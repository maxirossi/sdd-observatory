# Contribuir a SDD Observatory

¡Gracias por el interés! Esta guía cubre lo mínimo para levantar el proyecto y abrir un cambio.

## Setup local

Requisitos: Docker + Docker Compose.

```bash
cp .env.example .env        # ajustá SCAN_TARGET_PATH al repo SDD que quieras observar
docker compose up -d        # postgres + backend + frontend
docker compose exec backend python -m app.cli scan-project /workspaces/target
```

Dashboard en http://localhost:5180 · API en http://localhost:8000 (docs en `/docs`).

El stack corre con hot-reload: el backend con `uvicorn --reload` y el frontend con HMR de Vite. Los logs de Claude/Copilot se ingestan automáticamente cada 60s.

Ver [`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md) para migrations, scan, ingest y typecheck.

## Antes de abrir un PR

- **Backend:** mantené el estilo existente (FastAPI + SQLModel). Si tocás el modelo de datos, agregá una migración Alembic.
- **Frontend:** `npx tsc --noEmit` debe pasar sin errores antes de commitear.
- **Privacidad:** este proyecto observa el runtime de herramientas IA. Nunca commitees datos capturados (sesiones, prompts, dumps), paths absolutos del host ni secretos. El sanitizer redacta tokens/keys, pero la regla es no persistir nada sensible al repo.
- **Principio rector:** *si no puede demostrarse estructuralmente, no debe visualizarse como un hecho.* La UI separa evidencia (lo que el runtime observó) de claims (lo que el agente afirma). Mantené esa distinción al agregar datos a la interfaz.

## Estilo de commits

Conventional commits en español o inglés, p. ej.:

```
feat(runtime): nuevo adapter para <tool>
fix(live-status): corrige falso "Finalizado"
docs(config): aclara SCAN_TARGET_PATH
```

## Reportar bugs / ideas

Abrí un issue describiendo qué esperabas, qué pasó, y cómo reproducirlo (provider, target, pasos).

---

Al contribuir aceptás que tu aporte se licencie bajo [MIT](./LICENSE).
