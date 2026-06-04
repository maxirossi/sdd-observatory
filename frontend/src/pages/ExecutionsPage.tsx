import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ExecutionsList } from '../components/ExecutionsList';
import { PageHeader } from '../components/PageHeader';
import { api, type ExecutionRead } from '../lib/api';

const STATUS_FILTERS = [
  { value: '', label: 'todas' },
  { value: 'delegated', label: 'delegó' },
  { value: 'inline', label: 'inline' },
  { value: 'read_only', label: 'solo lectura' },
];

export function ExecutionsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [execs, setExecs] = useState<ExecutionRead[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setExecs(null);
    api
      .projectExecutions(projectId, 200)
      .then((e) => !cancelled && setExecs(e))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const filtered = useMemo(() => {
    if (!execs) return [];
    const q = query.trim().toLowerCase();
    return execs.filter((e) => {
      if (status && e.status !== status) return false;
      if (q) {
        const hay = `${e.task_ref ?? ''} ${e.label ?? ''} ${e.delegated_agents.join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [execs, status, query]);

  const delegatedCount = execs?.filter((e) => e.status === 'delegated').length ?? 0;

  return (
    <div>
      <PageHeader
        title="Executions"
        subtitle="Ejecuciones (turnos) de todas las sesiones — 1 turno = 1 ejecución, por tarea."
      />
      <div className="space-y-4 p-6">
        {error && <p className="text-[13px] text-rose-300">Error: {error}</p>}

        <div className="flex flex-wrap items-center gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filtrar por tarea, prompt o agente…"
            className="w-72 rounded-md border border-slate-700/70 bg-slate-900 px-3 py-1.5 text-[13px] text-slate-100 focus:border-cyan-500 focus:outline-none"
          />
          <div className="flex gap-1">
            {STATUS_FILTERS.map((s) => (
              <button
                key={s.value}
                type="button"
                onClick={() => setStatus(s.value)}
                className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
                  status === s.value
                    ? 'bg-cyan-500/20 text-cyan-200'
                    : 'bg-slate-800/60 text-slate-400 hover:bg-slate-800'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
          {execs && (
            <span className="ml-auto font-mono text-[11px] text-slate-500">
              {filtered.length}/{execs.length} ejecuciones · {delegatedCount} con delegación
            </span>
          )}
        </div>

        <div className="card-elev overflow-hidden">
          {!execs ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="h-8 animate-pulse rounded bg-slate-800" />
              ))}
            </div>
          ) : (
            <ExecutionsList items={filtered} showSession />
          )}
        </div>
      </div>
    </div>
  );
}
