from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_env: str = "development"
    log_level: str = "INFO"
    database_url: str = "postgresql+psycopg://ssdoffice:ssdoffice@postgres:5432/ssdoffice"
    privacy_mode: str = "metadata_only"  # metadata_only | sanitized_payload | raw_local_only

    # Host-side path of the project mounted under /workspaces/target. Used when
    # persisting Project.path so it matches the `cwd` claude logs record.
    # Setting it via .env is the simplest way to keep ingest associations honest.
    scan_target_host_path: str | None = None
    # In-container mount path that mirrors `scan_target_host_path`. When the file
    # API gets a project whose stored path is the host one, we redirect reads here.
    scan_target_mount_path: str = "/workspaces/target"

    # Background ingest of Claude session logs.
    ingest_watch_enabled: bool = False
    ingest_watch_interval_seconds: int = 60
    ingest_watch_path: str = "/workspaces/claude-logs"

    # Background re-scan del proyecto target (re-parsea tasks/cycles/docs y guarda
    # un snapshot de progreso por ciclo). Sin esto, el progreso queda congelado en
    # el último scan manual.
    scan_watch_enabled: bool = True
    scan_watch_interval_seconds: int = 3600  # 1h

    # Módulo Audit (basado en git history del target).
    audit_large_branch_files: int = 30  # branch con > N archivos vs base → warning
    audit_window_days: int = 14  # ventana de datos del audit (últimas 2 semanas)
    audit_max_branches: int = 60  # cuántas branches recientes analizar
    # Set to enable VS Code Copilot log ingest within the same watch loop.
    copilot_logs_path: str | None = None
    # Path al workspaceStorage de VS Code (donde viven los chatSessions
    # con prompts/responses/agents reales). Reemplaza al copilot_logs_path
    # como fuente preferida porque trae mucho más detalle.
    copilot_storage_path: str | None = None
    # TZ del host que generó los logs. VS Code escribe timestamps sin TZ en
    # hora local; necesitamos esta info para convertirlos a UTC al persistir.
    log_timezone: str = "America/Argentina/Buenos_Aires"

    # ── Auto-ejecución (runner host-side) ──
    # El backend NO ejecuta agentes (container, mount :ro, sin claude/keys). Solo
    # ENCOLA jobs; un runner en el host los toma y corre `claude -p` en el cwd del
    # repo. Gate de seguridad: por defecto solo se permite encolar sobre el fixture
    # lab (sdd_lab_host_path), nunca sobre el target real.
    runner_enabled: bool = True
    runner_lab_only: bool = True
    sdd_lab_host_path: str | None = None  # path host del fixture (lo trae .env)


settings = Settings()
