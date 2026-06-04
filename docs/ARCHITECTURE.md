# SDD Observatory — Architecture

## Capas

```
┌─────────────────────────────────────────────────────────────────┐
│                   Frontend (Vite + React)                        │
│           sidebar + 10 páginas + react-router                    │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP (REST)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Backend API (FastAPI)                           │
│   /api/projects · /api/runtime · /api/events · /api/sessions    │
│   /api/projects/:id/(cycles|health|tree|file|intelligence|...)  │
└──────────────┬─────────────────────────────────────┬────────────┘
               │                                     │
               ▼                                     ▼
┌──────────────────────────┐         ┌─────────────────────────────┐
│  Scanner (servicios)     │         │  Runtime capture pipeline   │
│  - agents/.agent.md      │         │  - ProviderAdapter ABC      │
│  - functional/Cycles/    │         │  - claude_adapter           │
│  - docs/                 │         │  - copilot_adapter          │
│  - tasks regex + domain  │         │  - sanitizer (secrets)      │
│  - cross-link mentions   │         │  - inference (tasks/paths)  │
└──────────────┬───────────┘         │  - collector orchestration  │
               │                     └──────────────┬──────────────┘
               │                                    │
               ▼                                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                   PostgreSQL 16                                  │
│  projects · agents · sdd_documents · sdd_tasks                  │
│  agent_mentions · runtime_events · llm_interactions             │
│  provider_configs                                               │
└─────────────────────────────────────────────────────────────────┘
```

---

## Modelo de datos

### Core (scanner)

```
projects
├── agents (project_id, name, type, file_path, content_hash, tags)
├── sdd_documents (project_id, type, file_path, title, content_hash)
└── sdd_tasks (project_id, cycle, task_code, title, status, domain, file_path)
```

### Cross-links

```
agent_mentions (project_id, agent_id, file_path, source_type, line_number, snippet)
```

`source_type` puede ser `docs`, `spec`, `tasks` (del scanner) o `runtime_claude_user`, `runtime_claude_assistant` (de la ingesta de logs Claude). El `file_path` para mentions runtime usa pseudo-URL `claude://session/<sid>#<eid>` para correlar evento + sesión.

### Runtime

```
runtime_events
├── id, project_id, provider, source_kind, event_type
├── timestamp, external_id (idempotencia)
├── status_code, latency_ms, request_size, response_size
├── endpoint, error_message
└── event_metadata: JSONB
    ├── session_id, request_id, parent_uuid, cwd
    ├── model, usage
    └── inference: { task_ids[], cycle_ids[], paths[], technologies[], agent_tokens[] }

llm_interactions (runtime_event_id, provider, model, prompt_chars, response_chars, sanitized_*)

provider_configs (provider, enabled, capture_metadata, capture_payload, capture_response)
```

#### Source kinds

| Valor | Origen | Estado v0.2 |
|---|---|---|
| `local_logs` | Filesystem logs (`~/.claude/projects`, `~/.config/Code/logs`) | **activo** |
| `project_scan` | Scanner del repo | reservado, no se usa todavía |
| `manual_import` | POST manual de JSON/CSV | reservado |

#### Idempotencia

Index parcial único sobre `(provider, external_id) WHERE external_id IS NOT NULL`. Cada adapter genera el `external_id` con un esquema estable: Claude usa el `uuid` del jsonl; Copilot usa `copilot:<ccreq_id>`.

---

## API surface

| Endpoint | Qué hace |
|---|---|
| `GET /api/projects` | Lista proyectos scaneados |
| `GET /api/projects/:id/agents` | Agentes detectados |
| `GET /api/projects/:id/documents` | Docs SDD |
| `GET /api/projects/:id/tasks` | Tasks parseadas con cycle + domain |
| `GET /api/projects/:id/health` | Score compuesto + métricas globales |
| `GET /api/projects/:id/cycles` | Progreso por ciclo + breakdown por dominio |
| `GET /api/projects/:id/tree` | Árbol del repo con flags A/D/T + mentions |
| `GET /api/projects/:id/file?path=...` | Lee contenido de archivo (256 KiB cap) |
| `GET /api/projects/:id/file-info?path=...` | Cross-info de un path (agents, docs, tasks) |
| `GET /api/projects/:id/usage` | Runtime vs declared coverage por agent |
| `GET /api/projects/:id/dependency-graph` | Refs T260→T263 entre tasks |
| `GET /api/projects/:id/scope-drift` | Tasks con runtime fuera del prefix esperado |
| `GET /api/projects/:id/dead-agents` | Clasificación active/inactive/runtime_only/declared_only |
| `GET /api/projects/:id/coverage-matrix` | Matriz runtime × docs × tasks por agent |
| `GET /api/projects/:id/correlation` | Top archivos con agentes/tasks/docs cross-linked |
| `GET /api/projects/:id/architecture` | Detección heurística de frameworks/patterns |
| `GET /api/projects/:id/search?q=...` | Full-text transversal (ILIKE) |
| `GET /api/projects/:id/findings` | Findings sintéticos sobre el estado |
| `GET /api/projects/:id/sessions` | Lista sesiones runtime |
| `GET /api/sessions/:sid` | Replay completo |
| `GET /api/projects/:id/agent-graph` | Co-ocurrencia de agentes en sesiones |
| `GET /api/events/runtime-sources` | Buckets por `source_kind` |
| `GET /api/events/by-provider` | Stats por provider |
| `GET /api/events/timeline` | Timeline horario |
| `GET /api/events` | Events recientes |
| `POST /api/events` | Ingesta manual de eventos |
| `GET /api/runtime/providers` | Estado por provider (adapter + DB + counts) |
| `GET /api/runtime/health` | Métricas globales runtime |
| `GET /api/runtime/top-agents` | Top agentes por runtime mentions |
| `POST /api/runtime/collector/run?provider=...` | Trigger manual del collector |
| `GET /api/providers` | Lista config por provider |
| `PUT /api/providers/:provider` | Update flags |

Spec OpenAPI completo: http://localhost:8000/docs

---

## Frontend routing

```
/                          → redirect a /projects
/projects                  → landing con cards de proyectos
/projects/:id/overview     → home del proyecto
/projects/:id/cycles       → progreso por ciclo + dominio
/projects/:id/tasks        → tabla con filtros
/projects/:id/agents       → grid agrupado por type
/projects/:id/runtime      → providers + live stream + sources
/projects/:id/sessions     → sesiones + replay
/projects/:id/explorer     → árbol + file info
/projects/:id/intelligence → usage + drift + dead + coverage + correlation + search
/projects/:id/providers    → catálogo de captura
/projects/:id/settings     → backend + security + danger zone
```

Layout: sidebar fija + topbar con project selector + `<Outlet />` central.

---

## Decisiones clave

### 1. project.path es la ruta del host, no la del container

El scanner persiste `project.path` con `SCAN_TARGET_HOST_PATH` (la ruta absoluta del host), para que matchee el `cwd` que escriben los logs de Claude. Pero el endpoint `/file` necesita leer del filesystem dentro del container, donde el bind mount está en `/workspaces/target`. La resolución se hace en `_resolve_root()`: si `project.path` no existe localmente y coincide con `scan_target_host_path`, redirige a `scan_target_mount_path`.

### 2. Runtime mentions sobreviven al re-scan

El `persist()` del scanner hace upsert por `(project_id, name)` en agents (no delete+insert) para que las FKs de `agent_mentions` runtime no se rompan. Solo borra agents que desaparecieron del repo Y no tienen runtime mentions.

### 3. Timestamps con TZ

VS Code escribe logs en hora local sin TZ. El parser de Copilot interpreta como `settings.log_timezone` y convierte a UTC naive antes de persistir. Claude logs ya vienen con `Z` ISO. Sin este fix, `now() - timestamp` daría offsets falsos.

### 4. Provider-agnostic

`ProviderAdapter` ABC en `services/runtime/base.py`. Cada provider implementa `discover()` y `ingest_path()`. El `collector` itera adapters de `registry.py` filtrando por `ProviderConfig.enabled`. Agregar un nuevo provider es: 1 archivo adapter + 1 línea en registry.

### 5. Source kind ≠ provider

Provider dice "qué herramienta" (claude/copilot). Source kind dice "cómo capturamos el evento" (logs locales / scan / manual). Un mismo provider podría llegar por varios source kinds, por eso cada evento declara el suyo de forma explícita.

---

## Watch loop

Al boot, `lifespan` arranca un `asyncio.Task` que ejecuta cada `INGEST_WATCH_INTERVAL_SECONDS` (default 60s) una pasada del collector. El collector lee `ProviderConfig` y corre los adapters habilitados. Cada tick logea `runtime tick <provider>: files=N new=M skipped=K`.

Trigger manual: `POST /api/runtime/collector/run?provider=claude`.

---

## Migrations

| ID | Cambio |
|---|---|
| 0001 | Schema inicial (projects, agents, docs, tasks, runtime_events, llm_interactions, provider_configs) |
| 0002 | agent_mentions |
| 0003 | runtime_events.external_id + index parcial único |
| 0004 | runtime_events.source_kind + index |
| 0005 | sdd_tasks.domain + index |

Auto-aplicadas en startup del backend (`_run_migrations` en `lifespan`).
