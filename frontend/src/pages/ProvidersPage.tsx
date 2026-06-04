import { useEffect, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { api, type ProviderConfigRead } from '../lib/api';

export function ProvidersPage() {
  const [providers, setProviders] = useState<ProviderConfigRead[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runMsg, setRunMsg] = useState<string | null>(null);

  const refresh = () => {
    setError(null);
    api
      .providers()
      .then(setProviders)
      .catch((e) => setError(e.message));
  };

  useEffect(refresh, []);

  const triggerRun = async (provider: string) => {
    setRunMsg(null);
    try {
      const r = await api.runtimeCollectorRun(provider);
      const total = r.reduce((acc, x) => acc + x.events_inserted, 0);
      setRunMsg(`${provider}: +${total} eventos · ${r[0]?.files_seen ?? 0} files`);
    } catch (e: unknown) {
      setRunMsg((e as Error).message);
    }
  };

  return (
    <div>
      <PageHeader
        title="Providers"
        subtitle="Catálogo de captura. enabled controla el watch loop; capture_* gobierna POST."
      />

      <div className="space-y-4 p-6">
        {error && <p className="text-[12px] text-rose-300">{error}</p>}
        {!providers && !error && (
          <div className="space-y-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="h-16 animate-pulse rounded-xl bg-slate-900" />
            ))}
          </div>
        )}
        {providers && providers.length === 0 && (
          <p className="text-[12px] text-slate-500">Sin providers configurados.</p>
        )}
        {providers && providers.length > 0 && (
          <ul className="space-y-3">
            {providers.map((p) => (
              <li
                key={p.provider}
                className="card-elev p-5"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="font-mono text-[18px] font-bold tracking-tight text-slate-50">
                      {p.provider}
                    </p>
                    <p className="mt-1 font-mono text-[11.5px] text-slate-500">
                      {p.enabled ? 'enabled' : 'disabled'} ·{' '}
                      {new Date(p.updated_at).toLocaleString()}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => triggerRun(p.provider)}
                    className="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
                  >
                    Run collector
                  </button>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
                  <Toggle label="enabled" value={p.enabled} />
                  <Toggle label="capture_metadata" value={p.capture_metadata} />
                  <Toggle label="capture_payload" value={p.capture_payload} />
                  <Toggle label="capture_response" value={p.capture_response} />
                </div>
              </li>
            ))}
          </ul>
        )}
        {runMsg && (
          <p className="rounded border border-slate-800 bg-slate-900 px-3 py-2 font-mono text-[11px] text-slate-400">
            {runMsg}
          </p>
        )}
        <p className="text-[11px] text-slate-500">
          Para flippear flags: <code className="text-slate-300">UPDATE provider_configs SET enabled=true WHERE provider='claude'</code>
        </p>
      </div>
    </div>
  );
}

function Toggle({ label, value }: { label: string; value: boolean }) {
  return (
    <div
      className={`flex items-center justify-between rounded border px-2 py-1.5 text-[11px] ${
        value
          ? 'border-emerald-700/60 bg-emerald-500/5 text-emerald-300'
          : 'border-slate-800 bg-slate-950 text-slate-500'
      }`}
    >
      <span className="font-mono">{label}</span>
      <span className="font-mono">{value ? 'on' : 'off'}</span>
    </div>
  );
}
