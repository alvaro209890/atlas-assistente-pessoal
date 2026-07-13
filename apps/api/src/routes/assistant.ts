import type { PoolClient } from '@atlas/database';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser } from '../auth.js';
import { AppError, parseInput } from '../errors.js';
import type { EventHub } from '../events.js';
import { alwaysLearningKey, canAutoExecuteProposal } from '../proposal-policy.js';
import type { AppDatabase } from '../types.js';
import { ianaTimezone } from '../timezone.js';

interface AssistantDeps {
  database: AppDatabase;
  events: EventHub;
}

const uuidParams = z.object({ id: z.string().uuid() });
const isoDate = z.coerce.date();
const optionalNullableDate = isoDate.nullable().optional();
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const taskStatus = z.enum(['inbox', 'open', 'in_progress', 'paused', 'done', 'cancelled', 'merged']);
const editableTaskStatus = z.enum(['inbox', 'open', 'in_progress', 'paused']);
const taskPriority = z.enum(['low', 'medium', 'high', 'urgent']);
const taskRisk = z.enum(['low', 'medium', 'high', 'critical']);

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export function normalizeWorkDays(days: readonly number[]): number[] {
  return [...new Set(days.map((day) => day === 7 ? 0 : day))].sort((left, right) => left - right);
}

export function materializeNextOccurrence(
  recurrence: Record<string, unknown>,
  now = new Date(),
): Date {
  const nextAt = typeof recurrence.nextAt === 'string' ? new Date(recurrence.nextAt) : null;
  if (nextAt && Number.isFinite(nextAt.getTime()) && nextAt.getTime() > now.getTime()) return nextAt;
  const intervalMinutes = typeof recurrence.intervalMinutes === 'number' ? recurrence.intervalMinutes : null;
  if (intervalMinutes && Number.isFinite(intervalMinutes) && intervalMinutes > 0) {
    return new Date(now.getTime() + Math.min(intervalMinutes, 525_600) * 60_000);
  }
  const every = typeof recurrence.every === 'number' && recurrence.every > 0 ? recurrence.every : 1;
  const unitMs = recurrence.unit === 'minute' ? 60_000
    : recurrence.unit === 'hour' ? 3_600_000
      : recurrence.unit === 'week' || recurrence.frequency === 'weekly' ? 7 * 86_400_000
        : 86_400_000;
  return new Date(now.getTime() + Math.min(every, 365) * unitMs);
}

function publicWorkDays(days: readonly number[]): number[] {
  return [...new Set(days.map((day) => day === 0 ? 7 : day))].sort((left, right) => left - right);
}

interface ProfileRow {
  id: string;
  email: string;
  preferred_name: string;
  full_name: string | null;
  professional_area: string | null;
  goals: string[];
  whatsapp_name_suggestion: string | null;
  timezone: string;
  locale: string;
  work_days: number[];
  work_start: string;
  work_end: string;
  quiet_start: string;
  quiet_end: string;
  communication_style: string;
  updated_at: Date | string;
}

function profileJson(row: ProfileRow) {
  return {
    id: row.id,
    email: row.email,
    preferredName: row.preferred_name,
    fullName: row.full_name,
    occupation: row.professional_area,
    goals: row.goals,
    timezone: row.timezone,
    locale: row.locale,
    workDays: publicWorkDays(row.work_days),
    workStart: row.work_start.slice(0, 5),
    workEnd: row.work_end.slice(0, 5),
    quietStart: row.quiet_start.slice(0, 5),
    quietEnd: row.quiet_end.slice(0, 5),
    communicationStyle: row.communication_style,
    whatsappNameSuggestion: row.whatsapp_name_suggestion,
    updatedAt: iso(row.updated_at),
  };
}

const profileSelect = `u.id,u.email,u.preferred_name,u.full_name,
  p.professional_area,p.goals,p.whatsapp_name_suggestion,
  s.timezone,s.locale,s.work_days,s.work_start::text,s.work_end::text,
  s.quiet_start::text,s.quiet_end::text,s.communication_style,
  GREATEST(u.updated_at,p.updated_at,s.updated_at) AS updated_at`;

interface TaskRow {
  id: string;
  brain_node_id: string | null;
  project_node_id: string | null;
  person_node_id: string | null;
  merged_into_task_id: string | null;
  title: string;
  description: string;
  status: z.infer<typeof taskStatus>;
  priority: z.infer<typeof taskPriority>;
  risk: z.infer<typeof taskRisk>;
  next_action: string | null;
  due_at: Date | string | null;
  estimated_minutes: number | null;
  recurrence: Record<string, unknown> | null;
  expected_owner: string | null;
  confidence: string | number | null;
  version: number;
  completed_at: Date | string | null;
  cancelled_at: Date | string | null;
  metadata: Record<string, unknown>;
  created_at: Date | string;
  updated_at: Date | string;
  trello_card_id?: string | null;
  trello_sync_status?: string | null;
  trello_card_url?: string | null;
  project_name?: string | null;
  person_name?: string | null;
}

const taskSelect = `t.id,t.brain_node_id,t.project_node_id,t.person_node_id,t.merged_into_task_id,
  t.title,t.description,t.status,t.priority,t.risk,t.next_action,t.due_at,t.estimated_minutes,
  t.recurrence,t.expected_owner,t.confidence,t.version,t.completed_at,t.cancelled_at,t.metadata,
  t.created_at,t.updated_at,l.trello_card_id,l.sync_status AS trello_sync_status,
  (SELECT c.url FROM trello_cards c WHERE c.id=l.trello_card_id AND c.user_id=t.user_id) AS trello_card_url,
  (SELECT n.title FROM brain_nodes n WHERE n.id=t.project_node_id AND n.user_id=t.user_id) AS project_name,
  (SELECT n.title FROM brain_nodes n WHERE n.id=t.person_node_id AND n.user_id=t.user_id) AS person_name`;

function taskJson(row: TaskRow) {
  return {
    id: row.id,
    brainNodeId: row.brain_node_id,
    projectNodeId: row.project_node_id,
    personNodeId: row.person_node_id,
    mergedIntoTaskId: row.merged_into_task_id,
    title: row.title,
    description: row.description,
    projectName: row.project_name ?? null,
    personName: row.person_name ?? null,
    status: row.status,
    priority: row.priority,
    risk: row.risk,
    nextAction: row.next_action,
    dueAt: iso(row.due_at),
    estimatedMinutes: row.estimated_minutes,
    recurrence: row.recurrence,
    expectedOwner: row.expected_owner,
    confidence: row.confidence === null ? null : Number(row.confidence),
    version: row.version,
    completedAt: iso(row.completed_at),
    cancelledAt: iso(row.cancelled_at),
    trello: row.trello_card_id ? {
      cardId: row.trello_card_id,
      url: row.trello_card_url ?? null,
      syncStatus: row.trello_sync_status,
    } : null,
    metadata: row.metadata,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(100_000).default(''),
  status: taskStatus.default('open'),
  priority: taskPriority.default('medium'),
  risk: taskRisk.default('low'),
  projectNodeId: z.string().uuid().nullable().optional(),
  personNodeId: z.string().uuid().nullable().optional(),
  nextAction: z.string().trim().max(2_000).nullable().optional(),
  dueAt: optionalNullableDate,
  estimatedMinutes: z.number().int().positive().max(525_600).nullable().optional(),
  recurrence: z.record(z.string(), z.unknown()).nullable().optional(),
  expectedOwner: z.string().trim().max(200).nullable().optional(),
  sourceFingerprint: z.string().trim().min(1).max(500).optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
const updateTaskSchema = createTaskSchema.omit({ sourceFingerprint: true, status: true }).partial()
  .extend({ status: editableTaskStatus.optional() })
  .refine((value) => Object.keys(value).length > 0, 'Envie ao menos um campo.');

async function readTask(database: AppDatabase, userId: string, taskId: string): Promise<TaskRow> {
  const result = await database.query<TaskRow>(
    `SELECT ${taskSelect} FROM canonical_tasks t
     LEFT JOIN task_trello_links l ON l.user_id=t.user_id AND l.task_id=t.id
     WHERE t.id=$1 AND t.user_id=$2`, [taskId, userId],
  );
  if (!result.rows[0]) throw new AppError(404, 'TASK_NOT_FOUND', 'Tarefa não encontrada.');
  return result.rows[0];
}

async function queueTaskProjectionSync(
  client: Pick<PoolClient, 'query'>,
  input: {
    userId: string; taskId: string; version: number; action: string;
    extra?: Record<string, unknown>; dedupeKey?: string;
  },
): Promise<void> {
  await client.query(
    `UPDATE task_trello_links SET sync_status='pending',atlas_revision=GREATEST(atlas_revision,$3),
       metadata=metadata || $4::jsonb,last_error=NULL
     WHERE user_id=$1 AND task_id=$2 AND sync_status<>'detached'`,
    [input.userId, input.taskId, input.version,
      { canonicalTaskVersion: input.version, pendingAction: input.action }],
  );
  const jobKey = input.dedupeKey ?? `${input.taskId}:v${input.version}:${input.action}`;
  await client.query(
    `INSERT INTO job_attempts (user_id,job_type,job_key,status,input)
     VALUES ($1,'task:sync_trello',$2,'queued',$3)
     ON CONFLICT (user_id,job_type,job_key,attempt) DO NOTHING`,
    [input.userId, jobKey, {
      taskId: input.taskId, canonicalTaskVersion: input.version, action: input.action,
      ...(input.extra ?? {}),
    }],
  );
}

export async function registerAssistantRoutes(app: FastifyInstance, deps: AssistantDeps): Promise<void> {
  const { database, events } = deps;

  app.get('/profile', async (request) => {
    const user = currentUser(request);
    const result = await database.query<ProfileRow>(
      `SELECT ${profileSelect} FROM users u
       JOIN user_profiles p ON p.user_id=u.id JOIN user_settings s ON s.user_id=u.id
       WHERE u.id=$1`, [user.id],
    );
    if (!result.rows[0]) throw new AppError(404, 'PROFILE_NOT_FOUND', 'Perfil não encontrado.');
    return profileJson(result.rows[0]);
  });

  app.patch('/profile', async (request) => {
    const user = currentUser(request);
    const input = parseInput(z.object({
      preferredName: z.string().trim().min(2).max(120).optional(),
      fullName: z.string().trim().min(2).max(180).nullable().optional(),
      occupation: z.string().trim().max(180).nullable().optional(),
      goals: z.array(z.string().trim().min(1).max(300)).max(3).optional(),
      timezone: ianaTimezone.optional(),
      locale: z.string().trim().min(2).max(20).optional(),
      workDays: z.array(z.number().int().min(0).max(7)).min(1).max(7).optional(),
      workStart: time.optional(), workEnd: time.optional(),
      quietStart: time.optional(), quietEnd: time.optional(),
      communicationStyle: z.enum(['concise', 'balanced', 'detailed', 'encouraging']).optional(),
    }).refine((value) => Object.keys(value).length > 0, 'Envie ao menos um campo.'), request.body);
    const normalizedWorkDays = input.workDays ? normalizeWorkDays(input.workDays) : null;
    const result = await database.userTransaction(user.id, async (client) => {
      await client.query(
        `UPDATE users SET
           preferred_name=COALESCE($2,preferred_name),display_name=COALESCE($2,display_name),
           full_name=CASE WHEN $3 THEN $4 ELSE full_name END
         WHERE id=$1`,
        [user.id, input.preferredName ?? null, Object.hasOwn(input, 'fullName'), input.fullName ?? null],
      );
      await client.query(
        `UPDATE user_profiles SET
           professional_area=CASE WHEN $2 THEN $3 ELSE professional_area END,
           goals=COALESCE($4,goals)
         WHERE user_id=$1`,
        [user.id, Object.hasOwn(input, 'occupation'), input.occupation ?? null, input.goals ?? null],
      );
      await client.query(
        `UPDATE user_settings SET timezone=COALESCE($2,timezone),locale=COALESCE($3,locale),
           work_days=COALESCE($4,work_days),work_start=COALESCE($5::time,work_start),
           work_end=COALESCE($6::time,work_end),quiet_start=COALESCE($7::time,quiet_start),
           quiet_end=COALESCE($8::time,quiet_end),communication_style=COALESCE($9,communication_style)
         WHERE user_id=$1`,
        [user.id, input.timezone ?? null, input.locale ?? null, normalizedWorkDays,
          input.workStart ?? null, input.workEnd ?? null, input.quietStart ?? null,
          input.quietEnd ?? null, input.communicationStyle ?? null],
      );
      return client.query<ProfileRow>(
        `SELECT ${profileSelect} FROM users u
         JOIN user_profiles p ON p.user_id=u.id JOIN user_settings s ON s.user_id=u.id
         WHERE u.id=$1`, [user.id],
      );
    });
    await events.publish(user.id, 'profile.updated', { fields: Object.keys(input) });
    return profileJson(result.rows[0]!);
  });

  app.get('/tasks', async (request) => {
    const user = currentUser(request);
    const query = parseInput(z.object({
      status: taskStatus.optional(), priority: taskPriority.optional(),
      projectNodeId: z.string().uuid().optional(), dueBefore: isoDate.optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
      offset: z.coerce.number().int().min(0).max(100_000).default(0),
    }), request.query);
    const result = await database.query<TaskRow & { total: number }>(
      `SELECT ${taskSelect},count(*) OVER()::int AS total FROM canonical_tasks t
       LEFT JOIN task_trello_links l ON l.user_id=t.user_id AND l.task_id=t.id
       WHERE t.user_id=$1 AND ($2::text IS NULL OR t.status=$2)
         AND ($3::text IS NULL OR t.priority=$3)
         AND ($4::uuid IS NULL OR t.project_node_id=$4)
         AND ($5::timestamptz IS NULL OR t.due_at <= $5)
       ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                t.due_at NULLS LAST,t.updated_at DESC LIMIT $6 OFFSET $7`,
      [user.id, query.status ?? null, query.priority ?? null, query.projectNodeId ?? null,
        query.dueBefore ?? null, query.limit, query.offset],
    );
    return { items: result.rows.map(taskJson), total: result.rows[0]?.total ?? 0, limit: query.limit, offset: query.offset };
  });

  app.post('/tasks', async (request, reply) => {
    const user = currentUser(request);
    const input = parseInput(createTaskSchema, request.body);
    const created = await database.userTransaction(user.id, async (client) => {
      const node = await client.query<{ id: string }>(
        `INSERT INTO brain_nodes (user_id,type,domain,title,manual_content,status,source_type,metadata)
         VALUES ($1,'task','general',$2,$3,$4,'canonical_task',$5) RETURNING id`,
        [user.id, input.title, input.description,
          input.status === 'done' ? 'done' : input.status === 'cancelled' ? 'archived' : 'active',
          { priority: input.priority, risk: input.risk }],
      );
      const task = await client.query<TaskRow>(
        `INSERT INTO canonical_tasks
          (user_id,brain_node_id,project_node_id,person_node_id,title,description,status,priority,risk,
           next_action,due_at,estimated_minutes,recurrence,expected_owner,source_fingerprint,confidence,metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING *,NULL::uuid AS trello_card_id,NULL::text AS trello_sync_status`,
        [user.id, node.rows[0]!.id, input.projectNodeId ?? null, input.personNodeId ?? null,
          input.title, input.description, input.status, input.priority, input.risk, input.nextAction ?? null,
          input.dueAt ?? null, input.estimatedMinutes ?? null, input.recurrence ?? null,
          input.expectedOwner ?? null, input.sourceFingerprint ?? null, input.confidence ?? null, input.metadata],
      );
      await client.query('UPDATE brain_nodes SET source_id=$3 WHERE id=$1 AND user_id=$2', [node.rows[0]!.id, user.id, task.rows[0]!.id]);
      await client.query(
        `INSERT INTO task_events (user_id,task_id,event_type,actor_type,actor_user_id,payload)
         VALUES ($1,$2,'created','user',$1,$3)`, [user.id, task.rows[0]!.id, { input }],
      );
      await queueTaskProjectionSync(client, {
        userId: user.id, taskId: task.rows[0]!.id, version: task.rows[0]!.version, action: 'create',
      });
      return task.rows[0]!;
    });
    await events.publish(user.id, 'task.created', { taskId: created.id });
    return reply.status(201).send(taskJson(created));
  });

  app.get('/tasks/:id', async (request) => {
    const user = currentUser(request);
    const { id } = parseInput(uuidParams, request.params);
    const task = await readTask(database, user.id, id);
    const eventsResult = await database.query(
      `SELECT id,event_type AS "eventType",actor_type AS "actorType",payload,
              occurred_at AS "occurredAt" FROM task_events
       WHERE user_id=$1 AND task_id=$2 ORDER BY occurred_at DESC LIMIT 100`, [user.id, id],
    );
    return { ...taskJson(task), events: eventsResult.rows };
  });

  app.patch('/tasks/:id', async (request) => {
    const user = currentUser(request);
    const { id } = parseInput(uuidParams, request.params);
    const input = parseInput(updateTaskSchema, request.body);
    const rawInput = request.body && typeof request.body === 'object'
      ? request.body as Record<string, unknown>
      : {};
    const has = (key: string) => Object.hasOwn(rawInput, key);
    const result = await database.userTransaction(user.id, async (client) => {
      const updated = await client.query<TaskRow>(
        `UPDATE canonical_tasks SET
           title=COALESCE($3,title),description=COALESCE($4,description),status=COALESCE($5,status),
           priority=COALESCE($6,priority),risk=COALESCE($7,risk),
           project_node_id=CASE WHEN $8 THEN $9 ELSE project_node_id END,
           person_node_id=CASE WHEN $10 THEN $11 ELSE person_node_id END,
           next_action=CASE WHEN $12 THEN $13 ELSE next_action END,
           due_at=CASE WHEN $14 THEN $15 ELSE due_at END,
           estimated_minutes=CASE WHEN $16 THEN $17 ELSE estimated_minutes END,
           recurrence=CASE WHEN $18 THEN $19 ELSE recurrence END,
           expected_owner=CASE WHEN $20 THEN $21 ELSE expected_owner END,
           confidence=CASE WHEN $22 THEN $23 ELSE confidence END,
           metadata=metadata || COALESCE($24,'{}'::jsonb),version=version+1
         WHERE id=$1 AND user_id=$2
         RETURNING *,NULL::uuid AS trello_card_id,NULL::text AS trello_sync_status`,
        [id, user.id, has('title') ? input.title ?? null : null,
          has('description') ? input.description ?? null : null,
          has('status') ? input.status ?? null : null,
          has('priority') ? input.priority ?? null : null,
          has('risk') ? input.risk ?? null : null,
          has('projectNodeId'), input.projectNodeId ?? null,
          has('personNodeId'), input.personNodeId ?? null,
          has('nextAction'), input.nextAction ?? null,
          has('dueAt'), input.dueAt ?? null,
          has('estimatedMinutes'), input.estimatedMinutes ?? null,
          has('recurrence'), input.recurrence ?? null,
          has('expectedOwner'), input.expectedOwner ?? null,
          has('confidence'), input.confidence ?? null,
          has('metadata') ? input.metadata ?? null : null],
      );
      const row = updated.rows[0];
      if (!row) throw new AppError(404, 'TASK_NOT_FOUND', 'Tarefa não encontrada.');
      await client.query(
        `UPDATE brain_nodes SET title=$3,manual_content=CASE WHEN $6 THEN $4 ELSE manual_content END,
          status=CASE WHEN $5='done' THEN 'done' WHEN $5 IN ('cancelled','merged') THEN 'archived' ELSE 'active' END
         WHERE id=$1 AND user_id=$2`, [row.brain_node_id, user.id, row.title, row.description, row.status,
          has('description')],
      );
      await client.query(
        `INSERT INTO task_events (user_id,task_id,event_type,actor_type,actor_user_id,payload)
         VALUES ($1,$2,'updated','user',$1,$3)`, [user.id, id, { changes: input }],
      );
      await queueTaskProjectionSync(client, {
        userId: user.id, taskId: id, version: row.version, action: 'update',
      });
      return row;
    });
    await events.publish(user.id, 'task.updated', { taskId: id, version: result.version });
    return taskJson(result);
  });

  app.post('/tasks/:id/conflict', async (request) => {
    const user = currentUser(request);
    const { id } = parseInput(uuidParams, request.params);
    const input = parseInput(z.object({ resolution: z.enum(['keep_atlas', 'keep_trello']) }), request.body);
    await database.userTransaction(user.id, async (client) => {
      const conflict = await client.query<{
        brain_node_id: string | null; version: number; link_id: string; card_id: string;
        card_title: string; card_description: string; card_due_at: Date | string | null;
        card_due_complete: boolean; card_closed: boolean; card_list_id: string; card_updated_at: Date | string;
        inbox_list_id: string | null; in_progress_list_id: string | null;
        paused_list_id: string | null; done_list_id: string | null;
      }>(
        `SELECT t.brain_node_id,t.version,l.id AS link_id,c.id AS card_id,c.title AS card_title,
                c.description AS card_description,c.due_at AS card_due_at,c.due_complete AS card_due_complete,
                c.closed AS card_closed,c.list_id AS card_list_id,c.updated_at AS card_updated_at,
                bc.inbox_list_id,bc.in_progress_list_id,bc.paused_list_id,bc.done_list_id
         FROM canonical_tasks t JOIN task_trello_links l ON l.task_id=t.id AND l.user_id=t.user_id
         JOIN trello_cards c ON c.id=l.trello_card_id AND c.user_id=l.user_id
         LEFT JOIN trello_board_configs bc ON bc.id=c.trello_board_config_id AND bc.user_id=c.user_id
         WHERE t.id=$1 AND t.user_id=$2 AND l.sync_status='conflict'
         FOR UPDATE OF t,l,c`, [id, user.id],
      );
      const row = conflict.rows[0];
      if (!row) throw new AppError(409, 'TASK_CONFLICT_NOT_FOUND', 'Esta tarefa não possui um conflito pendente com o Trello.');
      if (input.resolution === 'keep_atlas') {
        const resolved = await client.query<{ version: number }>(
          `UPDATE canonical_tasks SET version=version+1,metadata=metadata || $3::jsonb
           WHERE id=$1 AND user_id=$2 RETURNING version`,
          [id, user.id, { conflictResolution: 'keep_atlas', conflictResolvedAt: new Date().toISOString() }],
        );
        await queueTaskProjectionSync(client, {
          userId: user.id, taskId: id, version: resolved.rows[0]!.version, action: 'resolve_conflict_keep_atlas',
        });
      } else {
        const status = row.card_due_complete || row.card_list_id === row.done_list_id ? 'done'
          : row.card_closed ? 'cancelled'
          : row.card_list_id === row.in_progress_list_id ? 'in_progress'
            : row.card_list_id === row.paused_list_id ? 'paused'
              : row.card_list_id === row.inbox_list_id ? 'inbox' : 'open';
        const updated = await client.query<{ version: number }>(
          `UPDATE canonical_tasks SET title=$3,description=$4,due_at=$5,status=$6,
             completed_at=CASE WHEN $6='done' THEN COALESCE(completed_at,now()) ELSE NULL END,
             cancelled_at=CASE WHEN $6='cancelled' THEN COALESCE(cancelled_at,now()) ELSE NULL END,version=version+1,
             metadata=metadata || $7::jsonb
           WHERE id=$1 AND user_id=$2 RETURNING version`,
          [id, user.id, row.card_title, row.card_description, row.card_due_at, status,
            { conflictResolution: 'keep_trello', conflictResolvedAt: new Date().toISOString(), trelloCardId: row.card_id }],
        );
        await client.query(
          `UPDATE task_trello_links SET sync_status='synced',atlas_revision=$3,
             trello_revision=$4,last_synced_at=now(),last_error=NULL,
             metadata=metadata || $5::jsonb WHERE id=$1 AND user_id=$2`,
          [row.link_id, user.id, updated.rows[0]!.version, new Date(row.card_updated_at).toISOString(),
            { conflictResolution: 'keep_trello' }],
        );
      }
      await client.query(
        `INSERT INTO task_events (user_id,task_id,event_type,actor_type,actor_user_id,payload)
         VALUES ($1,$2,$3,'user',$1,$4)`,
        [user.id, id, `conflict_resolved_${input.resolution}`, { resolution: input.resolution, trelloCardId: row.card_id }],
      );
    });
    const task = await readTask(database, user.id, id);
    await events.publish(user.id, 'task.conflict.resolved', {
      taskId: id, resolution: input.resolution, syncStatus: task.trello_sync_status ?? null,
    });
    return { resolution: input.resolution, task: taskJson(task), syncStatus: task.trello_sync_status ?? null };
  });

  app.post('/tasks/:id/actions', async (request) => {
    const user = currentUser(request);
    const { id } = parseInput(uuidParams, request.params);
    const input = parseInput(z.object({
      action: z.enum(['complete', 'cancel', 'merge', 'reopen', 'snooze', 'reschedule', 'open', 'comment']),
      targetTaskId: z.string().uuid().optional(),
      snoozeUntil: isoDate.optional(),
      dueAt: isoDate.nullable().optional(),
      comment: z.string().trim().min(1).max(10_000).optional(),
      reason: z.string().trim().max(2_000).optional(),
    }), request.body);
    if (input.action === 'merge' && (!input.targetTaskId || input.targetTaskId === id)) {
      throw new AppError(400, 'MERGE_TARGET_REQUIRED', 'Escolha outra tarefa como destino da mesclagem.');
    }
    if (input.action === 'snooze' && !input.snoozeUntil) {
      throw new AppError(400, 'SNOOZE_UNTIL_REQUIRED', 'Informe até quando a tarefa deve ser adiada.');
    }
    if (input.action === 'reschedule' && !Object.hasOwn(input, 'dueAt')) {
      throw new AppError(400, 'DUE_AT_REQUIRED', 'Informe o novo prazo.');
    }
    if (input.action === 'comment' && !input.comment) {
      throw new AppError(400, 'COMMENT_REQUIRED', 'Escreva o comentário que deve ser enviado ao Trello.');
    }
    await database.userTransaction(user.id, async (client) => {
      const current = await client.query<TaskRow>(
        'SELECT * FROM canonical_tasks WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, user.id],
      );
      const task = current.rows[0];
      if (!task) throw new AppError(404, 'TASK_NOT_FOUND', 'Tarefa não encontrada.');
      if (input.action === 'complete') {
        await client.query(
          `UPDATE canonical_tasks SET status='done',completed_at=now(),cancelled_at=NULL,version=version+1
           WHERE id=$1 AND user_id=$2`, [id, user.id],
        );
        await client.query("UPDATE brain_nodes SET status='done' WHERE id=$1 AND user_id=$2", [task.brain_node_id, user.id]);
      } else if (input.action === 'cancel') {
        await client.query(
          `UPDATE canonical_tasks SET status='cancelled',cancelled_at=now(),completed_at=NULL,version=version+1
           WHERE id=$1 AND user_id=$2`, [id, user.id],
        );
        await client.query("UPDATE brain_nodes SET status='archived' WHERE id=$1 AND user_id=$2", [task.brain_node_id, user.id]);
      } else if (input.action === 'reopen') {
        await client.query(
          `UPDATE canonical_tasks SET status='open',cancelled_at=NULL,completed_at=NULL,version=version+1
           WHERE id=$1 AND user_id=$2`, [id, user.id],
        );
        await client.query("UPDATE brain_nodes SET status='active' WHERE id=$1 AND user_id=$2", [task.brain_node_id, user.id]);
      } else if (input.action === 'reschedule') {
        await client.query(
          'UPDATE canonical_tasks SET due_at=$3,version=version+1 WHERE id=$1 AND user_id=$2',
          [id, user.id, input.dueAt ?? null],
        );
      } else if (input.action === 'snooze') {
        const reminder = await client.query<{ id: string }>(
          `INSERT INTO reminders
            (user_id,task_id,kind,schedule_type,title,message,scheduled_for,status,dedupe_key)
           VALUES ($1,$2,'custom','absolute',$3,$4,$5,'snoozed',$6)
           ON CONFLICT (user_id,dedupe_key) WHERE dedupe_key IS NOT NULL
           DO UPDATE SET scheduled_for=EXCLUDED.scheduled_for,status='snoozed',cancelled_at=NULL
           RETURNING id`,
          [user.id, id, `Retomar: ${task.title}`, input.reason ?? '', input.snoozeUntil,
            `task:${id}:snooze:${input.snoozeUntil!.toISOString()}`],
        );
        await client.query(
          `INSERT INTO reminder_occurrences (user_id,reminder_id,scheduled_at,deliver_after,status)
           VALUES ($1,$2,$3,$3,'snoozed') ON CONFLICT DO NOTHING`,
          [user.id, reminder.rows[0]!.id, input.snoozeUntil],
        );
        await client.query(
          "UPDATE canonical_tasks SET status='paused',version=version+1 WHERE id=$1 AND user_id=$2",
          [id, user.id],
        );
      } else if (input.action === 'merge') {
        const target = await client.query('SELECT 1 FROM canonical_tasks WHERE id=$1 AND user_id=$2 FOR UPDATE', [input.targetTaskId, user.id]);
        if (!target.rows[0]) throw new AppError(404, 'MERGE_TARGET_NOT_FOUND', 'Tarefa de destino não encontrada.');
        await client.query(
          `UPDATE canonical_tasks SET status='merged',merged_into_task_id=$3,version=version+1
           WHERE id=$1 AND user_id=$2`, [id, user.id, input.targetTaskId],
        );
        await client.query('UPDATE reminders SET task_id=$3 WHERE task_id=$1 AND user_id=$2', [id, user.id, input.targetTaskId]);
        await client.query('UPDATE commitments SET task_id=$3 WHERE task_id=$1 AND user_id=$2', [id, user.id, input.targetTaskId]);
        await client.query(
          "UPDATE task_trello_links SET sync_status='detached',metadata=metadata || $3::jsonb WHERE task_id=$1 AND user_id=$2",
          [id, user.id, { mergedIntoTaskId: input.targetTaskId }],
        );
        await client.query("UPDATE brain_nodes SET status='archived' WHERE id=$1 AND user_id=$2", [task.brain_node_id, user.id]);
      }
      const taskEvent = await client.query<{ id: string }>(
        `INSERT INTO task_events (user_id,task_id,event_type,actor_type,actor_user_id,payload)
         VALUES ($1,$2,$3,'user',$1,$4) RETURNING id`, [user.id, id, input.action, { ...input, confirmed: true }],
      );
      if (input.action !== 'open') {
        const metadataLearningId = typeof task.metadata.learningId === 'string'
          ? task.metadata.learningId
          : Array.isArray(task.metadata.learningIds) && typeof task.metadata.learningIds[0] === 'string'
            ? task.metadata.learningIds[0]
            : null;
        const learningId = metadataLearningId && z.string().uuid().safeParse(metadataLearningId).success
          ? (await client.query<{ id: string }>(
            'SELECT id FROM assistant_learnings WHERE id=$1 AND user_id=$2', [metadataLearningId, user.id],
          )).rows[0]?.id ?? null
          : null;
        const outcome = input.action === 'complete' ? 'completed'
          : input.action === 'snooze' ? 'snoozed'
            : input.action === 'reschedule' || input.action === 'comment' ? 'edited'
              : 'accepted';
        await client.query(
          `INSERT INTO assistant_action_outcomes
            (user_id,learning_id,task_id,action_type,outcome,score,context)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [user.id, learningId, id, `task.${input.action}`, outcome,
            input.action === 'complete' ? 1 : input.action === 'cancel' ? -0.25 : null,
            { taskEventId: taskEvent.rows[0]!.id, confirmed: true, ...input }],
        );
      }
      if (input.action !== 'open') {
        const version = await client.query<{ version: number }>(
          'SELECT version FROM canonical_tasks WHERE id=$1 AND user_id=$2', [id, user.id],
        );
        await queueTaskProjectionSync(client, {
          userId: user.id, taskId: id, version: version.rows[0]!.version, action: input.action,
          extra: {
            targetTaskId: input.targetTaskId ?? null,
            ...(input.action === 'comment' ? { comment: input.comment, taskEventId: taskEvent.rows[0]!.id } : {}),
          },
          ...(input.action === 'comment' ? { dedupeKey: `${id}:comment:${taskEvent.rows[0]!.id}` } : {}),
        });
      }
    });
    const task = await readTask(database, user.id, id);
    await events.publish(user.id, `task.${input.action}`, { taskId: id, targetTaskId: input.targetTaskId ?? null });
    return { task: taskJson(task), action: input.action, confirmed: true };
  });

  app.get('/reminders', async (request) => {
    const user = currentUser(request);
    const query = parseInput(z.object({
      status: z.enum(['scheduled', 'sent', 'acknowledged', 'snoozed', 'cancelled', 'ignored', 'missed']).optional(),
      taskId: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(100),
    }), request.query);
    const result = await database.query(
      `SELECT id,task_id AS "taskId",commitment_id AS "commitmentId",kind,
              schedule_type AS "scheduleType",title,message,scheduled_for AS "scheduledFor",
              recurrence,status,priority,respect_quiet_hours AS "respectQuietHours",
              last_sent_at AS "lastSentAt",acknowledged_at AS "acknowledgedAt",metadata,
              created_at AS "createdAt",updated_at AS "updatedAt"
       FROM reminders WHERE user_id=$1 AND ($2::text IS NULL OR status=$2)
         AND ($3::uuid IS NULL OR task_id=$3)
       ORDER BY scheduled_for NULLS LAST,created_at DESC LIMIT $4`,
      [user.id, query.status ?? null, query.taskId ?? null, query.limit],
    );
    return { items: result.rows };
  });

  app.post('/reminders', async (request, reply) => {
    const user = currentUser(request);
    const input = parseInput(z.object({
      taskId: z.string().uuid().nullable().optional(), commitmentId: z.string().uuid().nullable().optional(),
      kind: z.enum(['custom', 'task_due', 'urgent_24h', 'due_2h', 'follow_up', 'briefing']).default('custom'),
      scheduleType: z.enum(['absolute', 'relative', 'recurring', 'due', 'follow_up']).default('absolute'),
      title: z.string().trim().min(1).max(300), message: z.string().max(10_000).default(''),
      scheduledFor: isoDate.optional(), recurrence: z.record(z.string(), z.unknown()).optional(),
      priority: z.number().int().min(0).max(9).default(5), respectQuietHours: z.boolean().default(true),
      dedupeKey: z.string().trim().min(1).max(500).optional(), metadata: z.record(z.string(), z.unknown()).default({}),
    }).refine((value) => value.scheduledFor !== undefined || value.recurrence !== undefined,
      'Informe scheduledFor ou recurrence.'), request.body);
    const occurrenceAt = input.scheduledFor ?? materializeNextOccurrence(input.recurrence!);
    const result = await database.userTransaction(user.id, async (client) => {
      const reminder = await client.query(
        `INSERT INTO reminders
          (user_id,task_id,commitment_id,kind,schedule_type,title,message,scheduled_for,recurrence,
           priority,respect_quiet_hours,dedupe_key,metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING id,task_id AS "taskId",commitment_id AS "commitmentId",kind,
           schedule_type AS "scheduleType",title,message,scheduled_for AS "scheduledFor",recurrence,
           status,priority,respect_quiet_hours AS "respectQuietHours",metadata,
           created_at AS "createdAt",updated_at AS "updatedAt"`,
        [user.id, input.taskId ?? null, input.commitmentId ?? null, input.kind, input.scheduleType,
          input.title, input.message, occurrenceAt, input.recurrence ?? null,
          input.priority, input.respectQuietHours, input.dedupeKey ?? null, input.metadata],
      );
      await client.query(
        `INSERT INTO reminder_occurrences (user_id,reminder_id,scheduled_at,deliver_after)
         VALUES ($1,$2,$3,$3) ON CONFLICT DO NOTHING`, [user.id, reminder.rows[0]!.id, occurrenceAt],
      );
      return reminder.rows[0]!;
    });
    await events.publish(user.id, 'reminder.created', { reminderId: result.id });
    return reply.status(201).send(result);
  });

  app.patch('/reminders/:id', async (request) => {
    const user = currentUser(request);
    const { id } = parseInput(uuidParams, request.params);
    const input = parseInput(z.object({
      action: z.enum(['acknowledge', 'snooze', 'cancel', 'update']).optional(),
      title: z.string().trim().min(1).max(300).optional(), message: z.string().max(10_000).optional(),
      scheduledFor: optionalNullableDate, recurrence: z.record(z.string(), z.unknown()).nullable().optional(),
      priority: z.number().int().min(0).max(9).optional(), respectQuietHours: z.boolean().optional(),
    }).refine((value) => Object.keys(value).length > 0, 'Envie ao menos um campo.'), request.body);
    if (input.action === 'snooze' && !input.scheduledFor) {
      throw new AppError(400, 'SNOOZE_UNTIL_REQUIRED', 'Informe até quando o lembrete deve ser adiado.');
    }
    const result = await database.userTransaction(user.id, async (client) => {
      const current = await client.query<{ recurrence: Record<string, unknown> | null; scheduled_for: Date | string | null }>(
        'SELECT recurrence,scheduled_for FROM reminders WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, user.id],
      );
      if (!current.rows[0]) throw new AppError(404, 'REMINDER_NOT_FOUND', 'Lembrete não encontrado.');
      const effectiveRecurrence = Object.hasOwn(input, 'recurrence') ? input.recurrence : current.rows[0].recurrence;
      const occurrenceAt = input.scheduledFor
        ?? ((Object.hasOwn(input, 'recurrence') || (Object.hasOwn(input, 'scheduledFor') && effectiveRecurrence)) && effectiveRecurrence
          ? materializeNextOccurrence(effectiveRecurrence)
          : null);
      const schedulingChanged = Object.hasOwn(input, 'scheduledFor') || Object.hasOwn(input, 'recurrence') || input.action === 'snooze';
      if (schedulingChanged && !occurrenceAt && !effectiveRecurrence && input.action !== 'cancel') {
        throw new AppError(400, 'REMINDER_SCHEDULE_REQUIRED', 'O lembrete precisa de uma data ou recorrência.');
      }
      if (schedulingChanged || input.action === 'cancel' || input.action === 'acknowledge') {
        await client.query(
          `UPDATE reminder_occurrences SET status='cancelled',locked_by=NULL,locked_at=NULL
           WHERE user_id=$1 AND reminder_id=$2 AND status IN ('pending','failed','snoozed')`, [user.id, id],
        );
      }
      const updated = await client.query(
        `UPDATE reminders SET title=COALESCE($3,title),message=COALESCE($4,message),
           scheduled_for=CASE WHEN $5 THEN $6 ELSE scheduled_for END,
           recurrence=CASE WHEN $7 THEN $8 ELSE recurrence END,
           priority=COALESCE($9,priority),respect_quiet_hours=COALESCE($10,respect_quiet_hours),
           status=CASE $11 WHEN 'acknowledge' THEN 'acknowledged' WHEN 'snooze' THEN 'snoozed'
             WHEN 'cancel' THEN 'cancelled' ELSE CASE WHEN $5 THEN 'scheduled' ELSE status END END,
           acknowledged_at=CASE WHEN $11='acknowledge' THEN now() ELSE acknowledged_at END,
           cancelled_at=CASE WHEN $11='cancel' THEN now() ELSE cancelled_at END
         WHERE id=$1 AND user_id=$2
         RETURNING id,task_id AS "taskId",commitment_id AS "commitmentId",kind,
           schedule_type AS "scheduleType",title,message,scheduled_for AS "scheduledFor",recurrence,
           status,priority,respect_quiet_hours AS "respectQuietHours",metadata,
           created_at AS "createdAt",updated_at AS "updatedAt"`,
        [id, user.id, input.title ?? null, input.message ?? null, schedulingChanged,
          occurrenceAt, Object.hasOwn(input, 'recurrence'), input.recurrence ?? null,
          input.priority ?? null, input.respectQuietHours ?? null, input.action ?? 'update'],
      );
      if (occurrenceAt && input.action !== 'cancel' && input.action !== 'acknowledge') {
        await client.query(
          `INSERT INTO reminder_occurrences (user_id,reminder_id,scheduled_at,deliver_after,status)
           VALUES ($1,$2,$3,$3,$4)
           ON CONFLICT (user_id,reminder_id,scheduled_at) DO UPDATE SET
             deliver_after=EXCLUDED.deliver_after,status=EXCLUDED.status,attempt_count=0,
             locked_by=NULL,locked_at=NULL,last_error=NULL`,
          [user.id, id, occurrenceAt, input.action === 'snooze' ? 'snoozed' : 'pending'],
        );
      }
      return updated.rows[0]!;
    });
    await events.publish(user.id, `reminder.${input.action ?? 'updated'}`, { reminderId: id });
    return result;
  });

  app.get('/commitments', async (request) => {
    const user = currentUser(request);
    const query = parseInput(z.object({
      status: z.enum(['open', 'waiting', 'fulfilled', 'cancelled']).optional(),
      direction: z.enum(['owed_by_me', 'owed_to_me']).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }), request.query);
    const result = await database.query(
      `SELECT id,task_id AS "taskId",person_node_id AS "personNodeId",direction,title,details,
              counterpart_name AS "counterpartName",status,due_at AS "dueAt",
              next_follow_up_at AS "nextFollowUpAt",confidence,metadata,fulfilled_at AS "fulfilledAt",
              created_at AS "createdAt",updated_at AS "updatedAt"
       FROM commitments WHERE user_id=$1 AND ($2::text IS NULL OR status=$2)
         AND ($3::text IS NULL OR direction=$3)
       ORDER BY next_follow_up_at NULLS LAST,due_at NULLS LAST,updated_at DESC LIMIT $4`,
      [user.id, query.status ?? null, query.direction ?? null, query.limit],
    );
    return { items: result.rows };
  });

  app.post('/commitments', async (request, reply) => {
    const user = currentUser(request);
    const input = parseInput(z.object({
      taskId: z.string().uuid().nullable().optional(), personNodeId: z.string().uuid().nullable().optional(),
      direction: z.enum(['owed_by_me', 'owed_to_me']), title: z.string().trim().min(1).max(300),
      details: z.string().max(20_000).default(''), counterpartName: z.string().trim().max(200).nullable().optional(),
      status: z.enum(['open', 'waiting', 'fulfilled', 'cancelled']).default('open'),
      dueAt: optionalNullableDate, nextFollowUpAt: optionalNullableDate,
      sourceFingerprint: z.string().trim().min(1).max(500).optional(),
      confidence: z.number().min(0).max(1).nullable().optional(), metadata: z.record(z.string(), z.unknown()).default({}),
    }), request.body);
    const result = await database.query(
      `INSERT INTO commitments
        (user_id,task_id,person_node_id,direction,title,details,counterpart_name,status,due_at,
         next_follow_up_at,source_fingerprint,confidence,metadata,fulfilled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
         CASE WHEN $8='fulfilled' THEN now() ELSE NULL END)
       RETURNING id,task_id AS "taskId",person_node_id AS "personNodeId",direction,title,details,
         counterpart_name AS "counterpartName",status,due_at AS "dueAt",
         next_follow_up_at AS "nextFollowUpAt",confidence,metadata,fulfilled_at AS "fulfilledAt",
         created_at AS "createdAt",updated_at AS "updatedAt"`,
      [user.id, input.taskId ?? null, input.personNodeId ?? null, input.direction, input.title,
        input.details, input.counterpartName ?? null, input.status, input.dueAt ?? null,
        input.nextFollowUpAt ?? null, input.sourceFingerprint ?? null, input.confidence ?? null, input.metadata],
    );
    await events.publish(user.id, 'commitment.created', { commitmentId: result.rows[0]!.id });
    return reply.status(201).send(result.rows[0]);
  });

  app.patch('/commitments/:id', async (request) => {
    const user = currentUser(request);
    const { id } = parseInput(uuidParams, request.params);
    const input = parseInput(z.object({
      title: z.string().trim().min(1).max(300).optional(), details: z.string().max(20_000).optional(),
      status: z.enum(['open', 'waiting', 'fulfilled', 'cancelled']).optional(),
      dueAt: optionalNullableDate, nextFollowUpAt: optionalNullableDate,
    }).refine((value) => Object.keys(value).length > 0), request.body);
    const result = await database.query(
      `UPDATE commitments SET title=COALESCE($3,title),details=COALESCE($4,details),
         status=COALESCE($5,status),due_at=CASE WHEN $6 THEN $7 ELSE due_at END,
         next_follow_up_at=CASE WHEN $8 THEN $9 ELSE next_follow_up_at END,
         fulfilled_at=CASE WHEN $5='fulfilled' THEN now() WHEN $5 IS NOT NULL THEN NULL ELSE fulfilled_at END
       WHERE id=$1 AND user_id=$2
       RETURNING id,task_id AS "taskId",person_node_id AS "personNodeId",direction,title,details,
         counterpart_name AS "counterpartName",status,due_at AS "dueAt",
         next_follow_up_at AS "nextFollowUpAt",confidence,metadata,fulfilled_at AS "fulfilledAt",
         created_at AS "createdAt",updated_at AS "updatedAt"`,
      [id, user.id, input.title ?? null, input.details ?? null, input.status ?? null,
        Object.hasOwn(input, 'dueAt'), input.dueAt ?? null,
        Object.hasOwn(input, 'nextFollowUpAt'), input.nextFollowUpAt ?? null],
    );
    if (!result.rows[0]) throw new AppError(404, 'COMMITMENT_NOT_FOUND', 'Compromisso não encontrado.');
    await database.query(
      `INSERT INTO assistant_action_outcomes (user_id,task_id,action_type,outcome,score,context)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [user.id, result.rows[0].taskId ?? null, `commitment.${input.status ?? 'update'}`,
        input.status === 'fulfilled' ? 'completed' : input.status === 'cancelled' ? 'rejected' : 'edited',
        input.status === 'fulfilled' ? 1 : input.status === 'cancelled' ? -0.25 : 0.25,
        { commitmentId: id, ...input }],
    );
    await events.publish(user.id, 'commitment.updated', { commitmentId: id, status: input.status ?? null });
    return result.rows[0];
  });

  app.get('/assistant/learnings', async (request) => {
    const user = currentUser(request);
    const query = parseInput(z.object({
      status: z.enum(['suggested', 'active', 'paused', 'rejected', 'obsolete', 'forgotten', 'superseded']).optional(),
      scopeType: z.enum(['global', 'conversation', 'person', 'project']).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }), request.query);
    const result = await database.query(
      `SELECT id,supersedes_learning_id AS "supersedesLearningId",scope_type AS "scopeType",
              scope_id AS "scopeId",learning_key AS "learningKey",statement,source_type AS "sourceType",
              state AS status,confidence,evidence_count AS "evidenceCount",
              distinct_evidence_days AS "distinctEvidenceDays",requires_confirmation AS "requiresConfirmation",
              first_evidence_at AS "firstEvidenceAt",last_evidence_at AS "lastEvidenceAt",
              activated_at AS "activatedAt",review_after AS "reviewAfter",expires_at AS "expiresAt",
              last_used_at AS "lastUsedAt",version,metadata,created_at AS "createdAt",updated_at AS "updatedAt"
       FROM assistant_learnings WHERE user_id=$1 AND ($2::text IS NULL OR state=$2)
         AND ($3::text IS NULL OR scope_type=$3)
       ORDER BY CASE state WHEN 'suggested' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,updated_at DESC LIMIT $4`,
      [user.id, query.status ?? null, query.scopeType ?? null, query.limit],
    );
    return { items: result.rows };
  });

  app.post('/assistant/learnings', async (request, reply) => {
    const user = currentUser(request);
    const input = parseInput(z.object({
      scopeType: z.enum(['global', 'conversation', 'person', 'project']).default('global'),
      scopeId: z.string().trim().min(1).max(500).optional(),
      learningKey: z.string().trim().min(1).max(300),
      statement: z.string().trim().min(1).max(10_000),
      sourceType: z.enum(['explicit', 'inferred']).default('explicit'),
      confidence: z.number().min(0).max(1).default(1),
      risk: z.enum(['low', 'medium', 'high', 'destructive']).default('low'),
      metadata: z.record(z.string(), z.unknown()).default({}),
    }).refine((value) => value.scopeType === 'global' || Boolean(value.scopeId),
      'scopeId é obrigatório fora do escopo global.'), request.body);
    const explicit = input.sourceType === 'explicit';
    const result = await database.query(
      `INSERT INTO assistant_learnings
        (user_id,scope_type,scope_id,learning_key,statement,source_type,state,confidence,
         requires_confirmation,activated_at,review_after,metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id,scope_type AS "scopeType",scope_id AS "scopeId",learning_key AS "learningKey",
         statement,source_type AS "sourceType",state AS status,confidence,
         evidence_count AS "evidenceCount",distinct_evidence_days AS "distinctEvidenceDays",
         requires_confirmation AS "requiresConfirmation",activated_at AS "activatedAt",
         review_after AS "reviewAfter",version,metadata,created_at AS "createdAt",updated_at AS "updatedAt"`,
      [user.id, input.scopeType, input.scopeId ?? null, input.learningKey, input.statement,
        input.sourceType, explicit ? 'active' : 'suggested', input.confidence,
        !explicit && input.risk !== 'low', explicit ? new Date() : null,
        explicit ? null : new Date(Date.now() + 90 * 86_400_000), { ...input.metadata, risk: input.risk }],
    );
    await events.publish(user.id, 'learning.created', { learningId: result.rows[0]!.id, status: explicit ? 'active' : 'suggested' });
    return reply.status(201).send(result.rows[0]);
  });

  app.get('/assistant/learnings/:id/evidence', async (request) => {
    const user = currentUser(request);
    const { id } = parseInput(uuidParams, request.params);
    const owned = await database.query('SELECT 1 FROM assistant_learnings WHERE id=$1 AND user_id=$2', [id, user.id]);
    if (!owned.rows[0]) throw new AppError(404, 'LEARNING_NOT_FOUND', 'Aprendizado não encontrado.');
    const result = await database.query(
      `SELECT id,evidence_type AS "evidenceType",source_id AS "sourceId",excerpt,signal,weight,
              observed_at AS "observedAt",metadata,created_at AS "createdAt"
       FROM assistant_learning_evidence WHERE user_id=$1 AND learning_id=$2 ORDER BY observed_at DESC`,
      [user.id, id],
    );
    return { items: result.rows };
  });

  app.post('/assistant/learnings/:id/evidence', async (request, reply) => {
    const user = currentUser(request);
    const { id } = parseInput(uuidParams, request.params);
    const input = parseInput(z.object({
      evidenceType: z.string().trim().min(1).max(100), sourceId: z.string().trim().max(500).optional(),
      excerpt: z.string().max(10_000).default(''),
      signal: z.enum(['supports', 'contradicts', 'confirms', 'rejects']).default('supports'),
      weight: z.number().min(0).max(1).default(1), observedAt: isoDate.default(() => new Date()),
      metadata: z.record(z.string(), z.unknown()).default({}),
    }), request.body);
    const result = await database.userTransaction(user.id, async (client) => {
      const learning = await client.query<{
        source_type: string; state: string; confidence: string | number; metadata: Record<string, unknown>;
      }>('SELECT source_type,state,confidence,metadata FROM assistant_learnings WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, user.id]);
      if (!learning.rows[0]) throw new AppError(404, 'LEARNING_NOT_FOUND', 'Aprendizado não encontrado.');
      const evidence = await client.query(
        `INSERT INTO assistant_learning_evidence
          (user_id,learning_id,evidence_type,source_id,excerpt,signal,weight,observed_at,metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id,evidence_type AS "evidenceType",source_id AS "sourceId",excerpt,signal,weight,
           observed_at AS "observedAt",metadata,created_at AS "createdAt"`,
        [user.id, id, input.evidenceType, input.sourceId ?? null, input.excerpt, input.signal,
          input.weight, input.observedAt, input.metadata],
      );
      const stats = await client.query<{ evidence_count: number; evidence_days: number; first_at: Date; last_at: Date }>(
        `SELECT count(*) FILTER (WHERE signal IN ('supports','confirms'))::int AS evidence_count,
                count(DISTINCT (observed_at AT TIME ZONE 'UTC')::date)
                  FILTER (WHERE signal IN ('supports','confirms'))::int AS evidence_days,
                min(observed_at) AS first_at,max(observed_at) AS last_at
         FROM assistant_learning_evidence WHERE user_id=$1 AND learning_id=$2`, [user.id, id],
      );
      const stat = stats.rows[0]!;
      const canActivate = learning.rows[0].source_type === 'inferred'
        && learning.rows[0].state === 'suggested'
        && learning.rows[0].metadata.risk === 'low'
        && Number(learning.rows[0].confidence) >= 0.85
        && stat.evidence_count >= 3 && stat.evidence_days >= 2;
      await client.query(
        `UPDATE assistant_learnings SET evidence_count=$3,distinct_evidence_days=$4,
           first_evidence_at=$5,last_evidence_at=$6,
           state=CASE WHEN $7 THEN 'active' ELSE state END,
           activated_at=CASE WHEN $7 THEN COALESCE(activated_at,now()) ELSE activated_at END,
           review_after=CASE WHEN $7 THEN now()+interval '90 days' ELSE review_after END
         WHERE id=$1 AND user_id=$2`,
        [id, user.id, stat.evidence_count, stat.evidence_days, stat.first_at, stat.last_at, canActivate],
      );
      return { evidence: evidence.rows[0]!, activated: canActivate };
    });
    await events.publish(user.id, result.activated ? 'learning.activated' : 'learning.evidence.added', { learningId: id });
    return reply.status(201).send(result);
  });

  app.patch('/assistant/learnings/:id', async (request) => {
    const user = currentUser(request);
    const { id } = parseInput(uuidParams, request.params);
    const input = parseInput(z.object({
      action: z.enum(['confirm', 'pause', 'resume', 'reject', 'forget', 'update', 'undo']),
      statement: z.string().trim().min(1).max(10_000).optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }), request.body);
    if (input.action === 'update' && !input.statement) {
      throw new AppError(400, 'STATEMENT_REQUIRED', 'Informe o texto atualizado do aprendizado.');
    }
    const result = await database.userTransaction(user.id, async (client) => {
      const current = await client.query<{
        id: string; scope_type: string; scope_id: string | null; learning_key: string; statement: string;
        source_type: string; confidence: string | number; version: number; metadata: Record<string, unknown>;
        state: string; supersedes_learning_id: string | null;
      }>('SELECT * FROM assistant_learnings WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, user.id]);
      const row = current.rows[0];
      if (!row) throw new AppError(404, 'LEARNING_NOT_FOUND', 'Aprendizado não encontrado.');
      if (input.action === 'update') {
        await client.query("UPDATE assistant_learnings SET state='superseded' WHERE id=$1 AND user_id=$2", [id, user.id]);
        const created = await client.query(
          `INSERT INTO assistant_learnings
            (user_id,supersedes_learning_id,scope_type,scope_id,learning_key,statement,source_type,state,
             confidence,requires_confirmation,activated_at,review_after,version,metadata)
           VALUES ($1,$2,$3,$4,$5,$6,'explicit','active',1,false,now(),NULL,$7,$8)
           RETURNING id,scope_type AS "scopeType",scope_id AS "scopeId",learning_key AS "learningKey",
             statement,source_type AS "sourceType",state AS status,confidence,version,metadata,
             created_at AS "createdAt",updated_at AS "updatedAt"`,
          [user.id, id, row.scope_type, row.scope_id, row.learning_key, input.statement,
            row.version + 1, { ...row.metadata, ...(input.metadata ?? {}) }],
        );
        await client.query(
          `INSERT INTO assistant_action_outcomes (user_id,learning_id,action_type,outcome,score,context)
           VALUES ($1,$2,'learning.update','edited',0.5,$3)`,
          [user.id, id, { replacementLearningId: created.rows[0]!.id }],
        );
        return created.rows[0]!;
      }
      if (input.action === 'forget') {
        await client.query('DELETE FROM assistant_learning_evidence WHERE learning_id=$1 AND user_id=$2', [id, user.id]);
        const forgotten = await client.query(
          `UPDATE assistant_learnings SET state='forgotten',statement='[esquecido]',metadata='{}'::jsonb,
             confidence=0,evidence_count=0,distinct_evidence_days=0,expires_at=now()
           WHERE id=$1 AND user_id=$2
           RETURNING id,scope_type AS "scopeType",scope_id AS "scopeId",learning_key AS "learningKey",
             statement,source_type AS "sourceType",state AS status,confidence,version,metadata,
            created_at AS "createdAt",updated_at AS "updatedAt"`, [id, user.id],
        );
        await client.query(
          `INSERT INTO assistant_action_outcomes (user_id,learning_id,action_type,outcome,score,context)
           VALUES ($1,$2,'learning.forget','rejected',-1,$3)`, [user.id, id, { forgotten: true }],
        );
        return forgotten.rows[0]!;
      }
      if (input.action === 'undo' && row.supersedes_learning_id) {
        await client.query(
          "UPDATE assistant_learnings SET state='obsolete' WHERE id=$1 AND user_id=$2", [id, user.id],
        );
        const restored = await client.query(
          `UPDATE assistant_learnings SET state='active',requires_confirmation=false,activated_at=COALESCE(activated_at,now())
           WHERE id=$1 AND user_id=$2
           RETURNING id,scope_type AS "scopeType",scope_id AS "scopeId",learning_key AS "learningKey",
             statement,source_type AS "sourceType",state AS status,confidence,
             evidence_count AS "evidenceCount",distinct_evidence_days AS "distinctEvidenceDays",
             requires_confirmation AS "requiresConfirmation",activated_at AS "activatedAt",
             review_after AS "reviewAfter",version,metadata,created_at AS "createdAt",updated_at AS "updatedAt"`,
          [row.supersedes_learning_id, user.id],
        );
        await client.query(
          `INSERT INTO assistant_action_outcomes (user_id,learning_id,action_type,outcome,score,context)
           VALUES ($1,$2,'learning.undo','undone',0,$3)`,
          [user.id, row.supersedes_learning_id, { undoneLearningId: id }],
        );
        return restored.rows[0]!;
      }
      const state = input.action === 'confirm' || input.action === 'resume' || input.action === 'undo'
        ? 'active' : input.action === 'pause' ? 'paused' : 'rejected';
      const updated = await client.query(
        `UPDATE assistant_learnings SET state=$3,requires_confirmation=false,
           activated_at=CASE WHEN $3='active' THEN COALESCE(activated_at,now()) ELSE activated_at END,
           review_after=CASE WHEN $3='active' AND source_type='inferred' THEN now()+interval '90 days' ELSE review_after END,
           metadata=metadata || COALESCE($4,'{}'::jsonb)
         WHERE id=$1 AND user_id=$2
         RETURNING id,scope_type AS "scopeType",scope_id AS "scopeId",learning_key AS "learningKey",
           statement,source_type AS "sourceType",state AS status,confidence,
           evidence_count AS "evidenceCount",distinct_evidence_days AS "distinctEvidenceDays",
           requires_confirmation AS "requiresConfirmation",activated_at AS "activatedAt",
           review_after AS "reviewAfter",version,metadata,created_at AS "createdAt",updated_at AS "updatedAt"`,
        [id, user.id, state, input.metadata ?? null],
      );
      await client.query(
        `INSERT INTO assistant_action_outcomes (user_id,learning_id,action_type,outcome,score,context)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [user.id, id, `learning.${input.action}`,
          input.action === 'confirm' || input.action === 'resume' ? 'accepted'
            : input.action === 'reject' ? 'rejected' : 'undone',
          input.action === 'confirm' || input.action === 'resume' ? 1 : input.action === 'reject' ? -1 : 0,
          { previousState: row.state }],
      );
      return updated.rows[0]!;
    });
    await events.publish(user.id, `learning.${input.action}`, { learningId: result.id, previousLearningId: id });
    return result;
  });

  app.get('/assistant/outcomes', async (request) => {
    const user = currentUser(request);
    const query = parseInput(z.object({ learningId: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }), request.query);
    const result = await database.query(
      `SELECT id,learning_id AS "learningId",task_id AS "taskId",action_type AS "actionType",
              outcome,score,context,occurred_at AS "occurredAt",created_at AS "createdAt"
       FROM assistant_action_outcomes WHERE user_id=$1 AND ($2::uuid IS NULL OR learning_id=$2)
       ORDER BY occurred_at DESC LIMIT $3`, [user.id, query.learningId ?? null, query.limit],
    );
    return { items: result.rows };
  });

  app.post('/assistant/outcomes', async (request, reply) => {
    const user = currentUser(request);
    const input = parseInput(z.object({
      learningId: z.string().uuid().nullable().optional(), taskId: z.string().uuid().nullable().optional(),
      actionType: z.string().trim().min(1).max(100),
      outcome: z.enum(['accepted', 'edited', 'completed', 'snoozed', 'rejected', 'undone', 'failed']),
      score: z.number().min(-1).max(1).nullable().optional(),
      context: z.record(z.string(), z.unknown()).default({}), occurredAt: isoDate.default(() => new Date()),
    }), request.body);
    const result = await database.query(
      `INSERT INTO assistant_action_outcomes
        (user_id,learning_id,task_id,action_type,outcome,score,context,occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id,learning_id AS "learningId",task_id AS "taskId",action_type AS "actionType",
         outcome,score,context,occurred_at AS "occurredAt",created_at AS "createdAt"`,
      [user.id, input.learningId ?? null, input.taskId ?? null, input.actionType, input.outcome,
        input.score ?? null, input.context, input.occurredAt],
    );
    await events.publish(user.id, 'assistant.outcome.recorded', { outcomeId: result.rows[0]!.id });
    return reply.status(201).send(result.rows[0]);
  });

  app.get('/assistant/proposals', async (request) => {
    const user = currentUser(request);
    const query = parseInput(z.object({
      status: z.enum(['pending', 'confirmed', 'edited', 'cancelled', 'executing', 'completed', 'failed']).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }), request.query);
    const result = await database.query(
      `SELECT id,thread_id AS "threadId",chat_message_id AS "chatMessageId",proposal_type AS "proposalType",
              title,description,status,risk,reversible,requires_confirmation AS "requiresConfirmation",
              proposed_payload AS "proposedPayload",edited_payload AS "editedPayload",evidence,
              confirmed_at AS "confirmedAt",cancelled_at AS "cancelledAt",executed_at AS "executedAt",
              error_message AS "errorMessage",metadata,created_at AS "createdAt",updated_at AS "updatedAt"
       FROM action_proposals WHERE user_id=$1 AND ($2::text IS NULL OR status=$2)
       ORDER BY created_at DESC LIMIT $3`, [user.id, query.status ?? null, query.limit],
    );
    return { items: result.rows };
  });

  app.patch('/assistant/proposals/:id', async (request) => {
    const user = currentUser(request);
    const { id } = parseInput(uuidParams, request.params);
    const input = parseInput(z.object({
      action: z.enum(['confirm', 'edit', 'cancel', 'always']),
      patch: z.record(z.string(), z.unknown()).optional(),
    }), request.body);
    if (input.action === 'edit' && !input.patch) throw new AppError(400, 'PATCH_REQUIRED', 'Informe as alterações da proposta.');
    const result = await database.userTransaction(user.id, async (client) => {
      const current = await client.query<{
        id: string; proposal_type: string; title: string; description: string; status: string;
        reversible: boolean; risk: string; proposed_payload: Record<string, unknown>; edited_payload: Record<string, unknown> | null;
      }>('SELECT * FROM action_proposals WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, user.id]);
      const proposal = current.rows[0];
      if (!proposal) throw new AppError(404, 'PROPOSAL_NOT_FOUND', 'Proposta não encontrada.');
      if (!['pending', 'edited'].includes(proposal.status)) {
        throw new AppError(409, 'PROPOSAL_ALREADY_DECIDED', 'Esta proposta já foi decidida.');
      }
      if (input.action === 'always' && !canAutoExecuteProposal({
        reversible: proposal.reversible, risk: proposal.risk, proposalType: proposal.proposal_type,
      })) {
        throw new AppError(422, 'ALWAYS_NOT_ALLOWED', 'Ações irreversíveis ou destrutivas não podem ser automatizadas.');
      }
      if (input.action === 'edit') {
        await client.query(
          `UPDATE action_proposals SET status='edited',edited_payload=COALESCE(edited_payload,proposed_payload) || $3::jsonb
           WHERE id=$1 AND user_id=$2`, [id, user.id, input.patch],
        );
      } else if (input.action === 'cancel') {
        await client.query(
          "UPDATE action_proposals SET status='cancelled',cancelled_at=now() WHERE id=$1 AND user_id=$2",
          [id, user.id],
        );
      } else {
        await client.query(
          "UPDATE action_proposals SET status='confirmed',confirmed_at=now() WHERE id=$1 AND user_id=$2",
          [id, user.id],
        );
        if (input.action === 'always') {
          await client.query(
            `INSERT INTO assistant_learnings
              (user_id,scope_type,learning_key,statement,source_type,state,confidence,requires_confirmation,activated_at,metadata)
             VALUES ($1,'global',$2,$3,'explicit','active',1,false,now(),$4)
             ON CONFLICT (user_id,scope_type,scope_id,learning_key,version)
             DO UPDATE SET statement=EXCLUDED.statement,state='active',source_type='explicit',confidence=1,
               requires_confirmation=false,activated_at=COALESCE(assistant_learnings.activated_at,now()),
               expires_at=NULL,review_after=NULL,
               metadata=assistant_learnings.metadata || EXCLUDED.metadata,updated_at=now()`,
            [user.id, alwaysLearningKey(proposal.proposal_type),
              `Executar automaticamente propostas reversíveis do tipo ${proposal.proposal_type}`,
              { lastConfirmedProposalId: id, reversibleOnly: true }],
          );
        }
        await client.query(
          `INSERT INTO job_attempts (user_id,job_type,job_key,status,input)
           VALUES ($1,'action_proposal:execute',$2,'queued',$3)`,
          [user.id, `proposal:${id}`, { proposalId: id, confirmedBy: user.id, always: input.action === 'always' }],
        );
      }
      await client.query(
        `INSERT INTO assistant_action_outcomes (user_id,action_type,outcome,score,context)
         VALUES ($1,$2,$3,$4,$5)`,
        [user.id, `proposal.${proposal.proposal_type}.${input.action}`,
          input.action === 'edit' ? 'edited' : input.action === 'cancel' ? 'rejected' : 'accepted',
          input.action === 'cancel' ? -1 : input.action === 'edit' ? 0.25 : 1,
          { proposalId: id, reversible: proposal.reversible, risk: proposal.risk }],
      );
      const updated = await client.query(
        `SELECT id,thread_id AS "threadId",chat_message_id AS "chatMessageId",proposal_type AS "proposalType",
                title,description,status,risk,reversible,requires_confirmation AS "requiresConfirmation",
                proposed_payload AS "proposedPayload",edited_payload AS "editedPayload",evidence,
                confirmed_at AS "confirmedAt",cancelled_at AS "cancelledAt",executed_at AS "executedAt",
                error_message AS "errorMessage",metadata,created_at AS "createdAt",updated_at AS "updatedAt"
         FROM action_proposals WHERE id=$1 AND user_id=$2`, [id, user.id],
      );
      return updated.rows[0]!;
    });
    await events.publish(user.id, `proposal.${input.action}`, { proposalId: id });
    return result;
  });
}
