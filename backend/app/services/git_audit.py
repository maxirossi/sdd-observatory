"""Auditoría a nivel repositorio basada en git history del target.

Detecta: pushes directos a la base (anomalía), branches con muchos archivos
cambiados (warning) y estadísticas de contribuidores. Read-only sobre el `.git`
montado en el container.
"""
from __future__ import annotations

import subprocess
from collections import defaultdict
from datetime import datetime

from app.config import settings


def container_repo_path(project_path: str) -> str:
    """Traduce el `Project.path` (host) al path legible DENTRO del contenedor.

    El target configurado se monta en `scan_target_mount_path` (su host path NO
    existe en el contenedor), así que para ese proyecto devolvemos el mount. El
    resto de los proyectos (p.ej. sdd-template-lab) se montan en su propio path
    host, así que se usa tal cual. Permite que el audit de git sea POR PROYECTO."""
    if settings.scan_target_host_path and project_path == settings.scan_target_host_path:
        return settings.scan_target_mount_path
    return project_path


def _git(repo: str, *args: str, timeout: int = 30) -> str:
    try:
        r = subprocess.run(
            ["git", "-C", repo, *args],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return r.stdout
    except (subprocess.SubprocessError, OSError):
        return ""


def _git_available() -> bool:
    try:
        subprocess.run(["git", "--version"], capture_output=True, timeout=5)
        return True
    except (subprocess.SubprocessError, OSError):
        return False


def _detect_base(repo: str) -> str | None:
    refs = _git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes")
    names = set(refs.split())
    for cand in ("main", "master", "origin/main", "origin/master"):
        if cand in names:
            return cand
    return None


def _parse_iso(s: str) -> datetime | None:
    try:
        return datetime.fromisoformat(s.strip())
    except (ValueError, TypeError):
        return None


def get_audit(repo_path: str) -> dict:
    if not repo_path or not _git_available():
        return {"available": False, "reason": "git no disponible o path vacío"}
    # ¿es un repo?
    if not _git(repo_path, "rev-parse", "--git-dir").strip():
        return {"available": False, "reason": "el target no es un repositorio git"}

    base = _detect_base(repo_path)
    if base is None:
        return {"available": False, "reason": "no se detectó branch base (main/master)"}

    thr = settings.audit_large_branch_files
    window_days = settings.audit_window_days
    since = f"{window_days} days ago"

    # ── Resumen ── (totales all-time como contexto + commits en la ventana)
    total_commits = int(_git(repo_path, "rev-list", "--count", base).strip() or 0)
    commits_in_window = int(
        _git(repo_path, "rev-list", "--count", f"--since={since}", base).strip() or 0
    )
    branch_names = [b for b in _git(repo_path, "for-each-ref", "--format=%(refname:short)", "refs/heads").split() if b]
    last_commit_at = _parse_iso(_git(repo_path, "log", "-1", "--format=%cI", base))

    # ── Pushes directos a base (first-parent + no-merge), ÚLTIMAS 2 SEMANAS ──
    # Lo que entra por PR aparece como 2º parent de un merge → NO en first-parent.
    # Los no-merge en first-parent son commits directos sobre la base.
    raw = _git(
        repo_path,
        "log",
        "--first-parent",
        "--no-merges",
        f"--since={since}",
        "--format=%H%x1f%an%x1f%aI%x1f%s",
        base,
    )
    direct_recent: list[dict] = []
    for line in raw.splitlines():
        parts = line.split("\x1f")
        if len(parts) != 4:
            continue
        sha, author, date, msg = parts
        direct_recent.append({"sha": sha[:10], "author": author, "date": date, "message": msg[:140]})
    # Total all-time (contexto) — cheap rev-list, sin traer la lista entera.
    direct_total = int(
        _git(repo_path, "rev-list", "--count", "--first-parent", "--no-merges", base).strip() or 0
    )

    # ── Branches grandes (warning) ──
    # NOTA: for-each-ref NO interpreta %x1f (lo deja literal); usamos tab real como
    # separador (los refnames/fechas/autores no contienen tabs).
    refs = _git(
        repo_path,
        "for-each-ref",
        "--sort=-committerdate",
        "--format=%(refname:short)\t%(committerdate:iso-strict)\t%(authorname)",
        "refs/heads",
    )
    base_short = base.split("/")[-1]
    large_branches: list[dict] = []
    analyzed = 0
    for line in refs.splitlines():
        parts = line.split("\t")
        if len(parts) != 3:
            continue
        name, cdate, author = parts
        if name == base_short or name == base:
            continue
        if analyzed >= settings.audit_max_branches:
            break
        analyzed += 1
        mb = _git(repo_path, "merge-base", base, name).strip()
        if not mb:
            continue
        files = [f for f in _git(repo_path, "diff", "--name-only", f"{mb}..{name}").splitlines() if f]
        ahead = int(_git(repo_path, "rev-list", "--count", f"{mb}..{name}").strip() or 0)
        if len(files) > thr:
            large_branches.append(
                {
                    "name": name,
                    "files_changed": len(files),
                    "commits_ahead": ahead,
                    "last_commit": cdate,
                    "author": author,
                }
            )
    large_branches.sort(key=lambda b: -b["files_changed"])

    # ── Contribuidores (ÚLTIMAS 2 SEMANAS) ──
    shortlog = _git(repo_path, "shortlog", "-sn", "--no-merges", f"--since={since}", base)
    commits_by_author: dict[str, int] = {}
    for line in shortlog.splitlines():
        line = line.strip()
        if not line:
            continue
        cnt, _, name = line.partition("\t")
        try:
            commits_by_author[name.strip()] = int(cnt.strip())
        except ValueError:
            continue
    # insertions/deletions por autor (numstat) — en la ventana
    numstat = _git(
        repo_path,
        "log",
        "--no-merges",
        "--numstat",
        f"--since={since}",
        "--format=\x02%an",
        base,
    )
    ins: dict[str, int] = defaultdict(int)
    dele: dict[str, int] = defaultdict(int)
    files_touched: dict[str, int] = defaultdict(int)
    cur = None
    for line in numstat.splitlines():
        if line.startswith("\x02"):
            cur = line[1:].strip()
            continue
        if cur is None or not line.strip():
            continue
        cols = line.split("\t")
        if len(cols) == 3:
            a, d, _f = cols
            if a.isdigit():
                ins[cur] += int(a)
            if d.isdigit():
                dele[cur] += int(d)
            files_touched[cur] += 1
    contributors = [
        {
            "author": a,
            "commits": commits_by_author.get(a, 0),
            "insertions": ins.get(a, 0),
            "deletions": dele.get(a, 0),
            "files_touched": files_touched.get(a, 0),
        }
        for a in set(commits_by_author) | set(ins)
    ]
    contributors.sort(key=lambda c: -c["commits"])

    return {
        "available": True,
        "base_branch": base,
        "total_commits": total_commits,
        "commits_in_window": commits_in_window,
        "branches": len(branch_names),
        "contributors": len(contributors),
        "last_commit_at": last_commit_at.isoformat() if last_commit_at else None,
        "direct_to_base_total": direct_total,
        "direct_to_base_recent": direct_recent[:100],
        "large_branches": large_branches[:50],
        "top_contributors": contributors[:30],
        "thresholds": {
            "large_branch_files": thr,
            "window_days": window_days,
            "max_branches": settings.audit_max_branches,
        },
    }
