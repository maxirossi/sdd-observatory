import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertTriangle, GitBranch, GitCommit, ShieldAlert, Users } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { api, type AuditReport } from '../lib/api';

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString([], { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function authorTone(i: number): string {
  const tones = ['#38bdf8', '#34d399', '#a78bfa', '#fbbf24', '#f472b6', '#fb7185'];
  return tones[i % tones.length];
}

export function AuditPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [data, setData] = useState<AuditReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setData(null);
    setError(null);
    api
      .audit(projectId)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return (
    <div>
      <PageHeader
        title="Audit"
        subtitle="Repository-level audit from git history — anomalies, warnings & contributors."
      />
      <div className="space-y-4 p-6">
        {error && <p className="text-[13px] text-rose-300">Error: {error}</p>}
        {!data && !error && (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="card-elev h-28 animate-pulse" />
            ))}
          </div>
        )}
        {data && !data.available && (
          <div className="card-elev px-5 py-4 text-[13px] text-amber-300">
            Audit no disponible: {data.reason ?? 'desconocido'}
          </div>
        )}
        {data && data.available && (
          <>
            {/* Resumen del repo */}
            <p className="text-[12px] text-slate-500">
              Datos de las últimas{' '}
              <span className="font-mono text-slate-300">{data.thresholds?.window_days ?? 14} días</span>{' '}
              · contribuidores y pushes en la ventana; commits/branches totales como contexto.
            </p>
            <div className="card-elev grid grid-cols-2 gap-px overflow-hidden md:grid-cols-6">
              <Stat label="Base branch" value={data.base_branch ?? '—'} mono />
              <Stat label="Commits (total)" value={String(data.total_commits ?? 0)} />
              <Stat label="Commits (2 sem)" value={String(data.commits_in_window ?? 0)} />
              <Stat label="Branches" value={String(data.branches ?? 0)} />
              <Stat label="Contributors (2 sem)" value={String(data.contributors ?? 0)} />
              <Stat label="Último commit" value={fmtDate(data.last_commit_at)} />
            </div>

            {/* Anomalía: push directo a base */}
            <Section
              icon={<ShieldAlert className="h-4 w-4 text-rose-400" />}
              title="Pushes directos a la base"
              tone="rose"
              count={data.direct_to_base_recent.length}
              subtitle={`commits no-merge sobre ${data.base_branch} (sin pasar por PR/merge) en las últimas 2 semanas · ${data.direct_to_base_total ?? 0} all-time`}
            >
              {data.direct_to_base_recent.length === 0 ? (
                <Empty>Sin pushes directos recientes 🎉</Empty>
              ) : (
                <ul className="divide-y divide-slate-800/50">
                  {data.direct_to_base_recent.map((c) => (
                    <li key={c.sha} className="flex items-center gap-3 px-4 py-2 text-[12px]">
                      <GitCommit className="h-3.5 w-3.5 shrink-0 text-rose-400/70" />
                      <span className="w-20 shrink-0 font-mono text-[11px] text-slate-500">{c.sha}</span>
                      <span className="w-36 shrink-0 truncate text-slate-300">{c.author}</span>
                      <span className="min-w-0 flex-1 truncate text-slate-400" title={c.message}>
                        {c.message}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-slate-600">{fmtDate(c.date)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            {/* Warning: branches grandes */}
            <Section
              icon={<AlertTriangle className="h-4 w-4 text-amber-400" />}
              title="Branches grandes"
              tone="amber"
              count={data.large_branches.length}
              subtitle={`branches con > ${data.thresholds?.large_branch_files} archivos vs base (revisar scope) · top ${data.thresholds?.max_branches} recientes`}
            >
              {data.large_branches.length === 0 ? (
                <Empty>Ninguna branch reciente supera el umbral.</Empty>
              ) : (
                <ul className="divide-y divide-slate-800/50">
                  {data.large_branches.map((b) => (
                    <li key={b.name} className="flex items-center gap-3 px-4 py-2 text-[12px]">
                      <GitBranch className="h-3.5 w-3.5 shrink-0 text-amber-400/70" />
                      <span className="min-w-0 flex-1 truncate font-mono text-slate-200" title={b.name}>
                        {b.name}
                      </span>
                      <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-amber-200">
                        {b.files_changed} files
                      </span>
                      <span className="w-16 shrink-0 text-right font-mono text-[10px] text-slate-500">
                        {b.commits_ahead} cmt
                      </span>
                      <span className="w-28 shrink-0 truncate text-right text-[11px] text-slate-500">{b.author}</span>
                      <span className="w-14 shrink-0 text-right font-mono text-[10px] text-slate-600">
                        {fmtDate(b.last_commit)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            {/* Contribuidores */}
            <Section
              icon={<Users className="h-4 w-4 text-cyan-400" />}
              title="Contribuidores"
              tone="cyan"
              count={data.top_contributors.length}
              subtitle="commits y líneas por autor (no-merge, sobre la base)"
            >
              <ul className="divide-y divide-slate-800/50">
                {data.top_contributors.map((c, i) => {
                  const max = data.top_contributors[0]?.commits || 1;
                  return (
                    <li key={c.author} className="flex items-center gap-3 px-4 py-2 text-[12px]">
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: authorTone(i) }} />
                      <span className="w-44 shrink-0 truncate text-slate-200">{c.author}</span>
                      <span className="flex h-2 flex-1 overflow-hidden rounded-full bg-slate-800/70">
                        <span
                          className="rounded-full"
                          style={{ width: `${(c.commits / max) * 100}%`, background: authorTone(i) }}
                        />
                      </span>
                      <span className="w-16 shrink-0 text-right font-mono text-slate-200">{c.commits} cmt</span>
                      <span className="w-24 shrink-0 text-right font-mono text-[11px] text-emerald-300/80">
                        +{c.insertions.toLocaleString()}
                      </span>
                      <span className="w-24 shrink-0 text-right font-mono text-[11px] text-rose-300/80">
                        -{c.deletions.toLocaleString()}
                      </span>
                      <span className="hidden w-20 shrink-0 text-right font-mono text-[10px] text-slate-600 lg:inline">
                        {c.files_touched} files
                      </span>
                    </li>
                  );
                })}
              </ul>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="bg-slate-900/40 px-4 py-3">
      <p className="label-track text-slate-500">{label}</p>
      <p className={`mt-1 text-[18px] font-semibold text-slate-100 ${mono ? 'font-mono text-[14px]' : ''}`}>
        {value}
      </p>
    </div>
  );
}

function Section({
  icon,
  title,
  subtitle,
  count,
  tone,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  count: number;
  tone: 'rose' | 'amber' | 'cyan';
  children: React.ReactNode;
}) {
  const countCls =
    tone === 'rose'
      ? 'bg-rose-500/15 text-rose-300'
      : tone === 'amber'
        ? 'bg-amber-500/15 text-amber-300'
        : 'bg-cyan-500/15 text-cyan-300';
  return (
    <div className="card-elev overflow-hidden">
      <header className="flex items-center gap-2 border-b border-slate-800/80 px-5 py-3">
        {icon}
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[14px] font-semibold tracking-tight text-slate-100">
            {title}
            <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${countCls}`}>{count}</span>
          </p>
          <p className="text-[11.5px] text-slate-500">{subtitle}</p>
        </div>
      </header>
      <div className="max-h-[360px] overflow-y-auto">{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-5 py-4 text-[12px] text-slate-500">{children}</p>;
}
