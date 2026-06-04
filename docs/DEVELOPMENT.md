# Development

Workflows para trabajar sobre el código.

---

## Levantar el stack

```bash
cp .env.example .env
docker compose up -d                     # postgres + backend + frontend
```

Volumes persistentes:

- `postgres_data` — datos de la DB
- `frontend_node_modules` — node_modules del frontend (no contamina el host)

---

## Logs en vivo

```bash
docker compose logs -f backend
docker compose logs -f frontend
```

Hot reload activado:

- Backend: `uvicorn --reload` detecta cambios en `backend/app/`
- Frontend: Vite HMR sobre `frontend/src/`

---

## Migrations (Alembic)

Crear una nueva:

```bash
docker compose exec backend alembic revision -m "descripción"
# editar backend/migrations/versions/00XX_*.py
```

Aplicar:

```bash
docker compose exec backend alembic upgrade head
```

> En realidad las migrations se aplican **automáticamente** al startup del backend (`_run_migrations` en `main.lifespan`). Solo necesitás aplicar manualmente si el container está abajo o si necesitás runtime check.

Revert:

```bash
docker compose exec backend alembic downgrade -1
```

Ver estado:

```bash
docker compose exec backend alembic current
```

---

## CLI del scanner

```bash
# Escanear el repo target montado en /workspaces/target
docker compose exec backend python -m app.cli scan-project /workspaces/target

# Info del scanner (verifica adapter loading)
docker compose exec backend python -m app.cli info

# Ingest manual de claude logs (también lo hace el watch loop)
docker compose exec backend python -m app.cli ingest-claude-logs /workspaces/claude-logs

# Ingest manual de copilot logs
docker compose exec backend python -m app.cli ingest-copilot-logs /workspaces/vscode-logs
```

Output del scan:

```
│ Archivos vistos          │      258 │
│ Líneas vistas            │    77310 │
│ Eventos insertados       │     2703 │
│ Skipped                  │        0 │
```

---

## Triggers manuales del collector

```bash
# Todos los providers habilitados
curl -X POST http://localhost:8000/api/runtime/collector/run

# Un provider específico (ignora el flag enabled)
curl -X POST "http://localhost:8000/api/runtime/collector/run?provider=copilot"
```

O desde la UI: **Runtime** → click **Trigger** en el provider.

---

## Backend

### Estructura

```
backend/app/
├── api/                     # FastAPI routers
│   ├── events.py            # /api/events (timeline, by-provider, runtime-sources)
│   ├── findings.py          # /api/projects/:id/findings
│   ├── health.py            # /cycles + /health
│   ├── intelligence.py      # /dependency-graph + drift + dead + coverage
│   ├── projects.py          # CRUD projects + related
│   ├── providers.py         # provider_configs CRUD
│   ├── runtime.py           # /api/runtime/*
│   ├── sessions.py          # /api/sessions + agent-graph
│   ├── tree.py              # /tree + /file-info
│   ├── usage.py             # /usage
│   └── wave5.py             # /correlation + /architecture + /search
├── cli/
│   └── __main__.py          # typer CLI
├── models/
│   ├── cross.py             # agent_mentions
│   ├── project.py           # project, agent, doc, task
│   └── runtime.py           # runtime_event, llm_interaction, provider_config
├── services/
│   ├── claude_logs.py       # parser Claude jsonl
│   ├── copilot_logs.py      # parser VS Code logs
│   ├── sanitizer.py         # redacta secrets
│   ├── scanner.py           # scan-project
│   └── runtime/             # captura provider-agnostic
│       ├── base.py          # ProviderAdapter ABC + ParsedEvent
│       ├── claude_adapter.py
│       ├── copilot_adapter.py
│       ├── collector.py     # orquestador
│       ├── inference.py     # task_ids, paths, agentes
│       └── registry.py
├── config.py                # settings (env vars)
├── db.py                    # engine + session
└── main.py                  # FastAPI app + lifespan
```

### Agregar un endpoint nuevo

1. Crear router en `app/api/foo.py` con `APIRouter(prefix="/api/foo")`
2. Definir schemas con `pydantic.BaseModel`
3. Importarlo en `main.py` y `app.include_router(foo.router)`

### Agregar un provider runtime

Ver [`RUNTIME-CAPTURE.md`](./RUNTIME-CAPTURE.md) sección "Agregar un provider nuevo".

---

## Frontend

### Estructura

```
frontend/src/
├── App.tsx                  # router
├── main.tsx                 # bootstrap
├── layouts/
│   └── AppLayout.tsx        # sidebar + topbar + outlet
├── pages/                   # uno por ruta
│   ├── OverviewPage.tsx
│   ├── CyclesPage.tsx
│   ├── TasksPage.tsx
│   ├── AgentsPage.tsx
│   ├── RuntimePage.tsx
│   ├── SessionsPage.tsx
│   ├── ExplorerPage.tsx
│   ├── IntelligencePage.tsx
│   ├── ProvidersPage.tsx
│   ├── SettingsPage.tsx
│   └── ProjectsLandingPage.tsx
├── components/              # panels y widgets reutilizables
│   ├── PageHeader.tsx
│   ├── HealthBanner.tsx
│   ├── CyclesPanel.tsx
│   ├── RuntimeObservabilityPanel.tsx
│   ├── RuntimeSourcesPanel.tsx
│   ├── SessionsPanel.tsx
│   ├── AgentGraphPanel.tsx
│   ├── ExplorerPanel.tsx
│   ├── IntelligencePanel.tsx
│   ├── Wave5Panel.tsx
│   ├── EntityDrawer.tsx
│   ├── RawFileModal.tsx
│   └── MarkdownView.tsx
├── lib/
│   └── api.ts               # cliente fetch + tipos
└── styles/
    └── index.css            # tokens + utilities (Tailwind v4)
```

### Tokens de diseño en `styles/index.css`

```css
.card-elev               /* card con gradient + shadow */
.card-elev-hover         /* hover translateY + glow */
.kpi-number              /* 36px tabular nums, weight 600 */
.label-track             /* uppercase tracking-wide 11px */
.mono-body               /* JetBrains Mono 12.5px */
.pulse-dot               /* live indicator animado */
.fade-in-row             /* entrada de event rows */
.tabular                 /* font-variant-numeric: tabular-nums */
```

### Agregar una página nueva

1. Crear `frontend/src/pages/NewPage.tsx`
2. Agregar la ruta en `App.tsx` dentro del `<Route path="/projects/:projectId" element={<AppLayout />}>`
3. Agregar el item al `NAV` array en `layouts/AppLayout.tsx`

### Typecheck

```bash
docker compose exec frontend npm run typecheck
```

### Type API client

`frontend/src/lib/api.ts` mantiene tipos manuales sincronizados con los `BaseModel` del backend. Cuando agregás un schema nuevo en backend, replicarlo acá.

---

## Postgres

### Conectar

```bash
docker compose exec postgres psql -U ssdoffice -d ssdoffice
```

### Queries útiles

```sql
-- Estado de providers
SELECT provider, enabled, updated_at FROM provider_configs ORDER BY 1;

-- Volumen runtime
SELECT source_kind, provider, count(*), max(timestamp) AS last
FROM runtime_events GROUP BY source_kind, provider ORDER BY 1,2;

-- Sesiones con más eventos
SELECT event_metadata->>'session_id' AS sid, count(*) AS events
FROM runtime_events WHERE provider='claude'
GROUP BY sid ORDER BY events DESC LIMIT 10;

-- Tasks por cycle/domain/status
SELECT cycle, domain, status, count(*)
FROM sdd_tasks GROUP BY cycle, domain, status ORDER BY 1,2,3;
```

---

## Reset / debug

### Wipe runtime sin perder scan

```sql
DELETE FROM llm_interactions;
DELETE FROM agent_mentions WHERE source_type LIKE 'runtime_%';
DELETE FROM runtime_events;
```

### Wipe completo (vuelve a estado virgen)

```bash
docker compose down -v
docker compose up -d
docker compose exec backend python -m app.cli scan-project /workspaces/target
```

### Re-scan preservando runtime mentions

```bash
docker compose exec backend python -m app.cli scan-project /workspaces/target
```

El scanner hace **upsert** por `(project_id, name)` en agents, así que las FKs de `agent_mentions` runtime sobreviven.

---

## Testing

> No hay test suite formal todavía. Por hoy se valida con:

- Typecheck (`tsc -b --noEmit`)
- Smoke con curl al backend después de cada cambio
- Click test de la UI con dev server
