import { useParams } from 'react-router-dom';
import { ExplorerPanel } from '../components/ExplorerPanel';
import { PageHeader } from '../components/PageHeader';

export function ExplorerPage() {
  const { projectId } = useParams<{ projectId: string }>();
  if (!projectId) return null;
  return (
    <div>
      <PageHeader
        title="Explorer"
        subtitle="Árbol del repo con cross-info: agents (A), docs (D), tasks (T), menciones."
      />
      <div className="p-6">
        <ExplorerPanel projectId={projectId} />
      </div>
    </div>
  );
}
