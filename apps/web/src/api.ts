import { demoChats, demoNotes, demoOnboarding, demoSession, demoWorkspace } from './demo';
import type {
  ActionProposal,
  AssistantLearning,
  AssistantTask,
  AiMessage,
  AiRequest,
  AiResponse,
  AiSource,
  AppEvent,
  AuthInput,
  Chat,
  ChatThreadSummary,
  Commitment,
  FeedbackAction,
  LearningAction,
  LearningEvidence,
  Note,
  OnboardingStatus,
  ProposalAction,
  Reminder,
  Session,
  TaskAction,
  TrelloSetup,
  TrelloListRole,
  UserProfile,
  WhatsAppSession,
  WorkspaceData,
} from './types';

export class ApiError extends Error {
  status: number;
  details?: unknown;

  constructor(message: string, status = 500, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

export interface AppApi {
  readonly isPreview: boolean;
  subscribeEvents(listener: (event: AppEvent) => void): () => void;
  getSession(): Promise<Session | null>;
  login(input: AuthInput): Promise<Session>;
  register(input: AuthInput): Promise<Session>;
  logout(): Promise<void>;
  getProfile(): Promise<UserProfile>;
  updateProfile(input: UserProfile): Promise<UserProfile>;
  getOnboarding(): Promise<OnboardingStatus>;
  createWhatsAppSession(): Promise<WhatsAppSession>;
  getWhatsAppSession(id: string): Promise<WhatsAppSession>;
  startTrelloAuthorization(): Promise<{ authorizationUrl: string }>;
  getTrelloSetup(): Promise<TrelloSetup>;
  selectTrelloBoard(boardId: string): Promise<TrelloSetup>;
  saveTrelloMapping(input: { boardId: string; mapping: Record<TrelloListRole, string> }): Promise<TrelloSetup>;
  listChats(): Promise<Chat[]>;
  updateChat(id: string, enabled: boolean): Promise<{ id: string; enabled: boolean }>;
  setAllChatsMonitored(enabled: boolean): Promise<{ updated: number }>;
  completeOnboarding(input: { selectedChatIds: string[]; notifySelf: boolean }): Promise<Session>;
  getWorkspace(): Promise<WorkspaceData>;
  listTasks(): Promise<AssistantTask[]>;
  getTask(id: string): Promise<AssistantTask>;
  updateTask(id: string, input: { title?: string; description?: string }): Promise<AssistantTask>;
  runTaskAction(id: string, input: { action: TaskAction; targetTaskId?: string; snoozeUntil?: string; dueAt?: string }): Promise<AssistantTask>;
  resolveTaskConflict(id: string, resolution: 'keep_atlas' | 'keep_trello'): Promise<AssistantTask>;
  listReminders(): Promise<Reminder[]>;
  updateReminder(id: string, input: Partial<Pick<Reminder, 'scheduledAt' | 'state' | 'recurrence'>>): Promise<Reminder>;
  listCommitments(): Promise<Commitment[]>;
  updateCommitment(id: string, input: { status?: 'open' | 'waiting' | 'fulfilled' | 'cancelled'; dueAt?: string | null; nextFollowUpAt?: string | null }): Promise<Commitment>;
  listLearnings(status?: string): Promise<AssistantLearning[]>;
  listLearningEvidence(id: string): Promise<LearningEvidence[]>;
  actOnLearning(id: string, input: { action: LearningAction; statement?: string }): Promise<AssistantLearning | { deleted: true }>;
  listProposals(): Promise<ActionProposal[]>;
  actOnProposal(id: string, input: { action: ProposalAction; patch?: Record<string, unknown> }): Promise<ActionProposal>;
  updateSettings(input: { reminderTimes?: string[]; notifySelf?: boolean }): Promise<NonNullable<WorkspaceData['settings']>>;
  getNote(id: string): Promise<Note>;
  createNote(): Promise<Note>;
  updateNote(id: string, input: { title: string; contentMarkdown: string }): Promise<Note>;
  askAi(input: AiRequest): Promise<AiResponse>;
  listChatThreads(): Promise<ChatThreadSummary[]>;
  getChatMessages(threadId: string): Promise<AiMessage[]>;
  toggleAutomation(id: string, enabled: boolean): Promise<{ id: string; enabled: boolean }>;
  createAutomation(input: { kind: 'briefing' | 'deadline' | 'overdue' | 'follow_up' | 'stale_task' | 'weekly_review'; time?: string }): Promise<WorkspaceData['automations'][number]>;
  sendFeedback(input: { itemId: string; action: FeedbackAction; context: 'inbox' | 'activity' }): Promise<{ accepted: boolean }>;
}

const unwrapItems = <T,>(payload: T[] | { items: T[] }): T[] => Array.isArray(payload) ? payload : payload.items;

interface ApiTaskPayload {
  id: string;
  title: string;
  description?: string | null;
  status: AssistantTask['status'];
  priority: AssistantTask['priority'];
  projectName?: string | null;
  personName?: string | null;
  dueAt?: string | null;
  nextAction?: string | null;
  risk?: string | null;
  estimatedMinutes?: number | null;
  expectedOwner?: string | null;
  recurrence?: string | Record<string, unknown> | null;
  trello?: {
    cardId?: string | null;
    url?: string | null;
    syncStatus?: AssistantTask['trelloSyncStatus'];
  } | null;
  metadata?: Record<string, unknown>;
  updatedAt?: string;
}

interface ApiReminderPayload {
  id: string;
  title: string;
  scheduledFor?: string | null;
  status: Reminder['state'];
  recurrence?: string | Record<string, unknown> | null;
  taskId?: string | null;
  commitmentId?: string | null;
}

interface ApiCommitmentPayload {
  id: string;
  title: string;
  direction: Commitment['direction'];
  counterpartName?: string | null;
  dueAt?: string | null;
  nextFollowUpAt?: string | null;
  status: Commitment['status'];
}

interface ApiLearningPayload {
  id: string;
  statement: string;
  scopeType: AssistantLearning['scopeType'];
  scopeId?: string | null;
  status: AssistantLearning['status'];
  confidence: number | string;
  evidenceCount?: number;
  sourceType?: 'explicit' | 'inferred';
  lastUsedAt?: string | null;
  updatedAt: string;
  version?: number;
}

interface ApiProposalPayload {
  id: string;
  title: string;
  description: string;
  proposalType?: string;
  actionType?: string;
  risk: ActionProposal['risk'];
  reversible: boolean;
  status: ActionProposal['status'];
  evidence?: Array<{ id: string; label: string }>;
  proposedPayload?: Record<string, unknown> | null;
  editedPayload?: Record<string, unknown> | null;
}

interface ApiAutomationPayload {
  id: string;
  name: string;
  kind: string;
  description?: string;
  enabled: boolean;
  schedule?: string | null;
  lastRunAt?: string | null;
  lastRun?: string | null;
  lastRunStatus?: string | null;
  lastError?: string | null;
  status?: WorkspaceData['automations'][number]['status'];
}

function recurrenceLabel(value: string | Record<string, unknown> | null | undefined): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  for (const key of ['label', 'rule', 'rrule', 'text']) {
    if (typeof value[key] === 'string') return value[key];
  }
  return JSON.stringify(value);
}

function normalizeTask(task: ApiTaskPayload): AssistantTask {
  const labels = Array.isArray(task.metadata?.labels)
    ? task.metadata.labels.filter((item): item is string => typeof item === 'string')
    : [];
  const sourceMessageIds = Array.isArray(task.metadata?.sourceMessageIds)
    ? task.metadata.sourceMessageIds.filter((item): item is string => typeof item === 'string')
    : [];
  return {
    id: task.id,
    title: task.title,
    description: task.description ?? null,
    status: task.status,
    priority: task.priority,
    projectName: task.projectName ?? (typeof task.metadata?.projectName === 'string' ? task.metadata.projectName : null),
    personName: task.personName ?? (typeof task.metadata?.personName === 'string' ? task.metadata.personName : null),
    dueAt: task.dueAt ?? null,
    nextAction: task.nextAction ?? null,
    risk: task.risk ?? null,
    estimateMinutes: task.estimatedMinutes ?? null,
    expectedOwner: task.expectedOwner ?? null,
    recurrence: recurrenceLabel(task.recurrence),
    trelloCardId: task.trello?.cardId ?? null,
    trelloCardUrl: task.trello?.url ?? null,
    trelloSyncStatus: task.trello?.syncStatus ?? null,
    labels,
    sourceMessageIds,
    updatedAt: task.updatedAt,
  };
}

const normalizeReminder = (reminder: ApiReminderPayload): Reminder => ({
  id: reminder.id,
  title: reminder.title,
  scheduledAt: reminder.scheduledFor ?? '',
  state: reminder.status,
  recurrence: recurrenceLabel(reminder.recurrence),
  taskId: reminder.taskId ?? null,
  commitmentId: reminder.commitmentId ?? null,
});

const normalizeCommitment = (commitment: ApiCommitmentPayload): Commitment => ({
  id: commitment.id,
  title: commitment.title,
  direction: commitment.direction,
  personName: commitment.counterpartName ?? null,
  dueAt: commitment.dueAt ?? null,
  followUpAt: commitment.nextFollowUpAt ?? null,
  status: commitment.status,
});

const normalizeLearning = (learning: ApiLearningPayload): AssistantLearning => ({
  id: learning.id,
  statement: learning.statement,
  scopeType: learning.scopeType,
  scopeLabel: learning.scopeId ?? null,
  status: learning.status,
  confidence: Number(learning.confidence),
  evidenceCount: learning.evidenceCount ?? 0,
  inferred: learning.sourceType !== 'explicit',
  lastUsedAt: learning.lastUsedAt ?? null,
  version: learning.version,
  updatedAt: learning.updatedAt,
});

const normalizeProposal = (proposal: ApiProposalPayload): ActionProposal => ({
  id: proposal.id,
  title: proposal.title,
  description: typeof proposal.editedPayload?.description === 'string'
    ? proposal.editedPayload.description
    : proposal.description,
  actionType: proposal.actionType ?? proposal.proposalType ?? 'unknown',
  risk: proposal.risk,
  reversible: proposal.reversible,
  status: proposal.status,
  evidence: proposal.evidence ?? [],
  payload: proposal.editedPayload ?? proposal.proposedPayload ?? {},
});

const normalizeAutomation = (automation: ApiAutomationPayload): WorkspaceData['automations'][number] => ({
  id: automation.id,
  name: automation.name,
  description: automation.description
    ?? (automation.schedule ? `Executa conforme ${automation.schedule}.` : automation.kind.replaceAll('_', ' ')),
  enabled: automation.enabled,
  lastRun: automation.lastRun ?? automation.lastRunAt ?? null,
  status: automation.status
    ?? (!automation.enabled ? 'paused' : automation.lastError || automation.lastRunStatus === 'failed' ? 'attention' : 'healthy'),
});

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  if (response.status === 204) return undefined as T;

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      (payload && typeof payload === 'object' && 'message' in payload && String(payload.message)) ||
      (response.status === 401 ? 'Sua sessão expirou. Entre novamente.' : 'Não foi possível concluir a solicitação.');
    throw new ApiError(message, response.status, payload);
  }
  return payload as T;
}

class RealApi implements AppApi {
  readonly isPreview = false;
  private trelloState: TrelloSetup = { connected: false, boards: [], lists: [], mapping: {} };
  private lastEventId = 0;

  subscribeEvents(listener: (event: AppEvent) => void) {
    const suffix = this.lastEventId > 0 ? `?after=${this.lastEventId}` : '';
    const source = new EventSource(`/api/events${suffix}`, { withCredentials: true });
    source.onmessage = (message: MessageEvent<string>) => {
      try {
        const event = JSON.parse(message.data) as AppEvent;
        if (!event || typeof event.id !== 'number' || typeof event.eventType !== 'string') return;
        this.lastEventId = Math.max(this.lastEventId, event.id);
        listener(event);
      } catch {
        // Ignore malformed frames and keep the stream alive for the next valid event.
      }
    };
    return () => source.close();
  }

  async getSession() {
    try {
      return await request<Session>('/auth/session');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return null;
      throw error;
    }
  }

  login(input: AuthInput) {
    return request<Session>('/auth/login', { method: 'POST', body: JSON.stringify(input) });
  }

  register(input: AuthInput) {
    return request<Session>('/auth/register', { method: 'POST', body: JSON.stringify(input) });
  }

  logout() {
    return request<void>('/auth/logout', { method: 'POST' });
  }

  getProfile() {
    return request<UserProfile>('/profile');
  }

  updateProfile(input: UserProfile) {
    return request<UserProfile>('/profile', { method: 'PATCH', body: JSON.stringify(input) });
  }

  getOnboarding() {
    return request<OnboardingStatus>('/onboarding');
  }

  createWhatsAppSession() {
    return request<WhatsAppSession>('/whatsapp/sessions', { method: 'POST', body: '{}' });
  }

  getWhatsAppSession(id: string) {
    return request<WhatsAppSession>(`/whatsapp/sessions/${encodeURIComponent(id)}`);
  }

  async startTrelloAuthorization() {
    const result = await request<{ authorizeUrl: string; state: string; expiresAt: string }>('/trello/authorize');
    return { authorizationUrl: result.authorizeUrl };
  }

  async getTrelloSetup() {
    type Connection = { id: string; displayName?: string; memberName?: string; boardId?: string; boardName?: string; inboxListId?: string; inProgressListId?: string; pausedListId?: string; doneListId?: string };
    const payload = await request<{ items: Connection[] }>('/trello/connections');
    const connections = payload.items || [];
    const connection = connections[0];
    if (!connection) {
      this.trelloState = { connected: false, boards: [], lists: [], mapping: {} };
      return this.trelloState;
    }
    const boardsPayload = await request<{ items: TrelloSetup['boards'] }>(`/trello/connections/${encodeURIComponent(connection.id)}/boards`);
    const boards = boardsPayload.items || [];
    const selectedBoardId = connection.boardId || null;
    const listsPayload = selectedBoardId
      ? await request<{ items: TrelloSetup['lists'] }>(`/trello/boards/${encodeURIComponent(selectedBoardId)}/lists?connectionId=${encodeURIComponent(connection.id)}`)
      : { items: [] };
    this.trelloState = {
      connected: true,
      connectionId: connection.id,
      accountName: connection.displayName || connection.memberName || null,
      boards,
      selectedBoardId,
      selectedBoardName: connection.boardName || null,
      lists: listsPayload.items || [],
      mapping: {
        inbox: connection.inboxListId,
        inProgress: connection.inProgressListId,
        paused: connection.pausedListId,
        completed: connection.doneListId,
      },
    };
    return this.trelloState;
  }

  async selectTrelloBoard(boardId: string) {
    if (!this.trelloState.connectionId) await this.getTrelloSetup();
    const connectionId = this.trelloState.connectionId;
    if (!connectionId) throw new ApiError('Conecte o Trello antes de escolher um quadro.', 409);
    const payload = await request<{ items: TrelloSetup['lists'] }>(`/trello/boards/${encodeURIComponent(boardId)}/lists?connectionId=${encodeURIComponent(connectionId)}`);
    const lists = payload.items || [];
    this.trelloState = {
      ...this.trelloState,
      selectedBoardId: boardId,
      selectedBoardName: this.trelloState.boards.find((board) => board.id === boardId)?.name || null,
      lists,
      mapping: {},
    };
    return this.trelloState;
  }

  async saveTrelloMapping(input: { boardId: string; mapping: Record<TrelloListRole, string> }) {
    const connectionId = this.trelloState.connectionId;
    if (!connectionId) throw new ApiError('A conexão com o Trello não foi encontrada.', 409);
    await request<unknown>(`/trello/boards/${encodeURIComponent(input.boardId)}/mapping`, {
      method: 'PUT',
      body: JSON.stringify({
        connectionId,
        boardName: this.trelloState.selectedBoardName || this.trelloState.boards.find((board) => board.id === input.boardId)?.name || 'Quadro Trello',
        inboxListId: input.mapping.inbox,
        inProgressListId: input.mapping.inProgress,
        pausedListId: input.mapping.paused,
        doneListId: input.mapping.completed,
      }),
    });
    this.trelloState = { ...this.trelloState, mapping: input.mapping };
    return this.trelloState;
  }

  listChats() {
    return request<Chat[]>('/whatsapp/chats');
  }

  updateChat(id: string, enabled: boolean) {
    return request<{ id: string; enabled: boolean }>(`/whatsapp/chats/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    });
  }

  setAllChatsMonitored(enabled: boolean) {
    return request<{ updated: number }>('/whatsapp/chats/monitor-all', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    });
  }

  completeOnboarding(input: { selectedChatIds: string[]; notifySelf: boolean }) {
    return request<Session>('/onboarding/complete', { method: 'POST', body: JSON.stringify(input) });
  }

  getWorkspace() {
    return request<WorkspaceData>('/workspace/bootstrap');
  }

  async listTasks() {
    const tasks = unwrapItems(await request<ApiTaskPayload[] | { items: ApiTaskPayload[] }>('/tasks'));
    return tasks.map(normalizeTask);
  }

  async getTask(id: string) {
    return normalizeTask(await request<ApiTaskPayload>(`/tasks/${encodeURIComponent(id)}`));
  }

  async updateTask(id: string, input: { title?: string; description?: string }) {
    return normalizeTask(await request<ApiTaskPayload>(`/tasks/${encodeURIComponent(id)}`, {
      method: 'PATCH', body: JSON.stringify(input),
    }));
  }

  async runTaskAction(id: string, input: { action: TaskAction; targetTaskId?: string; snoozeUntil?: string; dueAt?: string }) {
    const result = await request<{ task: ApiTaskPayload }>(`/tasks/${encodeURIComponent(id)}/actions`, { method: 'POST', body: JSON.stringify(input) });
    return normalizeTask(result.task);
  }

  async resolveTaskConflict(id: string, resolution: 'keep_atlas' | 'keep_trello') {
    const result = await request<{ task: ApiTaskPayload }>(`/tasks/${encodeURIComponent(id)}/conflict`, {
      method: 'POST',
      body: JSON.stringify({ resolution }),
    });
    return normalizeTask(result.task);
  }

  async listReminders() {
    const reminders = unwrapItems(await request<ApiReminderPayload[] | { items: ApiReminderPayload[] }>('/reminders'));
    return reminders.map(normalizeReminder);
  }

  async updateReminder(id: string, input: Partial<Pick<Reminder, 'scheduledAt' | 'state' | 'recurrence'>>) {
    const action = input.state === 'acknowledged' ? 'acknowledge'
      : input.state === 'snoozed' ? 'snooze'
        : input.state === 'cancelled' ? 'cancel' : 'update';
    const result = await request<ApiReminderPayload>(`/reminders/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        action,
        ...(input.scheduledAt !== undefined ? { scheduledFor: input.scheduledAt } : {}),
        ...(input.recurrence !== undefined ? { recurrence: input.recurrence ? { rule: input.recurrence } : null } : {}),
      }),
    });
    return normalizeReminder(result);
  }

  async listCommitments() {
    const commitments = unwrapItems(await request<ApiCommitmentPayload[] | { items: ApiCommitmentPayload[] }>('/commitments'));
    return commitments.map(normalizeCommitment);
  }

  async updateCommitment(id: string, input: { status?: 'open' | 'waiting' | 'fulfilled' | 'cancelled'; dueAt?: string | null; nextFollowUpAt?: string | null }) {
    return normalizeCommitment(await request<ApiCommitmentPayload>(`/commitments/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }));
  }

  async listLearnings(status?: string) {
    const query = status ? `?status=${encodeURIComponent(status)}` : '';
    const learnings = unwrapItems(await request<ApiLearningPayload[] | { items: ApiLearningPayload[] }>(`/assistant/learnings${query}`));
    return learnings.map(normalizeLearning);
  }

  async listLearningEvidence(id: string) {
    return unwrapItems(await request<LearningEvidence[] | { items: LearningEvidence[] }>(
      `/assistant/learnings/${encodeURIComponent(id)}/evidence`,
    ));
  }

  async actOnLearning(id: string, input: { action: LearningAction; statement?: string }) {
    const result = await request<ApiLearningPayload>(`/assistant/learnings/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) });
    return normalizeLearning(result);
  }

  async listProposals() {
    const proposals = unwrapItems(await request<ApiProposalPayload[] | { items: ApiProposalPayload[] }>('/assistant/proposals'));
    return proposals.map(normalizeProposal);
  }

  async actOnProposal(id: string, input: { action: ProposalAction; patch?: Record<string, unknown> }) {
    return normalizeProposal(await request<ApiProposalPayload>(`/assistant/proposals/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }));
  }

  async updateSettings(input: { reminderTimes?: string[]; notifySelf?: boolean }) {
    const result = await request<{ timezone: string; reminderTimes: string[]; featureFlags: Record<string, unknown> }>('/config', {
      method: 'PATCH',
      body: JSON.stringify({
        ...(input.reminderTimes ? { reminderTimes: input.reminderTimes } : {}),
        ...(input.notifySelf !== undefined ? { featureFlags: { notifySelf: input.notifySelf } } : {}),
      }),
    });
    return { timezone: result.timezone, reminderTimes: result.reminderTimes, notifySelf: result.featureFlags.notifySelf !== false };
  }

  getNote(id: string) {
    return request<Note>(`/notes/${encodeURIComponent(id)}`);
  }

  createNote() {
    return request<Note>('/notes', { method: 'POST', body: JSON.stringify({ title: 'Sem título', contentMarkdown: '' }) });
  }

  updateNote(id: string, input: { title: string; contentMarkdown: string }) {
    return request<Note>(`/notes/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input) });
  }

  async askAi(input: AiRequest) {
    const response = await request<AiResponse & { proposals?: ApiProposalPayload[] }>('/ai/chat', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return {
      ...response,
      proposals: response.proposals?.map(normalizeProposal),
    };
  }

  async listChatThreads() {
    const payload = await request<{ items: ChatThreadSummary[] } | ChatThreadSummary[]>('/brain/chat/threads');
    return unwrapItems(payload);
  }

  async getChatMessages(threadId: string) {
    type Stored = { id: string; role: string; content: string | null; citations?: unknown };
    const payload = await request<{ items: Stored[] } | Stored[]>(`/brain/chat/threads/${encodeURIComponent(threadId)}/messages`);
    return unwrapItems(payload)
      .filter((message): message is Stored & { role: 'user' | 'assistant' } =>
        (message.role === 'user' || message.role === 'assistant') && !!message.content?.trim())
      .map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content as string,
        ...(Array.isArray(message.citations) && message.citations.length
          ? { sources: message.citations as AiSource[] }
          : {}),
      })) satisfies AiMessage[];
  }

  toggleAutomation(id: string, enabled: boolean) {
    return request<{ id: string; enabled: boolean }>(`/automations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    });
  }

  async createAutomation(input: { kind: 'briefing' | 'deadline' | 'overdue' | 'follow_up' | 'stale_task' | 'weekly_review'; time?: string }) {
    return normalizeAutomation(await request<ApiAutomationPayload>('/automations', { method: 'POST', body: JSON.stringify(input) }));
  }

  async sendFeedback(input: { itemId: string; action: FeedbackAction; context: 'inbox' | 'activity' }) {
    await request<unknown>('/feedback', {
      method: 'POST',
      body: JSON.stringify({
        itemId: input.itemId,
        action: input.action,
        context: input.context,
        kind: 'ai_correction',
      }),
    });
    return { accepted: true };
  }
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const pause = (ms = 180) => new Promise((resolve) => window.setTimeout(resolve, ms));

class PreviewApi implements AppApi {
  readonly isPreview = true;
  private notes = clone(demoNotes);
  private workspace = clone(demoWorkspace);
  private whatsappPolls = 0;
  private trelloSetup: TrelloSetup = clone(demoOnboarding.trello!);
  private profile: UserProfile = clone(demoOnboarding.profile!);

  subscribeEvents() {
    return () => undefined;
  }

  async getSession() {
    await pause();
    return clone(demoSession);
  }

  async login() {
    await pause();
    return clone(demoSession);
  }

  async register(input: AuthInput) {
    await pause();
    return { ...clone(demoSession), user: { ...demoSession.user, preferredName: input.preferredName || demoSession.user.preferredName, fullName: input.fullName || null, email: input.email } };
  }

  async logout() {
    await pause(80);
  }

  async getProfile() {
    await pause(80);
    return clone(this.profile);
  }

  async updateProfile(input: UserProfile) {
    await pause(120);
    this.profile = clone(input);
    return clone(this.profile);
  }

  async getOnboarding() {
    await pause();
    return clone(demoOnboarding);
  }

  async createWhatsAppSession() {
    await pause(260);
    this.whatsappPolls = 0;
    return clone(demoOnboarding.whatsapp!);
  }

  async getWhatsAppSession(id: string) {
    await pause(100);
    this.whatsappPolls += 1;
    return {
      id,
      status: this.whatsappPolls > 1 ? 'connected' : 'qr',
      qrDataUrl: null,
      phoneLabel: this.whatsappPolls > 1 ? '+55 11 99999-0000' : null,
    } as WhatsAppSession;
  }

  async startTrelloAuthorization() {
    await pause(320);
    this.trelloSetup = { ...this.trelloSetup, connected: true, accountName: 'Marina Costa' };
    return { authorizationUrl: '#trello-preview-authorized' };
  }

  async getTrelloSetup() {
    await pause(180);
    return clone(this.trelloSetup);
  }

  async selectTrelloBoard(boardId: string) {
    await pause(220);
    this.trelloSetup = {
      ...this.trelloSetup,
      selectedBoardId: boardId,
      lists: [
        { id: 'list-inbox', name: 'Entrada' },
        { id: 'list-doing', name: 'Em andamento' },
        { id: 'list-paused', name: 'Pausado' },
        { id: 'list-done', name: 'Concluído' },
        { id: 'list-ideas', name: 'Ideias' },
      ],
    };
    return clone(this.trelloSetup);
  }

  async saveTrelloMapping(input: { boardId: string; mapping: Record<TrelloListRole, string> }) {
    await pause(260);
    this.trelloSetup = { ...this.trelloSetup, selectedBoardId: input.boardId, mapping: input.mapping };
    return clone(this.trelloSetup);
  }

  async listChats() {
    await pause(260);
    return clone(demoChats);
  }

  async updateChat(id: string, enabled: boolean) {
    await pause(120);
    return { id, enabled };
  }

  async setAllChatsMonitored(enabled: boolean) {
    await pause(160);
    return { updated: demoChats.length, enabled } as { updated: number };
  }

  async completeOnboarding() {
    await pause(320);
    return clone(demoSession);
  }

  async getWorkspace() {
    await pause(360);
    return clone(this.workspace);
  }

  async listTasks() {
    await pause(100);
    return clone(this.workspace.tasks ?? []);
  }

  async getTask(id: string) {
    await pause(80);
    const task = this.workspace.tasks?.find((item) => item.id === id);
    if (!task) throw new ApiError('Tarefa não encontrada.', 404);
    return clone(task);
  }

  async updateTask(id: string, input: { title?: string; description?: string }) {
    await pause(100);
    const task = this.workspace.tasks?.find((item) => item.id === id);
    if (!task) throw new ApiError('Tarefa não encontrada.', 404);
    Object.assign(task, input);
    return clone(task);
  }

  async runTaskAction(id: string, input: { action: TaskAction; targetTaskId?: string; snoozeUntil?: string; dueAt?: string }) {
    await pause(120);
    const task = this.workspace.tasks?.find((item) => item.id === id);
    if (!task) throw new ApiError('Tarefa não encontrada.', 404);
    if (input.action === 'complete') task.status = 'completed';
    if (input.action === 'cancel') task.status = 'cancelled';
    if (input.action === 'merge') task.status = 'merged';
    if (input.action === 'reopen') task.status = 'open';
    if (input.action === 'snooze') task.dueAt = input.snoozeUntil ?? task.dueAt;
    if (input.action === 'reschedule') task.dueAt = input.dueAt ?? task.dueAt;
    return clone(task);
  }

  async resolveTaskConflict(id: string, resolution: 'keep_atlas' | 'keep_trello') {
    await pause(120);
    const task = this.workspace.tasks?.find((item) => item.id === id);
    if (!task) throw new ApiError('Tarefa não encontrada.', 404);
    task.trelloSyncStatus = resolution === 'keep_atlas' ? 'pending' : 'synced';
    this.workspace.assistantInbox = this.workspace.assistantInbox?.filter(
      (item) => item.kind !== 'conflict' || item.targetId !== id,
    );
    return clone(task);
  }

  async listReminders() {
    await pause(80);
    return clone(this.workspace.reminders ?? []);
  }

  async updateReminder(id: string, input: Partial<Pick<Reminder, 'scheduledAt' | 'state' | 'recurrence'>>) {
    await pause(100);
    const reminder = this.workspace.reminders?.find((item) => item.id === id);
    if (!reminder) throw new ApiError('Lembrete não encontrado.', 404);
    Object.assign(reminder, input);
    return clone(reminder);
  }

  async listCommitments() {
    await pause(80);
    return clone(this.workspace.commitments ?? []);
  }

  async updateCommitment(id: string, input: { status?: 'open' | 'waiting' | 'fulfilled' | 'cancelled'; dueAt?: string | null; nextFollowUpAt?: string | null }) {
    await pause(80);
    const commitment = this.workspace.commitments?.find((item) => item.id === id);
    if (!commitment) throw new ApiError('Compromisso não encontrado.', 404);
    Object.assign(commitment, {
      ...(input.status ? { status: input.status } : {}),
      ...(Object.hasOwn(input, 'dueAt') ? { dueAt: input.dueAt } : {}),
      ...(Object.hasOwn(input, 'nextFollowUpAt') ? { followUpAt: input.nextFollowUpAt } : {}),
    });
    return clone(commitment);
  }

  async listLearnings(status?: string) {
    await pause(80);
    const items = this.workspace.learnings ?? [];
    return clone(status ? items.filter((item) => item.status === status) : items);
  }

  async listLearningEvidence(id: string) {
    await pause(80);
    const learning = this.workspace.learnings?.find((item) => item.id === id);
    if (!learning) throw new ApiError('Aprendizado não encontrado.', 404);
    return Array.from({ length: learning.evidenceCount }, (_, index) => ({
      id: `${id}-evidence-${index + 1}`,
      evidenceType: index === 0 ? 'correction' : 'behavior',
      sourceId: null,
      excerpt: index === 0 ? 'Você corrigiu uma sugestão semelhante do Atlas.' : 'O mesmo padrão apareceu em outro dia.',
      signal: 'supports' as const,
      weight: 0.9,
      observedAt: 'recentemente',
    }));
  }

  async actOnLearning(id: string, input: { action: LearningAction; statement?: string }) {
    await pause(100);
    const items = this.workspace.learnings ?? [];
    const learning = items.find((item) => item.id === id);
    if (!learning) throw new ApiError('Aprendizado não encontrado.', 404);
    if (input.action === 'forget') {
      this.workspace.learnings = items.filter((item) => item.id !== id);
      return { deleted: true } as const;
    }
    if (input.statement) learning.statement = input.statement;
    learning.status = input.action === 'confirm' ? 'active' : input.action === 'pause' ? 'paused' : input.action === 'reject' ? 'rejected' : learning.status;
    return clone(learning);
  }

  async listProposals() {
    await pause(80);
    return clone(this.workspace.proposals ?? []);
  }

  async actOnProposal(id: string, input: { action: ProposalAction; patch?: Record<string, unknown> }) {
    await pause(120);
    const proposal = this.workspace.proposals?.find((item) => item.id === id);
    if (!proposal) throw new ApiError('Proposta não encontrada.', 404);
    if (input.action === 'edit' && typeof input.patch?.description === 'string') {
      proposal.description = input.patch.description;
      proposal.status = 'edited';
    } else {
      proposal.status = input.action === 'cancel' ? 'cancelled' : 'confirmed';
    }
    return clone(proposal);
  }

  async updateSettings(input: { reminderTimes?: string[]; notifySelf?: boolean }) {
    await pause(160);
    const current = this.workspace.settings ?? { timezone: 'America/Sao_Paulo', reminderTimes: ['08:00', '18:00'], notifySelf: true };
    const settings = { ...current, ...input };
    this.workspace.settings = settings;
    return clone(settings);
  }

  async getNote(id: string) {
    await pause(160);
    const note = this.notes[id];
    if (!note) throw new ApiError('Nota não encontrada.', 404);
    return clone(note);
  }

  async createNote() {
    await pause(160);
    const id = `preview-note-${Date.now()}`;
    const note: Note = {
      id,
      title: 'Sem título',
      excerpt: 'Uma nova ideia começa aqui.',
      updatedAt: 'agora',
      tags: [],
      source: 'manual',
      contentMarkdown: '# Sem título\n\n',
    };
    this.notes[id] = note;
    const { contentMarkdown: _content, ...summary } = note;
    this.workspace.notes.unshift(summary);
    return clone(note);
  }

  async updateNote(id: string, input: { title: string; contentMarkdown: string }) {
    await pause(220);
    const current = this.notes[id];
    if (!current) throw new ApiError('Nota não encontrada.', 404);
    const updated = { ...current, ...input, updatedAt: 'agora', excerpt: input.contentMarkdown.replace(/[#*_>\[\]]/g, '').slice(0, 110) };
    this.notes[id] = updated;
    return clone(updated);
  }

  async askAi(input: AiRequest): Promise<AiResponse> {
    await pause(720);
    return {
      answer: `Encontrei um fio claro entre suas decisões recentes e o ${input.context.view === 'today' ? 'foco de hoje' : 'contexto aberto'}. O próximo passo mais consistente é fechar a apresentação da Aurora e confirmar o responsável pelo envio antes das 14:00.`,
      threadId: input.threadId || 'preview-thread-1',
      messageId: `preview-message-${Date.now()}`,
      sources: [
        { id: 'note-1', title: 'Decisões da semana', excerpt: 'O lançamento da Aurora segue para quinta-feira.', kind: 'note', updatedAt: 'Hoje, 09:42' },
        { id: 'card-1', title: 'Revisar apresentação final', excerpt: 'Cartão em andamento com prazo para hoje.', kind: 'trello', updatedAt: 'Hoje, 09:18' },
        { id: 'chat-2', title: 'Equipe Produto', excerpt: 'Lucas confirmou que prepara o material final.', kind: 'whatsapp', updatedAt: 'há 8 min' },
      ],
      proposals: input.message.toLocaleLowerCase('pt-BR').includes('adiar') ? clone(this.workspace.proposals?.slice(0, 1) ?? []) : [],
    };
  }

  async listChatThreads() {
    await pause(60);
    return [] as ChatThreadSummary[];
  }

  async getChatMessages() {
    await pause(60);
    return [] as AiMessage[];
  }

  async toggleAutomation(id: string, enabled: boolean) {
    await pause(160);
    this.workspace.automations = this.workspace.automations.map((item) =>
      item.id === id ? { ...item, enabled, status: enabled ? 'healthy' : 'paused' } : item,
    );
    return { id, enabled };
  }

  async createAutomation(input: { kind: 'briefing' | 'deadline' | 'overdue' | 'follow_up' | 'stale_task' | 'weekly_review'; time?: string }) {
    await pause(120);
    const names = { briefing: 'Briefing pessoal', deadline: 'Prazo próximo', overdue: 'Itens vencidos', follow_up: 'Resposta pendente', stale_task: 'Tarefa parada', weekly_review: 'Revisão semanal' } as const;
    const automation = { id: `auto-${Date.now()}`, name: names[input.kind], description: input.time ? `Executa às ${input.time}.` : 'Executa quando o contexto correspondente for detectado.', enabled: true, lastRun: null, status: 'healthy' as const };
    this.workspace.automations.push(automation);
    return clone(automation);
  }

  async sendFeedback() {
    await pause(180);
    return { accepted: true };
  }
}

export function createApi(preview = false): AppApi {
  return preview ? new PreviewApi() : new RealApi();
}
