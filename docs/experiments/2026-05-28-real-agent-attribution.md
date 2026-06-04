# Evidencia — Atribución REAL de agentes (Copilot runSubagent)

> **Fecha:** 2026-05-28
> **Branch:** `suris`
> **Target observado:** un repo target real (SCAN_TARGET_PATH)
> **Objetivo:** distinguir agentes que *efectivamente intervienen* (delegación
> del orchestrator) de los meramente *mencionados en texto* (falsos positivos),
> y validarlo con un experimento controlado de delegación forzada.

Este documento registra el proceso de punta a punta: diagnóstico → investigación
empírica → implementación → validación pasiva → experimento controlado →
hallazgos → decisiones.

---

## 0. Problema

En SDD Observatory, la atribución de "agentes intervinientes" daba falsos
positivos: **todos los agentes parecían intervenir**. La causa: `_persist_mentions`
(en `copilot_storage_adapter.py` y `claude_logs.py`) marcaba como interviniente a
TODO agente cuyo nombre apareciera en el prompt/response vía regex `\b{name}\b`.

Cuando el orchestrator escribe su plan ("voy a delegar en backend-developer,
frontend-developer, tester…"), **los nombra a todos en texto → todos quedan
marcados**, aunque solo se ejecute uno (o ninguno).

Comparativa global previa al fix (target real):

```
agentes con MENCIÓN runtime:  26   ← devops.agent 99, orchestrator 71, AGENTS 45, CLAUDE 25, refinement 45...
agentes con INVOCACIÓN real:   5   ← backend-developer 9, frontend-developer 8, satellite-developer 3, Explore 2, frontend-tdd 2
```

---

## 1. Investigación empírica de los datos de Copilot

VS Code persiste cada sesión de Copilot Chat en
`~/.config/Code/User/workspaceStorage/<hash>/chatSessions/`. Hallazgos:

- **Dos formatos conviven:** `.json` (objeto pretty-printed, viejo) y `.jsonl`
  (delta-log append-only `kind 0/1/2`, nuevo y mayoritario, hasta 21 MB). Al
  deduplicar por basename, preferir `.jsonl`.
- Cada `request` reconstruido tiene: `message.text` (prompt), `response[]`,
  `agent` (participante nativo de Copilot, p.ej. `github.copilot.editsAgent` —
  NO el sub-agente speckit), `contentReferences`, `variableData` (instruction
  files adjuntos), `timestamp`.

### La señal real de intervención

La delegación de verdad es la tool call **`runSubagent`** dentro de
`response[].kind == "toolInvocationSerialized"`, con `toolSpecificData`:

```json
{
  "kind": "subagent",
  "agentName": "satellite-developer",
  "description": "Audit wrapper gaps vs backend",
  "prompt": "## Contexto\n...",
  "modelName": "Claude Opus 4.5",
  "result": "# Reporte de Diagnóstico ..."
}
```

`execution_subagent` (otro toolId) es distinto: wrapper de ejecución en
background (correr tests), NO nombra agente. No se usa para atribución.

### GOTCHA de conteo (doble conteo)

Una misma delegación lógica aparece **2-3 veces** en `response[]` (un placeholder
con `result` vacío + la versión final con `result` lleno), todas con el MISMO
`toolCallId`. Hay que **deduplicar por `toolCallId`** quedándose con la entrada de
`result` más largo. Sin dedup daba 50; deduplicado real = 24 (histórico).

---

## 2. Implementación (backend + UI)

**Modelo / persistencia**
- Tabla nueva `agent_invocations` (modelo `AgentInvocation`, migración `0006`).
  Idempotente por `(provider, external_id)` con
  `external_id = copilot:subagent:{request_id}:{toolCallId}`.
  `agent_id` nullable (agentName puede no ser agente declarado, p.ej. "Explore").
- Persistencia FUERA del gate de insert del evento → backfillea sesiones ya
  ingestadas.
- Resolución `agentName` → agente declarado (con/sin sufijo `.agent`,
  case-insensitive).

**Logging extendido ("loggear todo lo posible")**
- `event_metadata.tool_calls_detail[]`: comando de terminal + `state`
  (exitCode/duration), archivos tocados, todos (`manage_todo_list`), agente
  delegado. `delegated_agents[]` por turno. Cap 300 por turno.
- Sanitiza comandos/prompts (redacta tokens/passwords). Backfill auto-limitado de
  metadata en eventos viejos (UPDATE WHERE NOT key).

**API**
- `GET /api/runtime/invoked-agents` — agentes que realmente intervinieron.
- `GET /api/runtime/invocations` — lista de delegaciones (filtro por session_id).

**UI**
- `TopAgentsPanel` → "Agentes que intervinieron" (invocaciones reales).
- `AgentFlowModal` → grafo desde delegaciones reales por turno; estado vacío
  honesto cuando no hubo `runSubagent`.

---

## 3. Validación pasiva — sesión T479 (tarea chica)

Prompt: *"Implementar T479 del cycle 4 (Modales crear/editar regla de límite,
HU-28-FE)…"*. El orchestrator resolvió **todo inline**, sin delegar.

```
Turno T479: 111 tool calls (readFile 47, findFiles 20, terminal 17, listDir 8,
            todos 6, findText 6, multiReplaceString 3, replaceString 2, ...)
Delegaciones reales (runSubagent): 0
Agentes intervinientes:            0   ✅ correcto
```

→ **Actividad intensa ≠ intervención de agentes.** El modelo viejo de menciones
habría marcado falsamente a frontend-developer/architect/etc. (nombrados en
specs/prompt). El nuevo: 0 agentes intervinientes. Correcto.

---

## 4. Experimento controlado — delegación forzada

Prompt diseñado para que sea **imposible resolver sin delegar** (reglas: "MUST
NOT implement directly", "MUST delegate via real sub-agent invocations", evidencia
obligatoria por agente). Agentes requeridos: `frontend-developer`,
`backend-developer`, `frontend-tdd`. Scope multidominio real (HU-28 Límites,
FE+BE+tests). Ejecutado en **Autopilot (Preview)**, modelo Claude Sonnet 4.6.

### Lección de método

Una lectura **a mitad de la sesión** mostró solo `frontend-developer` y llevó a
una conclusión prematura ("Copilot no delega de verdad"). Con la sesión
**completa** (autopiloto + tiempo), el orchestrator SÍ delegó en serie a los 3.
→ **No concluir sobre delegación hasta que el turno se estabilice** (sin cambios
~3 min en el `.jsonl`).

### Resultado FINAL (sesión completa, dedup por toolCallId)

```
agent_name          | invocaciones | con_result | max_result_chars | modelo
--------------------+--------------+------------+------------------+------------------
frontend-developer  |      2       |     1      |       184        | Claude Sonnet 4.6
backend-developer   |      1       |     1      |      4537        | Claude Sonnet 4.6
frontend-tdd        |      1       |     1      |      1566        | Claude Sonnet 4.6
```

**3/3 agentes requeridos delegados de verdad.** Cada `runSubagent` con
`isComplete=True`, prompts reales de ~2.8k–10k chars, modelos reales.

Actividad TOTAL del/los turno(s) de delegación (≈420 tool calls; solo **4** son
delegaciones reales):

```
copilot_readFile 168 · run_in_terminal 85 · findFiles 42 · findTextInFiles 36 ·
replaceString 27 · multiReplaceString 19 · listDirectory 16 · manage_todo_list 12 ·
runSubagent 7 (=4 dedup) · getErrors 4 · createFile 2
```

Menciones por texto registradas en la sesión: solo `AGENTS ×3`. **Importante:** el
matcher de menciones exige el nombre con sufijo `.agent`; el orchestrator escribió
los nombres pelados (`frontend-developer`), así que el contraste texto-vs-real
queda enmascarado por una limitación del matcher en ESTA sesión. El contraste real
se ve mejor en los números globales (§0: 26 menciones vs 5 invocaciones) y en que
el orchestrator nombró a los 3 agentes muchas veces en prosa, pero solo se
capturan vía `runSubagent`.

### Degradación por delegación (hallazgo)

Los sub-agentes reescribieron el módulo Límites y **eliminaron exports en uso**
(`useLimitRuleMerchants`, `useToggleLimitRuleStatus`, `SCOPE_LABELS`,
`PERIOD_LABELS`, `TRANSACTION_TYPE_LABELS`) → **7 regresiones**. El orchestrator
las reparó él mismo inline (editó `limit.types.ts`, `limits.api.ts`). Cierre:
"Todos (4/4)", 8 archivos cambiados (+345/-123). → El `result` "exitoso" de un
agente **no garantiza** que no rompió otra cosa.

### Resiliencia a compactación (hallazgo)

A mitad de la sesión Copilot ejecutó "Compacted conversation" (manejo de context
window, deja una clave `summary` en el estado). **El parser de `runSubagent`
sobrevive**: la reconstrucción por deltas preserva el array de `requests` y las 4
delegaciones quedan intactas. No afecta la ingesta.

### Evidencia capturada (result parcial sanitizado)

Con `PRIVACY_MODE=sanitized_payload`, el `result` de backend-developer (4537c) es
su propio reporte de evidencia:

```
## Reporte de Revisión — Backend Módulo Límites (HU-76-BE / HU-28-FE)
### 1. Archivos inspeccionados
| Archivo | Tipo |
| BackofficeLimitRuleController.java | Controller REST |
| LimitRuleResponse.java             | DTO response |
| CreateLimitRuleRequest.java        | ...
```

> Nota: este reporte es el **claim del propio agente** (qué dice que inspeccionó),
> no atribución estructural verificada de archivos. Ver §6.

---

## 5. Estructura del log — por qué no hay atribución de archivos por agente

Secuencia de tool calls del turno de delegación (extracto):

```
manage_todo_list → ◆ runSubagent[frontend-developer] → listDirectory ×4 →
readFile ×20 → findTextInFiles → replaceString → multiReplaceString ×3 →
... → run_in_terminal ×10 → ...   (194 tool calls en total)
```

Copilot **aplana los tool calls del sub-agente en el array `response[]` del
orchestrator padre**, después del marcador `runSubagent`, sin ownership anidado.
Y el orchestrator intercala trabajo inline propio entre delegaciones — lo narra
él mismo:

> *"El agente retornó parcialmente. Verifico el estado actual de los archivos y
> ejecuto los tests antes de delegar al siguiente agente… Hay 3 tests fallando."*

→ Las ediciones que siguen a un `runSubagent` son una **mezcla** de (a) el
sub-agente y (b) el orchestrator. El log no los separa.

---

## 6. Regla de Atribución (decidida y documentada)

Documentada en `docs/COPILOT-STORAGE.md §Agent Attribution Rule`:

- **Verdad fuerte por agente (evidencia estructural)** = `runSubagent[agent]` +
  `prompt` + `result` parcial sanitizado. Es lo que guarda `agent_invocations` y
  lo que la UI presenta como "agentes que intervinieron".
- **Atribución de archivos/tools por agente NO está garantizada** por el formato.
- **Atribución por posición** (tool calls entre `runSubagent[A]` y
  `runSubagent[B]` → agente A) solo como **heurística etiquetada**.
- **No presentar modificaciones de archivos como hechas definitivamente por un
  agente** salvo que el log traiga ownership anidado explícito.

Matiz **invocado vs completado-con-output**: un `runSubagent` puede venir
`isComplete=True` con `result` vacío/parcial ("el agente retornó parcialmente").
Distinguir invocación (`runSubagent` emitido) de resultado (`result_chars > 0`).

---

## 7. Decisiones tomadas

1. **`PRIVACY_MODE=sanitized_payload`** (local) — para capturar el texto del
   `result` parcial + prompts, pasando por el sanitizer (redacta
   tokens/JWT/PEM/passwords). En `metadata_only` solo quedaba `result_chars`.
2. **Modelo de señales:**
   - `agent_mentions` → solo texto (señal débil, falsos positivos). NO usar para
     "intervención".
   - `agent_invocations` → ejecución real. Verdad fuerte por agente.
   - `delegated_agents_count` → derivado de invocations reales.
3. **No prometer "archivos por agente"** todavía (el log no lo soporta limpio).

---

## 8. Conclusiones

1. **Copilot SÍ delega de verdad (runSubagent) cuando se lo fuerza y se le da
   tiempo.** El experimento controlado produjo 4 delegaciones reales a los 3
   agentes requeridos, con prompts y results reales, `isComplete=True`. La
   hipótesis "Copilot solo dice que delega" se cumple a medias: delega de a poco,
   parcial, y mezclado con trabajo propio — pero las delegaciones son reales y
   estructurales.

2. **La detección estructural es la correcta.** `runSubagent` + `toolCallId`
   captura exactamente lo que intervino (4, deduplicado de 7 entradas crudas) e
   ignora lo que el orchestrator solo *nombró* en prosa. Detectar por texto habría
   inflado el conteo (ver §0: 26 vs 5 global).

3. **Actividad ≠ intervención.** El turno tuvo ~420 tool calls (168 readFile, 85
   terminal, 46 ediciones) pero solo 4 son delegaciones. T479 (§3) lo confirma por
   contraste: 111 tool calls, 0 delegaciones.

4. **La delegación real puede degradar calidad.** Los agentes introdujeron 7
   regresiones (borraron exports en uso); el orchestrator reparó inline. El éxito
   reportado por un agente no es garantía de integridad del sistema.

5. **El orchestrator no respeta "MUST NOT edit".** Hace trabajo inline sustancial
   (ediciones, tests, reparaciones) pese a la instrucción. Real-world ≠ ideal del
   prompt.

6. **Atribución de archivos por agente NO es posible** desde este formato: Copilot
   aplana los tool calls del sub-agente en el array del padre, mezclados con el
   inline del orchestrator (§5). La verdad por-agente se limita a
   delegación + prompt + `result` (auto-reporte del agente).

7. **El `result` parcial es valioso y ahora se captura** (`sanitized_payload`):
   es el reporte de evidencia del propio agente (archivos inspeccionados, etc.).

8. **Robustez operativa:** el parser sobrevive a la compactación de Copilot.

9. **Lección de método:** no concluir sobre delegación a mitad de sesión — esperar
   estabilización (~3 min sin cambios en el `.jsonl`). Una lectura temprana dio un
   veredicto falso ("solo frontend-developer").

---

## 9. Estado y pendientes

- [x] Backend: modelo + migración 0006 + captura runSubagent + dedup + logging
      extendido + endpoints. Commit `020c6bf`.
- [x] UI: TopAgentsPanel + AgentFlowModal sobre datos reales.
- [x] `PRIVACY_MODE=sanitized_payload`; regla de atribución documentada.
- [x] Experimento controlado de delegación forzada — completado (sesión
      `<session-id>`, 4 delegaciones reales a 3 agentes, results capturados).
- [ ] Exponer `result_chars` / estado invocado-vs-completado en la UI.
- [ ] Commit del flip de privacy + doc de la regla + cap 300 + esta evidencia.
- [ ] (Opcional) Paridad Claude (Task tool con `subagent_type`) — Copilot es
      prioridad.

> **Cierre:** sesión experimental terminada y ingestada. §4 y §8 reflejan los
> números finales. Evidencia completa de 0→fin documentada.
