import { useEffect, useState } from 'react';
import { CheckCircle2, GitCommit, MessageSquare, Bot, X } from 'lucide-react';
import { api, type TaskTimeline, type TimelineStep } from '../lib/api';

interface Props {
  projectId: string;
  taskRef: string;
  onClose: () => void;
}

const KIND: Record<string, { color: string; Icon: typeof Bot }> = {
  request: { color: '#38bdf8', Icon: MessageSquare },
  agent: { color: '#a78bfa', Icon: Bot },
  commit: { color: '#f59e0b', Icon: GitCommit },
  closed: { color: '#34d399', Icon: CheckCircle2 },
};

function fmtDur(s: number | null | undefined): string {
  if (s == null) return '';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

function fmtClock(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

export function TaskTimelineModal({ projectId, taskRef, onClose }: Props) {
  const [data, setData] = useState<TaskTimeline | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    api
      .taskTimeline(projectId, taskRef)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [projectId, taskRef]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-slate-800 px-5 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[13px] font-semibold text-cyan-300">{taskRef}</span>
              <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[9.5px] uppercase tracking-wide text-slate-400">
                Task Replay
              </span>
            </div>
            {data?.title && <p className="mt-0.5 truncate text-[12px] text-slate-400">{data.title}</p>}
          </div>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200">
            <X className="h-4 w-4" />
          </button>
        </header>

        {data && (
          <div className="flex flex-wrap gap-x-5 gap-y-1 border-b border-slate-800 bg-slate-950/40 px-5 py-2 font-mono text-[11px] text-slate-400">
            {data.status && <span>status · <span className="text-slate-200">{data.status}</span></span>}
            {data.domain && <span>domain · <span className="text-slate-200">{data.domain}</span></span>}
            <span>agentes · <span className="text-slate-200">{data.agents.length}</span></span>
            <span>sesiones · <span className="text-slate-200">{data.sessions}</span></span>
            <span>duración · <span className="text-slate-200">{fmtDur(data.total_duration_s)}</span></span>
            <span>archivos · <span className="text-slate-200">{data.files_touched.length}</span></span>
          </div>
        )}

        <div className="overflow-y-auto px-5 py-4">
          {error ? (
            <p className="text-xs text-rose-300">No disponible: {error}</p>
          ) : !data ? (
            <div className="h-40 animate-pulse rounded bg-slate-800/50" />
          ) : data.steps.length === 0 ? (
            <p className="py-6 text-center text-[12px] text-slate-500">
              Sin delegaciones registradas para esta tarea.
            </p>
          ) : (
            <ol className="relative ml-2 border-l border-slate-800">
              {data.steps.map((s, i) => (
                <Step key={i} step={s} last={i === data.steps.length - 1} />
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}

function Step({ step, last }: { step: TimelineStep; last: boolean }) {
  const k = KIND[step.kind] ?? KIND.agent;
  const Icon = k.Icon;
  return (
    <li className="relative mb-4 pl-6 last:mb-0">
      <span
        className="absolute -left-[9px] flex h-4 w-4 items-center justify-center rounded-full ring-4 ring-slate-900"
        style={{ background: k.color }}
      >
        <Icon className="h-2.5 w-2.5 text-slate-900" />
      </span>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-semibold text-slate-100">
          {step.label}
          {step.kind === 'agent' && step.declared === false && (
            <span className="ml-1.5 rounded bg-slate-800 px-1 py-0.5 text-[9px] font-normal text-slate-500">built-in</span>
          )}
        </span>
        <span className="shrink-0 font-mono text-[10.5px] text-slate-500">
          {fmtClock(step.at)}
          {!last && step.duration_s != null && step.duration_s > 0 && (
            <span className="ml-1 text-slate-600">· +{fmtDur(step.duration_s)}</span>
          )}
        </span>
      </div>
      {step.description && (
        <p className="mt-0.5 text-[11.5px] leading-snug text-slate-400">{step.description}</p>
      )}
      {step.kind === 'agent' && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5 font-mono text-[10px]">
          <span className={step.result_chars ? 'text-emerald-400/80' : 'text-amber-400/70'}>
            {step.result_chars ? `✓ ${step.result_chars}c resultado` : '⚠ sin resultado'}
          </span>
          {step.provider && <span className="text-slate-600">· {step.provider}</span>}
          {(step.tools?.length ?? 0) > 0 && <span className="text-slate-500">· {step.tools!.length} tools</span>}
          {(step.files?.length ?? 0) > 0 && <span className="text-slate-500">· {step.files!.length} files</span>}
        </div>
      )}
    </li>
  );
}
