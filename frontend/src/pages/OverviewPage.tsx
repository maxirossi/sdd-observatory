import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { HealthBanner } from '../components/HealthBanner';
import { PageHeader } from '../components/PageHeader';
import { api, type EventRead, type HealthResponse, type ProjectRead } from '../lib/api';

export function OverviewPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [project, setProject] = useState<ProjectRead | null>(null);
  const [events, setEvents] = useState<EventRead[]>([]);
  const [healthMeta, setHealthMeta] = useState<HealthResponse | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    api.projects().then((all) => {
      if (cancelled) return;
      setProject(all.find((p) => p.id === projectId) ?? null);
    });
    api.health().then((h) => !cancelled && setHealthMeta(h)).catch(() => {});

    const tick = () => {
      api.events(20, projectId).then((e) => !cancelled && setEvents(e)).catch(() => {});
    };
    tick();
    const id = setInterval(tick, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [projectId]);

  if (!projectId) return null;

  return (
    <div>
      <PageHeader
        title={project?.name ?? 'Overview'}
        subtitle={project?.path ?? 'Cargando proyecto…'}
        badge={
          <span className="inline-flex items-center gap-2 rounded-full border border-emerald-700/50 bg-emerald-500/10 px-3 py-1 text-[11px] font-semibold text-emerald-300">
            <span className="pulse-dot bg-emerald-400" />
            ACTIVE
          </span>
        }
        actions={
          healthMeta && (
            <div className="hidden gap-4 font-mono text-[11px] text-slate-500 md:flex">
              <span>env · <span className="text-slate-300">{healthMeta.env}</span></span>
              <span>privacy · <span className="text-slate-300">{healthMeta.privacyMode}</span></span>
              <span>
                last scan ·{' '}
                <span className="text-slate-300">
                  {project?.last_scanned_at
                    ? new Date(project.last_scanned_at).toLocaleTimeString()
                    : '—'}
                </span>
              </span>
            </div>
          )
        }
      />

      <div className="space-y-5 p-6">
        <HealthBanner projectId={projectId} />

        <section className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
          <ScanSnapshot project={project} />
          <ActivityFeed events={events} />
        </section>
      </div>
    </div>
  );
}

function ScanSnapshot({ project }: { project: ProjectRead | null }) {
  return (
    <div className="card-elev overflow-hidden">
      <header className="border-b border-slate-800/80 px-5 py-3">
        <p className="label-track text-slate-500">Scan snapshot</p>
      </header>
      <div className="grid grid-cols-3 gap-px bg-slate-800/40">
        <StatCell label="Agents" value={project?.agents_count} />
        <StatCell label="Docs" value={project?.documents_count} />
        <StatCell label="Tasks" value={project?.tasks_count} />
      </div>
      <div className="px-5 py-3 text-[12px] text-slate-500">
        Último scan:{' '}
        <span className="text-slate-300">
          {project?.last_scanned_at
            ? new Date(project.last_scanned_at).toLocaleString()
            : '—'}
        </span>
      </div>
    </div>
  );
}

function StatCell({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div className="bg-slate-950/40 px-5 py-4">
      <p className="label-track text-slate-500">{label}</p>
      <p className="kpi-number mt-1 text-slate-100">
        {value !== undefined ? value.toLocaleString() : '—'}
      </p>
    </div>
  );
}

function ActivityFeed({ events }: { events: EventRead[] }) {
  return (
    <div className="card-elev overflow-hidden">
      <header className="flex items-center justify-between border-b border-slate-800/80 px-5 py-3">
        <p className="label-track text-slate-500">Live runtime activity</p>
        <span className="flex items-center gap-2 font-mono text-[11px] text-slate-500">
          <span className="pulse-dot bg-cyan-400" />
          stream · 10s
        </span>
      </header>
      {events.length === 0 ? (
        <p className="px-5 py-10 text-center text-[13px] text-slate-500">
          Sin eventos runtime. Activá un provider en Providers para empezar.
        </p>
      ) : (
        <ol className="divide-y divide-slate-800/60 font-mono text-[12.5px]">
          {events.slice(0, 12).map((e) => (
            <EventRow key={e.id} event={e} />
          ))}
        </ol>
      )}
    </div>
  );
}

const PROVIDER_BADGE: Record<string, string> = {
  claude: 'bg-violet-500/15 text-violet-200 border-violet-700/40',
  copilot: 'bg-emerald-500/15 text-emerald-200 border-emerald-700/40',
  cursor: 'bg-amber-500/15 text-amber-200 border-amber-700/40',
  openai: 'bg-cyan-500/15 text-cyan-200 border-cyan-700/40',
};

function EventRow({ event: e }: { event: EventRead }) {
  const ts = new Date(e.timestamp);
  const provider = PROVIDER_BADGE[e.provider] ?? 'bg-slate-700 text-slate-300';
  return (
    <li className="fade-in-row flex items-center gap-3 px-5 py-2.5 transition-colors hover:bg-slate-800/30">
      <span className="w-20 shrink-0 text-slate-500 tabular">
        {ts.toLocaleTimeString()}
      </span>
      <span className={`rounded border px-1.5 py-0.5 text-[10.5px] font-semibold ${provider}`}>
        {e.provider}
      </span>
      <span className="w-20 shrink-0 text-slate-400">{e.event_type}</span>
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
        <span className="w-14 shrink-0 text-right text-slate-500 tabular">
          {e.latency_ms}ms
        </span>
      )}
    </li>
  );
}
