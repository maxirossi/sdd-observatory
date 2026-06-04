import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { api, type ProjectRead } from '../lib/api';

export function ProjectsLandingPage() {
  const [projects, setProjects] = useState<ProjectRead[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api
      .projects()
      .then(setProjects)
      .catch((e) => setError(e.message));
  }, []);

  // Auto-redirect si solo hay un proyecto — escenario típico de single-project.
  if (projects && projects.length === 1) {
    return <Navigate to={`/projects/${projects[0].id}/overview`} replace />;
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      <header className="border-b border-slate-800/80 bg-[#070a14] px-6 py-5">
        <p className="font-mono text-[12px] text-cyan-300">SDD Observatory</p>
        <h1 className="mt-1 text-[26px] font-bold tracking-tight text-slate-50" style={{ letterSpacing: '-0.02em' }}>
          Projects
        </h1>
      </header>
      <div className="p-6">
        {error && <p className="text-[12px] text-rose-300">{error}</p>}
        {!projects && !error && (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-32 animate-pulse rounded-xl bg-slate-900" />
            ))}
          </div>
        )}
        {projects && projects.length === 0 && (
          <div className="rounded-xl border border-slate-800 bg-slate-900 p-6 text-center">
            <p className="text-[13px] text-slate-300">No hay proyectos scaneados.</p>
            <p className="mt-1 text-[11px] text-slate-500">
              Ejecutá <code className="text-slate-300">docker compose exec backend python -m app.cli scan-project /workspaces/target</code>
            </p>
          </div>
        )}
        {projects && projects.length > 1 && (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => navigate(`/projects/${p.id}/overview`)}
                className="card-elev card-elev-hover p-5 text-left"
              >
                <p className="text-[16px] font-bold tracking-tight text-slate-50">{p.name}</p>
                <p className="mt-1 truncate font-mono text-[11.5px] text-slate-500" title={p.path}>
                  {p.path}
                </p>
                <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
                  <Stat label="agents" value={p.agents_count} />
                  <Stat label="docs" value={p.documents_count} />
                  <Stat label="tasks" value={p.tasks_count} />
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded bg-slate-950 px-2 py-1.5">
      <p className="font-mono text-[9px] uppercase tracking-wider text-slate-500">{label}</p>
      <p className="text-slate-100">{value}</p>
    </div>
  );
}
