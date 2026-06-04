import { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api, type EventTimelineBucket, type ProviderStats } from '../lib/api';

interface Props {
  projectId?: string;
}

const PROVIDER_COLOR: Record<string, string> = {
  claude: '#a78bfa',
  copilot: '#34d399',
  cursor: '#fbbf24',
  openai: '#22d3ee',
  gemini: '#60a5fa',
  ollama: '#94a3b8',
};

function color(provider: string): string {
  return PROVIDER_COLOR[provider] ?? '#64748b';
}

function formatHour(iso: string): string {
  const d = new Date(iso);
  return `${d.getHours().toString().padStart(2, '0')}h`;
}

export function RuntimePanel({ projectId }: Props) {
  const [timeline, setTimeline] = useState<EventTimelineBucket[] | null>(null);
  const [providers, setProviders] = useState<ProviderStats[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTimeline(null);
    setProviders(null);
    setError(null);
    Promise.all([api.timeline(projectId, 48), api.byProvider(projectId)])
      .then(([t, p]) => {
        if (cancelled) return;
        setTimeline(t);
        setProviders(p);
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const timelineData = useMemo(() => {
    if (!timeline) return [];
    // Reshape: one row per bucket, one column per provider.
    const byBucket = new Map<string, Record<string, number | string>>();
    const providerKeys = new Set<string>();
    for (const row of timeline) {
      const key = row.bucket;
      providerKeys.add(row.provider);
      const entry = byBucket.get(key) ?? { bucket: key, label: formatHour(key) };
      entry[row.provider] = (entry[row.provider] as number | undefined) ?? 0;
      entry[row.provider] = (entry[row.provider] as number) + row.count;
      byBucket.set(key, entry);
    }
    const rows = [...byBucket.values()].sort((a, b) =>
      String(a.bucket).localeCompare(String(b.bucket)),
    );
    return { rows, providers: [...providerKeys] };
  }, [timeline]);

  if (error) {
    return (
      <Card>
        <p className="px-4 py-3 text-xs text-rose-300">No se pudo cargar runtime: {error}</p>
      </Card>
    );
  }

  return (
    <section className="grid gap-4 lg:grid-cols-[2fr_1fr]">
      <Card>
        <SectionHeader title="Runtime — eventos por hora (48h)" />
        <div className="h-56 w-full px-2 pb-2">
          {timeline == null ? (
            <Skeleton />
          ) : timeline.length === 0 ? (
            <Empty body="Sin eventos en las últimas 48 horas. Corré: docker compose exec backend python -m app.cli ingest-claude-logs" />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={(timelineData as { rows: Record<string, number | string>[] }).rows}
                margin={{ top: 8, right: 12, left: -10, bottom: 0 }}
              >
                <CartesianGrid stroke="#1e293b" strokeDasharray="2 4" />
                <XAxis
                  dataKey="label"
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
                />
                {(timelineData as { providers: string[] }).providers.map((p) => (
                  <Line
                    key={p}
                    type="monotone"
                    dataKey={p}
                    stroke={color(p)}
                    strokeWidth={2}
                    dot={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </Card>

      <Card>
        <SectionHeader title="Volumen por provider" />
        <div className="h-56 w-full px-2 pb-2">
          {providers == null ? (
            <Skeleton />
          ) : providers.length === 0 ? (
            <Empty body="Sin actividad por provider todavía." />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={providers.map((p) => ({ provider: p.provider, total: p.total, fill: color(p.provider) }))}
                margin={{ top: 8, right: 12, left: -10, bottom: 0 }}
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
                <Bar dataKey="total" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </Card>
    </section>
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

function Skeleton() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="h-32 w-3/4 animate-pulse rounded bg-slate-800" />
    </div>
  );
}

function Empty({ body }: { body: string }) {
  return (
    <div className="flex h-full items-center justify-center px-4 text-center">
      <p className="text-[11px] text-slate-500">{body}</p>
    </div>
  );
}
