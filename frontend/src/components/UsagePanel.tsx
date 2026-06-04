import { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api, type AgentUsageRow, type UsageRead } from '../lib/api';

interface Props {
  projectId: string;
  onOpenAgent?: (agentId: string) => void;
}

const PROVIDER_COLOR: Record<string, string> = {
  claude: '#a78bfa',
  copilot: '#34d399',
  cursor: '#fbbf24',
  openai: '#22d3ee',
};

function color(provider: string): string {
  return PROVIDER_COLOR[provider] ?? '#64748b';
}

export function UsagePanel({ projectId, onOpenAgent }: Props) {
  const [usage, setUsage] = useState<UsageRead | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setUsage(null);
    setError(null);
    api
      .usage(projectId, 30)
      .then((d) => !cancelled && setUsage(d))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const providerTotal = useMemo(
    () => (usage?.provider_share ?? []).reduce((acc, p) => acc + p.events, 0),
    [usage],
  );

  const topAgentChart = useMemo(
    () =>
      (usage?.top_agents ?? []).slice(0, 10).map((a) => ({
        name: a.name.replace('.agent', ''),
        runtime: a.runtime_mentions,
        doc: a.doc_mentions,
      })),
    [usage],
  );

  if (error) {
    return (
      <Card>
        <p className="px-4 py-3 text-xs text-rose-300">No se pudo cargar usage: {error}</p>
      </Card>
    );
  }

  if (!usage) {
    return (
      <Card>
        <div className="space-y-2 p-4">
          <div className="h-4 w-2/3 animate-pulse rounded bg-slate-800" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-slate-800" />
          <div className="h-4 w-3/4 animate-pulse rounded bg-slate-800" />
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <section className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Stat
          title="Agentes con uso runtime"
          value={`${usage.agents_with_runtime_mentions} / ${usage.agents_total}`}
          subtitle="referenciados en sesiones reales"
          tone="emerald"
        />
        <Stat
          title="Más usado (runtime)"
          value={usage.most_used_runtime?.name ?? '—'}
          subtitle={
            usage.most_used_runtime
              ? `${usage.most_used_runtime.runtime_mentions} menciones`
              : 'Sin menciones runtime aún'
          }
          tone="cyan"
          onClick={
            usage.most_used_runtime && onOpenAgent
              ? () => onOpenAgent(usage.most_used_runtime!.agent_id)
              : undefined
          }
        />
        <Stat
          title="Declarado sin uso"
          value={usage.least_used_declared?.name ?? '—'}
          subtitle={
            usage.least_used_declared
              ? `${usage.least_used_declared.doc_mentions} menciones doc · 0 runtime`
              : 'Todos los declarados se usan'
          }
          tone="amber"
          onClick={
            usage.least_used_declared && onOpenAgent
              ? () => onOpenAgent(usage.least_used_declared!.agent_id)
              : undefined
          }
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Card>
          <SectionHeader title="Top 10 agentes por uso (runtime vs declarado)" />
          <div className="h-64 w-full px-2 pb-2">
            {topAgentChart.length === 0 ? (
              <Empty body="Sin uso registrado todavía." />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={topAgentChart}
                  layout="vertical"
                  margin={{ top: 4, right: 16, left: 96, bottom: 0 }}
                >
                  <CartesianGrid stroke="#1e293b" strokeDasharray="2 4" />
                  <XAxis
                    type="number"
                    stroke="#475569"
                    tick={{ fontSize: 10, fill: '#94a3b8' }}
                    tickLine={false}
                    axisLine={false}
                    allowDecimals={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    stroke="#475569"
                    tick={{ fontSize: 10, fill: '#94a3b8' }}
                    tickLine={false}
                    axisLine={false}
                    width={92}
                  />
                  <Tooltip
                    contentStyle={{
                      background: '#0f172a',
                      border: '1px solid #1e293b',
                      fontSize: '11px',
                    }}
                    cursor={{ fill: 'rgba(148,163,184,0.08)' }}
                  />
                  <Bar dataKey="runtime" stackId="m" fill="#a78bfa" radius={[0, 0, 0, 0]} />
                  <Bar dataKey="doc" stackId="m" fill="#475569" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>

        <Card>
          <SectionHeader title="Share por provider (30d)" />
          <div className="h-64 w-full px-2 pb-2">
            {usage.provider_share.length === 0 ? (
              <Empty body="Sin eventos en los últimos 30 días." />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={usage.provider_share.map((p) => ({
                    provider: p.provider,
                    events: p.events,
                    fill: color(p.provider),
                  }))}
                  margin={{ top: 4, right: 12, left: -16, bottom: 0 }}
                >
                  <CartesianGrid stroke="#1e293b" strokeDasharray="2 4" />
                  <XAxis
                    dataKey="provider"
                    stroke="#475569"
                    tick={{ fontSize: 10, fill: '#94a3b8' }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    stroke="#475569"
                    tick={{ fontSize: 10, fill: '#94a3b8' }}
                    tickLine={false}
                    axisLine={false}
                    allowDecimals={false}
                  />
                  <Tooltip
                    contentStyle={{
                      background: '#0f172a',
                      border: '1px solid #1e293b',
                      fontSize: '11px',
                    }}
                    cursor={{ fill: 'rgba(148,163,184,0.08)' }}
                  />
                  <Bar dataKey="events" radius={[4, 4, 0, 0]}>
                    {usage.provider_share.map((p, i) => (
                      <Cell key={i} fill={color(p.provider)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>
      </section>

      <Card>
        <SectionHeader title={`Ranking completo (${usage.top_agents.length} agentes)`} />
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead className="text-left text-[10px] uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-3 py-2">Agente</th>
                <th className="px-3 py-2">Tipo</th>
                <th className="px-3 py-2 text-right">Runtime</th>
                <th className="px-3 py-2 text-right">Declarado</th>
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-3 py-2">Estado</th>
              </tr>
            </thead>
            <tbody>
              {usage.top_agents.map((row) => (
                <UsageRow key={row.agent_id} row={row} onOpenAgent={onOpenAgent} total={providerTotal} />
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function UsageRow({
  row,
  onOpenAgent,
}: {
  row: AgentUsageRow;
  onOpenAgent?: (id: string) => void;
  total: number;
}) {
  const status = row.declared_only
    ? { label: 'Declarado sin uso', cls: 'bg-amber-500/15 text-amber-300' }
    : row.runtime_mentions === 0 && row.doc_mentions === 0
      ? { label: 'Sin menciones', cls: 'bg-slate-500/15 text-slate-400' }
      : { label: 'En uso', cls: 'bg-emerald-500/15 text-emerald-300' };

  return (
    <tr className="border-t border-slate-800 hover:bg-slate-800/40">
      <td className="px-3 py-2">
        {onOpenAgent ? (
          <button
            type="button"
            onClick={() => onOpenAgent(row.agent_id)}
            className="text-left text-slate-100 hover:text-cyan-300"
          >
            {row.name}
          </button>
        ) : (
          <span className="text-slate-100">{row.name}</span>
        )}
      </td>
      <td className="px-3 py-2 font-mono text-[10px] text-slate-500">{row.type}</td>
      <td className="px-3 py-2 text-right tabular-nums text-violet-300">
        {row.runtime_mentions}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-slate-400">{row.doc_mentions}</td>
      <td className="px-3 py-2 text-right tabular-nums text-slate-100">{row.total_mentions}</td>
      <td className="px-3 py-2">
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-mono ${status.cls}`}>
          {status.label}
        </span>
      </td>
    </tr>
  );
}

function Stat({
  title,
  value,
  subtitle,
  tone,
  onClick,
}: {
  title: string;
  value: string;
  subtitle: string;
  tone: 'cyan' | 'amber' | 'emerald';
  onClick?: () => void;
}) {
  const accent =
    tone === 'cyan'
      ? 'text-cyan-300'
      : tone === 'amber'
        ? 'text-amber-300'
        : 'text-emerald-300';
  const interactive = onClick
    ? 'cursor-pointer hover:border-slate-700 hover:bg-slate-900'
    : '';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={`flex flex-col items-start gap-1 rounded-xl border border-slate-800 bg-slate-900 px-4 py-3 text-left transition-colors disabled:cursor-default ${interactive}`}
    >
      <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        {title}
      </span>
      <span className={`truncate text-lg font-semibold ${accent}`} title={value}>
        {value}
      </span>
      <span className="text-[11px] text-slate-500">{subtitle}</span>
    </button>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900">{children}</div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <header className="border-b border-slate-800 px-4 py-2">
      <p className="text-[12px] font-semibold text-slate-200">{title}</p>
    </header>
  );
}

function Empty({ body }: { body: string }) {
  return (
    <div className="flex h-full items-center justify-center px-4 text-center">
      <p className="text-[11px] text-slate-500">{body}</p>
    </div>
  );
}
