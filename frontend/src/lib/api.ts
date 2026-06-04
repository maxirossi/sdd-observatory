const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';

export interface HealthResponse {
  status: string;
  env?: string;
  privacyMode?: string;
}

export interface ProjectRead {
  id: string;
  name: string;
  path: string;
  last_scanned_at: string | null;
  agents_count: number;
  documents_count: number;
  tasks_count: number;
}

export interface ProviderConfigRead {
  provider: string;
  enabled: boolean;
  capture_metadata: boolean;
  capture_payload: boolean;
  capture_response: boolean;
  updated_at: string;
}

export interface EventRead {
  id: string;
  provider: string;
  event_type: string;
  timestamp: string;
  status_code: number | null;
  latency_ms: number | null;
  endpoint: string | null;
  request_size: number | null;
  response_size: number | null;
  error_message: string | null;
  has_interaction: boolean;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} on ${path}`);
  }
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j?.detail) detail = j.detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export interface AgentRead {
  id: string;
  name: string;
  file_path: string;
  type: string;
  description: string | null;
  tags: string[];
  mentions_count: number;
  runtime_mentions: number;
  doc_mentions: number;
  sessions: number;
  providers: string[];
  status: 'active' | 'declared_only' | 'runtime_only' | 'inactive';
}

export interface AgentMentionRead {
  id: string;
  file_path: string;
  source_type: string;
  line_number: number | null;
  snippet: string | null;
}

export interface SddDocumentRead {
  id: string;
  type: string;
  file_path: string;
  title: string | null;
}

export interface SddTaskRead {
  id: string;
  cycle: string | null;
  task_code: string | null;
  title: string;
  file_path: string | null;
  status?: string | null;
  domain?: string | null;
}

export interface AgentRelatedRead {
  agent: AgentRead;
  documents: SddDocumentRead[];
  tasks: SddTaskRead[];
  cycles: string[];
  runtime_sessions: string[];
}

export interface DocumentRelatedRead {
  document: SddDocumentRead;
  cycle: string | null;
  agents: AgentRead[];
  tasks: SddTaskRead[];
}

export interface TaskRelatedRead {
  task: SddTaskRead;
  agents: AgentRead[];
  documents: SddDocumentRead[];
}

export interface AgentUsageRow {
  agent_id: string;
  name: string;
  type: string;
  doc_mentions: number;
  runtime_mentions: number;
  total_mentions: number;
  declared_only: boolean;
  runtime_only: boolean;
}

export interface ProviderShare {
  provider: string;
  events: number;
}

export interface DailyBucket {
  day: string;
  provider: string;
  events: number;
}

export interface UsageRead {
  project_id: string;
  last_scanned_at: string | null;
  agents_total: number;
  agents_with_runtime_mentions: number;
  agents_without_any_mentions: number;
  most_used_runtime: AgentUsageRow | null;
  least_used_declared: AgentUsageRow | null;
  top_agents: AgentUsageRow[];
  provider_share: ProviderShare[];
  daily_activity: DailyBucket[];
}

export interface FileContentRead {
  file_path: string;
  size_bytes: number;
  truncated: boolean;
  content: string;
}

export interface EventTimelineBucket {
  bucket: string;
  provider: string;
  count: number;
}

export interface ProviderStats {
  provider: string;
  total: number;
  last_seen: string | null;
}

export interface FindingItem {
  label: string;
  detail: string | null;
  ref_id: string | null;
}

export interface Finding {
  id: string;
  title: string;
  severity: 'info' | 'warning' | 'danger';
  description: string;
  count: number;
  items: FindingItem[];
}

export interface CycleStatusCounts {
  done: number;
  in_progress: number;
  pending: number;
  unknown: number;
}

export interface DomainBreakdown {
  domain: string;
  total: number;
  done: number;
  in_progress: number;
  pending: number;
  unknown: number;
}

export interface CycleSummary {
  cycle: string;
  label: string;
  total_tasks: number;
  status: CycleStatusCounts;
  completion_pct: number;
  docs_count: number;
  agents_referenced: number;
  runtime_events: number;
  last_activity: string | null;
  state: 'wip' | 'done' | 'idle' | 'empty';
  domains: DomainBreakdown[];
  delta_done: number | null;
  baseline_at: string | null;
  baseline: CycleStatusCounts | null;
  baseline_total: number | null;
}

export interface ProgressGlobal {
  tasks_total: number;
  tasks_done: number;
  tasks_in_progress: number;
  tasks_pending: number;
  tasks_unknown: number;
  tasks_with_file: number;
  traceability_pct: number;
  runtime_active: boolean;
}

export interface HealthRead {
  project_id: string;
  last_scanned_at: string | null;
  agents_total: number;
  agents_used_runtime: number;
  agents_coverage_pct: number;
  docs_total: number;
  docs_referenced: number;
  cycles_total: number;
  cycles_wip: number;
  progress: ProgressGlobal;
  runtime_last_24h: number;
  health_score: number;
  health_breakdown: HealthDimension[];
}

export interface HealthDimension {
  key: string;
  label: string;
  score: number | null;
  weight: number;
  detail: string | null;
}

export interface SourceProviderBreakdown {
  provider: string;
  events: number;
  last_seen: string | null;
}

export interface RuntimeSourceBucket {
  source_kind: 'local_logs' | 'project_scan' | 'manual_import';
  label: string;
  description: string;
  enabled: boolean;
  available: boolean;
  providers: SourceProviderBreakdown[];
  total: number;
}

export const api = {
  health: () => getJson<HealthResponse>('/health'),
  projects: () => getJson<ProjectRead[]>('/api/projects'),
  providers: () => getJson<ProviderConfigRead[]>('/api/providers'),
  events: (limit = 25, projectId?: string) =>
    getJson<EventRead[]>(`/api/events?limit=${limit}${projectId ? `&project_id=${projectId}` : ''}`),
  agents: (projectId: string) => getJson<AgentRead[]>(`/api/projects/${projectId}/agents`),
  documents: (projectId: string) => getJson<SddDocumentRead[]>(`/api/projects/${projectId}/documents`),
  tasks: (projectId: string) => getJson<SddTaskRead[]>(`/api/projects/${projectId}/tasks`),
  fileContent: (projectId: string, path: string) =>
    getJson<FileContentRead>(`/api/projects/${projectId}/file?path=${encodeURIComponent(path)}`),
  agentMentions: (projectId: string, agentId: string) =>
    getJson<AgentMentionRead[]>(`/api/projects/${projectId}/agents/${agentId}/mentions`),
  agentRelated: (projectId: string, agentId: string) =>
    getJson<AgentRelatedRead>(`/api/projects/${projectId}/agents/${agentId}/related`),
  documentRelated: (projectId: string, documentId: string) =>
    getJson<DocumentRelatedRead>(`/api/projects/${projectId}/documents/${documentId}/related`),
  taskRelated: (projectId: string, taskId: string) =>
    getJson<TaskRelatedRead>(`/api/projects/${projectId}/tasks/${taskId}/related`),
  usage: (projectId: string, days = 30) =>
    getJson<UsageRead>(`/api/projects/${projectId}/usage?days=${days}`),
  findings: (projectId: string) =>
    getJson<Finding[]>(`/api/projects/${projectId}/findings`),
  timeline: (projectId?: string, hours = 48) =>
    getJson<EventTimelineBucket[]>(
      `/api/events/timeline?hours=${hours}${projectId ? `&project_id=${projectId}` : ''}`,
    ),
  byProvider: (projectId?: string) =>
    getJson<ProviderStats[]>(
      `/api/events/by-provider${projectId ? `?project_id=${projectId}` : ''}`,
    ),
  runtimeSources: (projectId?: string) =>
    getJson<RuntimeSourceBucket[]>(
      `/api/events/runtime-sources${projectId ? `?project_id=${projectId}` : ''}`,
    ),
  cycles: (projectId: string, sinceHours?: number) =>
    getJson<CycleSummary[]>(
      `/api/projects/${projectId}/cycles${sinceHours ? `?since_hours=${sinceHours}` : ''}`,
    ),
  projectHealth: (projectId: string) =>
    getJson<HealthRead>(`/api/projects/${projectId}/health`),
  sessions: (projectId: string, limit = 40) =>
    getJson<SessionSummary[]>(`/api/projects/${projectId}/sessions?limit=${limit}`),
  sessionReplay: (sessionId: string, limit = 500) =>
    getJson<SessionReplayRead>(`/api/sessions/${sessionId}?limit=${limit}`),
  turnText: (eventId: string) => getJson<TurnText>(`/api/sessions/events/${eventId}/text`),
  agentGraph: (projectId: string) =>
    getJson<AgentGraph>(`/api/projects/${projectId}/agent-graph`),
  tree: (projectId: string, depth = 6) =>
    getJson<TreeNode>(`/api/projects/${projectId}/tree?max_depth=${depth}`),
  fileInfo: (projectId: string, path: string) =>
    getJson<FileInfo>(`/api/projects/${projectId}/file-info?path=${encodeURIComponent(path)}`),
  fileMentions: (projectId: string, path: string) =>
    getJson<FileMention[]>(`/api/projects/${projectId}/file-mentions?path=${encodeURIComponent(path)}`),
  dependencyGraph: (projectId: string) =>
    getJson<DependencyGraph>(`/api/projects/${projectId}/dependency-graph`),
  scopeDrift: (projectId: string) =>
    getJson<ScopeDriftRow[]>(`/api/projects/${projectId}/scope-drift`),
  deadAgents: (projectId: string) =>
    getJson<DeadAgentRow[]>(`/api/projects/${projectId}/dead-agents`),
  coverageMatrix: (projectId: string) =>
    getJson<CoverageRow[]>(`/api/projects/${projectId}/coverage-matrix`),
  correlation: (projectId: string, limit = 20) =>
    getJson<CorrelationCard[]>(`/api/projects/${projectId}/correlation?limit=${limit}`),
  architecture: (projectId: string) =>
    getJson<ArchitectureProfile>(`/api/projects/${projectId}/architecture`),
  search: (projectId: string, q: string) =>
    getJson<SearchHit[]>(`/api/projects/${projectId}/search?q=${encodeURIComponent(q)}`),
  runtimeProviders: (projectId?: string) =>
    getJson<RuntimeProviderRow[]>(`/api/runtime/providers${projectId ? `?project_id=${projectId}` : ''}`),
  runtimeHealth: (projectId?: string) =>
    getJson<RuntimeHealthRead>(`/api/runtime/health${projectId ? `?project_id=${projectId}` : ''}`),
  runtimeTopAgents: (projectId?: string, limit = 15) =>
    getJson<TopRuntimeAgent[]>(
      `/api/runtime/top-agents?limit=${limit}${projectId ? `&project_id=${projectId}` : ''}`,
    ),
  // Agentes que REALMENTE intervinieron (delegaciones runSubagent), no menciones.
  runtimeInvokedAgents: (projectId?: string, limit = 30) =>
    getJson<InvokedAgent[]>(
      `/api/runtime/invoked-agents?limit=${limit}${projectId ? `&project_id=${projectId}` : ''}`,
    ),
  taskFlows: (projectId: string) =>
    getJson<TaskFlowsResponse>(`/api/projects/${projectId}/task-flows`),
  audit: (projectId: string) => getJson<AuditReport>(`/api/projects/${projectId}/audit`),
  liveStatus: (projectId: string) =>
    getJson<LiveStatus>(`/api/runtime/live-status?project_id=${projectId}`),
  runtimeInsights: (projectId: string) =>
    getJson<RuntimeInsights>(`/api/runtime/insights?project_id=${projectId}`),
  agentEffectiveness: (projectId: string) =>
    getJson<AgentEffectiveness[]>(`/api/projects/${projectId}/agent-effectiveness`),
  taskTimeline: (projectId: string, taskRef: string) =>
    getJson<TaskTimeline>(`/api/projects/${projectId}/task-timeline/${encodeURIComponent(taskRef)}`),
  sessionExecutions: (sessionId: string) =>
    getJson<ExecutionRead[]>(`/api/sessions/${sessionId}/executions`),
  projectExecutions: (projectId: string, limit = 150) =>
    getJson<ExecutionRead[]>(`/api/projects/${projectId}/executions?limit=${limit}`),
  runtimeInvocations: (opts: {
    projectId?: string;
    sessionId?: string;
    agentName?: string;
    limit?: number;
  }) => {
    const p = new URLSearchParams();
    if (opts.projectId) p.set('project_id', opts.projectId);
    if (opts.sessionId) p.set('session_id', opts.sessionId);
    if (opts.agentName) p.set('agent_name', opts.agentName);
    p.set('limit', String(opts.limit ?? 200));
    return getJson<AgentInvocationRow[]>(`/api/runtime/invocations?${p.toString()}`);
  },
  // ── Auto-ejecución (runner host-side) ──
  runnerStatus: () => getJson<RunnerStatus>('/api/runner/status'),
  runnerJobs: (opts: { projectId?: string; status?: string; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (opts.projectId) p.set('project_id', opts.projectId);
    if (opts.status) p.set('status', opts.status);
    if (opts.limit) p.set('limit', String(opts.limit));
    return getJson<AgentRunRow[]>(`/api/runner/jobs?${p.toString()}`);
  },
  runnerEnqueue: (body: {
    project_id: string;
    prompt: string;
    task_ref?: string | null;
    permission_mode?: string;
  }) => postJson<AgentRunRow>('/api/runner/jobs', body),
  runnerCancel: (runId: string) => postJson<AgentRunRow>(`/api/runner/jobs/${runId}/cancel`),
  runtimeCollectorRun: (provider?: string) => {
    const url = `/api/runtime/collector/run${provider ? `?provider=${provider}` : ''}`;
    return fetch(`${API_URL}${url}`, { method: 'POST' }).then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
      return (await r.json()) as CollectorRunResult[];
    });
  },
};

export interface RuntimeProviderRow {
  provider: string;
  enabled: boolean;
  available: boolean;
  source_kinds: string[];
  events_total: number;
  last_event_at: string | null;
  sessions_total: number;
  capture_metadata: boolean;
  capture_payload: boolean;
  capture_response: boolean;
}

export interface RuntimeHealthRead {
  providers_enabled: number;
  providers_available: number;
  providers_active_24h: number;
  events_last_hour: number;
  events_last_24h: number;
  sessions_last_24h: number;
  sources: Record<string, number>;
}

export interface TopRuntimeAgent {
  agent_id: string;
  name: string;
  runtime_mentions: number;
  sessions: number;
  providers: string[];
}

export interface InvokedAgent {
  agent_id: string | null;
  agent_name: string;
  declared: boolean;
  invocations: number;
  sessions: number;
  providers: string[];
  last_invoked_at: string | null;
}

export interface ExecDelegation {
  agent_name: string;
  declared: boolean;
  result_chars: number;
  description: string | null;
}

export interface ExecutionRead {
  session_id: string;
  request_id: string | null;
  index: number;
  task_ref: string | null;
  label: string | null;
  model: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_s: number | null;
  delegations: ExecDelegation[];
  delegated_agents: string[];
  tool_calls: number;
  edits: number;
  files_touched: string[];
  status: string; // delegated | inline | read_only
}

export interface AuditCommit {
  sha: string;
  author: string;
  date: string;
  message: string;
}

export interface AuditBranch {
  name: string;
  files_changed: number;
  commits_ahead: number;
  last_commit: string;
  author: string;
}

export interface AuditContributor {
  author: string;
  commits: number;
  insertions: number;
  deletions: number;
  files_touched: number;
}

export interface AuditReport {
  available: boolean;
  reason: string | null;
  base_branch: string | null;
  total_commits: number | null;
  commits_in_window: number | null;
  branches: number | null;
  contributors: number | null;
  last_commit_at: string | null;
  direct_to_base_total: number | null;
  direct_to_base_recent: AuditCommit[];
  large_branches: AuditBranch[];
  top_contributors: AuditContributor[];
  thresholds: { large_branch_files: number; window_days: number; max_branches: number } | null;
}

export interface ProviderInsight {
  provider: string;
  events: number;
  sessions: number;
  executions: number;
  distinct_agents: number;
  avg_agents_per_session: number;
  avg_session_duration_s: number;
  avg_execution_duration_s: number;
  delegations: number;
  pct_delegated: number;
  pct_inline: number;
  pct_read_only: number;
}

export interface ComparativeRow {
  metric: string;
  unit: string;
  claude?: number | null;
  copilot?: number | null;
}

export interface RuntimeInsights {
  providers: ProviderInsight[];
  comparative: ComparativeRow[];
  insights: string[];
}

export interface TimelineStep {
  kind: string; // request | agent | commit | closed
  label: string;
  at: string;
  agent_name?: string | null;
  declared?: boolean;
  description?: string | null;
  result_chars?: number;
  provider?: string | null;
  tools?: string[];
  files?: string[];
  duration_s?: number | null;
}

export interface TaskTimeline {
  task_ref: string;
  task_id: string | null;
  title: string | null;
  status: string | null;
  domain: string | null;
  sessions: number;
  agents: string[];
  total_duration_s: number | null;
  files_touched: string[];
  steps: TimelineStep[];
}

export interface AgentEffectiveness {
  agent_name: string;
  declared: boolean;
  invocations: number;
  sessions: number;
  tasks_associated: number;
  tasks_completed: number;
  with_result: number;
  anomalies: number;
  effectiveness_score: number;
  completion_score: number | null;
  result_score: number;
  anomaly_free_score: number | null;
  activity_score: number;
  trend: number | null;
  risk: string;
}

export interface LiveStatus {
  active: boolean;
  provider?: string | null; // copilot | claude
  session_id?: string | null;
  age_seconds?: number | null;
  branch?: string | null;
  task_ref?: string | null;
  auto_run?: boolean;
  phase?: string | null; // starting | delegating | agent_working | verifying
  pending_subagent?: boolean | null;
  current_step?: string | null;
  active_agent?: string | null;
  agents_done?: string[];
  delegations_total?: number | null;
  todos_done?: number | null;
  todos_total?: number | null;
}

export interface FlowAgent {
  agent_name: string;
  declared: boolean;
  invocations: number;
  with_result: number;
  expected_domain: string;
  domain_mismatch: boolean;
}

export interface TaskFlow {
  task_ref: string;
  task_id: string | null;
  domain: string | null;
  status: string | null;
  title: string | null;
  agents: FlowAgent[];
  distinct_agents: number;
  total_invocations: number;
  sessions: number;
  first_at: string | null;
  last_at: string | null;
  warnings: string[];
}

export interface DomainPattern {
  domain: string;
  tasks: number;
  typical_agents: { agent_name: string; freq_pct: number }[];
}

export interface TaskFlowsResponse {
  flows: TaskFlow[];
  patterns: DomainPattern[];
}

export interface AgentInvocationRow {
  id: string;
  agent_id: string | null;
  agent_name: string;
  declared: boolean;
  provider: string;
  tool: string;
  session_id: string | null;
  request_id: string | null;
  runtime_event_id: string | null;
  description: string | null;
  model: string | null;
  prompt_chars: number | null;
  result_chars: number | null;
  order_index: number;
  timestamp: string;
  sanitized_prompt?: string | null;
  sanitized_result?: string | null;
  claims?: AgentClaims | null;
}

export interface AgentClaims {
  files: string[];
  validations: { label: string; status: string }[];
}

export interface CollectorRunResult {
  provider: string;
  files_seen: number;
  events_inserted: number;
  skipped: number;
  errors: number;
}

export interface RunnerStatus {
  enabled: boolean;
  lab_only: boolean;
  lab_path: string | null;
  queued: number;
  running: number;
}

export interface AgentRunRow {
  id: string;
  project_id: string;
  provider: string;
  cwd: string;
  prompt: string;
  task_ref: string | null;
  permission_mode: string;
  status: string; // queued | running | done | error | canceled
  session_id: string | null;
  exit_code: number | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

export interface CorrelationLinkAgent {
  id: string;
  name: string;
  mentions: number;
}
export interface CorrelationLinkTask {
  id: string;
  task_code: string | null;
  title: string;
  cycle: string | null;
  status: string | null;
  domain: string | null;
}
export interface CorrelationLinkDoc {
  id: string;
  title: string | null;
  type: string;
}
export interface CorrelationCard {
  file_path: string;
  runtime_events: number;
  last_seen: string | null;
  agents: CorrelationLinkAgent[];
  tasks: CorrelationLinkTask[];
  documents: CorrelationLinkDoc[];
  cycles_touched: string[];
}

export interface ArchSignal {
  label: string;
  confidence: number;
  evidence: string[];
}
export interface ArchitectureProfile {
  languages: string[];
  frameworks: ArchSignal[];
  patterns: ArchSignal[];
  deployment: ArchSignal[];
}

export interface SearchHit {
  kind: 'agent' | 'document' | 'task' | 'mention';
  id: string;
  label: string;
  subtitle: string | null;
  score: number;
}

export interface DepNode {
  id: string;
  task_code: string | null;
  title: string;
  status: string | null;
  cycle: string | null;
}
export interface DepEdge {
  source: string;
  target_code: string;
  resolved_id: string | null;
}
export interface DependencyGraph {
  nodes: DepNode[];
  edges: DepEdge[];
  unresolved_codes: string[];
}
export interface ScopeDriftRow {
  task_id: string;
  task_code: string | null;
  title: string;
  expected_prefix: string;
  actual_paths: string[];
  drift: boolean;
}
export interface DeadAgentRow {
  agent_id: string;
  name: string;
  type: string;
  doc_mentions: number;
  runtime_mentions: number;
  classification: 'active' | 'inactive' | 'runtime_only' | 'declared_only';
}
export interface CoverageRow {
  agent_id: string;
  name: string;
  declared: boolean;
  runtime_high: boolean;
  runtime_count: number;
  tasks_linked: number;
  docs_coverage: number;
}

export interface TreeNode {
  name: string;
  path: string;
  type: 'dir' | 'file';
  children?: TreeNode[];
  mentions: number;
  has_agent: boolean;
  has_doc: boolean;
  has_task: boolean;
  file_count: number;
  size_bytes?: number | null;
}

export interface FileInfo {
  path: string;
  size_bytes: number;
  agents: { id: string; name: string }[];
  documents: { id: string; title: string; type: string }[];
  tasks: { id: string; title: string; status: string | null; cycle: string | null }[];
  mentions: number;
}

export interface FileMention {
  agent_id: string;
  agent_name: string;
  source_type: string;
  line_number: number | null;
  snippet: string | null;
}

export interface SessionSummary {
  session_id: string;
  provider: string;
  project_id: string | null;
  events: number;
  started_at: string;
  ended_at: string;
  duration_seconds: number;
  distinct_agents: number;
  distinct_files: number;
  models: string[];
  turns: number;
  tokens_input: number;
  tokens_output: number;
}

export interface SessionTokens {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
}

export interface SessionEvent {
  id: string;
  timestamp: string;
  event_type: string;
  provider: string;
  model: string | null;
  agent_mentions: string[];
  files_touched: string[];
  error: string | null;
  tokens_input: number | null;
  tokens_output: number | null;
  request_id: string | null;
  turn_id?: string | null;
  prompt_preview: string | null;
}

export interface SessionReplayRead {
  session_id: string;
  provider: string;
  project_id: string | null;
  started_at: string;
  ended_at: string;
  events_total: number;
  turns: number;
  agents_in_order: string[];
  models: string[];
  tokens: SessionTokens;
  events: SessionEvent[];
}

export interface TurnText {
  event_id: string;
  provider: string;
  event_type: string;
  prompt: string | null;
  response: string | null;
  sanitized: boolean;
  truncated: boolean;
  error: string | null;
}

export interface AgentGraphNode {
  id: string;
  name: string;
  type: string;
  runtime_count: number;
  sessions: number;
  declared?: boolean;
  with_result?: number;
}

export interface AgentGraphEdge {
  source: string;
  target: string;
  sessions: number;
}

export interface AgentGraph {
  nodes: AgentGraphNode[];
  edges: AgentGraphEdge[];
}
