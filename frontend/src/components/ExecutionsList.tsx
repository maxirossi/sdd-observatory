import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { ExecutionRead } from '../lib/api';

const STATUS: Record<string, { label: string; cls: string }> = {
  delegated: { label: 'delegó', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  inline: { label: 'inline', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  read_only: { label: 'solo lectura', cls: 'bg-slate-600/20 text-slate-400 border-slate-600/40' },
};

function agentTone(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('tdd') || n.includes('test') || n.includes('e2e')) return 'text-pink-300';
  if (n.includes('frontend')) return 'text-sky-300';
  if (n.includes('backend') || n.includes('satellite')) return 'text-emerald-300';
  if (n.includes('devops') || n.includes('observability')) return 'text-amber-300';
  if (n.includes('orchestrator') || n.includes('architect') || n.includes('speckit'))
    return 'text-violet-300';
  return 'text-slate-300';
}

function fmtDur(s: number | null): string {
  if (s == null) return '—';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}min`;
  return `${(s / 3600).toFixed(1)}h`;
}

function fmtTime(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
}

export function ExecutionRow({ e, showSession }: { e: ExecutionRead; showSession?: boolean }) {
  const [open, setOpen] = useState(false);
  const st = STATUS[e.status] ?? STATUS.read_only;
  return (
    <li className="border-t border-slate-800/60 first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-slate-800/30"
      >
        <ChevronRight
          className={`h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span className="w-7 shrink-0 text-right font-mono text-[11px] text-slate-600">#{e.index}</span>
        <span className="w-24 shrink-0 truncate font-mono text-[12px] font-semibold text-slate-100">
          {e.task_ref ?? '—'}
        </span>
        <span className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] font-semibold ${st.cls}`}>
          {st.label}
        </span>
        {/* agentes */}
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {e.delegations.map((d) => (
            <span
              key={d.agent_name}
              className="flex items-center gap-1 rounded bg-slate-800/60 px-1.5 py-0.5 font-mono text-[10px]"
              title={`${d.result_chars > 0 ? `✓ ${d.result_chars}c` : 'sin result'} · ${d.description ?? ''}`}
            >
              <span className={`h-1 w-1 rounded-full ${d.result_chars > 0 ? 'bg-emerald-400' : 'bg-amber-400'}`} />
              <span className={agentTone(d.agent_name)}>{d.agent_name}</span>
            </span>
          ))}
          {e.delegations.length === 0 && (
            <span className="font-mono text-[10px] text-slate-600">sin delegación</span>
          )}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-slate-500">{fmtDur(e.duration_s)}</span>
        <span className="hidden shrink-0 font-mono text-[10px] text-slate-600 md:inline">
          {e.tool_calls}tc · {e.edits}ed
        </span>
        {showSession && (
          <span className="hidden shrink-0 font-mono text-[9px] text-slate-700 lg:inline">
            {e.session_id.slice(0, 8)}
          </span>
        )}
      </button>

      {open && (
        <div className="space-y-2.5 bg-slate-950/40 px-4 py-3 pl-11">
          {e.label && (
            <p className="text-[11.5px] italic leading-snug text-slate-400">«{e.label.replace(/`/g, '')}»</p>
          )}
          <div className="flex flex-wrap gap-3 font-mono text-[10px] text-slate-500">
            <span>{fmtTime(e.started_at)} → {fmtTime(e.ended_at)}</span>
            {e.model && <span className="text-slate-400">{e.model}</span>}
            <span>{e.tool_calls} tool calls · {e.edits} ediciones</span>
          </div>
          {e.delegations.length > 0 && (
            <ul className="space-y-1">
              {e.delegations.map((d) => (
                <li key={d.agent_name + (d.description ?? '')} className="flex items-center gap-2 text-[11px]">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${d.result_chars > 0 ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                  <span className={`w-40 shrink-0 truncate font-mono ${agentTone(d.agent_name)}`}>
                    {d.agent_name}
                    {!d.declared && <span className="ml-1 text-[8.5px] text-slate-600">·no-decl</span>}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-slate-400" title={d.description ?? ''}>
                    {d.description ?? '—'}
                  </span>
                  <span className={`shrink-0 font-mono text-[10px] ${d.result_chars > 0 ? 'text-emerald-300/80' : 'text-amber-300/80'}`}>
                    {d.result_chars > 0 ? `✓ ${d.result_chars}c` : '⚠ vacío'}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {e.files_touched.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {e.files_touched.slice(0, 10).map((f) => (
                <span key={f} className="rounded bg-slate-900/70 px-1.5 py-0.5 font-mono text-[9.5px] text-slate-500" title={f}>
                  {f.split('/').pop()}
                </span>
              ))}
              {e.files_touched.length > 10 && (
                <span className="font-mono text-[9.5px] text-slate-600">+{e.files_touched.length - 10}</span>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export function ExecutionsList({ items, showSession }: { items: ExecutionRead[]; showSession?: boolean }) {
  if (items.length === 0)
    return <p className="px-4 py-4 text-[12px] text-slate-500">Sin ejecuciones.</p>;
  return (
    <ul>
      {items.map((e) => (
        <ExecutionRow key={`${e.session_id}-${e.request_id ?? e.index}`} e={e} showSession={showSession} />
      ))}
    </ul>
  );
}
