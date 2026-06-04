import { useEffect, useMemo, useState } from 'react';
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  type Edge,
  type Node,
  type NodeProps,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { api, type AgentInvocationRow, type SessionEvent } from '../lib/api';

interface Props {
  sessionId: string;
  events: SessionEvent[];
  onClose: () => void;
}

// ───────────────────── Categoría / color por agente ─────────────────────

type Category = 'planning' | 'frontend' | 'backend' | 'testing' | 'security' | 'devops' | 'infra';

const CAT_COLOR: Record<Category, string> = {
  planning: '#a78bfa',
  frontend: '#38bdf8',
  backend: '#34d399',
  testing: '#f472b6',
  security: '#fb7185',
  devops: '#fbbf24',
  infra: '#94a3b8',
};

const CAT_LABEL: Record<Category, string> = {
  planning: 'Planning',
  frontend: 'Frontend',
  backend: 'Backend',
  testing: 'Testing',
  security: 'Security',
  devops: 'DevOps',
  infra: 'Infra',
};

function agentCategory(name: string): Category {
  const n = name.toLowerCase();
  if (n.includes('tdd') || n.includes('test') || n.includes('e2e') || n.includes('playwright'))
    return 'testing';
  if (n.includes('frontend')) return 'frontend';
  if (n.includes('backend') || n.includes('satellite') || n.includes('sync-api')) return 'backend';
  if (n.includes('security') || n.includes('pre-merge')) return 'security';
  if (n.includes('devops') || n.includes('observability')) return 'devops';
  if (
    n.includes('speckit') ||
    n.includes('architect') ||
    n.includes('refinement') ||
    n.includes('orchestrator') ||
    n.includes('plan')
  )
    return 'planning';
  return 'infra';
}

// ───────────────────── Modelo de datos ─────────────────────

interface Deleg {
  agent: string;
  description: string | null;
  resultChars: number;
  model: string | null;
}

interface StepInfo {
  turn: number; // índice de aparición (1-based)
  label: string; // prompt del turno (truncado)
  time: string;
  delegations: Deleg[];
}

function buildSteps(invocations: AgentInvocationRow[], promptByReq: Map<string, string>): StepInfo[] {
  // Agrupar por request_id (turno). Preservar orden temporal.
  const byTurn = new Map<string, { ts: number; dels: Deleg[] }>();
  for (const iv of invocations) {
    const key = iv.request_id ?? iv.id;
    const ts = new Date(iv.timestamp).getTime();
    const entry = byTurn.get(key);
    const del: Deleg = {
      agent: iv.agent_name,
      description: iv.description,
      resultChars: iv.result_chars ?? 0,
      model: iv.model,
    };
    if (entry) {
      entry.dels.push(del);
      entry.ts = Math.min(entry.ts, ts);
    } else {
      byTurn.set(key, { ts, dels: [del] });
    }
  }
  const ordered = Array.from(byTurn.entries()).sort((a, b) => a[1].ts - b[1].ts);
  return ordered.map(([reqId, v], i) => {
    const prompt = promptByReq.get(reqId) ?? '';
    const label = prompt ? prompt.replace(/\s+/g, ' ').trim().slice(0, 52) : `Turno ${i + 1}`;
    return {
      turn: i + 1,
      label,
      time: new Date(v.ts).toLocaleTimeString(),
      delegations: v.dels,
    };
  });
}

// ───────────────────── Nodos ─────────────────────

interface AgentNodeData {
  label: string;
  category: Category;
  description: string | null;
  resultChars: number;
  model: string | null;
  selected: boolean;
  onSelect: (name: string) => void;
}

function AgentNode({ data }: NodeProps<AgentNodeData>) {
  const color = CAT_COLOR[data.category];
  const ok = data.resultChars > 0;
  return (
    <div
      onClick={() => data.onSelect(data.label)}
      className="cursor-pointer rounded-lg border bg-slate-950/90 px-3 py-2 transition-all"
      style={{
        borderColor: data.selected ? color : `${color}55`,
        boxShadow: data.selected ? `0 0 0 1px ${color}, 0 0 18px ${color}55` : `0 0 12px ${color}1a`,
        width: 216,
      }}
    >
      <Handle type="target" position={Position.Top} style={{ background: color, width: 6, height: 6, border: 'none' }} />
      <div className="flex items-center gap-1.5">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
        <span className="truncate font-mono text-[12px] font-medium text-slate-100">{data.label}</span>
      </div>
      {data.description && (
        <p className="mt-1 line-clamp-2 pl-3.5 text-[10.5px] leading-snug text-slate-400">
          {data.description}
        </p>
      )}
      <div className="mt-1.5 flex items-center gap-2 pl-3.5">
        <span
          className="rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold"
          style={{ background: `${ok ? '#34d39922' : '#fbbf2422'}`, color: ok ? '#6ee7b7' : '#fcd34d' }}
          title={ok ? 'Delegación con resultado devuelto' : 'Delegó pero retornó parcial/vacío'}
        >
          {ok ? `✓ ${data.resultChars}c` : '⚠ sin result'}
        </span>
        {data.model && <span className="truncate font-mono text-[9px] text-slate-600">{data.model}</span>}
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: color, width: 6, height: 6, border: 'none' }} />
    </div>
  );
}

interface TurnNodeData {
  turn: number;
  label: string;
  time: string;
  count: number;
}

function TurnNode({ data }: NodeProps<TurnNodeData>) {
  return (
    <div
      className="rounded-lg border border-slate-700 bg-slate-900/95 px-3 py-2"
      style={{ width: 200, boxShadow: '0 0 12px rgba(148,163,184,0.08)' }}
    >
      <Handle type="target" position={Position.Top} style={{ background: '#64748b', width: 6, height: 6, border: 'none' }} />
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] font-semibold text-slate-200">Turno {data.turn}</span>
        <span className="font-mono text-[9px] text-slate-500">{data.time}</span>
      </div>
      <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-snug text-slate-400">«{data.label}»</p>
      <p className="mt-1 font-mono text-[9px] text-cyan-400/80">{data.count} delegación{data.count !== 1 ? 'es' : ''}</p>
      <Handle type="source" position={Position.Bottom} style={{ background: '#64748b', width: 6, height: 6, border: 'none' }} />
    </div>
  );
}

// Swimlane de fondo que agrupa visualmente cada turno.
function BandNode({ data }: NodeProps<{ turn: number }>) {
  return (
    <div className="pointer-events-none relative h-full w-full rounded-2xl border border-dashed border-slate-700/45 bg-slate-500/[0.035]">
      <span className="absolute left-3 top-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-slate-600">
        Turno {data.turn}
      </span>
    </div>
  );
}

const nodeTypes = { agent: AgentNode, turn: TurnNode, band: BandNode };

// ───────────────────── Layout ─────────────────────

const COL_W = 250;
const AGENT_W = 216; // ancho del nodo de agente (ver AgentNode)
const ROW_H = 104; // alto por fila de agentes
const TURN_HEAD = 96; // espacio que ocupa el nodo de turno arriba
const TURN_GAP = 64; // separación entre turnos (swimlanes)
const BAND_PAD = 26; // padding del swimlane alrededor de su contenido
const MAX_COLS = 4;

function buildGraph(
  steps: StepInfo[],
  selectedAgent: string | null,
  onSelect: (name: string) => void,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const turnIds: string[] = [];
  let yCursor = 0;

  steps.forEach((step, si) => {
    const n = step.delegations.length;
    const cols = Math.min(n, MAX_COLS);
    const rows = Math.ceil(n / MAX_COLS);
    const agentsTop = yCursor + TURN_HEAD;
    const turnHeight = TURN_HEAD + rows * ROW_H;

    // Extent horizontal: nodo de turno [-100,100] + columnas de agentes.
    const leftCol = (0 - (cols - 1) / 2) * COL_W;
    const rightCol = (cols - 1 - (cols - 1) / 2) * COL_W + AGENT_W;
    const minX = Math.min(-100, leftCol);
    const maxX = Math.max(100, rightCol);

    // Swimlane de fondo (primero en el array → se dibuja detrás).
    nodes.push({
      id: `band-${si}`,
      type: 'band',
      position: { x: minX - BAND_PAD, y: yCursor - BAND_PAD },
      data: { turn: step.turn },
      draggable: false,
      selectable: false,
      style: { width: maxX - minX + BAND_PAD * 2, height: turnHeight + BAND_PAD },
      zIndex: 0,
    });

    const turnId = `turn-${si}`;
    turnIds.push(turnId);
    nodes.push({
      id: turnId,
      type: 'turn',
      position: { x: -100, y: yCursor },
      data: { turn: step.turn, label: step.label, time: step.time, count: step.delegations.length },
      draggable: true,
      zIndex: 1,
    });

    step.delegations.forEach((d, ai) => {
      const col = ai % MAX_COLS;
      const x = (col - (Math.min(n, MAX_COLS) - 1) / 2) * COL_W;
      const row = Math.floor(ai / MAX_COLS);
      const id = `s${si}-a${ai}`;
      nodes.push({
        id,
        type: 'agent',
        position: { x, y: agentsTop + row * ROW_H },
        data: {
          label: d.agent,
          category: agentCategory(d.agent),
          description: d.description,
          resultChars: d.resultChars,
          model: d.model,
          selected: selectedAgent === d.agent,
          onSelect,
        },
        draggable: true,
        zIndex: 1,
      });
      edges.push({
        id: `e-${turnId}-${id}`,
        source: turnId,
        target: id,
        style: { stroke: `${CAT_COLOR[agentCategory(d.agent)]}66`, strokeWidth: 1.5 },
        type: 'smoothstep',
      });
    });

    yCursor += turnHeight + TURN_GAP;
  });

  // Troncal entre turnos.
  for (let i = 0; i < turnIds.length - 1; i++) {
    edges.push({
      id: `trunk-${i}`,
      source: turnIds[i],
      target: turnIds[i + 1],
      animated: true,
      style: { stroke: 'rgba(103,232,249,0.3)', strokeWidth: 1.5, strokeDasharray: '4 4' },
      type: 'smoothstep',
    });
  }
  return { nodes, edges };
}

// ───────────────────── Vista secuencial (paso a paso) ─────────────────────

interface SeqStep {
  step: number; // 1-based global
  turn: number; // turno (1-based) al que pertenece
  iv: AgentInvocationRow;
}

function buildSequence(invocations: AgentInvocationRow[]): SeqStep[] {
  const sorted = [...invocations].sort((a, b) => {
    const ta = new Date(a.timestamp).getTime();
    const tb = new Date(b.timestamp).getTime();
    if (ta !== tb) return ta - tb;
    return (a.order_index ?? 0) - (b.order_index ?? 0);
  });
  let turn = 0;
  let lastReq: string | null = null;
  return sorted.map((iv, i) => {
    const req = iv.request_id ?? iv.id;
    if (req !== lastReq) {
      turn += 1;
      lastReq = req;
    }
    return { step: i + 1, turn, iv };
  });
}

function StepCard({ s, num }: { s: SeqStep; num: number }) {
  const [open, setOpen] = useState(false);
  const { iv } = s;
  const cat = agentCategory(iv.agent_name);
  const color = CAT_COLOR[cat];
  const ok = (iv.result_chars ?? 0) > 0;
  const hasDetail = !!(iv.sanitized_prompt || iv.sanitized_result);
  return (
    <li className="relative pl-12">
      {/* número del paso (local al turno) */}
      <span
        className="absolute left-2 top-0 flex h-7 w-7 items-center justify-center rounded-full border font-mono text-[11px] font-semibold"
        style={{ borderColor: `${color}88`, color, background: `${color}14` }}
      >
        {num}
      </span>
      <div className="rounded-lg border border-slate-800 bg-slate-900/70" style={{ boxShadow: `inset 2px 0 0 ${color}` }}>
        <div className="flex items-start justify-between gap-3 px-3 py-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
              <span className="truncate font-mono text-[12.5px] font-medium text-slate-100">
                {iv.agent_name}
              </span>
              <span className="text-[10px]" style={{ color }}>
                {CAT_LABEL[cat]}
              </span>
              {!iv.declared && (
                <span className="rounded bg-slate-800 px-1 text-[8.5px] uppercase text-slate-500">ext</span>
              )}
            </div>
            {iv.description && (
              <p className="mt-1 text-[11.5px] leading-snug text-slate-300">{iv.description}</p>
            )}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <span
              className="rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold"
              style={{ background: ok ? '#34d39922' : '#fbbf2422', color: ok ? '#6ee7b7' : '#fcd34d' }}
              title={ok ? 'Delegación con resultado devuelto' : 'Delegó pero retornó parcial/vacío'}
            >
              {ok ? `✓ ${iv.result_chars}c` : '⚠ sin result'}
            </span>
            <span className="font-mono text-[9px] text-slate-600">
              {new Date(iv.timestamp).toLocaleTimeString()}
            </span>
            {iv.model && <span className="font-mono text-[9px] text-slate-600">{iv.model}</span>}
          </div>
        </div>
        {/* Evidence (estructural) + Agent Claims (self-reported) */}
        <div className="grid gap-px border-t border-slate-800/70 bg-slate-800/40 sm:grid-cols-2">
          <DelegEvidence iv={iv} />
          <DelegClaims iv={iv} />
        </div>
        {hasDetail && (
          <div className="border-t border-slate-800/70">
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className="flex w-full items-center gap-1 px-3 py-1 text-left text-[10px] text-slate-500 hover:text-slate-300"
            >
              <span>{open ? '▾' : '▸'}</span>
              {open ? 'Ocultar texto crudo' : 'Ver consigna / resultado (texto crudo)'}
            </button>
            {open && (
              <div className="space-y-2 px-3 pb-3">
                {iv.sanitized_prompt && (
                  <DetailBlock label="Consigna (prompt)" text={iv.sanitized_prompt} />
                )}
                {iv.sanitized_result && (
                  <DetailBlock label="Resultado reportado por el agente" text={iv.sanitized_result} />
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

// Evidence: SOLO datos estructurales observados por el runtime.
function DelegEvidence({ iv }: { iv: AgentInvocationRow }) {
  const ok = (iv.result_chars ?? 0) > 0;
  const taskRef = inferTaskRef(iv.description);
  const rows: { ok: boolean | null; text: string }[] = [
    { ok: true, text: `Invocación ejecutada · tool ${iv.tool}` },
    { ok: (iv.prompt_chars ?? 0) > 0, text: `Prompt enviado — ${iv.prompt_chars ?? 0} chars` },
    { ok, text: ok ? `Respuesta recibida — ${iv.result_chars} chars` : 'Sin respuesta capturada' },
  ];
  if (taskRef) rows.push({ ok: true, text: `Vinculado a tarea ${taskRef}` });
  rows.push({ ok: null, text: iv.declared ? 'Agente declarado en el repo' : 'Agente no declarado (built-in)' });
  return (
    <div className="bg-slate-900/70 px-3 py-2">
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="text-[9.5px] font-semibold uppercase tracking-wide text-slate-500">Evidence</span>
        <ProvenanceBadge kind="evidence" />
      </div>
      <ul className="space-y-0.5">
        {rows.map((r, i) => (
          <li key={i} className="flex items-center gap-1.5 text-[11px]">
            <span className={r.ok === null ? 'text-slate-600' : r.ok ? 'text-emerald-400' : 'text-amber-400'}>
              {r.ok === null ? '·' : r.ok ? '✓' : '⚠'}
            </span>
            <span className="text-slate-300">{r.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Agent Claims: afirmaciones parseadas del result. NUNCA presentadas como hecho.
function DelegClaims({ iv }: { iv: AgentInvocationRow }) {
  const files = iv.claims?.files ?? [];
  const validations = iv.claims?.validations ?? [];
  const empty = files.length === 0 && validations.length === 0;
  return (
    <div className="bg-slate-900/70 px-3 py-2">
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="text-[9.5px] font-semibold uppercase tracking-wide text-slate-500">Agent Claims</span>
        <ProvenanceBadge kind="claim" />
      </div>
      {empty ? (
        <p className="text-[10.5px] text-slate-600">— El agente no reportó archivos ni validaciones.</p>
      ) : (
        <div className="space-y-2">
          {validations.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {validations.map((v) => {
                const pass = v.status === 'pass';
                return (
                  <span
                    key={v.label}
                    className="rounded px-1.5 py-0.5 font-mono text-[9.5px] font-semibold"
                    style={{ background: pass ? '#34d39918' : '#fb718518', color: pass ? '#6ee7b7' : '#fda4af' }}
                  >
                    {pass ? 'PASS' : 'FAIL'} {v.label}
                  </span>
                );
              })}
            </div>
          )}
          {files.length > 0 && (
            <div>
              <p className="mb-0.5 text-[9px] uppercase tracking-wide text-slate-600">
                Files touched ({files.length})
              </p>
              <ul className="space-y-0.5">
                {files.slice(0, 8).map((f) => (
                  <li key={f} className="truncate font-mono text-[10.5px] text-slate-400" title={f}>
                    {shortPath(f)}
                  </li>
                ))}
                {files.length > 8 && (
                  <li className="text-[9.5px] text-slate-600">+ {files.length - 8} más</li>
                )}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DetailBlock({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <p className="mb-1 text-[9.5px] font-semibold uppercase tracking-wide text-slate-600">{label}</p>
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded bg-slate-950/70 px-2.5 py-2 font-mono text-[10.5px] leading-relaxed text-slate-300">
        {text}
      </pre>
    </div>
  );
}

interface TurnGroup {
  turn: number;
  key: string;
  steps: SeqStep[];
}

function groupByTurn(steps: SeqStep[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  for (const s of steps) {
    const key = s.iv.request_id ?? s.iv.id;
    const last = groups[groups.length - 1];
    if (!last || last.turn !== s.turn) {
      groups.push({ turn: s.turn, key, steps: [s] });
    } else {
      last.steps.push(s);
    }
  }
  return groups;
}

function TurnGroupCard({
  group,
  prompt,
  multi,
}: {
  group: TurnGroup;
  prompt: string | undefined;
  multi: boolean;
}) {
  const withResult = group.steps.filter((s) => (s.iv.result_chars ?? 0) > 0).length;
  return (
    <section className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/30">
      {/* Header del turno: chip + métricas + prompt disparador */}
      <header className="border-b border-slate-800 bg-cyan-500/[0.05] px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {multi && (
              <span className="rounded bg-cyan-500/15 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-cyan-300">
                Turno {group.turn}
              </span>
            )}
            <span className="text-[11px] text-slate-400">
              {group.steps.length} delegación{group.steps.length !== 1 ? 'es' : ''} · {withResult} con
              resultado
            </span>
          </div>
        </div>
        <p className="mt-2 whitespace-pre-wrap text-[12px] leading-snug text-slate-200">
          {prompt ? (
            <>
              <span className="text-[9.5px] font-semibold uppercase tracking-wide text-cyan-400/70">
                prompt que disparó:{' '}
              </span>
              “{prompt}”
            </>
          ) : (
            <span className="text-slate-500">— prompt disparador no disponible</span>
          )}
        </p>
      </header>
      {/* Pasos del turno, numerados localmente */}
      <ol className="relative space-y-3 p-4">
        {group.steps.length > 1 && (
          <span className="pointer-events-none absolute bottom-5 left-[38px] top-5 w-px bg-slate-800" />
        )}
        {group.steps.map((s, i) => (
          <StepCard key={s.iv.id} s={s} num={i + 1} />
        ))}
      </ol>
    </section>
  );
}

function SequenceView({
  steps,
  promptByTurn,
}: {
  steps: SeqStep[];
  promptByTurn: Map<string, string>;
}) {
  const groups = groupByTurn(steps);
  return (
    <div className="h-full overflow-y-auto px-5 py-4">
      <div className="mx-auto max-w-3xl space-y-5">
        {groups.map((g) => (
          <TurnGroupCard key={g.key} group={g} prompt={promptByTurn.get(g.key)} multi={groups.length > 1} />
        ))}
      </div>
    </div>
  );
}

// ───────────────────── Vista Prompt (prompt inicial del usuario) ─────────────

interface PromptTurn {
  turn: number;
  key: string;
  count: number;
  time: string;
  eventId: string | null;
  preview: string | null;
}

function PromptTurnCard({ t, multi }: { t: PromptTurn; multi: boolean }) {
  const [full, setFull] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    if (!t.eventId) return;
    let cancelled = false;
    setLoading(true);
    api
      .turnText(t.eventId)
      .then((r) => {
        if (cancelled) return;
        setFull(r.prompt ?? null);
        setTruncated(r.truncated);
      })
      .catch(() => !cancelled && setFull(null))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [t.eventId]);

  const text = full ?? t.preview;
  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/60">
      <header className="flex items-center justify-between border-b border-slate-800/70 px-4 py-2">
        <div className="flex items-center gap-2">
          {multi && (
            <span className="rounded bg-cyan-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-cyan-300">
              Turno {t.turn}
            </span>
          )}
          <span className="text-[11px] text-slate-500">
            disparó {t.count} delegación{t.count !== 1 ? 'es' : ''}
          </span>
        </div>
        <span className="font-mono text-[10px] text-slate-600">{new Date(t.time).toLocaleTimeString()}</span>
      </header>
      <div className="px-4 py-3">
        {loading && !full ? (
          <p className="text-[12px] text-slate-500">Cargando prompt completo…</p>
        ) : text ? (
          <pre className="max-h-[52vh] overflow-auto whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-slate-200">
            {text}
          </pre>
        ) : (
          <p className="text-[12px] text-slate-500">— Prompt no disponible para este turno.</p>
        )}
        {truncated && (
          <p className="mt-2 text-[10px] text-slate-600">(prompt truncado por tamaño)</p>
        )}
        {!full && t.preview && t.eventId && !loading && (
          <p className="mt-2 text-[10px] text-slate-600">(preview — no se pudo leer el texto completo)</p>
        )}
      </div>
    </section>
  );
}

function PromptView({ turns }: { turns: PromptTurn[] }) {
  return (
    <div className="h-full overflow-y-auto px-5 py-4">
      <div className="mx-auto max-w-3xl space-y-4">
        <p className="text-[11px] text-slate-500">
          Prompt{turns.length !== 1 ? 's' : ''} inicial{turns.length !== 1 ? 'es' : ''} del usuario que
          desencadenó{turns.length !== 1 ? 'aron' : ''} las delegaciones de esta sesión.
        </p>
        {turns.map((t) => (
          <PromptTurnCard key={t.key} t={t} multi={turns.length > 1} />
        ))}
      </div>
    </div>
  );
}

// ───────────────────── Evidence / Claims helpers ─────────────────────

const TASK_RE = /\b(T\d{2,}[a-z]?|HU-\d+-[A-Z]+)\b/;
function inferTaskRef(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.match(TASK_RE);
  return m ? m[1].toUpperCase() : null;
}
function fmtDur(s: number): string {
  if (s <= 0) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}
function fmtTok(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return `${n}`;
}
// Recorta prefijos absolutos para legibilidad (sigue siendo un claim del agente).
function shortPath(p: string): string {
  const m = p.match(/(?:^|\/)(?:projects\/[^/]+\/)(.+)$/);
  if (m) return m[1];
  return p;
}

// Badge de procedencia: estructural (evidence) vs self-reported (claim).
function ProvenanceBadge({ kind }: { kind: 'evidence' | 'claim' }) {
  const ev = kind === 'evidence';
  return (
    <span
      className={`rounded px-1.5 py-0.5 font-mono text-[8.5px] font-semibold uppercase tracking-wider ${
        ev ? 'bg-sky-500/12 text-sky-300/90' : 'bg-amber-500/12 text-amber-300/90'
      }`}
      title={ev ? 'Observado por el runtime — evidencia estructural' : 'Afirmado por el agente en su resultado — no verificado'}
    >
      {ev ? 'evidence' : 'self reported'}
    </span>
  );
}

interface DelegSummary {
  dele: number;
  agents: number;
  prompts: number;
  responses: number;
  dur: number;
  tokens: number;
  confidence: number;
  factors: { label: string; value: number; weight: number }[];
}

function computeSummary(invocations: AgentInvocationRow[], events: SessionEvent[]): DelegSummary {
  const dele = invocations.length;
  const agents = new Set(invocations.map((i) => i.agent_name)).size;
  const prompts = invocations.filter((i) => (i.prompt_chars ?? 0) > 0).length;
  const responses = invocations.filter((i) => (i.result_chars ?? 0) > 0).length;
  const declared = invocations.filter((i) => i.declared).length;
  const substantive = invocations.filter((i) => (i.result_chars ?? 0) >= 50).length;
  const ts = events.map((e) => new Date(e.timestamp).getTime()).filter((n) => !Number.isNaN(n));
  const dur = ts.length ? Math.round((Math.max(...ts) - Math.min(...ts)) / 1000) : 0;
  const tokens = events.reduce((a, e) => a + (e.tokens_input ?? 0) + (e.tokens_output ?? 0), 0);
  const errs = events.filter((e) => e.error).length;

  // Confianza: SOLO señales estructurales (sin claims). Pesos visibles.
  const responseRate = dele ? responses / dele : 0;
  const substantiveRate = dele ? substantive / dele : 0;
  const declaredRate = dele ? declared / dele : 0;
  const errorFree = events.length ? 1 - errs / events.length : 1;
  const factors = [
    { label: 'Respuestas recibidas', value: responseRate, weight: 0.45 },
    { label: 'Respuestas sustantivas (≥50c)', value: substantiveRate, weight: 0.25 },
    { label: 'Agentes declarados', value: declaredRate, weight: 0.2 },
    { label: 'Sesión sin errores', value: errorFree, weight: 0.1 },
  ];
  const confidence = Math.round(100 * factors.reduce((a, f) => a + f.value * f.weight, 0));
  return { dele, agents, prompts, responses, dur, tokens, confidence, factors };
}

function SessionSummaryBar({ summary }: { summary: DelegSummary }) {
  const [open, setOpen] = useState(false);
  const s = summary;
  const confColor = s.confidence >= 80 ? '#6ee7b7' : s.confidence >= 60 ? '#fcd34d' : '#fda4af';
  const cells: [string, string][] = [
    ['Delegaciones', `${s.dele}`],
    ['Agentes únicos', `${s.agents}`],
    ['Prompts enviados', `${s.prompts}`],
    ['Respuestas recibidas', `${s.responses}/${s.dele}`],
    ['Duración', fmtDur(s.dur)],
    ['Tokens', fmtTok(s.tokens)],
  ];
  return (
    <div className="border-b border-slate-800/80 bg-slate-950/40 px-5 py-2.5">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.12em] text-slate-500">
          Session evidence
        </span>
        {cells.map(([label, val]) => (
          <div key={label} className="flex items-baseline gap-1.5">
            <span className="text-[10px] text-slate-500">{label}</span>
            <span className="font-mono text-[13px] font-semibold text-slate-100">{val}</span>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="ml-auto flex items-center gap-1.5 rounded border border-slate-700/70 px-2 py-1 text-[10px] text-slate-400 hover:bg-slate-800"
          title="Confianza calculada solo con evidencia estructural"
        >
          <span className="uppercase tracking-wider">Confidence</span>
          <span className="font-mono text-[13px] font-semibold" style={{ color: confColor }}>
            {s.confidence}%
          </span>
          <span className="text-slate-600">{open ? '▾' : '▸'}</span>
        </button>
      </div>
      {open && (
        <div className="mt-2 rounded-md border border-slate-800 bg-slate-900/60 p-2.5">
          <p className="mb-1.5 text-[10px] text-slate-500">
            Solo señales estructurales (sin claims de tests/lint/contract del agente):
          </p>
          <ul className="space-y-1">
            {s.factors.map((f) => (
              <li key={f.label} className="flex items-center gap-2 text-[11px]">
                <span className="w-52 shrink-0 text-slate-400">{f.label}</span>
                <span className="h-1.5 w-24 overflow-hidden rounded bg-slate-800">
                  <span className="block h-full bg-sky-500/60" style={{ width: `${f.value * 100}%` }} />
                </span>
                <span className="font-mono text-[10px] text-slate-400">{Math.round(f.value * 100)}%</span>
                <span className="font-mono text-[9px] text-slate-600">×{f.weight}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ───────────────────── Modal ─────────────────────

export function AgentFlowModal({ sessionId, events, onClose }: Props) {
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [invocations, setInvocations] = useState<AgentInvocationRow[] | null>(null);
  const [view, setView] = useState<'graph' | 'sequence' | 'prompt'>('graph');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setInvocations(null);
    api
      .runtimeInvocations({ sessionId, limit: 500 })
      .then((rows) => !cancelled && setInvocations(rows))
      .catch(() => !cancelled && setInvocations([]));
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // turn_id (o request_id) → prompt DISPARADOR del turno. prompt_preview ahora
  // solo viene en los prompts reales de usuario (no en tool_results), y se linkea
  // con invocation.request_id (= turn_id en Claude).
  const promptByReq = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of events) {
      const key = e.turn_id ?? e.request_id;
      if (key && e.prompt_preview && !m.has(key)) {
        m.set(key, e.prompt_preview);
      }
    }
    return m;
  }, [events]);

  const steps = useMemo(
    () => buildSteps(invocations ?? [], promptByReq),
    [invocations, promptByReq],
  );
  const { nodes, edges } = useMemo(
    () => buildGraph(steps, selectedAgent, setSelectedAgent),
    [steps, selectedAgent],
  );
  const sequence = useMemo(() => buildSequence(invocations ?? []), [invocations]);
  const summary = useMemo(
    () => (invocations ? computeSummary(invocations, events) : null),
    [invocations, events],
  );

  // Turnos con delegación → su prompt disparador (evento user real). eventId
  // permite traer el prompt COMPLETO on-demand vía /events/:id/text.
  const promptTurns = useMemo(() => {
    const byTurn = new Map<string, { turn: number; key: string; count: number; time: string }>();
    for (const s of sequence) {
      const key = s.iv.request_id ?? s.iv.id;
      const e = byTurn.get(key);
      if (e) e.count += 1;
      else byTurn.set(key, { turn: s.turn, key, count: 1, time: s.iv.timestamp });
    }
    return Array.from(byTurn.values())
      .sort((a, b) => a.turn - b.turn)
      .map((t) => {
        const ev = events.find(
          (e) => e.event_type === 'user' && (e.turn_id ?? e.request_id) === t.key && !!e.prompt_preview,
        );
        return {
          ...t,
          eventId: ev?.id ?? null,
          preview: ev?.prompt_preview ?? promptByReq.get(t.key) ?? null,
        };
      });
  }, [sequence, events, promptByReq]);

  const inspector = useMemo(() => {
    if (!selectedAgent || !invocations) return null;
    const mine = invocations.filter((iv) => iv.agent_name === selectedAgent);
    const times = mine.map((iv) => new Date(iv.timestamp).getTime());
    const first = times.length ? new Date(Math.min(...times)) : null;
    const last = times.length ? new Date(Math.max(...times)) : null;
    const models = Array.from(new Set(mine.map((iv) => iv.model).filter(Boolean))) as string[];
    const withResult = mine.filter((iv) => (iv.result_chars ?? 0) > 0).length;
    const tasks = mine
      .map((iv) => ({ desc: iv.description, hasResult: (iv.result_chars ?? 0) > 0 }))
      .filter((t) => t.desc) as { desc: string; hasResult: boolean }[];
    return {
      name: selectedAgent,
      category: agentCategory(selectedAgent),
      declared: mine[0]?.declared ?? false,
      appearances: mine.length,
      withResult,
      models,
      tasks,
      first,
      last,
    };
  }, [selectedAgent, invocations]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-6" onClick={onClose}>
      <div className="hero-card flex h-[85vh] w-full max-w-6xl flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-slate-800/80 px-5 py-3">
          <div>
            <p className="text-[15px] font-semibold tracking-tight text-slate-100">Flujo de delegaciones</p>
            <p className="font-mono text-[11px] text-slate-500">
              {sessionId} · {steps.length} turno{steps.length !== 1 ? 's' : ''} con delegación ·{' '}
              {steps.reduce((a, s) => a + s.delegations.length, 0)} delegaciones reales
            </p>
          </div>
          <div className="flex items-center gap-2">
            {steps.length > 0 && (
              <div className="flex overflow-hidden rounded-md border border-slate-700">
                {(['graph', 'sequence', 'prompt'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setView(v)}
                    className={`px-2.5 py-1 text-[11px] transition-colors ${
                      view === v
                        ? 'bg-slate-700 text-slate-100'
                        : 'text-slate-400 hover:bg-slate-800'
                    }`}
                  >
                    {v === 'graph' ? 'Grafo' : v === 'sequence' ? 'Secuencia' : 'Prompt'}
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
            >
              Cerrar · Esc
            </button>
          </div>
        </header>

        {summary && steps.length > 0 && <SessionSummaryBar summary={summary} />}

        <div className="flex min-h-0 flex-1">
          <div className="relative min-w-0 flex-1">
            {invocations === null ? (
              <div className="flex h-full items-center justify-center text-[13px] text-slate-500">
                Cargando delegaciones…
              </div>
            ) : steps.length === 0 ? (
              <div className="flex h-full max-w-sm flex-col items-center justify-center gap-1 text-center text-[13px] text-slate-500 mx-auto">
                <p>El orchestrator no delegó en sub-agentes en esta sesión.</p>
                <p className="text-[11px] text-slate-600">
                  (No hay tool calls runSubagent — las menciones de texto no cuentan como intervención.)
                </p>
              </div>
            ) : view === 'sequence' ? (
              <SequenceView steps={sequence} promptByTurn={promptByReq} />
            ) : view === 'prompt' ? (
              <PromptView turns={promptTurns} />
            ) : (
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                defaultViewport={{ x: 480, y: 40, zoom: 0.8 }}
                minZoom={0.15}
                maxZoom={1.5}
                proOptions={{ hideAttribution: true }}
                onPaneClick={() => setSelectedAgent(null)}
              >
                <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#1e293b" />
                <Controls showInteractive={false} className="!border-slate-700 !bg-slate-900" />
                <MiniMap
                  pannable
                  zoomable
                  nodeColor={(n) =>
                    n.type === 'band'
                      ? 'rgba(100,116,139,0.10)'
                      : n.type === 'turn'
                        ? '#475569'
                        : CAT_COLOR[(n.data as AgentNodeData).category]
                  }
                  maskColor="rgba(5,11,22,0.7)"
                  className="!border !border-slate-800 !bg-slate-950"
                />
                <div className="pointer-events-none absolute left-3 top-3 z-10 max-w-xs rounded-md border border-slate-800 bg-slate-950/80 px-2.5 py-1.5">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                    Delegaciones paralelas
                  </p>
                  <p className="mt-0.5 text-[10px] leading-snug text-slate-500">
                    orchestrator → agentes (hermanos). La jerarquía parent-child entre
                    sub-agentes no es observable → no se infiere.
                  </p>
                </div>
              </ReactFlow>
            )}
          </div>

          {view === 'graph' && inspector && (
            <aside className="w-64 shrink-0 border-l border-slate-800/80 bg-slate-950/60 p-4">
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: CAT_COLOR[inspector.category] }} />
                <p className="truncate font-mono text-[13px] font-semibold text-slate-100">{inspector.name}</p>
              </div>
              <p className="mt-1 flex items-center gap-1.5 text-[11px] font-medium" style={{ color: CAT_COLOR[inspector.category] }}>
                {CAT_LABEL[inspector.category]}
                {!inspector.declared && (
                  <span className="rounded border border-slate-700 bg-slate-800/60 px-1 py-0.5 font-mono text-[8.5px] uppercase text-slate-500">
                    no-decl
                  </span>
                )}
              </p>
              <dl className="mt-4 space-y-2 text-[12px]">
                <Row label="Delegaciones" value={`${inspector.appearances}`} />
                <Row label="Con resultado" value={`${inspector.withResult}/${inspector.appearances}`} />
                <Row label="Modelos" value={inspector.models.join(', ') || '—'} />
                <Row label="Primera" value={inspector.first ? inspector.first.toLocaleTimeString() : '—'} />
                <Row label="Última" value={inspector.last ? inspector.last.toLocaleTimeString() : '—'} />
              </dl>
              {inspector.tasks.length > 0 && (
                <div className="mt-4">
                  <p className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-slate-500">
                    Tareas delegadas
                  </p>
                  <ul className="space-y-1">
                    {inspector.tasks.map((t, i) => (
                      <li
                        key={i}
                        className="flex items-center gap-1.5 truncate rounded bg-slate-900/60 px-2 py-1 text-[11px] text-slate-300"
                        title={`${t.desc}${t.hasResult ? '' : ' — sin resultado devuelto'}`}
                      >
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${t.hasResult ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                        <span className="truncate">{t.desc}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="mt-4 text-[10.5px] leading-relaxed text-slate-500">
                Delegaciones reales (runSubagent) del orchestrator en esta sesión.
              </p>
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-mono text-slate-200">{value}</dd>
    </div>
  );
}
