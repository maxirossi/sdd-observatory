"""Project Intelligence scanner.

Detecta agentes y documentación SDD en un proyecto local. Cubre las fuentes
listadas en PLAN.md Fase 1A.
"""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from sqlmodel import Session, select

from app.config import settings
from app.models import Agent, AgentMention, Project, SddDocument, SddTask

# ───────────────────────────── Detection rules ─────────────────────────────

AGENT_PATTERNS: list[tuple[str, str]] = [
    # (glob, agent_type)
    (".github/agents/*.md", "github_agents"),
    (".github/agents/*.agent.md", "github_agents"),
    ("AGENTS.md", "agents_root"),
    ("CLAUDE.md", "claude_md"),
    (".cursor/rules", "cursor_rules"),
    (".cursor/rules/*.md", "cursor_rules"),
    (".cursor/rules/*.mdc", "cursor_rules"),
]

DOC_PATTERNS: list[tuple[str, str]] = [
    ("docs/**/*.md", "docs"),
    (".docs/**/*.md", "docs"),
    ("README.md", "docs"),
    ("functional/Cycles/**/spec.md", "spec"),
    ("functional/Cycles/**/requirements.md", "requirements"),
    ("functional/Cycles/**/tasks.md", "tasks"),
    ("docs/spec.md", "spec"),
    ("docs/tasks.md", "tasks"),
    ("docs/requirements.md", "requirements"),
]

# Cycle/task code patterns used across SDD projects in this team.
CYCLE_DIR_RE = re.compile(r"functional/Cycles/(?P<cycle>[^/]+)/", re.IGNORECASE)

# Task line parser. Acepta:
#   - [x] **T035a** Description ...
#   - [ ] T-SEC-001 [Backend] Description
#   - [x] **HU-WRP-C3-02** Description
#   - [/] T049b Title
# Captura: checkbox opcional, **bold** opcional alrededor del código, código,
# título. Domain se extrae aparte del title.
TASK_LINE_RE = re.compile(
    r"^\s*[-*]?\s*"
    r"(?:\[(?P<box>[ xX/~\-\.])\]\s*)?"
    r"(?:\*\*\s*)?"
    r"(?P<code>(?:T|HU)[A-Z0-9-]*\d+[a-z]?(?:[A-Za-z0-9]*)?)"
    r"(?:\s*\*\*)?"
    r"\s*[:\-—]?\s*(?P<title>.+?)\s*$",
    re.MULTILINE,
)

# Detección de dominio:
# 1) Tag explícito `[Backend]` / `[Frontend]` / `[Wrapper]` / `[DevOps]` / `[E2E]`
# 2) Sufijo del code o referencia `HU-XX-BE` / `HU-XX-FE` / `HU-WRP-...`
# 3) Track section en el título (Track Backend, Track Wrapper)
DOMAIN_TAG_RE = re.compile(
    r"\[(?P<tag>Backend|Frontend|Wrapper|DevOps|E2E|QA|Docs|Infra|Sec(?:urity)?|API)\]",
    re.IGNORECASE,
)
DOMAIN_HU_SUFFIX_RE = re.compile(
    r"HU(?:[-_A-Z0-9]+)?-(?P<dom>BE|FE|WRP|OPS|E2E|QA|SEC|API)\b",
    re.IGNORECASE,
)

DOMAIN_NORMALIZE = {
    "backend": "backend",
    "be": "backend",
    "frontend": "frontend",
    "fe": "frontend",
    "wrapper": "wrapper",
    "wrp": "wrapper",
    "fullstack": "fullstack",
    "fs": "fullstack",
    "devops": "devops",
    "ops": "devops",
    "infra": "devops",
    "e2e": "e2e",
    "qa": "e2e",
    "docs": "docs",
    "sec": "security",
    "security": "security",
    "api": "api",
}

# Keywords del título → dominio. Solo señales fuertes/específicas para no
# meter ruido (best-effort, sigue cayendo a 'unknown' si no hay match claro).
# Orden: la primera regla que matchea gana.
_DOMAIN_KEYWORD_RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\b(?:wrapper|proxy gateway|api gateway|bff)\b", re.I), "wrapper"),
    (re.compile(r"\b(?:docker|docker compose|ci/cd|github actions|workflow|deploy|"
                r"helm|kubernetes|k8s|terraform|tls termination|secrets manager|"
                r"runbook|pipeline|infra(?:structura)?)\b", re.I), "devops"),
    (re.compile(r"\bPROD-\d+\b"), "devops"),
    (re.compile(r"\b(?:jwt|rbac|oauth2?|correlationid|sanitiz|rate[- ]?limit|"
                r"vault|owasp|hardening|csrf|xss|auth filter)\b", re.I), "security"),
    (re.compile(r"\b(?:react|tsx|componente?s?|\bui\b|tailwind|vite|"
                r"routing|route-config|app-shell|pantalla|frontend)\b", re.I), "frontend"),
    (re.compile(r"\b(?:e2e|playwright|cypress|smoke test|integration test)\b", re.I), "e2e"),
    (re.compile(r"\b(?:flyway|migration|aggregate|usecase|use case|"
                r"adapters?|jpa|repository|endpoint|domain \+ application|"
                r"persistence|state machine|gateway)\b", re.I), "backend"),
]


def _detect_domain(title: str, code: str | None, file_path: str) -> str:
    blob = title
    m = DOMAIN_TAG_RE.search(blob)
    if m:
        norm = m.group("tag").lower()
        return DOMAIN_NORMALIZE.get(norm, "other")
    m = DOMAIN_HU_SUFFIX_RE.search(blob)
    if m:
        return DOMAIN_NORMALIZE.get(m.group("dom").lower(), "other")
    if code:
        m = DOMAIN_HU_SUFFIX_RE.search(code)
        if m:
            return DOMAIN_NORMALIZE.get(m.group("dom").lower(), "other")
        # T-SEC-001 / T-WRP-... / T-FE-...
        prefix = code.upper().split("-")
        if len(prefix) >= 2 and prefix[0] == "T":
            tag = prefix[1].lower()
            if tag in DOMAIN_NORMALIZE:
                return DOMAIN_NORMALIZE[tag]
    # Path heuristics
    p = file_path.lower()
    if "/wrapper" in p:
        return "wrapper"
    if "/frontend" in p or "/fe" in p:
        return "frontend"
    if "/backend" in p or "/be" in p:
        return "backend"
    # Keyword matching del título (best-effort, última instancia antes de unknown)
    for pattern, dom in _DOMAIN_KEYWORD_RULES:
        if pattern.search(blob):
            return dom
    return "unknown"

# Order matters: most specific keywords first to avoid "in progress" being
# matched by "progress" alone.
_STATUS_KEYWORD_RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\b(?:DONE|COMPLETED|FINISHED|RESOLVED|BUILD\s+SUCCESS|MERGED|CLOSED)\b", re.IGNORECASE), "done"),
    (re.compile(r"\b(?:verificado|finalizado|cerrado|terminado|completado|hecho)\b", re.IGNORECASE), "done"),
    (re.compile(r"\b(?:IN\s+PROGRESS|WIP|DOING)\b", re.IGNORECASE), "in_progress"),
    (re.compile(r"\b(?:en\s+curso|en\s+progreso|en\s+desarrollo)\b", re.IGNORECASE), "in_progress"),
    (re.compile(r"\b(?:TODO|PENDING|BLOCKED|BACKLOG)\b", re.IGNORECASE), "pending"),
    (re.compile(r"\b(?:pendiente|por\s+hacer|bloqueado)\b", re.IGNORECASE), "pending"),
]


def _detect_status(checkbox: str | None, title: str) -> str:
    """Return done | in_progress | pending | unknown based on hints in the line."""
    if checkbox:
        if checkbox.lower() == "x":
            return "done"
        if checkbox in ("~", "/"):
            return "in_progress"
        if checkbox == " ":
            return "pending"
    # Emoji hints (Unicode; precedence over keywords).
    if "✅" in title or "✔" in title or "☑" in title:
        return "done"
    if "🚧" in title or "⏳" in title or "🔄" in title:
        return "in_progress"
    if "⏸" in title or "🛑" in title:
        return "pending"
    for rx, status in _STATUS_KEYWORD_RULES:
        if rx.search(title):
            return status
    return "unknown"

# Folders never scanned regardless of patterns.
SKIP_DIRS = {
    ".git",
    "node_modules",
    "dist",
    "build",
    "target",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".turbo",
    ".pytest_cache",
    ".ruff_cache",
    ".mypy_cache",
}


# ───────────────────────────── Result containers ─────────────────────────────


@dataclass
class ScannedAgent:
    name: str
    file_path: str
    type: str
    description: str | None
    tags: list[str] = field(default_factory=list)
    content_hash: str = ""


@dataclass
class ScannedDocument:
    type: str
    file_path: str
    title: str | None
    content_hash: str


@dataclass
class ScannedTask:
    cycle: str | None
    task_code: str | None
    title: str
    file_path: str
    status: str = "unknown"
    domain: str = "unknown"


@dataclass
class ScannedMention:
    agent_name: str
    file_path: str
    source_type: str
    line_number: int
    snippet: str


@dataclass
class ScanResult:
    project_path: str
    project_name: str
    agents: list[ScannedAgent] = field(default_factory=list)
    documents: list[ScannedDocument] = field(default_factory=list)
    tasks: list[ScannedTask] = field(default_factory=list)
    mentions: list[ScannedMention] = field(default_factory=list)


# ───────────────────────────── Helpers ─────────────────────────────


def _hash_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _read_text(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def _title_from_markdown(text: str) -> str | None:
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            return stripped.lstrip("# ").strip() or None
        if stripped:
            # First non-empty non-heading line — bail to avoid noise.
            break
    return None


def _description_from_frontmatter(text: str) -> tuple[str | None, list[str]]:
    """Look for YAML-ish frontmatter ('description:' and 'tags:') in the first
    block of the file. Best-effort, no real YAML parser.
    """
    description: str | None = None
    tags: list[str] = []
    if not text.startswith("---"):
        return description, tags
    end = text.find("\n---", 3)
    if end == -1:
        return description, tags
    block = text[3:end]
    for raw in block.splitlines():
        line = raw.strip()
        if line.lower().startswith("description:"):
            description = line.split(":", 1)[1].strip().strip('"').strip("'")
        elif line.lower().startswith("tags:"):
            value = line.split(":", 1)[1].strip()
            if value.startswith("[") and value.endswith("]"):
                tags = [t.strip().strip('"').strip("'") for t in value[1:-1].split(",") if t.strip()]
    return description, tags


def _iter_glob_files(root: Path, pattern: str) -> list[Path]:
    matches = list(root.glob(pattern))
    out: list[Path] = []
    for p in matches:
        if not p.is_file():
            continue
        try:
            rel_parts = p.relative_to(root).parts
        except ValueError:
            continue
        if any(part in SKIP_DIRS for part in rel_parts):
            continue
        out.append(p)
    return out


# ───────────────────────────── Scanner core ─────────────────────────────


def scan(path: str | Path) -> ScanResult:
    root = Path(path).resolve()
    if not root.exists() or not root.is_dir():
        raise FileNotFoundError(f"Project path does not exist or is not a directory: {root}")

    result = ScanResult(project_path=str(root), project_name=root.name)
    seen_files: set[Path] = set()

    # Agents
    for pattern, agent_type in AGENT_PATTERNS:
        for file in _iter_glob_files(root, pattern):
            if file in seen_files:
                continue
            seen_files.add(file)
            text = _read_text(file)
            description, tags = _description_from_frontmatter(text)
            if not description:
                description = _title_from_markdown(text)
            result.agents.append(
                ScannedAgent(
                    name=file.stem,
                    file_path=str(file.relative_to(root)),
                    type=agent_type,
                    description=description,
                    tags=tags,
                    content_hash=_hash_bytes(text.encode("utf-8")),
                )
            )

    # Documents
    for pattern, doc_type in DOC_PATTERNS:
        for file in _iter_glob_files(root, pattern):
            if file in seen_files:
                continue
            seen_files.add(file)
            text = _read_text(file)
            result.documents.append(
                ScannedDocument(
                    type=doc_type,
                    file_path=str(file.relative_to(root)),
                    title=_title_from_markdown(text),
                    content_hash=_hash_bytes(text.encode("utf-8")),
                )
            )

    # Tasks (best-effort line-level extraction from tasks.md files)
    for pattern in ("functional/Cycles/**/tasks.md", "docs/tasks.md", "docs/**/tasks.md"):
        for file in _iter_glob_files(root, pattern):
            text = _read_text(file)
            rel = str(file.relative_to(root))
            cycle_match = CYCLE_DIR_RE.search(rel)
            cycle = cycle_match.group("cycle") if cycle_match else None
            for m in TASK_LINE_RE.finditer(text):
                code = m.group("code")
                title = m.group("title").strip()
                if len(title) < 3 or title.startswith("#"):
                    continue
                status = _detect_status(m.group("box"), title)
                domain = _detect_domain(title, code, rel)
                result.tasks.append(
                    ScannedTask(
                        cycle=cycle,
                        task_code=code,
                        title=title[:300],
                        file_path=rel,
                        status=status,
                        domain=domain,
                    )
                )

    _collect_mentions(root, result)

    return result


def _classify_source(doc_type: str | None, file_path: str) -> str:
    if doc_type:
        return doc_type
    name = file_path.lower()
    if "tasks" in name:
        return "tasks"
    if "spec" in name:
        return "spec"
    if "requirements" in name:
        return "requirements"
    return "other"


def _collect_mentions(root: Path, result: ScanResult) -> None:
    """For each agent name, find references inside scanned docs (and tasks files).

    Skips the agent's own file. Compiles word-boundary regexes per agent. Yields
    at most a snippet per (file, agent, line) to avoid noisy duplicates.
    """
    if not result.agents:
        return

    # name -> compiled pattern (word-ish boundary; tolerate '.', '-', '_').
    patterns: list[tuple[str, re.Pattern[str], str]] = []
    for a in result.agents:
        base = a.name.replace(".agent", "")
        if len(base) < 3:
            continue
        # Match name as a whole-ish token: not preceded/followed by alnum.
        rx = re.compile(rf"(?<![A-Za-z0-9_]){re.escape(base)}(?![A-Za-z0-9_])")
        patterns.append((a.name, rx, a.file_path))

    if not patterns:
        return

    # Build a quick map of file → source_type from already-scanned documents.
    doc_type_by_path = {d.file_path: d.type for d in result.documents}

    candidate_files: set[Path] = set()
    for d in result.documents:
        candidate_files.add(root / d.file_path)
    for t in result.tasks:
        if t.file_path:
            candidate_files.add(root / t.file_path)

    for file in candidate_files:
        if not file.is_file():
            continue
        rel = str(file.relative_to(root))
        text = _read_text(file)
        if not text:
            continue
        source_type = _classify_source(doc_type_by_path.get(rel), rel)
        for agent_name, rx, own_path in patterns:
            if rel == own_path:
                continue  # skip the agent's own definition file
            seen_lines: set[int] = set()
            for m in rx.finditer(text):
                # Compute line number.
                line_no = text.count("\n", 0, m.start()) + 1
                if line_no in seen_lines:
                    continue
                seen_lines.add(line_no)
                # Snippet: the matching line (clipped).
                line_start = text.rfind("\n", 0, m.start()) + 1
                line_end = text.find("\n", m.start())
                if line_end == -1:
                    line_end = len(text)
                snippet = text[line_start:line_end].strip()[:500]
                result.mentions.append(
                    ScannedMention(
                        agent_name=agent_name,
                        file_path=rel,
                        source_type=source_type,
                        line_number=line_no,
                        snippet=snippet,
                    )
                )


# ───────────────────────────── Persistence ─────────────────────────────


def persist(result: ScanResult, session: Session) -> Project:
    """Idempotent persistence: upsert project by path, replace agents/docs/tasks/mentions.

    If `SCAN_TARGET_HOST_PATH` is set, persist that path instead of the in-container
    path. This keeps the Project.path aligned with the `cwd` recorded by Claude
    Code session logs (which live on the host), so runtime ingest can attribute
    events to the right project.
    """
    # El override SCAN_TARGET_HOST_PATH (alinear Project.path con el cwd de los
    # logs Claude) es GLOBAL → solo debe aplicar al target configurado (el que se
    # monta en scan_target_mount_path). Para otros proyectos escaneados (p.ej. el
    # fixture sdd-template-lab) persistimos su propio path, evitando colisiones.
    mount = (settings.scan_target_mount_path or "").rstrip("/")
    rp = result.project_path
    is_configured_target = bool(mount) and (rp == mount or rp.startswith(mount + "/"))
    persisted_path = (
        settings.scan_target_host_path
        if (settings.scan_target_host_path and is_configured_target)
        else rp
    )
    # El nombre del target configurado se deriva del path host real (p.ej.
    # "sdd-template-lab"), no del basename del mount ("/workspaces/target" →
    # "target"), que sería genérico y poco descriptivo.
    project_name = (
        Path(persisted_path).name
        if (settings.scan_target_host_path and is_configured_target)
        else result.project_name
    )
    project = session.exec(select(Project).where(Project.path == persisted_path)).first()
    if project is None:
        project = Project(name=project_name, path=persisted_path)
        session.add(project)
        session.flush()
    else:
        project.name = project_name
        # Wipe scan-derived state before re-inserting. Runtime mentions
        # (source_type LIKE 'runtime_claude%') belong to the claude logs ingest
        # and must survive a re-scan.
        # Mentions del scanner se reemplazan; las runtime_* tienen su propia
        # ingesta y sobreviven al re-scan (apuntan a agent_id estable porque
        # upserteamos agents abajo sin recrearlos).
        for mention in session.exec(
            select(AgentMention).where(
                AgentMention.project_id == project.id,
                ~AgentMention.source_type.like("runtime_%"),  # type: ignore[attr-defined]
            )
        ).all():
            session.delete(mention)
        for doc in session.exec(select(SddDocument).where(SddDocument.project_id == project.id)).all():
            session.delete(doc)
        for task in session.exec(select(SddTask).where(SddTask.project_id == project.id)).all():
            session.delete(task)

    project.last_scanned_at = datetime.utcnow()
    session.flush()

    # Upsert agents by (project_id, name). Preservamos el id para no romper
    # FKs de agent_mentions runtime — al rescannear no perdemos las 1300+
    # menciones runtime que apuntan al agente existente.
    existing_agents = {
        a.name: a
        for a in session.exec(select(Agent).where(Agent.project_id == project.id)).all()
    }
    scanned_names = {a.name for a in result.agents}
    name_to_id: dict[str, str] = {}
    for a in result.agents:
        ag = existing_agents.get(a.name)
        if ag is None:
            ag = Agent(
                project_id=project.id,
                name=a.name,
                file_path=a.file_path,
                type=a.type,
                description=a.description,
                tags=",".join(a.tags) if a.tags else None,
                content_hash=a.content_hash,
            )
            session.add(ag)
            session.flush()
        else:
            ag.file_path = a.file_path
            ag.type = a.type
            ag.description = a.description
            ag.tags = ",".join(a.tags) if a.tags else None
            ag.content_hash = a.content_hash
            ag.updated_at = datetime.utcnow()
        name_to_id[a.name] = ag.id

    # Agents que desaparecieron del repo y NO tienen mentions runtime — los
    # podemos borrar. Si tienen runtime mentions los conservamos como histórico.
    for name, ag in existing_agents.items():
        if name in scanned_names:
            continue
        has_runtime = session.exec(
            select(AgentMention.id).where(
                AgentMention.agent_id == ag.id,
                AgentMention.source_type.like("runtime_%"),  # type: ignore[attr-defined]
            ).limit(1)
        ).first()
        if has_runtime is None:
            session.delete(ag)
    for d in result.documents:
        session.add(
            SddDocument(
                project_id=project.id,
                type=d.type,
                file_path=d.file_path,
                title=d.title,
                content_hash=d.content_hash,
            )
        )
    for t in result.tasks:
        session.add(
            SddTask(
                project_id=project.id,
                cycle=t.cycle,
                task_code=t.task_code,
                title=t.title,
                file_path=t.file_path,
                status=t.status,
                domain=t.domain,
            )
        )

    for m in result.mentions:
        agent_id = name_to_id.get(m.agent_name)
        if agent_id is None:
            continue
        session.add(
            AgentMention(
                project_id=project.id,
                agent_id=agent_id,
                file_path=m.file_path,
                source_type=m.source_type,
                line_number=m.line_number,
                snippet=m.snippet,
            )
        )

    session.commit()
    session.refresh(project)
    return project
