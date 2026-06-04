import { useEffect, useState } from 'react';
import {
  api,
  type ExecutionRead,
  type SessionEvent,
  type SessionReplayRead,
  type SessionSummary,
  type TurnText,
} from '../lib/api';
import { AgentFlowModal } from './AgentFlowModal';
import { ExecutionsList } from './ExecutionsList';

interface Props {
  projectId: string;
}

const EVENT_COLOR: Record<string, string> = {
  user: 'text-cyan-300',
  assistant: 'text-violet-300',
  system: 'text-slate-500',
  tool_use: 'text-amber-300',
  tool_result: 'text-emerald-300',
  attachment: 'text-slate-500',
  error: 'text-rose-300',
  request: 'text-emerald-300',
};

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}min`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

function fmtTokens(n: number): string {
  if (n === 0) return '0';
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function SessionsPanel({ projectId }: Props) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSessions(null);
    setError(null);
    setSelected(null);
    api
      .sessions(projectId, 40)
      .then((s) => {
        if (cancelled) return;
        setSessions(s);
        // Auto-seleccionar la primera sesión al entrar (solo si no hay nada).
        if (s.length > 0) setSelected((cur) => cur ?? s[0].session_id);
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
      <div className="card-elev overflow-hidden">
        <header className="flex items-baseline justify-between border-b border-slate-800/80 px-4 py-3">
          <div>
            <p className="text-[13px] font-semibold text-slate-100">Sesiones runtime</p>
            <p className="text-[11px] text-slate-500">Cada sesión = una conversación agéntica.</p>
          </div>
          <p className="text-[11px] text-slate-500">{sessions?.length ?? '…'} sesiones</p>
        </header>
        {error && <p className="px-4 py-3 text-xs text-rose-300">{error}</p>}
        {sessions === null && !error && <Skeleton rows={4} />}
        {sessions && sessions.length === 0 && (
          <p className="px-4 py-3 text-xs text-slate-500">Sin sesiones detectadas todavía.</p>
        )}
        {sessions && sessions.length > 0 && (
          <ul className="max-h-[560px] divide-y divide-slate-800/60 overflow-y-auto">
            {sessions.map((s) => (
              <SessionRow
                key={s.session_id}
                s={s}
                active={s.session_id === selected}
                onSelect={() => setSelected(s.session_id)}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="card-elev overflow-hidden">
        {selected ? (
          <ReplayView sessionId={selected} />
        ) : (
          <div className="flex h-[320px] items-center justify-center px-4 text-center text-[13px] text-slate-500">
            Seleccioná una sesión para ver el replay y sus métricas.
          </div>
        )}
      </div>
    </div>
  );
}

const PROVIDER_DOT: Record<string, string> = {
  claude: 'bg-violet-400',
  copilot: 'bg-emerald-400',
};

function SessionRow({
  s,
  active,
  onSelect,
}: {
  s: SessionSummary;
  active: boolean;
  onSelect: () => void;
}) {
  const tokens = s.tokens_input + s.tokens_output;
  const dot = PROVIDER_DOT[s.provider] ?? 'bg-slate-500';
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={`block w-full px-4 py-3 text-left transition-colors ${
          active ? 'bg-slate-800/70 ring-1 ring-inset ring-cyan-500/20' : 'hover:bg-slate-800/40'
        }`}
      >
        <div className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
            <span className="truncate font-mono text-[12px] text-slate-300">
              {s.session_id.slice(0, 8)}…
            </span>
          </span>
          {tokens > 0 && (
            <span className="shrink-0 rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-cyan-300">
              {fmtTokens(tokens)} tok
            </span>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
          <span>{fmtTime(s.started_at)}</span>
          <span className="text-slate-700">·</span>
          <span>{fmtDuration(s.duration_seconds)}</span>
          <span className="text-slate-700">·</span>
          <span className="text-slate-400">{s.turns} turns</span>
          {s.distinct_agents > 0 && (
            <>
              <span className="text-slate-700">·</span>
              <span className="text-violet-300">{s.distinct_agents} agents</span>
            </>
          )}
        </div>
        {s.models.length > 0 && (
          <p className="mt-1 truncate font-mono text-[10px] text-slate-600">
            {s.models.join(', ')}
          </p>
        )}
      </button>
    </li>
  );
}

function ReplayView({ sessionId }: { sessionId: string }) {
  const [data, setData] = useState<SessionReplayRead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showFlow, setShowFlow] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    setShowFlow(false);
    api
      .sessionReplay(sessionId, 500)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (error) return <p className="px-4 py-3 text-xs text-rose-300">{error}</p>;
  if (!data) return <Skeleton rows={6} />;

  const narrative = data.events.filter(
    (e) =>
      ['user', 'assistant', 'error'].includes(e.event_type) ||
      e.agent_mentions.length > 0 ||
      e.files_touched.length > 0,
  );

  const durationS = Math.round(
    (new Date(data.ended_at).getTime() - new Date(data.started_at).getTime()) / 1000,
  );

  const canShowFlow = data.agents_in_order.length >= 1;

  return (
    <>
      {showFlow && (
        <AgentFlowModal
          sessionId={data.session_id}
          events={data.events}
          onClose={() => setShowFlow(false)}
        />
      )}
      <header className="border-b border-slate-800/80 px-5 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-mono text-[11px] text-slate-400">{data.session_id}</p>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {fmtTime(data.started_at)} → {fmtTime(data.ended_at)} · {fmtDuration(durationS)}
            </p>
          </div>
          {canShowFlow && (
            <button
              type="button"
              onClick={() => setShowFlow(true)}
              className="shrink-0 rounded-md border border-violet-700/60 bg-violet-500/10 px-2.5 py-1 text-[11px] font-semibold text-violet-200 hover:bg-violet-500/20"
            >
              Ver flujo →
            </button>
          )}
        </div>

        {/* Stats grid */}
        <div className="mt-3 grid grid-cols-4 gap-px overflow-hidden rounded-lg bg-slate-800/40">
          <StatCell label="Turns" value={`${data.turns}`} />
          <StatCell label="Tokens in" value={fmtTokens(data.tokens.input)} tone="cyan" />
          <StatCell label="Tokens out" value={fmtTokens(data.tokens.output)} tone="emerald" />
          <StatCell label="Cache read" value={fmtTokens(data.tokens.cache_read)} />
        </div>

        {data.models.length > 0 && (
          <p className="mt-2 font-mono text-[10px] text-slate-500">
            {data.models.join(' · ')}
          </p>
        )}

        {data.agents_in_order.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1">
            {data.agents_in_order.slice(0, 14).map((a) => (
              <span
                key={a}
                className="rounded bg-violet-500/10 px-1.5 py-0.5 font-mono text-[10px] text-violet-200"
              >
                {a}
              </span>
            ))}
            {data.agents_in_order.length > 14 && (
              <span className="text-[10px] text-slate-500">+ {data.agents_in_order.length - 14}</span>
            )}
          </div>
        )}
      </header>

      <ExecutionsSection sessionId={data.session_id} />

      <details className="group">
        <summary className="cursor-pointer list-none px-5 py-2 text-[11px] text-slate-500 hover:text-slate-300">
          <span className="group-open:hidden">▸ Ver timeline crudo de eventos ({narrative.length})</span>
          <span className="hidden group-open:inline">▾ Timeline crudo de eventos</span>
        </summary>
        <ol className="max-h-[420px] divide-y divide-slate-800/60 overflow-y-auto">
          {narrative.slice(0, 200).map((e) => (
            <EventRow key={e.id} e={e} />
          ))}
          {narrative.length === 0 && (
            <li className="px-4 py-3 text-[11px] text-slate-500">
              Esta sesión no tiene eventos con valor narrativo.
            </li>
          )}
        </ol>
      </details>
    </>
  );
}

function ExecutionsSection({ sessionId }: { sessionId: string }) {
  const [execs, setExecs] = useState<ExecutionRead[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setExecs(null);
    api
      .sessionExecutions(sessionId)
      .then((e) => !cancelled && setExecs(e))
      .catch(() => !cancelled && setExecs([]));
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  return (
    <div className="border-b border-slate-800/60">
      <p className="flex items-baseline gap-2 px-5 pb-1 pt-3 text-[12px] font-semibold text-slate-200">
        Ejecuciones
        <span className="font-mono text-[10px] font-normal text-slate-500">
          {execs?.length ?? '…'} turnos · 1 turno = 1 ejecución
        </span>
      </p>
      {execs === null ? (
        <p className="px-5 py-2 text-[11px] text-slate-500">Cargando ejecuciones…</p>
      ) : (
        <ExecutionsList items={execs} />
      )}
    </div>
  );
}

function StatCell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'cyan' | 'emerald';
}) {
  const v =
    tone === 'cyan' ? 'text-cyan-300' : tone === 'emerald' ? 'text-emerald-300' : 'text-slate-100';
  return (
    <div className="bg-slate-950/50 px-3 py-2">
      <p className="text-[9.5px] font-semibold uppercase tracking-wider text-slate-500">{label}</p>
      <p className={`mt-0.5 font-mono text-[17px] font-bold tabular ${v}`}>{value}</p>
    </div>
  );
}

function EventRow({ e }: { e: SessionEvent }) {
  const time = new Date(e.timestamp).toLocaleTimeString();
  const color = EVENT_COLOR[e.event_type] ?? 'text-slate-300';
  const hasTokens = e.tokens_output != null && e.tokens_output > 0;
  const expandable = e.event_type === 'user' || e.event_type === 'assistant';

  const [open, setOpen] = useState(false);
  const [text, setText] = useState<TurnText | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = () => {
    if (!expandable) return;
    const next = !open;
    setOpen(next);
    if (next && !text && !loading) {
      setLoading(true);
      api
        .turnText(e.id)
        .then((t) => setText(t))
        .catch((err) => setText({ error: err.message } as TurnText))
        .finally(() => setLoading(false));
    }
  };

  return (
    <li className="px-5 py-2 transition-colors hover:bg-slate-800/20">
      <button
        type="button"
        onClick={toggle}
        disabled={!expandable}
        className="flex w-full items-baseline gap-3 text-left disabled:cursor-default"
      >
        {expandable && (
          <span className="font-mono text-[10px] text-slate-600">{open ? '▾' : '▸'}</span>
        )}
        <span className="font-mono text-[10px] text-slate-500 tabular">{time}</span>
        <span className={`font-mono text-[11px] font-semibold ${color}`}>{e.event_type}</span>
        {e.model && <span className="font-mono text-[10px] text-slate-600">{e.model}</span>}
        {hasTokens && (
          <span className="ml-auto font-mono text-[10px] text-slate-500 tabular">
            <span className="text-cyan-400/70">{e.tokens_input ?? 0}</span>
            <span className="text-slate-700">→</span>
            <span className="text-emerald-400/70">{e.tokens_output}</span> tok
          </span>
        )}
      </button>

      {/* Preview del prompt (user turns) — para ubicarse sin expandir */}
      {!open && e.prompt_preview && (
        <button
          type="button"
          onClick={toggle}
          className="mt-1 block w-full truncate pl-[26px] text-left text-[11.5px] italic text-slate-400 hover:text-slate-200"
          title={e.prompt_preview}
        >
          “{e.prompt_preview}”
        </button>
      )}

      {e.agent_mentions.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {Array.from(new Set(e.agent_mentions)).map((a) => (
            <span
              key={a}
              className="rounded bg-violet-500/15 px-1.5 py-0.5 font-mono text-[10px] text-violet-200"
            >
              {a}
            </span>
          ))}
        </div>
      )}
      {e.files_touched.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {e.files_touched.slice(0, 4).map((f) => (
            <span
              key={f}
              className="truncate rounded bg-slate-800/80 px-1.5 py-0.5 font-mono text-[9.5px] text-slate-400"
              title={f}
            >
              {f.split('/').pop()}
            </span>
          ))}
          {e.files_touched.length > 4 && (
            <span className="text-[9.5px] text-slate-600">+ {e.files_touched.length - 4}</span>
          )}
        </div>
      )}
      {e.error && <p className="mt-1 text-[11px] text-rose-300">{e.error}</p>}

      {/* Texto on-demand */}
      {open && (
        <div className="fade-in-row mt-2 rounded-md border border-slate-800 bg-slate-950/60 p-3">
          {loading && <p className="text-[11px] text-slate-500">Leyendo del archivo fuente…</p>}
          {text?.error && <p className="text-[11px] text-rose-300">{text.error}</p>}
          {text && !text.error && (
            <div className="space-y-2.5">
              {text.prompt && (
                <TurnBlock label="prompt" body={text.prompt} accent="text-cyan-300" />
              )}
              {text.response && (
                <TurnBlock label="response" body={text.response} accent="text-violet-300" />
              )}
              {!text.prompt && !text.response && (
                <p className="text-[11px] text-slate-500">Sin texto en este turn.</p>
              )}
              <p className="text-[9.5px] text-slate-600">
                sanitizado al vuelo · no persistido{text.truncated ? ' · truncado' : ''}
              </p>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function TurnBlock({ label, body, accent }: { label: string; body: string; accent: string }) {
  return (
    <div>
      <p className={`mb-1 font-mono text-[9.5px] font-semibold uppercase tracking-wider ${accent}`}>
        {label}
      </p>
      <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-slate-300">
        {body}
      </pre>
    </div>
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
