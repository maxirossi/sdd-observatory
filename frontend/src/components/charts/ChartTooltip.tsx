/** Tooltip glass reutilizable para charts Nivo.
 *
 * Nivo pasa tooltips por render-prop; estos componentes le dan un look
 * consistente (glass + border + sombra) en vez del default. */

interface Row {
  color: string;
  label: string;
  value: number | string;
}

export function GlassTooltip({
  title,
  rows,
  footer,
}: {
  title?: string;
  rows: Row[];
  footer?: { label: string; value: number | string };
}) {
  return (
    <div className="min-w-[150px] px-3 py-2.5">
      {title && <p className="mb-1.5 text-[12px] font-semibold text-slate-100">{title}</p>}
      <ul className="space-y-1">
        {rows.map((r, i) => (
          <li key={i} className="flex items-center gap-2 text-[11px]">
            <span className="h-2 w-2 rounded-sm" style={{ background: r.color }} />
            <span className="text-slate-400">{r.label}</span>
            <span className="ml-auto font-mono tabular text-slate-200">{r.value}</span>
          </li>
        ))}
      </ul>
      {footer && (
        <div className="mt-1.5 flex items-center justify-between border-t border-slate-700/50 pt-1.5 text-[11px]">
          <span className="text-slate-500">{footer.label}</span>
          <span className="font-mono tabular text-slate-100">{footer.value}</span>
        </div>
      )}
    </div>
  );
}
