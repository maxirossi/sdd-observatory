import { useEffect, useState } from 'react';
import { api, type TaskFlow, type TaskFlowsResponse } from '../lib/api';

interface Props {
  projectId: string;
}

const DOMAIN_CHIP: Record<string, string> = {
  frontend: 'bg-sky-500/15 text-sky-200 border-sky-500/30',
  backend: 'bg-emerald-500/15 text-emerald-200 border-emerald-500/30',
  wrapper: 'bg-violet-500/15 text-violet-200 border-violet-500/30',
  devops: 'bg-amber-500/15 text-amber-200 border-amber-500/30',
  security: 'bg-rose-500/15 text-rose-200 border-rose-500/30',
  e2e: 'bg-pink-500/15 text-pink-200 border-pink-500/30',
};

function agentTone(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('tdd') || n.includes('test') || n.includes('e2e')) return 'text-pink-300';
  if (n.includes('frontend')) return 'text-sky-300';
  if (n.includes('backend') || n.includes('satellite')) return 'text-emerald-300';
  if (n.includes('devops') || n.includes('observability')) return 'text-amber-300';
  if (n.includes('orchestrator') || n.includes('architect') || n.includes('speckit'))
    return 'text-violet-300';
  return 'text-slate-300';
}

function WarnBadges({ warnings }: { warnings: string[] }) {
  return (
    <>
      {warnings.map((w) => {
        if (w === 'few_agents')
          return (
            <span
              key={w}
              title="Menos de 2 agentes intervinieron — flujo incompleto (esperado: impl + test)"
              className="rounded border border-amber-500/40 bg-amber-500/15 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-amber-200"
            >
              ⚠ &lt;2 agentes
            </span>
          );
        if (w === 'no_result')
          return (
            <span
              key={w}
              title="Ningún agente devolvió resultado (delegó pero retornó vacío)"
              className="rounded border border-slate-600 bg-slate-700/40 px-1.5 py-0.5 font-mono text-[9px] text-slate-300"
            >
              sin result
            </span>
          );
        if (w.startsWith('domain_mismatch:'))
          return (
            <span
              key={w}
              title={`Agente de otro dominio intervino: ${w.split(':')[1]}`}
              className="rounded border border-rose-500/40 bg-rose-500/15 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-rose-200"
            >
              ⚠ dominio: {w.split(':')[1]}
            </span>
          );
        return null;
      })}
    </>
  );
}

function FlowRow({ f }: { f: TaskFlow }) {
  const hasWarn = f.warnings.length > 0;
  return (
    <li
      className={`flex flex-col gap-1.5 px-4 py-2.5 ${hasWarn ? 'bg-amber-500/[0.03]' : ''}`}
    >
      <div className="flex items-center gap-2">
        <span className="w-24 shrink-0 font-mono text-[12px] font-semibold text-slate-100">
          {f.task_ref}
        </span>
        {f.domain && (
          <span
            className={`rounded border px-1.5 py-0.5 font-mono text-[9px] ${
              DOMAIN_CHIP[f.domain] ?? 'bg-slate-800 text-slate-400 border-slate-700'
            }`}
          >
            {f.domain}
          </span>
        )}
        {f.status && (
          <span className="font-mono text-[10px] text-slate-500">{f.status}</span>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-1">
          <WarnBadges warnings={f.warnings} />
        </span>
      </div>
      {f.title && (
        <p className="truncate pl-1 text-[11px] text-slate-500" title={f.title}>
          {f.title.replace(/`/g, '')}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5 pl-1">
        {f.agents.map((a) => (
          <span
            key={a.agent_name}
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] ${
              a.domain_mismatch ? 'bg-rose-500/10 ring-1 ring-rose-500/30' : 'bg-slate-800/60'
            }`}
            title={`${a.invocations} delegación(es), ${a.with_result} con resultado${
              a.domain_mismatch ? ` · dominio esperado: ${a.expected_domain}` : ''
            }${a.declared ? '' : ' · no declarado'}`}
          >
            <span className={agentTone(a.agent_name)}>{a.agent_name}</span>
            <span className="text-slate-500">
              ×{a.invocations}
              {a.with_result < a.invocations && (
                <span className="text-amber-400/80"> ({a.with_result}✓)</span>
              )}
            </span>
          </span>
        ))}
        <span className="ml-1 font-mono text-[9px] text-slate-600">
          {f.sessions} ses · {f.total_invocations} deleg
        </span>
      </div>
    </li>
  );
}

export function TaskFlowsPanel({ projectId }: Props) {
  const [data, setData] = useState<TaskFlowsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    api
      .taskFlows(projectId)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (error)
    return (
      <div className="card-elev px-5 py-3 text-[13px] text-rose-300">
        No se pudo cargar task-flows: {error}
      </div>
    );

  const warned = data?.flows.filter((f) => f.warnings.length > 0).length ?? 0;

  return (
    <div className="card-elev overflow-hidden">
      <header className="flex items-baseline justify-between border-b border-slate-800/80 px-5 py-3">
        <div>
          <p className="text-[14px] font-semibold tracking-tight text-slate-100">
            Flujo por tarea
          </p>
          <p className="text-[12px] text-slate-500">
            Agentes que intervinieron por tarea (delegación real) + patrones y anomalías.
          </p>
        </div>
        {data && (
          <p className="text-[12px] text-slate-500">
            {data.flows.length} tareas
            {warned > 0 && <span className="ml-2 text-amber-300">· {warned} con warning</span>}
          </p>
        )}
      </header>

      {!data ? (
        <div className="space-y-2 p-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-8 animate-pulse rounded bg-slate-800" />
          ))}
        </div>
      ) : data.flows.length === 0 ? (
        <p className="px-5 py-4 text-[13px] text-slate-500">
          Sin delegaciones reales atribuibles a tareas todavía.
        </p>
      ) : (
        <>
          {/* Patrones por dominio */}
          {data.patterns.length > 0 && (
            <div className="border-b border-slate-800/60 px-5 py-3">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Patrones por dominio
              </p>
              <div className="flex flex-wrap gap-4">
                {data.patterns.map((p) => (
                  <div key={p.domain} className="text-[11px]">
                    <span
                      className={`rounded border px-1.5 py-0.5 font-mono text-[9px] ${
                        DOMAIN_CHIP[p.domain] ?? 'bg-slate-800 text-slate-400 border-slate-700'
                      }`}
                    >
                      {p.domain}
                    </span>
                    <span className="ml-1.5 text-slate-500">{p.tasks} tareas:</span>{' '}
                    {p.typical_agents.map((t, i) => (
                      <span key={t.agent_name} className={agentTone(t.agent_name)}>
                        {i > 0 && <span className="text-slate-600">, </span>}
                        {t.agent_name}
                        <span className="text-slate-600"> {t.freq_pct}%</span>
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Flows por tarea */}
          <ul className="max-h-[460px] divide-y divide-slate-800/50 overflow-y-auto">
            {data.flows.map((f) => (
              <FlowRow key={f.task_ref} f={f} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
