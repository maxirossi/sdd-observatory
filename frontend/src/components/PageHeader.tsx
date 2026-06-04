interface Props {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  badge?: React.ReactNode;
}

export function PageHeader({ title, subtitle, actions, badge }: Props) {
  return (
    <header className="flex items-baseline justify-between border-b border-slate-800/80 bg-[#070a14] px-6 py-5">
      <div className="min-w-0">
        <div className="flex items-baseline gap-3">
          <h1
            className="text-[24px] font-bold tracking-tight text-slate-50"
            style={{ letterSpacing: '-0.02em' }}
          >
            {title}
          </h1>
          {badge}
        </div>
        {subtitle && <p className="mt-1 text-[13px] text-slate-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}
