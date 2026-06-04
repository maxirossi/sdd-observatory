# AgentOps / SDD Observatory — Plan de acción incremental

## Objetivo principal

Construir una herramienta local para tener visibilidad del proceso agéntico
dentro de un proyecto SDD.

La herramienta debe permitir:

- detectar agentes definidos en el repo
- monitorear uso real de herramientas IA como Copilot, Claude u otros
- registrar requests/responses de forma configurable
- guardar métricas en PostgreSQL
- visualizar actividad en un dashboard React/Vite
- cruzar agentes definidos vs agentes realmente utilizados
- medir eficiencia, ruido, retrabajo y trazabilidad del proceso SDD

---

## Stack inicial

### Frontend

- React
- Vite
- TypeScript
- TailwindCSS
- Recharts

### Backend

- Python
- FastAPI
- SQLAlchemy / SQLModel
- Alembic
- PostgreSQL

### Infra local

- Docker Compose
- PostgreSQL
- Backend API
- Frontend dashboard

---

## Módulos principales

### Módulo 1 — Runtime Observability

Responsable de monitorear actividad real de herramientas IA.

Inicialmente se enfoca en **Copilot**.

Configurable para soportar luego:

- Claude
- Cursor
- OpenAI API
- Gemini
- Ollama
- otros providers

### Módulo 2 — Project Intelligence

Responsable de analizar el proyecto local.

Detecta:

- agentes definidos
- documentación SDD
- ciclos
- specs
- tasks
- requirements
- prompts
- convenciones del repo
- posible ownership por módulo

---

## Desarrollo en paralelo

Los dos módulos avanzan en paralelo desde el inicio.

Motivo:

- **Runtime Observability** muestra lo que realmente pasa.
- **Project Intelligence** muestra lo que el proyecto declara que debería pasar.

El valor aparece al cruzar ambos mundos.

---

## Fase 0 — Bootstrap del proyecto

**Objetivo:** base técnica mínima.

Tareas:

- crear monorepo
- agregar `frontend/`
- agregar `backend/`
- agregar `docker-compose.yml`
- levantar PostgreSQL
- configurar FastAPI
- configurar React/Vite
- configurar migrations
- configurar `.env`

**Resultado esperado:** app local corriendo con API backend + frontend + Postgres.

---

## Fase 1A — Project Intelligence MVP

**Objetivo:** escanear un proyecto local y registrar agentes.

Entrada:

```bash
python -m app.cli scan-project /path/to/project
```

Detectar inicialmente:

- `.github/agents/*.md`
- `CLAUDE.md`
- `.cursor/rules`
- `.docs/**`
- `docs/**`
- `functional/Cycles/**`
- `spec.md`
- `tasks.md`
- `requirements.md`

Entidades mínimas:

- `projects`
- `agents`
- `project_files`
- `sdd_documents`
- `sdd_cycles`
- `sdd_tasks`

Información por agente:

- nombre
- path
- descripción inferida
- contenido raw opcional
- tipo
- tags inferidos
- fecha de detección
- hash del archivo

**Resultado esperado:** el dashboard muestra proyecto escaneado, agentes,
documentos SDD, ciclos y tasks detectadas.

---

## Fase 1B — Runtime Observability MVP

**Objetivo:** capturar actividad inicial de Copilot de forma controlada y
configurable.

**Principio importante:** NO monitorear todo el tráfico de la PC. Sólo lo
asociado a providers configurados.

Provider inicial: `copilot`.

Providers futuros: `claude`, `cursor`, `openai`, `gemini`, `ollama`.

### Configuración sugerida

```yaml
providers:
  copilot:
    enabled: true
    capture_payload: false
    capture_response: false
    capture_metadata: true

  claude:
    enabled: false

privacy:
  redact_secrets: true
  store_raw_payloads: false
```

### Métricas mínimas

- timestamp
- provider
- endpoint
- status code
- latency
- request size
- response size
- estimated input chars
- estimated output chars
- error flag
- project association
- raw payload habilitado/deshabilitado

### Entidades mínimas

- `observed_requests`
- `observed_responses`
- `provider_configs`
- `runtime_events`

**Resultado esperado:** dashboard con requests por día, provider usado,
latencia promedio, errores, volumen de tráfico, timeline básica.

---

## Fase 2 — Cruce entre módulos

**Objetivo:** relacionar actividad real con estructura SDD del proyecto.

### Preguntas que debe responder

- ¿Qué agentes existen pero no se usan?
- ¿Qué tráfico IA ocurre sin task asociada?
- ¿Qué task genera más actividad?
- ¿Qué provider se usa más?
- ¿Qué parte del proyecto concentra más interacción IA?
- ¿Hay agentes definidos pero redundantes?
- ¿Hay prompts o respuestas que mencionan agentes no registrados?

### Inferencias iniciales

Detectar en prompts/responses:

- nombres de agentes
- task IDs
- HU IDs
- paths de archivos
- nombres de features
- nombres de ciclos

### Entidades nuevas

- `agent_usage_events`
- `task_activity_links`
- `provider_agent_mentions`
- `file_mentions`

**Resultado esperado:** dashboard con agentes definidos vs usados, actividad
por task, actividad por ciclo SDD, timeline agente/provider/task.

---

## Fase 3 — Dashboard inicial

### Secciones principales

1. **Project Overview** — nombre, path, último scan, agentes, docs SDD,
   eventos runtime.
2. **Agents** — declarados, usados, no usados, mencionados pero no definidos.
3. **Runtime Activity** — requests por provider, errores, latencia, volumen,
   timeline.
4. **SDD Flow** — ciclos, tasks, actividad asociada, gaps de trazabilidad.
5. **Findings** — alertas útiles: agente definido pero nunca usado, tráfico
   IA sin task, task con demasiadas iteraciones, provider no configurado
   detectado, posible scope drift.

---

## Fase 4 — Sanitización y privacidad

**Objetivo:** evitar guardar información sensible accidentalmente.

### Reglas mínimas

Redactar automáticamente:

- API keys
- tokens
- passwords
- JWTs
- bearer tokens
- cookies
- emails si se configura
- variables `.env`
- secrets comunes

### Modos de almacenamiento

- `metadata_only`
- `sanitized_payload`
- `raw_local_only`

**Default recomendado:** `metadata_only`. Raw payload deshabilitado por
defecto.

---

## Fase 5 — Configuración extensible de providers

**Objetivo:** pasar de Copilot-only a provider-agnostic.

### Interface conceptual

```python
class ProviderAdapter:
    name: str

    def match_request(self, request) -> bool: ...
    def parse_request(self, request) -> ParsedRequest: ...
    def parse_response(self, response) -> ParsedResponse: ...
```

Providers: `copilot`, `claude`, `cursor`, `openai`, `gemini`, `ollama`,
`custom`.

**Resultado esperado:** agregar un provider no requiere reescribir el core.

---

## Fase 6 — Métricas de eficiencia agéntica

**Objetivo:** medir valor real del proceso.

Métricas candidatas:

- requests por task
- requests por agente
- agentes más usados
- agentes no usados
- tasks con más iteraciones
- prompts sin task asociada
- errores por provider
- latencia por provider
- volumen por día
- actividad por ciclo
- actividad fuera de scope
- archivos más mencionados

---

## Fase 7 — Integración con Git

**Objetivo:** cruzar actividad IA con cambios reales.

Capturar:

- branch actual
- commits
- changed files
- diff summary
- cantidad de archivos modificados
- líneas agregadas/eliminadas
- relación con task/HU

Valor: detectar mucho tráfico sin cambios, pocos prompts con mucho impacto,
cambios fuera de scope, agentes asociados a archivos concretos, retrabajo
por feature.

---

## Modelo de datos inicial sugerido

```sql
projects(id, name, path, created_at, last_scanned_at)

agents(id, project_id, name, file_path, type, description, tags,
       content_hash, created_at, updated_at)

sdd_documents(id, project_id, type, file_path, title, content_hash)

sdd_tasks(id, project_id, cycle_id, task_code, title, status, file_path)

provider_configs(id, provider, enabled, capture_metadata, capture_payload,
                 capture_response)

runtime_events(id, project_id, provider, event_type, timestamp,
               status_code, latency_ms, request_size, response_size,
               metadata_json)

llm_interactions(id, runtime_event_id, provider, model, prompt_chars,
                 response_chars, sanitized_prompt, sanitized_response,
                 detected_agent_id, detected_task_id)

agent_usage_events(id, project_id, agent_id, provider, source,
                   confidence, timestamp)
```

---

## MVP recomendado

### MVP 1 — debe permitir

- registrar proyecto
- escanear repo
- detectar agentes
- detectar docs SDD
- configurar provider Copilot
- capturar metadata básica
- mostrar dashboard inicial

### No incluir todavía

- análisis avanzado con embeddings
- captura total de payloads
- interceptación global
- scoring complejo
- multiusuario
- cloud sync
- billing
- autenticación

---

## Principios del producto

1. **Local-first** — la herramienta corre localmente.
2. **Privacy-first** — no guardar payloads sensibles por defecto.
3. **Provider-agnostic** — Copilot es el primer provider, no el único.
4. **SDD-aware** — observabilidad del proceso SDD, no sólo de LLM.
5. **Evidence-based** — decisiones sobre agentes basadas en datos reales.

---

## Nombre tentativo

Opciones:

- SDD Observatory
- AgentOps Local
- Project Agent Intelligence
- DevAgent Radar
- SpecFlow Observatory
- OctoMate Project Lens

**Nombre recomendado inicial:** SDD Observatory

---

## Resultado final esperado

Una herramienta que permita ver:

- qué agentes existen,
- qué agentes se usan,
- cómo se usa Copilot/Claude/Cursor,
- qué tareas generan más actividad,
- dónde hay ruido,
- dónde hay retrabajo,
- y cómo mejorar el proceso SDD con evidencia.
