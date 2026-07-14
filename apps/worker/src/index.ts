import { randomUUID } from "node:crypto";
import { createDatabase } from "@atlas/database";
import {
  BaileysSessionManager,
  DeepSeekDecisionClient,
  WhatsAppMotherNotificationChannel,
  type WhatsAppSessionEvent,
} from "@atlas/integrations";
import {
  makeBatchIdempotencyKey,
  normalizedMessageSchema,
  parseAtlasSelfCommand,
  type NormalizedMessage,
} from "@atlas/shared";
import { PgBoss } from "pg-boss";
import pino from "pino";

import { ConversationBatcher } from "./batcher.js";
import { isUserAutomationKind } from "./automation-dispatch.js";
import { readWorkerConfig } from "./config.js";
import { QUEUES, registerHandlers, type AnalyzeBatchJob, type NotificationJob, type TrelloTaskJob } from "./handlers.js";
import { WorkerRepository } from "./repository.js";
import { reconcileWhatsAppSessions } from "./session-sync.js";

async function main(): Promise<void> {
  const config = readWorkerConfig();
  const logger = pino({ level: config.LOG_LEVEL });
  const database = createDatabase({
    connectionString: config.DATABASE_URL,
    applicationName: "atlas-worker",
  });
  const repository = new WorkerRepository(database);

  const boss = new PgBoss(config.DATABASE_URL);
  boss.on("error", (error) => logger.error({ error }, "pg-boss error"));
  await boss.start();

  let batcher: ConversationBatcher;
  const sessions = new BaileysSessionManager({
    authRepository: repository,
    selectedChats: repository,
    allowSending: false,
    onEvent: async (event: WhatsAppSessionEvent) => {
      if (event.type === "qr") {
        await repository.updateWhatsappState(event.userId, {
          status: "pairing",
          qrDataUrl: event.dataUrl,
        });
        return;
      }
      if (event.type === "connected") {
        await repository.updateWhatsappState(event.userId, {
          status: "connected",
          selfJid: event.selfJid,
          ...(event.displayName !== undefined ? { displayName: event.displayName } : {}),
        });
        await repository.enqueueWelcomeIfNeeded(event.userId);
        return;
      }
      if (event.type === "disconnected") {
        await repository.updateWhatsappState(event.userId, {
          status: event.retrying ? "reconnecting" : "disconnected",
        });
        return;
      }
      if (event.type === "logged_out") {
        await repository.updateWhatsappState(event.userId, { status: "logged_out" });
        return;
      }
      if (event.type === "error") {
        logger.error({ userId: event.userId, error: event.error }, "WhatsApp session error");
        await repository.updateWhatsappState(event.userId, {
          status: "error",
          error: event.error.message,
        });
        return;
      }
      if (event.type === "conversations") {
        await repository.upsertConversationCatalog(event.userId, event.conversations);
        return;
      }
      if (event.type === "contacts") {
        await repository.upsertContacts(event.userId, event.contacts);
        return;
      }

      const message = normalizedMessageSchema.parse({
        ...event.message,
        userId: event.userId,
      });
      if (message.fromMe) {
        const selfChat = await repository.isSelfChat(message.userId, message.chatJid);
        if (selfChat) {
          const command = parseAtlasSelfCommand(message.text);
          if (command && await repository.persistMessage(message)) {
            const handling = await repository.handleSelfCommand(message.userId, command, message.id);
            if (handling.task) {
              await boss.send(QUEUES.trello, {
                userId: message.userId,
                batchKey: `self-command:${message.id}`,
                task: handling.task.task,
                allowedCandidateCardIds: handling.task.allowedCandidateCardIds,
                allowedMemberIds: handling.task.allowedMemberIds,
                attempt: 0,
              } satisfies TrelloTaskJob);
            }
            if (handling.notification && await repository.shouldNotifySelf(message.userId)) {
              const outboxId = await repository.enqueueNotification(
                { userId: message.userId, ...handling.notification },
                `self-command:${message.id}:reply`,
              );
              await boss.send(QUEUES.notification, { outboxId, attempt: 0 } satisfies NotificationJob);
            }
            return;
          }
          // Texto livre no chat próprio é uma ótima forma de capturar notas,
          // decisões e observações. Ele segue para o fluxo normal abaixo.
        }
        // fromMe numa conversa monitorada (não self): NÃO descarta. Persiste e
        // manda ao batch para a IA ver os DOIS lados da conversa — contexto real
        // e compromissos que o próprio dono assume ("te envio amanhã"). Cai no
        // fluxo comum de ingestão abaixo.
      }
      if (await repository.persistMessage(message)) {
        if (await repository.isAutomationEnabled(message.userId, "message_ingestion")) {
          batcher.add(message);
        }
      }
    },
  });

  const motherSessions = new BaileysSessionManager({
    authRepository: repository.platformAuthRepository(),
    selectedChats: { isSelected: async () => false },
    acceptAllTextMessages: true,
    allowSending: true,
    onEvent: async (event: WhatsAppSessionEvent) => {
      if (event.type === "qr") {
        await repository.updatePlatformWhatsappState({ status: "pairing", qrDataUrl: event.dataUrl });
        return;
      }
      if (event.type === "connected") {
        await repository.updatePlatformWhatsappState({ status: "connected", selfJid: event.selfJid });
        return;
      }
      if (event.type === "disconnected") {
        await repository.updatePlatformWhatsappState({ status: event.retrying ? "reconnecting" : "disconnected" });
        return;
      }
      if (event.type === "logged_out") {
        await repository.updatePlatformWhatsappState({ status: "logged_out" });
        return;
      }
      if (event.type === "error") {
        logger.error({ error: event.error }, "Central WhatsApp session error");
        await repository.updatePlatformWhatsappState({ status: "error", error: event.error.message });
        return;
      }
      if (event.type === "contacts") return;
      if (event.type === "conversations" || event.message.fromMe) return;
      if (event.message.chatJid.endsWith("@g.us")) return;
      const userId = await repository.findUserByWhatsappJid(event.message.senderJid);
      if (!userId) {
        logger.warn({ senderJid: event.message.senderJid }, "Ignoring central WhatsApp message from an unknown number");
        return;
      }
      const message = normalizedMessageSchema.parse({ ...event.message, userId, fromMe: false });
      if (!(await repository.persistMotherMessage(message))) return;
      const command = parseAtlasSelfCommand(message.text);
      if (command) {
        const handling = await repository.handleSelfCommand(userId, command, message.id);
        if (handling.task) {
          await boss.send(QUEUES.trello, {
            userId,
            batchKey: `mother-command:${message.id}`,
            task: handling.task.task,
            allowedCandidateCardIds: handling.task.allowedCandidateCardIds,
            allowedMemberIds: handling.task.allowedMemberIds,
            attempt: 0,
          } satisfies TrelloTaskJob);
        }
        if (handling.notification) {
          await repository.enqueueNotification(
            { userId, ...handling.notification },
            `mother-command:${message.id}:reply`,
          );
        }
        return;
      }
      if (await repository.isAutomationEnabled(userId, "message_ingestion")) batcher.add(message);
      try {
        const conversation = await repository.buildAssistantConversation(userId);
        const answer = await deepSeek.answerAssistant(conversation);
        const outboxId = await repository.enqueueNotification(
          { userId, kind: "admin_message", title: "Atlas", body: answer },
          `mother-conversation:${message.id}:reply`,
        );
        await boss.send(QUEUES.notification, { outboxId, attempt: 0 } satisfies NotificationJob);
      } catch (error) {
        logger.error({ error, userId, messageId: message.id }, "Could not answer central WhatsApp conversation");
      }
    },
  });

  batcher = new ConversationBatcher({
    quietWindowMs: config.BATCH_QUIET_SECONDS * 1_000,
    maxWindowMs: config.BATCH_MAX_SECONDS * 1_000,
    maxMessages: 30,
    onFlush: async (batch) => {
      const batchKey = makeBatchIdempotencyKey(
        batch.userId,
        batch.chatJid,
        batch.messages.map((message) => message.id),
      );
      await repository.markMessagesStatus(
        batch.userId,
        batch.messages.map((message) => message.id),
        "batched",
      );
      const batchId = await repository.persistBatch({
        userId: batch.userId,
        chatJid: batch.chatJid,
        batchKey,
        messages: batch.messages,
        startedAt: batch.startedAt,
        flushedAt: batch.flushedAt,
      });
      await boss.send(QUEUES.analyze, {
        userId: batch.userId,
        chatJid: batch.chatJid,
        messages: batch.messages,
        batchKey,
        batchId,
        attempt: 0,
        immediateRepairAttempt: false,
      } satisfies AnalyzeBatchJob);
    },
  });

  const deepSeek = new DeepSeekDecisionClient({
    apiKey: config.DEEPSEEK_API_KEY,
    baseURL: config.DEEPSEEK_BASE_URL,
    model: config.DEEPSEEK_MODEL,
  });
  const notificationChannel = new WhatsAppMotherNotificationChannel(motherSessions, repository);
  await registerHandlers({ boss, repository, deepSeek, notificationChannel, config });

  const controlWorkerId = `atlas-control-${randomUUID()}`;
  let activeControlRun: Promise<void> | null = null;
  const processControlJobsOnce = async () => {
      const jobs = await repository.claimControlJobs(controlWorkerId);
      for (const job of jobs) {
        let automationId: string | null = null;
        try {
          if (job.jobType.startsWith("automation:")) {
            automationId = typeof job.input.automationId === "string" ? job.input.automationId : null;
            if (!automationId) throw new Error("Automation control job has no automationId");
            const automation = await repository.getAutomation(job.userId, automationId);
            if (!automation) throw new Error("Automation no longer exists");
            if (!automation.enabled) throw new Error("Automation is disabled");
            if (automation.kind === "pending_reminder" || isUserAutomationKind(automation.kind)) {
              if (!(await repository.shouldNotifySelf(job.userId))) {
                throw new Error("WhatsApp self notifications are disabled");
              }
              const notification = automation.kind === "pending_reminder"
                ? { kind: "brief" as const, title: "Resumo de tarefas", body: await repository.buildBrief(job.userId) }
                : await repository.buildAutomationNotification(job.userId, automation.kind);
              const outboxId = await repository.enqueueNotification(
                { userId: job.userId, ...notification },
                `automation:${automationId}:${job.id}`,
              );
              await boss.send(QUEUES.notification, { outboxId, attempt: 0 } satisfies NotificationJob);
              await repository.markAutomationResult(job.userId, automationId);
              await repository.completeControlJob(
                job.id,
                job.userId,
                controlWorkerId,
                { dispatched: true, notificationOutboxId: outboxId },
              );
              continue;
            }
            if (automation.kind === "message_ingestion") {
              const messages = await repository.loadRecoverableMessages(job.userId);
              for (const message of messages) batcher.add(message);
              await repository.markAutomationResult(job.userId, automationId);
              await repository.completeControlJob(
                job.id,
                job.userId,
                controlWorkerId,
                { recoveredMessages: messages.length },
              );
              continue;
            }
            throw new Error(`Unsupported manual automation kind: ${automation.kind}`);
          }

          if (job.jobType === "feedback:reprocess") {
            const feedbackId = typeof job.input.feedbackId === "string" ? job.input.feedbackId : null;
            if (!feedbackId) throw new Error("Reprocess control job has no feedbackId");
            const messages = await repository.loadFeedbackMessages(job.userId, feedbackId);
            if (!messages.length) throw new Error("No original WhatsApp evidence is available for this feedback");
            const chatJid = messages[0]!.chatJid;
            const chatMessages = messages.filter((message) => message.chatJid === chatJid).slice(-30);
            const batchKey = `${makeBatchIdempotencyKey(job.userId, chatJid, chatMessages.map((message) => message.id))}:feedback:${feedbackId}`;
            const startedAt = new Date(chatMessages[0]!.sentAt);
            const batchId = await repository.persistBatch({
              userId: job.userId,
              chatJid,
              batchKey,
              messages: chatMessages,
              startedAt,
              flushedAt: new Date(),
            });
            await boss.send(QUEUES.analyze, {
              userId: job.userId,
              chatJid,
              messages: chatMessages,
              batchKey,
              batchId,
              attempt: 0,
              immediateRepairAttempt: false,
            } satisfies AnalyzeBatchJob);
            await repository.completeControlJob(
              job.id,
              job.userId,
              controlWorkerId,
              { dispatched: true, batchId, messageCount: chatMessages.length },
            );
            continue;
          }
          if (job.jobType === "task:sync_trello") {
            const taskId = typeof job.input.taskId === "string" ? job.input.taskId : null;
            if (!taskId) throw new Error("Task sync job has no taskId");
            const prepared = await repository.getCanonicalTaskForSync(
              job.userId,
              taskId,
              typeof job.input.action === "string" ? job.input.action : null,
              `task-event:${job.id}`,
              typeof job.input.comment === "string" ? job.input.comment : null,
            );
            if (!prepared) throw new Error("Canonical task no longer exists");
            await boss.send(QUEUES.trello, {
              userId: job.userId,
              batchKey: `task-sync:${job.id}`,
              task: prepared.task,
              allowedCandidateCardIds: prepared.allowedCandidateCardIds,
              allowedMemberIds: prepared.allowedMemberIds,
              attempt: 0,
              resolveConflict: job.input.action === "resolve_conflict_keep_atlas",
            } satisfies TrelloTaskJob);
            await repository.completeControlJob(job.id, job.userId, controlWorkerId, { dispatched: true, taskId });
            continue;
          }
          if (job.jobType === "action_proposal:execute") {
            const proposalId = typeof job.input.proposalId === "string" ? job.input.proposalId : null;
            if (!proposalId) throw new Error("Proposal execution job has no proposalId");
            const dispatch = await repository.dispatchConfirmedProposal(job.userId, proposalId);
            if (dispatch?.kind === "trello") {
              await boss.send(QUEUES.trello, {
                userId: job.userId,
                batchKey: `proposal:${proposalId}`,
                task: dispatch.prepared.task,
                allowedCandidateCardIds: dispatch.prepared.allowedCandidateCardIds,
                allowedMemberIds: dispatch.prepared.allowedMemberIds,
                attempt: 0,
                proposalId,
              } satisfies TrelloTaskJob);
            }
            await repository.completeControlJob(job.id, job.userId, controlWorkerId, {
              dispatched: dispatch?.kind === "trello",
              completedWithoutTrello: dispatch?.kind === "completed",
              editRequired: dispatch?.kind === "edit_required",
              proposalId,
            });
            continue;
          }
          throw new Error(`Unsupported control job type: ${job.jobType}`);
        } catch (error) {
          if (automationId) await repository.markAutomationResult(job.userId, automationId, error);
          await repository.failControlJob(job.id, job.userId, controlWorkerId, job.attempt, error);
          logger.error({ error, controlJobId: job.id, jobType: job.jobType }, "Control job failed");
        }
      }
  };
  const processControlJobs = (): Promise<void> => {
    if (activeControlRun) return activeControlRun;
    activeControlRun = processControlJobsOnce()
      .catch((error) => logger.error({ error }, "Could not claim or process control jobs"))
      .finally(() => {
        activeControlRun = null;
      });
    return activeControlRun;
  };

  const recoverable = await repository.loadRecoverableMessages();
  for (const message of recoverable) batcher.add(message);

  let sessionSyncRunning = false;
  const syncSessions = async () => {
    if (sessionSyncRunning) return;
    sessionSyncRunning = true;
    try {
      const connections = await repository.listWhatsappConnections();
      await reconcileWhatsAppSessions(connections, sessions, (userId, error) => {
        logger.error({ error, userId }, "Could not start WhatsApp session");
      });
      const motherStatus = await repository.platformWhatsappStatus();
      if (["pairing", "connected", "reconnecting"].includes(motherStatus)) {
        if (!motherSessions.hasSession("mother")) await motherSessions.start("mother");
      } else if (motherSessions.hasSession("mother")) {
        await motherSessions.stop("mother");
      }
    } finally {
      sessionSyncRunning = false;
    }
  };
  await syncSessions();
  const sessionWatcher = setInterval(
    () => void syncSessions(),
    config.SESSION_WATCH_INTERVAL_SECONDS * 1_000,
  );
  await processControlJobs();
  const controlJobWatcher = setInterval(() => void processControlJobs(), 3_000);
  let outboxSweepRunning = false;
  const sweepMotherOutbox = async () => {
    if (outboxSweepRunning) return;
    outboxSweepRunning = true;
    try {
      const ids = await repository.listPendingMotherOutboxIds();
      for (const outboxId of ids) {
        await boss.send(QUEUES.notification, { outboxId, attempt: 0 } satisfies NotificationJob);
      }
    } finally {
      outboxSweepRunning = false;
    }
  };
  await sweepMotherOutbox();
  const outboxWatcher = setInterval(() => void sweepMotherOutbox(), 3_000);
  logger.info("Atlas worker started");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Stopping Atlas worker");
    clearInterval(sessionWatcher);
    clearInterval(controlJobWatcher);
    clearInterval(outboxWatcher);
    if (activeControlRun) await activeControlRun;
    await batcher.flushAll();
    await Promise.all(sessions.listSessionUserIds().map((userId) => sessions.suspend(userId)));
    await Promise.all(motherSessions.listSessionUserIds().map((sessionKey) => motherSessions.suspend(sessionKey)));
    await boss.stop({ graceful: true, timeout: 30_000 });
    await database.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
