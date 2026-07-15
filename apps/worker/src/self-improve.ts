import { createHash } from "node:crypto";

import type { NormalizedMessage } from "@atlas/shared";

import type { WorkerRepository } from "./repository.js";

/**
 * Varredura rotineira de auto-aprimoramento. Cada ciclo:
 *  1. Reprocessa lotes de análise que falharam (ex.: indisponibilidade da IA),
 *     reaproveitando o batch_key idempotente original.
 *  2. Tece o grafo com arestas determinísticas "mentions" quando uma nota cita
 *     o título/alias de uma entidade durável — o grafo cresce mesmo quando a IA
 *     omite relations.
 *  3. Arquiva notas "análise pendente" cujo lote foi finalmente concluído.
 *  4. Consolida aprendizados duplicados (mesma frase e escopo).
 *  5. Quando existe uma dúvida concreta (tarefa incompleta ou padrão sugerido),
 *     pergunta proativamente ao dono pelo WhatsApp — no máximo uma pergunta a
 *     cada intervalo, dentro do horário social, sem repetir a mesma dúvida.
 */

export interface SelfImproveSweepResult {
  requeuedBatches: number;
  wovenEdges: number;
  archivedPendingNotes: number;
  consolidatedLearnings: number;
  questionsAsked: number;
}

export interface RequeuedBatch {
  userId: string;
  chatJid: string;
  batchKey: string;
  batchId: string;
  messages: NormalizedMessage[];
}

const MAX_REQUEUED_BATCHES_PER_SWEEP = 50;
const MAX_BATCH_ATTEMPTS = 10;
const PROACTIVE_QUESTION_MIN_INTERVAL_HOURS = 6;
const PROACTIVE_QUESTION_START_HOUR = 8;
const PROACTIVE_QUESTION_END_HOUR = 21;

interface BatchRow {
  id: string;
  user_id: string;
  chat_jid: string;
  batch_key: string;
}

interface BatchMessageRow {
  external_message_id: string;
  chat_jid: string;
  sender_jid: string;
  sender_name: string | null;
  sent_at: Date;
  from_me: boolean;
  body: string;
  metadata: Record<string, unknown>;
  quoted_external_message_id: string | null;
}

export async function collectFailedBatchesForRequeue(
  repository: WorkerRepository,
  limit = MAX_REQUEUED_BATCHES_PER_SWEEP,
): Promise<RequeuedBatch[]> {
  const batches = await repository.database.query<BatchRow>(
    `SELECT id,user_id,chat_jid,batch_key FROM message_batches
     WHERE status='failed' AND attempt_count<$1
     ORDER BY window_ends_at DESC LIMIT $2`,
    [MAX_BATCH_ATTEMPTS, limit],
  );
  const jobs: RequeuedBatch[] = [];
  for (const batch of batches.rows) {
    const rows = await repository.database.query<BatchMessageRow>(
      `SELECT wm.external_message_id,wm.chat_jid,wm.sender_jid,
              COALESCE(NULLIF(wm.metadata->>'senderName',''),NULLIF(mc.display_name,'')) AS sender_name,
              wm.sent_at,wm.from_me,wm.body,wm.metadata,wm.quoted_external_message_id
       FROM message_batch_items item
       JOIN whatsapp_messages wm ON wm.id=item.message_id AND wm.user_id=item.user_id
       LEFT JOIN monitored_chats mc ON mc.id=wm.monitored_chat_id
       WHERE item.user_id=$1 AND item.batch_id=$2
       ORDER BY item.position`,
      [batch.user_id, batch.id],
    );
    if (!rows.rows.length) continue;
    jobs.push({
      userId: batch.user_id,
      chatJid: batch.chat_jid,
      batchKey: batch.batch_key,
      batchId: batch.id,
      messages: rows.rows.map((row) => ({
        id: row.external_message_id,
        userId: batch.user_id,
        chatJid: row.chat_jid,
        senderJid: row.sender_jid,
        senderName: row.sender_name,
        sentAt: row.sent_at.toISOString(),
        fromMe: row.from_me,
        text: row.body,
        isGroup: typeof row.metadata?.isGroup === "boolean" ? row.metadata.isGroup : row.chat_jid.endsWith("@g.us"),
        mentionedJids: Array.isArray(row.metadata?.mentionedJids)
          ? row.metadata.mentionedJids.filter((value): value is string => typeof value === "string")
          : [],
        quotedParticipantJid: typeof row.metadata?.quotedParticipantJid === "string" ? row.metadata.quotedParticipantJid : null,
        quotedMessageId: row.quoted_external_message_id,
        directedToUser: typeof row.metadata?.directedToUser === "boolean" ? row.metadata.directedToUser : undefined,
      })),
    });
  }
  return jobs;
}

/**
 * Liga notas/decisões a entidades duráveis citadas pelo título ou alias.
 * Usa fronteira de palavra (\m/\M) para evitar falsos positivos por substring
 * e exige nomes com pelo menos 4 caracteres.
 */
export async function weaveMentionEdges(repository: WorkerRepository, userId: string): Promise<number> {
  const result = await repository.database.query(
    `WITH entities AS (
       SELECT id,lower(btrim(title)) AS name,aliases FROM brain_nodes
       WHERE user_id=$1 AND status IN ('active','inbox') AND type IN ('person','project','group','entity','topic')
         AND length(btrim(title))>=4
       ORDER BY updated_at DESC LIMIT 300
     ), names AS (
       SELECT id,name FROM entities
       UNION ALL
       SELECT e.id,lower(btrim(alias.value)) AS name
       FROM entities e CROSS JOIN LATERAL unnest(e.aliases) AS alias(value)
       WHERE length(btrim(alias.value))>=4
     ), notes AS (
       SELECT id,lower(title||' '||left(coalesce(manual_content,''),4000)||' '||left(coalesce(generated_content,''),4000)) AS text
       FROM brain_nodes
       WHERE user_id=$1 AND status IN ('active','inbox')
         AND type IN ('note','decision','reference','procedure','meeting','task','daily_summary','weekly_review')
       ORDER BY updated_at DESC LIMIT 500
     )
     INSERT INTO brain_edges (user_id,from_node_id,to_node_id,relation_type,weight,provenance)
     SELECT DISTINCT $1::uuid,n.id,names.id,'mentions',0.6,'rule'
     FROM notes n
     JOIN names ON n.id<>names.id
       AND n.text ~ ('\\m'||regexp_replace(names.name,'([^a-z0-9à-ÿ ])','\\\\\\1','g')||'\\M')
     ON CONFLICT (user_id,from_node_id,to_node_id,relation_type) DO NOTHING`,
    [userId],
  );
  return result.rowCount ?? 0;
}

export async function archiveResolvedPendingNotes(repository: WorkerRepository, userId: string): Promise<number> {
  const result = await repository.database.query(
    `UPDATE brain_nodes n SET status='archived',
       metadata=n.metadata || jsonb_build_object('resolvedBy','self-improve','resolvedAt',now())
     FROM message_batches mb
     WHERE n.user_id=$1 AND n.status='inbox' AND (n.metadata->>'pendingAnalysis')::boolean IS TRUE
       AND mb.user_id=n.user_id AND mb.batch_key=n.metadata->>'batchKey' AND mb.status='completed'`,
    [userId],
  );
  return result.rowCount ?? 0;
}

export async function consolidateDuplicateLearnings(repository: WorkerRepository, userId: string): Promise<number> {
  const result = await repository.database.query(
    `WITH ranked AS (
       SELECT id,
         first_value(id) OVER (
           PARTITION BY lower(btrim(statement)),scope_type,COALESCE(scope_id,'')
           ORDER BY (source_type='explicit') DESC,confidence DESC,created_at
         ) AS keeper
       FROM assistant_learnings
       WHERE user_id=$1 AND state IN ('active','suggested','paused')
     )
     DELETE FROM assistant_learnings
     WHERE user_id=$1 AND id IN (SELECT id FROM ranked WHERE id<>keeper)`,
    [userId],
  );
  return result.rowCount ?? 0;
}

export interface ProactiveDoubt {
  key: string;
  question: string;
}

export async function collectDoubts(repository: WorkerRepository, userId: string): Promise<ProactiveDoubt[]> {
  const doubts: ProactiveDoubt[] = [];
  const tasks = await repository.database.query<{ id: string; title: string; missing: string[] | null; confidence: number | null }>(
    `SELECT id::text,title,
       CASE WHEN jsonb_typeof(metadata->'missingInformation')='array'
         THEN ARRAY(SELECT jsonb_array_elements_text(metadata->'missingInformation')) END AS missing,
       confidence::float AS confidence
     FROM canonical_tasks
     WHERE user_id=$1 AND status='inbox'
       AND (confidence<0.7 OR jsonb_array_length(COALESCE(metadata->'missingInformation','[]'::jsonb))>0)
     ORDER BY created_at DESC LIMIT 3`,
    [userId],
  );
  for (const task of tasks.rows) {
    const missing = (task.missing ?? []).filter(Boolean).slice(0, 3);
    doubts.push({
      key: `task:${task.id}`,
      question: missing.length
        ? `Sobre a tarefa "${task.title}": ainda me falta ${missing.join(", ")}. Pode me confirmar esses detalhes?`
        : `Anotei a tarefa "${task.title}", mas não tenho certeza se ela é mesmo sua responsabilidade. Confirma pra mim?`,
    });
  }
  const learnings = await repository.database.query<{ id: string; statement: string }>(
    `SELECT id::text,statement FROM assistant_learnings
     WHERE user_id=$1 AND state='suggested'
     ORDER BY confidence DESC,created_at DESC LIMIT 2`,
    [userId],
  );
  for (const learning of learnings.rows) {
    doubts.push({
      key: `learning:${learning.id}`,
      question: `Percebi um padrão: "${learning.statement}". Quer que eu passe a considerar isso sempre? Responda sim ou não.`,
    });
  }
  return doubts;
}

export function withinSocialHours(timezone: string, now = new Date()): boolean {
  let hour = now.getUTCHours();
  try {
    hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" }).format(now));
  } catch {
    // Fuso inválido: usa UTC como aproximação segura.
  }
  return hour >= PROACTIVE_QUESTION_START_HOUR && hour < PROACTIVE_QUESTION_END_HOUR;
}

export function doubtDedupeKey(doubt: ProactiveDoubt): string {
  return `proactive-question:${createHash("sha256").update(doubt.key).digest("hex").slice(0, 24)}`;
}

/**
 * Envia no máximo UMA pergunta proativa por usuário por ciclo, respeitando o
 * intervalo mínimo entre perguntas e sem repetir uma dúvida já perguntada
 * (o dedupe_key do outbox garante a idempotência histórica).
 */
export async function maybeAskProactiveQuestion(
  repository: WorkerRepository,
  userId: string,
): Promise<number | null> {
  if (!(await repository.shouldNotifySelf(userId))) return null;
  const settings = await repository.database.query<{ timezone: string }>(
    "SELECT timezone FROM user_settings WHERE user_id=$1",
    [userId],
  );
  if (!withinSocialHours(settings.rows[0]?.timezone ?? "America/Sao_Paulo")) return null;
  const recent = await repository.database.query(
    `SELECT 1 FROM notification_outbox
     WHERE user_id=$1 AND payload->>'kind'='proactive_question'
       AND created_at>now()-make_interval(hours => $2) LIMIT 1`,
    [userId, PROACTIVE_QUESTION_MIN_INTERVAL_HOURS],
  );
  if (recent.rows.length) return null;
  const doubts = await collectDoubts(repository, userId);
  for (const doubt of doubts) {
    const dedupeKey = doubtDedupeKey(doubt);
    const asked = await repository.database.query(
      `SELECT 1 FROM notification_outbox
       WHERE user_id=$1 AND channel='whatsapp' AND dedupe_key=$2 LIMIT 1`,
      [userId, dedupeKey],
    );
    if (asked.rows.length) continue;
    return repository.enqueueNotification(
      { userId, kind: "proactive_question", title: "Uma dúvida rápida", body: doubt.question },
      dedupeKey,
    );
  }
  return null;
}

export async function listActiveUserIds(repository: WorkerRepository): Promise<string[]> {
  const result = await repository.database.query<{ id: string }>(
    "SELECT id::text FROM users ORDER BY created_at",
  );
  return result.rows.map((row) => row.id);
}
