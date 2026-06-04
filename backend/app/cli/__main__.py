import typer
from rich.console import Console
from rich.table import Table
from sqlmodel import Session

from app.config import settings
from app.db import engine
from app.services.claude_logs import ingest_path as ingest_claude_logs_path
from app.services.copilot_logs import ingest_path as ingest_copilot_logs_path
from app.services.scanner import persist, scan

app = typer.Typer(help="SDD Observatory CLI", no_args_is_help=True)
console = Console()


@app.command("info")
def info() -> None:
    """Muestra información del entorno actual."""
    console.print(f"[bold]ssdoffice-backend[/] env=[cyan]{settings.app_env}[/] privacy=[cyan]{settings.privacy_mode}[/]")
    console.print(f"DB: [dim]{settings.database_url}[/]")


@app.command("scan-project")
def scan_project(
    path: str = typer.Argument(..., help="Path absoluto al proyecto a escanear"),
    persist_db: bool = typer.Option(True, "--persist/--no-persist", help="Persistir en Postgres"),
) -> None:
    """Detecta agentes y documentación SDD en el path indicado."""
    console.print(f"[bold cyan]scan-project[/] target=[yellow]{path}[/]")
    result = scan(path)

    table = Table(title="Resumen", show_lines=False)
    table.add_column("Item")
    table.add_column("Cantidad", justify="right")
    table.add_row("Agentes", str(len(result.agents)))
    table.add_row("Documentos SDD", str(len(result.documents)))
    table.add_row("Tasks", str(len(result.tasks)))
    console.print(table)

    if persist_db:
        with Session(engine) as session:
            project = persist(result, session)
        console.print(f"[green]Persistido[/] project_id=[bold]{project.id}[/] path=[yellow]{project.path}[/]")
    else:
        console.print("[yellow]--no-persist[/] activo: no se escribió en la DB.")


@app.command("ingest-claude-logs")
def ingest_claude_logs(
    path: str = typer.Argument(
        "/workspaces/claude-logs",
        help="Path a ~/.claude/projects dentro del container (default monta el del host)",
    ),
) -> None:
    """Lee los .jsonl de sesiones Claude Code y persiste runtime_events + llm_interactions."""
    console.print(f"[bold cyan]ingest-claude-logs[/] path=[yellow]{path}[/]")
    with Session(engine) as session:
        stats = ingest_claude_logs_path(path, session)

    table = Table(title="Resumen ingest")
    table.add_column("Item")
    table.add_column("Cantidad", justify="right")
    table.add_row("Archivos vistos", str(stats.files_seen))
    table.add_row("Líneas vistas", str(stats.lines_seen))
    table.add_row("Eventos insertados", str(stats.events_inserted))
    table.add_row("Interacciones insertadas", str(stats.interactions_inserted))
    table.add_row("Menciones detectadas", str(stats.mentions_inserted))
    table.add_row("Skipped", str(stats.skipped))
    console.print(table)


@app.command("ingest-copilot-logs")
def ingest_copilot_logs(
    path: str = typer.Argument(
        "/workspaces/vscode-logs",
        help="Path a ~/.config/Code/logs dentro del container",
    ),
) -> None:
    """Lee los logs de la extensión Copilot y persiste runtime_events."""
    console.print(f"[bold cyan]ingest-copilot-logs[/] path=[yellow]{path}[/]")
    with Session(engine) as session:
        stats = ingest_copilot_logs_path(path, session)

    table = Table(title="Resumen ingest")
    table.add_column("Item")
    table.add_column("Cantidad", justify="right")
    table.add_row("Archivos vistos", str(stats.files_seen))
    table.add_row("Líneas vistas", str(stats.lines_seen))
    table.add_row("Eventos insertados", str(stats.events_inserted))
    table.add_row("Interacciones insertadas", str(stats.interactions_inserted))
    table.add_row("Skipped", str(stats.skipped))
    console.print(table)


if __name__ == "__main__":
    app()
