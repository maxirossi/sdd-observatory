import { useEffect, useState } from 'react';
import { Lightbulb } from 'lucide-react';
import { api, type RuntimeInsights } from '../lib/api';

interface Props {
  projectId: string;
}

const PROVIDER_COLOR: Record<string, string> = {
  claude: '#a78bfa',
  copilot: '#34d399',
};

function fmtDuration(s: number): string {
  if (!s || s <= 0) return '—';
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  const h = s / 3600;
  return h < 24 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`;
}

function fmtValue(v: number | null | undefined, unit: string): string {
  if (v == null) return '—';
  if (unit === 's') return fmtDuration(v);
  if (unit === '%') return `${v.toFixed(1)}%`;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

// Provider con el valor más alto de la métrica (solo para resaltar, no juzga "mejor").
function higher(claude?: number | null, copilot?: number | null): 'claude' | 'copilot' | null {
  if (claude == null || copilot == null || claude === copilot) return null;
  return claude > copilot ? 'claude' : 'copilot';
}

export function RuntimeInsightsPanel({ projectId }: Props) {
  const [data, setData] = useState<RuntimeInsights | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    api
      .runtimeInsights(projectId)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (error) {
    return (
      <Card>
        <p className="px-4 py-3 text-xs text-rose-300">No se pudieron cargar los insights: {error}</p>
      </Card>
    );
  }
  if (!data) {
    return (
      <Card>
        <div className="h-40 animate-pulse rounded bg-slate-800/50 m-4" />
      </Card>
    );
  }

  const hasComparative = data.comparative.some((r) => r.claude != null && r.copilot != null);

  return (
    <section className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
      {/* Tabla comparativa */}
      <Card>
        <SectionHeader title="Comparativa por provider" />
        {!hasComparative ? (
          <p className="px-4 py-6 text-center text-[11px] text-slate-500">
            Se necesita actividad de Claude y Copilot para comparar.
          </p>
        ) : (
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-slate-800 text-left text-[10.5px] uppercase tracking-wide text-slate-500">
                <th className="px-4 py-2 font-medium">Métrica</th>
                <th className="px-4 py-2 text-right font-medium">
                  <span style={{ color: PROVIDER_COLOR.claude }}>Claude</span>
                </th>
                <th className="px-4 py-2 text-right font-medium">
                  <span style={{ color: PROVIDER_COLOR.copilot }}>Copilot</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.comparative.map((row) => {
                const w = higher(row.claude, row.copilot);
                return (
                  <tr key={row.metric} className="border-b border-slate-800/50 last:border-0">
                    <td className="px-4 py-1.5 text-slate-300">{row.metric}</td>
                    <td
                      className="px-4 py-1.5 text-right font-mono tabular-nums"
                      style={{ color: w === 'claude' ? PROVIDER_COLOR.claude : '#cbd5e1', fontWeight: w === 'claude' ? 600 : 400 }}
                    >
                      {fmtValue(row.claude, row.unit)}
                    </td>
                    <td
                      className="px-4 py-1.5 text-right font-mono tabular-nums"
                      style={{ color: w === 'copilot' ? PROVIDER_COLOR.copilot : '#cbd5e1', fontWeight: w === 'copilot' ? 600 : 400 }}
                    >
                      {fmtValue(row.copilot, row.unit)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      {/* Insights determinísticos */}
      <Card>
        <SectionHeader title="Insights" badge="determinístico" />
        <div className="space-y-2 p-4">
          {data.insights.length === 0 ? (
            <p className="text-[11px] text-slate-500">
              Sin diferencias significativas entre providers (o falta actividad en alguno).
            </p>
          ) : (
            data.insights.map((text, i) => (
              <div
                key={i}
                className="flex items-start gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2"
              >
                <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
                <span className="text-[12px] leading-snug text-slate-200">{text}</span>
              </div>
            ))
          )}
        </div>
      </Card>
    </section>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900">{children}</div>;
}

function SectionHeader({ title, badge }: { title: string; badge?: string }) {
  return (
    <header className="flex items-center justify-between border-b border-slate-800 px-4 py-2">
      <p className="text-[12px] font-semibold text-slate-200">{title}</p>
      {badge && (
        <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[9.5px] uppercase tracking-wide text-slate-400">
          {badge}
        </span>
      )}
    </header>
  );
}
