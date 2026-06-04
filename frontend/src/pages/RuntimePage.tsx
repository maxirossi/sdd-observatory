import { useParams } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { RuntimeInsightsPanel } from '../components/RuntimeInsightsPanel';
import { RuntimeObservabilityPanel } from '../components/RuntimeObservabilityPanel';
import { RuntimePanel } from '../components/RuntimePanel';
import { RuntimeSourcesPanel } from '../components/RuntimeSourcesPanel';

export function RuntimePage() {
  const { projectId } = useParams<{ projectId: string }>();
  if (!projectId) return null;
  return (
    <div>
      <PageHeader
        title="Runtime"
        subtitle="Eventos reales, providers y fuentes de captura."
        badge={
          <span className="inline-flex items-center gap-2 rounded-full border border-cyan-700/50 bg-cyan-500/10 px-3 py-1 text-[11px] font-semibold text-cyan-300">
            <span className="pulse-dot bg-cyan-400" />
            STREAMING
          </span>
        }
      />
      <div className="space-y-5 p-6">
        <RuntimeObservabilityPanel projectId={projectId} />
        <RuntimeInsightsPanel projectId={projectId} />
        <RuntimeSourcesPanel projectId={projectId} />
        <RuntimePanel projectId={projectId} />
      </div>
    </div>
  );
}
