import { useEffect, useMemo, useState } from 'react';
import {
  api,
  type FileContentRead,
  type FileInfo,
  type FileMention,
  type TreeNode,
} from '../lib/api';
import { EntityDrawer, type EntityTarget } from './EntityDrawer';
import { MarkdownView, isMarkdownPath } from './MarkdownView';
import { RawFileModal } from './RawFileModal';

interface Props {
  projectId: string;
}

type FilterKey = 'agent' | 'doc' | 'task' | 'mentions' | 'key';

const FILTERS: { key: FilterKey; label: string; badge: string; cls: string }[] = [
  { key: 'agent', label: 'Agents', badge: 'A', cls: 'bg-violet-500/20 text-violet-200 border-violet-500/40' },
  { key: 'doc', label: 'Docs', badge: 'D', cls: 'bg-cyan-500/20 text-cyan-200 border-cyan-500/40' },
  { key: 'task', label: 'Tasks', badge: 'T', cls: 'bg-emerald-500/20 text-emerald-200 border-emerald-500/40' },
  { key: 'mentions', label: 'Menciones', badge: '#', cls: 'bg-amber-500/20 text-amber-200 border-amber-500/40' },
  { key: 'key', label: 'Clave', badge: '★', cls: 'bg-sky-500/20 text-sky-200 border-sky-500/40' },
];

// Docs "importantes" del proceso SDD — match por nombre (case-insensitive).
const KEY_DOC_RE =
  /(constitution|constituci[oó]n|\bplan\b|context|charter|roadmap|principles|principios|glossary|glosario|agents?\.md|claude\.md|readme|spec|requirements|decisions-index|adr-)/i;

function isKeyDoc(name: string, path: string): boolean {
  return KEY_DOC_RE.test(name) || KEY_DOC_RE.test(path);
}

function nodeMatchesFilter(n: TreeNode, f: FilterKey): boolean {
  switch (f) {
    case 'agent':
      return n.has_agent;
    case 'doc':
      return n.has_doc;
    case 'task':
      return n.has_task;
    case 'mentions':
      return n.mentions > 0;
    case 'key':
      return n.type === 'file' && isKeyDoc(n.name, n.path);
  }
}

export function ExplorerPanel({ projectId }: Props) {
  const [modalPath, setModalPath] = useState<string | null>(null);
  const [entity, setEntity] = useState<EntityTarget | null>(null);
  const onOpenFile = (p: string) => setModalPath(p);
  const onOpenEntity = (e: EntityTarget) => setEntity(e);
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<Set<FilterKey>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setTree(null);
    setError(null);
    setSelectedPath(null);
    api
      .tree(projectId, 6)
      .then((t) => !cancelled && setTree(t))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const toggleFilter = (f: FilterKey) => {
    setFilters((prev) => {
      const next = new Set(prev);
      next.has(f) ? next.delete(f) : next.add(f);
      return next;
    });
  };

  const filtered = useMemo(() => {
    if (!tree) return null;
    const q = query.trim().toLowerCase();
    const activeFilters = Array.from(filters);
    if (!q && activeFilters.length === 0) return tree;

    const prune = (node: TreeNode): TreeNode | null => {
      if (node.type === 'file') {
        const textOk = !q || node.path.toLowerCase().includes(q) || node.name.toLowerCase().includes(q);
        // OR entre filtros: el archivo pasa si cumple alguno de los activos.
        const filterOk =
          activeFilters.length === 0 || activeFilters.some((f) => nodeMatchesFilter(node, f));
        return textOk && filterOk ? node : null;
      }
      const kept = (node.children ?? []).map(prune).filter(Boolean) as TreeNode[];
      if (kept.length === 0) return null;
      return { ...node, children: kept };
    };
    return prune(tree) ?? { ...tree, children: [] };
  }, [tree, query, filters]);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <div className="card-elev flex flex-col overflow-hidden">
        <header className="space-y-2.5 border-b border-slate-800/80 px-4 py-3">
          <div className="flex items-baseline justify-between">
            <p className="text-[13px] font-semibold text-slate-100">Explorer</p>
            <p className="text-[11px] text-slate-500">{tree?.file_count ?? '…'} archivos</p>
          </div>
          <input
            type="text"
            placeholder="Filtrar por nombre / path"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-md border border-slate-700/70 bg-slate-950 px-3 py-1.5 text-[12.5px] text-slate-100 placeholder-slate-600 focus:border-cyan-500 focus:outline-none"
          />
          <div className="flex flex-wrap gap-1.5">
            {FILTERS.map((f) => {
              const active = filters.has(f.key);
              return (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => toggleFilter(f.key)}
                  className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ${
                    active
                      ? f.cls
                      : 'border-slate-800 bg-slate-950/60 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                  }`}
                >
                  <span className="font-mono text-[10px]">{f.badge}</span>
                  {f.label}
                </button>
              );
            })}
            {filters.size > 0 && (
              <button
                type="button"
                onClick={() => setFilters(new Set())}
                className="rounded-md px-2 py-1 text-[11px] text-slate-500 hover:text-slate-300"
              >
                limpiar
              </button>
            )}
          </div>
        </header>
        {error && <p className="px-3 py-2 text-xs text-rose-300">{error}</p>}
        {!error && !filtered && <Skeleton rows={12} />}
        {filtered && (
          <div className="max-h-[640px] flex-1 overflow-y-auto px-2 py-2">
            <TreeNodeRow
              node={filtered}
              depth={0}
              selectedPath={selectedPath}
              onSelect={(p) => setSelectedPath(p)}
              autoExpand={query.trim().length > 0 || filters.size > 0}
            />
          </div>
        )}
      </div>

      <div className="card-elev overflow-hidden">
        {selectedPath ? (
          <FilePreview
            projectId={projectId}
            path={selectedPath}
            onOpenFile={onOpenFile}
            onOpenEntity={onOpenEntity}
          />
        ) : (
          <div className="flex h-[320px] items-center justify-center px-4 text-center text-[13px] text-slate-500">
            Seleccioná un archivo para ver su contenido + agents, docs, tasks y mentions.
          </div>
        )}
      </div>

      {modalPath && (
        <RawFileModal projectId={projectId} path={modalPath} onClose={() => setModalPath(null)} />
      )}
      {entity && (
        <EntityDrawer
          projectId={projectId}
          target={entity}
          onClose={() => setEntity(null)}
          onOpenFile={onOpenFile}
          onOpenEntity={setEntity}
        />
      )}
    </div>
  );
}

function TreeNodeRow({
  node,
  depth,
  selectedPath,
  onSelect,
  autoExpand,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  autoExpand: boolean;
}) {
  const [expanded, setExpanded] = useState<boolean>(depth < 1 || autoExpand);
  const isFile = node.type === 'file';
  const isSelected = isFile && selectedPath === node.path;

  // Re-expandir si entra en modo filtro.
  useEffect(() => {
    if (autoExpand) setExpanded(true);
  }, [autoExpand]);

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          if (isFile) onSelect(node.path);
          else setExpanded((v) => !v);
        }}
        className={`flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[13px] transition-colors hover:bg-slate-800/50 ${
          isSelected ? 'bg-cyan-500/15 text-cyan-200 ring-1 ring-inset ring-cyan-500/25' : 'text-slate-300'
        }`}
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
      >
        <span className="w-3 shrink-0 font-mono text-[11px] text-slate-600">
          {isFile ? '' : expanded ? '▾' : '▸'}
        </span>
        <span className={`truncate ${isFile ? '' : 'font-medium text-slate-200'}`}>{node.name}</span>
        <HeatBadges node={node} />
      </button>
      {!isFile && expanded && node.children && node.children.length > 0 && (
        <div>
          {node.children.map((c) => (
            <TreeNodeRow
              key={c.path || c.name}
              node={c}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
              autoExpand={autoExpand}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function HeatBadges({ node }: { node: TreeNode }) {
  const badges: { b: string; cls: string }[] = [];
  if (node.has_agent) badges.push({ b: 'A', cls: 'bg-violet-500/20 text-violet-200' });
  if (node.has_doc) badges.push({ b: 'D', cls: 'bg-cyan-500/20 text-cyan-200' });
  if (node.has_task) badges.push({ b: 'T', cls: 'bg-emerald-500/20 text-emerald-200' });
  return (
    <span className="ml-auto flex items-center gap-1 pl-1 font-mono text-[10px] text-slate-500">
      {badges.map((x) => (
        <span key={x.b} className={`rounded px-1 ${x.cls}`}>
          {x.b}
        </span>
      ))}
      {node.mentions > 0 && <span className="text-amber-300/80">{node.mentions}</span>}
    </span>
  );
}

// ───────────────────── File preview (contenido + cross-info) ─────────────────────

function FilePreview({
  projectId,
  path,
  onOpenFile,
  onOpenEntity,
}: {
  projectId: string;
  path: string;
  onOpenFile: (p: string) => void;
  onOpenEntity: (e: EntityTarget) => void;
}) {
  const [info, setInfo] = useState<FileInfo | null>(null);
  const [content, setContent] = useState<FileContentRead | null>(null);
  const [mentions, setMentions] = useState<FileMention[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'content' | 'mentions'>('content');

  useEffect(() => {
    let cancelled = false;
    setInfo(null);
    setContent(null);
    setMentions(null);
    setError(null);
    setTab('content');
    api
      .fileInfo(projectId, path)
      .then((f) => !cancelled && setInfo(f))
      .catch((e) => !cancelled && setError(e.message));
    api
      .fileContent(projectId, path)
      .then((c) => !cancelled && setContent(c))
      .catch(() => {
        /* binario o no legible — sin preview */
      });
    api
      .fileMentions(projectId, path)
      .then((m) => !cancelled && setMentions(m))
      .catch(() => !cancelled && setMentions([]));
    return () => {
      cancelled = true;
    };
  }, [projectId, path]);

  if (error) return <p className="px-4 py-3 text-xs text-rose-300">{error}</p>;

  const isMd = isMarkdownPath(path);
  const mentionCount = mentions?.length ?? info?.mentions ?? 0;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-slate-800/80 px-4 py-2.5">
        <p className="truncate font-mono text-[12px] text-slate-300" title={path}>
          {path}
        </p>
        <button
          type="button"
          onClick={() => onOpenFile(path)}
          className="shrink-0 rounded-md border border-cyan-700/60 bg-cyan-500/10 px-2.5 py-1 text-[11px] font-semibold text-cyan-200 hover:bg-cyan-500/20"
        >
          Abrir →
        </button>
      </header>

      {/* Cross-info compacta */}
      {info && <CrossInfoBar info={info} onOpenEntity={onOpenEntity} />}

      {/* Tabs: contenido / menciones */}
      <div className="flex items-center gap-1 border-b border-slate-800/60 px-3 py-1.5">
        <TabBtn active={tab === 'content'} onClick={() => setTab('content')}>
          Contenido
        </TabBtn>
        <TabBtn active={tab === 'mentions'} onClick={() => setTab('mentions')}>
          Menciones{mentionCount > 0 ? ` · ${mentionCount}` : ''}
        </TabBtn>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'content' ? (
          content == null && !error ? (
            <Skeleton rows={8} />
          ) : content ? (
            isMd ? (
              <div className="px-5 py-4">
                <MarkdownView source={content.content} />
              </div>
            ) : (
              <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-[12px] leading-relaxed text-slate-300">
                {content.content}
              </pre>
            )
          ) : (
            <p className="px-4 py-6 text-center text-[12px] text-slate-500">
              Sin preview de contenido (binario o no legible).
            </p>
          )
        ) : (
          <MentionsList mentions={mentions} onOpenEntity={onOpenEntity} />
        )}
      </div>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-3 py-1 text-[12px] font-medium transition-colors ${
        active ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'
      }`}
    >
      {children}
    </button>
  );
}

const MENTION_TONE: Record<string, string> = {
  docs: 'text-cyan-300',
  spec: 'text-cyan-300',
  tasks: 'text-emerald-300',
};

function MentionsList({
  mentions,
  onOpenEntity,
}: {
  mentions: FileMention[] | null;
  onOpenEntity: (e: EntityTarget) => void;
}) {
  if (mentions == null) return <Skeleton rows={6} />;
  if (mentions.length === 0)
    return (
      <p className="px-4 py-6 text-center text-[12px] text-slate-500">
        Este archivo no menciona agentes.
      </p>
    );

  // Agrupar por agente para "contra quién".
  const byAgent = new Map<string, FileMention[]>();
  for (const m of mentions) {
    const arr = byAgent.get(m.agent_name) ?? [];
    arr.push(m);
    byAgent.set(m.agent_name, arr);
  }

  return (
    <div className="divide-y divide-slate-800/50">
      {Array.from(byAgent.entries()).map(([agent, list]) => (
        <div key={agent} className="px-4 py-3">
          <button
            type="button"
            onClick={() => onOpenEntity({ kind: 'agent', agentId: list[0].agent_id })}
            className="flex items-center gap-2 text-[13px] font-semibold text-violet-200 hover:text-violet-100"
          >
            <span className="h-2 w-2 rounded-full bg-violet-400" />
            {agent}
            <span className="font-mono text-[11px] text-slate-500">×{list.length}</span>
          </button>
          <ul className="mt-2 space-y-1.5">
            {list.map((m, i) => (
              <li key={i} className="flex gap-2 text-[12px]">
                <span className="shrink-0 font-mono text-[10px] text-slate-600">
                  {m.line_number != null ? `L${m.line_number}` : '—'}
                </span>
                <span className={`min-w-0 flex-1 ${MENTION_TONE[m.source_type] ?? 'text-slate-400'}`}>
                  <span className="text-slate-300">{m.snippet || '(sin contexto)'}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function CrossInfoBar({
  info,
  onOpenEntity,
}: {
  info: FileInfo;
  onOpenEntity: (e: EntityTarget) => void;
}) {
  const empty =
    info.agents.length === 0 && info.documents.length === 0 && info.tasks.length === 0;
  if (empty && info.mentions === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-slate-800/60 bg-slate-950/40 px-4 py-2.5">
      <span className="font-mono text-[10px] text-slate-500">
        {info.size_bytes.toLocaleString()} B
      </span>
      {info.mentions > 0 && (
        <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-200">
          {info.mentions} menciones
        </span>
      )}
      {info.agents.map((a) => (
        <Chip key={a.id} tone="violet" onClick={() => onOpenEntity({ kind: 'agent', agentId: a.id })}>
          {a.name}
        </Chip>
      ))}
      {info.documents.map((d) => (
        <Chip
          key={d.id}
          tone="cyan"
          onClick={() => onOpenEntity({ kind: 'document', documentId: d.id })}
        >
          {d.title || d.type}
        </Chip>
      ))}
      {info.tasks.map((t) => (
        <Chip key={t.id} tone="emerald" onClick={() => onOpenEntity({ kind: 'task', taskId: t.id })}>
          {t.title}
        </Chip>
      ))}
    </div>
  );
}

function Chip({
  children,
  onClick,
  tone,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  tone: 'violet' | 'cyan' | 'emerald';
}) {
  const cls =
    tone === 'violet'
      ? 'bg-violet-500/15 text-violet-200 hover:bg-violet-500/25'
      : tone === 'cyan'
        ? 'bg-cyan-500/15 text-cyan-200 hover:bg-cyan-500/25'
        : 'bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`max-w-[200px] truncate rounded px-2 py-0.5 text-[11px] ${cls}`}
    >
      {children}
    </button>
  );
}

function Skeleton({ rows }: { rows: number }) {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-4 w-full animate-pulse rounded bg-slate-800" />
      ))}
    </div>
  );
}
