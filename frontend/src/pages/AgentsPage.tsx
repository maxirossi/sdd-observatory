import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { EntityDrawer, type EntityTarget } from '../components/EntityDrawer';
import { PageHeader } from '../components/PageHeader';
import { RawFileModal } from '../components/RawFileModal';
import { api, type AgentRead } from '../lib/api';

const STATUS_STYLE: Record<AgentRead['status'], { label: string; cls: string }> = {
  active: { label: 'active', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  runtime_only: { label: 'runtime', cls: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30' },
  declared_only: { label: 'declarado', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  inactive: { label: 'inactivo', cls: 'bg-slate-700 text-slate-400 border-slate-600' },
};

const PROVIDER_CHIP: Record<string, string> = {
  claude: 'bg-violet-500/15 text-violet-200',
  copilot: 'bg-emerald-500/15 text-emerald-200',
};

type SortKey = 'runtime' | 'docs' | 'sessions' | 'name';

export function AgentsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [agents, setAgents] = useState<AgentRead[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('runtime');
  const [entity, setEntity] = useState<EntityTarget | null>(null);
  const [modalPath, setModalPath] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setAgents(null);
    api
      .agents(projectId)
      .then((a) => !cancelled && setAgents(a))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const filtered = useMemo(() => {
    if (!agents) return [];
    const q = query.trim().toLowerCase();
    let list = agents;
    if (q) {
      list = agents.filter((a) =>
        `${a.name} ${a.type} ${a.description ?? ''} ${a.tags.join(' ')}`.toLowerCase().includes(q),
      );
    }
    const sorted = [...list];
    sorted.sort((a, b) => {
      switch (sort) {
        case 'docs':
          return b.doc_mentions - a.doc_mentions;
        case 'sessions':
          return b.sessions - a.sessions;
        case 'name':
          return a.name.localeCompare(b.name);
        default:
          return b.runtime_mentions - a.runtime_mentions;
      }
    });
    return sorted;
  }, [agents, query, sort]);

  const totals = useMemo(() => {
    if (!agents) return null;
    return {
      active: agents.filter((a) => a.status === 'active').length,
      declared: agents.filter((a) => a.status === 'declared_only').length,
      inactive: agents.filter((a) => a.status === 'inactive').length,
      runtime: agents.reduce((acc, a) => acc + a.runtime_mentions, 0),
    };
  }, [agents]);

  const maxRuntime = filtered.length > 0 ? Math.max(...filtered.map((a) => a.runtime_mentions), 1) : 1;

  if (!projectId) return null;

  return (
    <div>
      <PageHeader
        title="Agents"
        subtitle={
          totals
            ? `${agents!.length} agents · ${totals.active} activos · ${totals.declared} solo declarados · ${totals.runtime.toLocaleString()} menciones runtime`
            : 'Cargando…'
        }
      />

      <div className="space-y-4 p-6">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            placeholder="Buscar por nombre, tipo o tag…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="min-w-[260px] flex-1 rounded-xl border border-slate-700/80 bg-slate-900 px-4 py-2.5 text-[14px] text-slate-100 placeholder-slate-600 focus:border-cyan-500 focus:outline-none"
          />
          <div className="flex rounded-lg border border-slate-800 bg-slate-900 p-0.5 text-[12px]">
            {(['runtime', 'docs', 'sessions', 'name'] as SortKey[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setSort(k)}
                className={`rounded-md px-3 py-1.5 font-medium transition-colors ${
                  sort === k ? 'bg-slate-800 text-cyan-300' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {k === 'runtime' ? 'Uso runtime' : k === 'docs' ? 'Docs' : k === 'sessions' ? 'Sesiones' : 'A–Z'}
              </button>
            ))}
          </div>
        </div>

        {error && <p className="text-[13px] text-rose-300">{error}</p>}
        {!agents && !error && <SkelGrid />}
        {agents && filtered.length === 0 && (
          <p className="text-[13px] text-slate-500">Sin agents con ese criterio.</p>
        )}

        {agents && filtered.length > 0 && (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map((a, i) => (
              <AgentCard
                key={a.id}
                a={a}
                rank={sort === 'runtime' ? i + 1 : undefined}
                maxRuntime={maxRuntime}
                onOpen={() => setEntity({ kind: 'agent', agentId: a.id })}
              />
            ))}
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
        <RawFileModal projectId={projectId} path={modalPath} onClose={() => setModalPath(null)} />
      )}
    </div>
  );
}

function AgentCard({
  a,
  rank,
  maxRuntime,
  onOpen,
}: {
  a: AgentRead;
  rank?: number;
  maxRuntime: number;
  onOpen: () => void;
}) {
  const status = STATUS_STYLE[a.status];
  const isLive = a.runtime_mentions > 50;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="card-elev card-elev-hover group flex flex-col p-4 text-left"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {rank && (
            <span className="font-mono text-[11px] text-slate-600">#{rank}</span>
          )}
          {isLive && <span className="pulse-dot bg-emerald-400" />}
          <span className="truncate text-[14px] font-semibold text-slate-50 group-hover:text-cyan-300">
            {a.name}
          </span>
        </div>
        <span className={`shrink-0 rounded-md border px-1.5 py-0.5 font-mono text-[9.5px] font-semibold ${status.cls}`}>
          {status.label}
        </span>
      </div>

      <p className="mt-0.5 font-mono text-[10px] text-slate-500">{a.type}</p>

      {/* Stat row con barra de runtime */}
      <div className="mt-3">
        <div className="flex items-baseline justify-between text-[11px]">
          <span className="text-slate-500">Uso runtime</span>
          <span className="font-mono tabular text-cyan-300">{a.runtime_mentions}</span>
        </div>
        <div className="mt-1 flex h-1.5 overflow-hidden rounded-full bg-slate-800">
          <span
            className="progress-fill rounded-full"
            style={{
              width: `${(a.runtime_mentions / maxRuntime) * 100}%`,
              background: 'linear-gradient(90deg,#22d3ee,#34d399)',
            }}
          />
        </div>
      </div>

      {/* Metrics */}
      <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
        <Metric label="Docs" value={a.doc_mentions} />
        <Metric label="Sesiones" value={a.sessions} />
        <Metric label="Total" value={a.mentions_count} />
      </div>

      {/* Providers */}
      {a.providers.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {a.providers.map((p) => (
            <span
              key={p}
              className={`rounded px-1.5 py-0.5 font-mono text-[9.5px] font-semibold ${
                PROVIDER_CHIP[p] ?? 'bg-slate-800 text-slate-400'
              }`}
            >
              {p}
            </span>
          ))}
        </div>
      )}

      {a.description && (
        <p className="mt-3 line-clamp-2 border-t border-slate-800/60 pt-2.5 text-[11.5px] text-slate-400">
          {a.description}
        </p>
      )}
    </button>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-slate-950/50 px-2 py-1.5">
      <p className="text-[9px] uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-0.5 font-mono text-[14px] font-bold tabular text-slate-100">{value}</p>
    </div>
  );
}

function SkelGrid() {
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="card-elev h-44 animate-pulse" />
      ))}
    </div>
  );
}
