import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { History } from 'lucide-react';
import { AutoRunPanel } from '../components/AutoRunPanel';
import { EntityDrawer, type EntityTarget } from '../components/EntityDrawer';
import { PageHeader } from '../components/PageHeader';
import { RawFileModal } from '../components/RawFileModal';
import { TaskTimelineModal } from '../components/TaskTimelineModal';
import { api, type SddTaskRead, type TaskFlow } from '../lib/api';

const STATUS_STYLE: Record<string, string> = {
  done: 'bg-emerald-500/15 text-emerald-300',
  in_progress: 'bg-amber-500/15 text-amber-300',
  pending: 'bg-slate-500/15 text-slate-300',
  unknown: 'bg-slate-700 text-slate-400',
};

const DOMAIN_DOT: Record<string, string> = {
  backend: 'bg-emerald-400',
  frontend: 'bg-cyan-400',
  wrapper: 'bg-violet-400',
  devops: 'bg-amber-400',
  security: 'bg-rose-400',
  e2e: 'bg-pink-400',
  api: 'bg-sky-400',
  docs: 'bg-slate-400',
  unknown: 'bg-slate-600',
};

export function TasksPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [tasks, setTasks] = useState<SddTaskRead[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filterCycle, setFilterCycle] = useState<string>('');
  const [filterDomain, setFilterDomain] = useState<string>('');
  const [filterStatus, setFilterStatus] = useState<string>('');
  const [query, setQuery] = useState('');
  const [entity, setEntity] = useState<EntityTarget | null>(null);
  const [modalPath, setModalPath] = useState<string | null>(null);
  const [timelineRef, setTimelineRef] = useState<string | null>(null);
  const [flows, setFlows] = useState<TaskFlow[]>([]);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setTasks(null);
    api
      .tasks(projectId)
      .then((t) => !cancelled && setTasks(t))
      .catch((e) => !cancelled && setError(e.message));
    api
      .taskFlows(projectId)
      .then((d) => !cancelled && setFlows(d.flows))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // task_code (upper) → flow real de delegación.
  const flowByCode = useMemo(() => {
    const m = new Map<string, TaskFlow>();
    for (const f of flows) if (f.task_ref) m.set(f.task_ref.toUpperCase(), f);
    return m;
  }, [flows]);

  const cycles = useMemo(
    () => Array.from(new Set((tasks ?? []).map((t) => t.cycle).filter(Boolean) as string[])).sort(),
    [tasks],
  );
  const domains = useMemo(
    () =>
      Array.from(
        new Set((tasks ?? []).map((t) => t.domain ?? null).filter(Boolean) as string[]),
      ).sort(),
    [tasks],
  );

  const filtered = useMemo(() => {
    if (!tasks) return [];
    const q = query.trim().toLowerCase();
    return tasks.filter((t) => {
      if (filterCycle && t.cycle !== filterCycle) return false;
      if (filterStatus && (t.status ?? 'unknown') !== filterStatus) return false;
      if (filterDomain && (t.domain ?? 'unknown') !== filterDomain) return false;
      if (q) {
        const hay = `${t.task_code ?? ''} ${t.title}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [tasks, filterCycle, filterDomain, filterStatus, query]);

  if (!projectId) return null;

  return (
    <div>
      <PageHeader
        title="Tasks"
        subtitle={tasks ? `${filtered.length} / ${tasks.length} tasks` : 'Cargando…'}
      />

      <div className="space-y-4 p-6">
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 card-elev p-3">
          <input
            type="text"
            placeholder="Buscar por código o título…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="min-w-[280px] flex-1 rounded-md border border-slate-700/80 bg-slate-950 px-3 py-2 text-[13.5px] text-slate-100 placeholder-slate-600 focus:border-cyan-500 focus:outline-none"
          />
          <Pill
            options={[{ value: '', label: 'todos los ciclos' }, ...cycles.map((c) => ({ value: c, label: c }))]}
            value={filterCycle}
            onChange={setFilterCycle}
          />
          <Pill
            options={[{ value: '', label: 'todos los dominios' }, ...domains.map((d) => ({ value: d, label: d }))]}
            value={filterDomain}
            onChange={setFilterDomain}
          />
          <Pill
            options={[
              { value: '', label: 'todos los estados' },
              { value: 'done', label: 'done' },
              { value: 'in_progress', label: 'in_progress' },
              { value: 'pending', label: 'pending' },
              { value: 'unknown', label: 'unknown' },
            ]}
            value={filterStatus}
            onChange={setFilterStatus}
          />
        </div>

        <AutoRunPanel projectId={projectId} />

        {error && <p className="text-[12px] text-rose-300">No se pudieron cargar tasks: {error}</p>}
        {!tasks && !error && (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-10 animate-pulse rounded bg-slate-900" />
            ))}
          </div>
        )}

        {tasks && (
          <div className="card-elev overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead className="bg-slate-950/60 text-left">
                  <tr>
                    <th className="px-4 py-3 label-track text-slate-500">Código</th>
                    <th className="px-4 py-3 label-track text-slate-500">Título</th>
                    <th className="px-4 py-3 label-track text-slate-500">Ciclo</th>
                    <th className="px-4 py-3 label-track text-slate-500">Dominio</th>
                    <th className="px-4 py-3 label-track text-slate-500">Estado</th>
                    <th className="px-4 py-3 label-track text-slate-500">Flow (agentes)</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((t) => {
                    const domain = t.domain ?? 'unknown';
                    const status = t.status ?? 'unknown';
                    const flow = t.task_code ? flowByCode.get(t.task_code.toUpperCase()) : undefined;
                    return (
                      <tr
                        key={t.id}
                        onClick={() => setEntity({ kind: 'task', taskId: t.id })}
                        className="cursor-pointer border-t border-slate-800/60 transition-colors hover:bg-slate-800/30"
                      >
                        <td className="px-4 py-2.5 font-mono text-[12.5px] text-slate-300">
                          {t.task_code ?? '—'}
                        </td>
                        <td className="max-w-[460px] truncate px-4 py-2.5 text-slate-100" title={t.title}>
                          {t.title}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-[11.5px] text-slate-500">
                          {t.cycle ?? '—'}
                        </td>
                        <td className="px-4 py-2.5">
                          <span className="flex items-center gap-2 text-[12px] text-slate-300">
                            <span className={`h-2 w-2 rounded-full ${DOMAIN_DOT[domain] ?? 'bg-slate-600'}`} />
                            {domain}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className={`rounded-md px-2 py-0.5 font-mono text-[11px] font-semibold ${STATUS_STYLE[status] ?? STATUS_STYLE.unknown}`}>
                            {status}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          {flow ? (
                            <div className="flex flex-wrap items-center gap-1">
                              {flow.agents.map((a) => (
                                <span
                                  key={a.agent_name}
                                  title={`${a.invocations} delegación(es), ${a.with_result} con resultado${a.domain_mismatch ? ` · dominio esperado: ${a.expected_domain}` : ''}`}
                                  className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                                    a.domain_mismatch
                                      ? 'bg-rose-500/10 text-rose-200 ring-1 ring-rose-500/30'
                                      : 'bg-slate-800/70 text-slate-300'
                                  }`}
                                >
                                  {a.agent_name}
                                  {a.invocations > 1 && <span className="text-slate-500"> ×{a.invocations}</span>}
                                </span>
                              ))}
                              {flow.warnings.includes('few_agents') && (
                                <span
                                  title="Menos de 2 agentes — flujo incompleto (esperado: impl + test)"
                                  className="rounded border border-amber-500/40 bg-amber-500/15 px-1 py-0.5 font-mono text-[9px] font-semibold text-amber-200"
                                >
                                  ⚠ &lt;2
                                </span>
                              )}
                              {t.task_code && (
                                <button
                                  title="Ver Task Replay (timeline)"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setTimelineRef(t.task_code!.toUpperCase());
                                  }}
                                  className="flex items-center gap-1 rounded bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[10px] text-cyan-300 ring-1 ring-cyan-600/30 hover:bg-cyan-500/20"
                                >
                                  <History className="h-2.5 w-2.5" /> replay
                                </button>
                              )}
                            </div>
                          ) : (
                            <span className="font-mono text-[10px] text-slate-600">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-12 text-center text-[13px] text-slate-500">
                        Sin tasks con esos filtros.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {entity && (
        <EntityDrawer
          projectId={projectId}
          target={entity}
          onClose={() => setEntity(null)}
          onOpenFile={setModalPath}
          onOpenEntity={setEntity}
        />
      )}
      {modalPath && (
        <RawFileModal
          projectId={projectId}
          path={modalPath}
          onClose={() => setModalPath(null)}
        />
      )}
      {timelineRef && (
        <TaskTimelineModal
          projectId={projectId}
          taskRef={timelineRef}
          onClose={() => setTimelineRef(null)}
        />
      )}
    </div>
  );
}

function Pill({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded border border-slate-800 bg-slate-950 px-2 py-1.5 text-[11px] text-slate-200 focus:border-slate-600 focus:outline-none"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
