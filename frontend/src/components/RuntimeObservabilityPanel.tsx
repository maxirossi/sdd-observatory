import { useEffect, useState } from 'react';
import {
  api,
  type CollectorRunResult,
  type EventRead,
  type RuntimeHealthRead,
  type RuntimeProviderRow,
} from '../lib/api';

interface Props {
  projectId?: string;
}

function fmtRelative(iso: string | null): string {
  if (!iso) return '—';
  const delta = Date.now() - new Date(iso).getTime();
  const sec = Math.round(delta / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}min`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

const PROVIDER_GRAD: Record<string, string> = {
  claude: 'from-violet-500/20 via-violet-500/5 to-transparent',
  copilot: 'from-emerald-500/20 via-emerald-500/5 to-transparent',
  cursor: 'from-amber-500/20 via-amber-500/5 to-transparent',
  openai: 'from-cyan-500/20 via-cyan-500/5 to-transparent',
};

const PROVIDER_DOT: Record<string, string> = {
  claude: 'bg-violet-400',
  copilot: 'bg-emerald-400',
  cursor: 'bg-amber-400',
  openai: 'bg-cyan-400',
};

export function RuntimeObservabilityPanel({ projectId }: Props) {
  const [providers, setProviders] = useState<RuntimeProviderRow[] | null>(null);
  const [health, setHealth] = useState<RuntimeHealthRead | null>(null);
  const [events, setEvents] = useState<EventRead[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [runMsg, setRunMsg] = useState<string | null>(null);

  const refresh = () => {
    setError(null);
    Promise.all([api.runtimeProviders(projectId), api.runtimeHealth(projectId), api.events(40, projectId)])
      .then(([p, h, e]) => {
        setProviders(p);
        setHealth(h);
        setEvents(e);
      })
      .catch((err) => setError(err.message));
  };

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 10_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const triggerRun = async (provider?: string) => {
    setRunMsg(null);
    try {
      const result: CollectorRunResult[] = await api.runtimeCollectorRun(provider);
      const total = result.reduce((acc, r) => acc + r.events_inserted, 0);
      setRunMsg(
        result
          .map((r) => `${r.provider} +${r.events_inserted} (${r.files_seen} files)`)
          .join(' · '),
      );
      if (total > 0) refresh();
    } catch (e: unknown) {
      setRunMsg((e as Error).message);
    }
  };

  if (error) {
    return (
      <div className="card-elev px-5 py-4 text-[13px] text-rose-300">
        No se pudo cargar runtime: {error}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {health && <HealthStrip health={health} />}

      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {!providers
          ? Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="card-elev h-32 animate-pulse" />
            ))
          : providers.map((p) => (
              <ProviderCard key={p.provider} p={p} onRun={() => triggerRun(p.provider)} />
            ))}
      </div>

      <LiveStream events={events} />

      {runMsg && (
        <p className="card-elev px-4 py-2 font-mono text-[12px] text-slate-300">{runMsg}</p>
      )}
    </div>
  );
}

function HealthStrip({ health }: { health: RuntimeHealthRead }) {
  return (
    <div className="card-elev grid grid-cols-2 gap-px overflow-hidden bg-slate-800/40 md:grid-cols-6">
      <Cell label="Providers · habilitados" value={`${health.providers_enabled}`} subtitle={`${health.providers_available} adapters`} />
      <Cell label="Activos 24h" value={`${health.providers_active_24h}`} subtitle="≥ 1 evento" />
      <Cell label="Events · última hora" value={health.events_last_hour.toLocaleString()} highlight />
      <Cell label="Events · 24h" value={health.events_last_24h.toLocaleString()} />
      <Cell label="Sesiones · 24h" value={`${health.sessions_last_24h}`} />
      <Cell
        label="Source breakdown (24h)"
        value={`L ${health.sources.local_logs ?? 0}`}
        subtitle={`S ${health.sources.project_scan ?? 0} · M ${health.sources.manual_import ?? 0}`}
      />
    </div>
  );
}

function Cell({
  label,
  value,
  subtitle,
  highlight,
}: {
  label: string;
  value: string;
  subtitle?: string;
  highlight?: boolean;
}) {
  return (
    <div className="bg-slate-950/60 px-5 py-4">
      <p className="label-track text-slate-500">{label}</p>
      <p
        className={`kpi-number mt-2 ${highlight ? 'text-cyan-300' : 'text-slate-50'}`}
      >
        {value}
      </p>
      {subtitle && <p className="mt-1 text-[12px] text-slate-500">{subtitle}</p>}
    </div>
  );
}

function ProviderCard({ p, onRun }: { p: RuntimeProviderRow; onRun: () => void }) {
  const grad = PROVIDER_GRAD[p.provider] ?? 'from-slate-500/10 via-slate-500/5 to-transparent';
  const dot = PROVIDER_DOT[p.provider] ?? 'bg-slate-400';
  const isLive = p.enabled && p.events_total > 0;

  return (
    <div className={`card-elev card-elev-hover relative overflow-hidden`}>
      <div className={`absolute inset-x-0 top-0 h-32 bg-gradient-to-b ${grad} pointer-events-none`} />
      <div className="relative p-5">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-[16px] font-bold tracking-tight text-slate-50">
                {p.provider}
              </span>
              {isLive && <span className={`pulse-dot ${dot}`} />}
            </div>
            <p className="mt-1 font-mono text-[11px] text-slate-500">
              {p.source_kinds.join(', ') || 'no source'}
            </p>
          </div>
          <span
            className={`rounded-md border px-2 py-0.5 font-mono text-[10.5px] font-semibold ${
              !p.available
                ? 'border-rose-700/60 bg-rose-500/15 text-rose-200'
                : p.enabled
                  ? 'border-emerald-700/60 bg-emerald-500/15 text-emerald-200'
                  : 'border-slate-700 bg-slate-800 text-slate-400'
            }`}
          >
            {!p.available
              ? 'NO ADAPTER'
              : p.enabled
                ? 'ACTIVE'
                : 'DISABLED'}
          </span>
        </div>

        <div className="mt-4">
          <p className="kpi-number tabular text-slate-50">{p.events_total.toLocaleString()}</p>
          <p className="mt-1 text-[12px] text-slate-500">eventos totales</p>
        </div>

        <div className="mt-4 flex items-center justify-between border-t border-slate-800/60 pt-3 text-[11.5px] text-slate-400">
          <span>last · <span className="text-slate-300">{fmtRelative(p.last_event_at)}</span></span>
          <span>{p.sessions_total > 0 ? `${p.sessions_total} sessions` : '—'}</span>
        </div>

        <div className="mt-3 flex items-center justify-between">
          <p className="font-mono text-[10.5px] text-slate-600">
            meta:{String(p.capture_metadata)} · pl:{String(p.capture_payload)} · resp:{String(p.capture_response)}
          </p>
          <button
            type="button"
            onClick={onRun}
            disabled={!p.available}
            className="rounded-md border border-slate-700 px-2.5 py-1 text-[11.5px] font-medium text-slate-200 transition-colors hover:bg-slate-800 disabled:opacity-40"
          >
            Trigger
          </button>
        </div>
      </div>
    </div>
  );
}

function LiveStream({ events }: { events: EventRead[] }) {
  return (
    <div className="card-elev overflow-hidden">
      <header className="flex items-center justify-between border-b border-slate-800/80 px-5 py-3">
        <div>
          <p className="text-[14px] font-semibold text-slate-100">Runtime activity · live stream</p>
          <p className="text-[12px] text-slate-500">Auto-refresh cada 10s · últimos 40 eventos</p>
        </div>
        <span className="flex items-center gap-2 font-mono text-[11.5px] text-emerald-300">
          <span className="pulse-dot bg-emerald-400" />
          STREAMING
        </span>
      </header>
      {events.length === 0 ? (
        <p className="px-5 py-10 text-center text-[13px] text-slate-500">
          Sin eventos. Habilitá un provider para empezar a ver tráfico.
        </p>
      ) : (
        <ol className="max-h-[420px] divide-y divide-slate-800/60 overflow-y-auto font-mono text-[12.5px]">
          {events.map((e) => {
            const ts = new Date(e.timestamp);
            const dot = PROVIDER_DOT[e.provider] ?? 'bg-slate-500';
            return (
              <li
                key={e.id}
                className="fade-in-row flex items-center gap-3 px-5 py-2.5 transition-colors hover:bg-slate-800/30"
              >
                <span className="w-20 shrink-0 text-slate-500 tabular">
                  {ts.toLocaleTimeString()}
                </span>
                <span className="flex w-24 shrink-0 items-center gap-1.5">
                  <span className={`h-2 w-2 rounded-full ${dot}`} />
                  <span className="text-slate-300">{e.provider}</span>
                </span>
                <span className="w-24 shrink-0 text-slate-400">{e.event_type}</span>
                <span className="min-w-0 flex-1 truncate text-slate-300" title={e.endpoint ?? ''}>
                  {e.endpoint ?? '—'}
                </span>
                {e.status_code && (
                  <span
                    className={`w-10 shrink-0 text-right tabular ${
                      e.status_code >= 500
                        ? 'text-rose-300'
                        : e.status_code >= 400
                          ? 'text-amber-300'
                          : 'text-emerald-300'
                    }`}
                  >
                    {e.status_code}
                  </span>
                )}
                {e.latency_ms !== null && (
                  <span className="w-16 shrink-0 text-right text-slate-500 tabular">
                    {e.latency_ms}ms
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
