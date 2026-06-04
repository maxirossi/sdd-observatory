import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from './layouts/AppLayout';
import { AgentsPage } from './pages/AgentsPage';
import { CyclesPage } from './pages/CyclesPage';
import { AuditPage } from './pages/AuditPage';
import { ExecutionsPage } from './pages/ExecutionsPage';
import { ExplorerPage } from './pages/ExplorerPage';
import { IntelligencePage } from './pages/IntelligencePage';
import { OverviewPage } from './pages/OverviewPage';
import { ProjectsLandingPage } from './pages/ProjectsLandingPage';
import { ProvidersPage } from './pages/ProvidersPage';
import { RuntimePage } from './pages/RuntimePage';
import { SessionsPage } from './pages/SessionsPage';
import { SettingsPage } from './pages/SettingsPage';
import { TasksPage } from './pages/TasksPage';

export function App() {
  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/" element={<Navigate to="/projects" replace />} />
        <Route path="/projects" element={<ProjectsLandingPage />} />
        <Route path="/projects/:projectId" element={<AppLayout />}>
          <Route index element={<Navigate to="overview" replace />} />
          <Route path="overview" element={<OverviewPage />} />
          <Route path="cycles" element={<CyclesPage />} />
          <Route path="tasks" element={<TasksPage />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="runtime" element={<RuntimePage />} />
          <Route path="sessions" element={<SessionsPage />} />
          <Route path="executions" element={<ExecutionsPage />} />
          <Route path="explorer" element={<ExplorerPage />} />
          <Route path="intelligence" element={<IntelligencePage />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="providers" element={<ProvidersPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/projects" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
