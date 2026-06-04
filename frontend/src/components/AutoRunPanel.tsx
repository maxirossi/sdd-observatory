import { useEffect, useRef, useState } from 'react';
import { Play } from 'lucide-react';
import { api, type AgentRunRow, type RunnerStatus } from '../lib/api';

interface Props {
  projectId: string;
}

const STATUS: Record<string, { cls: string; label: string }> = {
  queued: { cls: 'bg-slate-500/15 text-slate-300', label: 'en cola' },
  running: { cls: 'bg-amber-500/15 text-amber-300 animate-pulse', label: 'ejecutando' },
  done: { cls: 'bg-emerald-500/15 text-emerald-300', label: 'completado' },
  error: { cls: 'bg-rose-500/15 text-rose-300', label: 'error' },
  canceled: { cls: 'bg-slate-700 text-slate-400', label: 'cancelado' },
};

const DEFAULT_PROMPT =
  'Actuá como el orchestrator del repo y ejecutá la siguiente tarea pendiente del cycle-2, delegando en los agentes que correspondan.';

export function AutoRunPanel({ projectId }: Props) {
  const [status, setStatus] = useState<RunnerStatus | null>(null);
  const [jobs, setJobs] = useState<AgentRunRow[]>([]);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [taskRef, setTaskRef] = useState('');
  const [perm, setPerm] = useState('acceptEdits');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = () => {
    api.runnerStatus().then(setStatus).catch(() => {});
    api.runnerJobs({ projectId, limit: 20 }).then(setJobs).catch(() => {});
  };

  useEffect(() => {
    refresh();
    timer.current = setInterval(refresh, 4000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const enqueue = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.runnerEnqueue({
        project_id: projectId,
        prompt: prompt.trim(),
        task_ref: taskRef.trim() || null,
        permission_mode: perm,
      });
      setTaskRef('');
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'No se pudo encolar');
    } finally {
      setBusy(false);
    }
  };

  const active = (status?.queued ?? 0) + (status?.running ?? 0);

  return (
    <div className="card-elev overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-2.5 text-left hover:bg-slate-800/30"
      >
        <div className="flex items-center gap-2">
          <Play className="h-3.5 w-3.5 text-cyan-400" />
          <span className="text-[13px] font-semibold text-slate-100">Auto-ejecución</span>
          <span className="text-[11px] text-slate-500">Claude Code · runner host-side</span>
          {active > 0 && (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 font-mono text-[10px] text-amber-300">
              {active} activo{active !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        <span className="text-[11px] text-slate-500">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-slate-800/70 p-4">
          {/* Aviso del modelo de ejecución */}
          <p className="rounded-md border border-slate-800 bg-slate-950/50 px-3 py-2 text-[11px] leading-relaxed text-slate-400">
            El backend <span className="text-slate-300">encola</span> el job; un runner en el host lo
            ejecuta con <code className="text-cyan-300">claude -p</code> en el repo y aparece en{' '}
            <span className="text-slate-300">Sessions</span> al terminar. Arrancá el runner:{' '}
            <code className="text-slate-300">python3 scripts/observatory-runner.py</code>.
            {status && !status.lab_only && (
              <span className="text-amber-300"> · lab-only OFF (cuidado: cualquier proyecto)</span>
            )}
          </p>

          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            className="w-full rounded-md border border-slate-700/80 bg-slate-950 px-3 py-2 text-[12.5px] text-slate-100 placeholder-slate-600 focus:border-cyan-500 focus:outline-none"
            placeholder="Prompt para el orchestrator…"
          />
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={taskRef}
              onChange={(e) => setTaskRef(e.target.value)}
              placeholder="task ref (opc. ej. T011)"
              className="w-40 rounded-md border border-slate-700/80 bg-slate-950 px-2 py-1.5 text-[12px] text-slate-100 placeholder-slate-600 focus:border-cyan-500 focus:outline-none"
            />
            <select
              value={perm}
              onChange={(e) => setPerm(e.target.value)}
              title="acceptEdits: auto-acepta ediciones · bypassPermissions: 100% desatendido (solo lab)"
              className="rounded border border-slate-800 bg-slate-950 px-2 py-1.5 text-[11px] text-slate-200 focus:border-slate-600 focus:outline-none"
            >
              <option value="acceptEdits">acceptEdits</option>
              <option value="bypassPermissions">bypassPermissions (autónomo)</option>
            </select>
            <button
              type="button"
              onClick={enqueue}
              disabled={busy || !prompt.trim()}
              className="flex items-center gap-1.5 rounded-md border border-cyan-700/60 bg-cyan-500/10 px-3 py-1.5 text-[12px] font-semibold text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-40"
            >
              <Play className="h-3 w-3" /> {busy ? 'Encolando…' : 'Ejecutar'}
            </button>
          </div>
          {err && <p className="text-[11px] text-rose-300">{err}</p>}

          {/* Jobs recientes */}
          {jobs.length > 0 && (
            <ul className="divide-y divide-slate-800/60 rounded-md border border-slate-800">
              {jobs.map((j) => {
                const st = STATUS[j.status] ?? STATUS.queued;
                return (
                  <li key={j.id} className="flex items-start gap-3 px-3 py-2">
                    <span className={`mt-0.5 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${st.cls}`}>
                      {st.label}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12px] text-slate-300" title={j.prompt}>
                        {j.task_ref ? <span className="font-mono text-cyan-300">{j.task_ref} · </span> : null}
                        {j.prompt}
                      </p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-3 font-mono text-[10px] text-slate-600">
                        <span>{new Date(j.created_at).toLocaleString()}</span>
                        {j.session_id && <span className="text-slate-500">session {j.session_id.slice(0, 8)}</span>}
                        {j.exit_code != null && <span>exit {j.exit_code}</span>}
                        <span>{j.permission_mode}</span>
                      </p>
                      {j.error && <p className="mt-0.5 truncate text-[10px] text-rose-300/80" title={j.error}>{j.error}</p>}
                    </div>
                    {j.status === 'queued' && (
                      <button
                        type="button"
                        onClick={() => api.runnerCancel(j.id).then(refresh).catch(() => {})}
                        className="shrink-0 rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400 hover:bg-slate-800"
                      >
                        cancelar
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
