import { useEffect, useState } from 'react';
import { api, type Finding } from '../lib/api';

interface Props {
  projectId: string;
}

const SEVERITY_STYLES: Record<Finding['severity'], { dot: string; label: string }> = {
  info: { dot: 'bg-slate-500', label: 'text-slate-400' },
  warning: { dot: 'bg-amber-500', label: 'text-amber-400' },
  danger: { dot: 'bg-rose-500', label: 'text-rose-400' },
};

export function FindingsPanel({ projectId }: Props) {
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFindings(null);
    setError(null);
    api
      .findings(projectId)
      .then((data) => !cancelled && setFindings(data))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return (
    <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
      <header className="border-b border-slate-800 px-4 py-2">
        <p className="text-[12px] font-semibold text-slate-200">Findings</p>
        <p className="text-[10px] text-slate-500">
          Reglas heurísticas sobre el cruce de agentes, docs, tasks y runtime.
        </p>
      </header>

      {error && <p className="px-4 py-3 text-xs text-rose-300">No se pudo cargar: {error}</p>}
      {!error && findings == null && <Skeleton />}
      {!error && findings != null && (
        <ul className="divide-y divide-slate-800">
          {findings.map((f) => {
            const style = SEVERITY_STYLES[f.severity];
            const isOpen = expanded === f.id;
            return (
              <li key={f.id}>
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : f.id)}
                  className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-slate-800/40"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className={`size-2 shrink-0 rounded-full ${style.dot}`} aria-hidden />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-100">{f.title}</p>
                      <p className="truncate text-[11px] text-slate-500">{f.description}</p>
                    </div>
                  </div>
                  <span className={`shrink-0 font-mono text-[12px] tabular-nums ${style.label}`}>
                    {f.count}
                  </span>
                </button>
                {isOpen && f.items.length > 0 && (
                  <ul className="border-t border-slate-800 bg-slate-950 px-6 py-2">
                    {f.items.map((it, idx) => (
                      <li
                        key={it.ref_id ?? `${f.id}-${idx}`}
                        className="grid grid-cols-[1fr_auto] gap-3 py-1 text-[12px]"
                      >
                        <span className="truncate text-slate-100" title={it.label}>
                          {it.label}
                        </span>
                        {it.detail && (
                          <span className="truncate font-mono text-[10px] text-slate-500" title={it.detail}>
                            {it.detail}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {isOpen && f.items.length === 0 && (
                  <p className="border-t border-slate-800 bg-slate-950 px-6 py-2 text-[11px] text-slate-500">
                    Sin items.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-2 p-4">
      <div className="h-4 w-2/3 animate-pulse rounded bg-slate-800" />
      <div className="h-4 w-1/2 animate-pulse rounded bg-slate-800" />
      <div className="h-4 w-3/4 animate-pulse rounded bg-slate-800" />
    </div>
  );
}
