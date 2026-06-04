# Configuración

Toda la config vive en `.env` (host) + `provider_configs` table (runtime).

---

## Env vars (`.env`)

Copiar `.env.example` y editar. El stack lee este archivo automáticamente vía docker compose.

### Database

| Var | Default | Notas |
|---|---|---|
| `POSTGRES_DB` | `ssdoffice` | |
| `POSTGRES_USER` | `ssdoffice` | |
| `POSTGRES_PASSWORD` | `ssdoffice` | cambiar en uso compartido |
| `POSTGRES_PORT` | `5433` | puerto **host**, evita conflicto con postgres local |
| `DATABASE_URL` | `postgresql+psycopg://ssdoffice:ssdoffice@postgres:5432/ssdoffice` | URL desde el container backend |

### Backend

| Var | Default | Notas |
|---|---|---|
| `APP_ENV` | `development` | |
| `LOG_LEVEL` | `INFO` | |
| `BACKEND_PORT` | `8000` | puerto host |
| `PRIVACY_MODE` | `metadata_only` | `metadata_only` / `sanitized_payload` / `raw_local_only` |
| `LOG_TIMEZONE` | `America/Argentina/Buenos_Aires` | TZ para parsear timestamps de logs sin TZ (VS Code Copilot) |

### Frontend

| Var | Default | Notas |
|---|---|---|
| `FRONTEND_PORT` | `5180` | |
| `VITE_API_URL` | `http://localhost:8000` | base URL del API desde el browser |

### Scanner

| Var | Default | Notas |
|---|---|---|
| `SCAN_TARGET_PATH` | `./` | path **host** del repo target a scannear. Se monta en `/workspaces/target` |
| `SCAN_TARGET_HOST_PATH` | `${SCAN_TARGET_PATH}` | path persistido en `project.path`. Tiene que matchear el `cwd` que escribe Claude en sus logs |

### Runtime ingest

| Var | Default | Notas |
|---|---|---|
| `INGEST_WATCH_ENABLED` | `true` | si `false`, el watch loop no corre |
| `INGEST_WATCH_INTERVAL_SECONDS` | `60` | frecuencia del polling |
| `INGEST_WATCH_PATH` | `/workspaces/claude-logs` | path **container** de los Claude logs |
| `COPILOT_LOGS_PATH` | (vacío) | path **container** de los VS Code logs. Settear a `/workspaces/vscode-logs` para activar |
| `CLAUDE_LOGS_PATH` | `./` | path **host** de Claude logs. Default `~/.claude/projects` |
| `VSCODE_LOGS_PATH` | `./` | path **host** de VS Code logs. Default `~/.config/Code/logs` |

---

## Provider configs (DB)

Tabla `provider_configs`. Editable con SQL directo:

```sql
SELECT provider, enabled, capture_metadata, capture_payload, capture_response
FROM provider_configs ORDER BY provider;
```

| Provider | Default v0.2 | Source kind |
|---|---|---|
| `claude` | enabled | `local_logs` |
| `copilot` | enabled | `local_logs` |

### Flags por provider

- `enabled` — controla si el watch loop corre el adapter de ese provider
- `capture_metadata` — siempre `true` por default. Bajo `metadata_only` privacy mode, este flag es necesario para que se persistan los eventos.
- `capture_payload` — si `true`, intenta persistir el prompt enviado (sanitizado). Default `false`.
- `capture_response` — análogo para respuesta. Default `false`.

### Toggle desde CLI

```bash
# Disable Claude
docker compose exec postgres psql -U ssdoffice -d ssdoffice \
  -c "UPDATE provider_configs SET enabled=false WHERE provider='claude';"
```

El cambio se refleja en el próximo tick (60s) o trigger manual del collector.

---

## Paths montados en containers

`docker-compose.yml` monta del host al container:

| Host | Container | Modo | Uso |
|---|---|---|---|
| `${SCAN_TARGET_PATH}` | `/workspaces/target` | `:ro` | scanner del repo target |
| `${CLAUDE_LOGS_PATH}` | `/workspaces/claude-logs` | `:ro` | logs jsonl de Claude Code |
| `${VSCODE_LOGS_PATH}` | `/workspaces/vscode-logs` | `:ro` | logs de VS Code (Copilot Chat) |
| `./backend` | `/app` | rw | hot reload |
| `./frontend` | `/app` | rw | hot reload |

Para escannear otro repo, cambiar `SCAN_TARGET_PATH` en `.env` y `docker compose restart backend`.

---

## Defaults sensatos

Estado por default después de `docker compose up`:

```
Backend                  →  on
Frontend                 →  on
Postgres                 →  on
provider claude          →  enabled
provider copilot         →  enabled (si COPILOT_LOGS_PATH está seteado)
privacy_mode             →  metadata_only
capture_payload          →  false
capture_response         →  false
watch_loop               →  on cada 60s
```

---

## Cambio de timezone

Si tu sistema NO está en `America/Argentina/Buenos_Aires`:

```bash
echo "LOG_TIMEZONE=America/Sao_Paulo" >> .env
docker compose restart backend
```

Después re-ingestar los Copilot events viejos:

```bash
docker compose exec postgres psql -U ssdoffice -d ssdoffice \
  -c "DELETE FROM runtime_events WHERE provider='copilot' AND source_kind='local_logs';"
curl -X POST "http://localhost:8000/api/runtime/collector/run?provider=copilot"
```

Los eventos de Claude no necesitan re-ingest (ya vienen con TZ ISO).
