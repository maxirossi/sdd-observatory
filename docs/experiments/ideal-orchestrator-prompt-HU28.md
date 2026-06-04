# Prompt ideal de orquestación — HU-28-FE (Copilot)

> Derivado del experimento del 2026-05-28 (ver `2026-05-28-real-agent-attribution.md`)
> + investigación del contrato real del `orchestrator.agent.md` y el workflow del
> framework en el target real. Diseñado para forzar el workflow COMPLETO con
> delegación real, anclado a mecanismos reales del framework (no reglas ad-hoc).

## ⚠️ HALLAZGO CRÍTICO — el orchestrator NUNCA corrió (verificado en runtime)

El workflow de investigación asumió que el orchestrator es read-only
(`tools: [codebase, search, agent]` en `orchestrator.agent.md`). **Pero la
verificación en runtime del `.jsonl` muestra que ese agente NUNCA se activó.**

Evidencia (sesión `<session-id>`, los 3 turnos):
- `agent.id = github.copilot.editsAgent`, `agent.name = "agent"` en **los 3 turnos**
  → corrió el **modo "Agent" default de Copilot**, NO el custom `orchestrator`.
- promptFiles adjuntos: solo `default.instructions.md`, `copilot-instructions.md`,
  `AGENTS.md`, `CLAUDE.md`. **`orchestrator.agent.md` NUNCA fue adjuntado** (si el
  modo orchestrator estuviera activo, sería su system prompt).
- Turno 0 (T479): default agent → **5 ediciones, 0 runSubagent** (edita inline).
- Turno 2: default agent → **53 ediciones + 6 runSubagent** (edita Y delega).

→ **`"Act as the repository orchestrator"` fue roleplay por TEXTO** sobre el agente
default. El frontmatter read-only del orchestrator nunca aplicó. Por eso:
- Editó inline e ignoró "MUST NOT edit": el agente default TIENE herramientas de
  edición y no está atado al contrato del orchestrator.
- La conclusión previa **#5 (el orchestrator edita inline) se confirma**, pero la
  causa real es que **el orchestrator no se ejecutó** — corrió el default.

### RESUELTO (desde los archivos) — escenario 2: los agentes son ROLEPLAY, no modos

Confirmado sin necesidad de VS Code:
- **No existe `.github/chatmodes/`** (la convención de modos ejecutables de VS Code).
- `.github/copilot-instructions.md:37,45` define el mecanismo textualmente:
  > *"Cuando el usuario pida actuar como un agente, adopta su rol y restricciones
  > leyendo `.github/agents/{nombre}.agent.md`… cambia tu personalidad inmediatamente
  > adoptando el rol y restricciones."*

→ Los `.github/agents/*.agent.md` son **personas de roleplay**, NO modos
seleccionables ni sandboxes. El agente **default de Copilot** (`github.copilot.editsAgent`,
tools completas incl. `editFiles`/`runInTerminal`/`agent`) es el único ejecutor.
"Act as orchestrator" le pide que LEA el `.agent.md` y adopte el rol — pero como
tiene tools de edición, **el `tools: [codebase,search,agent]` read-only del
orchestrator es DOCUMENTACIÓN DE INTENCIÓN, no un límite aplicado**. Por eso editó
inline e ignoró "MUST NOT edit".

**Matiz importante:** los **sub-agentes invocados vía `runSubagent`** (tool `agent`)
SÍ se cargan con su `.agent.md` (`agentName` → archivo del agente). Por eso las
delegaciones produjeron trabajo especializado real. La jerarquía efectiva es:
- **Top-level "orchestrator"** = roleplay no confiable sobre el default agent.
- **Sub-agentes** (runSubagent) = sí ejecutan con su `.agent.md` cargado.

### Consecuencia para el prompt

El prompt de abajo está pensado para el **agente default haciendo de orchestrator**
(la realidad). Cambios clave vs un orchestrator "real":
- **No se puede garantizar read-only.** Las prohibiciones de edición son persuasión;
  el agente puede ignorarlas. La única defensa dura es **detección post-hoc** (contar
  ediciones del top-level en el `.jsonl`) + el contrato de interfaz (find-references).
- **Reforzar la adopción de rol**: instruir explícitamente "leé
  `.github/agents/orchestrator.agent.md` y adoptá su contrato ANTES de actuar"
  (mecanismo de copilot-instructions) — mejora, no garantiza.
- **La palanca real de delegación es el tool `agent`/`runSubagent`**, que el default
  agent SÍ tiene y usa. El prompt debe empujar a delegar temprano y prohibir editar
  él mismo lo que corresponde a un sub-agente.

> Ver §"Adaptación para el agente default" al final.

## Otros hallazgos de la investigación

- **HU-28-FE ya está cerrada (`[x]`, T478–T481).** El prompt por defecto entra en
  **modo VERIFICACIÓN/NO-REGRESIÓN**, no reimplementa. Para probar orquestación de
  *implementación* hay que correrlo contra una HU con tasks `[ ]` abiertas.
- **`pre-merge-gate` NO es gate default del orchestrator** — existe como agente pero
  solo se invoca por override explícito o vía `test-orchestrator --full-suite`. Por eso
  el orchestrator "corta en el resumen" (modo de falla #6): no es que falle, es que el
  gate final no está en su flujo default. El prompt fuerza un **GATE DE NO-REGRESIÓN
  delegado** (build/typecheck/tests/find-references) como criterio de terminación.
- **`test-orchestrator` NO es enrutable** por el orchestrator (no está en sus handoffs).
  Tests FE: `frontend-developer` → `frontend-tdd` (unit) / `e2e-tester` (E2E).

---

## Setup previo

- **S1 — Sesión NUEVA** de Copilot Chat exclusiva para HU-28-FE (no reusar la de T479).
  El `.jsonl` es append-only: el contexto viejo contamina. Es la **única garantía real**
  de no-carryover; el texto "ignorá lo anterior" NO limpia la ventana.
- **S2 — Confirmar** que el agente es `orchestrator` (read-only, `tools:[codebase,search,agent]`).
- **S3 — Modelo** Claude Sonnet 4 (el declarado del agente).
- **S4 — Anclar** el turno a `HU-28-FE / cycle-4`.

---

## EL PROMPT (literal, listo para pegar al orchestrator)

```
Ignorá todo trabajo anterior. (Esta línea NO limpia contexto; la garantía es la
sesión nueva del operador. Es un recordatorio, no un mecanismo.)

# TAREA
HU-28-FE "Límites" del cycle-4. Es FRONTEND-ONLY (no hay tasks BE; el módulo es
HU-28-FE: T478..T481). Tu objetivo por defecto es VERIFICACIÓN / NO-REGRESIÓN,
no reimplementación (ver GATE DE ARRANQUE §1). Sos el orchestrator: coordinás, no implementás.

# TU ROL (duro)
NO editás archivos, NO corrés tests, NO ejecutás comandos. Tu único mecanismo de
mutación es delegar vía handoff (tool `agent`, send:true). Lecturas (search/codebase)
están PERMITIDAS e ilimitadas: tu modo de falla NO es leer de más, es ANALIZAR EN LOOP
SIN DELEGAR. Métrica de "inline" = mutaciones (cero); las lecturas no cuentan.

# GATE DE ARRANQUE (antes de todo)
0. RESOLUCIÓN DE MECANISMOS. Para CADA archivo/agente que vayas a invocar, resolvé la
   ruta real y citá el § literal. Si no lo resolvés → FALLÁ y reportá. Resolvé al menos:
   functional/.specify/CYCLE_WORKFLOW.md, .github/skills/skill-router.md,
   .github/agents/speckit.implement.agent.md, .github/agents/orchestrator.agent.md,
   tools/governance/task-profile-tags.yml, functional/Cycles/cycle-4/tasks.md, pull_request_template.
1. ESTADO DE TASKS. Leé functional/Cycles/cycle-4/tasks.md §HU-28-FE (T478..T481).
   - Si están [x] → MODO VERIFICACIÓN/NO-REGRESIÓN. NO redelegues implementación cerrada.
     Saltá al GATE DE NO-REGRESIÓN y reportame el estado, PIDIENDO OK antes de cualquier
     acción que no sea lectura.
   - Si hay [ ] abiertas → MODO IMPLEMENTACIÓN solo de esas.
   - Nunca completes retroactivamente tasks ya [x] (CYCLE_WORKFLOW.md — citá §).
2. RESOLUCIÓN DE CICLO. Confirmá cycle-4 activo; verificá spec.md/plan.md/tasks.md.
   NUNCA delegues sin ciclo resuelto.

# PRE-FLIGHT (solo MODO IMPLEMENTACIÓN — citá speckit.implement.agent.md / skill-router)
Para CADA task abierta: parseá Capas/Tipo/Riesgo/Tests/ADRs. Consultá skill-router.md y
copiá identificadores EXACTOS. Para HU-28-FE:
  frontend-component → frontend-architecture, frontend-patterns
  frontend-hook      → frontend-architecture, frontend-data-access-patterns
  (NO api-contract-gate / inter-service-smoke: son backend/cross-service, no aplican.)
Tests: `npm run test --filter={paquete}`, umbral ≥70% líneas. Skill inexistente → FALLÁ.

# MANIFIESTO DE DELEGACIÓN (solo IMPLEMENTACIÓN; emitilo y pedí OK)
Plan atómico antes de invocar:
  - Tasks abiertas + agente (frontend-developer; unit tests vía frontend-developer→frontend-tdd;
    E2E → e2e-tester). NO test-orchestrator (no enrutable).
  - OWNERSHIP POR ARCHIVO (no por módulo). Tasks que tocan el MISMO archivo → SERIALIZAR
    al mismo agente. "Límites" es cohesivo: no exijas disjunción de módulo.
  - Con search/grep, generá el inventario de EXPORTS PÚBLICOS del módulo y sus importadores
    externos. Congelalo como snapshot git (para diffear en POST).
  - Aceptación por task: build/typecheck/tests verdes + exports del snapshot resueltos.

FASES:
  FASE A — FAN-OUT: emití TODAS las delegaciones del batch SIN lectura/verificación intermedia.
  FASE B — VERIFICACIÓN: recién tras el último handoff, verificá read-only (sección POST).
  Tasks serializadas: re-snapshot del contrato al inicio de cada una.

# CONTRATO DE PROMPT HACIA CADA SUB-AGENTE (construido, no genérico)
Incluí textualmente: task, Capas, Skills (identificador exacto), ADRs, comando de tests +
umbral, "plan en task-impl-plans/TXXX-plan.md antes de tocar código", Mini-ciclo
(speckit.implement.agent.md §, citado).
  --- CONTRATO DE INTERFAZ ---
  Estos exports son API PÚBLICA consumida fuera de tu scope: {lista del snapshot, p.ej.
  useLimitRuleMerchants, useToggleLimitRuleStatus, SCOPE_LABELS, PERIOD_LABELS,
  TRANSACTION_TYPE_LABELS}. Regla: ADITIVO. NO borres exports en uso. Si una task REQUIERE
  cambiar una firma: permitido, pero migrá TODOS los importadores en ESTE handoff; si el
  importador está fuera de tu scope → NO cambies la firma, reportá para serializar.
  PROHIBIDO reescribir archivos enteros: editá quirúrgicamente.
  --- RESULT ESPERADO ---
  (1) archivos tocados + diff por archivo; (2) exports preservados/agregados/migrados;
  (3) comandos de verificación; (4) qué quedó fuera de scope.
  (No te creo exit codes por tu palabra: el verde lo confirma la verificación posterior.)

# VERIFICACIÓN POST-DELEGACIÓN (FASE B — contrato de completitud)
Tras el último handoff:
  1. LEÉ los archivos objetivo y diffeá contra el snapshot. Done = diff real en disco, NO
     el auto-reporte. Sin diff → NO informes éxito, NO lo apliques vos.
  2. Sin aplicar → RE-DELEGÁ al MISMO agente (intento 2) con rutas absolutas + cita literal.
  3. Sigue fallando → intento 3: agente ALTERNATIVO (frontend-developer/frontend-tdd).
  4. Agotados 2 y 3 → escaláme con detalle. NUNCA cierres con "hacelo vos".

# GATE DE NO-REGRESIÓN (el principal si todo está [x]; delegás la EJECUCIÓN, no la corrés)
  - build + typecheck verdes (frontend-developer).
  - "find references" sobre CADA export del snapshot → todos resueltos.
  - tests del módulo verdes: `npm run test --filter={paquete}` (frontend-developer→frontend-tdd).
Export público desaparecido o firma cambiada sin migrar → REGRESIÓN: re-delegá a restaurar/
migrar antes de avanzar. "Completado" = compilación verde del consumidor, no auto-reporte.

# GATES DE CIERRE
  - pre-merge-gate NO es default del orchestrator: invocalo solo si te lo pido como override,
    y decímelo. NO avances al PR con FALLO_VALIDACIÓN sin resolver.

# CIERRE / PR
  - PR body evaluando CADA checkbox del pull_request_template contra el código real.
    No verificable → "[ ] No verificado — ejecutar manualmente". Checkbox ⚠️ BLOQUEA merge.

# EVIDENCIA QUE DEBÉS DEVOLVERME (Reporte de Orquestación, por sub-agente)
  task(s), agente, skills inyectados (id exacto), ADRs; "entregado" (diff verificado) vs
  "re-delegado" (motivo); archivos tocados; exports preservados/agregados/migrados; comandos
  de verificación + resultado del runner; chatSessionId de esta corrida; overrides usados.

# PROHIBIDO
  Delegar sin ciclo/mecanismos resueltos · reimplementar tasks [x] · nombrar agentes/tasks BE
  · delegar a test-orchestrator · saltar pre-flight · verificar/leer-para-reparar ENTRE handoffs
  del batch (es FASE B) · ownership disjunto a nivel módulo · reescribir módulos enteros ·
  borrar exports en uso / cambiar firmas sin migrar · reintentar >1 vez al mismo agente o
  cerrar con "hacelo vos" sin agotar 2 y 3 · inventar skills/cobertura/gates/cumplimiento.

Empezá por GATE DE ARRANQUE §0 y §1. Decime en qué MODO caés y mostrame la resolución de
ciclo. PEDIME OK antes de cualquier delegación.
```

---

## Riesgos residuales (honestos)

1. **HU-28-FE está cerrada** → el prompt entra en modo verificación; no hay
   implementación que orquestar. Para probar orquestación de implementación, correrlo
   contra una HU con tasks `[ ]` abiertas.
2. **Loop sin handoff (el verdadero T479).** El prompt prohíbe textualmente analizar sin
   delegar, pero la instrucción declarativa puede no bastar (evidencia: forzado, igual
   patrones de no-delegación). No hay garantía dura; solo detección post-hoc (contar
   handoffs en el `.jsonl`).
3. **Inline del sub-agente.** El orchestrator no muta, pero el sub-agente sí. El contrato
   de interfaz + find-references lo *detecta* después, no lo *previene*.
4. **Ownership por archivo = tan bueno como el inventario de exports.** Barrels (`index.ts`),
   re-exports o imports dinámicos pueden ocultar consumidores.
5. **`result` estructurado se asume.** Si la tool `agent` devuelve solo texto en chat, "verificar
   el result" colapsa en "leer el chat"; la verificación en disco (diff vs snapshot) lo mitiga.
6. **Carryover textual = no-op.** Solo S1 (sesión nueva) lo garantiza.
7. **Read-only no aplicable** (resuelto): corre el agente default; el read-only del
   orchestrator es intención documentada, no límite. Detección post-hoc + contrato de
   interfaz es la única defensa.

---

## Adaptación para el agente default (la realidad — usar ESTA versión)

Dado que los agentes son roleplay sobre el default agent (no modos), anteponé al
PROMPT estas dos líneas y aceptá que read-only es best-effort:

```
# ADOPCIÓN DE ROL (mecanismo de copilot-instructions.md §45)
Antes de actuar: LEÉ .github/agents/orchestrator.agent.md COMPLETO y adoptá su
contrato (delegación, pre-flight, prohibiciones). Si una acción que ibas a hacer
vos la prohíbe el orchestrator → delegala. (Sé que tenés tools de edición; el rol
orchestrator te pide NO usarlas: usá `agent`/runSubagent en su lugar.)

# REGLA DURA OPERATIVA (porque el read-only no está sandboxeado)
Toda mutación de archivo que NO sea trivial-de-coordinación va por handoff. Si
editás vos un archivo de feature, lo considero violación del rol y abortá+reportá.
La detección es post-hoc (el observatorio cuenta tus ediciones top-level), así que
no hay red de seguridad: cumplí el contrato vos.
```

Luego seguí con el bloque "# TAREA … " de §2 tal cual.

**Qué NO cambia:** el resto del prompt (gate de arranque, pre-flight, manifiesto,
contrato de interfaz, verificación post, gate de no-regresión) sigue válido —
opera igual sobre el default agent haciendo de orchestrator.

**Qué esperar realista (según evidencia):** el default agent va a (a) leer el rol,
(b) delegar de verdad vía runSubagent a los sub-agentes (que SÍ cargan su .agent.md),
pero (c) probablemente igual edite algo inline y mezcle. El valor del observatorio
acá es **medir** cuánto delegó vs cuánto hizo inline — no garantizar que delegue todo.

---

## Para revisar mañana — resumen ejecutivo

1. **Hallazgo central:** todo corrió sobre el agente **default** de Copilot, no sobre
   el orchestrator. Los `.agent.md` son roleplay (no modos; no hay `.github/chatmodes/`).
   El read-only del orchestrator es inaplicable.
2. **La atribución por `runSubagent` sigue siendo válida y correcta** — las
   delegaciones son reales independientemente del agente padre.
3. **Prompt ideal**: la versión de §2 + la "Adaptación para el agente default" de
   arriba. Forzar lectura del rol + delegación temprana; read-only es best-effort +
   detección post-hoc.
4. **Para probar orquestación de IMPLEMENTACIÓN** (no verificación): correrlo contra
   una HU con tasks `[ ]` abiertas (HU-28-FE está cerrada). Candidatas: bloque AML
   backend (T429–T436, abiertas) — pero son BE, no FE.
5. **Decisión abierta:** ¿`PRIVACY_MODE=sanitized_payload` como default del proyecto
   (`.env.example`/compose) o queda local? Hoy está solo en `.env` local.
6. **UI pendiente implementada hoy:** distinción invocado-vs-completado-con-output
   (`result_chars`) — ver doc de estado.
