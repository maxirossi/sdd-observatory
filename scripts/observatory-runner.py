#!/usr/bin/env python3
"""SDD Observatory — runner host-side de auto-ejecución.

El backend (en container, mount :ro, sin claude/keys) NO ejecuta agentes: solo
ENCOLA jobs. Este runner corre en el HOST (donde vive `claude` y hay permiso de
escritura al repo), pollea la cola, toma cada job, ejecuta `claude -p <prompt>`
en el cwd del repo, y reporta el resultado + session_id (que linkea con el log
que el Observatory ingesta).

Uso:
    python3 scripts/observatory-runner.py                  # loop, pollea cada 5s
    python3 scripts/observatory-runner.py --once           # un solo poll
    python3 scripts/observatory-runner.py --api http://localhost:8000
    python3 scripts/observatory-runner.py --permission-mode bypassPermissions

Seguridad: el backend solo encola jobs sobre el fixture lab (runner_lab_only).
`bypassPermissions` corre 100% desatendido (equivale a --dangerously-skip-permissions)
— usar solo sobre el lab. `acceptEdits` (default) auto-acepta ediciones.

Solo stdlib (urllib + subprocess). No instala nada.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request


def _req(method: str, url: str, body: dict | None = None) -> dict | list:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read().decode()
        return json.loads(raw) if raw else {}


def _claude_session_from_json(stdout: str) -> str | None:
    """`claude -p --output-format json` devuelve un objeto con session_id."""
    try:
        obj = json.loads(stdout)
    except json.JSONDecodeError:
        # a veces hay líneas previas; intentamos la última línea JSON
        for line in reversed(stdout.strip().splitlines()):
            try:
                obj = json.loads(line)
                break
            except json.JSONDecodeError:
                continue
        else:
            return None
    if isinstance(obj, dict):
        return obj.get("session_id") or obj.get("sessionId")
    return None


def run_job(job: dict, api: str, claude_bin: str, perm_override: str | None) -> None:
    rid = job["id"]
    cwd = job["cwd"]
    prompt = job["prompt"]
    perm = perm_override or job.get("permission_mode") or "acceptEdits"
    print(f"[runner] job {rid[:8]} · task={job.get('task_ref')} · cwd={cwd} · perm={perm}")

    # Claim (queued → running). 409 = otro runner lo tomó.
    try:
        _req("POST", f"{api}/api/runner/jobs/{rid}/claim")
    except urllib.error.HTTPError as e:
        if e.code == 409:
            print(f"[runner] job {rid[:8]} ya tomado, skip")
            return
        raise

    cmd = [
        claude_bin, "-p", prompt,
        "--output-format", "json",
        "--permission-mode", perm,
    ]
    status, session_id, exit_code, err = "done", None, None, None
    try:
        proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
        exit_code = proc.returncode
        session_id = _claude_session_from_json(proc.stdout)
        if proc.returncode != 0:
            status = "error"
            err = (proc.stderr or proc.stdout or "")[-2000:]
        print(f"[runner] job {rid[:8]} exit={exit_code} session={session_id}")
    except FileNotFoundError:
        status, err = "error", f"claude no encontrado: {claude_bin}"
    except Exception as e:  # noqa: BLE001
        status, err = "error", f"{type(e).__name__}: {e}"

    _req(
        "POST",
        f"{api}/api/runner/jobs/{rid}/complete",
        {"status": status, "session_id": session_id, "exit_code": exit_code, "error": err},
    )


def poll_once(api: str, claude_bin: str, perm_override: str | None) -> int:
    try:
        jobs = _req("GET", f"{api}/api/runner/jobs?status=queued&limit=50")
    except urllib.error.URLError as e:
        print(f"[runner] backend inalcanzable: {e}")
        return 0
    if not isinstance(jobs, list) or not jobs:
        return 0
    # más viejos primero (la API los devuelve desc por created_at)
    jobs = sorted(jobs, key=lambda j: j.get("created_at", ""))
    for job in jobs:
        run_job(job, api, claude_bin, perm_override)
    return len(jobs)


def main() -> int:
    ap = argparse.ArgumentParser(description="SDD Observatory auto-run runner (host-side)")
    ap.add_argument("--api", default="http://localhost:8000", help="URL del backend")
    ap.add_argument("--interval", type=float, default=5.0, help="segundos entre polls")
    ap.add_argument("--once", action="store_true", help="un solo poll y salir")
    ap.add_argument("--claude", default="claude", help="binario de Claude Code")
    ap.add_argument(
        "--permission-mode",
        default=None,
        help="override del modo (acceptEdits|bypassPermissions|default|plan)",
    )
    args = ap.parse_args()

    print(f"[runner] API={args.api} · claude={args.claude} · interval={args.interval}s")
    if args.once:
        poll_once(args.api, args.claude, args.permission_mode)
        return 0
    try:
        while True:
            poll_once(args.api, args.claude, args.permission_mode)
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\n[runner] detenido")
    return 0


if __name__ == "__main__":
    sys.exit(main())
