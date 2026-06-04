# Hallazgos — Atribución real de agentes (Parte C) + diferencias Copilot vs Claude

> Fecha: 2026-06-01 · Branch: `suris` (sin commitear al momento de escribir).
> Consolida los hallazgos de la sesión de verificación sobre el fixture
> [`sdd-template-lab`](../../README.md) y el target real.
> Regla canónica: [`COPILOT-STORAGE.md §Agent Attribution Rule`](../COPILOT-STORAGE.md).
> Antecedente: [`2026-05-28-real-agent-attribution.md`](2026-05-28-real-agent-attribution.md).

## TL;DR

1. Varios paneles seguían mostrando **co-ocurrencia por menciones de texto**
   (falsos positivos) en vez de **delegación real** (`runSubagent`/`Agent`). Se
   reconectaron a la señal real: grafo de relaciones, chips del header de sesión,
   `distinct_agents`.
2. El contador **"turns"** estaba inflado: contaba mensajes `assistant`, y Claude
   parte cada `tool_use` en su propio mensaje assistant. Ahora cuenta **turnos
   reales** (la misma clave que las Ejecuciones).
3. **Claude Code delega SIEMPRE a `general-purpose`** (built-in); el rol real va en
   la `description` de la tool `Agent`. Se resuelve el agente declarado desde ese
   campo estructurado. (En Copilot el nombre declarado viene nativo en `runSubagent`.)

---

## Contexto: la señal de intervención

Repaso de la regla que ya regía (ver doc del 2026-05-28):

- **`agent_mentions`** = el nombre del agente aparece en el TEXTO del prompt/response.
  Señal **débil, con falsos positivos**: cuando el orchestrator escribe su plan
  ("voy a usar backend-developer, frontend-developer, tester…"), todos quedan
  marcados aunque nunca intervengan.
- **`agent_invocations`** = delegación **estructural real**: la tool call de
  delegación del orchestrator. **Verdad fuerte por agente.**
  - Copilot: `runSubagent` (`response[].kind=="toolInvocationSerialized"`,
    `toolSpecificData.kind=="subagent"`, `agentName`).
  - Claude Code: tool `Agent` (`type=tool_use`, `name in {Agent, Task}`,
    `input.subagent_type`).

**Regla:** la atribución de "agentes que intervinieron" usa SOLO `agent_invocations`,
nunca menciones por texto.

---

## Hallazgo 1 — Paneles aún cableados a menciones (falsos positivos)

Síntoma observado en el lab: el modal "Flujo de delegaciones" decía correctamente
**0 delegaciones reales**, pero abajo el **Agent Relationship Graph** mostraba
6 agentes / 15 conexiones. Contradicción.

**Causa:** el endpoint `GET /api/projects/:id/agent-graph` se construía de
`agent_mentions`. El lab tiene **una sola sesión Claude** (la que construyó el repo y
escribió los 6 `.agent.md`); como los 6 nombres aparecieron en un mismo texto, el
grafo conectaba todo par que comparte sesión → **grafo completo C(6,2)=15** sin que
nadie delegara de verdad.

**Fix** (`backend/app/api/sessions.py`):

- `agent-graph` se reescribió para construirse de `agent_invocations`
  (**co-delegación real**): nodo = `agent_name`; edge A↔B si ambos fueron delegados
  en la misma `session_id`. Campos extra por nodo: `declared` (mapea a un agente del
  repo) y `with_result` (delegaciones con output no vacío).
- Schema `AgentGraphNode/Edge`: `id/source/target` pasaron de `UUID` a `str` (el
  nodo se identifica por `agent_name`, porque la delegación viaja por nombre y los
  built-ins no tienen `agent_id`).
- UI (`AgentGraphPanel.tsx`): relabel a "Co-delegación real (runSubagent/Agent)…",
  estado vacío explícito, tag `ext` para agentes no declarados.

**Resultado:** lab → grafo vacío (0 delegación real, honesto); target real →
8 nodos / 17 edges reales (backend-developer, Explore, frontend-developer, etc.).

---

## Hallazgo 2 — Header de sesión: chips y `distinct_agents` por menciones

El header de la sesión mostraba **6 chips de agentes** y `distinct_agents=6`, también
derivados de `agent_mentions`. El panel "Agentes que intervinieron" ya decía 0
correctamente → contradicción.

**Fix** (`backend/app/api/sessions.py`):

- `list_sessions.distinct_agents`: de `AgentMention` →
  `count(distinct agent_name)` de `agent_invocations` por sesión. Lab: 6 → 0.
- `session_replay.agents_in_order` (los chips): de `agent_mentions` →
  `agent_invocations` ordenado por `order_index/timestamp` (dedup preservando
  orden). Lab → `[]` (sin chips engañosos).
- Las menciones per-evento (`SessionEvent.agent_mentions`) se **mantienen**, pero
  solo en el **timeline CRUDO** (señal débil, claramente etiquetada).

**Efecto colateral intencional:** `SessionsPanel.canShowFlow` depende de
`agents_in_order`; con 0 delegaciones reales el botón "Ver flujo" se **oculta** (antes
abría un modal vacío). El estado 0 ya lo explican el panel "Agentes que intervinieron"
y el grafo vacío.

---

## Hallazgo 3 — Bug de conteo de `turns` (inflado por mensajes assistant)

El header mostraba **"28 turns"** pero las Ejecuciones decían **"2 turnos"**.

**Causa:** `turns` se calculaba como `count(event_type=='assistant')`
(`list_sessions`) y `turns += 1` por assistant (`session_replay`). **Claude parte
cada `tool_use` en su propio mensaje assistant** → infla. Las Ejecuciones, en cambio,
agrupan por turno real vía `_build_executions` (clave `turn_id || request_id ||
external_id`).

**Fix:** ambos contadores ahora cuentan **turn-keys distintos** con la misma clave
que `_build_executions`. Verificado: lab 28 → 2; target real `<session-A>`=119,
`<session-B>`=14. El header del summary y del replay coinciden con las Ejecuciones.

> Nota de modelo: el `turn_id` lo estampa `_assign_turns` en `claude_logs.py` (= uuid
> del prompt REAL de usuario). Copilot no trae `turn_id` y cae a `request_id`, que ya
> es su turno → intacto.

---

## Hallazgo 4 — Claude delega a `general-purpose`; el rol va en la `description`

Al correr el Escenario D (T013, multi-agente) con Claude Code, el flujo mostró
**5 delegaciones reales** pero **todos los nodos decían `general-purpose`**.

**Causa (NO es bug de captura):** Claude Code **no lee** los
`.github/agents/*.agent.md` (eso es formato SDD/Copilot). Cuando el orchestrator
(Claude haciendo roleplay) delega, el tool `Agent` trae
`input.subagent_type = "general-purpose"` (built-in) para TODAS las delegaciones, y
el **rol real va en `input.description`** con prefijo claro:

| `description` | `subagent_type` | result |
|---|---|---|
| `Architect: archive contract + ADR` | general-purpose | ✓ |
| `Backend: archive/unarchive endpoints` | general-purpose | ✓ |
| `Frontend: archive/unarchive UI` | general-purpose | ✓ |
| `Tester: validate T013` | general-purpose | ✓ |
| `Pre-merge-gate: T013 close` | general-purpose | ✓ |

Como el grafo se indexa por `agent_name`, las 5 habrían colapsado en **un solo nodo
`general-purpose` sin relaciones**.

**Fix** (`backend/app/services/claude_logs.py` — `_resolve_from_description`):

- Cuando el `subagent_type` es un built-in y **no** mapea a un agente declarado, se
  toma el token antes del primer `:` de la `description` y se matchea contra los
  agentes declarados del proyecto (exacto / prefijo / primera palabra; p.ej.
  "backend" → "backend-developer"). **Solo resuelve si el match es ÚNICO**
  (conservador).
- Si matchea: se setea `agent_id` + `agent_name = nombre declarado` (`declared:true`)
  → el grafo/flujo/chips/invoked-agents muestran el rol.
- `_agent_name_map` ahora devuelve por proyecto `{by_key: {nombre→id}, by_id:
  {id→nombre}}`.

**Por qué es defensible:** la `description` es un **campo estructurado de la tool
`Agent`** (`tool_use.input.description`), NO prosa suelta del chat → NO recae en el
falso-positivo de menciones. Es la intención explícita de delegación que el
orchestrator codifica en el evento estructural.

**Resultado:**

- Lab → 5 declarados (architect, backend-developer, frontend-developer, tester,
  pre-merge-gate). Grafo 5 nodos / 10 edges (C(5,2), co-delegados misma sesión).
- target real → `Explore` (14) y `general-purpose` (4) **siguen sin resolver**
  (`declared:false`) porque sus descriptions no matchean un declarado único —
  correcto, la heurística no sobre-atribuye.

---

## Copilot vs Claude — tabla de atribución

| Aspecto | Copilot | Claude Code |
|---|---|---|
| Tool de delegación | `runSubagent` | `Agent` (también `Task`) |
| Nombre del agente | `toolSpecificData.agentName` (nombre **declarado** nativo) | `input.subagent_type` (built-in **`general-purpose`**) |
| Rol declarado | viene directo en `agentName` | hay que **inferirlo de `description`** |
| `.github/agents/*.agent.md` | conoce los nombres (matchea `agentName`) | **no los carga** (roleplay del default agent) |
| Modelo del subagente | sí (`modelName`) | no lo trae (`model=None`) — **pendiente** |
| Dedup | por `toolCallId` (placeholder + final con mismo id) | por `tool_use.id` (único, sin placeholders) |
| `turn_id` | no (cae a `request_id`) | sí (`_assign_turns`) |

---

## Notas operativas

- **GOTCHA de backfill (Claude):** `_persist_invocations` usa
  `on_conflict_do_nothing` por `external_id` → re-correr el collector **NO** actualiza
  filas existentes. Para re-resolver invocaciones ya ingestadas hay que
  `DELETE FROM agent_invocations WHERE provider='claude'` y re-ingestar (idempotente,
  recrea todo desde los logs). Copilot no necesita esto (su `agentName` ya es el
  nombre declarado).
- **PRIVACY:** capturar el texto del `result`/`prompt` requiere
  `PRIVACY_MODE=sanitized_payload` (local, redacta tokens/JWT/PEM/passwords). En
  `metadata_only` solo queda `result_chars`.
- **Verificación rápida:**
  ```bash
  curl -s -X POST "http://localhost:8000/api/runtime/collector/run?provider=claude"
  curl -s "http://localhost:8000/api/runtime/invoked-agents?project_id=<PID>"
  curl -s "http://localhost:8000/api/projects/<PID>/agent-graph"
  ```

---

## Estado / pendientes

- [x] `agent-graph` reconectado a co-delegación real.
- [x] Header de sesión (chips + `distinct_agents`) reconectado a invocaciones.
- [x] Bug de `turns` (inflado por assistant) corregido.
- [x] Resolución Claude `general-purpose` → agente declarado vía `description`.
- [ ] Modelo del subagente en Claude (el `tool_use` no lo trae → `model=None`).
- [ ] Commit de toda esta capa (branch `suris`).
- [ ] Repasar otros paneles (`TopAgentsPanel`, Intelligence) por si quedan restos de
      la señal de menciones.
