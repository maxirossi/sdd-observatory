# Copilot Chat Storage adapter

> Cómo VS Code persiste las sesiones de GitHub Copilot Chat y cómo las
> ingestamos. Reemplaza al adapter basado en `GitHub Copilot Chat.log` porque
> trae mucho más detalle.

---

## Dónde vive la data

VS Code mantiene **una storage por workspace** bajo:

```
~/.config/Code/User/workspaceStorage/<workspace_hash>/
├── workspace.json          ← qué workspace es este storage (folder URI)
├── state.vscdb             ← state general (no usado por nosotros)
└── chatSessions/
    ├── <session_id>.jsonl   ← cada sesión de Copilot Chat
    ├── ...
    └── <session_id>.jsonl
```

En un proyecto activo es **chunky**. Por ejemplo, un target real:

```
171 MB · 37 archivos · sesiones del 5 may al 27 may
```

---

## Atribución al proyecto

`workspace.json` dice exactamente qué carpeta abrió el usuario:

```json
{
  "folder": "file:///path/to/your-project",
  "configuration": null,
  ...
}
```

Match al project: si la URL del folder es **igual o subdirectorio** de algún
`project.path` registrado en DB, los events de esta sesión se atribuyen.
Cero heurísticas — match exacto.

Si `workspace.json["folder"]` cae afuera de cualquier `project.path`, todas
las sesiones de ese workspace se **skipean** (no entran al runtime DB).

---

## Formato del `.jsonl`

Es un **append-only delta log**. Cada línea es un JSON con shape:

```json
{ "kind": <0|1|2>, "k": <path[]>, "v": <value> }
```

| `kind` | Significado | Ejemplo |
|---|---|---|
| `0` | Snapshot inicial — sólo aparece en la primera línea | `{kind:0, v:{version:3, requests:[], inputState:{...}}}` |
| `1` | Replace at path `k` | `{kind:1, k:["inputState","selectedModel"], v:{...}}` |
| `2` | Append/extend at path `k` | `{kind:2, k:["requests"], v:[ {requestId, message, ...} ]}` |

Para reconstruir el estado final hay que **aplicar todas las deltas en orden**.

```python
def apply_delta(state, op):
    k = op.get("kind")
    if k == 0:
        return op["v"]
    path = op.get("k") or []
    v = op.get("v")
    if k == 1:
        # replace at path
        ...
    elif k == 2:
        # append to array at path
        ...
    return state
```

Implementación completa en `backend/app/services/runtime/copilot_storage_adapter.py`.

---

## Shape de un `request` reconstruido

```python
{
    "requestId":     "request_e535a6e5-18c0-40bd-a27b-446bc46eb2ea",
    "timestamp":     1779910277159,                  # epoch ms
    "agent": {
        "id":         "github.copilot.editsAgent",   # ← native agent
        "name":       "agent",
        "isCore":     False,
        "modes":      ["agent"],
        ...
    },
    "modelId":       "copilot/claude-sonnet-4.6",
    "responseId":    "...",
    "elapsedMs":     8457,                           # cap a 1h en el adapter
    "message": {
        "text":       "mostrame los agentes disponibles ...",
        "parts":      [...]
    },
    "response": [
        {"kind": "mcpServersStarting"},
        {"kind": "toolInvocationSerialized", "toolId": "...", "toolCallId": "..."},
        {"value": "Cero errores. Hago el commit ..."},
        {"kind": "thinking", "value": "The user wants to ..."},
        ...
    ],
    "contentReferences": [
        {"kind": "reference", "reference": {
            "$mid": 1,
            "fsPath": "/path/to/your-project/AGENTS.md",
            "external": "file:///path/to/your-project/AGENTS.md",
            "path": "/path/to/your-project/AGENTS.md"
        }},
        ...
    ],
    "codeCitations": [...],
    "completionTokens": ...,
    "result":           {...},
    "followups":        [...]
}
```

---

## Cómo lo persistimos

Por cada `request` reconstruido, generamos **2 runtime_events**:

### Event `user` (el prompt)

```
external_id   = copilot:chat:user:<requestId>
event_type    = "user"
timestamp     = request.timestamp (UTC)
request_size  = bytes del prompt UTF-8
endpoint      = requestId
event_metadata:
  session_id       = session_id del file
  request_id       = requestId
  native_agent_id  = request.agent.id          (ej "github.copilot.editsAgent")
  native_agent_name= request.agent.name
  model            = request.modelId
  elapsed_ms       = request.elapsedMs
  tool_calls       = [toolId, ...]
  files_touched    = paths relativos al project (de contentReferences)
  source_file      = nombre del jsonl
  workspace_storage= hash del workspaceStorage
  inference:
    task_ids       = ["T260", "HU-WRP-C3-02", ...]
    paths          = ["backend/foo.py", ...]
    technologies   = ["NestJS", ...]
    agent_tokens   = ["backend-developer.agent", ...]
```

### Event `assistant` (la respuesta)

Igual shape pero con:
- `event_type = "assistant"`
- `timestamp = request.timestamp + elapsed_ms` (cap 1h)
- `latency_ms = elapsed_ms` (cap 1h por overflow de INTEGER)
- `response_size = bytes del response UTF-8`
- `external_id = copilot:chat:assistant:<requestId>`

### `llm_interactions`

Una row por assistant event:

```
runtime_event_id   = assistant event id
provider           = "copilot"
model              = request.modelId
prompt_chars       = len(prompt_text)
response_chars     = len(response_text)
sanitized_prompt   = sanitize(prompt) si privacy_mode != metadata_only
sanitized_response = sanitize(response) si privacy_mode != metadata_only
```

### `agent_mentions`

Por cada `Agent` declarado en el repo cuyo nombre matchee `\b{name}\b` en el
texto del prompt o response:

```
agent_id     = id del Agent del repo
file_path    = copilot://session/<sid>#<requestId>:user        (o :assistant)
source_type  = "runtime_copilot_user" | "runtime_copilot_assistant"
snippet      = ±80 chars alrededor del match
```

Adicionalmente, si el `native_agent_id` de Copilot matchea por nombre con un
agent del repo (caso raro), se crea una mention con
`source_type = "runtime_copilot_native"`.

---

## Idempotencia

External ID stable por `(provider, external_id)` con índice parcial único:

```sql
CREATE UNIQUE INDEX ix_runtime_events_external_id_unique
ON runtime_events (provider, external_id)
WHERE external_id IS NOT NULL;
```

ON CONFLICT DO NOTHING en el INSERT. Re-correr el adapter sobre los mismos
archivos = 0 events nuevos.

Las `agent_mentions` se crean **solo cuando el event_insert devuelve id
nuevo**. Si re-corrés, las viejas siguen porque cada turn tiene su propio
`requestId` en el `file_path` de la mention. No hay duplicados.

---

## Diferencias vs adapter `.log` (deprecado)

| Aspecto | adapter `.log` | adapter storage (actual) |
|---|---|---|
| Fuente | `~/.config/Code/logs/<ts>/window*/exthost/GitHub.copilot-chat/GitHub Copilot Chat.log` | `~/.config/Code/User/workspaceStorage/<hash>/chatSessions/*.jsonl` |
| Datos | `ccreq:<id> | success | model | latency | endpoint` | Prompt + response + agent + tool calls + content refs |
| Atribución | Heurística LCP sobre `file://` referenciados en `renderer.log` | `workspace.json["folder"]` exacto |
| Agent del repo | ❌ (sin prompt text) | ✅ regex sobre prompt + response |
| Sesiones replay | ❌ (sin session_id en el log) | ✅ session_id en cada turn |
| Tool calls | ❌ | ✅ `toolId` de cada `toolInvocationSerialized` |
| Modelo resuelto | ✅ (alias → resolved) | ✅ (`copilot/claude-sonnet-4.6`, `copilot/gpt-4.1`, `copilot/auto`, `copilot/claude-opus-4.5`) |
| Privacy | metadata-only natural (no había prompt) | metadata-only por default; prompt sanitizado opcional |

El adapter `.log` (`backend/app/services/runtime/copilot_adapter.py`) sigue
en el código pero **no en el registry**. Si más adelante queremos combinar
ambas fuentes (`.log` aporta `latency_ms` y `status_code` reales; storage
aporta contenido), se puede armar un adapter compuesto.

---

## Bind mount + config

`docker-compose.yml`:

```yaml
backend:
  environment:
    COPILOT_STORAGE_PATH: ${COPILOT_STORAGE_PATH:-/workspaces/vscode-storage}
  volumes:
    - ${VSCODE_STORAGE_PATH:-./}:/workspaces/vscode-storage:ro
```

`.env` (host):

```bash
VSCODE_STORAGE_PATH=${HOME}/.config/Code/User/workspaceStorage
COPILOT_STORAGE_PATH=/workspaces/vscode-storage
```

Settings (`backend/app/config.py`):

```python
copilot_storage_path: str | None = None
copilot_logs_path: str | None = None
```

El collector prioriza `copilot_storage_path` si está set; si no, cae al
`copilot_logs_path` (adapter viejo).

---

## Caveats conocidos

- **`elapsedMs` puede venir absurdamente grande** cuando VS Code estuvo
  cerrado entre prompts (acumula tiempo de wall-clock). Cap a 1 hora en el
  adapter para evitar overflow del INTEGER de `latency_ms` y timestamps
  futuros. Si elapsedMs > 1h → se persiste `latency_ms = None`.
- **Streaming SSE**: las respuestas chunked se almacenan en `response` como
  varios items. El adapter concatena los items con `value` string. Para
  respuestas vacías (kind=`mcpServersStarting` u otros markers), el
  `response_text` queda en `""`.
- **Sessions multi-folder**: si el user abre un workspace con varias folders
  (`workspace.json["configuration"]` apunta a un `.code-workspace` file en
  vez de `folder`), hoy se skipea — implementar lookup de `.code-workspace`
  + match a project por cualquiera de sus folders cuando haga falta.
- **Privacy**: el adapter **respeta `settings.privacy_mode`** para los
  `sanitized_prompt`/`sanitized_response` en `llm_interactions`. En
  `metadata_only` (default), solo se persisten counts de chars; el texto
  crudo nunca entra a la DB. En `sanitized_payload` se persiste pasando por
  el sanitizer (redacta API keys, JWTs, etc).

---

## Replay endpoint

`GET /api/sessions/:session_id` funciona idéntico para Claude y Copilot.
La clave de correlación entre `runtime_events` y `agent_mentions` se hace
por `event_metadata.request_id` (Copilot) o `external_id` (Claude).

Schema en `agent_mentions.file_path`:

```
claude://session/<sid>#<event_uuid>
copilot://session/<sid>#<requestId>:user
copilot://session/<sid>#<requestId>:assistant
copilot://session/<sid>#<requestId>:native
```

El endpoint extrae el `requestId` base (split por `:`) para correlar con
`runtime_events.event_metadata.request_id`.

---

## Agent Attribution Rule

Copilot **flattens subagent tool calls into the parent orchestrator response
array**: after a `runSubagent[agent]` entry, the file reads/edits/terminal calls
that the delegated agent (and the orchestrator's own interleaved inline work)
perform all appear as subsequent items of the SAME parent `response[]` — there is
no nested ownership. The orchestrator routinely does inline work between
delegations (it narrates *"el agente retornó parcialmente, verifico y ejecuto los
tests"*), so post-`runSubagent` activity is a mix of subagent + orchestrator.

Therefore:

- **Strong attribution (structural evidence)** = `runSubagent[agent]` + `prompt`
  + sanitized partial `result`. This is what `agent_invocations` stores and what
  the UI must present as "agents that intervened".
- **File/tool attribution per agent is NOT guaranteed** by the log format.
- **Positional attribution** (tool calls between `runSubagent[A]` and
  `runSubagent[B]` → agent A) may be shown ONLY as a heuristic, clearly labeled.
- **Do not present file modifications as definitively performed by a specific
  agent** unless a future log format contains explicit nested ownership metadata.

Consecuencias en el modelo:

- `agent_mentions` → solo texto mencionado (señal débil, falsos positivos).
- `agent_invocations` → ejecución real (runSubagent): agent + prompt + result
  parcial sanitizado. **Verdad fuerte por agente.**
- Un `runSubagent` puede venir `isComplete=True` con `result` vacío/parcial — el
  agente "retornó parcialmente". Distinguir **invocado** vs **completado con
  output** (`result_chars > 0`).
- "Archivos posiblemente tocados por agente": si se muestra, etiquetar como
  **heurística por posición**, nunca como evidencia fuerte.

> Capturar el `result` parcial requiere `PRIVACY_MODE=sanitized_payload` (local).
> En `metadata_only` solo queda `result_chars`.

### Diferencia con Claude Code

En Copilot el `agentName` del `runSubagent` ya trae el **nombre declarado** del
agente. **Claude Code es distinto:** su tool `Agent` delega SIEMPRE a un built-in
(`subagent_type="general-purpose"`) y el **rol va en `input.description`**
("Architect: …", "Backend: …"). Se resuelve el agente declarado desde ese campo
estructurado (`_resolve_from_description`, conservador: solo si el match es único).
Detalle completo + tabla comparativa en
[`experiments/2026-06-01-findings-attribution-parte-c.md`](experiments/2026-06-01-findings-attribution-parte-c.md).
