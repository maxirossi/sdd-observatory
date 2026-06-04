import { useEffect, useState } from 'react';
import { api, type HealthDimension, type HealthRead } from '../lib/api';

interface Props {
  projectId: string;
}

function scoreColor(s: number): string {
  if (s >= 75) return 'text-emerald-300';
  if (s >= 50) return 'text-amber-300';
  return 'text-rose-300';
}

function scoreRing(s: number): string {
  if (s >= 75) return 'ring-emerald-500/40';
  if (s >= 50) return 'ring-amber-500/40';
  return 'ring-rose-500/40';
}

export function HealthBanner({ projectId }: Props) {
  const [data, setData] = useState<HealthRead | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    api
      .projectHealth(projectId)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (error) {
    return (
      <div className="rounded-xl border border-rose-900/60 bg-rose-950/30 px-4 py-3 text-xs text-rose-300">
        Health no disponible: {error}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-20 animate-pulse rounded-xl bg-slate-900" />
        ))}
      </div>
    );
  }

  const p = data.progress;

  return (
    <div className="card-elev overflow-hidden">
      <div className="grid grid-cols-2 gap-px bg-slate-800/40 md:grid-cols-6">
        <Cell
          label="Project Health"
          value={`${data.health_score}`}
          unit="/100"
          valueClass={`${scoreColor(data.health_score)}`}
          accent={`ring-2 ${scoreRing(data.health_score)}`}
          subtitle={
            p.runtime_active ? 'Runtime activo (24h)' : 'Sin runtime en 24h'
          }
        />
        <Cell
          label="Agents Coverage"
          value={`${data.agents_coverage_pct}%`}
          subtitle={`${data.agents_used_runtime} / ${data.agents_total} con runtime`}
        />
        <Cell
          label="Tasks (done / total)"
          value={`${p.tasks_done} / ${p.tasks_total}`}
          subtitle={
            p.tasks_in_progress > 0
              ? `${p.tasks_in_progress} WIP · ${p.tasks_pending} pendientes`
              : `${p.tasks_pending} pendientes · ${p.tasks_unknown} sin clasificar`
          }
        />
        <Cell
          label="Traceability"
          value={`${p.traceability_pct}%`}
          subtitle={`${p.tasks_with_file} / ${p.tasks_total} con código`}
        />
        <Cell
          label="Cycles"
          value={`${data.cycles_total}`}
          subtitle={
            data.cycles_wip > 0 ? `${data.cycles_wip} en curso` : 'Sin ciclos en curso'
          }
        />
        <Cell
          label="Runtime · 24h"
          value={data.runtime_last_24h.toLocaleString()}
          subtitle={`Docs total: ${data.docs_total}`}
        />
      </div>

      {data.health_breakdown?.length > 0 && (
        <div className="border-t border-slate-800/60 px-5 py-3">
          <p className="label-track mb-2 text-slate-500">
            Health score · desglose ponderado
          </p>
          <div className="grid gap-x-6 gap-y-2 md:grid-cols-2 lg:grid-cols-3">
            {data.health_breakdown.map((d) => (
              <DimensionBar key={d.key} dim={d} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function barColor(s: number): string {
  if (s >= 75) return '#34d399';
  if (s >= 50) return '#fbbf24';
  return '#fb7185';
}

function DimensionBar({ dim }: { dim: HealthDimension }) {
  const s = dim.score;
  const pct = Math.round(dim.weight * 100);
  return (
    <div className="flex items-center gap-3" title={dim.detail ?? ''}>
      <span className="w-28 shrink-0 text-[11.5px] text-slate-400">
        {dim.label} <span className="text-slate-600">·{pct}%</span>
      </span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800">
        {s != null && (
          <div className="h-full rounded-full" style={{ width: `${s}%`, background: barColor(s) }} />
        )}
      </div>
      <span
        className="w-9 shrink-0 text-right font-mono text-[11.5px] tabular-nums"
        style={{ color: s != null ? barColor(s) : '#64748b' }}
      >
        {s != null ? s : 'n/d'}
      </span>
    </div>
  );
}

function Cell({
  label,
  value,
  unit,
  subtitle,
  valueClass,
  accent,
}: {
  label: string;
  value: string;
  unit?: string;
  subtitle?: string;
  valueClass?: string;
  accent?: string;
}) {
  return (
    <div className={`bg-slate-950/60 px-5 py-4 ${accent ?? ''}`}>
      <p className="label-track text-slate-500">{label}</p>
      <p className="mt-2 flex items-baseline gap-1">
        <span className={`kpi-number ${valueClass ?? 'text-slate-50'}`}>{value}</span>
        {unit && <span className="text-[12px] font-medium text-slate-500">{unit}</span>}
      </p>
      {subtitle && <p className="mt-1.5 text-[12px] text-slate-500">{subtitle}</p>}
    </div>
  );
}
