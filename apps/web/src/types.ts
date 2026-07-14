export type NavId =
  | 'today'
  | 'inbox'
  | 'chats'
  | 'brain'
  | 'graph'
  | 'projects'
  | 'people'
  | 'trello'
  | 'learnings'
  | 'automations'
  | 'settings';

export interface User {
  id: string;
  preferredName: string;
  fullName?: string | null;
  /** Compatibility with sessions created before the Atlas profile migration. */
  name?: string;
  email: string;
  avatarUrl?: string | null;
}

export type CommunicationStyle = 'concise' | 'balanced' | 'detailed';

export interface UserProfile {
  preferredName: string;
  fullName: string | null;
  occupation: string | null;
  goals: string[];
  timezone: string;
  locale: string;
  workDays: number[];
  workStart: string;
  workEnd: string;
  quietStart: string;
  quietEnd: string;
  communicationStyle: CommunicationStyle;
}

export interface Session {
  user: User;
  onboardingComplete: boolean;
}

export interface WhatsAppSession {
  id: string;
  status: 'idle' | 'qr' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error';
  qrDataUrl?: string | null;
  phoneLabel?: string | null;
  error?: string | null;
}

export interface Chat {
  id: string;
  name: string;
  kind: 'direct' | 'group';
  avatar?: string | null;
  lastMessageAt?: string | null;
  selected?: boolean;
}

export interface OnboardingStatus {
  step: number;
  profile?: UserProfile | null;
  whatsapp: WhatsAppSession | null;
  trelloConnected: boolean;
  trello?: TrelloSetup | null;
  selectedChatIds: string[];
}

export interface TrelloBoard {
  id: string;
  name: string;
}

export interface TrelloList {
  id: string;
  name: string;
}

export type TrelloListRole = 'inbox' | 'inProgress' | 'paused' | 'completed';

export interface TrelloSetup {
  connected: boolean;
  connectionId?: string | null;
  accountName?: string | null;
  boards: TrelloBoard[];
  selectedBoardId?: string | null;
  selectedBoardName?: string | null;
  lists: TrelloList[];
  mapping: Partial<Record<TrelloListRole, string>>;
}

export interface NoteSummary {
  id: string;
  title: string;
  excerpt: string;
  updatedAt: string;
  tags: string[];
  pinned?: boolean;
  source?: 'manual' | 'whatsapp' | 'trello';
}

export interface Note extends NoteSummary {
  contentMarkdown: string;
  generatedContentMarkdown?: string;
}

export interface FocusItem {
  id: string;
  title: string;
  project: string;
  dueLabel: string;
  priority: 'high' | 'medium' | 'low';
  completed?: boolean;
}

export type TaskStatus = 'inbox' | 'open' | 'in_progress' | 'paused' | 'completed' | 'done' | 'cancelled' | 'merged';
export type TaskPriority = 'urgent' | 'high' | 'medium' | 'low';

export interface AssistantTask {
  id: string;
  title: string;
  description?: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  projectName?: string | null;
  personName?: string | null;
  dueAt?: string | null;
  dueLabel?: string | null;
  nextAction?: string | null;
  risk?: string | null;
  estimateMinutes?: number | null;
  expectedOwner?: string | null;
  recurrence?: string | null;
  trelloCardId?: string | null;
  trelloCardUrl?: string | null;
  trelloSyncStatus?: 'pending' | 'synced' | 'conflict' | 'error' | 'detached' | null;
  labels?: string[];
  sourceMessageIds?: string[];
  updatedAt?: string;
}

export type TaskAction = 'complete' | 'cancel' | 'merge' | 'snooze' | 'reschedule' | 'open' | 'reopen';

export interface Reminder {
  id: string;
  title: string;
  scheduledAt: string;
  state: 'scheduled' | 'sent' | 'acknowledged' | 'snoozed' | 'cancelled' | 'ignored' | 'missed';
  recurrence?: string | null;
  taskId?: string | null;
  commitmentId?: string | null;
}

export interface Commitment {
  id: string;
  title: string;
  direction: 'owed_by_me' | 'owed_to_me';
  personName?: string | null;
  dueAt?: string | null;
  dueLabel?: string | null;
  followUpAt?: string | null;
  status: 'open' | 'waiting' | 'completed' | 'fulfilled' | 'cancelled';
}

export type LearningStatus = 'suggested' | 'active' | 'paused' | 'rejected' | 'obsolete' | 'forgotten' | 'superseded';
export type LearningAction = 'confirm' | 'pause' | 'resume' | 'reject' | 'forget' | 'update' | 'undo';

export interface AssistantLearning {
  id: string;
  statement: string;
  scopeType: 'global' | 'conversation' | 'person' | 'project';
  scopeLabel?: string | null;
  status: LearningStatus;
  confidence: number;
  evidenceCount: number;
  inferred: boolean;
  lastUsedAt?: string | null;
  version?: number;
  updatedAt: string;
}

export interface LearningEvidence {
  id: string;
  evidenceType: string;
  sourceId?: string | null;
  excerpt: string;
  signal: 'supports' | 'contradicts' | 'confirms' | 'rejects';
  weight: number;
  observedAt: string;
}

export type ProposalAction = 'confirm' | 'edit' | 'cancel' | 'always';

export interface ActionProposal {
  id: string;
  title: string;
  description: string;
  actionType: string;
  risk: 'low' | 'medium' | 'high' | 'destructive';
  reversible: boolean;
  status: 'pending' | 'confirmed' | 'edited' | 'cancelled' | 'executing' | 'completed' | 'failed' | 'executed';
  evidence?: Array<{ id: string; label: string }>;
  payload?: Record<string, unknown>;
}

export interface AssistantInboxItem {
  id: string;
  kind: 'task' | 'conflict' | 'duplicate' | 'learning' | 'memory';
  title: string;
  description: string;
  confidence?: number;
  createdAt: string;
  targetId?: string | null;
}

export interface Activity {
  id: string;
  title: string;
  detail: string;
  at: string;
  kind: 'whatsapp' | 'note' | 'trello' | 'ai';
}

export interface Project {
  id: string;
  name: string;
  description: string;
  progress: number;
  status: 'active' | 'paused' | 'done';
  noteCount: number;
  people: string[];
  accent: string;
}

export interface Person {
  id: string;
  name: string;
  role: string;
  initials: string;
  lastContext: string;
  noteCount: number;
  accent: string;
}

export interface TrelloCard {
  id: string;
  title: string;
  list: string;
  due?: string | null;
  labels: string[];
}

export interface Automation {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  lastRun?: string | null;
  status: 'healthy' | 'attention' | 'paused';
}

export interface GraphNode {
  id: string;
  label: string;
  kind: 'note' | 'project' | 'person' | 'topic';
  size?: number;
  source?: 'manual' | 'whatsapp' | 'trello' | 'ai';
  tags?: string[];
  updatedAt?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface AiSource {
  id: string;
  title: string;
  excerpt: string;
  kind: 'note' | 'whatsapp' | 'trello';
  updatedAt: string;
}

export interface AiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: AiSource[];
  proposals?: ActionProposal[];
}

export interface AppEvent {
  id: number;
  topic: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface WorkspaceData {
  greeting: string;
  briefing: string;
  focus: FocusItem[];
  tasks?: AssistantTask[];
  reminders?: Reminder[];
  commitments?: Commitment[];
  learnings?: AssistantLearning[];
  proposals?: ActionProposal[];
  assistantInbox?: AssistantInboxItem[];
  activities: Activity[];
  notes: NoteSummary[];
  inboxItems?: NoteSummary[];
  projects: Project[];
  people: Person[];
  trelloCards: TrelloCard[];
  automations: Automation[];
  graph: {
    nodes: GraphNode[];
    edges: GraphEdge[];
  };
  stats: {
    inbox: number;
    notes: number;
    connections: number;
    openTasks: number;
  };
  integrationStatus?: {
    whatsappConnected: boolean;
    trelloConnected: boolean;
    monitoredChats: number;
  };
  settings?: {
    timezone: string;
    reminderTimes: string[];
    notifySelf: boolean;
  };
  aiUsage?: {
    period: string;
    calls: number;
    tokens: number;
    latencyMs: number;
    errors: number;
    errorRate: number;
    costCents: number;
  };
}

export type FeedbackAction = 'edit' | 'not_task' | 'merge' | 'reprocess';

export interface AuthInput {
  email: string;
  password: string;
  preferredName?: string;
  fullName?: string;
}

export interface AiRequest {
  message: string;
  threadId?: string;
  context: {
    view: NavId;
    noteId?: string | null;
  };
}

export interface AiResponse {
  answer: string;
  sources: AiSource[];
  threadId: string;
  messageId: string;
  proposals?: ActionProposal[];
}
