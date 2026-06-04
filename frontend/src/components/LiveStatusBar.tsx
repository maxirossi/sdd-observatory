import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, GitBranch, Loader2 } from 'lucide-react';
import { api, type LiveStatus } from '../lib/api';
import { getLiveStatusEnabled, subscribeLiveStatusEnabled } from '../lib/liveStatusPref';

interface Props {
  projectId: string;
}

const PHASE_COLOR: Record<string, string> = {
  starting: '#38bdf8',
  delegating: '#a78bfa',
  agent_working: '#22d3ee',
  verifying: '#fbbf24',
  done: '#34d399',
};

function composeText(s: LiveStatus): { main: string; detail?: string | null } {
  // Sin "Iniciando" (generaba falsos positivos): mostramos el paso real si lo hay,
  // y si no, un genérico "En progreso".
  if (s.phase === 'agent_working') {
    return { main: `${s.active_agent ?? 'agente'} trabajando…`, detail: s.current_step };
  }
  if (s.phase === 'verifying') {
    return { main: 'Integrando / verificando…', detail: s.current_step };
  }
  return { main: s.current_step || 'En progreso' };
}

export function LiveStatusBar({ projectId }: Props) {
  const [enabled, setEnabled] = useState(getLiveStatusEnabled());
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [doneFlash, setDoneFlash] = useState<string | null>(null);
  const prevActive = useRef(false);
  const lastTask = useRef<string | null>(null);
  const inactiveStreak = useRef(0);

  useEffect(() => subscribeLiveStatusEnabled(setEnabled), []);

  useEffect(() => {
    if (!enabled || !projectId) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const s = await api.liveStatus(projectId);
        if (!cancelled) setStatus(s);
      } catch {
        /* silencioso: red intermitente no debe romper la barra */
      }
      if (!cancelled) timer = setTimeout(poll, 2000);
    };
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, projectId]);

  // Transición activo → inactivo con HISTÉRESIS: Copilot escribe a ráfagas y un
  // sub-agente corriendo no toca el archivo padre, así que un solo poll inactivo
  // NO significa "finalizado". Exigimos 2 polls inactivos consecutivos (~4s) y
  // que no haya sub-agente pendiente antes de flashear "✓ Finalizado".
  useEffect(() => {
    if (status == null) return;
    const active = !!status.active;
    if (active) {
      if (status.task_ref) lastTask.current = status.task_ref;
      inactiveStreak.current = 0;
      prevActive.current = true;
      return;
    }
    // status inactivo
    inactiveStreak.current += 1;
    if (prevActive.current && inactiveStreak.current >= 2) {
      prevActive.current = false;
      setDoneFlash(`✓ Finalizado${lastTask.current ? ` · ${lastTask.current}` : ''}`);
      const t = setTimeout(() => setDoneFlash(null), 3500);
      return () => clearTimeout(t);
    }
  }, [status]);

  if (!enabled) return null;
  const active = !!status?.active;
  if (!active && !doneFlash) return null;

  const color = doneFlash ? PHASE_COLOR.done : PHASE_COLOR[status?.phase ?? 'starting'] ?? '#38bdf8';
  const text = doneFlash ? { main: doneFlash } : composeText(status as LiveStatus);

  return (
    <div
      className="flex items-center gap-3 border-b px-5 py-2 fade-in"
      style={{
        background: 'linear-gradient(90deg, #0a1733 0%, #0c1e3f 100%)',
        borderColor: `${color}40`,
        boxShadow: `inset 3px 0 0 ${color}, inset 0 -1px 0 ${color}33`,
      }}
    >
      {/* Icono de progreso visible */}
      {doneFlash ? (
        <CheckCircle2 className="h-4 w-4 shrink-0" style={{ color }} />
      ) : (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" style={{ color }} />
      )}

      <span className="truncate text-[12.5px] font-semibold" style={{ color }}>
        {text.main}
      </span>
      {!doneFlash && text.detail && (
        <span className="hidden truncate text-[11px] text-slate-400 md:inline">· {text.detail}</span>
      )}

      {/* meta a la derecha */}
      {active && status && (
        <span className="ml-auto flex shrink-0 items-center gap-2.5 font-mono text-[10px] text-slate-400">
          {status.auto_run && (
            <span
              className="rounded bg-cyan-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-cyan-200 ring-1 ring-cyan-400/30"
              title="Disparado por el runner host (auto-ejecución)"
            >
              auto
            </span>
          )}
          {status.provider && (
            <span
              className="rounded px-1.5 py-0.5 text-[10.5px] capitalize ring-1 ring-inset"
              style={{ background: `${color}1a`, color, boxShadow: `inset 0 0 0 1px ${color}33` }}
              title={`Provider: ${status.provider}`}
            >
              {status.provider}
            </span>
          )}
          {status.branch && (
            <span
              className="flex items-center gap-1 rounded bg-blue-500/15 px-1.5 py-0.5 text-[10.5px] text-blue-200 ring-1 ring-blue-400/20"
              title={`Branch: ${status.branch}`}
            >
              <GitBranch className="h-3 w-3" />
              <span className="max-w-[200px] truncate">{status.branch}</span>
            </span>
          )}
          {status.task_ref && (
            <span className="rounded bg-slate-800/70 px-1.5 py-0.5 text-slate-300">{status.task_ref}</span>
          )}
          {(status.agents_done?.length ?? 0) > 0 && (
            <span className="text-emerald-400/80">{status.agents_done!.length} agente(s) ✓</span>
          )}
          {(status.delegations_total ?? 0) > 0 && <span>{status.delegations_total} deleg</span>}
          {(status.todos_total ?? 0) > 0 && (
            <span>
              {status.todos_done}/{status.todos_total} todos
            </span>
          )}
        </span>
      )}
    </div>
  );
}
