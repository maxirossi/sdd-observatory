# Estado para revisar — Atribución real de agentes Copilot (2026-05-28)

> Resumen ejecutivo de la sesión de trabajo. Sin commitear lo nuevo (por pedido).
> Leé esto primero; los detalles están en los docs linkeados.

## TL;DR

Implementamos y validamos en runtime la **atribución REAL de agentes** en Copilot:
distinguir los que *efectivamente intervienen* (delegación `runSubagent`) de los
*mencionados en texto* (falsos positivos). Corrimos un experimento controlado de
delegación forzada y, al analizarlo, descubrimos que **el agente custom "orchestrator"
nunca corrió** — todo fue el agente default de Copilot haciendo roleplay.

## Qué se construyó

**Backend (committeado en `020c6bf`)**
- Tabla `agent_invocations` (modelo + migración `0006`). Captura `runSubagent`:
  agentName, prompt, result, model, link al evento padre. Dedup por `toolCallId`
  (una delegación aparece 2-3× en `response[]`). Idempotente; backfillea sesiones
  ya ingestadas.
- Logging extendido `event_metadata.tool_calls_detail[]` (comandos+exitCode, archivos,
  todos, agente delegado), cap 300/turno. Sanitizado.
- Endpoints `GET /api/runtime/invoked-agents` y `/api/runtime/invocations`.

**UI** (SIN COMMITEAR — rework de hoy)
- `TopAgentsPanel` → "Agentes que intervinieron" (invocaciones reales) — committeado.
- `AgentFlowModal` reescrito ("Flujo de delegaciones"): **nodos enriquecidos**
  (agente + tarea + estado de result ✓Nc/⚠ + modelo) + **separado por turno**
  (cada turno = nodo etiquetado con su prompt + sus delegaciones, edges troncales
  animados). Inspector con invocado-vs-completado.
- `SessionsPanel` → nuevo **panel "Delegaciones reales"** (lista por turno: prompt ·
  agente · tarea · result · modelo), debajo del header del replay. Es la vista más
  legible para entender el flujo sin abrir el grafo.
- Datos: vía `/api/runtime/invocations?session_id=` + `prompt_preview` del replay
  para etiquetar turnos. Verificado end-to-end con la sesión `<session-id>`.

**Docs (committeado en `5e37668`)**
- `docs/COPILOT-STORAGE.md §Agent Attribution Rule`.
- `docs/experiments/2026-05-28-real-agent-attribution.md` (evidencia 0→fin).

**Config (local, gitignored)**
- `.env`: `PRIVACY_MODE=sanitized_payload` — para capturar el texto del `result`
  parcial de las delegaciones. **Solo local.**

## Estado git ahora

```
último commit: 5e37668
SIN COMMITEAR:
  M frontend/src/components/AgentFlowModal.tsx        (UI invocado-vs-completado)
  ?? docs/experiments/ideal-orchestrator-prompt-HU28.md
  ?? docs/experiments/2026-05-28-ESTADO-para-revisar.md  (este archivo)
  (.env modificado pero gitignored → no aparece)
DB: 28 invocaciones reales, 6 sesiones con delegación.
```

## Hallazgos clave

1. **El "orchestrator" nunca corrió como tal.** Los 3 turnos de la sesión experimental
   tienen `agent.id=github.copilot.editsAgent` (modo Agent default), y `orchestrator.agent.md`
   nunca se adjuntó. Los `.github/agents/*.agent.md` son **roleplay** (lo dice
   `copilot-instructions.md:37,45`; no hay `.github/chatmodes/`). El read-only del
   orchestrator (`tools:[codebase,search,agent]`) es intención documentada, NO un límite.
   Por eso editó inline e ignoró "MUST NOT edit". Detalle: `ideal-orchestrator-prompt-HU28.md`.
2. **La delegación por `runSubagent` SÍ es real y bien atribuida** — independientemente
   del agente padre. Experimento: 4 delegaciones a frontend-developer ×2, backend-developer,
   frontend-tdd (Claude Sonnet 4.6), con results de 184–4537 chars.
3. **Actividad ≠ intervención.** El turno tuvo ~420 tool calls y solo 4 delegaciones.
   T479 (tarea chica): 111 tool calls, 0 delegaciones.
4. **La delegación puede degradar calidad**: los sub-agentes borraron exports en uso
   → 7 regresiones → reparadas inline. Y el flujo **cortó en el resumen** sin gate final
   (el `pre-merge-gate` no es default del orchestrator).
5. **Robustez**: el parser sobrevive a "Compacted conversation" de Copilot.

## Feature nueva: Flow por tarea (29-may, SIN COMMITEAR)

Detección de patrones a nivel TAREA: qué agentes intervinieron (delegación real) en
cada tarea, con patrones por dominio y anomalías.
- **Backend**: `GET /api/projects/:id/task-flows` (en `intelligence.py`). Infiere
  `task_ref` por cascada (description regex `T\d+`/`HU-XX-XX` → `inference.task_ids`
  del evento padre). Agrupa por tarea → agentes (inv/with_result/declared), sesiones.
  **Patrones** por dominio (frecuencia de cada agente). **Anomalías**:
  `domain_mismatch` (agente de otro dominio, ej. FE task con backend-developer) +
  **`few_agents`** (⚠ <2 agentes — flujo incompleto, pedido explícito) + `no_result`.
- **Frontend**:
  - `TaskFlowsPanel` (vista dedicada en Intelligence): patrones por dominio + lista
    de flows con warnings resaltados.
  - `TasksPage`: nueva columna **"Flow (agentes)"** con chips por agente + ⚠<2.
- Verificado: backend tasks con solo `backend-developer` (sin test) salen flaggeadas
  `few_agents`; T478/T479 (FE) muestran frontend-developer + frontend-tdd, sin anomalía.

## Feature nueva: Barra de estado en vivo (29-may, SIN COMMITEAR)

Una franja en el **topbar global** que muestra "en vivo" el estado de la ejecución
de Copilot en curso, cambiando texto in-place (no apila) y cerrándose sola al
terminar.
- **Backend**: `services/live_status.py` + `GET /api/runtime/live-status?project_id=`.
  Lee el tail del chatSession más reciente del proyecto (NO la DB — el watch loop de
  60s es muy lento). Deriva fase: `starting` / `delegating` / `agent_working` /
  `verifying`, + `current_step` (el todo `in-progress` de Copilot), `active_agent`
  (último runSubagent con result vacío), `agents_done`, todos done/total. Activo si
  el archivo se modificó hace <45s.
- **Frontend**: `LiveStatusBar` (en `AppLayout` topbar) pollea cada 2s mientras hay
  actividad, transiciona texto in-place, y al pasar a inactivo muestra "✓ Finalizado"
  ~3.5s y se oculta. **Spinner** (Loader2 girando) + **fondo azul oscuro** (gradiente
  #0a1733→#0c1e3f) con acento lateral por fase + **chip de branch** (GitBranch +
  nombre, leído de `.git/HEAD` del target montado, ej. `feat/bo-limits-fe-t478-hu28`).
- **Toggle**: Settings → "Interfaz" → "Barra de estado en vivo" (on/off, **default
  true**, guardado en localStorage del navegador vía `lib/liveStatusPref.ts`).
- Verificado en vivo: con la sesión corriendo muestra phase=delegating,
  current_step="Implementar PATCH /{id}/toggle…", todos 2/4.
- Minor pendiente: backoff de polling cuando está idle (hoy pollea cada 2s siempre).

## Feature nueva: Ejecuciones (subdivisión de sesión, 29-may, SIN COMMITEAR)

Resuelve "sesiones gigantes": una sesión se divide en **ejecuciones** (1 turno =
1 ejecución), cada una etiquetada por su tarea.
- **Backend**: `GET /api/sessions/:sid/executions` (con prompt real) +
  `GET /api/projects/:id/executions` (lista global, sin leer archivos). Agrupa
  runtime_events por (session_id, request_id), infiere task_ref (prompt → description
  de la 1ra delegación → inference.task_ids), enriquece con agent_invocations.
  Campos: task_ref, status (delegated/inline/read_only), duración, tool_calls, edits,
  delegaciones, files. En `sessions.py`.
- **Frontend**:
  - `ExecutionsList` (componente acordeón reusable): fila colapsable por ejecución
    (#idx · task · status · agentes · duración · tools/edits), expande a prompt +
    delegaciones (agente·tarea·result) + archivos.
  - `SessionsPanel`: la sesión ahora muestra el **acordeón de Ejecuciones** como vista
    principal; el timeline crudo de eventos queda en un `<details>` colapsado abajo.
  - `ExecutionsPage` (nueva, ruta `executions`, nav "Executions" en grupo Runtime):
    lista global de ejecuciones de todas las sesiones, filtrable por texto/status.
- Verificado: `<session-id>` (10h50min, 8 turnos) → 8 ejecuciones navegables (T479, T478,
  auto-dispatch, architect) con status y delegaciones por turno.

## Feature nueva: Re-scan en background + avance por ventana de tiempo (29-may, SIN COMMITEAR)

Antes el progreso de tasks/cycles era un snapshot del último scan manual.
- **Re-scan background** (`main.py` `_scan_watch_loop`): re-escanea el target
  (`scan`+`persist`) al arranque y cada `scan_watch_interval_seconds` (default 3600=1h,
  config `scan_watch_enabled`). Refresca status de tasks sin scan manual. Seguro:
  `persist` guarda el host path (no pisa atribución). Verificado: cycle-4 64%→81% solo.
- **Snapshots** (`cycle_snapshots`, migración 0007, `services/snapshots.py`): en cada
  scan graba done/wip/pending/unknown/total por ciclo con timestamp.
- **Avance por ventana**: `/cycles?since_hours=N` devuelve `delta_done`/`baseline_done`/
  `baseline_at` por ciclo (vs snapshot baseline: el último antes de la ventana, o el más
  viejo si no hay). `CyclesPanel` con selector **actual / 24h / 7días / 30días** y badge
  "+N done" por ciclo.
- Caveat: el delta acumula sentido con el tiempo (snapshots cada 1h); con datos de
  segundos atrás da ±0. Con --reload de uvicorn se graban muchos snapshots (1 por save);
  en prod es 1/hora.

## Feature nueva: Audit module (29-may, SIN COMMITEAR)

Auditoría a nivel repositorio desde la historia git del target. **Requirió instalar
`git` en el Dockerfile del backend** (rebuild hecho; el `.git` ya estaba montado).
- **Backend**: `services/git_audit.py` + `GET /api/projects/:id/audit` (router
  `api/audit.py`). Read-only sobre `/workspaces/target`.
  - **Anomalía — push directo a base**: commits no-merge en first-parent de master
    (lo que entra por PR es 2º parent de un merge → no aparece). Target real: 152 total,
    50 recientes (90d).
  - **Warning — branches grandes**: branches con > N archivos vs merge-base(base)
    (default N=30, top 60 recientes). Target real: 9 (una branch grande, 218 files…).
  - **Contribuidores**: commits + insertions/deletions + files por autor (shortlog +
    numstat). 15 contribuidores.
- **Frontend**: `AuditPage` (ruta `audit`, nav "Audit" en Analysis): resumen del repo
  + anomalías + warnings + tabla de contribuidores. Config en `config.py`
  (`audit_large_branch_files`, `audit_recent_days`, `audit_max_branches`).
- **Caveat heurística**: "push directo a master" = first-parent no-merge. Es preciso si
  el equipo mergea PRs con merge-commit; si hacen **squash-merge**, cada PR queda como
  un commit no-merge en master → se vería como "directo" (falso positivo). El target real
  usa merge-commits (138), así que la heurística aplica bien.
- **Bug encontrado y resuelto**: `for-each-ref` NO interpreta `%x1f` (sí `git log`) →
  el split fallaba y daba 0 branches grandes. Fix: separador tab real.

## Decisiones abiertas (para vos)

- [ ] **`PRIVACY_MODE=sanitized_payload` como default del proyecto** (`.env.example`/
  `docker-compose.yml`) o ¿queda solo local? Hoy: solo `.env` local.
- [ ] **Commitear lo de hoy** (UI invocado-vs-completado + los 2 docs nuevos).
- [ ] ¿Probar el **prompt ideal** adaptado al agente default? (ver abajo).

## Cómo probar mañana

1. **Ver la UI nueva**: abrir el observatorio → Sessions → sesión `<session-id>…` →
   "Ver flujo →". Click en un agente: ahora muestra "Con resultado X/Y" y dots
   verde/ámbar por tarea. (frontend-tdd debería verse con su result; alguno en ámbar.)
2. **Probar el prompt ideal** (opcional): usar la versión "Adaptación para el agente
   default" de `ideal-orchestrator-prompt-HU28.md` §final. OJO: HU-28-FE está cerrada
   → entra en modo verificación. Para orquestación de IMPLEMENTACIÓN real, elegir una
   HU con tasks `[ ]` abiertas.
3. Tras cualquier sesión nueva: `curl -s -X POST "http://localhost:8000/api/runtime/collector/run?provider=copilot"`
   y mirar `/api/runtime/invoked-agents`.

## Punteros

- `docs/experiments/2026-05-28-real-agent-attribution.md` — evidencia completa 0→fin.
- `docs/experiments/ideal-orchestrator-prompt-HU28.md` — prompt ideal + adaptación al
  default agent + riesgos.
- `docs/COPILOT-STORAGE.md §Agent Attribution Rule` — la regla canónica.

## Pendientes / next

- Commit de lo de hoy (cuando lo apruebes).
- (Opcional) Exponer invocado-vs-completado también en `TopAgentsPanel` (hoy solo en
  el flow modal; requiere agregar result info al endpoint `/invoked-agents`).
- (Opcional) Paridad Claude (Task tool) — Copilot es prioridad.
- (Opcional) Re-correr el experimento con una HU abierta para ver orquestación de
  implementación de punta a punta (con gate final).
