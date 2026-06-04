import { useParams } from 'react-router-dom';
import { AgentEffectivenessPanel } from '../components/AgentEffectivenessPanel';
import { FindingsPanel } from '../components/FindingsPanel';
import { IntelligencePanel } from '../components/IntelligencePanel';
import { PageHeader } from '../components/PageHeader';
import { TaskFlowsPanel } from '../components/TaskFlowsPanel';
import { UsagePanel } from '../components/UsagePanel';
import { Wave5Panel } from '../components/Wave5Panel';

export function IntelligencePage() {
  const { projectId } = useParams<{ projectId: string }>();
  if (!projectId) return null;
  return (
    <div>
      <PageHeader
        title="Intelligence"
        subtitle="Inferencias, anomalías y cobertura del proceso agéntico."
      />
      <div className="space-y-4 p-6">
        <UsagePanel projectId={projectId} />
        <AgentEffectivenessPanel projectId={projectId} />
        <TaskFlowsPanel projectId={projectId} />
        <IntelligencePanel projectId={projectId} />
        <Wave5Panel projectId={projectId} />
        <FindingsPanel projectId={projectId} />
      </div>
    </div>
  );
}
