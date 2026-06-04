import { useEffect, useMemo, useState } from 'react';
import { api, type AgentGraph } from '../lib/api';

interface Props {
  projectId: string;
}

export function AgentGraphPanel({ projectId }: Props) {
  const [data, setData] = useState<AgentGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    setFocus(null);
    api
      .agentGraph(projectId)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Top-N nodos por sesiones, top edges del nodo focal o globales.
  const view = useMemo(() => {
    if (!data) return null;
    const nameById = new Map(data.nodes.map((n) => [n.id, n.name]));
    const focalEdges = focus
      ? data.edges.filter((e) => e.source === focus || e.target === focus)
      : data.edges.slice(0, 15);
    return { nameById, focalEdges };
  }, [data, focus]);

  if (error) {
    return (
      <Card>
        <p className="px-4 py-3 text-xs text-rose-300">No se pudo cargar el grafo: {error}</p>
      </Card>
    );
  }
  if (!data || !view) {
    return (
      <Card>
        <div className="space-y-2 p-4">
          <div className="h-4 w-1/2 animate-pulse rounded bg-slate-800" />
          <div className="h-32 animate-pulse rounded bg-slate-800" />
        </div>
      </Card>
    );
  }

  const ranked = [...data.nodes].sort((a, b) => b.sessions - a.sessions);
  const maxSessions = ranked.length > 0 ? ranked[0].sessions : 1;

  return (
    <Card>
      <header className="flex items-baseline justify-between border-b border-slate-800 px-4 py-2">
        <div>
          <p className="flex items-center gap-2 text-[12px] font-semibold text-slate-200">
            Agent Relationship Graph
            <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[8.5px] font-medium uppercase tracking-wider text-slate-400">
              todo el proyecto
            </span>
          </p>
          <p className="text-[10px] text-slate-500">
            Co-delegación real (runSubagent/Agent): par conectado si compartieron sesión —
            acumulado del proyecto, no de la sesión seleccionada.
          </p>
        </div>
        <p className="text-[11px] text-slate-500">
          {data.nodes.length} agents · {data.edges.length} conexiones
        </p>
      </header>

      {data.nodes.length === 0 && (
        <p className="px-4 py-6 text-center text-[12px] text-slate-500">
          Ningún agente fue delegado de verdad en este proyecto.
          <br />
          <span className="text-[10px] text-slate-600">
            (Las menciones por texto no cuentan como intervención.)
          </span>
        </p>
      )}

      {data.nodes.length > 0 && (
      <div className="grid gap-px bg-slate-800 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="bg-slate-900 p-3">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Agentes delegados · por sesiones distintas
          </p>
          <ul className="space-y-1">
            {ranked.slice(0, 15).map((n) => {
              const active = n.id === focus;
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => setFocus(active ? null : n.id)}
                    className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-[12px] transition-colors ${
                      active
                        ? 'bg-violet-500/20 text-violet-100'
                        : 'hover:bg-slate-800'
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate font-mono">{n.name}</span>
                      {n.declared === false && (
                        <span className="shrink-0 rounded bg-slate-800 px-1 text-[9px] text-slate-500">
                          ext
                        </span>
                      )}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="h-1.5 w-16 overflow-hidden rounded bg-slate-800">
                        <span
                          className="block h-full bg-violet-500/70"
                          style={{ width: `${(n.sessions / maxSessions) * 100}%` }}
                        />
                      </span>
                      <span className="w-6 text-right font-mono text-[10px] text-slate-400">
                        {n.sessions}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="bg-slate-900 p-3">
          <p className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            {focus
              ? `Conexiones de ${view.nameById.get(focus)}`
              : 'Top conexiones globales'}
            {focus && (
              <button
                type="button"
                onClick={() => setFocus(null)}
                className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] font-normal normal-case tracking-normal text-slate-400 hover:bg-slate-800"
              >
                limpiar
              </button>
            )}
          </p>
          {view.focalEdges.length === 0 ? (
            <p className="text-[11px] text-slate-500">— Sin co-delegaciones.</p>
          ) : (
            <ul className="space-y-1">
              {view.focalEdges.slice(0, 20).map((e, i) => {
                const aName = view.nameById.get(e.source) ?? e.source;
                const bName = view.nameById.get(e.target) ?? e.target;
                return (
                  <li
                    key={`${e.source}-${e.target}-${i}`}
                    className="flex items-center justify-between gap-2 px-2 py-1 text-[12px]"
                  >
                    <span className="truncate font-mono text-slate-200">
                      {aName} <span className="text-slate-600">↔</span> {bName}
                    </span>
                    <span className="font-mono text-[11px] text-slate-400">
                      {e.sessions} {e.sessions === 1 ? 'sesión' : 'sesiones'}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
      )}
    </Card>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900">{children}</div>
  );
}
