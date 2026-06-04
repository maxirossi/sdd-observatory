import { useEffect, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { api, type AgentEffectiveness } from '../lib/api';

interface Props {
  projectId: string;
}

function scoreColor(s: number): string {
  if (s >= 75) return '#34d399';
  if (s >= 50) return '#fbbf24';
  return '#fb7185';
}

const RISK_STYLE: Record<string, string> = {
  low: 'bg-emerald-500/15 text-emerald-300 ring-emerald-600/30',
  medium: 'bg-amber-500/15 text-amber-300 ring-amber-600/30',
  high: 'bg-rose-500/15 text-rose-300 ring-rose-600/30',
};

function Trend({ value }: { value: number | null }) {
  if (value == null) return <span className="text-slate-600">—</span>;
  if (Math.abs(value) < 0.5)
    return (
      <span className="inline-flex items-center gap-0.5 text-slate-400">
        <Minus className="h-3 w-3" /> 0
      </span>
    );
  const up = value > 0;
  return (
    <span className={`inline-flex items-center gap-0.5 ${up ? 'text-emerald-400' : 'text-rose-400'}`}>
      {up ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
      {up ? '+' : ''}
      {value.toFixed(0)}
    </span>
  );
}

export function AgentEffectivenessPanel({ projectId }: Props) {
  const [rows, setRows] = useState<AgentEffectiveness[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    api
      .agentEffectiveness(projectId)
      .then((d) => !cancelled && setRows(d))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return (
    <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
      <header className="flex items-center justify-between border-b border-slate-800 px-4 py-2.5">
        <p className="text-[13px] font-semibold text-slate-100">Agent Effectiveness</p>
        <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[9.5px] uppercase tracking-wide text-slate-400">
          40% completion · 25% result · 20% sin anomalías · 15% actividad
        </span>
      </header>

      {error ? (
        <p className="px-4 py-4 text-xs text-rose-300">No disponible: {error}</p>
      ) : !rows ? (
        <div className="m-4 h-32 animate-pulse rounded bg-slate-800/50" />
      ) : rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-[11px] text-slate-500">
          Sin delegaciones registradas todavía.
        </p>
      ) : (
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-slate-800 text-left text-[10px] uppercase tracking-wide text-slate-500">
              <th className="px-4 py-2 font-medium">Agente</th>
              <th className="px-3 py-2 text-center font-medium">Effectiveness</th>
              <th className="px-3 py-2 text-center font-medium">Trend</th>
              <th className="px-3 py-2 text-center font-medium">Risk</th>
              <th className="px-3 py-2 text-right font-medium">Tasks</th>
              <th className="px-3 py-2 text-right font-medium">Result</th>
              <th className="px-3 py-2 text-right font-medium">Anom.</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.agent_name} className="border-b border-slate-800/50 last:border-0 hover:bg-slate-800/20">
                <td className="px-4 py-2">
                  <span className="font-medium text-slate-200">{r.agent_name}</span>
                  {!r.declared && (
                    <span className="ml-1.5 rounded bg-slate-800 px-1 py-0.5 text-[9px] text-slate-500">built-in</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${r.effectiveness_score}%`, background: scoreColor(r.effectiveness_score) }}
                      />
                    </div>
                    <span
                      className="w-8 shrink-0 text-right font-mono tabular-nums"
                      style={{ color: scoreColor(r.effectiveness_score) }}
                    >
                      {r.effectiveness_score}
                    </span>
                  </div>
                </td>
                <td className="px-3 py-2 text-center font-mono text-[11px] tabular-nums">
                  <Trend value={r.trend} />
                </td>
                <td className="px-3 py-2 text-center">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] capitalize ring-1 ring-inset ${RISK_STYLE[r.risk] ?? ''}`}>
                    {r.risk}
                  </span>
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-400">
                  {r.tasks_completed}/{r.tasks_associated}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-400">
                  {r.with_result}/{r.invocations}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-400">{r.anomalies}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
