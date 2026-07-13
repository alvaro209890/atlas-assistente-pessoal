import {
  DeepSeekDecisionClient,
  DeterministicTrelloExecutor,
  IntegrationError,
  InvalidAiOutputError,
  TrelloClient,
  type Notification,
  type NotificationChannel,
  isRetryableIntegrationError,
} from "@atlas/integrations";
import {
  AI_RETRY_DELAYS_SECONDS,
  buildAiExecutionPlan,
  consolidateCatchUpTitles,
  findInvalidDecisionReferences,
  makeTaskExecutionKey,
  type AiDecision,
  type AiTask,
  type NormalizedMessage,
} from "@atlas/shared";
import { PgBoss } from "pg-boss";

import type { WorkerConfig } from "./config.js";
import { WorkerRepository } from "./repository.js";

export const QUEUES = {
  analyze: "atlas.ai.analyze-batch",
  trello: "atlas.trello.execute-task",
  notification: "atlas.notification.send",
  briefTick: "atlas.brief.tick",
  dailySummary: "atlas.brain.daily-summary",
  weeklyReview: "atlas.brain.weekly-review",
  consolidatedSummary: "atlas.brain.consolidated-summary",
  trelloSync: "atlas.trello.sync-cards",
  reminderTick: "atlas.reminder.tick",
} as const;

export interface AnalyzeBatchJob {
  userId: string;
  chatJid: string;
  messages: NormalizedMessage[];
  batchKey: string;
  batchId: string;
  attempt: number;
  immediateRepairAttempt?: boolean;
  enrichmentCycles?: number;
  fallbackCanonicalTaskId?: string;
}

export interface TrelloTaskJob {
  userId: string;
  batchKey: string;
  task: AiTask;
  allowedCandidateCardIds: string[];
  allowedMemberIds: string[];
  attempt: number;
  proposalId?: string;
  resolveConflict?: boolean;
  fallbackEnrichment?: boolean;
}

export function retargetFallbackEnrichment(
  decision: AiDecision,
  target: { canonicalTaskId: string; cardId: string | null },
): AiDecision {
  const index = decision.tasks.findIndex((task) => task.operation !== "ignore");
  if (index < 0) return decision;
  const tasks = [...decision.tasks];
  const current = tasks[index]!;
  tasks[index] = {
    ...current,
    operation: target.cardId ? "patch" : "create",
    authorization: "inferred",
    authorizationMessageId: null,
    canonicalTaskId: target.canonicalTaskId,
    candidateCardId: target.cardId,
    mergeSourceCardIds: [],
    labels: current.labels.filter((label) => label.toLocaleLowerCase("pt-BR") !== "ia pendente"),
    labelsToRemove: target.cardId
      ? [...new Set([...current.labelsToRemove, "IA pendente"])]
      : current.labelsToRemove.filter((label) => label.toLocaleLowerCase("pt-BR") !== "ia pendente"),
  };
  return { ...decision, tasks };
}

export interface NotificationJob {
  outboxId: number;
  attempt: number;
}

export interface TrelloSyncJob {
  userId: string | null;
  attempt: number;
}

interface RetryPayload {
  attempt: number;
}

export function hasScheduledRetry(error: unknown, attempt: number): boolean {
  const retryable = isRetryableIntegrationError(error) || !(error instanceof IntegrationError);
  return retryable && AI_RETRY_DELAYS_SECONDS[attempt] !== undefined;
}

async function retryOrThrow<T extends RetryPayload>(
  boss: PgBoss,
  queue: string,
  payload: T,
  error: unknown,
): Promise<void> {
  const delay = AI_RETRY_DELAYS_SECONDS[payload.attempt];
  if (hasScheduledRetry(error, payload.attempt) && delay !== undefined) {
    await boss.sendAfter(queue, { ...payload, attempt: payload.attempt + 1 }, null, delay);
    return;
  }
  throw error;
}

export async function syncTrelloSnapshot(
  repository: WorkerRepository,
  userId: string,
): Promise<void> {
  const config = await repository.getTrelloConfig(userId);
  const client = new TrelloClient({ apiKey: config.apiKey, token: config.token });
  const [cards, lists, members] = await Promise.all([
    client.getOpenCards(config.boardId),
    client.getOpenLists(config.boardId),
    client.getBoardMembers(config.boardId),
  ]);
  await repository.replaceTrelloCardSnapshot(userId, config, cards, lists, members);
}

async function enqueueNotification(
  boss: PgBoss,
  repository: WorkerRepository,
  notification: Notification,
  dedupeKey: string,
): Promise<void> {
  if (!(await repository.shouldNotifySelf(notification.userId))) return;
  const outboxId = await repository.enqueueNotification(notification, dedupeKey);
  await boss.send(QUEUES.notification, { outboxId, attempt: 0 } satisfies NotificationJob);
}

export async function dispatchDueBriefs(
  boss: PgBoss,
  repository: WorkerRepository,
  now = new Date(),
): Promise<number> {
  const users = await repository.findDueBriefUsers();
  const minute = now.toISOString().slice(0, 16);
  let dispatched = 0;
  for (const item of users) {
    try {
      const body = await repository.buildBrief(item.userId);
      await enqueueNotification(
        boss,
        repository,
        { userId: item.userId, kind: "brief", title: "Resumo de tarefas", body },
        `brief:${item.time}:${minute}`,
      );
      dispatched += 1;
    } catch {
      // A disconnected or concurrently changed tenant must not block other briefings.
    }
  }
  return dispatched;
}

function taskReviewBody(task: AiTask): string {
  const missing = task.missingInformation.length
    ? `\nFalta: ${task.missingInformation.join(", ")}`
    : "";
  return `${task.title}\nConfiança: ${Math.round(task.confidence * 100)}%${missing}`;
}

export interface HandlerDependencies {
  boss: PgBoss;
  repository: WorkerRepository;
  deepSeek: DeepSeekDecisionClient;
  notificationChannel: NotificationChannel;
  config: WorkerConfig;
}

export async function registerHandlers(dependencies: HandlerDependencies): Promise<void> {
  const { boss, repository, deepSeek, notificationChannel, config } = dependencies;
  for (const queue of Object.values(QUEUES)) await boss.createQueue(queue);

  await boss.work<AnalyzeBatchJob>(QUEUES.analyze, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const payload = job.data;
      let runId: string | null = null;
      try {
        await repository.updateBatchStatus(payload.userId, payload.batchId, "processing");
        await syncTrelloSnapshot(repository, payload.userId).catch(() => undefined);
        const context = await repository.buildContext(
          payload.userId,
          payload.chatJid,
          payload.messages,
        );
        const run = await repository.beginAiRun(
          payload.userId,
          payload.batchKey,
          context,
          payload.batchId,
        );
        runId = run.runId;
        const started = Date.now();
        const result = run.previousDecision
          ? {
              decision: run.previousDecision,
              usage: { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 },
              requestId: null,
            }
          : await deepSeek.decide(context);
        const invalidReferences = findInvalidDecisionReferences(result.decision, context);
        if (invalidReferences.length > 0) {
          throw new InvalidAiOutputError(
            `DeepSeek referenced context IDs that were not supplied: ${invalidReferences.join("; ")}`,
          );
        }
        const fallbackTarget = payload.fallbackCanonicalTaskId
          ? await repository.getFallbackEnrichmentTarget(payload.userId, payload.fallbackCanonicalTaskId)
          : null;
        const effectiveDecision = fallbackTarget
          ? retargetFallbackEnrichment(result.decision, fallbackTarget)
          : result.decision;
        if (!run.previousDecision) {
          await repository.completeAiRun(
            payload.userId,
            run.runId,
            result.decision,
            { ...result.usage, requestId: result.requestId },
            Date.now() - started,
          );
        }

        const plan = buildAiExecutionPlan(
          effectiveDecision,
          config.AI_CONFIDENCE_THRESHOLD,
          context,
        );
        await repository.upsertMemories(payload.userId, plan.acceptedMemories);
        await repository.persistDecisionArtifacts(payload.userId, effectiveDecision, payload.batchKey, context);
        const allowedCandidateCardIds = [...new Set([
          ...context.cardCandidates.map((card) => card.id),
          ...(fallbackTarget?.cardId ? [fallbackTarget.cardId] : []),
        ])];
        const allowedMemberIds = context.allowedTrelloMemberIds;
        for (const planned of plan.tasks) {
          if (planned.disposition === "execute") {
            await boss.send(QUEUES.trello, {
              userId: payload.userId,
              batchKey: payload.batchKey,
              task: planned.task,
              allowedCandidateCardIds,
              allowedMemberIds,
              attempt: 0,
              ...(fallbackTarget && planned.task.canonicalTaskId === fallbackTarget.canonicalTaskId
                ? { fallbackEnrichment: true }
                : {}),
            } satisfies TrelloTaskJob);
          } else if (planned.disposition === "review") {
            await enqueueNotification(
              boss,
              repository,
              {
                userId: payload.userId,
                kind: "needs_review",
                title: "Tarefa para revisar",
                body: taskReviewBody(planned.task),
              },
              `${payload.batchKey}:review:${planned.task.clientRef}`,
            );
          } else if (planned.disposition === "propose") {
            await repository.createTaskActionProposal(payload.userId, planned.task, payload.batchKey);
            await enqueueNotification(
              boss,
              repository,
              { userId: payload.userId, kind: "needs_review", title: "Confirmação necessária", body: `${planned.task.title}\nO Atlas não executará ${planned.task.operation} sem sua confirmação.` },
              `${payload.batchKey}:proposal:${planned.task.clientRef}`,
            );
          }
        }

        if (plan.replyShouldNotifySelf && effectiveDecision.reply.needed) {
          const reply = effectiveDecision.reply;
          await enqueueNotification(
            boss,
            repository,
            {
              userId: payload.userId,
              kind: "reply_suggestion",
              title: `Resposta sugerida${reply.recipientName ? ` para ${reply.recipientName}` : ""}`,
              body: reply.draft,
            },
            `${payload.batchKey}:reply`,
          );
        }
        await repository.markMessagesStatus(
          payload.userId,
          payload.messages.map((message) => message.id),
          "processed",
        );
        await repository.updateBatchStatus(payload.userId, payload.batchId, "completed");
      } catch (error) {
        if (runId) await repository.failAiRun(payload.userId, runId, error);
        await repository.updateBatchStatus(payload.userId, payload.batchId, "failed", error);
        if (error instanceof InvalidAiOutputError && payload.immediateRepairAttempt !== true) {
          await boss.send(QUEUES.analyze, {
            ...payload,
            immediateRepairAttempt: true,
          } satisfies AnalyzeBatchJob);
          continue;
        }
        if (!hasScheduledRetry(error, payload.attempt)) {
          const originalText = payload.messages.map((message) => message.text).join("\n");
          const fallbackTask: AiTask = {
            clientRef: "ai-pending-fallback",
            operation: "create",
            authorization: "inferred",
            authorizationMessageId: null,
            canonicalTaskId: null,
            candidateCardId: null,
            mergeSourceCardIds: [],
            title: `IA pendente — ${originalText.slice(0, 120) || "mensagem do WhatsApp"}`,
            description:
              `A análise inteligente ficou pendente e será tentada novamente.\n\nMensagem original:\n${originalText.slice(0, 7_000)}`,
            priority: "normal",
            targetListRole: "inbox",
            nextAction: "Reprocessar com a IA",
            waitingOn: "DeepSeek",
            risk: "unknown",
            checklist: [],
            dueAt: null,
            dueBasis: "none",
            labels: ["IA pendente"],
            labelsToRemove: [],
            memberIdsToAdd: [],
            memberIdsToRemove: [],
            project: null,
            person: null,
            estimateMinutes: null,
            recurrence: null,
            confidence: 1,
            evidenceMessageIds: payload.messages.map((message) => message.id),
            missingInformation: [],
          };
          if (payload.fallbackCanonicalTaskId) {
            fallbackTask.canonicalTaskId = payload.fallbackCanonicalTaskId;
          }
          const fallbackCanonical = await repository.prepareCanonicalTask(payload.userId, fallbackTask);
          fallbackTask.canonicalTaskId = fallbackCanonical.taskId;
          await boss.send(QUEUES.trello, {
            userId: payload.userId,
            batchKey: payload.batchKey,
            task: fallbackTask,
            allowedCandidateCardIds: [],
            allowedMemberIds: [],
            attempt: 0,
          } satisfies TrelloTaskJob);
          if ((payload.enrichmentCycles ?? 0) < 4) {
            await boss.sendAfter(
              QUEUES.analyze,
              {
                ...payload,
                attempt: 0,
                immediateRepairAttempt: false,
                enrichmentCycles: (payload.enrichmentCycles ?? 0) + 1,
                fallbackCanonicalTaskId: fallbackCanonical.taskId,
              },
              null,
              15 * 60,
            );
          }
          continue;
        }
        await retryOrThrow(boss, QUEUES.analyze, payload, error);
      }
    }
  });

  await boss.work<TrelloTaskJob>(QUEUES.trello, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const payload = job.data;
      const executionKey = makeTaskExecutionKey(payload.batchKey, payload.task.clientRef);
      try {
        const canonical = await repository.prepareCanonicalTask(payload.userId, payload.task);
        if (payload.fallbackEnrichment && payload.task.operation === "create" && canonical.existingCardId) {
          payload.task = {
            ...payload.task,
            operation: "patch",
            candidateCardId: canonical.existingCardId,
            labels: payload.task.labels.filter((label) => label.toLocaleLowerCase("pt-BR") !== "ia pendente"),
            labelsToRemove: [...new Set([...payload.task.labelsToRemove, "IA pendente"])],
          };
          payload.allowedCandidateCardIds = [...new Set([
            ...payload.allowedCandidateCardIds,
            canonical.existingCardId,
          ])];
        }
        await repository.linkBatchRemindersToTask(
          payload.userId,
          payload.batchKey,
          payload.task.clientRef,
          canonical.taskId,
        );
        if (canonical.syncConflict && payload.resolveConflict !== true) {
          await enqueueNotification(
            boss,
            repository,
            {
              userId: payload.userId,
              kind: "needs_review",
              title: "Conflito no Trello",
              body: `${payload.task.title}\nO cartão e a tarefa foram alterados ao mesmo tempo. Revise o conflito antes de sincronizar.`,
            },
            `${executionKey}:sync-conflict`,
          );
          continue;
        }
        const config = await repository.getTrelloConfig(payload.userId);
        const client = new TrelloClient({ apiKey: config.apiKey, token: config.token });
        const executor = new DeterministicTrelloExecutor(client);
        const completed = await repository.getCompletedExecution(payload.userId, executionKey);
        const result =
          completed ??
          (payload.task.operation === "create" && canonical.existingCardId
            ? { cardId: canonical.existingCardId, cardUrl: canonical.existingCardUrl, operation: payload.task.operation }
            : null) ??
          (await executor.execute({
            task: payload.task,
            idempotencyKey: executionKey,
            boardId: config.boardId,
            listRoles: config.listRoles,
            allowedCandidateCardIds: new Set(payload.allowedCandidateCardIds),
            allowedMemberIds: new Set(payload.allowedMemberIds ?? []),
          }));
        if (!completed) {
          await repository.completeExecution(
            payload.userId,
            executionKey,
            result.cardId,
            result,
          );
        }
        await repository.recordTrelloCard(
          payload.userId,
          config,
          payload.task,
          result.cardId,
          result.cardUrl,
        );
        const brainNodeId = await repository.upsertTaskNode(
          payload.userId,
          payload.task,
          result.cardId,
          result.cardUrl,
        );
        await repository.recordCanonicalTaskExecution(
          payload.userId,
          canonical.taskId,
          payload.task,
          result.cardId,
          executionKey,
          brainNodeId,
        );
        if (payload.proposalId) {
          await repository.markProposalExecution(payload.userId, payload.proposalId, true);
        }
        await enqueueNotification(
          boss,
          repository,
          {
            userId: payload.userId,
            kind: payload.task.operation === "create" ? "task_created" : "task_updated",
            title: payload.task.operation === "create" ? "Tarefa criada" : "Tarefa atualizada",
            body: payload.task.title,
            ...(result.cardUrl
              ? { links: [{ label: "Abrir no Trello", url: result.cardUrl }] }
              : {}),
          },
          `${executionKey}:success`,
        );
      } catch (error) {
        if (payload.proposalId && !hasScheduledRetry(error, payload.attempt)) {
          await repository.markProposalExecution(
            payload.userId,
            payload.proposalId,
            false,
            error instanceof Error ? error.message : String(error),
          );
        }
        await retryOrThrow(boss, QUEUES.trello, payload, error);
      }
    }
  });

  await boss.work<NotificationJob>(QUEUES.notification, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const payload = job.data;
      let claimed: Awaited<ReturnType<WorkerRepository["getOutbox"]>> = null;
      try {
        const record = await repository.getOutbox(payload.outboxId);
        if (!record) continue;
        claimed = record;
        const raw = record.payload;
        const notification: Notification = {
          userId: record.userId,
          kind:
            typeof raw.kind === "string"
              ? (raw.kind as Notification["kind"])
              : "integration_error",
          title: record.subject,
          body: record.body,
          ...(Array.isArray(raw.links)
            ? { links: raw.links as { label: string; url: string }[] }
            : {}),
        };
        const receipt = await notificationChannel.send(notification);
        await repository.markOutboxSent(record.id, receipt.externalMessageId, record.lockToken);
      } catch (error) {
        if (claimed) await repository.markOutboxFailed(payload.outboxId, claimed.lockToken, error);
        await retryOrThrow(boss, QUEUES.notification, payload, error);
      }
    }
  });

  await boss.work<TrelloSyncJob>(QUEUES.trelloSync, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const payload = job.data;
      if (payload.userId === null) {
        const users = await repository.listConfiguredTrelloUsers();
        for (const userId of users) {
          await boss.send(QUEUES.trelloSync, { userId, attempt: 0 } satisfies TrelloSyncJob);
        }
        continue;
      }
      try {
        await syncTrelloSnapshot(repository, payload.userId);
      } catch (error) {
        await retryOrThrow(boss, QUEUES.trelloSync, payload, error);
      }
    }
  });

  await boss.work<Record<string, never>>(QUEUES.briefTick, { batchSize: 1 }, async () => {
    await repository.materializeDueAutomations();
    await dispatchDueBriefs(boss, repository);
  });

  await boss.work<Record<string, never>>(QUEUES.reminderTick, { batchSize: 1 }, async () => {
    const occurrences = await repository.claimDueReminderOccurrences("atlas-reminder-worker");
    const byUser = new Map<string, typeof occurrences>();
    for (const occurrence of occurrences) {
      const group = byUser.get(occurrence.userId) ?? [];
      group.push(occurrence);
      byUser.set(occurrence.userId, group);
    }
    for (const [userId, group] of byUser) {
      const ids = group.map((item) => item.id);
      try {
        const outboxId = await repository.enqueueNotification(
          { userId, kind: "reminder", title: group.length > 1 ? "Lembretes pendentes" : "Lembrete", body: consolidateCatchUpTitles(group.map((item) => item.title)) },
          `reminders:${ids.sort().join(":")}`,
        );
        await repository.markReminderOccurrencesQueued(ids, outboxId);
        await boss.send(QUEUES.notification, { outboxId, attempt: 0 } satisfies NotificationJob);
      } catch (error) {
        await repository.releaseReminderOccurrences(ids, error);
      }
    }
  });

  await boss.work<Record<string, never>>(QUEUES.dailySummary, { batchSize: 1 }, async () => {
    await repository.generateBrainSummaries("daily_summary");
  });
  await boss.work<Record<string, never>>(QUEUES.weeklyReview, { batchSize: 1 }, async () => {
    await repository.generateBrainSummaries("weekly_review");
  });
  await boss.work<Record<string, never>>(
    QUEUES.consolidatedSummary,
    { batchSize: 1 },
    async () => {
      await repository.generateBrainSummaries("consolidated_summary");
    },
  );

  await boss.schedule(QUEUES.briefTick, "* * * * *", {});
  await boss.schedule(QUEUES.reminderTick, "* * * * *", {});
  // Run hourly; repository selects only users whose local clock crossed the relevant boundary.
  await boss.schedule(QUEUES.dailySummary, "10 * * * *", {});
  await boss.schedule(QUEUES.weeklyReview, "20 * * * *", {});
  await boss.schedule(QUEUES.consolidatedSummary, "30 * * * *", {});
  await boss.schedule(QUEUES.trelloSync, "* * * * *", { userId: null, attempt: 0 });
  await boss.send(QUEUES.trelloSync, { userId: null, attempt: 0 } satisfies TrelloSyncJob);
}
