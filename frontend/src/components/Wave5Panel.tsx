import { useEffect, useState } from 'react';
import {
  api,
  type ArchSignal,
  type ArchitectureProfile,
  type CorrelationCard,
  type SearchHit,
} from '../lib/api';
import { EntityDrawer, type EntityTarget } from './EntityDrawer';
import { RawFileModal } from './RawFileModal';

interface Props {
  projectId: string;
}

type Tab = 'correlation' | 'architecture' | 'search';

const TAB_LABEL: Record<Tab, string> = {
  correlation: 'Correlation',
  architecture: 'Architecture',
  search: 'Search',
};

export function Wave5Panel({ projectId }: Props) {
  const [tab, setTab] = useState<Tab>('correlation');
  const [modalPath, setModalPath] = useState<string | null>(null);
  const [entity, setEntity] = useState<EntityTarget | null>(null);

  return (
    <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
      <header className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
        <p className="text-[12px] font-semibold text-slate-200">Inferencia y búsqueda</p>
        <nav className="flex rounded border border-slate-800 text-[11px]">
          {(Object.keys(TAB_LABEL) as Tab[]).map((k, i) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={`px-2 py-1 ${
                tab === k
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-400 hover:bg-slate-800/60'
              } ${i > 0 ? 'border-l border-slate-800' : ''}`}
            >
              {TAB_LABEL[k]}
            </button>
          ))}
        </nav>
      </header>
      <div className="p-3">
        {tab === 'correlation' && (
          <CorrelationView
            projectId={projectId}
            onOpenFile={setModalPath}
            onOpenEntity={setEntity}
          />
        )}
        {tab === 'architecture' && <ArchitectureView projectId={projectId} />}
        {tab === 'search' && (
          <SearchView projectId={projectId} onOpenEntity={setEntity} />
        )}
      </div>

      {modalPath && (
        <RawFileModal
          projectId={projectId}
          path={modalPath}
          onClose={() => setModalPath(null)}
        />
      )}
      {entity && (
        <EntityDrawer
          projectId={projectId}
          target={entity}
          onClose={() => setEntity(null)}
          onOpenFile={(p) => setModalPath(p)}
          onOpenEntity={setEntity}
        />
      )}
    </div>
  );
}

// ───────────────────── Correlation ─────────────────────

function CorrelationView({
  projectId,
  onOpenFile,
  onOpenEntity,
}: {
  projectId: string;
  onOpenFile: (p: string) => void;
  onOpenEntity: (e: EntityTarget) => void;
}) {
  const [rows, setRows] = useState<CorrelationCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let c = false;
    setRows(null);
    setError(null);
    api
      .correlation(projectId, 30)
      .then((r) => !c && setRows(r))
      .catch((e) => !c && setError(e.message));
    return () => {
      c = true;
    };
  }, [projectId]);

  if (error) return <Err msg={error} />;
  if (!rows) return <Skel rows={4} />;
  if (rows.length === 0) {
    return (
      <p className="text-[12px] text-slate-500">
        No hay archivos con cross-info detectada (sin mentions sobre paths reales).
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {rows.map((c) => (
        <li key={c.file_path} className="rounded border border-slate-800 bg-slate-950 p-3">
          <header className="mb-2 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => onOpenFile(c.file_path)}
              className="truncate font-mono text-[11px] text-cyan-300 hover:underline"
            >
              {c.file_path}
            </button>
            <div className="flex gap-1">
              {c.cycles_touched.map((cy) => (
                <span
                  key={cy}
                  className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-300"
                >
                  {cy}
                </span>
              ))}
            </div>
          </header>
          <div className="grid gap-2 md:grid-cols-3">
            <ChipGroup
              label="Agents"
              items={c.agents.map((a) => ({
                key: a.id,
                label: `${a.name} · ${a.mentions}`,
                onClick: () => onOpenEntity({ kind: 'agent', agentId: a.id }),
              }))}
              tone="violet"
            />
            <ChipGroup
              label="Tasks"
              items={c.tasks.map((t) => ({
                key: t.id,
                label: `${t.task_code ?? ''} ${t.title}`.trim(),
                onClick: () => onOpenEntity({ kind: 'task', taskId: t.id }),
              }))}
              tone="emerald"
            />
            <ChipGroup
              label="Docs"
              items={c.documents.map((d) => ({
                key: d.id,
                label: d.title || d.type,
                onClick: () => onOpenEntity({ kind: 'document', documentId: d.id }),
              }))}
              tone="cyan"
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function ChipGroup({
  label,
  items,
  tone,
}: {
  label: string;
  items: { key: string; label: string; onClick: () => void }[];
  tone: 'violet' | 'cyan' | 'emerald';
}) {
  const cls =
    tone === 'violet'
      ? 'bg-violet-500/15 text-violet-200 hover:bg-violet-500/25'
      : tone === 'cyan'
        ? 'bg-cyan-500/15 text-cyan-200 hover:bg-cyan-500/25'
        : 'bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25';
  return (
    <div>
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        {label} ({items.length})
      </p>
      <div className="flex flex-wrap gap-1">
        {items.length === 0 && <span className="text-[10px] text-slate-600">—</span>}
        {items.slice(0, 6).map((i) => (
          <button
            key={i.key}
            type="button"
            onClick={i.onClick}
            className={`max-w-full truncate rounded px-1.5 py-0.5 text-[10px] ${cls}`}
            title={i.label}
          >
            {i.label}
          </button>
        ))}
        {items.length > 6 && (
          <span className="text-[10px] text-slate-500">+ {items.length - 6}</span>
        )}
      </div>
    </div>
  );
}

// ───────────────────── Architecture ─────────────────────

function ArchitectureView({ projectId }: { projectId: string }) {
  const [data, setData] = useState<ArchitectureProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let c = false;
    setData(null);
    setError(null);
    api
      .architecture(projectId)
      .then((d) => !c && setData(d))
      .catch((e) => !c && setError(e.message));
    return () => {
      c = true;
    };
  }, [projectId]);

  if (error) return <Err msg={error} />;
  if (!data) return <Skel rows={5} />;

  return (
    <div className="space-y-4">
      <Block title="Lenguajes">
        <div className="flex flex-wrap gap-1.5">
          {data.languages.length === 0 && <span className="text-[11px] text-slate-500">—</span>}
          {data.languages.map((l) => (
            <span
              key={l}
              className="rounded bg-slate-800 px-2 py-0.5 font-mono text-[11px] text-slate-200"
            >
              {l}
            </span>
          ))}
        </div>
      </Block>
      <Block title="Frameworks">
        <SignalList items={data.frameworks} />
      </Block>
      <Block title="Patrones">
        <SignalList items={data.patterns} />
      </Block>
      <Block title="Deployment">
        <SignalList items={data.deployment} />
      </Block>
    </div>
  );
}

function SignalList({ items }: { items: ArchSignal[] }) {
  if (items.length === 0) return <span className="text-[11px] text-slate-500">— sin señales detectadas</span>;
  return (
    <ul className="space-y-1">
      {items.map((s) => (
        <li key={s.label} className="flex items-baseline justify-between gap-2 text-[11px]">
          <span className="flex items-center gap-2">
            <span className="font-mono font-semibold text-slate-100">{s.label}</span>
            <span className="text-slate-500">{s.evidence[0]}</span>
            {s.evidence.length > 1 && (
              <span className="text-slate-600">+{s.evidence.length - 1}</span>
            )}
          </span>
          <span className="h-1.5 w-16 overflow-hidden rounded bg-slate-800">
            <span
              className={`block h-full ${
                s.confidence >= 100
                  ? 'bg-emerald-500'
                  : s.confidence >= 70
                    ? 'bg-amber-500'
                    : 'bg-slate-500'
              }`}
              style={{ width: `${s.confidence}%` }}
            />
          </span>
        </li>
      ))}
    </ul>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        {title}
      </p>
      {children}
    </section>
  );
}

// ───────────────────── Search ─────────────────────

const KIND_STYLE: Record<SearchHit['kind'], string> = {
  agent: 'bg-violet-500/15 text-violet-200',
  document: 'bg-cyan-500/15 text-cyan-200',
  task: 'bg-emerald-500/15 text-emerald-200',
  mention: 'bg-slate-700 text-slate-200',
};

function SearchView({
  projectId,
  onOpenEntity,
}: {
  projectId: string;
  onOpenEntity: (e: EntityTarget) => void;
}) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (q.trim().length < 2) {
      setHits(null);
      setError(null);
      return;
    }
    let c = false;
    setError(null);
    const tid = setTimeout(() => {
      api
        .search(projectId, q.trim())
        .then((r) => !c && setHits(r))
        .catch((e) => !c && setError(e.message));
    }, 250);
    return () => {
      c = true;
      clearTimeout(tid);
    };
  }, [projectId, q]);

  return (
    <div className="space-y-3">
      <input
        type="text"
        value={q}
        autoFocus
        onChange={(e) => setQ(e.target.value)}
        placeholder='Buscar "idempotency", "cvu", "wrapper"…'
        className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-[12px] text-slate-100 placeholder-slate-600 focus:border-slate-500 focus:outline-none"
      />
      {error && <Err msg={error} />}
      {hits === null && q.length >= 2 && <Skel rows={4} />}
      {hits && hits.length === 0 && (
        <p className="text-[12px] text-slate-500">Sin resultados para "{q}".</p>
      )}
      {hits && hits.length > 0 && (
        <ul className="space-y-1">
          {hits.map((h) => (
            <li key={`${h.kind}-${h.id}`}>
              <button
                type="button"
                onClick={() => {
                  if (h.kind === 'agent') onOpenEntity({ kind: 'agent', agentId: h.id });
                  else if (h.kind === 'document')
                    onOpenEntity({ kind: 'document', documentId: h.id });
                  else if (h.kind === 'task') onOpenEntity({ kind: 'task', taskId: h.id });
                }}
                className="block w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-left text-[12px] hover:border-slate-600"
              >
                <div className="flex items-start gap-2">
                  <span
                    className={`rounded px-1.5 py-0.5 font-mono text-[9px] ${KIND_STYLE[h.kind]}`}
                  >
                    {h.kind}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-slate-100">{h.label}</p>
                    {h.subtitle && (
                      <p className="mt-0.5 truncate font-mono text-[10px] text-slate-500">
                        {h.subtitle}
                      </p>
                    )}
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ───────────────────── Shared ─────────────────────

function Skel({ rows }: { rows: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-4 w-full animate-pulse rounded bg-slate-800" />
      ))}
    </div>
  );
}

function Err({ msg }: { msg: string }) {
  return <p className="text-[12px] text-rose-300">No se pudo cargar: {msg}</p>;
}
