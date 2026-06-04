import { useEffect, useMemo, useState } from 'react';
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  api,
  type AgentMentionRead,
  type AgentRead,
  type ProjectRead,
  type SddDocumentRead,
  type SddTaskRead,
} from '../lib/api';
import { EntityDrawer, type EntityTarget } from './EntityDrawer';
import { RawFileModal } from './RawFileModal';

type Tab = 'agents' | 'documents' | 'tasks';
type StatusFilter = 'all' | 'done' | 'pending' | 'in_progress' | 'unknown';

interface Props {
  project: ProjectRead;
  onClose: () => void;
}

const TYPE_BADGE: Record<string, string> = {
  github_agents: 'bg-cyan-500/15 text-cyan-300',
  agents_root: 'bg-cyan-500/15 text-cyan-300',
  claude_md: 'bg-violet-500/15 text-violet-300',
  cursor_rules: 'bg-amber-500/15 text-amber-300',
  docs: 'bg-slate-500/15 text-slate-300',
  spec: 'bg-emerald-500/15 text-emerald-300',
  tasks: 'bg-blue-500/15 text-blue-300',
  requirements: 'bg-indigo-500/15 text-indigo-300',
  runtime_claude_user: 'bg-fuchsia-500/15 text-fuchsia-300',
  runtime_claude_assistant: 'bg-violet-500/15 text-violet-300',
  runtime_claude: 'bg-violet-500/15 text-violet-300',
};

const STATUS_BADGE: Record<string, string> = {
  done: 'bg-emerald-500/15 text-emerald-300',
  in_progress: 'bg-amber-500/15 text-amber-300',
  pending: 'bg-slate-500/15 text-slate-300',
  unknown: 'bg-slate-500/15 text-slate-500',
};

const STATUS_LABEL: Record<StatusFilter, string> = {
  all: 'Todos',
  done: 'Hechas',
  pending: 'Pendientes',
  in_progress: 'En progreso',
  unknown: 'Sin clasificar',
};

const TYPE_FILL: Record<string, string> = {
  github_agents: '#22d3ee',
  agents_root: '#22d3ee',
  claude_md: '#a78bfa',
  cursor_rules: '#fbbf24',
  docs: '#94a3b8',
  spec: '#34d399',
  tasks: '#60a5fa',
  requirements: '#818cf8',
};

function badge(type: string): string {
  return TYPE_BADGE[type] ?? 'bg-slate-500/15 text-slate-300';
}

function statusBadge(s: string | null | undefined): string {
  return STATUS_BADGE[s ?? 'unknown'] ?? STATUS_BADGE.unknown;
}

function fill(type: string): string {
  return TYPE_FILL[type] ?? '#64748b';
}

function groupCount<T>(items: T[], key: (t: T) => string | null | undefined): Array<[string, number]> {
  const map = new Map<string, number>();
  for (const it of items) {
    const k = key(it) ?? '—';
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

function cleanDescription(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed === '>-' || trimmed === '|' || trimmed === '>') return null;
  return trimmed;
}

function includesCi(haystack: string | null | undefined, needle: string): boolean {
  if (!needle) return true;
  return (haystack ?? '').toLowerCase().includes(needle.toLowerCase());
}

export function ProjectDetail({ project, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('agents');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [agents, setAgents] = useState<AgentRead[] | null>(null);
  const [documents, setDocuments] = useState<SddDocumentRead[] | null>(null);
  const [tasks, setTasks] = useState<SddTaskRead[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [openEntity, setOpenEntity] = useState<EntityTarget | null>(null);
  const [openFilePath, setOpenFilePath] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    setAgents(null);
    setDocuments(null);
    setTasks(null);
    setFilter('');
    setStatusFilter('all');
    setOpenEntity(null);
    setOpenFilePath(null);
    let cancelled = false;
    Promise.all([api.agents(project.id), api.documents(project.id), api.tasks(project.id)])
      .then(([a, d, t]) => {
        if (cancelled) return;
        setAgents(a);
        setDocuments(d);
        setTasks(t);
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  const agentsByType = useMemo(() => groupCount(agents ?? [], (a) => a.type), [agents]);
  const docsByType = useMemo(() => groupCount(documents ?? [], (d) => d.type), [documents]);
  const tasksByStatus = useMemo(
    () => groupCount(tasks ?? [], (t) => t.status ?? 'unknown'),
    [tasks],
  );
  const tasksByCycle = useMemo(() => groupCount(tasks ?? [], (t) => t.cycle), [tasks]);

  const agentsByTypeChart = agentsByType.map(([type, count]) => ({ type, count, fill: fill(type) }));

  const filteredAgents = useMemo(
    () =>
      (agents ?? []).filter(
        (a) =>
          includesCi(a.name, filter) ||
          includesCi(a.description, filter) ||
          includesCi(a.file_path, filter) ||
          includesCi(a.type, filter),
      ),
    [agents, filter],
  );

  const filteredDocs = useMemo(
    () =>
      (documents ?? []).filter(
        (d) =>
          includesCi(d.title, filter) || includesCi(d.file_path, filter) || includesCi(d.type, filter),
      ),
    [documents, filter],
  );

  const filteredTasks = useMemo(() => {
    const base = (tasks ?? []).filter(
      (t) =>
        includesCi(t.task_code, filter) ||
        includesCi(t.title, filter) ||
        includesCi(t.cycle, filter),
    );
    if (statusFilter === 'all') return base;
    return base.filter((t) => (t.status ?? 'unknown') === statusFilter);
  }, [tasks, filter, statusFilter]);

  return (
    <>
      <div className="mt-4 overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
        <header className="flex items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-100">{project.name}</p>
            <p className="truncate font-mono text-[11px] text-slate-500">{project.path}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-400 hover:bg-slate-800 hover:text-slate-100"
          >
            Cerrar
          </button>
        </header>

        <section className="grid grid-cols-1 gap-3 border-b border-slate-800 px-4 py-3 lg:grid-cols-[1.2fr_1fr_1fr_1fr]">
          <div className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Agentes por tipo
            </p>
            <div className="mt-2 h-32 w-full">
              {agentsByTypeChart.length === 0 ? (
                <p className="text-[12px] text-slate-600">—</p>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={agentsByTypeChart} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                    <XAxis
                      dataKey="type"
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
                    <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                      {agentsByTypeChart.map((entry, idx) => (
                        <Cell key={idx} fill={entry.fill} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
          <BreakdownBlock title="Docs por tipo" entries={docsByType} colorize={badge} />
          <BreakdownBlock title="Tasks por estado" entries={tasksByStatus} colorize={statusBadge} />
          <BreakdownBlock title="Tasks por ciclo" entries={tasksByCycle} />
        </section>

        <nav className="flex items-center gap-1 border-b border-slate-800 px-2 pt-2">
          <TabButton
            active={tab === 'agents'}
            onClick={() => setTab('agents')}
            label={`Agents (${filteredAgents.length}/${project.agents_count})`}
          />
          <TabButton
            active={tab === 'documents'}
            onClick={() => setTab('documents')}
            label={`Documents (${filteredDocs.length}/${project.documents_count})`}
          />
          <TabButton
            active={tab === 'tasks'}
            onClick={() => setTab('tasks')}
            label={`Tasks (${filteredTasks.length}/${project.tasks_count})`}
          />
          <div className="ml-auto pr-2 pb-1">
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filtrar…"
              className="w-48 rounded-md border border-slate-800 bg-slate-950 px-2 py-1 text-[12px] text-slate-100 placeholder:text-slate-600 focus:border-cyan-500/50 focus:outline-none"
            />
          </div>
        </nav>

        {tab === 'tasks' && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-800 px-3 py-2">
            {(['all', 'done', 'in_progress', 'pending', 'unknown'] as StatusFilter[]).map((s) => {
              const count =
                s === 'all'
                  ? tasks?.length ?? 0
                  : (tasks ?? []).filter((t) => (t.status ?? 'unknown') === s).length;
              const isActive = statusFilter === s;
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatusFilter(s)}
                  className={`flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] transition-colors ${
                    isActive
                      ? 'bg-cyan-500/25 text-cyan-200'
                      : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <span>{STATUS_LABEL[s]}</span>
                  <span className="font-mono text-[10px] tabular-nums opacity-70">{count}</span>
                </button>
              );
            })}
          </div>
        )}

        <div className="max-h-[560px] overflow-y-auto">
          {error && <p className="px-4 py-6 text-xs text-rose-300">No se pudo cargar: {error}</p>}
          {!error && tab === 'agents' &&
            (agents == null ? (
              <Loading />
            ) : (
              <AgentsList
                projectId={project.id}
                items={filteredAgents}
                onOpenEntity={(t) => setOpenEntity(t)}
              />
            ))}
          {!error && tab === 'documents' &&
            (documents == null ? (
              <Loading />
            ) : (
              <DocsList items={filteredDocs} onOpenEntity={(t) => setOpenEntity(t)} />
            ))}
          {!error && tab === 'tasks' &&
            (tasks == null ? (
              <Loading />
            ) : (
              <TasksList items={filteredTasks} onOpenEntity={(t) => setOpenEntity(t)} />
            ))}
        </div>
      </div>

      {openEntity && (
        <EntityDrawer
          projectId={project.id}
          target={openEntity}
          onClose={() => setOpenEntity(null)}
          onOpenFile={(p) => setOpenFilePath(p)}
          onOpenEntity={(t) => setOpenEntity(t)}
        />
      )}
      {openFilePath && (
        <RawFileModal
          projectId={project.id}
          path={openFilePath}
          onClose={() => setOpenFilePath(null)}
        />
      )}
    </>
  );
}

function BreakdownBlock({
  title,
  entries,
  colorize,
}: {
  title: string;
  entries: Array<[string, number]>;
  colorize?: (key: string) => string;
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{title}</p>
      {entries.length === 0 && <p className="mt-1 text-[12px] text-slate-600">—</p>}
      <ul className="mt-1 space-y-0.5">
        {entries.map(([k, n]) => (
          <li key={k} className="flex items-center justify-between text-[12px]">
            <span
              className={`truncate rounded px-1.5 py-0.5 font-mono text-[10px] ${
                colorize ? colorize(k) : 'text-slate-400'
              }`}
              title={k}
            >
              {k}
            </span>
            <span className="ml-2 tabular-nums text-slate-200">{n}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative -mb-px rounded-t-md px-3 py-1.5 text-[12px] font-medium transition-colors ${
        active
          ? 'bg-slate-900 text-cyan-300 border-x border-t border-slate-800'
          : 'text-slate-400 hover:text-slate-200'
      }`}
    >
      {label}
    </button>
  );
}

function Loading() {
  return (
    <div className="space-y-2 p-4">
      <div className="h-4 w-2/3 animate-pulse rounded bg-slate-800" />
      <div className="h-4 w-1/2 animate-pulse rounded bg-slate-800" />
    </div>
  );
}

function AgentsList({
  projectId,
  items,
  onOpenEntity,
}: {
  projectId: string;
  items: AgentRead[];
  onOpenEntity: (target: EntityTarget) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [mentionsCache, setMentionsCache] = useState<Record<string, AgentMentionRead[] | null>>({});
  const [mentionsError, setMentionsError] = useState<Record<string, string>>({});

  const toggleMentions = (a: AgentRead, ev: React.MouseEvent) => {
    ev.stopPropagation();
    const next = expanded === a.id ? null : a.id;
    setExpanded(next);
    if (next && !(a.id in mentionsCache)) {
      setMentionsCache((prev) => ({ ...prev, [a.id]: null }));
      api
        .agentMentions(projectId, a.id)
        .then((rows) => setMentionsCache((prev) => ({ ...prev, [a.id]: rows })))
        .catch((e) => setMentionsError((prev) => ({ ...prev, [a.id]: e.message })));
    }
  };

  if (items.length === 0) return <Empty body="Sin agentes con ese filtro." />;
  return (
    <ul className="divide-y divide-slate-800">
      {items.map((a) => {
        const desc = cleanDescription(a.description);
        const isOpen = expanded === a.id;
        const mentions = mentionsCache[a.id];
        return (
          <li key={a.id} className="text-sm">
            <div className="px-4 py-3 hover:bg-slate-800/30">
              <div className="flex items-start justify-between gap-3">
                <button
                  type="button"
                  onClick={() => onOpenEntity({ kind: 'agent', agentId: a.id })}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-slate-100">{a.name}</p>
                    {a.tags.length > 0 && (
                      <span className="font-mono text-[10px] text-slate-500">
                        {a.tags.slice(0, 4).join(' · ')}
                      </span>
                    )}
                  </div>
                  {desc && (
                    <p className="mt-1 text-[12px] leading-relaxed text-slate-300">{desc}</p>
                  )}
                  <p className="mt-1 truncate font-mono text-[11px] text-slate-500">
                    {a.file_path}
                  </p>
                </button>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-mono ${badge(a.type)}`}>
                    {a.type}
                  </span>
                  <button
                    type="button"
                    onClick={(ev) => toggleMentions(a, ev)}
                    disabled={a.mentions_count === 0}
                    className={`rounded-full px-2 py-0.5 text-[10px] font-mono transition-colors ${
                      a.mentions_count === 0
                        ? 'bg-slate-800 text-slate-600 cursor-default'
                        : isOpen
                          ? 'bg-cyan-500/25 text-cyan-200'
                          : 'bg-slate-800 text-slate-300 hover:bg-cyan-500/15 hover:text-cyan-200'
                    }`}
                  >
                    {a.mentions_count} menciones
                  </button>
                </div>
              </div>
            </div>
            {isOpen && (
              <div className="border-t border-slate-800 bg-slate-950 px-6 py-3">
                {mentionsError[a.id] && (
                  <p className="text-[11px] text-rose-300">{mentionsError[a.id]}</p>
                )}
                {!mentionsError[a.id] && mentions == null && (
                  <p className="text-[11px] text-slate-500">Cargando…</p>
                )}
                {!mentionsError[a.id] && mentions && mentions.length === 0 && (
                  <p className="text-[11px] text-slate-500">Sin menciones.</p>
                )}
                {!mentionsError[a.id] && mentions && mentions.length > 0 && (
                  <ul className="space-y-1">
                    {mentions.slice(0, 80).map((m) => (
                      <li key={m.id} className="text-[12px]">
                        <div className="flex w-full items-start justify-between gap-3 rounded px-1 py-0.5">
                          <div className="min-w-0">
                            <p className="truncate font-mono text-[11px] text-slate-400">
                              {m.file_path}
                              {m.line_number != null && (
                                <span className="text-slate-600">:{m.line_number}</span>
                              )}
                            </p>
                            {m.snippet && (
                              <p className="mt-0.5 truncate text-[11px] text-slate-300">{m.snippet}</p>
                            )}
                          </div>
                          <span
                            className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-mono ${badge(
                              m.source_type,
                            )}`}
                          >
                            {m.source_type}
                          </span>
                        </div>
                      </li>
                    ))}
                    {mentions.length > 80 && (
                      <li className="text-[11px] text-slate-600">
                        + {mentions.length - 80} más…
                      </li>
                    )}
                  </ul>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function DocsList({
  items,
  onOpenEntity,
}: {
  items: SddDocumentRead[];
  onOpenEntity: (target: EntityTarget) => void;
}) {
  if (items.length === 0) return <Empty body="Sin documentos con ese filtro." />;
  const groups = new Map<string, SddDocumentRead[]>();
  for (const d of items) {
    const dir = d.file_path.split('/').slice(0, -1).join('/') || '(root)';
    const bucket = groups.get(dir) ?? [];
    bucket.push(d);
    groups.set(dir, bucket);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  return (
    <ul className="divide-y divide-slate-800">
      {ordered.map(([dir, docs]) => (
        <li key={dir} className="px-4 py-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="font-mono text-[11px] text-slate-500">{dir}/</span>
            <span className="text-[11px] text-slate-500">{docs.length}</span>
          </div>
          <ul className="space-y-1">
            {docs.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  onClick={() => onOpenEntity({ kind: 'document', documentId: d.id })}
                  className="flex w-full items-start justify-between gap-3 rounded-md px-2 py-1 text-left hover:bg-slate-800/40"
                >
                  <div className="min-w-0">
                    <p className="truncate text-[13px] text-slate-100">
                      {d.title ?? d.file_path}
                    </p>
                    <p className="truncate font-mono text-[11px] text-slate-500">{d.file_path}</p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-mono ${badge(d.type)}`}
                  >
                    {d.type}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

function TasksList({
  items,
  onOpenEntity,
}: {
  items: SddTaskRead[];
  onOpenEntity: (target: EntityTarget) => void;
}) {
  if (items.length === 0) return <Empty body="Sin tasks con ese filtro." />;
  return (
    <ul className="divide-y divide-slate-800">
      {items.map((t) => (
        <li key={t.id}>
          <button
            type="button"
            onClick={() => onOpenEntity({ kind: 'task', taskId: t.id })}
            className="grid w-full grid-cols-[80px_1fr_120px_auto] items-center gap-3 px-4 py-2 text-left text-sm hover:bg-slate-800/40"
          >
            <span className="font-mono text-[11px] text-cyan-300">{t.task_code ?? '—'}</span>
            <span className="truncate text-slate-100" title={t.title}>
              {t.title}
            </span>
            <span className="text-right font-mono text-[11px] text-slate-500">
              {t.cycle ?? '—'}
            </span>
            <span
              className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-mono ${statusBadge(t.status)}`}
            >
              {t.status ?? 'unknown'}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Empty({ body }: { body: string }) {
  return <p className="px-4 py-6 text-center text-xs text-slate-500">{body}</p>;
}
