# Run 2 — Auto-dispatch T478 (HU-28-FE)

> 2026-05-28. Sesión `<session-id>`, turno auto-dispatch (`request_<id>…`).
> Experimento: que el orchestrator descubra y elija agentes solo, sin que el
> usuario los nombre. La corrida más limpia y exitosa de la serie.

## Veredicto estructural (verificado por el observatorio — NO el auto-reporte)

| Métrica | Valor |
|---|---|
| Tool calls del turno | 96 |
| Primer `runSubagent` | posición **15** (tras 14 de lectura/diagnóstico) |
| **Ediciones ANTES de delegar** | **0** ✅ (criterio "no inline antes de delegar") |
| Delegaciones reales (dedup toolCallId) | **2** |
| → frontend-developer | result **1989c** (completó con output) |
| → frontend-tdd | result **891c** (completó con output) |
| Agente nombrado por el usuario | **ninguno** (auto-dispatch real) ✅ |

## Criterios de éxito del experimento

| Criterio | ✅/❌ | Evidencia |
|---|:---:|---|
| Descubre agentes desde `.github/agents/` | ✅ | `listDirectory` sobre `.github/agents/` en fase inicial |
| Invoca ≥1 agente compatible vía `runSubagent` | ✅ | frontend-developer + frontend-tdd |
| No requiere que el usuario nombre el agente | ✅ | auto-dispatch |
| No implementa inline antes de delegar | ✅ | 0 ediciones en las primeras 15 tool calls |
| T478 implementada/verificada con evidencia | ✅ | 49/49 tests, fixes aplicados |
| Trazabilidad del result parcial | ✅ | results de 1989c / 891c capturados en `agent_invocations` |

**6/6 criterios cumplidos.**

## Reporte (auto-reporte del orchestrator — son sus CLAIMS)

**Agentes detectados** (catálogo que armó solo, leyendo `.github/agents/`):
- ✅ `frontend-developer` (Capas: fe → implementador primario)
- ✅ `frontend-tdd` (capa test FE → verificador de suite)
- ✅ condicional `refinement` (gate conformidad spec↔código)

**Agentes invocados** (verificado vía runSubagent): `frontend-developer`, `frontend-tdd`.

**Agentes descartados + motivo** (decisión propia, respetó `Capas: fe`):
- `backend-developer` ❌ — fe solamente; T445/T446-BE ya completos
- `devops` ❌ — sin cambios de infra
- `e2e-tester`/`playwright-tester` ❌ — T478 no declara criterio E2E
- `architect` ❌ — sin decisión de arquitectura nueva
- `satellite-developer` ❌ — NestJS satellites fuera de scope FE
- `speckit.*` ❌ — gobernanza, no implementación
- `observability-engineer` ❌ — métricas, no aplica
- `pre-merge-gate` ❌ — gate pre-PR, no corresponde ahora

**Resultado parcial por agente:**
- frontend-developer → `CUMPLE_CON_FIXES`, 6 gaps de §Pantalla 1 corregidos
  (headers "Nombre de la Regla"/"Límite Normativo", celdas Aplica A/Tipo/Período,
  subtítulo).
- frontend-tdd → corrió la suite: **49/49 pasan**, sin regresiones.

**Archivos modificados** (claim: por los agentes): tabla de reglas (headers/celdas),
subtítulo de página, 2 assertions de test por labels legibles.

**Tests/verificaciones:** 49/49 (`tests/features/limits/` + `tests/pages/limits/`),
sin regresiones, `tsc --noEmit` 0 errores en módulo limits (3 errores pre-existentes
en `closure/`, no relacionados).

**Trabajo inline del orchestrator:** claim = "solo lectura/diagnóstico, ningún cambio
de implementación directo".

**Riesgos/deuda:** 3 errores TS pre-existentes en `closure/`; E2E Playwright no
cubierto; `refinement --retroactive` opcional para conformidad formal.

## Caveat de atribución (metodología)

El turno SÍ tiene `multiReplaceString`/`replaceString` en su `response[]`, pero
**TODOS después del primer `runSubagent` (pos 15)** — consistentes con ser trabajo
de los sub-agentes aplanado en el array padre (ver `COPILOT-STORAGE.md §Agent
Attribution Rule`). No es estructuralmente demostrable que sean del sub-agente vs del
orchestrator-roleplay; lo verificable es que **0 ediciones ocurrieron ANTES de
delegar**, y que el orchestrator lo claim como sub-agente. El claim "ningún cambio
directo" NO es verificable por log; el observatorio reporta la delegación (verdad
fuerte) y el orden (0 inline pre-delegación).

## Comparación con runs previos

| Run | Agente top | Delegaciones | Inline pre-deleg | Regresiones |
|---|---|---|---|---|
| T479 (tarea chica) | default | 0 | — | — (no delegó) |
| Forced delegation | default (roleplay) | 4 (3 agentes) | mezclado | **sí (7 exports rotos)** |
| **Auto-dispatch T478** | default (roleplay) | **2 (2 agentes)** | **0** | **no (49/49 verdes)** |

→ El auto-dispatch + fase de descubrimiento previa dio el resultado más limpio:
delegación ordenada, sin inline previo, sin regresiones. Sigue siendo el agente
default haciendo roleplay (no el orchestrator real — ver hallazgo del día), pero el
comportamiento observado fue el deseado.
