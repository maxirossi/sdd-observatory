import { useEffect, useMemo, useState } from 'react';
import { api, type CycleStatusCounts, type CycleSummary, type DomainBreakdown } from '../lib/api';
import { DonutChart, type DonutDatum } from './charts/DonutChart';
import { StackedBarChart } from './charts/StackedBarChart';
import { chartColors, colorFor } from './charts/chartTheme';

interface Props {
  projectId: string;
}

const STATE_LABEL: Record<CycleSummary['state'], string> = {
  wip: 'WIP',
  done: 'Done',
  idle: 'Idle',
  empty: 'Vacío',
};

const STATE_CLASS: Record<CycleSummary['state'], string> = {
  wip: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  done: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  idle: 'bg-slate-500/10 text-slate-400 border-slate-700/60',
  empty: 'bg-slate-800 text-slate-500 border-slate-800',
};

const STATUS_FILL = {
  done: chartColors.done,
  in_progress: chartColors.in_progress,
  pending: chartColors.pending,
  unknown: chartColors.unknown,
};

function pctColorClass(pct: number): string {
  if (pct >= 90) return 'text-emerald-300';
  if (pct >= 60) return 'text-cyan-300';
  if (pct >= 30) return 'text-amber-300';
  return 'text-rose-300';
}

function statusDonutData(s: CycleSummary['status']): DonutDatum[] {
  return [
    { id: 'done', label: 'Done', value: s.done, color: STATUS_FILL.done },
    { id: 'wip', label: 'WIP', value: s.in_progress, color: STATUS_FILL.in_progress },
    { id: 'pending', label: 'Pending', value: s.pending, color: STATUS_FILL.pending },
    { id: 'unknown', label: 'Unknown', value: s.unknown, color: STATUS_FILL.unknown },
  ].filter((d) => d.value > 0);
}

const RANGES: { label: string; hours: number }[] = [
  { label: '24 h', hours: 24 },
  { label: '7 días', hours: 168 },
  { label: '30 días', hours: 720 },
];

export function CyclesPanel({ projectId }: Props) {
  const [cycles, setCycles] = useState<CycleSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sinceHours, setSinceHours] = useState<number>(0); // 0 = sin ventana
  const [customN, setCustomN] = useState<string>('');
  const [customUnit, setCustomUnit] = useState<'h' | 'd'>('d');

  const applyCustom = (nStr: string, unit: 'h' | 'd') => {
    setCustomN(nStr);
    setCustomUnit(unit);
    const n = parseInt(nStr, 10);
    if (Number.isFinite(n) && n > 0) setSinceHours(n * (unit === 'd' ? 24 : 1));
  };
  const presetHours = RANGES.map((r) => r.hours);
  const isCustom = sinceHours > 0 && !presetHours.includes(sinceHours);

  useEffect(() => {
    let cancelled = false;
    setCycles(null);
    setError(null);
    api
      .cycles(projectId, sinceHours || undefined)
      .then((c) => !cancelled && setCycles(c))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [projectId, sinceHours]);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-[12px] text-slate-500">
          {sinceHours
            ? 'Avance en la ventana seleccionada (Δ done vs. baseline).'
            : 'Estado actual. Elegí una ventana para ver el avance.'}
        </p>
        <div className="flex items-center gap-1">
          <span className="mr-1 text-[11px] text-slate-500">Avance:</span>
          <button
            type="button"
            onClick={() => setSinceHours(0)}
            className={`rounded-md px-2 py-1 text-[12px] font-medium transition-colors ${
              sinceHours === 0 ? 'bg-cyan-500/20 text-cyan-200' : 'bg-slate-800/60 text-slate-400 hover:bg-slate-800'
            }`}
          >
            actual
          </button>
          {RANGES.map((r) => (
            <button
              key={r.hours}
              type="button"
              onClick={() => setSinceHours(r.hours)}
              className={`rounded-md px-2 py-1 text-[12px] font-medium transition-colors ${
                sinceHours === r.hours ? 'bg-cyan-500/20 text-cyan-200' : 'bg-slate-800/60 text-slate-400 hover:bg-slate-800'
              }`}
            >
              {r.label}
            </button>
          ))}
          {/* Custom dinámico: n + unidad */}
          <div
            className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 ${
              isCustom ? 'bg-cyan-500/20 ring-1 ring-cyan-500/40' : 'bg-slate-800/60'
            }`}
          >
            <input
              type="number"
              min={1}
              value={customN}
              onChange={(e) => applyCustom(e.target.value, customUnit)}
              placeholder="n"
              className="w-12 bg-transparent text-center text-[12px] text-slate-100 placeholder:text-slate-600 focus:outline-none"
            />
            <select
              value={customUnit}
              onChange={(e) => applyCustom(customN, e.target.value as 'h' | 'd')}
              className="bg-transparent text-[12px] text-slate-300 focus:outline-none"
            >
              <option value="h" className="bg-slate-900">
                horas
              </option>
              <option value="d" className="bg-slate-900">
                días
              </option>
            </select>
          </div>
        </div>
      </div>

      {error ? (
        <div className="card-elev px-5 py-3 text-[13px] text-rose-300">
          No se pudo cargar /cycles: {error}
        </div>
      ) : !cycles ? (
        <div className="space-y-5">
          <div className="hero-card h-44 animate-pulse" />
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="card-elev h-60 animate-pulse" />
            ))}
          </div>
        </div>
      ) : cycles.length === 0 ? (
        <div className="card-elev px-5 py-3 text-[13px] text-slate-500">
          No se detectaron ciclos en el proyecto.
        </div>
      ) : (
        <>
          <HeroSummary cycles={cycles} />
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {cycles.map((c, i) => (
              <CycleCard key={c.cycle} c={c} index={i} sinceHours={sinceHours} />
            ))}
          </div>
          <CrossCycleChart cycles={cycles} />
        </>
      )}
    </div>
  );
}

// ───────────────────── Hero summary ─────────────────────

function HeroSummary({ cycles }: { cycles: CycleSummary[] }) {
  const totals = useMemo(() => {
    const t = { total: 0, done: 0, in_progress: 0, pending: 0, unknown: 0 };
    for (const c of cycles) {
      t.total += c.total_tasks;
      t.done += c.status.done;
      t.in_progress += c.status.in_progress;
      t.pending += c.status.pending;
      t.unknown += c.status.unknown;
    }
    return t;
  }, [cycles]);

  const avgPct = totals.total > 0 ? Math.round((totals.done / totals.total) * 100) : 0;
  const insights = useMemo(() => buildInsights(cycles, totals), [cycles, totals]);

  const donutData: DonutDatum[] = [
    { id: 'done', label: 'Done', value: totals.done, color: STATUS_FILL.done },
    { id: 'wip', label: 'WIP', value: totals.in_progress, color: STATUS_FILL.in_progress },
    { id: 'pending', label: 'Pending', value: totals.pending, color: STATUS_FILL.pending },
    { id: 'unknown', label: 'Unknown', value: totals.unknown, color: STATUS_FILL.unknown },
  ].filter((d) => d.value > 0);

  const segments = [
    { key: 'done', label: 'Done', value: totals.done, fill: STATUS_FILL.done },
    { key: 'in_progress', label: 'WIP', value: totals.in_progress, fill: STATUS_FILL.in_progress },
    { key: 'pending', label: 'Pending', value: totals.pending, fill: STATUS_FILL.pending },
    { key: 'unknown', label: 'Unknown', value: totals.unknown, fill: STATUS_FILL.unknown },
  ];

  return (
    <div className="hero-card fade-up stagger-0 grid gap-6 p-6 lg:grid-cols-[auto_1fr_minmax(0,260px)]">
      {/* Donut Nivo principal */}
      <div className="flex items-center gap-5">
        <div className="h-[150px] w-[150px] shrink-0">
          <DonutChart
            data={donutData}
            centervalue={`${avgPct}%`}
            centerSub={`${totals.done} / ${totals.total}`}
            centerValueClass={pctColorClass(avgPct)}
            innerRadius={0.74}
          />
        </div>
        <div>
          <p className="label-track text-slate-500">Avg completion</p>
          <p
            className={`text-[36px] font-bold tabular leading-none ${pctColorClass(avgPct)}`}
            style={{ letterSpacing: '-0.035em' }}
          >
            {avgPct}
            <span className="text-[18px] text-slate-500">%</span>
          </p>
          <p className="mt-2 text-[12px] text-slate-400">{cycles.length} ciclos</p>
        </div>
      </div>

      {/* Distribución */}
      <div className="flex flex-col justify-center">
        <p className="label-track mb-3 text-slate-500">Distribución de tasks</p>
        <div className="flex h-3.5 overflow-hidden rounded-full bg-slate-800/80 shadow-inner">
          {segments.map((s) =>
            s.value > 0 ? (
              <div
                key={s.key}
                className="progress-fill"
                style={{
                  width: `${(s.value / totals.total) * 100}%`,
                  background: s.fill,
                  boxShadow: `0 0 12px ${s.fill}33`,
                }}
                title={`${s.label}: ${s.value}`}
              />
            ) : null,
          )}
        </div>
        <div className="mt-4 grid grid-cols-4 gap-3">
          {segments.map((s) => (
            <div key={s.key}>
              <div className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.fill }} />
                <span className="text-[11px] text-slate-400">{s.label}</span>
              </div>
              <p
                className="mt-0.5 text-[24px] font-bold tabular text-slate-100"
                style={{ letterSpacing: '-0.02em' }}
              >
                {s.value}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Insights */}
      <div className="flex flex-col justify-center gap-2 border-l border-slate-800/60 pl-6">
        <p className="label-track text-slate-500">Insights</p>
        {insights.map((ins, i) => (
          <div key={i} className="flex items-start gap-2">
            <span
              className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: ins.color }}
            />
            <p className="text-[12px] leading-snug text-slate-300">{ins.text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

interface Insight {
  text: string;
  color: string;
}

function buildInsights(
  cycles: CycleSummary[],
  totals: { unknown: number; pending: number },
): Insight[] {
  const out: Insight[] = [];
  const withTasks = cycles.filter((c) => c.total_tasks > 0);

  if (withTasks.length > 0) {
    const lowest = withTasks.reduce((a, b) => (a.completion_pct <= b.completion_pct ? a : b));
    out.push({
      text: `${lowest.label} requiere atención — ${lowest.completion_pct}% completado, ${lowest.status.pending} pendientes`,
      color: '#fb7185',
    });
    const highest = withTasks.reduce((a, b) => (a.completion_pct >= b.completion_pct ? a : b));
    if (highest.cycle !== lowest.cycle) {
      out.push({
        text: `${highest.label} lidera con ${highest.completion_pct}% de avance`,
        color: '#34d399',
      });
    }
  }

  for (const c of cycles) {
    const stalled = c.domains.find((d) => d.total > 0 && d.done === 0);
    if (stalled) {
      out.push({
        text: `${stalled.domain} de ${c.label} sin empezar (${stalled.total} tasks)`,
        color: '#fbbf24',
      });
      break;
    }
  }

  if (totals.unknown > 0) {
    out.push({ text: `${totals.unknown} tasks sin clasificar de estado`, color: '#52525b' });
  }

  return out.slice(0, 4);
}

// ───────────────────── Cycle card ─────────────────────

function CycleCard({
  c,
  index,
  sinceHours,
}: {
  c: CycleSummary;
  index: number;
  sinceHours: number;
}) {
  // Con ventana activa, el donut/%/pills reflejan el ESTADO A ESA FECHA (baseline);
  // sin ventana, el estado actual.
  const windowed = sinceHours > 0 && c.baseline != null;
  const view = windowed ? (c.baseline as CycleStatusCounts) : c.status;
  const viewTotal = windowed ? c.baseline_total ?? 0 : c.total_tasks;
  const viewPct = viewTotal > 0 ? Math.round((view.done / viewTotal) * 100) : 0;
  const s = view;
  const needsAttention = viewPct < 50 && viewTotal > 0;
  const staggerClass = `stagger-${Math.min(index, 5)}`;
  const donutData = statusDonutData(s);
  const winLabel = sinceHours % 24 === 0 ? `${sinceHours / 24}d` : `${sinceHours}h`;

  return (
    <div className={`card-elev card-elev-hover fade-up ${staggerClass} group flex flex-col p-5`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[15px] font-semibold tracking-tight text-slate-50">
            {c.label}
          </p>
          <p className="mt-0.5 font-mono text-[11px] text-slate-500">{c.cycle}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span
            className={`rounded-md border px-2 py-0.5 font-mono text-[10.5px] font-semibold ${STATE_CLASS[c.state]}`}
          >
            {STATE_LABEL[c.state]}
          </span>
          {sinceHours > 0 && c.delta_done != null && (
            <span
              className={`rounded-md px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
                c.delta_done > 0
                  ? 'bg-emerald-500/15 text-emerald-300'
                  : 'bg-slate-700/40 text-slate-400'
              }`}
              title={`Baseline: ${c.baseline?.done ?? '—'} done${c.baseline_at ? ` (${new Date(c.baseline_at).toLocaleString()})` : ''}`}
            >
              {c.delta_done > 0 ? `+${c.delta_done}` : '±0'} done
            </span>
          )}
        </div>
      </div>

      {/* Donut Nivo + counts */}
      <div className="mt-4 flex items-center gap-4">
        <div className="h-[96px] w-[96px] shrink-0">
          {donutData.length > 0 ? (
            <DonutChart
              data={donutData}
              centervalue={`${viewPct}%`}
              centerValueClass={pctColorClass(viewPct)}
              innerRadius={0.7}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-[11px] text-slate-600">
              sin tasks
            </div>
          )}
        </div>
        <div className="grid flex-1 grid-cols-2 gap-x-3 gap-y-2">
          <StatusPill label="Done" value={s.done} fill={STATUS_FILL.done} />
          <StatusPill label="WIP" value={s.in_progress} fill={STATUS_FILL.in_progress} />
          <StatusPill label="Pending" value={s.pending} fill={STATUS_FILL.pending} />
          <StatusPill label="Unknown" value={s.unknown} fill={STATUS_FILL.unknown} />
        </div>
      </div>

      {/* Anotación de ventana: estado a la fecha → hoy */}
      {windowed && (
        <p className="mt-2.5 flex items-center gap-1.5 text-[11px] text-slate-400">
          <span className="font-mono text-slate-500">
            hace {winLabel}
            {c.baseline_at ? ` (${new Date(c.baseline_at).toLocaleDateString()})` : ''}
          </span>
          <span className="text-slate-600">→ hoy</span>
          <span className={`font-mono font-semibold ${pctColorClass(c.completion_pct)}`}>
            {c.completion_pct}%
          </span>
          {c.delta_done != null && c.delta_done > 0 && (
            <span className="font-mono font-semibold text-emerald-300">
              +{c.delta_done} done
            </span>
          )}
        </p>
      )}

      {/* Meta row */}
      <div className="mt-4 flex items-center gap-4 border-t border-slate-800/60 pt-3 text-[11.5px] text-slate-400">
        <span>
          <span className="font-mono text-slate-200">{c.total_tasks}</span> tasks
        </span>
        <span>
          <span className="font-mono text-slate-200">{c.docs_count}</span> docs
        </span>
        <span>
          <span className="font-mono text-slate-200">{c.agents_referenced}</span> agents
        </span>
        {c.runtime_events > 0 && (
          <span>
            <span className="font-mono text-slate-200">{c.runtime_events}</span> rt
          </span>
        )}
        {needsAttention && (
          <span className="ml-auto rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-rose-300">
            atención
          </span>
        )}
      </div>

      {/* Domain chips */}
      {c.domains.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {c.domains.map((d) => (
            <DomainChip key={d.domain} d={d} />
          ))}
        </div>
      )}
    </div>
  );
}

function StatusPill({ label, value, fill }: { label: string; value: number; fill: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: fill }} />
      <span className="text-[11px] text-slate-500">{label}</span>
      <span className="ml-auto font-mono text-[12px] tabular text-slate-200">{value}</span>
    </div>
  );
}

function DomainChip({ d }: { d: DomainBreakdown }) {
  const pct = d.total > 0 ? Math.round((d.done / d.total) * 100) : 0;
  const color = colorFor(d.domain);
  const complete = pct === 100;
  const stalled = d.done === 0 && d.total > 0;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md border border-slate-800 bg-slate-950/60 px-2 py-1 transition-colors group-hover:border-slate-700"
      title={`${d.domain}: ${d.done}/${d.total} done (${pct}%)`}
    >
      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      <span className="font-mono text-[11px] text-slate-300">{d.domain}</span>
      <span
        className={`font-mono text-[11px] tabular ${
          complete ? 'text-emerald-300' : stalled ? 'text-rose-300' : 'text-slate-500'
        }`}
      >
        {d.done}/{d.total}
      </span>
    </span>
  );
}

// ───────────────────── Cross-cycle chart (Nivo bar) ─────────────────────

function CrossCycleChart({ cycles }: { cycles: CycleSummary[] }) {
  const domainSet = useMemo(() => {
    const set = new Set<string>();
    cycles.forEach((c) => c.domains.forEach((d) => set.add(d.domain)));
    return Array.from(set).sort((a, b) => {
      if (a === 'unknown') return 1;
      if (b === 'unknown') return -1;
      return a.localeCompare(b);
    });
  }, [cycles]);

  const data = useMemo(() => {
    return cycles.map((c) => {
      const row: Record<string, string | number> = { cycle: c.label };
      domainSet.forEach((d) => {
        const found = c.domains.find((x) => x.domain === d);
        row[d] = found ? found.total : 0;
      });
      return row;
    });
  }, [cycles, domainSet]);

  return (
    <div className="card-elev fade-up stagger-4 overflow-hidden">
      <header className="border-b border-slate-800/80 px-5 py-3">
        <p className="text-[14px] font-semibold tracking-tight text-slate-100">
          Tasks por ciclo y dominio
        </p>
        <p className="text-[12px] text-slate-500">
          Distribución total apilada por dominio — dónde se concentra el trabajo.
        </p>
      </header>
      <div className="h-72 w-full px-4 pb-2 pt-3">
        <StackedBarChart data={data} indexBy="cycle" keys={domainSet} colorByKey={colorFor} />
      </div>
    </div>
  );
}
