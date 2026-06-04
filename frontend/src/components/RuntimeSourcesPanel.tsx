import { useEffect, useState } from 'react';
import { api, type RuntimeSourceBucket } from '../lib/api';

interface Props {
  projectId: string;
}

const PROVIDER_COLOR: Record<string, string> = {
  claude: 'text-violet-300',
  copilot: 'text-emerald-300',
  cursor: 'text-amber-300',
  openai: 'text-cyan-300',
};

function providerColor(p: string): string {
  return PROVIDER_COLOR[p] ?? 'text-slate-300';
}

function fmtRelative(iso: string | null): string {
  if (!iso) return 'never';
  const delta = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(delta / 60_000);
  if (minutes < 1) return 'hace segundos';
  if (minutes < 60) return `hace ${minutes}min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours}h`;
  const days = Math.round(hours / 24);
  return `hace ${days}d`;
}

export function RuntimeSourcesPanel({ projectId }: Props) {
  const [buckets, setBuckets] = useState<RuntimeSourceBucket[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBuckets(null);
    setError(null);
    api
      .runtimeSources(projectId)
      .then((b) => !cancelled && setBuckets(b))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (error) {
    return (
      <Card>
        <p className="px-4 py-3 text-xs text-rose-300">No se pudo cargar runtime-sources: {error}</p>
      </Card>
    );
  }
  if (!buckets) {
    return (
      <Card>
        <div className="space-y-2 p-4">
          <div className="h-4 w-1/2 animate-pulse rounded bg-slate-800" />
          <div className="h-4 w-2/3 animate-pulse rounded bg-slate-800" />
        </div>
      </Card>
    );
  }

  const visible = buckets;
  return (
    <div className="card-elev overflow-hidden">
      <header className="border-b border-slate-800/80 px-5 py-3">
        <p className="text-[14px] font-semibold text-slate-100">Runtime sources</p>
        <p className="text-[12px] text-slate-500">
          Cada fuente declara su origen.
        </p>
      </header>
      <ul className="divide-y divide-slate-800/60">
        {visible.map((b) => (
          <SourceRow key={b.source_kind} bucket={b} />
        ))}
      </ul>
    </div>
  );
}

function SourceRow({ bucket }: { bucket: RuntimeSourceBucket }) {
  const isWaiting = bucket.available && bucket.enabled && bucket.total === 0;
  const stateChip = !bucket.available
    ? { label: 'No implementado', cls: 'bg-slate-800 text-slate-400 border-slate-700' }
    : isWaiting
      ? { label: 'Esperando eventos', cls: 'bg-cyan-500/10 text-cyan-300 border-cyan-700/60' }
      : bucket.enabled
        ? { label: 'Activo', cls: 'bg-emerald-500/10 text-emerald-300 border-emerald-700/60' }
        : { label: 'Disabled', cls: 'bg-slate-800 text-slate-400 border-slate-700' };

  return (
    <li className="px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-slate-500">source:</span>
            <span className="font-mono text-[12px] font-semibold text-slate-100">
              {bucket.source_kind}
            </span>
            <span
              className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${stateChip.cls}`}
            >
              {stateChip.label}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-slate-400">{bucket.description}</p>
        </div>
        <div className="text-right">
          <p className="font-mono text-[11px] text-slate-500">{bucket.label}</p>
          {bucket.enabled && (
            <p className="font-mono text-[12px] text-slate-100">
              {bucket.total.toLocaleString()} <span className="text-slate-500">events</span>
            </p>
          )}
        </div>
      </div>

      {bucket.providers.length > 0 ? (
        <ul className="mt-3 space-y-1 border-l border-slate-800 pl-3">
          {bucket.providers.map((p) => (
            <li
              key={p.provider}
              className="flex items-center justify-between text-[12px]"
            >
              <span className={`font-mono ${providerColor(p.provider)}`}>{p.provider}</span>
              <span className="font-mono text-slate-400">
                {p.events.toLocaleString()}{' '}
                <span className="text-slate-600">· {fmtRelative(p.last_seen)}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 pl-3 font-mono text-[11px] text-slate-600">
          {!bucket.available ? '— módulo no disponible todavía' : '— sin eventos aún'}
        </p>
      )}
    </li>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="card-elev overflow-hidden">{children}</div>;
}
