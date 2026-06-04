import { useParams } from 'react-router-dom';
import { CyclesPanel } from '../components/CyclesPanel';
import { PageHeader } from '../components/PageHeader';

export function CyclesPage() {
  const { projectId } = useParams<{ projectId: string }>();
  if (!projectId) return null;
  return (
    <div>
      <PageHeader title="Cycles" subtitle="Progreso por ciclo y dominio." />
      <div className="p-6">
        <CyclesPanel projectId={projectId} />
      </div>
    </div>
  );
}
