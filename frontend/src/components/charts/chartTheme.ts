/** Theme dark compartido por todos los charts Nivo.
 *  Tipado estructural (sin import del tipo Theme, que cambió de módulo
 *  entre versiones de Nivo). */
export const nivoDarkTheme = {
  background: 'transparent',
  text: {
    fill: '#94a3b8',
    fontSize: 12,
    fontFamily: 'inherit',
  },
  axis: {
    domain: { line: { stroke: 'transparent' } },
    ticks: {
      line: { stroke: 'transparent' },
      text: { fill: '#94a3b8', fontSize: 10.5 },
    },
    legend: { text: { fill: '#cbd5e1', fontSize: 11 } },
  },
  grid: {
    line: { stroke: 'rgba(148,163,184,0.10)', strokeDasharray: '2 5' },
  },
  legends: {
    text: { fill: '#cbd5e1', fontSize: 11 },
  },
  tooltip: {
    container: {
      background: 'rgba(10,14,28,0.85)',
      color: '#f8fafc',
      fontSize: 12,
      border: '1px solid rgba(120,160,255,0.16)',
      borderRadius: '10px',
      boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
      padding: 0,
    },
  },
};

/** Paleta semántica — alineada con CyclesPanel y el resto de la UI. */
export const chartColors = {
  // status
  done: '#34d399', // emerald-400
  in_progress: '#fbbf24', // amber-400 (alias: wip)
  wip: '#fbbf24',
  pending: '#94a3b8', // slate-400
  unknown: '#52525b', // zinc-500
  // domains
  backend: '#34d399',
  frontend: '#38bdf8', // sky
  wrapper: '#a78bfa', // violet
  devops: '#fbbf24', // amber
  security: '#fb7185', // rose
  e2e: '#f472b6', // pink
  api: '#60a5fa', // blue
  docs: '#94a3b8',
  other: '#64748b',
} as const;

export function colorFor(key: string): string {
  return (chartColors as Record<string, string>)[key] ?? '#64748b';
}
