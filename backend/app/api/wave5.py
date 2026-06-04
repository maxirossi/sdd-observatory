"""Wave 5 — Correlation engine + Architecture detection + Semantic search.

- /correlation        cruza runtime → file → task → agent → cycle
- /architecture       detección heurística por presencia de archivos clave
- /search?q=          full-text mínimo transversal (docs/tasks/agents/mentions)
"""
from __future__ import annotations

import re
from collections import defaultdict
from pathlib import Path
from typing import Iterable
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, or_
from sqlmodel import Session, select

from app.config import settings
from app.db import get_session
from app.models import Agent, AgentMention, Project, RuntimeEvent, SddDocument, SddTask

router = APIRouter(prefix="/api/projects", tags=["wave5"])


# ───────────────────── Correlation ─────────────────────


class CorrelationLinkAgent(BaseModel):
    id: UUID
    name: str
    mentions: int


class CorrelationLinkTask(BaseModel):
    id: UUID
    task_code: str | None
    title: str
    cycle: str | None
    status: str | None
    domain: str | None


class CorrelationLinkDoc(BaseModel):
    id: UUID
    title: str | None
    type: str


class CorrelationCard(BaseModel):
    file_path: str
    runtime_events: int
    last_seen: str | None
    agents: list[CorrelationLinkAgent]
    tasks: list[CorrelationLinkTask]
    documents: list[CorrelationLinkDoc]
    cycles_touched: list[str]


@router.get("/{project_id}/correlation", response_model=list[CorrelationCard])
def correlation(
    project_id: UUID,
    limit: int = Query(20, ge=1, le=100),
    session: Session = Depends(get_session),
) -> list[CorrelationCard]:
    """Top archivos del repo con su contexto cross-entity.

    Score = mentions (todas) + runtime_events asociados al cwd / file.
    """
    if session.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")

    # Mentions agregadas por path (excluyendo claude://)
    mention_rows = session.exec(
        select(AgentMention.file_path, func.count(AgentMention.id))
        .join(Agent, AgentMention.agent_id == Agent.id)
        .where(
            Agent.project_id == project_id,
            ~AgentMention.file_path.like("claude://%"),  # type: ignore[operator]
        )
        .group_by(AgentMention.file_path)
        .order_by(func.count(AgentMention.id).desc())
        .limit(limit * 3)
    ).all()
    mentions_by_path = {p: int(c) for p, c in mention_rows}

    if not mentions_by_path:
        return []

    top_paths = list(mentions_by_path.keys())[:limit]

    # Resolve agents/tasks/docs/cycles para cada path
    agent_rows = session.exec(
        select(AgentMention.file_path, Agent.id, Agent.name, func.count(AgentMention.id))
        .join(Agent, AgentMention.agent_id == Agent.id)
        .where(
            Agent.project_id == project_id,
            AgentMention.file_path.in_(top_paths),  # type: ignore[attr-defined]
        )
        .group_by(AgentMention.file_path, Agent.id, Agent.name)
    ).all()
    agents_by_path: dict[str, list[CorrelationLinkAgent]] = defaultdict(list)
    for fp, aid, name, count in agent_rows:
        agents_by_path[fp].append(CorrelationLinkAgent(id=aid, name=name, mentions=int(count)))

    tasks_by_path: dict[str, list[CorrelationLinkTask]] = defaultdict(list)
    for t in session.exec(
        select(SddTask).where(
            SddTask.project_id == project_id, SddTask.file_path.in_(top_paths)  # type: ignore[attr-defined]
        )
    ).all():
        if t.file_path:
            tasks_by_path[t.file_path].append(
                CorrelationLinkTask(
                    id=t.id, task_code=t.task_code, title=t.title,
                    cycle=t.cycle, status=t.status, domain=t.domain,
                )
            )

    docs_by_path: dict[str, list[CorrelationLinkDoc]] = defaultdict(list)
    for d in session.exec(
        select(SddDocument).where(
            SddDocument.project_id == project_id, SddDocument.file_path.in_(top_paths)  # type: ignore[attr-defined]
        )
    ).all():
        docs_by_path[d.file_path].append(
            CorrelationLinkDoc(id=d.id, title=d.title, type=d.type)
        )

    out: list[CorrelationCard] = []
    for fp in top_paths:
        cycles = sorted(
            {seg for seg in fp.split("/") if seg.startswith("cycle-") and "." not in seg}
        )
        out.append(
            CorrelationCard(
                file_path=fp,
                runtime_events=0,  # placeholder; ATM no asociamos runtime al file
                last_seen=None,
                agents=agents_by_path.get(fp, []),
                tasks=tasks_by_path.get(fp, []),
                documents=docs_by_path.get(fp, []),
                cycles_touched=cycles,
            )
        )
    return out


# ───────────────────── Architecture detection ─────────────────────


class ArchSignal(BaseModel):
    label: str
    confidence: int  # 0..100
    evidence: list[str]


class ArchitectureProfile(BaseModel):
    languages: list[str]
    frameworks: list[ArchSignal]
    patterns: list[ArchSignal]
    deployment: list[ArchSignal]


_SIGNAL_RULES: list[tuple[str, str, list[str]]] = [
    # (category, label, glob_files)
    ("framework", "NestJS", ["**/nest-cli.json", "**/nestjs.config.*"]),
    ("framework", "FastAPI", ["**/fastapi/**/*.py", "**/app/main.py"]),
    ("framework", "Spring Boot", ["**/pom.xml", "**/build.gradle*"]),
    ("framework", "Express", ["**/express.json", "**/server.ts", "**/server.js"]),
    ("framework", "React", ["**/react/package.json", "**/.eslintrc.react*", "**/*.tsx"]),
    ("framework", "Vite", ["**/vite.config.*"]),
    ("framework", "TailwindCSS", ["**/tailwind.config.*"]),
    ("framework", "Alembic", ["**/alembic.ini", "**/alembic/env.py"]),
    ("framework", "Flyway", ["**/migrations/V*__*.sql", "**/db/migration/V*.sql"]),

    ("pattern", "Hexagonal", [
        "**/domain/**/aggregate*", "**/application/**/usecase*",
        "**/infrastructure/**/adapter*", "**/ports/**",
    ]),
    ("pattern", "DDD", ["**/aggregate*.py", "**/aggregate*.java", "**/domain-event*"]),
    ("pattern", "CQRS", ["**/command-handler*", "**/query-handler*", "**/cqrs*"]),
    ("pattern", "Event-driven", ["**/kafka*", "**/rabbit*", "**/event-bus*"]),
    ("pattern", "Microservices", ["**/services/*/Dockerfile", "**/microservices/**"]),
    ("pattern", "Monorepo", ["**/pnpm-workspace.yaml", "**/lerna.json", "**/nx.json", "**/turbo.json"]),
    ("pattern", "Wrapper proxy", ["**/wrapper*/**", "**/api-gateway/**"]),

    ("deployment", "Docker Compose", ["**/docker-compose*.yml", "**/docker-compose*.yaml"]),
    ("deployment", "Kubernetes", ["**/k8s/**/*.yaml", "**/kubernetes/**/*.yaml", "**/Chart.yaml"]),
    ("deployment", "GitHub Actions", ["**/.github/workflows/*.yml", "**/.github/workflows/*.yaml"]),
    ("deployment", "Terraform", ["**/*.tf", "**/terraform/**"]),
]


def _resolve_root(project: Project) -> Path:
    raw = Path(project.path)
    if not raw.exists() and settings.scan_target_host_path == str(raw):
        return Path(settings.scan_target_mount_path)
    return raw


# Lo que NO es código del repo: dependencias instaladas, build outputs, caches,
# herramientas de IDE, paquetes vendored. Si lo escaneamos contamos como
# evidencia algo que no escribió nadie del proyecto.
_ARCH_SKIP_DIRS = {
    # VCS / IDE
    ".git", ".svn", ".hg", ".idea", ".vscode", ".vs",
    # JS/TS deps + builds
    "node_modules", ".next", ".nuxt", ".turbo", ".angular", ".cache",
    "dist", "build", "out", "output", ".output",
    # Python
    "__pycache__", ".pytest_cache", ".tox", ".venv", "venv", ".mypy_cache", ".ruff_cache",
    "site-packages", ".eggs", "*.egg-info",
    # Java / Kotlin
    "target", ".gradle", "gradle", ".mvn", "bin", "obj",
    # Coverage / reports
    "coverage", "htmlcov", ".nyc_output", "test-results", "playwright-report",
    # Otros
    "vendor", "third_party", "node_modules.bak", ".serverless",
    ".terraform", "Pods", "DerivedData",
}


def _walk_files(root: Path, max_files: int = 30000):
    """Walk recursivo skipeando librerías/builds/caches. Solo código del repo."""
    stack: list[Path] = [root]
    yielded = 0
    while stack and yielded < max_files:
        cur = stack.pop()
        try:
            entries = list(cur.iterdir())
        except OSError:
            continue
        for e in entries:
            if e.is_dir():
                if e.name in _ARCH_SKIP_DIRS or e.name.endswith(".egg-info"):
                    continue
                stack.append(e)
            else:
                yield e
                yielded += 1
                if yielded >= max_files:
                    return


def _match_signals(files: list[Path], root: Path) -> dict[tuple[str, str], list[str]]:
    """One-pass matching de todos los _SIGNAL_RULES contra el listado de archivos.

    Devuelve {(category, label): [evidence relativa]}.
    """
    from fnmatch import fnmatch
    out: dict[tuple[str, str], list[str]] = {}
    rel_paths: list[str] = []
    name_only: list[str] = []
    for f in files:
        try:
            rp = str(f.relative_to(root))
        except ValueError:
            continue
        rel_paths.append(rp)
        name_only.append(f.name)

    for cat, label, patterns in _SIGNAL_RULES:
        evidence: list[str] = []
        for pat in patterns:
            tail = pat.replace("**/", "")
            for i, rp in enumerate(rel_paths):
                if fnmatch(rp, pat) or fnmatch(name_only[i], tail):
                    evidence.append(rp)
                    if len(evidence) >= 3:
                        break
            if len(evidence) >= 3:
                break
        if evidence:
            out[(cat, label)] = evidence[:3]
    return out


@router.get("/{project_id}/architecture", response_model=ArchitectureProfile)
def architecture(
    project_id: UUID, session: Session = Depends(get_session)
) -> ArchitectureProfile:
    project = session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    root = _resolve_root(project)
    if not root.exists():
        raise HTTPException(status_code=400, detail="Project path not reachable")

    # Languages detected via file extensions presentes
    LANG_BY_EXT = {
        ".py": "Python", ".ts": "TypeScript", ".tsx": "TypeScript",
        ".js": "JavaScript", ".jsx": "JavaScript",
        ".java": "Java", ".kt": "Kotlin", ".go": "Go",
        ".rs": "Rust", ".rb": "Ruby", ".php": "PHP",
        ".cs": "C#", ".swift": "Swift",
    }
    # One-pass walk: lang count + lista de archivos para matching de signals.
    files: list[Path] = []
    lang_count: dict[str, int] = defaultdict(int)
    for p in _walk_files(root, max_files=30000):
        files.append(p)
        suffix = p.suffix.lower()
        if suffix in LANG_BY_EXT:
            lang_count[LANG_BY_EXT[suffix]] += 1
    languages = [l for l, _ in sorted(lang_count.items(), key=lambda kv: -kv[1])][:5]

    signal_matches = _match_signals(files, root)
    by_cat: dict[str, list[ArchSignal]] = {"framework": [], "pattern": [], "deployment": []}
    for (cat, label), evidence in signal_matches.items():
        conf = 100 if len(evidence) >= 3 else 70 if len(evidence) == 2 else 50
        by_cat[cat].append(ArchSignal(label=label, confidence=conf, evidence=evidence))

    # Ordenar por confidence dentro de cada categoría
    for k in by_cat:
        by_cat[k].sort(key=lambda s: -s.confidence)

    return ArchitectureProfile(
        languages=languages,
        frameworks=by_cat["framework"],
        patterns=by_cat["pattern"],
        deployment=by_cat["deployment"],
    )


# ───────────────────── Semantic search ─────────────────────


class SearchHit(BaseModel):
    kind: str  # agent | document | task | mention
    id: str
    label: str
    subtitle: str | None
    score: int


@router.get("/{project_id}/search", response_model=list[SearchHit])
def search(
    project_id: UUID,
    q: str = Query(..., min_length=2, max_length=200),
    limit: int = Query(30, ge=1, le=200),
    session: Session = Depends(get_session),
) -> list[SearchHit]:
    """Full-text mínimo cross-entity. ILIKE %q% sobre nombre/título/snippet.

    No es semántica real (sin embeddings) — pero es transversal,
    barata y honesta. Para semántica real haría falta pgvector + embedding.
    """
    if session.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")

    pattern = f"%{q.lower()}%"
    hits: list[SearchHit] = []

    # Agents
    for a in session.exec(
        select(Agent)
        .where(
            Agent.project_id == project_id,
            or_(
                func.lower(Agent.name).like(pattern),
                func.lower(Agent.description).like(pattern),
                func.lower(Agent.tags).like(pattern),
            ),
        )
        .limit(limit)
    ).all():
        hits.append(
            SearchHit(
                kind="agent", id=str(a.id), label=a.name,
                subtitle=(a.description or "")[:140], score=80,
            )
        )

    # Docs
    for d in session.exec(
        select(SddDocument)
        .where(
            SddDocument.project_id == project_id,
            or_(
                func.lower(SddDocument.title).like(pattern),
                func.lower(SddDocument.file_path).like(pattern),
            ),
        )
        .limit(limit)
    ).all():
        hits.append(
            SearchHit(
                kind="document", id=str(d.id),
                label=d.title or d.file_path,
                subtitle=d.file_path, score=70,
            )
        )

    # Tasks
    for t in session.exec(
        select(SddTask)
        .where(
            SddTask.project_id == project_id,
            or_(
                func.lower(SddTask.title).like(pattern),
                func.lower(SddTask.task_code).like(pattern),
            ),
        )
        .limit(limit)
    ).all():
        hits.append(
            SearchHit(
                kind="task", id=str(t.id),
                label=f"{t.task_code or ''} {t.title}".strip(),
                subtitle=f"{t.cycle or ''} · {t.status or 'unknown'} · {t.domain or 'unknown'}",
                score=65,
            )
        )

    # Mentions (snippet)
    for mention, agent_name in session.exec(
        select(AgentMention, Agent.name)
        .join(Agent, AgentMention.agent_id == Agent.id)
        .where(
            Agent.project_id == project_id,
            func.lower(AgentMention.snippet).like(pattern),
        )
        .limit(limit)
    ).all():
        hits.append(
            SearchHit(
                kind="mention", id=str(mention.id),
                label=f"{agent_name} en {mention.file_path[:60]}",
                subtitle=(mention.snippet or "")[:160],
                score=40,
            )
        )

    hits.sort(key=lambda h: -h.score)
    return hits[:limit]
