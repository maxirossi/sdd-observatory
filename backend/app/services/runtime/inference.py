"""Runtime inference — extrae contexto de un blob de texto.

Output queda dentro de `event_metadata.inference` para que las queries
(/correlation, /search, etc) puedan cruzar runtime events contra entidades
del proyecto sin reparsear cada vez.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

# Códigos tipo T260, T-SEC-001, T049a, HU-WRP-C3-02
_TASK_RE = re.compile(r"\b((?:T|HU)[A-Z0-9-]*\d+[a-z]?)\b")

# Ciclos: cycle-1, cycle-2-security-hardening, etc
_CYCLE_RE = re.compile(r"\b(cycle-\d+(?:-[a-z0-9-]+)?)\b", re.IGNORECASE)

# Paths estilo filesystem: backend/foo/bar.java, src/components/X.tsx
# Heurística: extensión conocida o segmento con / al menos una vez.
_PATH_RE = re.compile(
    r"\b([A-Za-z0-9_\-./]+\.(?:py|ts|tsx|js|jsx|java|kt|go|rs|md|sql|yml|yaml|json|sh|tf|dockerfile))\b",
    re.IGNORECASE,
)

# Tecnologías que aparezcan textuales — útil para correlar con architecture
_TECH_KEYWORDS = {
    "nestjs": "NestJS",
    "fastapi": "FastAPI",
    "spring boot": "Spring Boot",
    "react": "React",
    "vite": "Vite",
    "tailwind": "TailwindCSS",
    "flyway": "Flyway",
    "alembic": "Alembic",
    "docker compose": "Docker Compose",
    "kubernetes": "Kubernetes",
    "k8s": "Kubernetes",
    "postgres": "PostgreSQL",
    "postgresql": "PostgreSQL",
    "redis": "Redis",
    "kafka": "Kafka",
    "rabbitmq": "RabbitMQ",
}

# Agentes — patrón generoso: palabras tipo `orchestrator.agent`, `backend-developer.agent`,
# `AGENTS`. La extracción precisa contra la DB la hace el ingest (regex compilados por
# nombre). Acá detectamos solo tokens con sufijo `.agent`.
_AGENT_RE = re.compile(r"\b([a-zA-Z][a-zA-Z0-9_-]+\.agent)\b")


@dataclass
class Inference:
    task_ids: list[str] = field(default_factory=list)
    cycle_ids: list[str] = field(default_factory=list)
    paths: list[str] = field(default_factory=list)
    technologies: list[str] = field(default_factory=list)
    agent_tokens: list[str] = field(default_factory=list)

    def is_empty(self) -> bool:
        return not (
            self.task_ids or self.cycle_ids or self.paths or self.technologies or self.agent_tokens
        )

    def to_dict(self) -> dict:
        return {
            "task_ids": self.task_ids,
            "cycle_ids": self.cycle_ids,
            "paths": self.paths,
            "technologies": self.technologies,
            "agent_tokens": self.agent_tokens,
        }


def _dedup(seq: list[str], cap: int = 20) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for x in seq:
        k = x.lower()
        if k in seen:
            continue
        seen.add(k)
        out.append(x)
        if len(out) >= cap:
            break
    return out


def extract_inference(text: str | None) -> Inference:
    """Best-effort extraction. Devuelve listas dedup-eadas y capeadas."""
    if not text:
        return Inference()
    task_ids = _dedup([m.group(1).upper() for m in _TASK_RE.finditer(text)])
    cycle_ids = _dedup([m.group(1).lower() for m in _CYCLE_RE.finditer(text)])
    paths = _dedup([m.group(1) for m in _PATH_RE.finditer(text)], cap=30)
    agent_tokens = _dedup([m.group(1) for m in _AGENT_RE.finditer(text)])
    lower = text.lower()
    techs: list[str] = []
    for needle, label in _TECH_KEYWORDS.items():
        if needle in lower:
            techs.append(label)
    return Inference(
        task_ids=task_ids,
        cycle_ids=cycle_ids,
        paths=paths,
        technologies=_dedup(techs),
        agent_tokens=agent_tokens,
    )


def enrich_metadata(metadata: dict, text: str | None) -> dict:
    """Mete la inferencia bajo `metadata["inference"]` solo si hay algo no vacío."""
    inf = extract_inference(text)
    if inf.is_empty():
        return metadata
    out = dict(metadata) if metadata else {}
    out["inference"] = inf.to_dict()
    return out
