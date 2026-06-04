# Runtime Capture

## Pipeline

```
[Filesystem logs / POST manual]
              │
              ▼
       ProviderAdapter
       (discover + parse)
              │
              ▼
        Sanitizer
   (redacta secrets)
              │
              ▼
        Inference
  (task_ids, paths, agents)
              │
              ▼
      ON CONFLICT DO NOTHING
   (provider, external_id)
              │
              ▼
        PostgreSQL
        runtime_events
```

---

## ProviderAdapter (interfaz)

`backend/app/services/runtime/base.py`

```python
class ProviderAdapter(ABC):
    name: str
    source_kind: str = "local_logs"

    @abstractmethod
    def discover(self, root: Path) -> Iterable[Path]: ...

    @abstractmethod
    def ingest_path(self, root: Path, session: Session) -> IngestStats: ...
```

Cada adapter implementa estos dos métodos.

---

## Adapters disponibles

### Claude (`services/runtime/claude_adapter.py`)

- **Discover:** `**/*.jsonl` bajo `~/.claude/projects/`
- **Parse:** cada línea jsonl tiene `uuid`, `type`, `timestamp`, `message`, `sessionId`, `cwd`, `model`, `usage`
- **External ID:** `uuid` del evento
- **Project attribution:** mapea `cwd` → project con `_project_for_cwd`
- **Mentions runtime:** extrae texto del `message`, matchea contra patterns compilados por agent_name, persiste `agent_mentions` con `source_type='runtime_claude_user'/'runtime_claude_assistant'` y `file_path='claude://session/<sid>#<eid>'`
- **Enrichment:** `event_metadata.inference` con task_ids, paths, agents detectados

### Copilot (`services/runtime/copilot_storage_adapter.py`) — **adapter actual**

- **Discover:** `**/chatSessions/*.jsonl` bajo `~/.config/Code/User/workspaceStorage/<hash>/`
- **Parse:** reconstruye un append-only delta log (`kind=0/1/2`) y itera `state.requests[]`
- **External ID:** `copilot:chat:user:<requestId>` y `copilot:chat:assistant:<requestId>` (2 events por turn)
- **Project attribution:** `workspace.json["folder"]` exacto — sin heurísticas
- **Datos:** prompt + response completos, agent nativo de Copilot, tool calls, contentReferences, modelId resuelto
- **Privacy:** prompt/response solo se persisten sanitizados si `privacy_mode != metadata_only`
- **Mentions runtime:** regex sobre prompt y response matchea agents declarados → `agent_mentions` con `file_path = copilot://session/<sid>#<requestId>:user|assistant`

Detalle completo del formato: ver [`COPILOT-STORAGE.md`](./COPILOT-STORAGE.md).

### Copilot — adapter legacy `.log` (deprecado, en el código pero no en el registry)

`services/runtime/copilot_adapter.py` lee el `GitHub Copilot Chat.log` con
regex `ccreq:<id> | success | model | <latency>ms | [endpoint]`. Solo
metadata HTTP-style; no expone prompts ni agents. Se conserva en el código
por si más adelante queremos combinarlo con el storage adapter (aporta
status_code real y latency de red exacta).

---

## Registro

`backend/app/services/runtime/registry.py`

```python
_REGISTRY: dict[str, ProviderAdapter] = {
    "claude": ClaudeAdapter(),
    "copilot": CopilotChatStorageAdapter(),   # storage > .log
}
```

Agregar un provider nuevo:

1. Crear `services/runtime/<provider>_adapter.py` que extienda `ProviderAdapter`
2. Agregarlo al `_REGISTRY`
3. Agregarlo a `SUPPORTED_PROVIDERS` en `api/providers.py`
4. Agregar el path resolver en `services/runtime/collector.py` (`_PROVIDER_PATH_RESOLVERS`)

---

## Sanitizer

`backend/app/services/sanitizer.py`

Patrones redactados antes de persistir:

- JWT (`eyJ...`)
- Bearer tokens (`Authorization: Bearer ...`)
- AWS access keys (`AKIA[0-9A-Z]{16}`)
- Google API keys (`AIza[0-9A-Za-z_-]{35}`)
- OpenAI keys (`sk-...`)
- Anthropic keys (`sk-ant-...`)
- GitHub PAT classic (`ghp_...`) + fine-grained (`github_pat_...`)
- Slack tokens (`xox[abprs]-...`)
- `"api_key"/"secret"/"token"/"password": "..."` en JSON
- `KEY=value` para env-style (API_KEY, SECRET, TOKEN, PASSWORD, JWT, BEARER, ACCESS_TOKEN, REFRESH_TOKEN)
- PEM private keys
- Cookies (`Set-Cookie:` / `Cookie:`)
- Connection strings con password embebido (`postgres://user:PASS@host`)

Aplicado en el ingest path antes de meter cualquier string en JSONB.

---

## Inference

`backend/app/services/runtime/inference.py`

Sobre el texto del mensaje (solo Claude por ahora; Copilot logs no traen el prompt completo), extrae best-effort:

- `task_ids` — regex `\b((?:T|HU)[A-Z0-9-]*\d+[a-z]?)\b` → `T260`, `T-SEC-001`, `HU-WRP-C3-02`
- `cycle_ids` — `cycle-\d+(-\w+)?`
- `paths` — extensiones conocidas (`.py`, `.ts`, `.tsx`, `.java`, etc.)
- `technologies` — keywords (NestJS, FastAPI, Spring Boot, ...)
- `agent_tokens` — `*.agent` patterns

Output va a `event_metadata.inference` del runtime_event.

---

## Watch loop

`backend/app/main.py:_ingest_watch_loop`

- Corre cada `INGEST_WATCH_INTERVAL_SECONDS` (default 60s)
- Delega a `services.runtime.collector.run_once()`
- El collector lee `provider_configs.enabled=true`, resuelve el path por provider, corre el adapter
- Logea `runtime tick <provider>: files=N new=M skipped=K` cada tick
- Idempotente: ON CONFLICT DO NOTHING sobre (provider, external_id), así no duplica si re-corre

Trigger manual: `POST /api/runtime/collector/run?provider=claude` o desde la UI (botón **Trigger** en `/runtime`).

---

## Idempotencia

Migration `0003` agrega:

```sql
CREATE UNIQUE INDEX ix_runtime_events_external_id_unique
ON runtime_events (provider, external_id)
WHERE external_id IS NOT NULL;
```

Cada adapter genera `external_id` estable. El insert usa `pg_insert().on_conflict_do_nothing()`. Si la misma sesión Claude se re-procesa, no entran duplicados.

---

## Privacy modes

`settings.privacy_mode`:

| Modo | capture_metadata | capture_payload | capture_response | Notas |
|---|---|---|---|---|
| `metadata_only` (default) | sí | **no** | **no** | Solo size/latency/status. Prompts y respuestas nunca se persisten. |
| `sanitized_payload` | sí | opcional por provider | opcional por provider | Si el provider lo activa, persiste payloads sanitizados con `sanitize()` |
| `raw_local_only` | sí | opcional | opcional | Persiste crudo sin sanitizar. **No usar fuera de debug local.** |

El default es `metadata_only`. Cambiar via env `PRIVACY_MODE`.

---

## Storage

### runtime_events

Columna principal. Cada evento es un row. Volumen esperado: 1-10 events/min en Copilot Chat activo, 0.5-2 events/segundo en Claude Code activo.

`event_metadata` JSONB acepta cualquier shape — específico al provider, no normalizado.

### llm_interactions

Para eventos `assistant` con `model` o `usage` conocido, se persiste un row aquí con `prompt_chars` y `response_chars` (counts, no contenido). `sanitized_prompt`/`sanitized_response` quedan en NULL salvo que el provider tenga `capture_payload=true` Y el privacy mode lo permita.

### agent_mentions

Para mentions runtime de Claude (donde podemos detectar agent names en el texto del prompt). Path tiene formato `claude://session/<sid>#<eid>` que permite correlar back al evento. Mentions del scanner (source_type `docs`/`spec`/`tasks`) usan el path del archivo donde se mencionó.

---

## Backfill / re-ingest

Si necesitás reprocessar todo:

```bash
# 1. Wipe runtime
docker compose exec postgres psql -U ssdoffice -d ssdoffice -c "
DELETE FROM llm_interactions;
DELETE FROM agent_mentions WHERE source_type LIKE 'runtime_%';
DELETE FROM runtime_events;
"

# 2. Trigger ingest manual
curl -X POST http://localhost:8000/api/runtime/collector/run

# El watch loop también va a hacer pull en el próximo tick (60s)
```

El re-ingest es safe: idempotencia por external_id evita duplicados.
