import { useEffect, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { api, type HealthResponse } from '../lib/api';
import { getLiveStatusEnabled, setLiveStatusEnabled } from '../lib/liveStatusPref';

export function SettingsPage() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  useEffect(() => {
    api.health().then(setHealth).catch(() => {});
  }, []);

  return (
    <div>
      <PageHeader title="Settings" subtitle="Configuración del observatorio." />
      <div className="space-y-5 p-6">
        <Section title="Backend" subtitle="Estado del proceso que serve la API y procesa el ingest.">
          {health ? (
            <KvGrid
              rows={[
                ['env', health.env ?? '—'],
                ['privacy_mode', health.privacyMode ?? '—'],
                ['status', health.status],
              ]}
            />
          ) : (
            <p className="text-[13px] text-slate-500">Cargando…</p>
          )}
        </Section>

        <Section
          title="Security"
          subtitle="Garantías de privacidad. Cambios requieren restart del backend."
        >
          <ul className="space-y-2 text-[13px]">
            <SecRow flag="metadata_only" status="enforced" desc="Solo se persisten metadata (size, latency, status). Body de prompts y respuestas NO se guarda." />
            <SecRow flag="capture_payload" status="off" desc="Captura de body completo está deshabilitada por defecto en todos los providers." />
            <SecRow flag="sanitizer" status="enforced" desc="JWT, API keys (AWS/Google/OpenAI/Anthropic/GitHub), Bearer tokens, cookies, connection strings y PEM keys se redactan antes de persistir." />
          </ul>
        </Section>

        <Section
          title="Interfaz"
          subtitle="Preferencias de visualización (se guardan en este navegador)."
        >
          <LiveStatusToggle />
        </Section>

        <Section
          title="Pendientes"
          subtitle="Funcionalidad que la página todavía no expone."
        >
          <ul className="space-y-1.5 text-[13px] text-slate-400">
            <li>· Edición inline de provider flags (hoy es read-only desde UI)</li>
            <li>· Trigger de scan-project</li>
            <li>· Cambio de log_timezone en runtime</li>
            <li>· Retention policy para runtime_events</li>
          </ul>
        </Section>

        <DangerZone />
      </div>
    </div>
  );
}

function LiveStatusToggle() {
  const [on, setOn] = useState(getLiveStatusEnabled());
  const toggle = () => {
    const next = !on;
    setOn(next);
    setLiveStatusEnabled(next);
  };
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-slate-200">Barra de estado en vivo</p>
        <p className="text-[12px] text-slate-500">
          Muestra en el topbar el estado de la ejecución de Copilot en curso (tarea, derivación,
          agente trabajando, finalizada). Polling cada ~2s mientras hay actividad.
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={toggle}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
          on ? 'bg-cyan-500/70' : 'bg-slate-700'
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
            on ? 'translate-x-5' : 'translate-x-0.5'
          }`}
        />
      </button>
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card-elev overflow-hidden">
      <header className="border-b border-slate-800/80 px-5 py-3">
        <p className="text-[14px] font-semibold text-slate-100">{title}</p>
        {subtitle && <p className="text-[12px] text-slate-500">{subtitle}</p>}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

function KvGrid({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="grid grid-cols-[160px_1fr] gap-x-4 gap-y-2 text-[13px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-slate-500">{k}</dt>
          <dd className="font-mono text-slate-100">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const STATUS_STYLE: Record<string, string> = {
  enforced: 'border-emerald-700/60 bg-emerald-500/15 text-emerald-200',
  off: 'border-slate-700 bg-slate-800 text-slate-300',
  'opt-in': 'border-cyan-700/60 bg-cyan-500/15 text-cyan-200',
};

function SecRow({ flag, status, desc }: { flag: string; status: keyof typeof STATUS_STYLE; desc: string }) {
  return (
    <li className="flex items-start gap-3 rounded-md border border-slate-800/60 bg-slate-950/40 px-4 py-3">
      <span
        className={`shrink-0 rounded border px-2 py-0.5 font-mono text-[10.5px] font-semibold ${STATUS_STYLE[status]}`}
      >
        {status}
      </span>
      <div className="min-w-0">
        <p className="font-mono text-[13px] text-slate-100">{flag}</p>
        <p className="mt-0.5 text-[12px] text-slate-400">{desc}</p>
      </div>
    </li>
  );
}

function DangerZone() {
  return (
    <section className="overflow-hidden rounded-xl border border-rose-900/40 bg-rose-950/10">
      <header className="border-b border-rose-900/40 px-5 py-3">
        <p className="text-[14px] font-semibold text-rose-200">Danger zone</p>
        <p className="text-[12px] text-rose-300/70">
          Acciones destructivas. No hay confirmación post-click — pegá los comandos abajo con cuidado.
        </p>
      </header>
      <div className="space-y-2 p-5">
        <DangerCmd
          label="Borrar todos los runtime events"
          cmd="docker compose exec postgres psql -U ssdoffice -d ssdoffice -c &quot;DELETE FROM runtime_events;&quot;"
        />
        <DangerCmd
          label="Borrar agent_mentions runtime"
          cmd="docker compose exec postgres psql -U ssdoffice -d ssdoffice -c &quot;DELETE FROM agent_mentions WHERE source_type LIKE 'runtime_%';&quot;"
        />
        <DangerCmd
          label="Wipe completo + DROP volumen"
          cmd="docker compose down -v && docker compose up -d"
        />
      </div>
    </section>
  );
}

function DangerCmd({ label, cmd }: { label: string; cmd: string }) {
  return (
    <div className="rounded-md border border-rose-900/30 bg-slate-950/60 px-4 py-3">
      <p className="text-[12px] font-semibold text-rose-200">{label}</p>
      <code className="mt-1 block overflow-x-auto whitespace-nowrap font-mono text-[11.5px] text-slate-300">
        {cmd.replace(/&quot;/g, '"')}
      </code>
    </div>
  );
}
