# SDD Observatory

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Backend: FastAPI](https://img.shields.io/badge/backend-FastAPI-009688.svg)
![Frontend: React](https://img.shields.io/badge/frontend-React%2018-61dafb.svg)
![Stack: Docker Compose](https://img.shields.io/badge/run-Docker%20Compose-2496ed.svg)

Observabilidad local del proceso agéntico de un proyecto SDD: agents declarados, tasks/cycles, runtime real de las herramientas IA, y cómo todo eso se cruza entre sí.

> **Status v0.2.** Funcional end-to-end. Captura runtime por **logs locales** activa por default (Claude + Copilot).

---

## ¿Qué hace?

- Detecta agents/docs/tasks/cycles en un repo SDD (`.github/agents/*.agent.md`, `functional/Cycles/`, `docs/`)
- Captura runtime de Claude Code y GitHub Copilot desde sus logs locales (`~/.claude/projects` y `~/.config/Code/logs`)
- Cruza agents declarados vs agents efectivamente usados en runtime
- Permite navegar el repo + agents + tasks + sesiones + intelligence desde un dashboard local

---

## Quick start

```bash
# 0. (opcional) Clonar el fixture de ejemplo para probar end-to-end
git clone https://github.com/maxirossi/sdd-template-lab.git

# 1. Configurar
cp .env.example .env       # apuntá SCAN_TARGET_PATH al fixture (o a tu propio repo SDD)

# 2. Levantar stack
docker compose up -d

# 3. Escanear el proyecto target
docker compose exec backend python -m app.cli scan-project /workspaces/target

# 4. Abrir dashboard
open http://localhost:5180
```

Eso es todo. Los logs de Claude/Copilot se procesan automáticamente cada 60s por el watch loop.

> **Fixture de demo:** [`sdd-template-lab`](https://github.com/maxirossi/sdd-template-lab) es un repo SDD sintético (CRUD de notas + gobernanza + agentes declarados) pensado para probar el Observatory sin datos reales. También podés apuntar `SCAN_TARGET_PATH` a cualquier repo SDD propio.

---

## Estructura del repo

```
ssdoffice/
├── README.md                  ← este archivo
├── PLAN.md                    ← plan original
├── ROADMAP.md                 ← oleadas v0.2 (status actual)
├── docker-compose.yml         ← postgres + backend + frontend
├── docs/                      ← documentación detallada
│   ├── ARCHITECTURE.md        ← cómo está construido
│   ├── RUNTIME-CAPTURE.md     ← pipeline de captura runtime
│   ├── CONFIG.md              ← env vars + provider_configs
│   └── DEVELOPMENT.md         ← workflows de dev
├── backend/                   ← FastAPI + SQLModel + Alembic
│   ├── app/
│   │   ├── api/               ← routers (10 endpoints)
│   │   ├── models/            ← project, runtime, cross
│   │   ├── services/          ← scanner + runtime capture
│   │   │   └── runtime/       ← adapters provider-agnostic
│   │   └── main.py            ← FastAPI app + watch loop
│   └── migrations/            ← alembic 0001→0005
├── frontend/                  ← Vite + React + Tailwind v4
│   └── src/
│       ├── pages/             ← 10 páginas (Overview/Cycles/...)
│       ├── layouts/           ← AppLayout con sidebar
│       ├── components/        ← panels reutilizables
│       └── lib/api.ts         ← cliente API
```

---

## Stack

| Capa | Tecnología |
|---|---|
| Frontend | React 18 + Vite + TypeScript + Tailwind v4 + Recharts + react-router-dom |
| Markdown viewer | react-markdown + remark-gfm + rehype-highlight |
| Backend API | FastAPI + SQLModel + Alembic + psycopg |
| Storage | PostgreSQL 16 con JSONB |
| Runtime capture | Python adapters (provider-agnostic) |
| Infra local | Docker Compose |

---

## Servicios

| Servicio | URL | Default |
|---|---|---|
| Postgres | `localhost:5433` | siempre on |
| Backend API | http://localhost:8000 | siempre on, docs en `/docs` |
| Frontend | http://localhost:5180 | siempre on |

---

## Dashboard

10 páginas bajo `/projects/:id/<module>`:

| Módulo | Qué muestra |
|---|---|
| **Overview** | Health + KPIs + live activity feed |
| **Cycles** | Progreso por ciclo + dominio (BE/FE/Wrapper/...) |
| **Tasks** | Tabla con filtros (cycle/domain/status) |
| **Agents** | Grid por type con search |
| **Runtime** | Provider cards + live stream + sources |
| **Sessions** | Replay narrativo de sesiones Claude |
| **Explorer** | Árbol del repo + cross-info por archivo |
| **Intelligence** | Usage + dependency graph + scope drift + dead agents + coverage + correlation + architecture + semantic search |
| **Providers** | Estado de cada provider (enabled/capture flags) |
| **Settings** | Backend + security + danger zone |

---

## Defaults v0.2

Después del primer `docker compose up`:

| Provider | Default | Source |
|---|---|---|
| **claude** | enabled | `local_logs` (`~/.claude/projects`) |
| **copilot** | enabled | `local_logs` (`~/.config/Code/logs`) |

Activar / desactivar:

```bash
# Toggle via SQL directo
docker compose exec postgres psql -U ssdoffice -d ssdoffice \
  -c "UPDATE provider_configs SET enabled=false WHERE provider='claude';"
```

---

## Principios

1. **Local-first** — todo corre en docker en tu máquina.
2. **Privacy-first** — modo `metadata_only` por default. Prompts y respuestas no se persisten. Sanitizer redacta API keys, JWTs, cookies, PEMs y connection strings.
3. **Provider-agnostic** — adapters separados por provider con interfaz común. Agregar uno nuevo es 1 archivo.
4. **Source-explicit** — cada evento declara su origen (`local_logs` / `project_scan` / `manual_import`). Cada source kind queda registrado por separado.
5. **Evidence-based** — métricas sobre actividad real. Sin mocks, sin números inventados.

---

## Documentación

| Documento | Contenido |
|---|---|
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | Modelo de datos, capas, endpoints, decisiones |
| [`docs/RUNTIME-CAPTURE.md`](./docs/RUNTIME-CAPTURE.md) | Pipeline de captura: adapters, sanitizer, inference, watch loop |
| [`docs/COPILOT-STORAGE.md`](./docs/COPILOT-STORAGE.md) | Detalle del adapter Copilot: workspaceStorage, delta JSONL, mentions |
| [`docs/CONFIG.md`](./docs/CONFIG.md) | Env vars, provider_configs, paths montados |
| [`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md) | Workflows: migrations, scan, ingest, typecheck |
| [`ROADMAP.md`](./ROADMAP.md) | Status de las 5 oleadas + lo que queda |

---

## Licencia

[MIT](./LICENSE) © 2026 Maximiliano Rossi
