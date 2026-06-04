import { useEffect, useState } from 'react';
import {
  api,
  type AgentRead,
  type AgentRelatedRead,
  type DocumentRelatedRead,
  type SddDocumentRead,
  type SddTaskRead,
  type TaskRelatedRead,
} from '../lib/api';

export type EntityTarget =
  | { kind: 'agent'; agentId: string }
  | { kind: 'document'; documentId: string }
  | { kind: 'task'; taskId: string };

interface Props {
  projectId: string;
  target: EntityTarget;
  onClose: () => void;
  onOpenFile: (path: string) => void;
  onOpenEntity: (next: EntityTarget) => void;
}

const STATUS_COLOR: Record<string, string> = {
  done: 'bg-emerald-500/15 text-emerald-300',
  in_progress: 'bg-amber-500/15 text-amber-300',
  pending: 'bg-slate-500/15 text-slate-300',
  unknown: 'bg-slate-500/15 text-slate-400',
};

function statusColor(s?: string | null): string {
  return STATUS_COLOR[s ?? 'unknown'] ?? STATUS_COLOR.unknown;
}

function copy(value: string) {
  void navigator.clipboard.writeText(value);
}

export function EntityDrawer({ projectId, target, onClose, onOpenFile, onOpenEntity }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [agentData, setAgentData] = useState<AgentRelatedRead | null>(null);
  const [docData, setDocData] = useState<DocumentRelatedRead | null>(null);
  const [taskData, setTaskData] = useState<TaskRelatedRead | null>(null);

  useEffect(() => {
    setError(null);
    setAgentData(null);
    setDocData(null);
    setTaskData(null);
    let cancelled = false;

    if (target.kind === 'agent') {
      api
        .agentRelated(projectId, target.agentId)
        .then((d) => !cancelled && setAgentData(d))
        .catch((e) => !cancelled && setError(e.message));
    } else if (target.kind === 'document') {
      api
        .documentRelated(projectId, target.documentId)
        .then((d) => !cancelled && setDocData(d))
        .catch((e) => !cancelled && setError(e.message));
    } else {
      api
        .taskRelated(projectId, target.taskId)
        .then((d) => !cancelled && setTaskData(d))
        .catch((e) => !cancelled && setError(e.message));
    }

    return () => {
      cancelled = true;
    };
  }, [projectId, target]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex" onClick={onClose}>
      <div className="ml-auto h-full w-full max-w-3xl border-l border-slate-800 bg-slate-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-full flex-col">
          <header className="flex items-start justify-between gap-3 border-b border-slate-800 px-5 py-3">
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                {target.kind === 'agent' && 'Agent'}
                {target.kind === 'document' && 'Document'}
                {target.kind === 'task' && 'Task'}
              </p>
              <p className="truncate text-sm font-semibold text-slate-100">
                {agentData?.agent.name ??
                  docData?.document.title ??
                  docData?.document.file_path ??
                  taskData?.task.title ??
                  'Cargando…'}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
            >
              Cerrar · Esc
            </button>
          </header>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            {error && <p className="text-xs text-rose-300">{error}</p>}

            {agentData && (
              <AgentDetail data={agentData} onOpenFile={onOpenFile} onOpenEntity={onOpenEntity} />
            )}
            {docData && (
              <DocumentDetail data={docData} onOpenFile={onOpenFile} onOpenEntity={onOpenEntity} />
            )}
            {taskData && (
              <TaskDetail data={taskData} onOpenFile={onOpenFile} onOpenEntity={onOpenEntity} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ───────────────────── Agent ─────────────────────

function AgentDetail({
  data,
  onOpenFile,
  onOpenEntity,
}: {
  data: AgentRelatedRead;
  onOpenFile: (path: string) => void;
  onOpenEntity: (next: EntityTarget) => void;
}) {
  const a = data.agent;
  return (
    <div className="space-y-5">
      <SectionFacts
        items={[
          ['Nombre', a.name],
          ['Tipo', a.type],
          ['Path', a.file_path],
          ['Tags', a.tags.length ? a.tags.join(' · ') : '—'],
          ['Menciones', String(a.mentions_count)],
          ['Ciclos', data.cycles.length ? data.cycles.join(' · ') : '—'],
        ]}
        onCopy={{ Path: a.file_path }}
        onOpen={{ Path: () => onOpenFile(a.file_path) }}
      />

      {a.description && (
        <section>
          <SectionTitle>Descripción</SectionTitle>
          <p className="text-[13px] leading-relaxed text-slate-300">{a.description}</p>
        </section>
      )}

      <RelatedDocuments items={data.documents} onOpenEntity={onOpenEntity} />
      <RelatedTasks items={data.tasks} onOpenEntity={onOpenEntity} />

      {data.runtime_sessions.length > 0 && (
        <section>
          <SectionTitle>Sesiones runtime referenciadas</SectionTitle>
          <ul className="space-y-1">
            {data.runtime_sessions.slice(0, 10).map((s) => (
              <li key={s} className="truncate font-mono text-[11px] text-slate-500" title={s}>
                {s}
              </li>
            ))}
            {data.runtime_sessions.length > 10 && (
              <li className="text-[11px] text-slate-600">+ {data.runtime_sessions.length - 10} más…</li>
            )}
          </ul>
        </section>
      )}

    </div>
  );
}

// ───────────────────── Document ─────────────────────

function DocumentDetail({
  data,
  onOpenFile,
  onOpenEntity,
}: {
  data: DocumentRelatedRead;
  onOpenFile: (path: string) => void;
  onOpenEntity: (next: EntityTarget) => void;
}) {
  const d = data.document;
  return (
    <div className="space-y-5">
      <SectionFacts
        items={[
          ['Tipo', d.type],
          ['Path', d.file_path],
          ['Título', d.title ?? '—'],
          ['Ciclo', data.cycle ?? '—'],
        ]}
        onCopy={{ Path: d.file_path }}
        onOpen={{ Path: () => onOpenFile(d.file_path) }}
      />
      <RelatedAgents items={data.agents} onOpenEntity={onOpenEntity} />
      <RelatedTasks items={data.tasks} onOpenEntity={onOpenEntity} />
    </div>
  );
}

// ───────────────────── Task ─────────────────────

function TaskDetail({
  data,
  onOpenFile,
  onOpenEntity,
}: {
  data: TaskRelatedRead;
  onOpenFile: (path: string) => void;
  onOpenEntity: (next: EntityTarget) => void;
}) {
  const t = data.task;
  return (
    <div className="space-y-5">
      <SectionFacts
        items={[
          ['Código', t.task_code ?? '—'],
          ['Título', t.title],
          ['Ciclo', t.cycle ?? '—'],
          [
            'Estado',
            t.status ? (
              <span className={`rounded px-2 py-0.5 text-[11px] font-mono ${statusColor(t.status)}`}>{t.status}</span>
            ) : (
              '—'
            ),
          ],
          ['Path', t.file_path ?? '—'],
        ]}
        onCopy={t.file_path ? { Path: t.file_path } : undefined}
        onOpen={t.file_path ? { Path: () => onOpenFile(t.file_path!) } : undefined}
      />
      <RelatedAgents items={data.agents} onOpenEntity={onOpenEntity} />
      <RelatedDocuments items={data.documents} onOpenEntity={onOpenEntity} />
    </div>
  );
}

// ───────────────────── Shared blocks ─────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <p className="label-track mb-2 text-slate-500">{children}</p>;
}

function SectionFacts({
  items,
  onCopy,
  onOpen,
}: {
  items: Array<[string, React.ReactNode]>;
  onCopy?: Record<string, string>;
  onOpen?: Record<string, () => void>;
}) {
  return (
    <section>
      <SectionTitle>Resumen</SectionTitle>
      <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-2.5 text-[13.5px]">
        {items.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-slate-500">{k}</dt>
            <dd className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className="min-w-0 max-w-full truncate text-slate-100"
                  title={typeof v === 'string' ? v : undefined}
                >
                  {v}
                </span>
                {onCopy?.[k] && (
                  <button
                    type="button"
                    onClick={() => copy(onCopy[k])}
                    className="shrink-0 rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1 text-[12px] font-medium text-slate-300 transition-colors hover:border-slate-600 hover:bg-slate-800 hover:text-slate-100"
                  >
                    Copiar
                  </button>
                )}
                {onOpen?.[k] && (
                  <button
                    type="button"
                    onClick={() => onOpen[k]()}
                    className="shrink-0 rounded-md border border-cyan-700/60 bg-cyan-500/10 px-3 py-1 text-[12px] font-semibold text-cyan-200 transition-colors hover:bg-cyan-500/20 hover:text-cyan-100"
                  >
                    Abrir →
                  </button>
                )}
              </div>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function RelatedAgents({
  items,
  onOpenEntity,
}: {
  items: AgentRead[];
  onOpenEntity: (next: EntityTarget) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section>
      <SectionTitle>Agentes relacionados ({items.length})</SectionTitle>
      <ul className="space-y-1">
        {items.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              onClick={() => onOpenEntity({ kind: 'agent', agentId: a.id })}
              className="flex w-full items-center justify-between gap-3 rounded px-2 py-1 text-left hover:bg-slate-800/60"
            >
              <span className="truncate text-[12px] text-slate-200">{a.name}</span>
              <span className="shrink-0 font-mono text-[10px] text-slate-500">{a.mentions_count} m</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RelatedDocuments({
  items,
  onOpenEntity,
}: {
  items: SddDocumentRead[];
  onOpenEntity: (next: EntityTarget) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section>
      <SectionTitle>Documentos relacionados ({items.length})</SectionTitle>
      <ul className="space-y-1">
        {items.slice(0, 50).map((d) => (
          <li key={d.id}>
            <button
              type="button"
              onClick={() => onOpenEntity({ kind: 'document', documentId: d.id })}
              className="flex w-full items-start justify-between gap-3 rounded px-2 py-1 text-left hover:bg-slate-800/60"
            >
              <div className="min-w-0">
                <p className="truncate text-[12px] text-slate-200">{d.title ?? d.file_path}</p>
                <p className="truncate font-mono text-[10px] text-slate-500">{d.file_path}</p>
              </div>
              <span className="shrink-0 rounded-full bg-slate-800 px-2 py-0.5 text-[10px] font-mono text-slate-400">
                {d.type}
              </span>
            </button>
          </li>
        ))}
        {items.length > 50 && (
          <li className="text-[11px] text-slate-600">+ {items.length - 50} más…</li>
        )}
      </ul>
    </section>
  );
}

function RelatedTasks({
  items,
  onOpenEntity,
}: {
  items: SddTaskRead[];
  onOpenEntity: (next: EntityTarget) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section>
      <SectionTitle>Tasks relacionadas ({items.length})</SectionTitle>
      <ul className="space-y-1">
        {items.slice(0, 50).map((t) => (
          <li key={t.id}>
            <button
              type="button"
              onClick={() => onOpenEntity({ kind: 'task', taskId: t.id })}
              className="grid w-full grid-cols-[80px_1fr_auto_auto] items-center gap-2 rounded px-2 py-1 text-left hover:bg-slate-800/60"
            >
              <span className="font-mono text-[11px] text-cyan-300">{t.task_code ?? '—'}</span>
              <span className="truncate text-[12px] text-slate-200" title={t.title}>
                {t.title}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-slate-500">{t.cycle ?? '—'}</span>
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-mono ${statusColor(t.status)}`}
              >
                {t.status ?? 'unknown'}
              </span>
            </button>
          </li>
        ))}
        {items.length > 50 && (
          <li className="text-[11px] text-slate-600">+ {items.length - 50} más…</li>
        )}
      </ul>
    </section>
  );
}

