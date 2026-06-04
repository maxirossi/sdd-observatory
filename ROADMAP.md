# SDD Observatory — Roadmap

> Status: **v0.2 funcional**. 7 oleadas cerradas. Pendiente: replay narrativo profundo + multi-project.

---

## Cerrado

### ✅ Wave 1 · Cycle + Progress + Health
- `GET /api/projects/:id/cycles` con breakdown por dominio (BE/FE/Wrapper/...)
- `GET /api/projects/:id/health` con score compuesto (4 dimensiones a 25%)
- `HealthBanner` con 6 KPIs · `CyclesPanel` con cross-cycle chart + DomainRow

### ✅ Wave 2 · Sesiones + Agent graph
- `GET /api/projects/:id/sessions` lista con duración, agents distintos, modelos
- `GET /api/sessions/:sid` replay timeline ordenado
- `GET /api/projects/:id/agent-graph` co-ocurrencia en sesiones
- `SessionsPanel` + `AgentGraphPanel` interactivo

### ✅ Wave 3 · Explorer + Heatmap
- `GET /api/projects/:id/tree` árbol con flags A/D/T + mentions agregadas
- `GET /api/projects/:id/file-info` cross-info por path
- `ExplorerPanel` 2-col con árbol filtable + panel derecho

### ✅ Wave 4 · Intelligence
- `GET /api/projects/:id/dependency-graph` refs T260→T263 entre tasks
- `GET /api/projects/:id/scope-drift` runtime vs prefix esperado
- `GET /api/projects/:id/dead-agents` clasificación active/inactive/runtime_only/declared_only
- `GET /api/projects/:id/coverage-matrix` matriz runtime × docs × tasks
- `IntelligencePanel` con 4 tabs

### ✅ Wave 5 · Inferencia + Búsqueda
- `GET /api/projects/:id/correlation` cross-entity por archivo
- `GET /api/projects/:id/architecture` detección heurística (frameworks/patterns/deployment)
- `GET /api/projects/:id/search?q=` full-text transversal
- `Wave5Panel` con 3 tabs

### ✅ Wave 6 · Runtime capture refactor
- `ProviderAdapter` ABC + adapters claude/copilot
- Sanitizer extendido (PEM, GitHub PATs, Slack, cookies, connection strings)
- Inference de task_ids/paths/agents en `event_metadata.inference`
- Collector unificado + watch loop provider-agnostic
- Endpoints `/api/runtime/*` (health/providers/top-agents/collector-run)
- `RuntimeObservabilityPanel` con provider cards + live stream

### ✅ Wave 8 · Copilot Storage Adapter
- Descubrimiento: VS Code persiste cada sesión Copilot Chat en `~/.config/Code/User/workspaceStorage/<hash>/chatSessions/*.jsonl` como append-only delta log
- `CopilotChatStorageAdapter` reconstruye el state (`kind=0/1/2`) y persiste prompt + response + native agent + tool calls + contentReferences
- Atribución por `workspace.json["folder"]` exacto, sin heurísticas LCP
- Mentions runtime sobre prompt/response → matches con agents del repo (AGENTS, orchestrator, speckit.*, backend-developer.agent, etc)
- 39 archivos · 1185 events · 30 mentions · 6 native agents distintos detectados
- Doc: [`docs/COPILOT-STORAGE.md`](./docs/COPILOT-STORAGE.md)

### ✅ Fase 1 UX · Sidebar + routing
- react-router-dom + AppLayout shell
- 10 páginas (Overview / Cycles / Tasks / Agents / Runtime / Sessions / Explorer / Intelligence / Providers / Settings)
- URLs deep-linkables `/projects/:id/<module>`
- Topbar project selector con pulse dot

### ✅ UX/UI polish v0.2
- Typography scale (sidebar 14, KPIs 36, labels uppercase tracking)
- `.card-elev` con linear gradient + box-shadow
- Scrollbar custom + pulse-dot + fade-in animations
- Inter + JetBrains Mono con cv11/ss01 features
- Per-page polish (Overview/Cycles/Runtime/Tasks/Agents/Settings)

### ✅ Scanner fix + domain
- Regex de tasks acepta `**bold**` y códigos `T-SEC-001`
- 22 → 338 tasks detectadas
- Campo `domain` con detección por tag `[Backend]` o sufijo `HU-XX-BE`
- Upsert por (project_id, name) en agents → no rompe FKs de runtime mentions

---

## Pendientes priorizados

### Próxima ola natural (1-2 sesiones)

- [ ] **Session Replay narrativo profundo.** Hoy `/api/sessions/:sid` devuelve timeline; falta UI tipo LangSmith con eventos colapsables, tool_use trees, prompt/response diffs (cuando capture_payload está activo)
- [ ] **Agent Context profundo.** Click en `refinement.agent` debería abrir vista completa: runtime sessions, tasks impactadas, docs relacionadas, commits, drift, archivos modificados, ciclos asociados
- [ ] **Runtime attribution mejorada.** Afinar la cobertura de `agent_mentions` runtime sobre prompt/response

### Mediano plazo

- [ ] **Multi-project.** Hoy hay 1 proyecto scaneado. Soportar varios con landing real, comparar, agregar a sidebar
- [ ] **Edición inline de provider flags.** Hoy Providers page es read-only; falta toggle con PUT
- [ ] **Trigger de scan-project desde UI.** Hoy es CLI only
- [ ] **Retention policy.** Auto-delete de runtime_events viejos (>90 días?)
- [ ] **Historical analytics.** Comparar semana vs semana, deltas mes a mes
- [ ] **Team analytics.** Si hay N developers usando el mismo repo, separar runtime por usuario

### Long shots (no comprometidos)

- [ ] **Semantic search real** con pgvector + embeddings (hoy es ILIKE)
- [ ] **Plugin VS Code propio** que postea directo al backend (cero setup)

---

## Limitaciones conocidas v0.2

- **Scanner detecta 338 tasks de las ~339 reales** del target real. 1 task con formato irregular se escapa.
- **`agents_referenced` en cycles está siempre en 0**. La heurística que lo calcula no anda; arreglar.
- **Re-scan borra runtime_claude mentions y depende del watch loop para repoblar.** Conviene esperar 60s después de scannear.
- **Architecture detection no detecta Python projects con setup.py** (solo pyproject.toml + alembic.ini).
