import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AiProvider, AiSource } from '../ai.js';
import { currentUser } from '../auth.js';
import { AppError, parseInput } from '../errors.js';
import type { EventHub } from '../events.js';
import { alwaysLearningKey, canAutoExecuteProposal } from '../proposal-policy.js';
import type { AppDatabase } from '../types.js';

interface ChatDeps {
  database: AppDatabase;
  events: EventHub;
  ai: AiProvider;
}

const askSchema = z.object({
  message: z.string().trim().min(1).max(20_000),
  threadId: z.string().uuid().optional(),
  context: z.object({
    view: z.string().max(80).optional(),
    noteId: z.string().uuid().nullable().optional(),
  }).default({}),
});

interface SourceRow {
  id: string;
  title: string;
  excerpt: string;
  source_type: string | null;
  updated_at: Date | string;
}

interface ProposedActionDraft {
  proposalType: string;
  title: string;
  description: string;
  risk: 'low' | 'medium' | 'high' | 'destructive';
  reversible: boolean;
  payload: Record<string, unknown>;
}

interface ChatProfileRow {
  preferred_name: string;
  full_name: string | null;
  professional_area: string | null;
  goals: string[];
  timezone: string;
  locale: string;
  work_days: number[];
  work_start: string;
  work_end: string;
  communication_style: string;
}

export function inferProposals(message: string): ProposedActionDraft[] {
  const drafts: ProposedActionDraft[] = [];
  const task = message.match(/(?:crie|criar|adicione|anote)\s+(?:uma\s+)?tarefa\s*[:\-]?\s*(.+)/iu);
  if (task?.[1]?.trim()) drafts.push({
    proposalType: 'create_task', title: `Criar tarefa: ${task[1].trim().slice(0, 180)}`,
    description: 'A tarefa só será criada depois da sua confirmação.', risk: 'low', reversible: true,
    payload: { title: task[1].trim() },
  });
  const reminder = message.match(/(?:me\s+)?lembre(?:-me)?\s+(?:de\s+)?(.+)/iu);
  if (reminder?.[1]?.trim()) drafts.push({
    proposalType: 'create_reminder', title: `Criar lembrete: ${reminder[1].trim().slice(0, 170)}`,
    description: 'Confirme e, se necessário, ajuste a data antes de agendar.', risk: 'low', reversible: true,
    payload: { naturalLanguageRequest: reminder[1].trim(), needsScheduleResolution: true },
  });
  const destructive = message.match(/\b(conclua|cancele|mescle)\b/iu);
  if (destructive) drafts.push({
    proposalType: 'task_mutation', title: `Confirmar ação: ${destructive[1]!.toLowerCase()}`,
    description: 'O Atlas precisa da confirmação e da tarefa exata antes de executar.',
    risk: 'destructive', reversible: false,
    payload: { requestedAction: destructive[1]!.toLowerCase(), needsTargetResolution: true },
  });
  return drafts;
}

function sourceJson(row: SourceRow): AiSource {
  const kind: AiSource['kind'] = row.source_type?.startsWith('whatsapp')
    ? 'whatsapp'
    : row.source_type?.startsWith('trello') ? 'trello' : 'note';
  return {
    id: row.id,
    title: row.title,
    excerpt: row.excerpt,
    kind,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function retrieveSources(database: AppDatabase, userId: string, query: string, noteId?: string | null): Promise<AiSource[]> {
  const result = await database.query<SourceRow>(
    `WITH input AS (
       SELECT websearch_to_tsquery('portuguese', $2) AS tsq
     ), ranked AS (
       SELECT n.id,
         (CASE WHEN n.id=$3::uuid THEN 10 ELSE 0 END
          + ts_rank_cd(n.search_vector,input.tsq)*0.8
          + similarity(n.title,$2)*0.2) AS score
       FROM brain_nodes n,input
       WHERE n.user_id=$1 AND n.status<>'deleted'
         AND (n.id=$3::uuid OR n.search_vector@@input.tsq
           OR similarity(n.title,$2)>0.12 OR n.title ILIKE '%'||$2||'%')
       ORDER BY score DESC,n.updated_at DESC LIMIT 8
     ), candidate_scores AS (
       SELECT id,score FROM ranked
       UNION ALL
       SELECT CASE WHEN e.from_node_id=r.id THEN e.to_node_id ELSE e.from_node_id END AS id,
              r.score*0.2*GREATEST(e.weight,0.1) AS score
       FROM ranked r
       JOIN brain_edges e ON e.user_id=$1
         AND (e.from_node_id=r.id OR e.to_node_id=r.id)
     ), candidates AS (
       SELECT id,max(score) AS score FROM candidate_scores GROUP BY id
     )
     SELECT n.id,n.title,
       left(regexp_replace(concat_ws(E'\\n',NULLIF(n.manual_content,''),NULLIF(n.generated_content,'')), E'[\\n\\r]+',' ','g'),500) AS excerpt,
       n.source_type,n.updated_at
     FROM candidates c
     JOIN brain_nodes n ON n.id=c.id AND n.user_id=$1 AND n.status<>'deleted'
     ORDER BY c.score DESC,n.updated_at DESC LIMIT 10`,
    [userId, query, noteId ?? null],
  );
  return result.rows.map(sourceJson);
}

async function askWithContext(
  request: FastifyRequest,
  input: z.infer<typeof askSchema>,
  deps: ChatDeps,
): Promise<{ answer: string; sources: AiSource[]; threadId: string; messageId: string; proposals: unknown[] }> {
  const user = currentUser(request);
  const { database, ai, events } = deps;
  const [sources, profileResult] = await Promise.all([
    retrieveSources(database, user.id, input.message, input.context.noteId),
    database.query<ChatProfileRow>(
      `SELECT u.preferred_name,u.full_name,p.professional_area,p.goals,
              s.timezone,s.locale,s.work_days,s.work_start::text,s.work_end::text,s.communication_style
       FROM users u JOIN user_profiles p ON p.user_id=u.id
       JOIN user_settings s ON s.user_id=u.id WHERE u.id=$1`,
      [user.id],
    ),
  ]);
  const profile = profileResult.rows[0];
  let threadId = input.threadId;
  if (threadId) {
    const owned = await database.query('SELECT 1 FROM brain_chat_threads WHERE id=$1 AND user_id=$2', [threadId, user.id]);
    if (!owned.rows[0]) throw new AppError(404, 'THREAD_NOT_FOUND', 'Conversa não encontrada.');
  } else {
    const created = await database.query<{ id: string }>(
      `INSERT INTO brain_chat_threads (user_id, title)
       VALUES ($1, $2) RETURNING id`,
      [user.id, input.message.slice(0, 90)],
    );
    threadId = created.rows[0]!.id;
  }

  await database.query(
    `INSERT INTO brain_chat_messages (user_id, thread_id, role, content)
     VALUES ($1,$2,'user',$3)`, [user.id, threadId, input.message],
  );
  const history = await database.query<{ role: 'user' | 'assistant'; content: string }>(
    `SELECT role, content FROM brain_chat_messages
     WHERE user_id=$1 AND thread_id=$2 AND role IN ('user','assistant')
     ORDER BY created_at DESC LIMIT 9`, [user.id, threadId],
  );
  const conversation = history.rows.reverse().slice(0, -1);
  const run = await database.query<{ id: string }>(
    `INSERT INTO ai_runs (user_id, purpose, provider, model, reasoning_effort, status, thread_id, input, started_at)
     VALUES ($1,'brain_chat','deepseek','deepseek-v4-flash','medium','running',$2,$3,now()) RETURNING id`,
    [user.id, threadId, { message: input.message, sourceIds: sources.map((source) => source.id), context: input.context }],
  );
  const runId = run.rows[0]!.id;
  const started = Date.now();

  let completion;
  try {
    completion = await ai.answer({
      message: input.message,
      sources,
      conversation,
      ...(profile ? {
        profile: {
          preferredName: profile.preferred_name,
          fullName: profile.full_name,
          occupation: profile.professional_area,
          goals: profile.goals,
          timezone: profile.timezone,
          locale: profile.locale,
          workDays: profile.work_days.map((day) => day === 0 ? 7 : day),
          workStart: profile.work_start.slice(0, 5),
          workEnd: profile.work_end.slice(0, 5),
          communicationStyle: profile.communication_style,
        },
      } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1_000) : 'Falha no provedor de IA';
    await database.query(
      `UPDATE ai_runs SET status='failed',error_code='PROVIDER_UNAVAILABLE',error_message=$3,
         latency_ms=$4,completed_at=now() WHERE id=$1 AND user_id=$2`,
      [runId, user.id, message, Date.now() - started],
    );
    request.log.error({ err: error, aiRunId: runId }, 'DeepSeek request failed');
    throw new AppError(503, 'AI_TEMPORARILY_UNAVAILABLE', 'A inteligência está temporariamente indisponível. Tente novamente em instantes.', { retryable: true });
  }

  const saved = await database.userTransaction(user.id, async (client) => {
    const cacheMissTokens = Math.max(0, completion.usage.promptTokens - completion.usage.cachedTokens);
    const costMicros = Math.round(
      cacheMissTokens * 0.14 + completion.usage.cachedTokens * 0.0028 + completion.usage.completionTokens * 0.28,
    );
    const assistant = await client.query<{ id: string }>(
      `INSERT INTO brain_chat_messages
         (user_id, thread_id, role, content, model, citations, token_usage, metadata)
       VALUES ($1,$2,'assistant',$3,$4,$5,$6,$7) RETURNING id`,
      [user.id, threadId, completion.answer, completion.model, JSON.stringify(sources), completion.usage, {}],
    );
    const messageId = assistant.rows[0]!.id;
    await client.query(
      `UPDATE ai_runs SET provider=$3, model=$4, status='succeeded', output=$5,
         prompt_tokens=$6, completion_tokens=$7, reasoning_tokens=$8, cached_tokens=$9,
         latency_ms=$10, chat_message_id=$11, cost_micros=$12, completed_at=now(),
         error_code=$13, error_message=$14
       WHERE id=$1 AND user_id=$2`,
      [runId, user.id, completion.provider, completion.model, { answer: completion.answer },
        completion.usage.promptTokens, completion.usage.completionTokens, completion.usage.reasoningTokens,
        completion.usage.cachedTokens, Date.now() - started, messageId, costMicros, null, null],
    );
    await client.query(
      `INSERT INTO ai_usage_events
         (user_id, ai_run_id, provider, model, purpose, prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens,cost_micros)
       VALUES ($1,$2,$3,$4,'brain_chat',$5,$6,$7,$8,$9)`,
      [user.id, runId, completion.provider, completion.model, completion.usage.promptTokens,
        completion.usage.completionTokens, completion.usage.reasoningTokens, completion.usage.cachedTokens, costMicros],
    );
    const drafts = inferProposals(input.message);
    const eligibleKeys = drafts
      .filter((draft) => canAutoExecuteProposal(draft))
      .map((draft) => alwaysLearningKey(draft.proposalType));
    const activeRules = eligibleKeys.length ? await client.query<{ id: string; learning_key: string }>(
      `SELECT id,learning_key FROM assistant_learnings
       WHERE user_id=$1 AND scope_type='global' AND scope_id IS NULL AND state='active'
         AND learning_key=ANY($2::text[])`, [user.id, eligibleKeys],
    ) : { rows: [] as Array<{ id: string; learning_key: string }> };
    const rulesByKey = new Map(activeRules.rows.map((rule) => [rule.learning_key, rule.id]));
    const proposals = [];
    for (const draft of drafts) {
      const ruleId = canAutoExecuteProposal(draft)
        ? rulesByKey.get(alwaysLearningKey(draft.proposalType)) ?? null
        : null;
      const autoExecute = ruleId !== null;
      const created = await client.query(
        `INSERT INTO action_proposals
          (user_id,thread_id,chat_message_id,proposal_type,title,description,risk,reversible,
           requires_confirmation,proposed_payload,evidence,status,confirmed_at,metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING id,proposal_type AS "proposalType",title,description,status,risk,reversible,
           requires_confirmation AS "requiresConfirmation",proposed_payload AS "proposedPayload",evidence,metadata`,
        [user.id, threadId, messageId, draft.proposalType, draft.title, draft.description,
          draft.risk, draft.reversible, !autoExecute, draft.payload,
          JSON.stringify(sources.map((source) => ({ sourceId: source.id, kind: source.kind }))),
          autoExecute ? 'confirmed' : 'pending', autoExecute ? new Date() : null,
          autoExecute ? { autoConfirmedByLearningId: ruleId } : {}],
      );
      const proposal = { ...created.rows[0]!, autoExecuted: autoExecute };
      proposals.push(proposal);
      if (autoExecute) {
        await client.query(
          `INSERT INTO job_attempts (user_id,job_type,job_key,status,input)
           VALUES ($1,'action_proposal:execute',$2,'queued',$3)
           ON CONFLICT (user_id,job_type,job_key,attempt) DO NOTHING`,
          [user.id, `proposal:${created.rows[0]!.id}`, {
            proposalId: created.rows[0]!.id, confirmedByLearningId: ruleId, always: true,
          }],
        );
        await client.query(
          'UPDATE assistant_learnings SET last_used_at=now() WHERE id=$1 AND user_id=$2',
          [ruleId, user.id],
        );
      }
    }
    if (proposals.length) {
      await client.query(
        `UPDATE brain_chat_messages SET metadata=metadata || $3::jsonb WHERE id=$1 AND user_id=$2`,
        [messageId, user.id, { actionProposalIds: proposals.map((proposal: { id: string }) => proposal.id) }],
      );
    }
    await client.query('UPDATE brain_chat_threads SET updated_at=now() WHERE id=$1 AND user_id=$2', [threadId, user.id]);
    return { messageId, proposals };
  });

  await events.publish(user.id, 'ai.answer.completed', {
    threadId, messageId: saved.messageId, aiRunId: runId,
    proposalIds: saved.proposals.map((proposal: { id: string }) => proposal.id),
  }, 'ai');
  return { answer: completion.answer, sources, threadId, messageId: saved.messageId, proposals: saved.proposals };
}

export async function registerChatRoutes(app: FastifyInstance, deps: ChatDeps): Promise<void> {
  const { database } = deps;

  app.post('/ai/chat', async (request) => askWithContext(request, parseInput(askSchema, request.body), deps));
  app.post('/brain/chat', async (request) => askWithContext(request, parseInput(askSchema, request.body), deps));

  app.get('/brain/chat/threads', async (request) => {
    const user = currentUser(request);
    const result = await database.query(
      `SELECT id, title, archived_at AS "archivedAt", metadata, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM brain_chat_threads WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 100`, [user.id],
    );
    return { items: result.rows };
  });

  app.post('/brain/chat/threads', async (request, reply) => {
    const user = currentUser(request);
    const input = parseInput(z.object({ title: z.string().trim().min(1).max(160).default('Nova conversa') }), request.body ?? {});
    const result = await database.query(
      `INSERT INTO brain_chat_threads (user_id,title) VALUES ($1,$2)
       RETURNING id,title,created_at AS "createdAt",updated_at AS "updatedAt"`, [user.id, input.title],
    );
    return reply.status(201).send(result.rows[0]);
  });

  app.get('/brain/chat/threads/:id/messages', async (request) => {
    const user = currentUser(request);
    const { id } = parseInput(z.object({ id: z.string().uuid() }), request.params);
    const owned = await database.query('SELECT 1 FROM brain_chat_threads WHERE id=$1 AND user_id=$2', [id, user.id]);
    if (!owned.rows[0]) throw new AppError(404, 'THREAD_NOT_FOUND', 'Conversa não encontrada.');
    const result = await database.query(
      `SELECT id,role,content,status,model,citations,token_usage AS "tokenUsage",
              metadata,created_at AS "createdAt"
       FROM brain_chat_messages WHERE thread_id=$1 AND user_id=$2 ORDER BY created_at`, [id, user.id],
    );
    return { items: result.rows };
  });

  app.post('/brain/chat/threads/:id/messages', async (request) => {
    const { id } = parseInput(z.object({ id: z.string().uuid() }), request.params);
    const body = parseInput(z.object({ message: z.string().trim().min(1).max(20_000) }), request.body);
    return askWithContext(request, { message: body.message, threadId: id, context: {} }, deps);
  });
}
