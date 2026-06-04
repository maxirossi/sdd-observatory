import { useEffect, useState } from 'react';
import { api, type InvokedAgent } from '../lib/api';
import { EntityDrawer, type EntityTarget } from './EntityDrawer';

interface Props {
  projectId: string;
}

const PROVIDER_CHIP: Record<string, string> = {
  claude: 'bg-violet-500/15 text-violet-200 border-violet-500/30',
  copilot: 'bg-emerald-500/15 text-emerald-200 border-emerald-500/30',
  cursor: 'bg-amber-500/15 text-amber-200 border-amber-500/30',
};

export function TopAgentsPanel({ projectId }: Props) {
  const [agents, setAgents] = useState<InvokedAgent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entity, setEntity] = useState<EntityTarget | null>(null);

  useEffect(() => {
    let cancelled = false;
    setAgents(null);
    setError(null);
    api
      .runtimeInvokedAgents(projectId, 20)
      .then((a) => !cancelled && setAgents(a))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (error) {
    return (
      <div className="card-elev px-5 py-3 text-[13px] text-rose-300">
        No se pudo cargar agentes intervinientes: {error}
      </div>
    );
  }

  const maxInv = agents && agents.length > 0 ? agents[0].invocations : 1;

  return (
    <div className="card-elev overflow-hidden">
      <header className="flex items-baseline justify-between border-b border-slate-800/80 px-5 py-3">
        <div>
          <p className="flex items-center gap-2 text-[14px] font-semibold tracking-tight text-slate-100">
            Agentes que intervinieron
            <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-slate-400">
              todo el proyecto
            </span>
          </p>
          <p className="text-[12px] text-slate-500">
            Acumulado de TODAS las sesiones (no de la seleccionada) · delegaciones reales
            runSubagent/Agent, no menciones de texto.
          </p>
        </div>
        {agents && (
          <p className="text-[12px] text-slate-500">{agents.length} agentes delegados</p>
        )}
      </header>

      {!agents ? (
        <div className="space-y-2 p-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-7 animate-pulse rounded bg-slate-800" />
          ))}
        </div>
      ) : agents.length === 0 ? (
        <p className="px-5 py-4 text-[13px] text-slate-500">
          Sin delegaciones de agentes todavía. El orchestrator no invocó sub-agentes vía
          runSubagent en las sesiones capturadas.
        </p>
      ) : (
        <ul className="divide-y divide-slate-800/50">
          {agents.map((a, i) => {
            const clickable = a.declared && a.agent_id;
            return (
              <li key={`${a.agent_name}-${i}`}>
                <button
                  type="button"
                  disabled={!clickable}
                  onClick={() =>
                    clickable && setEntity({ kind: 'agent', agentId: a.agent_id as string })
                  }
                  className={`group flex w-full items-center gap-3 px-5 py-2.5 text-left transition-colors ${
                    clickable ? 'hover:bg-slate-800/30' : 'cursor-default'
                  }`}
                >
                  <span className="w-5 shrink-0 text-right font-mono text-[11px] text-slate-600">
                    {i + 1}
                  </span>
                  <span className="flex w-52 shrink-0 items-center gap-1.5">
                    <span
                      className={`truncate text-[13px] ${
                        clickable
                          ? 'text-slate-100 group-hover:text-cyan-300'
                          : 'text-slate-300'
                      }`}
                    >
                      {a.agent_name}
                    </span>
                    {!a.declared && (
                      <span
                        title="No es un agente declarado del repo"
                        className="shrink-0 rounded border border-slate-700 bg-slate-800/60 px-1 py-0.5 font-mono text-[8.5px] uppercase text-slate-500"
                      >
                        no-decl
                      </span>
                    )}
                  </span>
                  {/* Barra de invocaciones */}
                  <span className="flex h-2 flex-1 overflow-hidden rounded-full bg-slate-800/80">
                    <span
                      className="progress-fill rounded-full"
                      style={{
                        width: `${(a.invocations / maxInv) * 100}%`,
                        background: 'linear-gradient(90deg,#a78bfa,#22d3ee)',
                        boxShadow: '0 0 8px rgba(167,139,250,0.25)',
                      }}
                    />
                  </span>
                  <span className="w-12 shrink-0 text-right font-mono text-[12px] tabular text-slate-200">
                    {a.invocations}
                  </span>
                  <span className="w-20 shrink-0 text-right font-mono text-[11px] text-slate-500">
                    {a.sessions} ses
                  </span>
                  <span className="flex w-28 shrink-0 justify-end gap-1">
                    {a.providers.map((p) => (
                      <span
                        key={p}
                        className={`rounded border px-1.5 py-0.5 font-mono text-[9px] font-semibold ${
                          PROVIDER_CHIP[p] ?? 'bg-slate-800 text-slate-400 border-slate-700'
                        }`}
                      >
                        {p}
                      </span>
                    ))}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {entity && (
        <EntityDrawer
          projectId={projectId}
          target={entity}
          onClose={() => setEntity(null)}
          onOpenFile={() => {}}
          onOpenEntity={setEntity}
        />
      )}
    </div>
  );
}
