import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AgentGraphPanel } from '../components/AgentGraphPanel';
import { PageHeader } from '../components/PageHeader';
import { SessionsPanel } from '../components/SessionsPanel';
import { TopAgentsPanel } from '../components/TopAgentsPanel';
import { api, type SessionSummary } from '../lib/api';

export function SessionsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);

  useEffect(() => {
    if (!projectId) return;
    api
      .sessions(projectId, 1)
      .then(setSessions)
      .catch(() => setSessions([]));
  }, [projectId]);

  if (!projectId) return null;

  const hasSessions = sessions === null || sessions.length > 0;

  return (
    <div>
      <PageHeader title="Sessions" subtitle="Replay narrativo y coordinación de agentes." />
      <div className="space-y-5 p-6">
        {sessions !== null && sessions.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            <SessionsPanel projectId={projectId} />
            {hasSessions && <TopAgentsPanel projectId={projectId} />}
            {hasSessions && <AgentGraphPanel projectId={projectId} />}
          </>
        )}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="card-elev px-6 py-10 text-center">
      <p className="text-[18px] font-semibold text-slate-100">Sin sesiones runtime aún</p>
      <p className="mx-auto mt-2 max-w-xl text-[13px] text-slate-400">
        Las sesiones se reconstruyen desde los logs de Claude Code (jsonl agrupados por{' '}
        <code className="rounded bg-slate-800 px-1 font-mono text-[11.5px]">session_id</code>).
        Para verlas acá necesitás activar el provider Claude y tener logs de sesiones en el
        directorio configurado.
      </p>
      <div className="mt-4 inline-block rounded-md border border-slate-800 bg-slate-950/60 px-4 py-2 text-left font-mono text-[12px] text-slate-400">
        <span className="text-slate-500">$</span> UPDATE provider_configs SET enabled=true WHERE
        provider='claude';
      </div>
    </div>
  );
}
