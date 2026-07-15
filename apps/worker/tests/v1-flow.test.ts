import type {
  DeepSeekDecisionClient,
  Notification,
  NotificationChannel,
  TrelloExecutionResult,
} from "@atlas/integrations";
import {
  AI_PROMPT_VERSION,
  AI_SCHEMA_VERSION,
  buildAiContext,
  makeTaskExecutionKey,
  type AiDecision,
  type AiMemory,
  type AiTask,
  type NormalizedMessage,
} from "@atlas/shared";
import type { PgBoss } from "pg-boss";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkerConfig } from "../src/config.js";
import {
  QUEUES,
  registerHandlers,
  type AnalyzeBatchJob,
  type NotificationJob,
  type TrelloTaskJob,
} from "../src/handlers.js";
import type {
  OutboxRecord,
  TrelloRuntimeConfig,
  WorkerRepository,
} from "../src/repository.js";

type BossJob = { data: unknown };
type BossHandler = (jobs: BossJob[]) => Promise<void>;

class FakeBoss {
  readonly handlers = new Map<string, BossHandler>();
  readonly queued = new Map<string, unknown[]>();

  async createQueue(): Promise<void> {}

  async work(
    queue: string,
    _options: Record<string, unknown>,
    handler: BossHandler,
  ): Promise<void> {
    this.handlers.set(queue, handler);
  }

  async schedule(): Promise<void> {}

  async send(queue: string, data: unknown): Promise<string> {
    const jobs = this.queued.get(queue) ?? [];
    jobs.push(data);
    this.queued.set(queue, jobs);
    return `job-${jobs.length}`;
  }

  async sendAfter(queue: string, data: unknown): Promise<string> {
    return this.send(queue, data);
  }

  async run(queue: string, data: unknown): Promise<void> {
    const handler = this.handlers.get(queue);
    if (!handler) throw new Error(`No handler registered for ${queue}`);
    await handler([{ data }]);
  }

  take<T>(queue: string): T {
    const jobs = this.queued.get(queue) ?? [];
    const data = jobs.shift();
    if (data === undefined) throw new Error(`No queued job for ${queue}`);
    return data as T;
  }
}

const config: WorkerConfig = {
  DATABASE_URL: "postgres://test:test@localhost:5432/test",
  DEEPSEEK_API_KEY: "test-only",
  DEEPSEEK_BASE_URL: "https://api.deepseek.com",
  DEEPSEEK_MODEL: "deepseek-v4-flash",
  TRELLO_APP_KEY: "trello-key",
  AI_CONFIDENCE_THRESHOLD: 0.7,
  BATCH_QUIET_SECONDS: 10,
  BATCH_MAX_SECONDS: 30,
  SESSION_WATCH_INTERVAL_SECONDS: 15,
  LOG_LEVEL: "silent",
  WORKER_ID: "worker-v1-flow-test",
};

const trelloConfig: TrelloRuntimeConfig = {
  apiKey: "trello-key",
  token: "trello-token",
  boardId: "board-provided",
  boardConfigId: "board-config-provided",
  connectionId: "connection-provided",
  listRoles: {
    inbox: "list-inbox-provided",
    inProgress: "list-progress-provided",
    paused: "list-paused-provided",
    done: "list-done-provided",
  },
};

const message: NormalizedMessage = {
  id: "wa-message-provided",
  userId: "user-provided",
  chatJid: "5511999999999@s.whatsapp.net",
  senderJid: "5511888888888@s.whatsapp.net",
  senderName: "Cliente",
  sentAt: "2026-07-13T15:00:00-03:00",
  fromMe: false,
  text: "Prepare o orçamento revisado para amanhã.",
};

const task: AiTask = {
  clientRef: "task-provided",
  operation: "create",
  authorization: "inferred",
  authorizationMessageId: null,
  canonicalTaskId: null,
  candidateCardId: null,
  mergeSourceCardIds: [],
  title: "Preparar orçamento revisado",
  description: "Revisar valores e preparar o orçamento solicitado.",
  priority: "high",
  targetListRole: "inbox",
  nextAction: "Revisar os valores",
  waitingOn: null,
  risk: "medium",
  checklist: [{ text: "Conferir valores", done: false }],
  dueAt: "2026-07-14T17:00:00-03:00",
  dueBasis: "explicit_relative",
  labels: [],
  labelsToRemove: [],
  project: null,
  person: "Cliente",
  estimateMinutes: 45,
  recurrence: null,
  confidence: 0.96,
  evidenceMessageIds: [message.id],
  missingInformation: [],
};

const memory: AiMemory = {
  operation: "upsert",
  nodeType: "person",
  title: "Cliente",
  generatedContent: "Solicitou um orçamento revisado.",
  aliases: [],
  tags: ["cliente"],
  confidence: 0.91,
  sourceMessageIds: [message.id],
  relations: [],
  expiresAt: null,
};

const decision: AiDecision = {
  schemaVersion: AI_SCHEMA_VERSION,
  promptVersion: AI_PROMPT_VERSION,
  conversationIntent: "actionable",
  tasks: [task],
  reminders: [],
  commitments: [],
  learnings: [],
  actionProposals: [],
  memories: [memory],
  reply: {
    needed: false,
    recipientName: null,
    recipientJid: null,
    objective: "none",
    draft: null,
    tone: null,
    confidence: 1,
  },
  conversationSummary: "O cliente solicitou um orçamento revisado para amanhã.",
  briefReason: "Há uma solicitação explícita com prazo.",
};

function makeRepository() {
  const executions = new Map<string, TrelloExecutionResult>();
  const cards = new Map<string, { task: AiTask; url: string | null }>();
  const taskNodes = new Map<string, AiTask>();
  const memories: AiMemory[] = [];
  const outboxes = new Map<number, OutboxRecord & { status: "pending" | "sending" | "sent" }>();
  const outboxIds = new Map<string, number>();
  const batchStatuses: string[] = [];

  const repository = {
    isSelected: vi.fn(async () => true),
    isSelfChat: vi.fn(async () => false),
    updateBatchStatus: vi.fn(async (_userId: string, _batchId: string, status: string) => {
      batchStatuses.push(status);
    }),
    getTrelloConfig: vi.fn(async () => trelloConfig),
    replaceTrelloCardSnapshot: vi.fn(async () => undefined),
    buildContext: vi.fn(async () =>
      buildAiContext({
        now: new Date("2026-07-13T18:00:00Z"),
        chatJid: message.chatJid,
        chatName: "Cliente",
        messages: [message],
        allowedListKeys: Object.values(trelloConfig.listRoles),
      }),
    ),
    beginAiRun: vi.fn(async () => ({ runId: "ai-run-provided", previousDecision: null })),
    completeAiRun: vi.fn(async () => undefined),
    failAiRun: vi.fn(async () => undefined),
    upsertMemories: vi.fn(async (_userId: string, incoming: readonly AiMemory[]) => {
      memories.push(...structuredClone(incoming));
    }),
    persistDecisionArtifacts: vi.fn(async () => undefined),
    createTaskActionProposal: vi.fn(async () => undefined),
    markMessagesStatus: vi.fn(async () => undefined),
    getCompletedExecution: vi.fn(async (_userId: string, key: string) => executions.get(key) ?? null),
    prepareCanonicalTask: vi.fn(async () => ({ taskId: "canonical-task-provided", fingerprint: "fingerprint-provided", existingCardId: null, existingCardUrl: null, syncConflict: false })),
    linkBatchRemindersToTask: vi.fn(async () => 0),
    completeExecution: vi.fn(
      async (_userId: string, key: string, _cardId: string, result: TrelloExecutionResult) => {
        executions.set(key, structuredClone(result));
      },
    ),
    recordTrelloCard: vi.fn(
      async (
        _userId: string,
        _runtimeConfig: TrelloRuntimeConfig,
        incoming: AiTask,
        cardId: string,
        cardUrl: string | null,
      ) => {
        cards.set(cardId, { task: structuredClone(incoming), url: cardUrl });
      },
    ),
    upsertTaskNode: vi.fn(
      async (_userId: string, incoming: AiTask, cardId: string) => {
        taskNodes.set(cardId, structuredClone(incoming));
      },
    ),
    recordCanonicalTaskExecution: vi.fn(async () => undefined),
    shouldNotifySelf: vi.fn(async () => true),
    enqueueNotification: vi.fn(async (notification: Notification, dedupeKey: string) => {
      const existingId = outboxIds.get(dedupeKey);
      if (existingId !== undefined) return existingId;
      const id = outboxes.size + 1;
      outboxIds.set(dedupeKey, id);
      outboxes.set(id, {
        id,
        userId: notification.userId,
        subject: notification.title,
        body: notification.body,
        payload: structuredClone(notification) as unknown as Record<string, unknown>,
        lockToken: "mock-lock",
        status: "pending",
      });
      return id;
    }),
    getOutbox: vi.fn(async (id: number) => {
      const record = outboxes.get(id);
      if (!record || record.status === "sent") return null;
      record.status = "sending";
      return record;
    }),
    markOutboxSent: vi.fn(async (id: number, _externalMessageId: string, _lockToken: string) => {
      const record = outboxes.get(id);
      if (record) record.status = "sent";
    }),
    markOutboxFailed: vi.fn(async () => undefined),
    listConfiguredTrelloUsers: vi.fn(async () => []),
    findDueBriefUsers: vi.fn(async () => []),
    buildBrief: vi.fn(async () => ""),
    generateBrainSummaries: vi.fn(async () => 0),
  };

  return {
    repository: repository as unknown as WorkerRepository,
    state: { executions, cards, taskNodes, memories, outboxes, batchStatuses },
    spies: repository,
  };
}

describe("V1 mocked integration flow", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("turns a WhatsApp batch into one Trello card, brain records and one self notification", async () => {
    const boss = new FakeBoss();
    const { repository, state, spies } = makeRepository();
    const deepSeek = {
      decide: vi.fn(async () => ({
        decision,
        usage: {
          promptTokens: 120,
          completionTokens: 80,
          cacheHitTokens: 0,
          cacheMissTokens: 120,
        },
        requestId: "deepseek-request-provided",
      })),
    } as unknown as DeepSeekDecisionClient;
    const sentToSelf: Notification[] = [];
    const notificationChannel: NotificationChannel = {
      kind: "primary_self",
      send: vi.fn(async (notification) => {
        sentToSelf.push(structuredClone(notification));
        return { channel: "primary_self", externalMessageId: "wa-self-notification-provided" };
      }),
    };

    let cardPosts = 0;
    let createdCardBody: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (method === "GET" && url.pathname.endsWith(`/boards/${trelloConfig.boardId}/cards`)) {
        return Response.json([]);
      }
      if (method === "GET" && url.pathname.endsWith(`/boards/${trelloConfig.boardId}/lists`)) {
        return Response.json([
          { id: trelloConfig.listRoles.inbox, name: "Entrada", closed: false },
          { id: trelloConfig.listRoles.inProgress, name: "Em andamento", closed: false },
          { id: trelloConfig.listRoles.paused, name: "Pausado", closed: false },
          { id: trelloConfig.listRoles.done, name: "Concluído", closed: false },
        ]);
      }
      if (method === "POST" && url.pathname === "/1/cards") {
        cardPosts += 1;
        createdCardBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          id: "trello-card-provided",
          name: task.title,
          desc: String(createdCardBody.desc),
          idList: trelloConfig.listRoles.inbox,
          due: task.dueAt,
          dueComplete: false,
          closed: false,
          url: "https://trello.com/c/trello-card-provided",
        });
      }
      if (method === "GET" && url.pathname.endsWith("/checklists")) {
        return Response.json([]);
      }
      if (method === "POST" && url.pathname.endsWith("/checklists")) {
        return Response.json({ id: "atlas-checklist", name: "Atlas", checkItems: [] });
      }
      if (method === "POST" && url.pathname.includes("/checkItems")) {
        return Response.json({ id: "check-item", name: "Conferir valores", state: "incomplete" });
      }
      throw new Error(`Unexpected Trello request: ${method} ${url.pathname}`);
    });

    await registerHandlers({
      boss: boss as unknown as PgBoss,
      repository,
      deepSeek,
      notificationChannel,
      config,
    });

    const analyzeJob: AnalyzeBatchJob = {
      userId: message.userId,
      chatJid: message.chatJid,
      messages: [message],
      batchKey: "batch-key-provided",
      batchId: "batch-id-provided",
      attempt: 0,
    };
    await boss.run(QUEUES.analyze, analyzeJob);

    const trelloJob = boss.take<TrelloTaskJob>(QUEUES.trello);
    expect(trelloJob).toMatchObject({
      userId: message.userId,
      batchKey: analyzeJob.batchKey,
      task: { clientRef: task.clientRef, evidenceMessageIds: [message.id] },
    });
    await boss.run(QUEUES.trello, trelloJob);
    await boss.run(QUEUES.notification, boss.take<NotificationJob>(QUEUES.notification));

    expect(deepSeek.decide).toHaveBeenCalledTimes(1);
    expect(deepSeek.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: message.chatJid,
        messages: [expect.objectContaining({ id: message.id, text: message.text })],
        allowedListKeys: Object.values(trelloConfig.listRoles),
      }),
    );
    expect(spies.completeAiRun).toHaveBeenCalledWith(
      message.userId,
      "ai-run-provided",
      decision,
      expect.objectContaining({ requestId: "deepseek-request-provided" }),
      expect.any(Number),
    );
    expect(state.memories).toEqual([
      expect.objectContaining({ title: memory.title, sourceMessageIds: [message.id] }),
    ]);
    expect(state.cards).toHaveLength(1);
    expect(state.cards.get("trello-card-provided")?.task.evidenceMessageIds).toEqual([message.id]);
    expect(state.taskNodes).toHaveLength(1);
    expect(state.taskNodes.get("trello-card-provided")?.evidenceMessageIds).toEqual([message.id]);
    expect(createdCardBody).toMatchObject({
      idList: trelloConfig.listRoles.inbox,
      name: task.title,
      due: task.dueAt,
    });
    expect(String(createdCardBody?.desc)).toContain(
      `Atlas-ID: ${makeTaskExecutionKey(analyzeJob.batchKey, task.clientRef)}`,
    );
    expect(sentToSelf).toEqual([
      expect.objectContaining({
        userId: message.userId,
        kind: "task_created",
        title: "Tarefa criada",
        body: task.title,
      }),
    ]);
    expect(state.batchStatuses).toEqual(["processing", "completed"]);

    // Reexecutar o mesmo job deve reutilizar a chave concluída e o outbox deduplicado.
    await boss.run(QUEUES.trello, trelloJob);
    await boss.run(QUEUES.notification, boss.take<NotificationJob>(QUEUES.notification));

    expect(cardPosts).toBe(1);
    expect(spies.completeExecution).toHaveBeenCalledTimes(1);
    expect(state.cards).toHaveLength(1);
    expect(state.taskNodes).toHaveLength(1);
    expect(notificationChannel.send).toHaveBeenCalledTimes(1);
  });
});
