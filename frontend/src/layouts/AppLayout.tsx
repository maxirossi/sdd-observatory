import {
  Activity,
  BookText,
  Boxes,
  CircleDot,
  Cog,
  FolderTree,
  Gauge,
  LayoutDashboard,
  ListChecks,
  Network,
  PlugZap,
  ShieldCheck,
  Sparkles,
  Split,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import { LiveStatusBar } from '../components/LiveStatusBar';
import { api, type ProjectRead, type RuntimeHealthRead } from '../lib/api';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  badgeKey?: 'runtime' | 'providers' | 'sessions';
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const GROUPS: NavGroup[] = [
  {
    label: 'Project',
    items: [
      { to: 'overview', label: 'Overview', icon: LayoutDashboard },
      { to: 'cycles', label: 'Cycles', icon: Workflow },
      { to: 'tasks', label: 'Tasks', icon: ListChecks },
      { to: 'agents', label: 'Agents', icon: Boxes },
    ],
  },
  {
    label: 'Runtime',
    items: [
      { to: 'runtime', label: 'Runtime', icon: Activity, badgeKey: 'runtime' },
      { to: 'sessions', label: 'Sessions', icon: BookText, badgeKey: 'sessions' },
      { to: 'executions', label: 'Executions', icon: Split },
      { to: 'providers', label: 'Providers', icon: PlugZap, badgeKey: 'providers' },
    ],
  },
  {
    label: 'Analysis',
    items: [
      { to: 'explorer', label: 'Explorer', icon: FolderTree },
      { to: 'intelligence', label: 'Intelligence', icon: Sparkles },
      { to: 'audit', label: 'Audit', icon: ShieldCheck },
    ],
  },
  {
    label: 'System',
    items: [{ to: 'settings', label: 'Settings', icon: Cog }],
  },
];

export function AppLayout() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectRead[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .projects()
      .then(setProjects)
      .catch((e) => setError(e.message));
  }, []);

  const currentProject = projects.find((p) => p.id === projectId);

  return (
    <div className="flex h-screen bg-[#050b16] text-slate-200">
      <Sidebar projectId={projectId} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-white/[0.05] bg-slate-950/70 px-5 backdrop-blur-md">
          <div className="flex items-center gap-3">
            <span className="label-track text-slate-500">Project</span>
            {error ? (
              <p className="text-[13px] text-rose-300">Error: {error}</p>
            ) : (
              <select
                value={projectId ?? ''}
                onChange={(e) => {
                  const newId = e.target.value;
                  if (newId) navigate(`/projects/${newId}/overview`);
                }}
                className="rounded-md border border-slate-700/70 bg-slate-900 px-2.5 py-1 text-[13px] font-medium text-slate-100 hover:border-slate-600 focus:border-cyan-500 focus:outline-none"
              >
                {!currentProject && <option value="">Seleccionar…</option>}
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
            {currentProject && (
              <p className="mono-body truncate text-slate-500" title={currentProject.path}>
                {currentProject.path}
              </p>
            )}
          </div>
          <div className="flex items-center gap-3 font-mono text-[11px] text-slate-500">
            <span className="pulse-dot bg-emerald-400" aria-hidden />
            <span className="text-slate-400">SDD Observatory</span>
            <span className="text-slate-700">·</span>
            <span>v0.2</span>
          </div>
        </header>

        {projectId && <LiveStatusBar projectId={projectId} />}

        <main className="min-h-0 flex-1 overflow-y-auto bg-[#050b16]">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function Sidebar({ projectId }: { projectId: string | undefined }) {
  const [runtimeHealth, setRuntimeHealth] = useState<RuntimeHealthRead | null>(null);
  const [providerCount, setProviderCount] = useState<{ enabled: number; total: number } | null>(
    null,
  );
  const [sessionsCount, setSessionsCount] = useState<number | null>(null);

  useEffect(() => {
    if (!projectId) return;
    const fetchAll = async () => {
      try {
        const [health, providers, sessions] = await Promise.all([
          api.runtimeHealth(projectId),
          api.runtimeProviders(projectId),
          api.sessions(projectId, 50),
        ]);
        setRuntimeHealth(health);
        // "Activos" = providers con actividad EN ESTE proyecto (no el enabled global).
        setProviderCount({
          enabled: providers.filter((p) => p.events_total > 0).length,
          total: providers.length,
        });
        setSessionsCount(sessions.length);
      } catch {
        // silent — el sidebar no debe romper si un endpoint falla
      }
    };
    fetchAll();
    const id = setInterval(fetchAll, 15_000);
    return () => clearInterval(id);
  }, [projectId]);

  return (
    <aside
      className="flex w-64 shrink-0 flex-col border-r border-white/[0.05]"
      style={{
        background: 'linear-gradient(180deg, #07101f 0%, #050b16 100%)',
      }}
    >
      <Brand />

      <nav className="flex-1 space-y-4 overflow-y-auto px-3 py-4">
        {GROUPS.map((group) => (
          <NavGroupBlock
            key={group.label}
            group={group}
            projectId={projectId}
            badges={{
              runtime: runtimeHealth ? formatRuntimeBadge(runtimeHealth) : null,
              providers: providerCount
                ? { label: `${providerCount.enabled} active`, tone: 'emerald' }
                : null,
              sessions:
                sessionsCount !== null && sessionsCount > 0
                  ? { label: `${sessionsCount}`, tone: 'slate' }
                  : null,
            }}
          />
        ))}
      </nav>

      <StatusFooter />
    </aside>
  );
}

function Brand() {
  return (
    <div className="flex h-14 items-center gap-2.5 border-b border-white/[0.05] px-5">
      <div className="relative">
        <CircleDot
          className="text-cyan-300"
          size={20}
          strokeWidth={2.4}
          style={{ filter: 'drop-shadow(0 0 8px rgba(103,232,249,0.55))' }}
        />
      </div>
      <div className="flex flex-col leading-tight">
        <span
          className="text-[15px] font-extrabold tracking-tight text-cyan-300"
          style={{ letterSpacing: '-0.01em', textShadow: '0 0 10px rgba(103,232,249,0.18)' }}
        >
          SDD
        </span>
        <span className="text-[11px] font-medium tracking-wide text-slate-400">
          Observatory
        </span>
      </div>
    </div>
  );
}

type BadgeTone = 'emerald' | 'cyan' | 'amber' | 'slate';

interface Badge {
  label: string;
  tone: BadgeTone;
  pulse?: boolean;
}

interface BadgeMap {
  runtime: Badge | null;
  providers: Badge | null;
  sessions: Badge | null;
}

function formatRuntimeBadge(h: RuntimeHealthRead): Badge {
  if (h.events_last_hour > 0) {
    return {
      label: `${h.events_last_hour}/h`,
      tone: 'emerald',
      pulse: true,
    };
  }
  if (h.events_last_24h > 0) {
    return { label: 'idle', tone: 'slate' };
  }
  return { label: '—', tone: 'slate' };
}

const BADGE_CLS: Record<BadgeTone, string> = {
  emerald: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  cyan: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
  amber: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  slate: 'bg-slate-800 text-slate-400 border-slate-700/80',
};

const TONE_DOT: Record<BadgeTone, string> = {
  emerald: 'bg-emerald-400',
  cyan: 'bg-cyan-400',
  amber: 'bg-amber-400',
  slate: 'bg-slate-500',
};

function NavGroupBlock({
  group,
  projectId,
  badges,
}: {
  group: NavGroup;
  projectId: string | undefined;
  badges: BadgeMap;
}) {
  return (
    <div>
      <p className="px-2.5 pb-1.5 text-[10.5px] font-bold uppercase tracking-[0.08em] text-slate-500/80">
        {group.label}
      </p>
      <ul className="space-y-0.5">
        {group.items.map((item) => {
          const disabled = !projectId;
          const to = projectId ? `/projects/${projectId}/${item.to}` : '#';
          const badge = item.badgeKey ? badges[item.badgeKey] : null;
          return (
            <li key={item.to}>
              {disabled ? (
                <span className="flex cursor-not-allowed items-center gap-3 rounded-lg px-2.5 py-2 text-[14px] font-medium text-slate-700">
                  <span className="grid h-7 w-7 place-items-center">
                    <item.icon size={18} strokeWidth={2} />
                  </span>
                  <span>{item.label}</span>
                </span>
              ) : (
                <NavLink
                  to={to}
                  end={item.to === 'overview'}
                  className={({ isActive }: { isActive: boolean }) =>
                    [
                      'group relative flex items-center gap-3 rounded-lg px-2.5 py-2 text-[14px] font-medium transition-all duration-150',
                      isActive
                        ? 'text-slate-50'
                        : 'text-slate-400 hover:translate-x-[2px] hover:bg-white/[0.03] hover:text-slate-100',
                    ].join(' ')
                  }
                  style={({ isActive }: { isActive: boolean }) =>
                    isActive
                      ? {
                          background:
                            'linear-gradient(90deg, rgba(30,41,59,0.95), rgba(15,23,42,0.92))',
                          border: '1px solid rgba(103,232,249,0.12)',
                          boxShadow:
                            '0 0 0 1px rgba(103,232,249,0.06), 0 4px 18px rgba(0,0,0,0.35)',
                        }
                      : undefined
                  }
                >
                  {({ isActive }: { isActive: boolean }) => (
                    <>
                      {isActive && (
                        <span
                          aria-hidden
                          className="absolute -left-3 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-cyan-300"
                          style={{ boxShadow: '0 0 12px rgba(103,232,249,0.55)' }}
                        />
                      )}
                      <span
                        className={[
                          'grid h-7 w-7 shrink-0 place-items-center rounded-md transition-colors duration-150',
                          isActive
                            ? 'bg-white/[0.04] text-cyan-200'
                            : 'text-slate-500 group-hover:text-cyan-200',
                        ].join(' ')}
                      >
                        <item.icon size={18} strokeWidth={2.1} />
                      </span>
                      <span className="flex-1 truncate">{item.label}</span>
                      {badge && (
                        <span
                          className={[
                            'flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono text-[10px] font-semibold',
                            BADGE_CLS[badge.tone],
                          ].join(' ')}
                        >
                          {badge.pulse && (
                            <span className={`h-1.5 w-1.5 rounded-full ${TONE_DOT[badge.tone]}`} />
                          )}
                          {badge.label}
                        </span>
                      )}
                    </>
                  )}
                </NavLink>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function StatusFooter() {
  const [privacyMode, setPrivacyMode] = useState<string | null>(null);
  useEffect(() => {
    api
      .health()
      .then((h) => setPrivacyMode(h.privacyMode ?? null))
      .catch(() => {});
  }, []);
  return (
    <div className="border-t border-white/[0.05] px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="grid h-6 w-6 place-items-center rounded-md bg-emerald-500/10 text-emerald-300">
          <Network size={13} strokeWidth={2.4} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold tracking-wide text-emerald-300">LOCAL DEV</p>
          <p className="mono-body truncate text-[10.5px] text-slate-500">
            localhost:5180
          </p>
        </div>
      </div>
      {privacyMode && (
        <div className="mt-2 flex items-center gap-2 font-mono text-[10px] text-slate-500">
          <Gauge size={11} strokeWidth={2.4} />
          <span>{privacyMode}</span>
        </div>
      )}
    </div>
  );
}
