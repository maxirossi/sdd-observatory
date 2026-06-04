import { useEffect, useState } from 'react';
import {
  api,
  type CoverageRow,
  type DeadAgentRow,
  type DependencyGraph,
  type ScopeDriftRow,
} from '../lib/api';

interface Props {
  projectId: string;
}

type Tab = 'dep' | 'drift' | 'dead' | 'coverage';

const TAB_LABEL: Record<Tab, string> = {
  dep: 'Dependency graph',
  drift: 'Scope drift',
  dead: 'Dead agents',
  coverage: 'Coverage matrix',
};

export function IntelligencePanel({ projectId }: Props) {
  const [tab, setTab] = useState<Tab>('coverage');

  return (
    <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
      <header className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
        <p className="text-[12px] font-semibold text-slate-200">Intelligence</p>
        <nav className="flex rounded border border-slate-800 text-[11px]">
          {(Object.keys(TAB_LABEL) as Tab[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={`px-2 py-1 ${
                tab === k
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-400 hover:bg-slate-800/60'
              } ${k !== 'dep' ? 'border-l border-slate-800' : ''}`}
            >
              {TAB_LABEL[k]}
            </button>
          ))}
        </nav>
      </header>
      <div className="p-3">
        {tab === 'dep' && <DepView projectId={projectId} />}
        {tab === 'drift' && <DriftView projectId={projectId} />}
        {tab === 'dead' && <DeadView projectId={projectId} />}
        {tab === 'coverage' && <CoverageView projectId={projectId} />}
      </div>
    </div>
  );
}

// ───────────────────── Dependency graph ─────────────────────

function DepView({ projectId }: { projectId: string }) {
  const [data, setData] = useState<DependencyGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let c = false;
    setData(null);
    setError(null);
    api
      .dependencyGraph(projectId)
      .then((d) => !c && setData(d))
      .catch((e) => !c && setError(e.message));
    return () => {
      c = true;
    };
  }, [projectId]);

  if (error) return <Err msg={error} />;
  if (!data) return <Skel rows={6} />;

  const byCode = new Map(data.nodes.map((n) => [n.task_code?.toUpperCase(), n]));
  const grouped = new Map<string, string[]>();
  for (const e of data.edges) {
    const src = data.nodes.find((n) => n.id === e.source);
    const key = src?.task_code ?? src?.title ?? 'desconocida';
    const arr = grouped.get(key) ?? [];
    arr.push(e.target_code);
    grouped.set(key, arr);
  }
  const rows = Array.from(grouped.entries()).sort(
    (a, b) => b[1].length - a[1].length,
  );

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-slate-500">
        {data.nodes.length} tasks · {data.edges.length} refs detectadas ·{' '}
        {data.unresolved_codes.length} codes sin task asociada.
      </p>
      <ul className="space-y-1 text-[12px]">
        {rows.slice(0, 25).map(([src, targets]) => (
          <li key={src} className="flex items-baseline gap-2">
            <span className="w-24 truncate font-mono text-[11px] text-slate-200">{src}</span>
            <span className="text-slate-600">→</span>
            <span className="flex flex-wrap gap-1">
              {Array.from(new Set(targets)).slice(0, 12).map((t) => {
                const found = byCode.get(t.toUpperCase());
                return (
                  <span
                    key={t}
                    className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                      found
                        ? 'bg-emerald-500/15 text-emerald-200'
                        : 'bg-slate-800 text-slate-500'
                    }`}
                    title={found ? `→ ${found.title}` : 'sin task asociada'}
                  >
                    {t}
                  </span>
                );
              })}
              {targets.length > 12 && (
                <span className="text-[10px] text-slate-600">+ {targets.length - 12}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ───────────────────── Scope drift ─────────────────────

function DriftView({ projectId }: { projectId: string }) {
  const [rows, setRows] = useState<ScopeDriftRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let c = false;
    setRows(null);
    setError(null);
    api
      .scopeDrift(projectId)
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
        No hay tasks con mentions asociadas todavía. Sin drift evaluable.
      </p>
    );
  }
  const drifted = rows.filter((r) => r.drift);
  return (
    <div className="space-y-3">
      <p className="text-[11px] text-slate-500">
        {rows.length} tasks evaluadas · {drifted.length} con drift.
      </p>
      <ul className="space-y-2 text-[12px]">
        {rows.map((r) => (
          <li
            key={r.task_id}
            className={`rounded border px-3 py-2 ${
              r.drift
                ? 'border-amber-700/60 bg-amber-500/5'
                : 'border-slate-800 bg-slate-950'
            }`}
          >
            <div className="flex items-baseline justify-between">
              <p className="font-mono text-[11px] text-slate-200">
                {r.task_code ?? '—'} <span className="text-slate-500">·</span>{' '}
                <span className="text-slate-400">{r.title}</span>
              </p>
              <span
                className={`rounded px-2 py-0.5 font-mono text-[10px] ${
                  r.drift
                    ? 'bg-amber-500/20 text-amber-200'
                    : 'bg-emerald-500/20 text-emerald-200'
                }`}
              >
                {r.drift ? 'DRIFT' : 'OK'}
              </span>
            </div>
            <p className="mt-1 font-mono text-[10px] text-slate-500">
              expected: <span className="text-slate-400">{r.expected_prefix}</span>
            </p>
            <ul className="mt-1 space-y-0.5">
              {r.actual_paths.slice(0, 6).map((p) => (
                <li key={p} className="truncate font-mono text-[10px] text-slate-400">
                  • {p}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ───────────────────── Dead agents ─────────────────────

const DEAD_CLASS_STYLE: Record<DeadAgentRow['classification'], string> = {
  active: 'bg-emerald-500/15 text-emerald-200',
  runtime_only: 'bg-cyan-500/15 text-cyan-200',
  declared_only: 'bg-amber-500/15 text-amber-200',
  inactive: 'bg-rose-500/15 text-rose-200',
};

function DeadView({ projectId }: { projectId: string }) {
  const [rows, setRows] = useState<DeadAgentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let c = false;
    setRows(null);
    setError(null);
    api
      .deadAgents(projectId)
      .then((r) => !c && setRows(r))
      .catch((e) => !c && setError(e.message));
    return () => {
      c = true;
    };
  }, [projectId]);

  if (error) return <Err msg={error} />;
  if (!rows) return <Skel rows={6} />;

  const totals = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.classification] = (acc[r.classification] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 text-[11px]">
        {(['active', 'declared_only', 'runtime_only', 'inactive'] as const).map((k) => (
          <span
            key={k}
            className={`rounded px-2 py-0.5 font-mono ${DEAD_CLASS_STYLE[k]}`}
          >
            {k}: {totals[k] ?? 0}
          </span>
        ))}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead className="text-left text-[10px] uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-2 py-1">Agent</th>
              <th className="px-2 py-1">Tipo</th>
              <th className="px-2 py-1 text-right">Doc</th>
              <th className="px-2 py-1 text-right">Runtime</th>
              <th className="px-2 py-1">Estado</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.agent_id} className="border-t border-slate-800">
                <td className="truncate px-2 py-1 text-slate-200">{r.name}</td>
                <td className="px-2 py-1 font-mono text-[10px] text-slate-500">{r.type}</td>
                <td className="px-2 py-1 text-right tabular-nums text-slate-400">
                  {r.doc_mentions}
                </td>
                <td className="px-2 py-1 text-right tabular-nums text-violet-300">
                  {r.runtime_mentions}
                </td>
                <td className="px-2 py-1">
                  <span
                    className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                      DEAD_CLASS_STYLE[r.classification]
                    }`}
                  >
                    {r.classification}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ───────────────────── Coverage matrix ─────────────────────

function CoverageView({ projectId }: { projectId: string }) {
  const [rows, setRows] = useState<CoverageRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let c = false;
    setRows(null);
    setError(null);
    api
      .coverageMatrix(projectId)
      .then((r) => !c && setRows(r))
      .catch((e) => !c && setError(e.message));
    return () => {
      c = true;
    };
  }, [projectId]);

  if (error) return <Err msg={error} />;
  if (!rows) return <Skel rows={6} />;

  const max = Math.max(...rows.map((r) => r.runtime_count), 1);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead className="text-left text-[10px] uppercase tracking-wider text-slate-500">
          <tr>
            <th className="px-2 py-1">Agent</th>
            <th className="px-2 py-1">Runtime</th>
            <th className="px-2 py-1 text-right">Docs</th>
            <th className="px-2 py-1 text-right">Tasks</th>
            <th className="px-2 py-1 text-right">Alta</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.agent_id} className="border-t border-slate-800">
              <td className="truncate px-2 py-1 text-slate-200">{r.name}</td>
              <td className="px-2 py-1">
                <span className="flex items-center gap-2">
                  <span className="block h-1.5 w-24 overflow-hidden rounded bg-slate-800">
                    <span
                      className="block h-full bg-violet-500/70"
                      style={{ width: `${(r.runtime_count / max) * 100}%` }}
                    />
                  </span>
                  <span className="w-10 text-right font-mono text-[10px] text-slate-400">
                    {r.runtime_count}
                  </span>
                </span>
              </td>
              <td className="px-2 py-1 text-right tabular-nums text-slate-300">
                {r.docs_coverage}
              </td>
              <td className="px-2 py-1 text-right tabular-nums text-slate-300">
                {r.tasks_linked}
              </td>
              <td className="px-2 py-1 text-right">
                {r.runtime_high ? (
                  <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] text-emerald-200">
                    high
                  </span>
                ) : (
                  <span className="text-[10px] text-slate-600">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
