import { randomUUID } from "node:crypto";

import type { Database } from "@atlas/database";
import {
  normalizeBrazilianPhone,
  type BaileysAuthRepository,
  type Notification,
  type SelectedChatRepository,
  type TrelloCard,
  type TrelloExecutionResult,
  type TrelloList,
  type TrelloListRoleMap,
  type TrelloMember,
  type WhatsAppConversationCatalogEntry,
  type WhatsAppRecipientResolver,
} from "@atlas/integrations";
import {
  AI_PROMPT_VERSION,
  aiDecisionSchema,
  aiCommitmentSchema,
  aiTaskSchema,
  buildAiContext,
  canExecuteCommitmentMutation,
  makeCanonicalTaskFingerprint,
  shouldActivateLearning,
  type ActionProposal,
  type ActiveLearning,
  type AtlasSelfCommand,
  type AiContext,
  type AiCommitment,
  type AiCorrection,
  type AiDecision,
  type AiMemory,
  type AiLearning,
  type AiPreferences,
  type AiReminder,
  type AiTask,
  type CardCandidate,
  type CommitmentCandidate,
  type KnownMemory,
  type NormalizedMessage,
} from "@atlas/shared";

import { materializeNextReminderOccurrence } from "./reminder-schedule.js";
import { composeAtlasPersonalization } from "./personalization.js";
import { composeAutomationNotification, type UserAutomationKind } from "./automation-dispatch.js";
import { nextAutomationRun } from "./automation-schedule.js";

interface IdRow {
  id: string;
}

export function validIanaTimezone(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat("pt-BR", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export interface ActiveWhatsappConnection {
  userId: string;
  connectionId: string;
  status: "disconnected" | "pairing" | "connected" | "reconnecting" | "logged_out" | "error";
}

export interface TrelloRuntimeConfig {
  apiKey: string;
  token: string;
  boardId: string;
  boardConfigId: string;
  connectionId: string;
  listRoles: TrelloListRoleMap;
}

export interface OutboxRecord {
  id: number;
  userId: string;
  subject: string;
  body: string;
  payload: Record<string, unknown>;
  lockToken: string;
}

export interface AiRunStart {
  runId: string;
  previousDecision: AiDecision | null;
}

export interface ControlJob {
  id: string;
  userId: string;
  jobType: string;
  attempt: number;
  input: Record<string, unknown>;
}

export interface AutomationRecord {
  id: string;
  userId: string;
  kind: string;
  enabled: boolean;
  schedule: string | null;
  timezone: string;
  config: Record<string, unknown>;
  nextRunAt: Date | null;
}

export interface CanonicalTaskPreparation {
  taskId: string;
  fingerprint: string;
  existingCardId: string | null;
  existingCardUrl: string | null;
  syncConflict: boolean;
}

export interface DueReminderOccurrence {
  id: string;
  userId: string;
  title: string;
}

export interface CanonicalTaskForSync {
  task: AiTask;
  allowedCandidateCardIds: string[];
  allowedMemberIds: string[];
}

export function mapTrelloCardState(
  card: Pick<TrelloCard, "closed" | "dueComplete" | "idList">,
  listRoles: TrelloListRoleMap,
): { canonicalStatus: "done" | "cancelled" | "in_progress" | "paused" | "inbox" | "open"; dueCompleted: boolean } {
  const dueCompleted = card.dueComplete === true || card.idList === listRoles.done;
  const canonicalStatus = dueCompleted ? "done"
    : card.closed ? "cancelled"
      : card.idList === listRoles.inProgress ? "in_progress"
        : card.idList === listRoles.paused ? "paused"
          : card.idList === listRoles.inbox ? "inbox" : "open";
  return { canonicalStatus, dueCompleted };
}

export interface SelfCommandHandling {
  handled: boolean;
  notification?: Omit<Notification, "userId">;
  task?: CanonicalTaskForSync;
}

export type ConfirmedProposalDispatch =
  | { kind: "trello"; prepared: CanonicalTaskForSync }
  | { kind: "completed" }
  | { kind: "edit_required"; message: string };

export type MessageBatchStatus =
  | "ready"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

export type GeneratedSummaryKind =
  | "daily_summary"
  | "weekly_review"
  | "consolidated_summary";

export class WorkerRepository implements BaileysAuthRepository, SelectedChatRepository, WhatsAppRecipientResolver {
  constructor(readonly database: Database) {}

  async publishEvent(
    userId: string,
    eventType: string,
    payload: Record<string, unknown> = {},
    topic = "app",
  ): Promise<void> {
    await this.database.query(
      `INSERT INTO event_outbox (user_id, topic, event_type, payload)
       VALUES ($1, $2, $3, $4)`,
      [userId, topic, eventType, payload],
    );
  }

  async isAutomationEnabled(userId: string, kind: string): Promise<boolean> {
    const result = await this.database.query(
      `SELECT 1 FROM automations
       WHERE user_id = $1 AND kind = $2 AND enabled = true LIMIT 1`,
      [userId, kind],
    );
    return result.rowCount === 1;
  }

  async shouldNotifySelf(userId: string): Promise<boolean> {
    const result = await this.database.query<{ enabled: boolean }>(
      `SELECT COALESCE((feature_flags->>'notifySelf')::boolean, true) AS enabled
       FROM user_settings WHERE user_id = $1`,
      [userId],
    );
    return result.rows[0]?.enabled ?? true;
  }

  async get(userId: string, category: string, key: string): Promise<string | null> {
    const result = await this.database.query<{ record_value: string }>(
      `SELECT record_value FROM whatsapp_auth_records
       WHERE user_id = $1 AND category = $2 AND record_key = $3`,
      [userId, category, key],
    );
    return result.rows[0]?.record_value ?? null;
  }

  async set(
    userId: string,
    category: string,
    key: string,
    value: string | null,
  ): Promise<void> {
    if (value === null) {
      await this.database.query(
        `DELETE FROM whatsapp_auth_records
         WHERE user_id = $1 AND category = $2 AND record_key = $3`,
        [userId, category, key],
      );
      return;
    }
    await this.database.query(
      `INSERT INTO whatsapp_auth_records (user_id, category, record_key, record_value)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, category, record_key)
       DO UPDATE SET record_value = EXCLUDED.record_value, updated_at = now()`,
      [userId, category, key, value],
    );
  }

  async clearUser(userId: string): Promise<void> {
    await this.database.query("DELETE FROM whatsapp_auth_records WHERE user_id = $1", [userId]);
  }

  async isSelected(userId: string, chatJid: string): Promise<boolean> {
    const result = await this.database.query(
      `SELECT 1 FROM monitored_chats
       WHERE user_id = $1 AND jid = $2 AND enabled = true LIMIT 1`,
      [userId, chatJid],
    );
    return result.rowCount === 1;
  }

  async listWhatsappConnections(): Promise<ActiveWhatsappConnection[]> {
    const result = await this.database.query<{
      user_id: string;
      id: string;
      status: ActiveWhatsappConnection["status"];
    }>(
      `SELECT DISTINCT ON (user_id) user_id, id, status
       FROM whatsapp_connections
       ORDER BY user_id, updated_at DESC`,
    );
    return result.rows.map((row) => ({
      userId: row.user_id,
      connectionId: row.id,
      status: row.status,
    }));
  }

  async getConnectionId(userId: string): Promise<string> {
    const result = await this.database.query<IdRow>(
      `SELECT id FROM whatsapp_connections
       WHERE user_id = $1 AND status <> 'logged_out'
       ORDER BY updated_at DESC LIMIT 1`,
      [userId],
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error(`No WhatsApp connection for user ${userId}`);
    return id;
  }

  async updateWhatsappState(
    userId: string,
    state:
      | { status: "pairing"; qrDataUrl: string }
      | { status: "connected"; selfJid: string; displayName?: string | null }
      | { status: "reconnecting" }
      | { status: "disconnected" }
      | { status: "logged_out" }
      | { status: "error"; error: string },
  ): Promise<void> {
    if (state.status === "pairing") {
      await this.database.query(
        `UPDATE whatsapp_connections SET status = 'pairing', pairing_qr = $2,
           pairing_expires_at = now() + interval '2 minutes', last_error = NULL
         WHERE user_id = $1 AND status <> 'logged_out'`,
        [userId, state.qrDataUrl],
      );
      await this.publishEvent(userId, "whatsapp.state.changed", { status: state.status }, "whatsapp");
      return;
    }
    if (state.status === "connected") {
      const phone = normalizeBrazilianPhone(state.selfJid);
      if (!phone) throw new Error(`Could not identify a Brazilian phone number from ${state.selfJid}`);
      await this.database.userTransaction(userId, async (client) => {
        await client.query(
          `UPDATE whatsapp_connections SET status = 'connected', jid = $2, self_jid = $2, phone_number = $3,
             pairing_qr = NULL, pairing_expires_at = NULL, last_connected_at = now(), last_error = NULL
           WHERE user_id = $1 AND status <> 'logged_out'`,
          [userId, phone.jid, phone.formatted],
        );
        if (state.displayName?.trim()) {
          await client.query(
            `INSERT INTO user_profiles (user_id,whatsapp_name_suggestion,whatsapp_name_suggested_at)
             VALUES ($1,$2,now())
             ON CONFLICT (user_id) DO UPDATE SET whatsapp_name_suggestion=EXCLUDED.whatsapp_name_suggestion,
               whatsapp_name_suggested_at=EXCLUDED.whatsapp_name_suggested_at`,
            [userId, state.displayName.trim().slice(0, 240)],
          );
        }
      });
      await this.publishEvent(userId, "whatsapp.state.changed", { status: state.status }, "whatsapp");
      return;
    }
    await this.database.query(
      `UPDATE whatsapp_connections SET status = $2,
         pairing_qr = CASE WHEN $2 = 'logged_out' THEN NULL ELSE pairing_qr END,
         last_error = $3
       WHERE user_id = $1 AND status <> 'logged_out'`,
      [userId, state.status, state.status === "error" ? state.error : null],
    );
    await this.publishEvent(
      userId,
      "whatsapp.state.changed",
      { status: state.status, ...(state.status === "error" ? { error: state.error } : {}) },
      "whatsapp",
    );
  }

  async upsertConversationCatalog(
    userId: string,
    conversations: readonly WhatsAppConversationCatalogEntry[],
  ): Promise<void> {
    const connectionId = await this.getConnectionId(userId);
    await this.database.transaction(async (client) => {
      for (const conversation of conversations) {
        await client.query(
          `INSERT INTO whatsapp_conversation_catalog
             (user_id, whatsapp_connection_id, jid, display_name, is_group, conversation_timestamp)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (user_id, whatsapp_connection_id, jid)
           DO UPDATE SET display_name = CASE
               WHEN EXCLUDED.display_name <> '' THEN EXCLUDED.display_name
               ELSE whatsapp_conversation_catalog.display_name END,
             is_group = EXCLUDED.is_group,
             conversation_timestamp = COALESCE(EXCLUDED.conversation_timestamp,
               whatsapp_conversation_catalog.conversation_timestamp),
             last_seen_at = now()`,
          [
            userId,
            connectionId,
            conversation.jid,
            conversation.name ?? "",
            conversation.isGroup,
            conversation.conversationTimestamp,
          ],
        );
        await client.query(
          `INSERT INTO monitored_chats
             (user_id, whatsapp_connection_id, jid, display_name, is_group, enabled)
           VALUES ($1, $2, $3, $4, $5, false)
           ON CONFLICT (user_id, whatsapp_connection_id, jid)
           DO UPDATE SET display_name = CASE
               WHEN EXCLUDED.display_name <> '' THEN EXCLUDED.display_name
               ELSE monitored_chats.display_name END,
             is_group = EXCLUDED.is_group`,
          [
            userId,
            connectionId,
            conversation.jid,
            conversation.name ?? "",
            conversation.isGroup,
          ],
        );
      }
    });
  }

  async upsertContacts(
    userId: string,
    contacts: readonly { jid: string; name: string; saved?: boolean }[],
  ): Promise<void> {
    const connectionId = await this.getConnectionId(userId);
    await this.database.transaction(async (client) => {
      for (const contact of contacts) {
        if (!contact.name) continue;
        // Nome salvo na agenda ($5=true) SOBRESCREVE o que estiver lá (o sync do
        // chat costuma gravar o pushName ou o número). pushName/verificado
        // ($5=false) só preenchem quando o chat ainda está sem nome.
        const saved = contact.saved === true;
        await client.query(
          `UPDATE whatsapp_conversation_catalog
           SET display_name = $4, last_seen_at = now()
           WHERE user_id = $1 AND whatsapp_connection_id = $2 AND jid = $3
             AND ($5::boolean OR display_name = '' OR display_name IS NULL)`,
          [userId, connectionId, contact.jid, contact.name, saved],
        );
        await client.query(
          `UPDATE monitored_chats
           SET display_name = $4
           WHERE user_id = $1 AND whatsapp_connection_id = $2 AND jid = $3
             AND ($5::boolean OR display_name = '' OR display_name IS NULL)`,
          [userId, connectionId, contact.jid, contact.name, saved],
        );
      }
    });
  }

  async persistMessage(message: NormalizedMessage): Promise<boolean> {
    const connectionId = await this.getConnectionId(message.userId);
    const result = await this.database.query<IdRow>(
      `INSERT INTO whatsapp_messages
         (user_id, whatsapp_connection_id, monitored_chat_id, external_message_id,
          chat_jid, sender_jid, direction, from_me, message_type, body, sent_at)
       SELECT $1, $2, mc.id, $3, $4, $5,
         CASE WHEN $6 THEN 'outbound' ELSE 'inbound' END, $6, 'text', $7, $8
       FROM whatsapp_connections wc
       LEFT JOIN monitored_chats mc ON mc.user_id=wc.user_id
         AND mc.whatsapp_connection_id=wc.id AND mc.jid=$4 AND mc.enabled=true
       WHERE wc.user_id=$1 AND wc.id=$2
         AND (mc.id IS NOT NULL OR wc.self_jid=$4)
         AND NOT EXISTS (
           SELECT 1 FROM notification_outbox no
           WHERE no.user_id = $1 AND no.external_message_id = $3
         )
       ON CONFLICT (user_id, whatsapp_connection_id, external_message_id) DO NOTHING
       RETURNING id`,
      [
        message.userId,
        connectionId,
        message.id,
        message.chatJid,
        message.senderJid,
        message.fromMe,
        message.text,
        message.sentAt,
      ],
    );
    return result.rowCount === 1;
  }

  async loadRecoverableMessages(userId?: string): Promise<NormalizedMessage[]> {
    const result = await this.database.query<{
      external_message_id: string;
      user_id: string;
      chat_jid: string;
      sender_jid: string;
      display_name: string | null;
      sent_at: Date;
      from_me: boolean;
      body: string;
    }>(
      `SELECT external_message_id, user_id, chat_jid, sender_jid, display_name,
              sent_at, from_me, body
       FROM (
         SELECT wm.external_message_id, wm.user_id, wm.chat_jid, wm.sender_jid,
                NULLIF(mc.display_name, '') AS display_name, wm.sent_at,
                wm.from_me, wm.body,
                row_number() OVER (
                  PARTITION BY wm.user_id, wm.chat_jid ORDER BY wm.sent_at DESC
                ) AS position
         FROM whatsapp_messages wm
         LEFT JOIN monitored_chats mc ON mc.id = wm.monitored_chat_id
         WHERE wm.processing_status IN ('pending', 'batched')
           AND wm.received_at > now() - interval '7 days'
           AND ($1::uuid IS NULL OR wm.user_id = $1)
           AND EXISTS (
             SELECT 1 FROM automations a
             WHERE a.user_id = wm.user_id AND a.kind = 'message_ingestion' AND a.enabled = true
           )
       ) recoverable
       WHERE position <= 30
       ORDER BY sent_at`,
      [userId ?? null],
    );
    return result.rows.map((row) => ({
      id: row.external_message_id,
      userId: row.user_id,
      chatJid: row.chat_jid,
      senderJid: row.sender_jid,
      senderName: row.display_name,
      sentAt: row.sent_at.toISOString(),
      fromMe: row.from_me,
      text: row.body,
    }));
  }

  async markMessagesStatus(
    userId: string,
    messageIds: readonly string[],
    status: "batched" | "processed" | "failed",
  ): Promise<void> {
    if (messageIds.length === 0) return;
    await this.database.query(
      `UPDATE whatsapp_messages SET processing_status = $3
       WHERE user_id = $1 AND external_message_id = ANY($2::text[])`,
      [userId, [...messageIds], status],
    );
  }

  async persistBatch(input: {
    userId: string;
    chatJid: string;
    batchKey: string;
    messages: readonly NormalizedMessage[];
    startedAt: Date;
    flushedAt: Date;
  }): Promise<string> {
    const connectionId = await this.getConnectionId(input.userId);
    return this.database.transaction(async (client) => {
      const batch = await client.query<IdRow>(
        `INSERT INTO message_batches
           (user_id, whatsapp_connection_id, chat_jid, batch_key, status,
            window_started_at, window_ends_at, message_count, combined_text)
         VALUES ($1, $2, $3, $4, 'ready', $5, $6, $7, $8)
         ON CONFLICT (user_id, batch_key)
         DO UPDATE SET status = CASE
             WHEN message_batches.status = 'completed' THEN 'completed'
             ELSE 'ready' END,
           message_count = EXCLUDED.message_count,
           combined_text = EXCLUDED.combined_text,
           window_ends_at = EXCLUDED.window_ends_at
         RETURNING id`,
        [
          input.userId,
          connectionId,
          input.chatJid,
          input.batchKey,
          input.startedAt,
          input.flushedAt,
          input.messages.length,
          input.messages.map((message) => message.text).join("\n"),
        ],
      );
      const batchId = batch.rows[0]!.id;
      for (const [position, message] of input.messages.entries()) {
        await client.query(
          `INSERT INTO message_batch_items (user_id, batch_id, message_id, position)
           SELECT $1, $2, wm.id, $4
           FROM whatsapp_messages wm
           WHERE wm.user_id = $1 AND wm.external_message_id = $3
           ON CONFLICT DO NOTHING`,
          [input.userId, batchId, message.id, position],
        );
      }
      return batchId;
    });
  }

  async updateBatchStatus(
    userId: string,
    batchId: string,
    status: MessageBatchStatus,
    error?: unknown,
  ): Promise<void> {
    await this.database.query(
      `UPDATE message_batches SET status = $3,
         attempt_count = CASE WHEN $3 = 'processing' THEN attempt_count + 1 ELSE attempt_count END,
         completed_at = CASE WHEN $3 = 'completed' THEN now() ELSE completed_at END,
         last_error = $4
       WHERE user_id = $1 AND id = $2`,
      [
        userId,
        batchId,
        status,
        error === undefined
          ? null
          : error instanceof Error
            ? error.message.slice(0, 1_000)
            : String(error).slice(0, 1_000),
      ],
    );
  }

  async buildContext(
    userId: string,
    chatJid: string,
    batchMessages: readonly NormalizedMessage[],
  ): Promise<AiContext> {
    const recent = await this.database.query<{
      external_message_id: string;
      sender_jid: string;
      sent_at: Date;
      from_me: boolean;
      body: string;
      display_name: string | null;
    }>(
      `SELECT wm.external_message_id, wm.sender_jid, wm.sent_at, wm.from_me, wm.body,
              NULLIF(mc.display_name, '') AS display_name
       FROM whatsapp_messages wm
       LEFT JOIN monitored_chats mc ON mc.id = wm.monitored_chat_id
       WHERE wm.user_id = $1 AND wm.chat_jid = $2
       ORDER BY wm.sent_at DESC LIMIT 15`,
      [userId, chatJid],
    );
    const settings = await this.database.query<{
      timezone: string;
      locale: string;
      feature_flags: Record<string, unknown>;
      preferred_name: string;
      professional_area: string | null;
      goals: string[];
      work_days: number[];
      work_start: string;
      work_end: string;
      communication_style: string;
    }>(
      `SELECT us.timezone,us.locale,us.feature_flags,u.preferred_name,
              up.professional_area,COALESCE(up.goals,'{}') AS goals,
              us.work_days,us.work_start::text,us.work_end::text,us.communication_style
       FROM user_settings us
       JOIN users u ON u.id=us.user_id
       LEFT JOIN user_profiles up ON up.user_id=us.user_id
       WHERE us.user_id=$1`,
      [userId],
    );
    const featureFlags = settings.rows[0]?.feature_flags ?? {};
    const profile = settings.rows[0];
    const personalization = profile
      ? composeAtlasPersonalization({
          preferredName: profile.preferred_name,
          professionalArea: profile.professional_area,
          goals: profile.goals,
          workDays: profile.work_days,
          workStart: profile.work_start,
          workEnd: profile.work_end,
          communicationStyle: profile.communication_style,
          customInstructions: typeof featureFlags.aiInstructions === "string" ? featureFlags.aiInstructions : "",
        })
      : { replyTone: "claro, calmo e equilibrado", customInstructions: "" };
    const preferences: Partial<AiPreferences> = {
      timezone: settings.rows[0]?.timezone ?? "America/Sao_Paulo",
      language: settings.rows[0]?.locale ?? "pt-BR",
      replyTone:
        typeof featureFlags.replyTone === "string" ? featureFlags.replyTone : personalization.replyTone,
      customInstructions:
        personalization.customInstructions,
    };
    const queryText = batchMessages.map((item) => item.text).join(" ").slice(0, 8_000);
    const memoriesResult = await this.database.query<{
      type: KnownMemory["nodeType"];
      title: string;
      content: string;
      aliases: string[];
      tags: string[];
    }>(
      `SELECT type, title,
              concat_ws(E'\n',NULLIF(manual_content,''),NULLIF(generated_content,'')) AS content,
              aliases, tags
       FROM brain_nodes
       WHERE user_id = $1 AND status = 'active'
         AND (
           search_vector @@ websearch_to_tsquery('portuguese', $2)
           OR similarity(title, left($2, 1000)) > 0.18
         )
       ORDER BY ts_rank_cd(search_vector, websearch_to_tsquery('portuguese', $2)) DESC,
                similarity(title, left($2, 1000)) DESC,
                updated_at DESC
       LIMIT 8`,
      [userId, queryText],
    );
    const cardsResult = await this.database.query<{
      trello_card_id: string;
      canonical_task_id: string | null;
      title: string;
      description: string;
      list_name: string;
      due_at: Date | null;
      url: string | null;
    }>(
      `SELECT tc.trello_card_id, ctl.task_id::text AS canonical_task_id,
              tc.title, tc.description, tc.list_name, tc.due_at, tc.url
       FROM trello_cards tc
       LEFT JOIN task_trello_links ctl ON ctl.user_id = tc.user_id AND ctl.trello_card_id = tc.id
       WHERE tc.user_id = $1 AND tc.closed = false AND tc.due_complete = false
       ORDER BY similarity(tc.title, $2) DESC, tc.updated_at DESC LIMIT 8`,
      [userId, queryText.slice(0, 1_000)],
    );
    const taskScopes = await this.database.query<{
      project_node_id: string | null;
      person_node_id: string | null;
      project_name: string | null;
      person_name: string | null;
    }>(
      `SELECT project_node_id::text,person_node_id::text,
              NULLIF(metadata->>'project','') AS project_name,
              NULLIF(metadata->>'person','') AS person_name
       FROM canonical_tasks
       WHERE user_id=$1 AND id::text=ANY($2::text[])`,
      [userId, cardsResult.rows.flatMap((row) => row.canonical_task_id ? [row.canonical_task_id] : [])],
    );
    const personScopeRefs = [...new Set([
      ...taskScopes.rows.flatMap((row) => [row.person_node_id, row.person_name]),
      ...memoriesResult.rows.filter((row) => row.type === "person").map((row) => row.title),
    ].filter((value): value is string => Boolean(value)))];
    const projectScopeRefs = [...new Set([
      ...taskScopes.rows.flatMap((row) => [row.project_node_id, row.project_name]),
      ...memoriesResult.rows.filter((row) => row.type === "project").map((row) => row.title),
    ].filter((value): value is string => Boolean(value)))];
    const correctionsResult = await this.database.query<{
      kind: string;
      comment: string;
      metadata: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT kind, comment, metadata, created_at
       FROM feedback
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 8`,
      [userId],
    );
    await this.database.query(
      `UPDATE assistant_learnings SET state='suggested',requires_confirmation=true,
         metadata=metadata || jsonb_build_object('reviewReason','inactive_90_days','reviewRequestedAt',now())
       WHERE user_id=$1 AND state='active' AND source_type='inferred'
         AND COALESCE(last_used_at,activated_at,last_evidence_at,created_at)<=now()-interval '90 days'`,
      [userId],
    );
    const learningsResult = await this.database.query<{
      id: string;
      scope_type: ActiveLearning["scope"];
      scope_id: string | null;
      statement: string;
      confidence: number;
      source_type: "explicit" | "inferred";
    }>(
      `SELECT id::text, scope_type, scope_id, statement, confidence::float, source_type
       FROM assistant_learnings
       WHERE user_id = $1 AND state = 'active' AND requires_confirmation=false
         AND (
           scope_type = 'global'
           OR (scope_type = 'conversation' AND scope_id = $2)
           OR (scope_type = 'person' AND scope_id=ANY($3::text[]))
           OR (scope_type = 'project' AND scope_id=ANY($4::text[]))
         )
       ORDER BY source_type = 'explicit' DESC, confidence DESC, last_used_at DESC NULLS LAST
       LIMIT 6`,
      [userId, chatJid, personScopeRefs, projectScopeRefs],
    );
    if (learningsResult.rows.length) {
      await this.database.query(
        `UPDATE assistant_learnings SET last_used_at=now(),review_after=now()+interval '90 days'
         WHERE user_id=$1 AND id=ANY($2::uuid[]) AND state='active'`,
        [userId, learningsResult.rows.map((row) => row.id)],
      );
    }
    const selfChatResult = await this.database.query<{ is_self_chat: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM whatsapp_connections
         WHERE user_id = $1 AND self_jid IS NOT NULL AND self_jid = $2
       ) AS is_self_chat`,
      [userId, chatJid],
    );
    const board = await this.database.query<{
      inbox_list_id: string | null;
      in_progress_list_id: string | null;
      paused_list_id: string | null;
      done_list_id: string | null;
    }>(
      `SELECT inbox_list_id, in_progress_list_id, paused_list_id, done_list_id
       FROM trello_board_configs WHERE user_id = $1 AND is_active = true
       ORDER BY updated_at DESC LIMIT 1`,
      [userId],
    );
    const allowedMembers = await this.database.query<{ member_id: string }>(
      `SELECT DISTINCT member_id FROM (
         SELECT member_id FROM trello_connections
         WHERE user_id=$1 AND status='connected' AND member_id IS NOT NULL
         UNION ALL
         SELECT member->>'id' AS member_id
         FROM trello_connections tc
         CROSS JOIN LATERAL jsonb_array_elements(COALESCE(tc.metadata->'boardMembers','[]'::jsonb)) member
         WHERE tc.user_id=$1 AND tc.status='connected'
         UNION ALL
         SELECT trim(both '"' from member::text) AS member_id
         FROM trello_cards card
         CROSS JOIN LATERAL jsonb_array_elements(COALESCE(card.members,'[]'::jsonb)) member
         WHERE card.user_id=$1 AND jsonb_typeof(member)='string'
       ) allowed WHERE member_id IS NOT NULL AND btrim(member_id)<>''`,
      [userId],
    );
    const previous = await this.database.query<{ summary: string | null }>(
      `SELECT NULLIF(output->>'conversationSummary', '') AS summary
       FROM ai_runs
       WHERE user_id = $1 AND purpose = 'whatsapp_triage' AND status = 'succeeded'
         AND input->>'chatJid' = $2
       ORDER BY completed_at DESC LIMIT 1`,
      [userId, chatJid],
    );

    const recentMessages: NormalizedMessage[] = recent.rows.map((row) => ({
      id: row.external_message_id,
      userId,
      chatJid,
      senderJid: row.sender_jid,
      senderName: row.display_name,
      sentAt: row.sent_at.toISOString(),
      fromMe: row.from_me,
      text: row.body,
    }));
    const merged = new Map<string, NormalizedMessage>();
    for (const message of [...recentMessages, ...batchMessages]) merged.set(message.id, message);
    const memories: KnownMemory[] = memoriesResult.rows.map((row) => ({
      nodeType: row.type,
      title: row.title,
      content: row.content,
      aliases: row.aliases,
      tags: row.tags,
    }));
    const cardCandidates: CardCandidate[] = cardsResult.rows.map((row) => ({
      id: row.trello_card_id,
      name: row.title,
      description: row.description,
      listName: row.list_name || "Sem lista",
      dueAt: row.due_at?.toISOString() ?? null,
      url: row.url,
      canonicalTaskId: row.canonical_task_id,
    }));
    const corrections: AiCorrection[] = correctionsResult.rows.map((row) => ({
      action: row.kind,
      comment: row.comment.slice(0, 2_000),
      metadata: row.metadata,
      createdAt: row.created_at.toISOString(),
    }));
    const activeLearnings: ActiveLearning[] = learningsResult.rows.map((row) => ({
      id: row.id,
      scope: row.scope_type,
      scopeRef: row.scope_id,
      statement: row.statement,
      confidence: row.confidence,
      explicitInstruction: row.source_type === "explicit",
    }));
    const allowedListKeys = board.rows[0]
      ? (["inbox", "inProgress", "paused", "done"] as const).filter((role) => {
          const row = board.rows[0];
          if (!row) return false;
          return {
            inbox: row.inbox_list_id,
            inProgress: row.in_progress_list_id,
            paused: row.paused_list_id,
            done: row.done_list_id,
          }[role] !== null;
        })
      : [];
    const commitmentCandidatesResult = await this.database.query<{
      id: string; direction: CommitmentCandidate["direction"]; title: string; counterpart_name: string | null;
      status: CommitmentCandidate["status"]; due_at: Date | null; next_follow_up_at: Date | null;
    }>(
      `SELECT id::text,direction,title,counterpart_name,status,due_at,next_follow_up_at
       FROM commitments WHERE user_id=$1 AND status IN ('open','waiting','fulfilled','cancelled')
       ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END,
         COALESCE(next_follow_up_at,due_at) NULLS LAST,updated_at DESC LIMIT 12`,
      [userId],
    );
    const commitmentCandidates: CommitmentCandidate[] = commitmentCandidatesResult.rows.map((item) => ({
      id: item.id, direction: item.direction, title: item.title, counterparty: item.counterpart_name,
      status: item.status, dueAt: item.due_at?.toISOString() ?? null,
      nextFollowUpAt: item.next_follow_up_at?.toISOString() ?? null,
    }));
    return buildAiContext({
      now: new Date(),
      chatJid,
      chatName: recent.rows[0]?.display_name ?? null,
      previousSummary: previous.rows[0]?.summary ?? null,
      preferences,
      messages: [...merged.values()],
      memories,
      corrections,
      activeLearnings,
      cardCandidates,
      commitmentCandidates,
      allowedListKeys,
      allowedTrelloMemberIds: allowedMembers.rows.map((row) => row.member_id),
      isSelfChat: selfChatResult.rows[0]?.is_self_chat ?? false,
    });
  }

  async beginAiRun(
    userId: string,
    batchKey: string,
    context: AiContext,
    batchId: string,
  ): Promise<AiRunStart> {
    const existing = await this.database.query<{ id: string; status: string; output: unknown }>(
      `SELECT id, status, output FROM ai_runs
       WHERE user_id = $1 AND purpose = 'whatsapp_triage' AND idempotency_key = $2`,
      [userId, batchKey],
    );
    const previous = existing.rows[0];
    if (previous?.status === "succeeded") {
      const parsed = aiDecisionSchema.safeParse(previous.output);
      return { runId: previous.id, previousDecision: parsed.success ? parsed.data : null };
    }
    if (previous) {
      await this.database.query(
        `UPDATE ai_runs SET status = 'running', input = $3, message_batch_id = $4, started_at = now(),
           error_code = NULL, error_message = NULL
         WHERE user_id = $1 AND id = $2`,
        [userId, previous.id, JSON.stringify(context), batchId],
      );
      return { runId: previous.id, previousDecision: null };
    }
    const inserted = await this.database.query<IdRow>(
      `INSERT INTO ai_runs
         (user_id, purpose, provider, model, reasoning_effort, status, prompt_version,
          idempotency_key, input, message_batch_id, started_at)
       VALUES ($1, 'whatsapp_triage', 'deepseek', 'deepseek-v4-flash', 'medium',
         'running', $5, $2, $3, $4, now()) RETURNING id`,
      [userId, batchKey, JSON.stringify(context), batchId, AI_PROMPT_VERSION],
    );
    return { runId: inserted.rows[0]!.id, previousDecision: null };
  }

  async completeAiRun(
    userId: string,
    runId: string,
    decision: AiDecision,
    usage: {
      promptTokens: number;
      completionTokens: number;
      cacheHitTokens: number;
      requestId: string | null;
    },
    latencyMs: number,
  ): Promise<void> {
    const cacheMissTokens = Math.max(0, usage.promptTokens - usage.cacheHitTokens);
    const costMicros = Math.round(
      cacheMissTokens * 0.14 +
        usage.cacheHitTokens * 0.0028 +
        usage.completionTokens * 0.28,
    );
    await this.database.transaction(async (client) => {
      await client.query(
        `UPDATE ai_runs SET status = 'succeeded', output = $3, request_id = $4,
           prompt_tokens = $5, completion_tokens = $6, cached_tokens = $7,
           cost_micros = $8, latency_ms = $9, completed_at = now()
         WHERE user_id = $1 AND id = $2`,
        [
          userId,
          runId,
          JSON.stringify(decision),
          usage.requestId,
          usage.promptTokens,
          usage.completionTokens,
          usage.cacheHitTokens,
          costMicros,
          latencyMs,
        ],
      );
      await client.query(
        `INSERT INTO ai_usage_events
           (user_id, ai_run_id, provider, model, purpose, prompt_tokens,
            completion_tokens, cached_tokens, cost_micros)
         VALUES ($1, $2, 'deepseek', 'deepseek-v4-flash', 'whatsapp_triage',
           $3, $4, $5, $6)
         ON CONFLICT (ai_run_id) DO NOTHING`,
        [userId, runId, usage.promptTokens, usage.completionTokens, usage.cacheHitTokens, costMicros],
      );
    });
  }

  async failAiRun(userId: string, runId: string, error: unknown): Promise<void> {
    await this.database.query(
      `UPDATE ai_runs SET status = 'failed', error_code = $3, error_message = $4,
         completed_at = now()
       WHERE user_id = $1 AND id = $2 AND status = 'running'`,
      [
        userId,
        runId,
        error instanceof Error ? error.name : "Error",
        error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000),
      ],
    );
  }

  async upsertMemories(userId: string, memories: readonly AiMemory[]): Promise<void> {
    let changed = 0;
    await this.database.userTransaction(userId, async (client) => {
      const nodeIds = new Map<string, string>();
      for (const memory of memories) {
        if (memory.operation !== "upsert" || !memory.generatedContent) continue;
        const sourceId = `${memory.nodeType}:${memory.title.toLocaleLowerCase("pt-BR")}`;
        const result = await client.query<IdRow>(
          `INSERT INTO brain_nodes
             (user_id, type, domain, title, generated_content, aliases, tags,
              source_type, source_id, metadata)
           VALUES ($1, $2, 'whatsapp', $3, $4, $5, $6, 'atlas-ai', $7, $8)
           ON CONFLICT (user_id, source_type, source_id)
             WHERE source_type IS NOT NULL AND source_id IS NOT NULL
           DO UPDATE SET title = EXCLUDED.title,
             generated_content = EXCLUDED.generated_content,
             aliases = EXCLUDED.aliases, tags = EXCLUDED.tags,
             metadata = brain_nodes.metadata || EXCLUDED.metadata
           RETURNING id`,
          [
            userId,
            memory.nodeType,
            memory.title,
            memory.generatedContent,
            memory.aliases,
            memory.tags,
            sourceId,
            JSON.stringify({ sourceMessageIds: memory.sourceMessageIds, confidence: memory.confidence }),
          ],
        );
        const nodeId = result.rows[0]!.id;
        nodeIds.set(`${memory.nodeType}:${memory.title.toLocaleLowerCase("pt-BR")}`, nodeId);
        for (const messageId of memory.sourceMessageIds) {
          await client.query(
            `INSERT INTO brain_node_sources
               (user_id,node_id,source_kind,source_id,title,excerpt,valid_from,valid_until,
                confidence,importance,metadata)
             VALUES ($1,$2,'whatsapp_message',$3,$4,$5,now(),$6,$7,$8,$9)
             ON CONFLICT (user_id,node_id,source_kind,source_id)
             DO UPDATE SET excerpt=EXCLUDED.excerpt,valid_until=EXCLUDED.valid_until,
               confidence=EXCLUDED.confidence,importance=EXCLUDED.importance,
               metadata=brain_node_sources.metadata || EXCLUDED.metadata`,
            [userId, nodeId, messageId, memory.title, memory.generatedContent.slice(0, 2_000),
              memory.expiresAt, memory.confidence,
              ["decision", "task", "project"].includes(memory.nodeType) ? 4 : 3,
              JSON.stringify({ generatedBy: "atlas-ai", evidenceMessageId: messageId })],
          );
        }
        await client.query(
          `UPDATE whatsapp_messages SET brain_node_id=$2
           WHERE user_id=$1 AND external_message_id=ANY($3::text[]) AND brain_node_id IS NULL`,
          [userId, nodeId, memory.sourceMessageIds],
        );
        changed += 1;
      }
      for (const memory of memories) {
        const fromId = nodeIds.get(`${memory.nodeType}:${memory.title.toLocaleLowerCase("pt-BR")}`);
        if (!fromId) continue;
        for (const relation of memory.relations) {
          const target = await client.query<IdRow>(
            `SELECT id FROM brain_nodes WHERE user_id = $1 AND type = $2
             AND lower(title) = lower($3) LIMIT 1`,
            [userId, relation.targetNodeType, relation.targetTitle],
          );
          const targetId = target.rows[0]?.id;
          if (!targetId || targetId === fromId) continue;
          await client.query(
            `INSERT INTO brain_edges
               (user_id, from_node_id, to_node_id, relation_type, weight, provenance)
             VALUES ($1, $2, $3, $4, $5, 'ai')
             ON CONFLICT (user_id, from_node_id, to_node_id, relation_type)
             DO UPDATE SET weight = EXCLUDED.weight, provenance = 'ai'`,
            [userId, fromId, targetId, relation.type, relation.confidence],
          );
        }
      }
    });
    if (changed > 0) {
      await this.publishEvent(userId, "brain.memory.updated", { count: changed }, "ai");
    }
  }

  async recipientJid(userId: string): Promise<string> {
    const result = await this.database.query<{ self_jid: string }>(
      `SELECT self_jid FROM whatsapp_connections
       WHERE user_id=$1 AND self_jid IS NOT NULL
       ORDER BY (status='connected') DESC,updated_at DESC LIMIT 1`,
      [userId],
    );
    const phone = result.rows[0] ? normalizeBrazilianPhone(result.rows[0].self_jid) : null;
    if (!phone) throw new Error(`No Brazilian WhatsApp recipient registered for user ${userId}`);
    return phone.jid;
  }

  async findUserByWhatsappJid(jid: string): Promise<string | null> {
    const phone = normalizeBrazilianPhone(jid);
    if (!phone) return null;
    const result = await this.database.query<{ user_id: string }>(
      `SELECT user_id FROM whatsapp_connections
       WHERE self_jid=$1
       ORDER BY (status='connected') DESC,updated_at DESC LIMIT 1`,
      [phone.jid],
    );
    return result.rows[0]?.user_id ?? null;
  }

  async enqueueWelcomeIfNeeded(userId: string): Promise<number> {
    const result = await this.database.query<{ preferred_name: string; welcome_message: string }>(
      `SELECT u.preferred_name,p.welcome_message FROM users u
       CROSS JOIN platform_whatsapp_connection p
       WHERE u.id=$1 AND p.singleton_key='mother'`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`Could not build welcome message for user ${userId}`);
    return this.enqueueNotification({
      userId,
      kind: "welcome",
      title: "Bem-vindo ao Atlas",
      body: row.welcome_message.replaceAll("{nome}", row.preferred_name),
    }, "platform-mother:welcome:v1");
  }

  async persistMotherMessage(message: NormalizedMessage): Promise<boolean> {
    const connectionId = await this.getConnectionId(message.userId);
    const result = await this.database.transaction(async (client) => {
      const audit = await client.query<IdRow>(
        `INSERT INTO platform_whatsapp_messages
           (user_id,external_message_id,chat_jid,sender_jid,direction,body,sent_at)
         VALUES ($1,$2,$3,$4,'inbound',$5,$6)
         ON CONFLICT (external_message_id) DO NOTHING RETURNING id`,
        [message.userId, message.id, message.chatJid, message.senderJid, message.text, message.sentAt],
      );
      if (audit.rowCount !== 1) return false;
      await client.query(
        `INSERT INTO whatsapp_messages
           (user_id,whatsapp_connection_id,monitored_chat_id,external_message_id,
            chat_jid,sender_jid,direction,from_me,message_type,body,sent_at)
         SELECT $1,$2,NULL,$3,$4,$5,'inbound',false,'text',$6,$7
         FROM whatsapp_connections
         WHERE id=$2 AND user_id=$1 AND self_jid=$4
         ON CONFLICT (user_id,whatsapp_connection_id,external_message_id) DO NOTHING`,
        [message.userId, connectionId, message.id, message.chatJid, message.senderJid, message.text, message.sentAt],
      );
      return true;
    });
    return result;
  }

  platformAuthRepository(): BaileysAuthRepository {
    return {
      get: async (_sessionKey, category, key) => {
        const result = await this.database.query<{ record_value: string }>(
          `SELECT record_value FROM platform_whatsapp_auth_records
           WHERE singleton_key='mother' AND category=$1 AND record_key=$2`,
          [category, key],
        );
        return result.rows[0]?.record_value ?? null;
      },
      set: async (_sessionKey, category, key, value) => {
        if (value === null) {
          await this.database.query(
            `DELETE FROM platform_whatsapp_auth_records
             WHERE singleton_key='mother' AND category=$1 AND record_key=$2`,
            [category, key],
          );
          return;
        }
        await this.database.query(
          `INSERT INTO platform_whatsapp_auth_records (singleton_key,category,record_key,record_value)
           VALUES ('mother',$1,$2,$3)
           ON CONFLICT (singleton_key,category,record_key)
           DO UPDATE SET record_value=EXCLUDED.record_value,updated_at=now()`,
          [category, key, value],
        );
      },
      clearUser: async () => {
        await this.database.query("DELETE FROM platform_whatsapp_auth_records WHERE singleton_key='mother'");
      },
    };
  }

  async platformWhatsappStatus(): Promise<ActiveWhatsappConnection["status"]> {
    const result = await this.database.query<{ status: ActiveWhatsappConnection["status"] }>(
      "SELECT status FROM platform_whatsapp_connection WHERE singleton_key='mother'",
    );
    return result.rows[0]?.status ?? "disconnected";
  }

  async updatePlatformWhatsappState(state:
    | { status: "pairing"; qrDataUrl: string }
    | { status: "connected"; selfJid: string }
    | { status: "reconnecting" | "disconnected" | "logged_out" }
    | { status: "error"; error: string }): Promise<void> {
    if (state.status === "pairing") {
      await this.database.query(
        `UPDATE platform_whatsapp_connection SET status='pairing',pairing_qr=$1,
           pairing_expires_at=now()+interval '2 minutes',last_error=NULL
         WHERE singleton_key='mother'`,
        [state.qrDataUrl],
      );
      return;
    }
    if (state.status === "connected") {
      const phone = normalizeBrazilianPhone(state.selfJid);
      if (!phone) throw new Error(`Could not identify the central Brazilian number from ${state.selfJid}`);
      await this.database.transaction(async (client) => {
        await client.query(
          `UPDATE platform_whatsapp_connection SET status='connected',phone_number=$1,self_jid=$2,
             pairing_qr=NULL,pairing_expires_at=NULL,last_connected_at=now(),last_error=NULL
           WHERE singleton_key='mother'`,
          [phone.formatted, phone.jid],
        );
        await client.query(
          `UPDATE notification_outbox SET status='pending',attempt_count=0,last_error=NULL,scheduled_at=now()
           WHERE channel='whatsapp' AND status='failed' AND sent_at IS NULL`,
        );
      });
      return;
    }
    await this.database.query(
      `UPDATE platform_whatsapp_connection SET status=$1,
         pairing_qr=CASE WHEN $1 IN ('logged_out','disconnected') THEN NULL ELSE pairing_qr END,
         last_error=$2 WHERE singleton_key='mother'`,
      [state.status, state.status === "error" ? state.error : null],
    );
  }

  async isSelfChat(userId: string, chatJid: string): Promise<boolean> {
    const result = await this.database.query<{ matches: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM whatsapp_connections
         WHERE user_id=$1 AND self_jid IS NOT NULL AND self_jid=$2
       ) AS matches`,
      [userId, chatJid],
    );
    return result.rows[0]?.matches ?? false;
  }

  async handleSelfCommand(
    userId: string,
    command: AtlasSelfCommand,
    evidenceId: string,
  ): Promise<SelfCommandHandling> {
    if (command.kind === "complete" || command.kind === "open" || command.kind === "explain") {
      const matches = await this.database.query<{
        id: string; title: string; priority: string; due_at: Date | null; metadata: Record<string, unknown>;
        url: string | null;
      }>(
        `SELECT t.id::text,t.title,t.priority,t.due_at,t.metadata,tc.url
         FROM canonical_tasks t
         LEFT JOIN task_trello_links ttl ON ttl.user_id=t.user_id AND ttl.task_id=t.id
         LEFT JOIN trello_cards tc ON tc.user_id=ttl.user_id AND tc.id=ttl.trello_card_id
         WHERE t.user_id=$1 AND t.status NOT IN ('done','cancelled','merged')
           AND ($2::text IS NULL OR t.id::text LIKE $2 || '%' OR similarity(t.title,$2)>0.18)
         ORDER BY CASE WHEN $2::text IS NOT NULL AND lower(t.title)=lower($2) THEN 0 ELSE 1 END,
                  CASE WHEN $2::text IS NULL THEN t.updated_at END DESC,
                  similarity(t.title,COALESCE($2,t.title)) DESC
         LIMIT $3`,
        [userId, command.reference, command.reference ? 2 : 1],
      );
      if (matches.rows.length === 0) {
        return { handled: true, notification: { kind: "needs_review", title: "Não encontrei a tarefa", body: "Diga o nome da tarefa para eu localizar com segurança." } };
      }
      if (matches.rows.length > 1) {
        return { handled: true, notification: { kind: "needs_review", title: "Qual tarefa?", body: matches.rows.map((row) => `• ${row.title}`).join("\n") } };
      }
      const match = matches.rows[0]!;
      if (command.kind === "complete") {
        const task = await this.getCanonicalTaskForSync(userId, match.id, "complete", evidenceId);
        if (task) {
          task.task.authorization = "explicit_user_command";
          task.task.authorizationMessageId = evidenceId;
          return { handled: true, task };
        }
      }
      if (command.kind === "open") {
        return { handled: true, notification: { kind: "task_updated", title: match.title, body: match.url ? "Cartão localizado." : "A tarefa ainda não possui cartão no Trello.", ...(match.url ? { links: [{ label: "Abrir no Trello", url: match.url }] } : {}) } };
      }
      const evidence = Array.isArray(match.metadata.evidenceMessageIds) ? match.metadata.evidenceMessageIds.length : 0;
      return { handled: true, notification: { kind: "task_updated", title: `Por que: ${match.title}`, body: `Prioridade ${match.priority}${match.due_at ? `, prazo ${match.due_at.toLocaleString("pt-BR")}` : ""}. Baseado em ${evidence} evidência(s) registrada(s).` } };
    }

    const reminders = await this.database.query<{ id: string; title: string }>(
      `SELECT id::text,title FROM reminders
       WHERE user_id=$1 AND status IN ('scheduled','sent','snoozed')
         AND ($2::text IS NULL OR id::text LIKE $2 || '%' OR similarity(title,$2)>0.18)
       ORDER BY CASE WHEN $2::text IS NULL THEN COALESCE(last_sent_at,scheduled_for,updated_at) END DESC,
                similarity(title,COALESCE($2,title)) DESC LIMIT $3`,
      [userId, command.reference, command.reference ? 2 : 1],
    );
    if (reminders.rows.length !== 1) {
      return { handled: true, notification: { kind: "needs_review", title: reminders.rows.length ? "Qual lembrete?" : "Lembrete não encontrado", body: reminders.rows.length ? reminders.rows.map((row) => `• ${row.title}`).join("\n") : "Diga o nome do lembrete." } };
    }
    const reminder = reminders.rows[0]!;
    if (command.kind === "silence") {
      await this.database.query(
        `UPDATE reminders SET status='cancelled',cancelled_at=now() WHERE id=$1 AND user_id=$2`,
        [reminder.id, userId],
      );
      await this.database.query(
        `UPDATE reminder_occurrences SET status='cancelled' WHERE reminder_id=$1 AND user_id=$2 AND status IN ('pending','failed','snoozed')`,
        [reminder.id, userId],
      );
      return { handled: true, notification: { kind: "reminder", title: "Lembrete silenciado", body: reminder.title } };
    }
    if (command.kind === "snooze" && command.durationMinutes) {
      await this.rescheduleReminder(userId, reminder.id, Math.min(command.durationMinutes, 525_600));
      return { handled: true, notification: { kind: "reminder", title: "Lembrete adiado", body: `${reminder.title} por ${command.durationMinutes} minutos.` } };
    }
    if (command.kind === "reschedule" && command.localTime) {
      await this.database.query(
        `WITH cancelled AS (
           UPDATE reminder_occurrences SET status='cancelled',locked_by=NULL,locked_at=NULL
           WHERE reminder_id=$1 AND user_id=$2 AND status IN ('pending','failed','snoozed')
           RETURNING id
         ), target AS (
           SELECT ((((now() AT TIME ZONE timezone)::date+1)+$3::time) AT TIME ZONE timezone) AS at
           FROM user_settings WHERE user_id=$2
         ), updated AS (
           UPDATE reminders SET status='scheduled',scheduled_for=target.at,last_sent_at=NULL FROM target
           WHERE id=$1 AND user_id=$2 RETURNING reminders.id,target.at
         )
         INSERT INTO reminder_occurrences (user_id,reminder_id,scheduled_at,deliver_after)
         SELECT $2,id,at,at FROM updated
         ON CONFLICT (user_id,reminder_id,scheduled_at) DO UPDATE SET
           deliver_after=EXCLUDED.deliver_after,status='pending',attempt_count=0,
           locked_by=NULL,locked_at=NULL,last_error=NULL`,
        [reminder.id, userId, command.localTime],
      );
      return { handled: true, notification: { kind: "reminder", title: "Lembrete reagendado", body: `${reminder.title} para amanhã às ${command.localTime}.` } };
    }
    return { handled: false };
  }

  private async rescheduleReminder(userId: string, reminderId: string, durationMinutes: number): Promise<void> {
    await this.database.query(
      `WITH cancelled AS (
         UPDATE reminder_occurrences SET status='cancelled',locked_by=NULL,locked_at=NULL
         WHERE reminder_id=$1 AND user_id=$2 AND status IN ('pending','failed','snoozed')
         RETURNING id
       ), updated AS (
         UPDATE reminders SET status='snoozed',scheduled_for=now()+make_interval(mins=>$3) WHERE id=$1 AND user_id=$2
         RETURNING id,scheduled_for
       )
       INSERT INTO reminder_occurrences (user_id,reminder_id,scheduled_at,deliver_after,status)
       SELECT $2,id,scheduled_for,scheduled_for,'snoozed' FROM updated
       ON CONFLICT (user_id,reminder_id,scheduled_at) DO UPDATE SET
         deliver_after=EXCLUDED.deliver_after,status='snoozed',attempt_count=0,
         locked_by=NULL,locked_at=NULL,last_error=NULL`,
      [reminderId, userId, durationMinutes],
    );
  }

  async prepareCanonicalTask(
    userId: string,
    task: AiTask,
  ): Promise<CanonicalTaskPreparation> {
    const fingerprint = makeCanonicalTaskFingerprint({
      userId,
      title: task.title,
      project: task.project,
      person: task.person,
      nextAction: task.nextAction,
    });
    return this.database.userTransaction(userId, async (client) => {
      const existing = await client.query<{
        id: string;
        trello_card_id: string | null;
        url: string | null;
        sync_status: string | null;
      }>(
        `SELECT ct.id::text, tc.trello_card_id, tc.url,ttl.sync_status
         FROM canonical_tasks ct
         LEFT JOIN task_trello_links ttl ON ttl.user_id=ct.user_id AND ttl.task_id=ct.id
         LEFT JOIN trello_cards tc ON tc.user_id=ttl.user_id AND tc.id=ttl.trello_card_id
         WHERE ct.user_id=$1 AND (
           ($2::uuid IS NOT NULL AND ct.id=$2::uuid)
           OR ($3::text IS NOT NULL AND tc.trello_card_id=$3)
           OR (ct.source_fingerprint=$4)
           OR (
             $2::uuid IS NULL AND $3::text IS NULL
             AND ct.status NOT IN ('done','cancelled','merged')
             AND GREATEST(
               similarity(lower(ct.title),lower($5)),
               word_similarity(lower(ct.title),lower($5)),
               word_similarity(lower($5),lower(ct.title))
             ) >= CASE WHEN length($5)>=18 THEN 0.46 ELSE 0.70 END
             AND ($6='' OR COALESCE(ct.metadata->>'project','')='' OR
               similarity(lower(ct.metadata->>'project'),lower($6))>=0.55)
             AND ($7='' OR COALESCE(ct.metadata->>'person','')='' OR
               similarity(lower(ct.metadata->>'person'),lower($7))>=0.55)
             AND ($8::timestamptz IS NULL OR ct.due_at IS NULL OR
               abs(extract(epoch FROM (ct.due_at-$8::timestamptz))) <= 604800)
           )
         )
         ORDER BY (ct.id=$2::uuid) DESC NULLS LAST,
           (tc.trello_card_id=$3) DESC NULLS LAST,(ct.source_fingerprint=$4) DESC,
           GREATEST(similarity(lower(ct.title),lower($5)),word_similarity(lower(ct.title),lower($5))) DESC,
           ct.updated_at DESC
         LIMIT 1 FOR UPDATE OF ct`,
        [userId, task.canonicalTaskId, task.candidateCardId, fingerprint, task.title,
          task.project ?? '', task.person ?? '', task.dueAt],
      );
      const found = existing.rows[0];
      if (found) {
        return {
          taskId: found.id,
          fingerprint,
          existingCardId: found.trello_card_id,
          existingCardUrl: found.url,
          syncConflict: found.sync_status === "conflict",
        };
      }
      const status = task.targetListRole === "inProgress" ? "in_progress" : task.targetListRole === "paused" ? "paused" : task.targetListRole === "inbox" ? "inbox" : "open";
      const inserted = await client.query<IdRow>(
        `INSERT INTO canonical_tasks
          (user_id,title,description,status,priority,risk,next_action,due_at,estimated_minutes,
           recurrence,expected_owner,source_fingerprint,confidence,metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (user_id,source_fingerprint) WHERE source_fingerprint IS NOT NULL
         DO UPDATE SET updated_at=now()
         RETURNING id::text`,
        [
          userId,
          task.title,
          task.description,
          status,
          task.priority === "normal" ? "medium" : task.priority,
          task.risk === "unknown" ? "low" : task.risk,
          task.nextAction,
          task.dueAt,
          task.estimateMinutes,
          task.recurrence ? JSON.stringify({ rule: task.recurrence }) : null,
          task.waitingOn,
          fingerprint,
          task.confidence,
          JSON.stringify({ evidenceMessageIds: task.evidenceMessageIds, project: task.project, person: task.person }),
        ],
      );
      return { taskId: inserted.rows[0]!.id, fingerprint, existingCardId: null, existingCardUrl: null, syncConflict: false };
    });
  }

  async getFallbackEnrichmentTarget(
    userId: string,
    canonicalTaskId: string,
  ): Promise<{ canonicalTaskId: string; cardId: string | null } | null> {
    const result = await this.database.query<{ task_id: string; card_id: string | null }>(
      `SELECT task.id::text AS task_id,card.trello_card_id AS card_id
       FROM canonical_tasks task
       LEFT JOIN task_trello_links link ON link.user_id=task.user_id AND link.task_id=task.id
         AND link.sync_status NOT IN ('detached','error')
       LEFT JOIN trello_cards card ON card.user_id=link.user_id AND card.id=link.trello_card_id
       WHERE task.user_id=$1 AND task.id=$2::uuid
       LIMIT 1`,
      [userId, canonicalTaskId],
    );
    const row = result.rows[0];
    return row ? { canonicalTaskId: row.task_id, cardId: row.card_id } : null;
  }

  async recordCanonicalTaskExecution(
    userId: string,
    taskId: string,
    task: AiTask,
    cardExternalId: string,
    executionKey: string,
    brainNodeId: string,
  ): Promise<void> {
    await this.database.userTransaction(userId, async (client) => {
      const status = task.operation === "complete" ? "done"
        : task.operation === "cancel" ? "cancelled"
          : task.targetListRole === "inProgress" ? "in_progress"
            : task.targetListRole === "paused" ? "paused"
              : task.targetListRole === "inbox" ? "inbox" : "open";
      await client.query(
        `UPDATE canonical_tasks SET title=$3, description=$4, status=$5, priority=$6,
           risk=$7, next_action=$8, due_at=$9, estimated_minutes=$10,
           recurrence=$11, expected_owner=$12, confidence=$13, version=version+1,
           completed_at=CASE WHEN $5='done' THEN now() WHEN $5<>'done' THEN NULL ELSE completed_at END,
           cancelled_at=CASE WHEN $5='cancelled' THEN now() WHEN $5<>'cancelled' THEN NULL ELSE cancelled_at END,
           metadata=metadata || $14::jsonb,
           brain_node_id=COALESCE(brain_node_id,$15::uuid)
         WHERE user_id=$1 AND id=$2`,
        [userId, taskId, task.title, task.description, status,
          task.priority === "normal" ? "medium" : task.priority,
          task.risk === "unknown" ? "low" : task.risk, task.nextAction, task.dueAt,
          task.estimateMinutes, task.recurrence ? JSON.stringify({ rule: task.recurrence }) : null,
          task.waitingOn, task.confidence,
          JSON.stringify({
            evidenceMessageIds: task.evidenceMessageIds,
            project: task.project,
            person: task.person,
            authorization: task.authorization,
            labels: task.labels,
            atlasMemberIds: task.memberIdsToAdd ?? [],
          }),
          brainNodeId],
      );
      const linked = await client.query<{ id: string }>(
        `SELECT id::text FROM trello_cards WHERE user_id=$1 AND trello_card_id=$2`,
        [userId, cardExternalId],
      );
      if (linked.rows[0]) {
        await client.query(
          `INSERT INTO task_trello_links
            (user_id,task_id,trello_card_id,sync_status,atlas_section_marker,last_synced_at,metadata)
           VALUES ($1,$2,$3::uuid,'synced','Atlas',now(),$4)
           ON CONFLICT (user_id,task_id) DO UPDATE SET trello_card_id=EXCLUDED.trello_card_id,
             sync_status='synced',atlas_revision=task_trello_links.atlas_revision+1,last_synced_at=now(),last_error=NULL`,
          [userId, taskId, linked.rows[0].id, JSON.stringify({ externalCardId: cardExternalId })],
        );
      }
      await client.query(
        `WITH event AS (
           INSERT INTO task_events (user_id,task_id,event_type,actor_type,idempotency_key,payload)
           VALUES ($1,$2,$3,'atlas',$4,$5)
           ON CONFLICT (user_id,task_id,idempotency_key) DO NOTHING
           RETURNING task_id
         )
         INSERT INTO assistant_action_outcomes (user_id,task_id,action_type,outcome,score,context)
         SELECT $1,task_id,$3,'completed',1,
           jsonb_build_object('executionKey',$4,'externalCardId',$6)
         FROM event`,
        [userId, taskId, task.operation, executionKey,
          JSON.stringify({ cardExternalId, evidenceMessageIds: task.evidenceMessageIds }), cardExternalId],
      );
      if (task.operation === "merge" && task.mergeSourceCardIds.length) {
        await client.query(
          `WITH sources AS (
             SELECT link.task_id FROM task_trello_links link
             JOIN trello_cards card ON card.user_id=link.user_id AND card.id=link.trello_card_id
             WHERE link.user_id=$1 AND card.trello_card_id=ANY($3::text[])
           )
           UPDATE reminders SET task_id=$2
           WHERE user_id=$1 AND task_id IN (SELECT task_id FROM sources)`,
          [userId, taskId, task.mergeSourceCardIds],
        );
        await client.query(
          `WITH sources AS (
             SELECT link.task_id FROM task_trello_links link
             JOIN trello_cards card ON card.user_id=link.user_id AND card.id=link.trello_card_id
             WHERE link.user_id=$1 AND card.trello_card_id=ANY($3::text[])
           )
           UPDATE commitments SET task_id=$2
           WHERE user_id=$1 AND task_id IN (SELECT task_id FROM sources)`,
          [userId, taskId, task.mergeSourceCardIds],
        );
        await client.query(
          `UPDATE brain_nodes node SET status='archived',
             metadata=metadata || jsonb_build_object('mergedIntoTaskId',$2)
           FROM canonical_tasks source,task_trello_links link,trello_cards card
           WHERE source.user_id=$1 AND node.user_id=source.user_id AND node.id=source.brain_node_id
             AND link.user_id=source.user_id AND link.task_id=source.id
             AND card.user_id=link.user_id AND card.id=link.trello_card_id
             AND card.trello_card_id=ANY($3::text[])`,
          [userId, taskId, task.mergeSourceCardIds],
        );
        await client.query(
          `UPDATE task_trello_links link SET sync_status='detached',
             metadata=metadata || jsonb_build_object('mergedIntoTaskId',$2,'detachedAt',now())
           FROM trello_cards card
           WHERE link.user_id=$1 AND card.user_id=link.user_id AND card.id=link.trello_card_id
             AND card.trello_card_id=ANY($3::text[])`,
          [userId, taskId, task.mergeSourceCardIds],
        );
        await client.query(
          `UPDATE canonical_tasks source SET status='merged',merged_into_task_id=$2,version=version+1
           FROM task_trello_links link JOIN trello_cards card
             ON card.user_id=link.user_id AND card.id=link.trello_card_id
           WHERE source.user_id=$1 AND source.id=link.task_id
             AND card.trello_card_id = ANY($3::text[])`,
          [userId, taskId, task.mergeSourceCardIds],
        );
      }
    });
    if (task.dueAt && !["complete", "cancel", "merge"].includes(task.operation)) {
      await this.ensureTaskDueReminders(userId, taskId, task);
    }
  }

  private async ensureTaskDueReminders(userId: string, taskId: string, task: AiTask): Promise<void> {
    const offsets = task.priority === "urgent" ? [["urgent_24h", 1440], ["due_2h", 120]] as const : [["due_2h", 120]] as const;
    for (const [kind, offset] of offsets) {
      const dedupe = `task:${taskId}:${kind}:${task.dueAt}`;
      await this.database.query(
        `WITH settings AS (
           SELECT timezone,quiet_start,quiet_end FROM user_settings WHERE user_id=$1
         ), inserted AS (
           INSERT INTO reminders
             (user_id,task_id,kind,schedule_type,title,message,scheduled_for,priority,respect_quiet_hours,dedupe_key)
           VALUES ($1,$2,$3,'due',$4,$5,$6::timestamptz-make_interval(mins=>$7),
             CASE WHEN $3='urgent_24h' THEN 1 ELSE 3 END,true,$8)
           ON CONFLICT (user_id,dedupe_key) WHERE dedupe_key IS NOT NULL
           DO UPDATE SET title=EXCLUDED.title,message=EXCLUDED.message,status='scheduled',scheduled_for=EXCLUDED.scheduled_for
           RETURNING id,scheduled_for
         ), timing AS (
           SELECT i.id,i.scheduled_for,s.*,
             i.scheduled_for AT TIME ZONE s.timezone AS local_at
           FROM inserted i CROSS JOIN settings s
         )
         INSERT INTO reminder_occurrences (user_id,reminder_id,scheduled_at,deliver_after)
         SELECT $1,id,scheduled_for,
           CASE
             WHEN quiet_start < quiet_end
               AND local_at::time >= quiet_start AND local_at::time < quiet_end
               THEN (local_at::date+quiet_end) AT TIME ZONE timezone
             WHEN quiet_start > quiet_end AND local_at::time >= quiet_start
               THEN ((local_at::date+1)+quiet_end) AT TIME ZONE timezone
             WHEN quiet_start > quiet_end AND local_at::time < quiet_end
               THEN (local_at::date+quiet_end) AT TIME ZONE timezone
             ELSE scheduled_for END
         FROM timing
         ON CONFLICT (user_id,reminder_id,scheduled_at) DO NOTHING`,
        [userId, taskId, kind, task.title, `Lembrete de prazo: ${task.title}`, task.dueAt, offset, dedupe],
      );
    }
  }

  async persistDecisionArtifacts(userId: string, decision: AiDecision, batchKey: string, context?: AiContext): Promise<void> {
    await this.persistCommitments(userId, decision.commitments, batchKey, context);
    await this.persistReminders(userId, decision.reminders, batchKey);
    await this.persistLearnings(userId, decision.learnings, batchKey);
    await this.persistActionProposals(userId, decision.actionProposals, batchKey);
  }

  private async persistCommitments(userId: string, commitments: readonly AiCommitment[], batchKey: string, context?: AiContext): Promise<void> {
    for (const item of commitments.filter((value) => value.confidence >= 0.7)) {
      if (!canExecuteCommitmentMutation(item, context)) {
        await this.database.query(
          `INSERT INTO action_proposals
             (user_id,proposal_type,title,risk,reversible,requires_confirmation,
              proposed_payload,evidence,idempotency_key)
           VALUES ($1,'commitment_change',$2,'destructive',false,true,$3,$4,$5)
           ON CONFLICT (user_id,idempotency_key) DO NOTHING`,
          [userId, item.title, JSON.stringify(item), JSON.stringify(item.evidenceMessageIds),
            `${batchKey}:commitment-proposal:${item.clientRef}`],
        );
        continue;
      }
      const fingerprint = makeCanonicalTaskFingerprint({
        userId, title: item.title, person: item.counterparty, project: item.direction,
      });
      const saved = await this.database.userTransaction(userId, async (client) => {
        if (item.operation !== "create") {
          const status = item.operation === "fulfill" ? "fulfilled"
            : item.operation === "cancel" ? "cancelled"
              : item.operation === "reopen" ? "open" : null;
          const updated = await client.query<{ id: string; status: string; due_at: Date | null }>(
            `UPDATE commitments SET title=$3,direction=$4,counterpart_name=$5,
               due_at=CASE WHEN $6::timestamptz IS NOT NULL THEN $6 ELSE due_at END,
               next_follow_up_at=CASE WHEN $7::timestamptz IS NOT NULL THEN $7 ELSE next_follow_up_at END,
               status=COALESCE($8,status),
               fulfilled_at=CASE WHEN $8='fulfilled' THEN now()
                 WHEN $8 IN ('open','cancelled') THEN NULL ELSE fulfilled_at END,
               confidence=GREATEST(COALESCE(confidence,0),$9),
               metadata=metadata || $10::jsonb,updated_at=now()
             WHERE id=$1::uuid AND user_id=$2
             RETURNING id::text,status,due_at`,
            [item.commitmentId, userId, item.title, item.direction, item.counterparty,
              item.dueAt, item.nextFollowUpAt, status, item.confidence,
              JSON.stringify({ batchKey, evidenceMessageIds: item.evidenceMessageIds, lastOperation: item.operation })],
          );
          if (!updated.rows[0]) return null;
          if (["fulfilled", "cancelled"].includes(updated.rows[0].status)) {
            await client.query(
              `UPDATE reminders SET status='cancelled',cancelled_at=now()
               WHERE user_id=$1 AND commitment_id=$2 AND status IN ('scheduled','snoozed')`,
              [userId, updated.rows[0].id],
            );
            await client.query(
              `UPDATE reminder_occurrences SET status='cancelled',locked_by=NULL,locked_at=NULL
               WHERE user_id=$1 AND reminder_id IN
                 (SELECT id FROM reminders WHERE user_id=$1 AND commitment_id=$2)
                 AND status IN ('pending','failed','snoozed')`,
              [userId, updated.rows[0].id],
            );
          }
          return updated.rows[0];
        }

        const active = await client.query<{ id: string; status: string; due_at: Date | null }>(
          `UPDATE commitments SET due_at=COALESCE($3,due_at),
             next_follow_up_at=COALESCE($4,next_follow_up_at),
             confidence=GREATEST(COALESCE(confidence,0),$5),
             metadata=metadata || $6::jsonb,updated_at=now()
           WHERE user_id=$1 AND source_fingerprint=$2 AND status IN ('open','waiting')
           RETURNING id::text,status,due_at`,
          [userId, fingerprint, item.dueAt, item.nextFollowUpAt, item.confidence,
            JSON.stringify({ batchKey, evidenceMessageIds: item.evidenceMessageIds })],
        );
        if (active.rows[0]) return active.rows[0];

        const insertFingerprint = await client.query(
          `SELECT 1 FROM commitments WHERE user_id=$1 AND source_fingerprint=$2 LIMIT 1`,
          [userId, fingerprint],
        ).then((result) => result.rows[0] ? `${fingerprint}:${batchKey}` : fingerprint);
        const inserted = await client.query<{ id: string; status: string; due_at: Date | null }>(
          `INSERT INTO commitments
             (user_id,direction,title,counterpart_name,due_at,next_follow_up_at,
              source_fingerprint,confidence,metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (user_id,source_fingerprint) WHERE source_fingerprint IS NOT NULL
           DO UPDATE SET updated_at=now()
           RETURNING id::text,status,due_at`,
          [userId, item.direction, item.title, item.counterparty, item.dueAt,
            item.nextFollowUpAt, insertFingerprint, item.confidence,
            JSON.stringify({ batchKey, evidenceMessageIds: item.evidenceMessageIds })],
        );
        return inserted.rows[0] ?? null;
      });

      if (saved?.due_at && ["open", "waiting"].includes(saved.status)) {
        const dueIso = new Date(saved.due_at).toISOString();
        const scheduledAt = new Date(new Date(saved.due_at).getTime() - 2 * 60 * 60 * 1_000);
        const dedupeKey = `commitment:${saved.id}:due_2h:${dueIso}`;
        await this.database.query(
          `WITH reminder AS (
             INSERT INTO reminders
               (user_id,commitment_id,kind,schedule_type,title,message,scheduled_for,priority,respect_quiet_hours,dedupe_key)
             VALUES ($1,$2,'commitment_due','relative',$3,$4,$5,2,true,$6)
             ON CONFLICT (user_id,dedupe_key) WHERE dedupe_key IS NOT NULL
             DO UPDATE SET title=EXCLUDED.title,message=EXCLUDED.message,scheduled_for=EXCLUDED.scheduled_for,status='scheduled'
             RETURNING id,scheduled_for
           )
           INSERT INTO reminder_occurrences (user_id,reminder_id,scheduled_at,deliver_after)
           SELECT $1,id,scheduled_for,scheduled_for FROM reminder ON CONFLICT DO NOTHING`,
          [userId, saved.id, item.title, `Compromisso próximo do prazo: ${item.title}`, scheduledAt, dedupeKey],
        );
      }
    }
  }

  private async persistReminders(userId: string, reminders: readonly AiReminder[], batchKey: string): Promise<void> {
    for (const item of reminders.filter((value) => value.confidence >= 0.7)) {
      const dedupe = `${batchKey}:reminder:${item.clientRef}`;
      await this.database.query(
        `WITH reminder AS (
           INSERT INTO reminders
             (user_id,kind,schedule_type,title,message,scheduled_for,recurrence,dedupe_key,metadata)
           VALUES ($1,'custom',CASE WHEN $5::text IS NULL THEN 'absolute' ELSE 'recurring' END,$2,$2,$3,$5,$4,$6)
           ON CONFLICT (user_id,dedupe_key) WHERE dedupe_key IS NOT NULL DO UPDATE SET updated_at=now()
           RETURNING id,scheduled_for
         )
         INSERT INTO reminder_occurrences (user_id,reminder_id,scheduled_at,deliver_after)
         SELECT $1,id,scheduled_for,scheduled_for FROM reminder WHERE scheduled_for IS NOT NULL
         ON CONFLICT (user_id,reminder_id,scheduled_at) DO NOTHING`,
        [userId, item.title, item.scheduledAt, dedupe, item.recurrence ? JSON.stringify({ rule: item.recurrence }) : null,
          JSON.stringify({ batchKey, taskClientRef: item.taskClientRef, evidenceMessageIds: item.evidenceMessageIds })],
      );
    }
  }

  async linkBatchRemindersToTask(
    userId: string,
    batchKey: string,
    taskClientRef: string,
    taskId: string,
  ): Promise<number> {
    const result = await this.database.query(
      `UPDATE reminders SET task_id=$4
       WHERE user_id=$1 AND task_id IS NULL
         AND metadata->>'batchKey'=$2 AND metadata->>'taskClientRef'=$3`,
      [userId, batchKey, taskClientRef, taskId],
    );
    return result.rowCount ?? 0;
  }

  private async persistLearnings(userId: string, learnings: readonly AiLearning[], batchKey: string): Promise<void> {
    for (const item of learnings) {
      const learningKey = makeCanonicalTaskFingerprint({ userId, title: item.statement, project: item.scope, person: item.scopeRef });
      await this.database.userTransaction(userId, async (client) => {
        type LearningRow = IdRow & { source_type: "explicit" | "inferred"; version: number; state: string };
        let current = await client.query<LearningRow>(
          `SELECT id::text,source_type,version,state FROM assistant_learnings
           WHERE user_id=$1 AND scope_type=$2 AND scope_id IS NOT DISTINCT FROM $3 AND learning_key=$4
             AND state NOT IN ('forgotten','superseded') ORDER BY version DESC LIMIT 1 FOR UPDATE`,
          [userId, item.scope, item.scopeRef, learningKey],
        );
        if (!current.rows[0]) {
          current = await client.query<LearningRow>(
            `INSERT INTO assistant_learnings
              (user_id,scope_type,scope_id,learning_key,statement,source_type,state,confidence,requires_confirmation,metadata)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             RETURNING id::text,source_type,version,state`,
            [userId, item.scope, item.scopeRef, learningKey, item.statement,
              item.explicitInstruction ? "explicit" : "inferred",
              item.explicitInstruction && item.risk === "low" ? "active" : "suggested", item.confidence,
              !item.explicitInstruction || item.risk === "high", JSON.stringify({ risk: item.risk, batchKey })],
          );
        } else if (item.explicitInstruction && current.rows[0].source_type === "inferred") {
          const inferred = current.rows[0];
          await client.query(
            `UPDATE assistant_learnings SET state='superseded'
             WHERE id=$1 AND user_id=$2`,
            [inferred.id, userId],
          );
          current = await client.query<LearningRow>(
            `INSERT INTO assistant_learnings
              (user_id,supersedes_learning_id,scope_type,scope_id,learning_key,statement,
               source_type,state,confidence,requires_confirmation,version,metadata)
             VALUES ($1,$2,$3,$4,$5,$6,'explicit',$7,$8,$9,$10,$11)
             RETURNING id::text,source_type,version,state`,
            [
              userId,
              inferred.id,
              item.scope,
              item.scopeRef,
              learningKey,
              item.statement,
              item.risk === "low" ? "active" : "suggested",
              item.confidence,
              item.risk === "high",
              inferred.version + 1,
              JSON.stringify({ risk: item.risk, batchKey, promotedFromLearningId: inferred.id }),
            ],
          );
        }
        const learningId = current.rows[0]!.id;
        for (const messageId of item.evidenceMessageIds) {
          await client.query(
            `INSERT INTO assistant_learning_evidence
              (user_id,learning_id,evidence_type,source_id,excerpt,weight,metadata)
             VALUES ($1,$2,'whatsapp_message',$3,$4,$5,$6)
             ON CONFLICT (user_id,learning_id,evidence_type,source_id) DO NOTHING`,
            [userId, learningId, messageId, item.statement.slice(0, 500), item.confidence, JSON.stringify({ batchKey })],
          );
        }
        const evidence = await client.query<{ id: string; observed_at: Date; weight: number }>(
          `SELECT id::text,observed_at,weight::float FROM assistant_learning_evidence WHERE user_id=$1 AND learning_id=$2`,
          [userId, learningId],
        );
        const activate = shouldActivateLearning({
          explicitInstruction: item.explicitInstruction,
          risk: item.risk,
          confidence: item.confidence,
          evidence: evidence.rows.map((row) => ({ id: row.id, occurredAt: row.observed_at.toISOString(), confidence: row.weight })),
        });
        await client.query(
          `UPDATE assistant_learnings SET statement=$3,confidence=GREATEST(confidence,$4),
             evidence_count=$5,distinct_evidence_days=$6,
             state=CASE WHEN $7 THEN 'active' ELSE state END,
             requires_confirmation=CASE WHEN $7 THEN false ELSE requires_confirmation END,
             activated_at=CASE WHEN $7 THEN COALESCE(activated_at,now()) ELSE activated_at END,
             review_after=CASE WHEN $7 AND source_type='inferred' THEN now()+interval '90 days' ELSE review_after END,
             last_evidence_at=now(),first_evidence_at=COALESCE(first_evidence_at,now())
           WHERE user_id=$1 AND id=$2`,
          [userId, learningId, item.statement, item.confidence, evidence.rows.length,
            new Set(evidence.rows.map((row) => row.observed_at.toISOString().slice(0, 10))).size,
            activate && item.risk === "low"],
        );
      });
    }
  }

  private async persistActionProposals(userId: string, proposals: readonly ActionProposal[], batchKey: string): Promise<void> {
    for (const proposal of proposals) {
      await this.database.userTransaction(userId, async (client) => {
        const alwaysForbidden = /profile|permission|recipient|external|send/i.test(proposal.kind);
        const alwaysRule = proposal.reversible && !alwaysForbidden
          ? await client.query<IdRow>(
              `SELECT id::text FROM assistant_learnings
               WHERE user_id=$1 AND scope_type='global' AND scope_id IS NULL
                 AND learning_key=$2 AND source_type='explicit' AND state='active'
                 AND requires_confirmation=false
               ORDER BY version DESC LIMIT 1`,
              [userId, `proposal:${proposal.kind}:always`],
            )
          : { rows: [] as IdRow[] };
        const learningId = alwaysRule.rows[0]?.id ?? null;
        const inserted = await client.query<{ id: string; status: string }>(
          `INSERT INTO action_proposals
            (user_id,proposal_type,title,status,risk,reversible,requires_confirmation,
             proposed_payload,evidence,idempotency_key,confirmed_at,metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
             CASE WHEN $4='confirmed' THEN now() ELSE NULL END,$11)
           ON CONFLICT (user_id,idempotency_key) DO UPDATE SET updated_at=now()
           RETURNING id::text,status`,
          [
            userId,
            proposal.kind,
            proposal.title,
            learningId ? "confirmed" : "pending",
            proposal.reversible && !alwaysForbidden ? "medium" : alwaysForbidden ? "high" : "destructive",
            proposal.reversible,
            learningId === null,
            JSON.stringify({ targetIds: proposal.targetIds, clientRef: proposal.clientRef }),
            JSON.stringify(proposal.evidenceMessageIds),
            `${batchKey}:proposal:${proposal.clientRef}`,
            JSON.stringify(learningId ? { alwaysLearningId: learningId, autoConfirmed: true } : {}),
          ],
        );
        if (learningId && inserted.rows[0]?.status === "confirmed") {
          await client.query(
            `INSERT INTO job_attempts (user_id,job_type,job_key,status,input)
             VALUES ($1,'action_proposal:execute',$2,'queued',$3)
             ON CONFLICT (user_id,job_type,job_key,attempt) DO NOTHING`,
            [
              userId,
              `proposal:${inserted.rows[0].id}`,
              JSON.stringify({ proposalId: inserted.rows[0].id, confirmedByLearningId: learningId, always: true }),
            ],
          );
        }
      });
    }
  }

  async createTaskActionProposal(userId: string, task: AiTask, batchKey: string): Promise<void> {
    await this.database.query(
      `INSERT INTO action_proposals
        (user_id,proposal_type,title,risk,reversible,requires_confirmation,proposed_payload,evidence,idempotency_key)
       VALUES ($1,$2,$3,'destructive',false,true,$4,$5,$6)
       ON CONFLICT (user_id,idempotency_key) DO NOTHING`,
      [userId, `${task.operation}_task`, task.title, JSON.stringify(task), JSON.stringify(task.evidenceMessageIds), `${batchKey}:task-proposal:${task.clientRef}`],
    );
  }

  private async getAllowedTrelloMemberIds(userId: string): Promise<string[]> {
    const result = await this.database.query<{ member_id: string }>(
      `SELECT DISTINCT member_id FROM (
         SELECT member_id FROM trello_connections
         WHERE user_id=$1 AND status='connected' AND member_id IS NOT NULL
         UNION ALL
         SELECT member->>'id' AS member_id
         FROM trello_connections tc
         CROSS JOIN LATERAL jsonb_array_elements(COALESCE(tc.metadata->'boardMembers','[]'::jsonb)) member
         WHERE tc.user_id=$1 AND tc.status='connected'
       ) allowed WHERE member_id IS NOT NULL AND btrim(member_id)<>''`,
      [userId],
    );
    return result.rows.map((row) => row.member_id);
  }

  async getCanonicalTaskForSync(
    userId: string,
    taskId: string,
    requestedAction?: string | null,
    evidenceId = `confirmed:${taskId}`,
    comment?: string | null,
  ): Promise<CanonicalTaskForSync | null> {
    const result = await this.database.query<{
      id: string; title: string; description: string; status: string; priority: string; risk: string;
      next_action: string | null; due_at: Date | null; estimated_minutes: number | null;
      recurrence: Record<string, unknown> | null; expected_owner: string | null; confidence: number | null;
      metadata: Record<string, unknown>; trello_card_id: string | null;
    }>(
      `SELECT t.id::text,t.title,t.description,t.status,t.priority,t.risk,t.next_action,t.due_at,
              t.estimated_minutes,t.recurrence,t.expected_owner,t.confidence::float,t.metadata,tc.trello_card_id
       FROM canonical_tasks t
       LEFT JOIN task_trello_links ttl ON ttl.user_id=t.user_id AND ttl.task_id=t.id
       LEFT JOIN trello_cards tc ON tc.user_id=ttl.user_id AND tc.id=ttl.trello_card_id
       WHERE t.user_id=$1 AND t.id=$2`,
      [userId, taskId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const normalizedAction = (requestedAction ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("pt-BR");
    const operation: AiTask["operation"] = !row.trello_card_id ? "create"
      : /conclu|complete|done/.test(normalizedAction) || row.status === "done" ? "complete"
        : /cancel|mescl|merge/.test(normalizedAction) || ["cancelled", "merged"].includes(row.status) ? "cancel"
          : /reabr|reopen/.test(normalizedAction) ? "reopen"
            : /comment/.test(normalizedAction) ? "comment" : "patch";
    const metadata = row.metadata ?? {};
    const labels = Array.isArray(metadata.labels) ? metadata.labels.filter((value): value is string => typeof value === "string") : [];
    const currentListRole: AiTask["targetListRole"] = row.status === "in_progress" ? "inProgress" : row.status === "paused" ? "paused" : row.status === "done" ? "done" : "inbox";
    const targetListRole: AiTask["targetListRole"] = operation === "reopen" && currentListRole === "done" ? "inbox" : currentListRole;
    const task: AiTask = {
      clientRef: `canonical-${row.id}`,
      operation,
      authorization: "confirmed_proposal",
      authorizationMessageId: evidenceId,
      canonicalTaskId: row.id,
      candidateCardId: row.trello_card_id,
      mergeSourceCardIds: [],
      title: row.title,
      description: operation === "comment" && comment ? comment.slice(0, 8_000) : row.description,
      priority: row.priority === "medium" ? "normal" : row.priority as AiTask["priority"],
      targetListRole,
      nextAction: row.next_action,
      waitingOn: row.expected_owner,
      risk: row.risk as AiTask["risk"],
      checklist: [],
      dueAt: row.due_at?.toISOString() ?? null,
      dueBasis: row.due_at ? "explicit" : "none",
      labels,
      labelsToRemove: [],
      memberIdsToAdd: [],
      memberIdsToRemove: [],
      project: typeof metadata.project === "string" ? metadata.project : null,
      person: typeof metadata.person === "string" ? metadata.person : null,
      estimateMinutes: row.estimated_minutes,
      recurrence: typeof row.recurrence?.rule === "string" ? row.recurrence.rule : null,
      confidence: row.confidence ?? 1,
      evidenceMessageIds: [evidenceId],
      missingInformation: [],
    };
    return {
      task,
      allowedCandidateCardIds: row.trello_card_id ? [row.trello_card_id] : [],
      allowedMemberIds: await this.getAllowedTrelloMemberIds(userId),
    };
  }

  async dispatchConfirmedProposal(userId: string, proposalId: string): Promise<ConfirmedProposalDispatch | null> {
    const result = await this.database.query<{
      proposal_type: string;
      proposed_payload: Record<string, unknown>;
      edited_payload: Record<string, unknown> | null;
    }>(
      `UPDATE action_proposals SET status='executing',error_message=NULL
       WHERE id=$1 AND user_id=$2 AND status='confirmed'
       RETURNING proposal_type,proposed_payload,edited_payload`,
      [proposalId, userId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const payload = { ...row.proposed_payload, ...(row.edited_payload ?? {}) };

    if (row.proposal_type === "create_task" && typeof payload.title === "string") {
      return { kind: "trello", prepared: {
        task: {
          clientRef: `proposal-${proposalId}`, operation: "create",
          authorization: "confirmed_proposal", authorizationMessageId: `proposal:${proposalId}`,
          canonicalTaskId: null, candidateCardId: null, mergeSourceCardIds: [],
          title: payload.title.slice(0, 180),
          description: typeof payload.description === "string" ? payload.description.slice(0, 8_000) : "",
          priority: "normal", targetListRole: "inbox", nextAction: null, waitingOn: null, risk: "low",
          checklist: [], dueAt: null, dueBasis: "none", labels: [], labelsToRemove: [],
          memberIdsToAdd: [], memberIdsToRemove: [],
          project: null, person: null, estimateMinutes: null, recurrence: null, confidence: 1,
          evidenceMessageIds: [`proposal:${proposalId}`], missingInformation: [],
        },
        allowedCandidateCardIds: [],
        allowedMemberIds: await this.getAllowedTrelloMemberIds(userId),
      } };
    }

    if (row.proposal_type === "create_reminder") {
      return this.executeConfirmedReminderProposal(userId, proposalId, payload);
    }
    if (row.proposal_type === "commitment_change") {
      const parsed = aiCommitmentSchema.safeParse({
        ...payload, authorization: "confirmed_proposal", authorizationMessageId: `proposal:${proposalId}`,
      });
      if (!parsed.success || !parsed.data.commitmentId || !["fulfill", "cancel"].includes(parsed.data.operation)) {
        return this.markProposalEditRequired(userId, proposalId, "A alteração de compromisso não contém um destino válido.");
      }
      const status = parsed.data.operation === "fulfill" ? "fulfilled" : "cancelled";
      const updated = await this.database.query(
        `UPDATE commitments SET status=$3,fulfilled_at=CASE WHEN $3='fulfilled' THEN now() ELSE NULL END,
           metadata=metadata || $4::jsonb,updated_at=now() WHERE id=$1::uuid AND user_id=$2`,
        [parsed.data.commitmentId, userId, status,
          JSON.stringify({ confirmedProposalId: proposalId, evidenceMessageIds: parsed.data.evidenceMessageIds })],
      );
      if (!updated.rowCount) {
        return this.markProposalEditRequired(userId, proposalId, "O compromisso não existe mais nesta conta.");
      }
      await this.database.query(
        `UPDATE reminders SET status='cancelled',cancelled_at=now()
         WHERE user_id=$1 AND commitment_id=$2 AND status IN ('scheduled','snoozed')`,
        [userId, parsed.data.commitmentId],
      );
      await this.markProposalExecution(userId, proposalId, true);
      return { kind: "completed" };
    }
    if (row.proposal_type === "profile_change") {
      const applied = await this.applyConfirmedProfileChange(userId, payload);
      if (applied) {
        await this.markProposalExecution(userId, proposalId, true);
        return { kind: "completed" };
      }
      return this.markProposalEditRequired(userId, proposalId, "A proposta de perfil não contém campos permitidos válidos.");
    }

    const embeddedTask = aiTaskSchema.safeParse(payload);
    if (embeddedTask.success && /_task$/.test(row.proposal_type)) {
      const task: AiTask = {
        ...embeddedTask.data,
        authorization: "confirmed_proposal",
        authorizationMessageId: `proposal:${proposalId}`,
        evidenceMessageIds: [...new Set([...embeddedTask.data.evidenceMessageIds, `proposal:${proposalId}`])],
      };
      return { kind: "trello", prepared: {
        task,
        allowedCandidateCardIds: [task.candidateCardId, ...task.mergeSourceCardIds].filter((id): id is string => id !== null),
        allowedMemberIds: await this.getAllowedTrelloMemberIds(userId),
      } };
    }

    const targetIds = Array.isArray(payload.targetIds)
      ? payload.targetIds.filter((id): id is string => typeof id === "string") : [];
    const requestedAction = row.proposal_type === "complete_task" ? "complete"
      : row.proposal_type === "cancel_task" ? "cancel"
        : row.proposal_type === "task_mutation" && typeof payload.requestedAction === "string"
          ? payload.requestedAction : null;
    const normalizedAction = (requestedAction ?? "")
      .normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("pt-BR");
    const mergeRequested = row.proposal_type === "merge_tasks"
      || (row.proposal_type === "task_mutation" && /mescl|merge/.test(normalizedAction));
    if (mergeRequested) {
      if (targetIds.length < 2 || new Set(targetIds).size !== targetIds.length) {
        return this.markProposalEditRequired(userId, proposalId, "Selecione ao menos duas tarefas diferentes para mesclar.");
      }
      const resolved = await Promise.all(targetIds.map((id) => this.resolveCanonicalTaskId(userId, id)));
      if (resolved.every((id): id is string => id !== null) && new Set(resolved).size === resolved.length) {
        const target = await this.getCanonicalTaskForSync(userId, resolved[0]!, "merge", `proposal:${proposalId}`);
        const sources = await Promise.all(resolved.slice(1).map((id) => this.getCanonicalTaskForSync(userId, id, "cancel", `proposal:${proposalId}`)));
        const sourceCards = sources.map((item) => item?.task.candidateCardId).filter((id): id is string => Boolean(id));
        if (target?.task.candidateCardId && sourceCards.length === resolved.length - 1) {
          target.task.operation = "merge";
          target.task.mergeSourceCardIds = sourceCards;
          target.task.authorization = "confirmed_proposal";
          target.allowedCandidateCardIds = [target.task.candidateCardId, ...sourceCards];
          return { kind: "trello", prepared: target };
        }
      }
      return this.markProposalEditRequired(userId, proposalId, "As tarefas selecionadas para mesclagem precisam pertencer à sua conta e estar vinculadas ao Trello.");
    }
    const candidate = typeof payload.taskId === "string" ? payload.taskId
      : typeof payload.targetTaskId === "string" ? payload.targetTaskId : targetIds[0] ?? null;
    const targetTaskId = candidate ? await this.resolveCanonicalTaskId(userId, candidate) : null;
    if (targetTaskId && requestedAction) {
      const prepared = await this.getCanonicalTaskForSync(userId, targetTaskId, requestedAction, `proposal:${proposalId}`);
      if (prepared) return { kind: "trello", prepared };
    }

    return this.markProposalEditRequired(userId, proposalId, "A proposta precisa de IDs válidos pertencentes à sua conta.");
  }

  private async executeConfirmedReminderProposal(
    userId: string,
    proposalId: string,
    payload: Record<string, unknown>,
  ): Promise<ConfirmedProposalDispatch> {
    const scheduled = typeof payload.scheduledFor === "string" ? new Date(payload.scheduledFor) : null;
    const recurrence = payload.recurrence && typeof payload.recurrence === "object" && !Array.isArray(payload.recurrence)
      ? payload.recurrence as Record<string, unknown> : null;
    const settings = await this.database.query<{ timezone: string }>(
      "SELECT timezone FROM user_settings WHERE user_id=$1", [userId],
    );
    const occurrenceAt = scheduled && Number.isFinite(scheduled.getTime()) ? scheduled
      : recurrence ? materializeNextReminderOccurrence(recurrence, new Date(), settings.rows[0]?.timezone ?? "America/Sao_Paulo") : null;
    if (!occurrenceAt) {
      return this.markProposalEditRequired(userId, proposalId, "Informe uma data/hora ou recorrência válida antes de confirmar o lembrete.");
    }
    const title = typeof payload.title === "string" ? payload.title
      : typeof payload.naturalLanguageRequest === "string" ? payload.naturalLanguageRequest : "Lembrete do Atlas";
    await this.database.userTransaction(userId, async (client) => {
      const reminder = await client.query<IdRow>(
        `INSERT INTO reminders
          (user_id,kind,schedule_type,title,message,scheduled_for,recurrence,dedupe_key,metadata)
         VALUES ($1,'custom',$3,$4,$5,$6,$7,$2,$8)
         ON CONFLICT (user_id,dedupe_key) WHERE dedupe_key IS NOT NULL
         DO UPDATE SET title=EXCLUDED.title,message=EXCLUDED.message,scheduled_for=EXCLUDED.scheduled_for,
           recurrence=EXCLUDED.recurrence,status='scheduled',cancelled_at=NULL
         RETURNING id::text`,
        [userId, `proposal:${proposalId}`, recurrence ? "recurring" : "absolute", title.slice(0, 300),
          typeof payload.message === "string" ? payload.message.slice(0, 10_000) : title.slice(0, 10_000),
          occurrenceAt, recurrence ? JSON.stringify(recurrence) : null, JSON.stringify({ proposalId })],
      );
      await client.query(
        `INSERT INTO reminder_occurrences (user_id,reminder_id,scheduled_at,deliver_after,status)
         VALUES ($1,$2,$3,$3,'pending')
         ON CONFLICT (user_id,reminder_id,scheduled_at) DO UPDATE SET
           deliver_after=EXCLUDED.deliver_after,status=CASE WHEN reminder_occurrences.status='sent' THEN 'sent' ELSE 'pending' END,
           locked_by=NULL,locked_at=NULL,last_error=NULL`,
        [userId, reminder.rows[0]!.id, occurrenceAt],
      );
      await client.query(
        "UPDATE action_proposals SET status='completed',executed_at=now(),error_message=NULL WHERE id=$1 AND user_id=$2",
        [proposalId, userId],
      );
    });
    return { kind: "completed" };
  }

  private async markProposalEditRequired(userId: string, proposalId: string, message: string): Promise<ConfirmedProposalDispatch> {
    await this.database.query(
      "UPDATE action_proposals SET status='edited',error_message=$3 WHERE id=$1 AND user_id=$2",
      [proposalId, userId, message],
    );
    return { kind: "edit_required", message };
  }

  private async resolveCanonicalTaskId(userId: string, candidate: string): Promise<string | null> {
    const result = await this.database.query<{ id: string }>(
      `SELECT task.id::text AS id FROM canonical_tasks task
       LEFT JOIN task_trello_links link ON link.user_id=task.user_id AND link.task_id=task.id
       LEFT JOIN trello_cards card ON card.user_id=link.user_id AND card.id=link.trello_card_id
       WHERE task.user_id=$1 AND (task.id::text=$2 OR card.trello_card_id=$2) LIMIT 1`,
      [userId, candidate],
    );
    return result.rows[0]?.id ?? null;
  }

  private async applyConfirmedProfileChange(userId: string, payload: Record<string, unknown>): Promise<boolean> {
    const preferredName = typeof payload.preferredName === "string" && payload.preferredName.trim() ? payload.preferredName.trim().slice(0, 120) : null;
    const fullName = typeof payload.fullName === "string" ? payload.fullName.trim().slice(0, 240) : null;
    const professionalArea = typeof payload.professionalArea === "string" ? payload.professionalArea.trim().slice(0, 240) : null;
    const goals = Array.isArray(payload.goals) ? payload.goals.filter((goal): goal is string => typeof goal === "string" && Boolean(goal.trim())).slice(0, 3).map((goal) => goal.trim().slice(0, 300)) : null;
    const timezone = validIanaTimezone(payload.timezone) ? payload.timezone : null;
    const locale = typeof payload.locale === "string" && payload.locale.length <= 40 ? payload.locale : null;
    const style = typeof payload.communicationStyle === "string" && ["concise", "balanced", "detailed", "encouraging"].includes(payload.communicationStyle) ? payload.communicationStyle : null;
    if (!preferredName && !Object.hasOwn(payload, "fullName") && !Object.hasOwn(payload, "professionalArea") && goals === null && !timezone && !locale && !style) return false;
    await this.database.userTransaction(userId, async (client) => {
      await client.query(
        `UPDATE users SET preferred_name=COALESCE($2,preferred_name),
           display_name=COALESCE($2,display_name),
           full_name=CASE WHEN $3 THEN $4 ELSE full_name END WHERE id=$1`,
        [userId, preferredName, Object.hasOwn(payload, "fullName"), fullName],
      );
      await client.query(
        `INSERT INTO user_profiles (user_id,professional_area,goals) VALUES ($1,$2,COALESCE($3,'{}'))
         ON CONFLICT (user_id) DO UPDATE SET
           professional_area=CASE WHEN $4 THEN EXCLUDED.professional_area ELSE user_profiles.professional_area END,
           goals=CASE WHEN $5 THEN EXCLUDED.goals ELSE user_profiles.goals END`,
        [userId, professionalArea, goals, Object.hasOwn(payload, "professionalArea"), goals !== null],
      );
      await client.query(
        `UPDATE user_settings SET timezone=COALESCE($2,timezone),locale=COALESCE($3,locale),communication_style=COALESCE($4,communication_style) WHERE user_id=$1`,
        [userId, timezone, locale, style],
      );
    });
    return true;
  }

  async getConfirmedProposalTask(userId: string, proposalId: string): Promise<CanonicalTaskForSync | null> {
    const result = await this.database.query<{
      proposal_type: string;
      proposed_payload: Record<string, unknown>;
      edited_payload: Record<string, unknown> | null;
    }>(
      `UPDATE action_proposals SET status='executing'
       WHERE id=$1 AND user_id=$2 AND status='confirmed'
       RETURNING proposal_type,proposed_payload,edited_payload`,
      [proposalId, userId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const payload = { ...row.proposed_payload, ...(row.edited_payload ?? {}) };
    if (row.proposal_type === "create_task" && typeof payload.title === "string") {
      return {
        task: {
          clientRef: `proposal-${proposalId}`,
          operation: "create",
          authorization: "confirmed_proposal",
          authorizationMessageId: `proposal:${proposalId}`,
          canonicalTaskId: null,
          candidateCardId: null,
          mergeSourceCardIds: [],
          title: payload.title.slice(0, 180),
          description: typeof payload.description === "string" ? payload.description.slice(0, 8_000) : "",
          priority: "normal", targetListRole: "inbox", nextAction: null, waitingOn: null, risk: "low",
          checklist: [], dueAt: null, dueBasis: "none", labels: [], labelsToRemove: [],
          memberIdsToAdd: [], memberIdsToRemove: [],
          project: null, person: null, estimateMinutes: null, recurrence: null, confidence: 1,
          evidenceMessageIds: [`proposal:${proposalId}`], missingInformation: [],
        },
        allowedCandidateCardIds: [],
        allowedMemberIds: await this.getAllowedTrelloMemberIds(userId),
      };
    }
    const targetTaskId = typeof payload.taskId === "string" ? payload.taskId : typeof payload.targetTaskId === "string" ? payload.targetTaskId : null;
    if (row.proposal_type === "task_mutation" && targetTaskId) {
      const prepared = await this.getCanonicalTaskForSync(userId, targetTaskId, typeof payload.requestedAction === "string" ? payload.requestedAction : null, `proposal:${proposalId}`);
      if (prepared) return prepared;
    }
    await this.markProposalExecution(userId, proposalId, false, "A proposta ainda precisa de tarefa ou horário exato.");
    return null;
  }

  async markProposalExecution(userId: string, proposalId: string, succeeded: boolean, error?: string): Promise<void> {
    await this.database.query(
      `UPDATE action_proposals SET status=$3,executed_at=CASE WHEN $3='completed' THEN now() ELSE executed_at END,
         error_message=$4 WHERE id=$1 AND user_id=$2`,
      [userId, proposalId, succeeded ? "completed" : "failed", error ?? null],
    );
  }

  async getTrelloConfig(userId: string): Promise<TrelloRuntimeConfig> {
    const result = await this.database.query<{
      api_key: string;
      access_token: string;
      board_id: string;
      board_config_id: string;
      connection_id: string;
      inbox_list_id: string | null;
      in_progress_list_id: string | null;
      paused_list_id: string | null;
      done_list_id: string | null;
    }>(
      `SELECT tc.api_key, tc.access_token, bc.board_id, bc.id AS board_config_id,
              tc.id AS connection_id, bc.inbox_list_id, bc.in_progress_list_id,
              bc.paused_list_id, bc.done_list_id
       FROM trello_connections tc
       JOIN trello_board_configs bc ON bc.trello_connection_id = tc.id
         AND bc.user_id = tc.user_id
       WHERE tc.user_id = $1 AND tc.status = 'connected' AND bc.is_active = true
       ORDER BY bc.updated_at DESC LIMIT 1`,
      [userId],
    );
    const row = result.rows[0];
    if (!row || !row.inbox_list_id || !row.in_progress_list_id || !row.paused_list_id || !row.done_list_id) {
      throw new Error("Trello is not fully configured");
    }
    return {
      apiKey: row.api_key,
      token: row.access_token,
      boardId: row.board_id,
      boardConfigId: row.board_config_id,
      connectionId: row.connection_id,
      listRoles: {
        inbox: row.inbox_list_id,
        inProgress: row.in_progress_list_id,
        paused: row.paused_list_id,
        done: row.done_list_id,
      },
    };
  }

  async listConfiguredTrelloUsers(): Promise<string[]> {
    const result = await this.database.query<{ user_id: string }>(
      `SELECT DISTINCT tc.user_id
       FROM trello_connections tc
       JOIN trello_board_configs bc ON bc.trello_connection_id = tc.id
         AND bc.user_id = tc.user_id
       WHERE tc.status = 'connected' AND bc.is_active = true
         AND bc.inbox_list_id IS NOT NULL
         AND bc.in_progress_list_id IS NOT NULL
         AND bc.paused_list_id IS NOT NULL
         AND bc.done_list_id IS NOT NULL`,
    );
    return result.rows.map((row) => row.user_id);
  }

  async replaceTrelloCardSnapshot(
    userId: string,
    config: TrelloRuntimeConfig,
    cards: readonly TrelloCard[],
    lists: readonly TrelloList[],
    members: readonly TrelloMember[] = [],
  ): Promise<void> {
    const listNames = new Map(lists.map((list) => [list.id, list.name]));
    await this.database.userTransaction(userId, async (client) => {
      await client.query(
        `UPDATE trello_connections SET metadata=metadata || jsonb_build_object('boardMembers',$3::jsonb)
         WHERE id=$1 AND user_id=$2`,
        [config.connectionId, userId, JSON.stringify(members)],
      );
      for (const card of cards) {
        const { dueCompleted, canonicalStatus } = mapTrelloCardState(card, config.listRoles);
        const labels = card.labels ?? (card.idLabels ?? []).map((id) => ({ id, name: "", color: null }));
        const controlledLabels = labels
          .map((label) => label.name.trim())
          .filter((name) => name.startsWith("Atlas: "))
          .map((name) => name.slice("Atlas: ".length).trim())
          .filter(Boolean);
        const memberIds = card.idMembers ?? [];
        if (card.dateLastActivity) {
          await client.query(
            `WITH conflicted AS (
               UPDATE task_trello_links link SET sync_status='conflict',
                 metadata=link.metadata || jsonb_build_object(
                   'conflictReason','simultaneous_external_edit',
                   'detectedAt',now(),
                   'atlasRevision',link.atlas_revision,
                   'previousTrelloRevision',link.trello_revision,
                   'incomingTrelloRevision',$4,
                   'previousSnapshot',jsonb_build_object(
                     'title',old.title,'description',old.description,'listId',old.list_id,
                     'dueAt',old.due_at,'dueComplete',old.due_complete,
                     'labels',old.labels,'members',old.members,'lastActivityAt',old.last_activity_at
                   ),
                   'incomingSnapshot',$6::jsonb
                 )
               FROM trello_cards old,canonical_tasks task
               WHERE old.user_id=$1 AND old.trello_connection_id=$2 AND old.trello_card_id=$3
                 AND link.user_id=old.user_id AND link.trello_card_id=old.id
                 AND task.user_id=link.user_id AND task.id=link.task_id
                 AND link.sync_status='pending'
                 AND $4::text IS DISTINCT FROM link.trello_revision
                 AND task.updated_at>COALESCE(link.last_synced_at,'epoch'::timestamptz)
                 AND $4::timestamptz>COALESCE(link.last_synced_at,old.synced_at,'epoch'::timestamptz)
                 AND (old.title IS DISTINCT FROM $5 OR old.list_id IS DISTINCT FROM $7
                   OR old.due_at IS DISTINCT FROM $8::timestamptz
                   OR old.due_complete IS DISTINCT FROM $9
                   OR old.labels IS DISTINCT FROM $10::jsonb
                   OR old.members IS DISTINCT FROM $11::jsonb)
               RETURNING link.task_id
             )
             INSERT INTO task_events (user_id,task_id,event_type,actor_type,idempotency_key,payload)
             SELECT $1,task_id,'trello_sync_conflict','trello',$12,
               jsonb_build_object('externalCardId',$3,'incoming',$6::jsonb)
             FROM conflicted
             ON CONFLICT (user_id,task_id,idempotency_key) DO NOTHING`,
            [
              userId,
              config.connectionId,
              card.id,
              card.dateLastActivity,
              card.name,
              JSON.stringify(card),
              card.idList,
              card.due,
              dueCompleted,
              JSON.stringify(labels),
              JSON.stringify(memberIds),
              `trello-conflict:${card.id}:${card.dateLastActivity}`,
            ],
          );
          await client.query(
            `WITH source AS (
               SELECT link.task_id
               FROM trello_cards old
               JOIN task_trello_links link ON link.user_id=old.user_id AND link.trello_card_id=old.id
               WHERE old.user_id=$1 AND old.trello_connection_id=$2 AND old.trello_card_id=$3
                 AND link.sync_status='synced'
                 AND $4::text IS DISTINCT FROM link.trello_revision
                 AND (old.title IS DISTINCT FROM $5 OR old.list_id IS DISTINCT FROM $6
                   OR old.due_at IS DISTINCT FROM $7::timestamptz
                   OR old.due_complete IS DISTINCT FROM $8
                   OR old.labels IS DISTINCT FROM $10::jsonb
                   OR old.members IS DISTINCT FROM $11::jsonb)
             ), event AS (
               INSERT INTO task_events (user_id,task_id,event_type,actor_type,idempotency_key,payload)
               SELECT $1,task_id,'trello_external_change_imported','trello',$13,
                 jsonb_build_object('externalCardId',$3,'revision',$4,'snapshot',$12::jsonb)
               FROM source
               ON CONFLICT (user_id,task_id,idempotency_key) DO NOTHING
               RETURNING task_id
             ), imported AS (
               UPDATE canonical_tasks task SET
                 title=$5,due_at=$7::timestamptz,status=$9,version=version+1,
                 completed_at=CASE WHEN $9='done' THEN COALESCE(completed_at,now()) ELSE NULL END,
                 cancelled_at=CASE WHEN $9='cancelled' THEN COALESCE(cancelled_at,now()) ELSE NULL END,
                 metadata=metadata || jsonb_build_object(
                   'trelloLabels',$10::jsonb,'trelloMemberIds',$11::jsonb,
                   'trelloDueComplete',$8,'lastExternalTrelloRevision',$4,
                   'labels',$14::jsonb
                 )
               FROM event WHERE task.user_id=$1 AND task.id=event.task_id
               RETURNING task.id,task.brain_node_id
             ), brain AS (
               UPDATE brain_nodes node SET title=task.title,status=CASE WHEN task.status='done' THEN 'done' ELSE 'active' END
               FROM imported,canonical_tasks task
               WHERE node.user_id=$1 AND node.id=imported.brain_node_id
                 AND task.user_id=node.user_id AND task.id=imported.id
               RETURNING node.id
             )
             INSERT INTO assistant_action_outcomes (user_id,task_id,action_type,outcome,score,context)
             SELECT $1,id,'trello_external_sync','accepted',1,
               jsonb_build_object('externalCardId',$3,'revision',$4)
             FROM imported`,
            [
              userId,
              config.connectionId,
              card.id,
              card.dateLastActivity,
              card.name,
              card.idList,
              card.due,
              dueCompleted,
              canonicalStatus,
              JSON.stringify(labels),
              JSON.stringify(memberIds),
              JSON.stringify(card),
              `trello-import:${card.id}:${card.dateLastActivity}`,
              JSON.stringify(controlledLabels),
            ],
          );
        }
        await client.query(
          `INSERT INTO trello_cards
             (user_id, trello_connection_id, trello_board_config_id, trello_card_id,
              board_id, list_id, list_name, title, description, url, due_at,
              due_complete, closed, labels, last_activity_at, raw_payload, synced_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             $12, $13, $14, $15, $16, now())
           ON CONFLICT (user_id, trello_connection_id, trello_card_id)
           DO UPDATE SET trello_board_config_id = EXCLUDED.trello_board_config_id,
             board_id = EXCLUDED.board_id, list_id = EXCLUDED.list_id,
             list_name = EXCLUDED.list_name, title = EXCLUDED.title,
             description = EXCLUDED.description, url = EXCLUDED.url,
             due_at = EXCLUDED.due_at, due_complete = EXCLUDED.due_complete,
             closed = EXCLUDED.closed, labels = EXCLUDED.labels,
             last_activity_at = EXCLUDED.last_activity_at,
             raw_payload = EXCLUDED.raw_payload, synced_at = now()`,
          [
            userId,
            config.connectionId,
            config.boardConfigId,
            card.id,
            config.boardId,
            card.idList,
            listNames.get(card.idList) ?? "Sem lista",
            card.name,
            card.desc,
            card.url,
            card.due,
            dueCompleted,
            card.closed,
            JSON.stringify(labels),
            card.dateLastActivity ?? null,
            JSON.stringify(card),
          ],
        );
        await client.query(
          `UPDATE trello_cards SET members=$4::jsonb
           WHERE user_id=$1 AND trello_connection_id=$2 AND trello_card_id=$3`,
          [userId, config.connectionId, card.id, JSON.stringify(memberIds)],
        );
        if (card.dateLastActivity) {
          await client.query(
            `UPDATE task_trello_links link SET trello_revision=$4,
               metadata=link.metadata || jsonb_build_object('lastObservedTrelloRevision',$4)
             FROM trello_cards tc
             WHERE link.user_id=$1 AND tc.user_id=link.user_id AND link.trello_card_id=tc.id
               AND tc.trello_connection_id=$2 AND tc.trello_card_id=$3
               AND link.sync_status='synced'`,
            [userId, config.connectionId, card.id, card.dateLastActivity],
          );
        }
      }
      await client.query(
        `UPDATE trello_cards SET closed=true,synced_at=now()
         WHERE user_id=$1 AND trello_connection_id=$2 AND board_id=$3
           AND NOT (trello_card_id=ANY($4::text[]))`,
        [userId, config.connectionId, config.boardId, cards.map((card) => card.id)],
      );
      await client.query(
        `UPDATE brain_nodes bn
         SET status = CASE WHEN tc.due_complete THEN 'done' WHEN tc.closed THEN 'archived' ELSE 'active' END
         FROM trello_cards tc
         WHERE bn.user_id = $1 AND bn.user_id = tc.user_id
           AND bn.source_type = 'trello' AND bn.source_id = tc.trello_card_id
           AND bn.status IS DISTINCT FROM
             CASE WHEN tc.due_complete THEN 'done' WHEN tc.closed THEN 'archived' ELSE 'active' END`,
        [userId],
      );
    });
    await this.publishEvent(userId, "trello.snapshot.updated", { boardId: config.boardId }, "trello");
  }

  async getCompletedExecution(
    userId: string,
    key: string,
  ): Promise<TrelloExecutionResult | null> {
    const result = await this.database.query<{ response_body: unknown }>(
      `SELECT response_body FROM idempotency_keys
       WHERE user_id = $1 AND namespace = 'trello-task' AND idempotency_key = $2
         AND status = 'completed' LIMIT 1`,
      [userId, key],
    );
    const response = result.rows[0]?.response_body as Partial<TrelloExecutionResult> | undefined;
    if (
      !response ||
      typeof response.cardId !== "string" ||
      (response.cardUrl !== null && typeof response.cardUrl !== "string") ||
      !["create", "patch", "comment", "complete", "reopen", "cancel", "merge"].includes(String(response.operation))
    ) {
      return null;
    }
    return response as TrelloExecutionResult;
  }

  async completeExecution(
    userId: string,
    key: string,
    cardId: string,
    response: unknown,
  ): Promise<void> {
    await this.database.query(
      `INSERT INTO idempotency_keys
         (user_id, namespace, idempotency_key, status, response_body,
          resource_type, resource_id, expires_at)
       VALUES ($1, 'trello-task', $2, 'completed', $3, 'trello_card', $4,
         now() + interval '365 days')
       ON CONFLICT (user_id, namespace, idempotency_key)
       DO UPDATE SET status = 'completed', response_body = EXCLUDED.response_body,
         resource_id = EXCLUDED.resource_id, expires_at = EXCLUDED.expires_at`,
      [userId, key, JSON.stringify(response), cardId],
    );
  }

  async upsertTaskNode(userId: string, task: AiTask, cardId: string, cardUrl: string | null): Promise<string> {
    const result = await this.database.query<IdRow>(
      `INSERT INTO brain_nodes
         (user_id, type, domain, title, generated_content, status, tags, source_type,
          source_id, source_url, metadata)
       VALUES ($1, 'task', 'trello', $2, $3, $4, $5, 'trello', $6, $7, $8)
       ON CONFLICT (user_id, source_type, source_id)
         WHERE source_type IS NOT NULL AND source_id IS NOT NULL
       DO UPDATE SET title = EXCLUDED.title, generated_content = EXCLUDED.generated_content,
         status = EXCLUDED.status, tags = EXCLUDED.tags, source_url = EXCLUDED.source_url,
         metadata = brain_nodes.metadata || EXCLUDED.metadata
       RETURNING id`,
      [
        userId,
        task.title,
        task.description,
        task.operation === "complete" ? "done" : "active",
        task.labels,
        cardId,
        cardUrl,
        JSON.stringify({
          priority: task.priority,
          targetListRole: task.targetListRole,
          nextAction: task.nextAction,
          waitingOn: task.waitingOn,
          risk: task.risk,
          checklist: task.checklist,
          dueAt: task.dueAt,
          cardId,
          sourceMessageIds: task.evidenceMessageIds,
        }),
      ],
    );
    await this.publishEvent(
      userId,
      "trello.task.applied",
      {
        nodeId: result.rows[0]!.id,
        cardId,
        operation: task.operation,
        title: task.title,
        sourceMessageIds: task.evidenceMessageIds,
      },
      "trello",
    );
    return result.rows[0]!.id;
  }

  async recordTrelloCard(
    userId: string,
    config: TrelloRuntimeConfig,
    task: AiTask,
    cardId: string,
    cardUrl: string | null,
  ): Promise<void> {
    const listId =
      task.operation === "complete"
        ? config.listRoles.done
        : config.listRoles[task.targetListRole];
    await this.database.query(
      `INSERT INTO trello_cards
         (user_id, trello_connection_id, trello_board_config_id, trello_card_id,
          board_id, list_id, list_name, title, description, url, due_at,
          due_complete, closed, labels, members, raw_payload, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
         $12, $13, $14, $15, $16, now())
       ON CONFLICT (user_id, trello_connection_id, trello_card_id)
       DO UPDATE SET list_id = EXCLUDED.list_id, list_name = EXCLUDED.list_name,
         title = EXCLUDED.title, description = EXCLUDED.description,
         url = COALESCE(EXCLUDED.url, trello_cards.url), due_at = EXCLUDED.due_at,
         due_complete = EXCLUDED.due_complete, closed = EXCLUDED.closed,
         labels = EXCLUDED.labels,
         members = CASE
           WHEN jsonb_array_length(EXCLUDED.members)>0 THEN
             (SELECT COALESCE(jsonb_agg(DISTINCT value),'[]'::jsonb)
              FROM jsonb_array_elements(trello_cards.members || EXCLUDED.members) value)
           ELSE trello_cards.members END,
         raw_payload = EXCLUDED.raw_payload, synced_at = now()`,
      [
        userId,
        config.connectionId,
        config.boardConfigId,
        cardId,
        config.boardId,
        listId,
        task.targetListRole,
        task.title,
        task.description,
        cardUrl,
        task.dueAt,
        task.operation === "complete",
        task.operation === "cancel",
        JSON.stringify(task.labels.map((name) => ({ id: null, name: `Atlas: ${name}`, color: null }))),
        JSON.stringify(task.memberIdsToAdd ?? []),
        JSON.stringify({ source: "atlas-worker", task }),
      ],
    );
  }

  async enqueueNotification(notification: Notification, dedupeKey: string): Promise<number> {
    const recipientJid = await this.recipientJid(notification.userId);
    const result = await this.database.query<{ id: string }>(
      `INSERT INTO notification_outbox
         (user_id, channel, whatsapp_connection_id, recipient_jid, subject, body, payload, dedupe_key)
        VALUES ($1, 'whatsapp', NULL, $2, $3, $4, $5, $6)
        ON CONFLICT (user_id, channel, dedupe_key) WHERE dedupe_key IS NOT NULL
        DO UPDATE SET subject = EXCLUDED.subject
        RETURNING id`,
      [
        notification.userId,
        recipientJid,
        notification.title,
        notification.body,
        JSON.stringify(notification),
        dedupeKey,
      ],
    );
    return Number(result.rows[0]!.id);
  }

  async listPendingMotherOutboxIds(limit = 100): Promise<number[]> {
    const result = await this.database.query<{ id: string }>(
      `SELECT no.id FROM notification_outbox no
       JOIN platform_whatsapp_connection p ON p.singleton_key='mother' AND p.status='connected'
       WHERE no.channel='whatsapp' AND no.status='pending' AND no.scheduled_at<=now()
         AND no.recipient_jid IS NOT NULL AND no.attempt_count<no.max_attempts
       ORDER BY no.priority,no.scheduled_at LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => Number(row.id));
  }

  async getOutbox(id: number): Promise<OutboxRecord | null> {
    const lockToken = randomUUID();
    const result = await this.database.query<{
      id: string;
      user_id: string;
      subject: string;
      body: string;
      payload: Record<string, unknown>;
    }>(
      `UPDATE notification_outbox SET status='sending',attempt_count=attempt_count+1,
         locked_by=$2,locked_at=now()
       WHERE id=$1 AND attempt_count<max_attempts AND scheduled_at<=now()
         AND (
           status IN ('pending','failed')
           OR (status='sending' AND locked_at<now()-interval '10 minutes')
         )
       RETURNING id,user_id,subject,body,payload`,
      [id, lockToken],
    );
    const row = result.rows[0];
    return row
      ? { id: Number(row.id), userId: row.user_id, subject: row.subject, body: row.body, payload: row.payload, lockToken }
      : null;
  }

  async markOutboxSent(id: number, externalMessageId: string, lockToken: string): Promise<void> {
    let userId: string | undefined;
    await this.database.transaction(async (client) => {
      const result = await client.query<{ user_id: string }>(
        `UPDATE notification_outbox SET status='sent',sent_at=now(),external_message_id=$2,
           last_error=NULL,locked_by=NULL,locked_at=NULL
         WHERE id=$1 AND status='sending' AND locked_by=$3
         RETURNING user_id`,
        [id, externalMessageId, lockToken],
      );
      userId = result.rows[0]?.user_id;
      if (!userId) return;
      const sent = await client.query<{
        user_id: string;
        reminder_id: string;
        scheduled_at: Date;
      }>(
        `UPDATE reminder_occurrences SET status='sent',sent_at=now(),locked_by=NULL,locked_at=NULL
         WHERE notification_outbox_id=$1 AND status='sending'
         RETURNING user_id::text,reminder_id::text,scheduled_at`,
        [id],
      );
      for (const occurrence of sent.rows) {
        const reminder = await client.query<{
          recurrence: Record<string, unknown> | null;
          timezone: string;
        }>(
          `SELECT r.recurrence,us.timezone FROM reminders r
           JOIN user_settings us ON us.user_id=r.user_id
           WHERE r.user_id=$1 AND r.id=$2 FOR UPDATE OF r`,
          [occurrence.user_id, occurrence.reminder_id],
        );
        const row = reminder.rows[0];
        const next = row?.recurrence
          ? materializeNextReminderOccurrence(row.recurrence, occurrence.scheduled_at, row.timezone)
          : null;
        if (next) {
          await client.query(
            `INSERT INTO reminder_occurrences
              (user_id,reminder_id,scheduled_at,deliver_after,status)
             VALUES ($1,$2,$3,$3,'pending')
             ON CONFLICT (user_id,reminder_id,scheduled_at) DO UPDATE SET
               deliver_after=EXCLUDED.deliver_after,
               status=CASE WHEN reminder_occurrences.status IN ('sent','acknowledged','cancelled')
                 THEN reminder_occurrences.status ELSE 'pending' END,
               locked_by=NULL,locked_at=NULL,last_error=NULL`,
            [occurrence.user_id, occurrence.reminder_id, next],
          );
          await client.query(
            `UPDATE reminders SET status='scheduled',scheduled_for=$3,last_sent_at=now()
             WHERE user_id=$1 AND id=$2 AND status NOT IN ('cancelled','acknowledged','ignored')`,
            [occurrence.user_id, occurrence.reminder_id, next],
          );
        } else {
          await client.query(
            `UPDATE reminders SET status=CASE WHEN recurrence IS NULL THEN 'sent' ELSE status END,last_sent_at=now()
             WHERE user_id=$1 AND id=$2`,
            [occurrence.user_id, occurrence.reminder_id],
          );
        }
      }
    });
    if (userId) {
      await this.publishEvent(userId, "notification.sent", { outboxId: id }, "whatsapp");
    }
  }

  async claimDueReminderOccurrences(workerId: string, limit = 50): Promise<DueReminderOccurrence[]> {
    const result = await this.database.transaction(async (client) => {
      await client.query(
        `UPDATE reminder_occurrences ro SET deliver_after=
           CASE
             WHEN us.quiet_start < us.quiet_end
               THEN (((now() AT TIME ZONE us.timezone)::date + us.quiet_end) AT TIME ZONE us.timezone)
             WHEN (now() AT TIME ZONE us.timezone)::time >= us.quiet_start
               THEN ((((now() AT TIME ZONE us.timezone)::date + 1) + us.quiet_end) AT TIME ZONE us.timezone)
             ELSE (((now() AT TIME ZONE us.timezone)::date + us.quiet_end) AT TIME ZONE us.timezone)
           END
         FROM reminders r,user_settings us
         WHERE r.user_id=ro.user_id AND r.id=ro.reminder_id
           AND us.user_id=ro.user_id AND r.respect_quiet_hours=true
           AND ro.status IN ('pending','failed','snoozed') AND ro.deliver_after<=now()
           AND us.quiet_start<>us.quiet_end
           AND (
             (us.quiet_start<us.quiet_end AND (now() AT TIME ZONE us.timezone)::time>=us.quiet_start
               AND (now() AT TIME ZONE us.timezone)::time<us.quiet_end)
             OR
             (us.quiet_start>us.quiet_end AND ((now() AT TIME ZONE us.timezone)::time>=us.quiet_start
               OR (now() AT TIME ZONE us.timezone)::time<us.quiet_end)
           )`,
      );
      return client.query<{
        id: string;
        user_id: string;
        title: string;
      }>(
        `WITH due AS (
         SELECT ro.id
         FROM reminder_occurrences ro
         JOIN reminders r ON r.user_id=ro.user_id AND r.id=ro.reminder_id
          JOIN LATERAL (
            SELECT 1 FROM whatsapp_connections wc
            WHERE wc.user_id=ro.user_id AND wc.self_jid IS NOT NULL
            ORDER BY (wc.status='connected') DESC,wc.updated_at DESC LIMIT 1
          ) recipient_whatsapp ON true
          JOIN platform_whatsapp_connection pw ON pw.singleton_key='mother' AND pw.status='connected'
         JOIN user_settings us ON us.user_id=ro.user_id
         WHERE ro.status IN ('pending','failed','snoozed') AND ro.deliver_after<=now()
           AND r.status IN ('scheduled','snoozed')
           AND COALESCE((us.feature_flags->>'notifySelf')::boolean,true)=true
           AND (ro.locked_at IS NULL OR ro.locked_at<now()-interval '10 minutes')
         ORDER BY ro.deliver_after LIMIT $2 FOR UPDATE OF ro SKIP LOCKED
       ), claimed AS (
         UPDATE reminder_occurrences ro SET status='sending',locked_by=$1,locked_at=now(),attempt_count=attempt_count+1
         FROM due WHERE ro.id=due.id
         RETURNING ro.id,ro.user_id,ro.reminder_id
       )
       SELECT c.id::text,c.user_id::text,r.title FROM claimed c
       JOIN reminders r ON r.user_id=c.user_id AND r.id=c.reminder_id`,
        [workerId, limit],
      );
    });
    return result.rows.map((row) => ({ id: row.id, userId: row.user_id, title: row.title }));
  }

  async markReminderOccurrencesQueued(ids: readonly string[], outboxId: number): Promise<void> {
    if (!ids.length) return;
    await this.database.query(
      `UPDATE reminder_occurrences SET notification_outbox_id=$2
       WHERE id=ANY($1::uuid[]) AND status='sending'`,
      [ids, outboxId],
    );
  }

  async releaseReminderOccurrences(ids: readonly string[], error: unknown): Promise<void> {
    if (!ids.length) return;
    await this.database.query(
      `UPDATE reminder_occurrences SET status='failed',locked_by=NULL,locked_at=NULL,last_error=$2
       WHERE id=ANY($1::uuid[]) AND status='sending'`,
      [ids, error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000)],
    );
  }

  async markOutboxFailed(id: number, lockToken: string, error: unknown): Promise<void> {
    await this.database.query(
      `UPDATE notification_outbox SET status='failed',last_error=$3,locked_by=NULL,locked_at=NULL
       WHERE id=$1 AND status='sending' AND locked_by=$2`,
      [id, lockToken, error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000)],
    );
  }

  async findDueBriefUsers(): Promise<{ userId: string; time: string }[]> {
    const result = await this.database.query<{ user_id: string; reminder_time: string }>(
      `SELECT DISTINCT us.user_id, rt.value AS reminder_time
       FROM user_settings us
       JOIN automations a ON a.user_id = us.user_id
         AND a.kind = 'pending_reminder' AND a.enabled = true
       JOIN LATERAL (
          SELECT 1 FROM whatsapp_connections wc
          WHERE wc.user_id=us.user_id AND wc.self_jid IS NOT NULL
          ORDER BY (wc.status='connected') DESC,wc.updated_at DESC LIMIT 1
        ) registered_whatsapp ON true
        JOIN platform_whatsapp_connection pw ON pw.singleton_key='mother' AND pw.status='connected'
       CROSS JOIN LATERAL jsonb_array_elements_text(us.reminder_times) rt(value)
       WHERE COALESCE((us.feature_flags->>'notifySelf')::boolean, true) = true
         AND to_char(now() AT TIME ZONE us.timezone, 'HH24:MI') = rt.value`,
    );
    return result.rows.map((row) => ({ userId: row.user_id, time: row.reminder_time }));
  }

  async buildBrief(userId: string): Promise<string> {
    const result = await this.database.query<{
      title: string;
      due_at: Date | null;
      list_name: string;
      updated_at: Date;
      last_activity_at: Date | null;
    }>(
      `SELECT title, due_at, list_name, updated_at, last_activity_at FROM trello_cards
       WHERE user_id = $1 AND closed = false AND due_complete = false
       ORDER BY (due_at IS NULL), due_at ASC NULLS LAST, updated_at DESC LIMIT 30`,
      [userId],
    );
    const now = Date.now();
    const overdue = result.rows.filter((row) => row.due_at && row.due_at.getTime() < now);
    const upcoming = result.rows.filter(
      (row) => row.due_at && row.due_at.getTime() >= now && row.due_at.getTime() <= now + 86_400_000,
    );
    const stalled = result.rows.filter((row) => {
      const activity = row.last_activity_at ?? row.updated_at;
      return activity.getTime() < now - 7 * 86_400_000;
    });
    const pendingReplies = await this.database.query<{ chat_name: string; sent_at: Date }>(
      `SELECT COALESCE(NULLIF(mc.display_name, ''), wm.chat_jid) AS chat_name,
              max(wm.sent_at) AS sent_at
       FROM whatsapp_messages wm
       LEFT JOIN monitored_chats mc ON mc.id = wm.monitored_chat_id
       WHERE wm.user_id = $1 AND wm.direction = 'inbound'
         AND wm.sent_at < now() - interval '2 hours'
         AND NOT EXISTS (
           SELECT 1 FROM whatsapp_messages reply
           WHERE reply.user_id = wm.user_id AND reply.chat_jid = wm.chat_jid
             AND reply.direction = 'outbound' AND reply.sent_at > wm.sent_at
         )
       GROUP BY COALESCE(NULLIF(mc.display_name, ''), wm.chat_jid)
       ORDER BY sent_at DESC LIMIT 8`,
      [userId],
    );
    const summaries = await this.database.query<{ type: string; generated_content: string }>(
      `SELECT DISTINCT ON (type) type, generated_content
       FROM brain_nodes
       WHERE user_id = $1 AND type IN ('daily_summary', 'weekly_review', 'consolidated_summary')
         AND status = 'active'
       ORDER BY type, updated_at DESC`,
      [userId],
    );
    const lines = [
      `Abertas: ${result.rows.length}`,
      `Vencidas: ${overdue.length}${overdue.slice(0, 5).map((row) => `\n• ${row.title}`).join("")}`,
      `Próximas 24h: ${upcoming.length}${upcoming.slice(0, 5).map((row) => `\n• ${row.title}`).join("")}`,
      `Paradas há 7+ dias: ${stalled.length}${stalled.slice(0, 5).map((row) => `\n• ${row.title}`).join("")}`,
      `Respostas pendentes: ${pendingReplies.rows.length}${pendingReplies.rows
        .slice(0, 5)
        .map((row) => `\n• ${row.chat_name}`)
        .join("")}`,
    ];
    const daily = summaries.rows.find((row) => row.type === "daily_summary");
    if (daily?.generated_content) {
      lines.push(`Contexto do dia:\n${daily.generated_content.slice(0, 1_000)}`);
    }
    return lines.join("\n\n");
  }

  async generateBrainSummaries(kind: GeneratedSummaryKind): Promise<number> {
    const periodFormat = {
      daily_summary: "YYYY-MM-DD",
      weekly_review: "IYYY-\"W\"IW",
      consolidated_summary: "YYYY-MM",
    }[kind];
    const users = await this.database.query<{ user_id: string; period: string }>(
      `SELECT us.user_id,
              to_char((now() AT TIME ZONE us.timezone) -
                CASE WHEN $2='consolidated_summary' THEN interval '1 month' ELSE interval '1 day' END, $1) AS period
       FROM user_settings us
       WHERE extract(hour FROM now() AT TIME ZONE us.timezone)=0
         AND CASE
           WHEN $2='weekly_review' THEN extract(isodow FROM now() AT TIME ZONE us.timezone)=1
           WHEN $2='consolidated_summary' THEN extract(day FROM now() AT TIME ZONE us.timezone)=1
           ELSE true END`,
      [periodFormat, kind],
    );
    let generated = 0;
    for (const user of users.rows) {
      await this.database.userTransaction(user.user_id, async (client) => {
        const cards = await client.query<{
          trello_card_id: string;
          title: string;
          description: string;
          url: string | null;
          due_at: Date | null;
          due_complete: boolean;
          closed: boolean;
        }>(
          `SELECT trello_card_id, title, description, url, due_at, due_complete, closed
           FROM trello_cards WHERE user_id = $1
           ORDER BY updated_at DESC LIMIT 25`,
          [user.user_id],
        );
        const derivedNodeIds: string[] = [];
        for (const card of cards.rows) {
          const node = await client.query<IdRow>(
            `INSERT INTO brain_nodes
               (user_id, type, domain, title, generated_content, status, source_type,
                source_id, source_url, happened_at, metadata)
             VALUES ($1, 'task', 'trello', $2, $3, $4, 'trello', $5, $6, $7, $8)
             ON CONFLICT (user_id, source_type, source_id)
               WHERE source_type IS NOT NULL AND source_id IS NOT NULL
             DO UPDATE SET title = EXCLUDED.title,
               generated_content = EXCLUDED.generated_content,
               status = EXCLUDED.status,
               source_url = EXCLUDED.source_url,
               metadata = brain_nodes.metadata || EXCLUDED.metadata
             RETURNING id`,
            [
              user.user_id,
              card.title,
              card.description,
              card.closed ? "done" : "active",
              card.trello_card_id,
              card.url,
              card.due_at,
              JSON.stringify({ dueAt: card.due_at, dueComplete: card.due_complete, closed: card.closed }),
            ],
          );
          derivedNodeIds.push(node.rows[0]!.id);
        }
        const recentNodes = await client.query<{
          id: string;
          type: string;
          title: string;
          generated_content: string;
        }>(
          `SELECT id, type, title, generated_content FROM brain_nodes
           WHERE user_id = $1 AND status = 'active'
             AND type NOT IN ('daily_summary', 'weekly_review', 'consolidated_summary')
           ORDER BY updated_at DESC LIMIT 30`,
          [user.user_id],
        );
        const commitments = await client.query<{
          id: string; title: string; direction: string; due_at: Date | null; next_follow_up_at: Date | null;
        }>(
          `SELECT id,title,direction,due_at,next_follow_up_at FROM commitments
           WHERE user_id=$1 AND status IN ('open','waiting')
           ORDER BY COALESCE(next_follow_up_at,due_at) NULLS LAST,updated_at DESC LIMIT 15`,
          [user.user_id],
        );
        const decisions = recentNodes.rows.filter((node) => node.type === "decision").slice(0, 10);
        const risks = await client.query<{ id: string; title: string; risk: string; due_at: Date | null }>(
          `SELECT id,title,risk,due_at FROM canonical_tasks
           WHERE user_id=$1 AND status NOT IN ('done','cancelled','merged') AND risk IN ('medium','high','critical')
           ORDER BY CASE risk WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,due_at NULLS LAST LIMIT 12`,
          [user.user_id],
        );
        const abandoned = await client.query<{ id: string; title: string; updated_at: Date }>(
          `SELECT id,title,updated_at FROM canonical_tasks
           WHERE user_id=$1 AND status NOT IN ('done','cancelled','merged')
             AND updated_at < now() - interval '14 days'
           ORDER BY updated_at LIMIT 10`,
          [user.user_id],
        );
        for (const node of recentNodes.rows) derivedNodeIds.push(node.id);
        const openCards = cards.rows.filter((card) => !card.closed && !card.due_complete);
        const overdue = openCards.filter(
          (card) => card.due_at && card.due_at.getTime() < Date.now(),
        );
        const content = [
          `Período: ${user.period}`,
          `Tarefas abertas: ${openCards.length}`,
          `Tarefas vencidas: ${overdue.length}`,
          ...openCards.slice(0, 15).map((card) =>
            `- ${card.title}${card.due_at ? ` (prazo ${card.due_at.toLocaleDateString("pt-BR")})` : ""}`,
          ),
          commitments.rows.length > 0 ? "Compromissos e retornos pendentes:" : "",
          ...commitments.rows.map((item) => `- ${item.direction === "owed_by_me" ? "Eu devo" : "Devem-me"}: ${item.title}${item.due_at ? ` (prazo ${item.due_at.toLocaleDateString("pt-BR")})` : ""} [fonte: compromisso:${item.id}]`),
          decisions.length > 0 ? "Decisões recentes:" : "",
          ...decisions.map((node) => `- [[${node.title}]] [fonte: cérebro:${node.id}]`),
          risks.rows.length > 0 ? "Riscos que pedem atenção:" : "",
          ...risks.rows.map((task) => `- [${task.risk}] ${task.title}${task.due_at ? ` (prazo ${task.due_at.toLocaleDateString("pt-BR")})` : ""} [fonte: tarefa:${task.id}]`),
          abandoned.rows.length > 0 ? "Assuntos possivelmente abandonados:" : "",
          ...abandoned.rows.map((task) => `- ${task.title} (sem atualização desde ${task.updated_at.toLocaleDateString("pt-BR")}) [fonte: tarefa:${task.id}]`),
          recentNodes.rows.length > 0 ? "Contexto e referências recentes:" : "",
          ...recentNodes.rows.slice(0, 15).map((node) => `- [${node.type}] [[${node.title}]] [fonte: cérebro:${node.id}]`),
        ]
          .filter(Boolean)
          .join("\n");
        const sourceId = `${kind}:${user.period}`;
        const summary = await client.query<IdRow>(
          `INSERT INTO brain_nodes
             (user_id, type, domain, title, generated_content, source_type, source_id,
              happened_at, metadata)
           VALUES ($1, $2, 'summary', $3, $4, 'atlas-summary', $5, now(), $6)
           ON CONFLICT (user_id, source_type, source_id)
             WHERE source_type IS NOT NULL AND source_id IS NOT NULL
           DO UPDATE SET title = EXCLUDED.title,
             generated_content = EXCLUDED.generated_content,
             happened_at = EXCLUDED.happened_at,
             metadata = brain_nodes.metadata || EXCLUDED.metadata
           RETURNING id`,
          [
            user.user_id,
            kind,
            `${kind.replaceAll("_", " ")} ${user.period}`,
            content,
            sourceId,
            JSON.stringify({ generatedBy: "atlas-worker", period: user.period }),
          ],
        );
        const summaryId = summary.rows[0]!.id;
        await client.query(
          `DELETE FROM brain_edges
           WHERE user_id = $1 AND from_node_id = $2
             AND relation_type = 'derived_from' AND provenance = 'ai'`,
          [user.user_id, summaryId],
        );
        for (const nodeId of [...new Set(derivedNodeIds)].slice(0, 40)) {
          if (nodeId === summaryId) continue;
          await client.query(
            `INSERT INTO brain_edges
               (user_id, from_node_id, to_node_id, relation_type, weight, provenance)
             VALUES ($1, $2, $3, 'derived_from', 1, 'ai')
             ON CONFLICT (user_id, from_node_id, to_node_id, relation_type)
             DO UPDATE SET weight = 1, provenance = 'ai'`,
            [user.user_id, summaryId, nodeId],
          );
        }
        generated += 1;
      });
      await this.publishEvent(
        user.user_id,
        "brain.summary.updated",
        { kind, period: user.period },
        "ai",
      );
    }
    return generated;
  }

  async claimControlJobs(workerId: string, limit = 1): Promise<ControlJob[]> {
    const result = await this.database.transaction(async (client) => client.query<{
      id: string;
      user_id: string;
      job_type: string;
      attempt: number;
      input: Record<string, unknown>;
    }>(
      `WITH candidates AS (
         SELECT id FROM job_attempts
         WHERE (
             (status IN ('queued','retrying') AND (retry_at IS NULL OR retry_at <= now()))
             OR (status = 'running' AND started_at < now() - interval '10 minutes')
           )
           AND (job_type LIKE 'automation:%' OR job_type IN (
             'feedback:reprocess','task:sync_trello','action_proposal:execute'
           ))
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT $2
       )
       UPDATE job_attempts jobs
       SET status='running',worker_id=$1,started_at=now(),retry_at=NULL
       FROM candidates WHERE jobs.id=candidates.id
       RETURNING jobs.id,jobs.user_id,jobs.job_type,jobs.attempt,jobs.input`,
      [workerId, limit],
    ));
    return result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      jobType: row.job_type,
      attempt: row.attempt,
      input: row.input,
    }));
  }

  async completeControlJob(
    id: string,
    userId: string,
    workerId: string,
    output: Record<string, unknown>,
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE job_attempts SET status='succeeded',output=$3,error_code=NULL,error_message=NULL,completed_at=now()
       WHERE id=$1 AND user_id=$2 AND status='running' AND worker_id=$4`,
      [id, userId, output, workerId],
    );
    return result.rowCount === 1;
  }

  async failControlJob(
    id: string,
    userId: string,
    workerId: string,
    attempt: number,
    error: unknown,
  ): Promise<boolean> {
    const message = error instanceof Error ? error.message : String(error);
    const retry = attempt < 3;
    const result = await this.database.query(
      `UPDATE job_attempts SET status=$4,
         attempt=CASE WHEN $4='retrying' THEN attempt+1 ELSE attempt END,
         error_code='CONTROL_JOB_FAILED',error_message=$5,
         retry_at=CASE WHEN $4='retrying' THEN now() + (attempt * interval '10 seconds') ELSE NULL END,
         completed_at=CASE WHEN $4='failed' THEN now() ELSE NULL END
       WHERE id=$1 AND user_id=$2 AND status='running' AND worker_id=$3`,
      [id, userId, workerId, retry ? 'retrying' : 'failed', message.slice(0, 2_000)],
    );
    return result.rowCount === 1;
  }

  async materializeDueAutomations(limit = 100, now = new Date()): Promise<number> {
    const supportedKinds: UserAutomationKind[] = [
      "briefing",
      "deadline",
      "overdue",
      "follow_up",
      "stale_task",
      "weekly_review",
    ];
    return this.database.transaction(async (client) => {
      const candidates = await client.query<{
        id: string;
        user_id: string;
        kind: UserAutomationKind;
        schedule: string;
        timezone: string;
        next_run_at: Date | null;
      }>(
        `SELECT id::text,user_id::text,kind,schedule,timezone,next_run_at
         FROM automations
         WHERE enabled=true AND kind=ANY($1::text[]) AND schedule IS NOT NULL
           AND (next_run_at IS NULL OR next_run_at<=$2)
         ORDER BY next_run_at NULLS FIRST,created_at
         FOR UPDATE SKIP LOCKED
         LIMIT $3`,
        [supportedKinds, now, limit],
      );
      let queued = 0;
      for (const automation of candidates.rows) {
        let nextRun: Date;
        try {
          nextRun = nextAutomationRun(automation.schedule, automation.timezone, now);
        } catch (error) {
          await client.query(
            `UPDATE automations SET next_run_at=$3,last_run_status='failed',last_error=$4
             WHERE id=$1 AND user_id=$2`,
            [automation.id, automation.user_id, new Date(now.getTime() + 86_400_000), String(error).slice(0, 2_000)],
          );
          continue;
        }
        if (automation.next_run_at !== null) {
          const scheduledFor = automation.next_run_at;
          const jobKey = `schedule:${automation.id}:${scheduledFor.toISOString()}`;
          const inserted = await client.query(
            `INSERT INTO job_attempts (user_id,job_type,job_key,status,input)
             VALUES ($1,$2,$3,'queued',$4)
             ON CONFLICT (user_id,job_type,job_key,attempt) DO NOTHING`,
            [
              automation.user_id,
              `automation:${automation.kind}`,
              jobKey,
              JSON.stringify({ automationId: automation.id, scheduledFor: scheduledFor.toISOString() }),
            ],
          );
          if (inserted.rowCount === 1) queued += 1;
        }
        await client.query(
          `UPDATE automations SET next_run_at=$3,last_error=NULL
           WHERE id=$1 AND user_id=$2`,
          [automation.id, automation.user_id, nextRun],
        );
      }
      return queued;
    });
  }

  async getAutomation(userId: string, automationId: string): Promise<AutomationRecord | null> {
    const result = await this.database.query<{
      id: string;
      user_id: string;
      kind: string;
      enabled: boolean;
      schedule: string | null;
      timezone: string;
      config: Record<string, unknown>;
      next_run_at: Date | null;
    }>(
      'SELECT id,user_id,kind,enabled,schedule,timezone,config,next_run_at FROM automations WHERE id=$1 AND user_id=$2',
      [automationId, userId],
    );
    const row = result.rows[0];
    return row ? {
      id: row.id,
      userId: row.user_id,
      kind: row.kind,
      enabled: row.enabled,
      schedule: row.schedule,
      timezone: row.timezone,
      config: row.config,
      nextRunAt: row.next_run_at,
    } : null;
  }

  async buildAutomationNotification(
    userId: string,
    kind: UserAutomationKind,
  ): Promise<Omit<Notification, "userId">> {
    if (kind === "briefing") {
      return { kind: "brief", title: "Briefing do Atlas", body: await this.buildBrief(userId) };
    }
    let items: string[] = [];
    if (kind === "deadline") {
      const result = await this.database.query<{ title: string; due_at: Date }>(
        `SELECT title,due_at FROM canonical_tasks
         WHERE user_id=$1 AND status NOT IN ('done','cancelled','merged')
           AND due_at>=now() AND due_at<=now()+interval '24 hours'
         ORDER BY due_at LIMIT 20`, [userId],
      );
      items = result.rows.map((row) => `${row.title} — ${row.due_at.toLocaleString("pt-BR")}`);
    } else if (kind === "overdue") {
      const result = await this.database.query<{ title: string; due_at: Date }>(
        `SELECT title,due_at FROM canonical_tasks
         WHERE user_id=$1 AND status NOT IN ('done','cancelled','merged') AND due_at<now()
         ORDER BY due_at LIMIT 20`, [userId],
      );
      items = result.rows.map((row) => `${row.title} — venceu ${row.due_at.toLocaleDateString("pt-BR")}`);
    } else if (kind === "follow_up") {
      const result = await this.database.query<{ title: string; counterpart_name: string | null }>(
        `SELECT title,counterpart_name FROM commitments
         WHERE user_id=$1 AND status IN ('open','waiting')
           AND COALESCE(next_follow_up_at,due_at)<=now()
         ORDER BY COALESCE(next_follow_up_at,due_at) LIMIT 20`, [userId],
      );
      items = result.rows.map((row) => `${row.title}${row.counterpart_name ? ` — ${row.counterpart_name}` : ""}`);
    } else if (kind === "stale_task") {
      const result = await this.database.query<{ title: string; updated_at: Date }>(
        `SELECT title,updated_at FROM canonical_tasks
         WHERE user_id=$1 AND status NOT IN ('done','cancelled','merged')
           AND updated_at<now()-interval '7 days'
         ORDER BY updated_at LIMIT 20`, [userId],
      );
      items = result.rows.map((row) => `${row.title} — sem atualização desde ${row.updated_at.toLocaleDateString("pt-BR")}`);
    } else {
      const result = await this.database.query<{ item: string }>(
        `SELECT item FROM (
           SELECT 'Concluída: ' || title AS item,completed_at AS at
           FROM canonical_tasks WHERE user_id=$1 AND completed_at>=now()-interval '7 days'
           UNION ALL
           SELECT 'Compromisso aberto: ' || title,updated_at
           FROM commitments WHERE user_id=$1 AND status IN ('open','waiting')
           UNION ALL
           SELECT 'Aprendizado: ' || statement,updated_at
           FROM assistant_learnings WHERE user_id=$1 AND state='active' AND updated_at>=now()-interval '7 days'
         ) review ORDER BY at DESC NULLS LAST LIMIT 20`, [userId],
      );
      items = result.rows.map((row) => row.item);
    }
    const composed = composeAutomationNotification(kind, items);
    return { kind: kind === "weekly_review" ? "brief" : "reminder", ...composed };
  }

  async markAutomationResult(userId: string, automationId: string, error?: unknown): Promise<void> {
    await this.database.query(
      `UPDATE automations SET last_run_at=now(),last_run_status=$3,last_error=$4
       WHERE id=$1 AND user_id=$2`,
      [automationId, userId, error ? 'failed' : 'succeeded', error ? String(error).slice(0, 2_000) : null],
    );
  }

  async loadFeedbackMessages(userId: string, feedbackId: string): Promise<NormalizedMessage[]> {
    const feedback = await this.database.query<{
      node_metadata: Record<string, unknown> | null;
      feedback_metadata: Record<string, unknown>;
    }>(
      `SELECT bn.metadata AS node_metadata,f.metadata AS feedback_metadata
       FROM feedback f
       LEFT JOIN brain_nodes bn ON bn.id=f.node_id AND bn.user_id=f.user_id
       WHERE f.id=$1 AND f.user_id=$2`,
      [feedbackId, userId],
    );
    const row = feedback.rows[0];
    if (!row) return [];
    const sourceIds = [
      ...(Array.isArray(row.node_metadata?.sourceMessageIds) ? row.node_metadata.sourceMessageIds : []),
      ...(Array.isArray(row.feedback_metadata.sourceMessageIds) ? row.feedback_metadata.sourceMessageIds : []),
    ].filter((value): value is string => typeof value === 'string');
    if (!sourceIds.length) return [];
    const messages = await this.database.query<{
      external_message_id: string;
      user_id: string;
      chat_jid: string;
      sender_jid: string;
      display_name: string | null;
      sent_at: Date;
      from_me: boolean;
      body: string;
    }>(
      `SELECT wm.external_message_id,wm.user_id,wm.chat_jid,wm.sender_jid,
              NULLIF(mc.display_name,'') AS display_name,wm.sent_at,wm.from_me,wm.body
       FROM whatsapp_messages wm
       LEFT JOIN monitored_chats mc ON mc.id=wm.monitored_chat_id
       WHERE wm.user_id=$1 AND wm.external_message_id=ANY($2::text[])
       ORDER BY wm.sent_at`,
      [userId, [...new Set(sourceIds)]],
    );
    return messages.rows.map((message) => ({
      id: message.external_message_id,
      userId: message.user_id,
      chatJid: message.chat_jid,
      senderJid: message.sender_jid,
      senderName: message.display_name,
      sentAt: message.sent_at.toISOString(),
      fromMe: message.from_me,
      text: message.body,
    }));
  }
}
