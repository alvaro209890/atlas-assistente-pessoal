import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser } from '../auth.js';
import { AppError, parseInput } from '../errors.js';
import { EventHub } from '../events.js';
import type { AppDatabase } from '../types.js';
import { syncWikilinkEdgesInTransaction } from '../wikilinks.js';
import type { BrainNodeRow } from './brain.js';
import { ianaTimezone } from '../timezone.js';

interface PlatformDeps {
  database: AppDatabase;
  events: EventHub;
}

interface SettingsRow {
  timezone: string;
  locale: string;
  ai_provider: string;
  ai_model: string;
  reasoning_effort: string;
  reminder_times: string[];
  feature_flags: Record<string, unknown>;
  updated_at: Date | string;
}

function noteJson(row: BrainNodeRow) {
  const content = [row.manual_content, row.generated_content].filter(Boolean).join('\n\n');
  return {
    id: row.id,
    title: row.title,
    excerpt: content.replace(/[#*_>\[\]`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 180),
    updatedAt: new Date(row.updated_at).toISOString(),
    tags: row.tags,
    pinned: row.metadata.pinned === true,
    source: row.source_type === 'whatsapp' ? 'whatsapp' : row.source_type === 'trello' ? 'trello' : 'manual',
    contentMarkdown: row.manual_content,
    generatedContentMarkdown: row.generated_content,
  };
}

export function normalizeTrelloLabels(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  const normalized = labels.flatMap((label) => {
    if (typeof label === 'string') return [label.trim()];
    if (!label || typeof label !== 'object') return [];
    const value = label as { name?: unknown; color?: unknown };
    if (typeof value.name === 'string' && value.name.trim()) return [value.name.trim()];
    if (typeof value.color === 'string' && value.color.trim()) return [value.color.trim()];
    return [];
  }).filter(Boolean);
  return [...new Set(normalized)];
}

export interface OnboardingPrerequisiteSnapshot {
  preferredName: string;
  professionalArea: string | null;
  goals: string[];
  workDays: number[];
  whatsappConnected: boolean;
  trelloConnected: boolean;
  mappingComplete: boolean;
  selectedChatCount: number;
  validSelectedChatCount: number;
}

export function assertOnboardingPrerequisites(snapshot: OnboardingPrerequisiteSnapshot): void {
  if (!snapshot.preferredName.trim() || !snapshot.professionalArea?.trim()
    || !snapshot.goals.some((goal) => goal.trim()) || snapshot.workDays.length === 0) {
    throw new AppError(409, 'ONBOARDING_PROFILE_INCOMPLETE',
      'Complete seu perfil: informe nome preferido, área de atuação, ao menos um objetivo e os dias de trabalho.',
      { step: 'profile' });
  }
  if (!snapshot.whatsappConnected) {
    throw new AppError(409, 'ONBOARDING_WHATSAPP_NOT_CONNECTED',
      'Conecte o WhatsApp e aguarde o status Conectado antes de continuar.', { step: 'whatsapp' });
  }
  if (!snapshot.trelloConnected) {
    throw new AppError(409, 'ONBOARDING_TRELLO_NOT_CONNECTED',
      'Autorize sua conta do Trello antes de continuar.', { step: 'trello' });
  }
  if (!snapshot.mappingComplete) {
    throw new AppError(409, 'ONBOARDING_TRELLO_MAPPING_INCOMPLETE',
      'Escolha um quadro e mapeie as listas Entrada, Em andamento, Pausado e Concluído.',
      { step: 'mapping' });
  }
  if (snapshot.selectedChatCount === 0) {
    throw new AppError(409, 'ONBOARDING_CHAT_REQUIRED',
      'Selecione ao menos uma conversa do WhatsApp para o Atlas acompanhar.', { step: 'chats' });
  }
  if (snapshot.validSelectedChatCount !== snapshot.selectedChatCount) {
    throw new AppError(422, 'ONBOARDING_CHAT_INVALID',
      'Uma das conversas selecionadas não pertence ao seu WhatsApp conectado. Atualize a lista e tente novamente.',
      { step: 'chats' });
  }
}

const automationKindSchema = z.enum(['briefing', 'deadline', 'overdue', 'follow_up', 'stale_task', 'weekly_review']);
type AutomationKind = z.infer<typeof automationKindSchema>;
const automationNames: Record<AutomationKind, string> = {
  briefing: 'Briefing pessoal', deadline: 'Prazo próximo', overdue: 'Itens vencidos',
  follow_up: 'Resposta pendente', stale_task: 'Tarefa parada', weekly_review: 'Revisão semanal',
};

export function canonicalAutomationDefinition(kind: AutomationKind, requestedTime?: string): {
  name: string; schedule: string; config: Record<string, unknown>;
} {
  const time = requestedTime ?? (kind === 'weekly_review' ? '09:00' : '08:00');
  const [hour, minute] = time.split(':').map(Number);
  const timedSchedule = `${minute} ${hour} * * ${kind === 'weekly_review' ? '1' : '*'}`;
  const schedule = kind === 'briefing' || kind === 'weekly_review' ? timedSchedule
    : kind === 'deadline' ? '*/15 * * * *'
      : kind === 'overdue' ? '0 * * * *'
        : kind === 'follow_up' ? '*/30 * * * *'
          : '0 9 * * *';
  return {
    name: automationNames[kind], schedule,
    config: { canonicalKind: kind, ...(kind === 'briefing' || kind === 'weekly_review' ? { time } : {}) },
  };
}

export async function registerPlatformRoutes(app: FastifyInstance, deps: PlatformDeps): Promise<void> {
  const { database, events } = deps;
  const uuidParams = z.object({ id: z.string().uuid() });

  app.get('/onboarding', async (request) => {
    const user = currentUser(request);
    const [settings, whatsapp, trello, mapping, monitored] = await Promise.all([
      database.query<{
        feature_flags: Record<string, unknown>; preferred_name: string; full_name: string | null;
        professional_area: string | null; goals: string[]; timezone: string; locale: string;
        work_days: number[]; work_start: string; work_end: string; quiet_start: string; quiet_end: string;
        communication_style: string;
      }>(
        `SELECT s.feature_flags,u.preferred_name,u.full_name,p.professional_area,p.goals,
                s.timezone,s.locale,s.work_days,s.work_start::text,s.work_end::text,
                s.quiet_start::text,s.quiet_end::text,s.communication_style
         FROM user_settings s JOIN users u ON u.id=s.user_id
         JOIN user_profiles p ON p.user_id=s.user_id WHERE s.user_id=$1`, [user.id],
      ),
      database.query<{
        id: string; status: string; pairing_qr: string | null; phone_number: string | null; last_error: string | null;
      }>(
        `SELECT id,status,pairing_qr,phone_number,last_error FROM whatsapp_connections
         WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [user.id],
      ),
      database.query('SELECT 1 FROM trello_connections WHERE user_id=$1 AND status=$2 LIMIT 1', [user.id, 'connected']),
      database.query(
        `SELECT 1 FROM trello_board_configs
         WHERE user_id=$1 AND is_active=true
           AND inbox_list_id IS NOT NULL AND in_progress_list_id IS NOT NULL
           AND paused_list_id IS NOT NULL AND done_list_id IS NOT NULL
        LIMIT 1`, [user.id],
      ),
      database.query('SELECT 1 FROM monitored_chats WHERE user_id=$1 AND enabled=true LIMIT 1', [user.id]),
    ]);
    const profile = settings.rows[0];
    const flags = profile?.feature_flags ?? {};
    const wa = whatsapp.rows[0];
    const whatsappStatus = !wa ? null
      : wa.status === 'pairing' ? (wa.pairing_qr ? 'qr' : 'connecting')
        : wa.status === 'connected' ? 'connected'
          : wa.status === 'reconnecting' ? 'connecting'
            : wa.status === 'error' ? 'error' : 'disconnected';
    const profileReady = Boolean(profile?.preferred_name.trim() && profile.professional_area?.trim() && profile.goals.some((goal) => goal.trim()));
    const inferredStep = monitored.rows[0] ? 6 : mapping.rows[0] ? 5 : trello.rows[0] ? 4
      : wa?.status === 'connected' ? 3 : wa ? 2 : profileReady ? 1 : 0;
    const persistedStep = typeof flags.onboardingStep === 'number' ? flags.onboardingStep : 0;
    return {
      step: flags.onboardingComplete === true ? 7 : Math.min(6, Math.max(persistedStep, inferredStep)),
      totalSteps: 7,
      profile: profile ? {
        preferredName: profile.preferred_name,
        fullName: profile.full_name,
        occupation: profile.professional_area,
        goals: profile.goals,
        timezone: profile.timezone,
        locale: profile.locale,
        workDays: profile.work_days.map((day) => day === 0 ? 7 : day).sort((left, right) => left - right),
        workStart: profile.work_start.slice(0, 5),
        workEnd: profile.work_end.slice(0, 5),
        quietStart: profile.quiet_start.slice(0, 5),
        quietEnd: profile.quiet_end.slice(0, 5),
        communicationStyle: profile.communication_style,
      } : null,
      whatsapp: wa ? {
        id: wa.id,
        status: whatsappStatus,
        qrDataUrl: wa.pairing_qr,
        phoneLabel: wa.phone_number,
        error: wa.last_error,
      } : null,
      trelloConnected: Boolean(trello.rows[0]),
      selectedChatIds: Array.isArray(flags.selectedChatIds) ? flags.selectedChatIds : [],
    };
  });

  app.post('/onboarding/complete', async (request) => {
    const user = currentUser(request);
    const input = parseInput(z.object({
      selectedChatIds: z.array(z.string().uuid()).max(500).default([]),
      notifySelf: z.boolean().default(true),
    }), request.body);
    const selectedChatIds = [...new Set(input.selectedChatIds)];
    const identity = await database.userTransaction(user.id, async (client) => {
      const profile = await client.query<{
        preferred_name: string; full_name: string | null; professional_area: string | null;
        goals: string[]; work_days: number[];
      }>(
        `SELECT u.preferred_name,u.full_name,p.professional_area,p.goals,s.work_days
         FROM users u JOIN user_profiles p ON p.user_id=u.id JOIN user_settings s ON s.user_id=u.id
         WHERE u.id=$1 FOR KEY SHARE OF u,p,s`, [user.id],
      );
      const whatsapp = await client.query<{ id: string }>(
        `SELECT id FROM whatsapp_connections WHERE user_id=$1 AND status='connected'
         ORDER BY updated_at DESC LIMIT 1 FOR KEY SHARE`, [user.id],
      );
      const trello = await client.query<{ id: string }>(
        `SELECT id FROM trello_connections WHERE user_id=$1 AND status='connected'
         ORDER BY updated_at DESC LIMIT 1 FOR KEY SHARE`, [user.id],
      );
      const mapping = await client.query<{ id: string }>(
        `SELECT bc.id FROM trello_board_configs bc
         JOIN trello_connections tc ON tc.id=bc.trello_connection_id AND tc.user_id=bc.user_id
         WHERE bc.user_id=$1 AND bc.is_active=true AND tc.status='connected'
           AND btrim(bc.board_id)<>'' AND bc.inbox_list_id IS NOT NULL
           AND bc.in_progress_list_id IS NOT NULL AND bc.paused_list_id IS NOT NULL
           AND bc.done_list_id IS NOT NULL
         ORDER BY bc.updated_at DESC LIMIT 1 FOR KEY SHARE OF bc,tc`, [user.id],
      );
      const validChats = selectedChatIds.length ? await client.query<{ id: string }>(
        `SELECT mc.id FROM monitored_chats mc
         JOIN whatsapp_connections wc ON wc.id=mc.whatsapp_connection_id AND wc.user_id=mc.user_id
         WHERE mc.user_id=$1 AND mc.id=ANY($2::uuid[]) AND wc.status='connected'
         FOR KEY SHARE OF mc,wc`, [user.id, selectedChatIds],
      ) : { rows: [] as Array<{ id: string }> };
      const row = profile.rows[0];
      assertOnboardingPrerequisites({
        preferredName: row?.preferred_name ?? '',
        professionalArea: row?.professional_area ?? null,
        goals: row?.goals ?? [],
        workDays: row?.work_days ?? [],
        whatsappConnected: Boolean(whatsapp.rows[0]),
        trelloConnected: Boolean(trello.rows[0]),
        mappingComplete: Boolean(mapping.rows[0]),
        selectedChatCount: selectedChatIds.length,
        validSelectedChatCount: validChats.rows.length,
      });
      await client.query('UPDATE monitored_chats SET enabled=false WHERE user_id=$1', [user.id]);
      await client.query(
        'UPDATE monitored_chats SET enabled=true WHERE user_id=$1 AND id=ANY($2::uuid[])',
        [user.id, selectedChatIds],
      );
      await client.query(
        `UPDATE user_settings SET feature_flags=feature_flags || $2::jsonb WHERE user_id=$1`,
        [user.id, { onboardingComplete: true, onboardingStep: 7, selectedChatIds, notifySelf: input.notifySelf }],
      );
      return { preferredName: row!.preferred_name, fullName: row!.full_name };
    });
    await events.publish(user.id, 'onboarding.completed', { selectedChatCount: selectedChatIds.length });
    return {
      user: {
        id: user.id, name: identity.preferredName, preferredName: identity.preferredName,
        fullName: identity.fullName, email: user.email, avatarUrl: null,
      },
      onboardingComplete: true,
    };
  });

  app.get('/config', async (request) => {
    const user = currentUser(request);
    const result = await database.query<SettingsRow>(
      `SELECT timezone,locale,ai_provider,ai_model,reasoning_effort,reminder_times,feature_flags,updated_at
       FROM user_settings WHERE user_id=$1`, [user.id],
    );
    const row = result.rows[0];
    if (!row) throw new AppError(404, 'SETTINGS_NOT_FOUND', 'Configurações não encontradas.');
    return {
      timezone: row.timezone, locale: row.locale,
      ai: { provider: row.ai_provider, model: row.ai_model, reasoningEffort: row.reasoning_effort },
      reminderTimes: row.reminder_times, featureFlags: row.feature_flags,
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  });

  app.patch('/config', async (request) => {
    const user = currentUser(request);
    const input = parseInput(z.object({
      timezone: ianaTimezone.optional(), locale: z.string().min(2).max(20).optional(),
      aiModel: z.literal('deepseek-v4-flash').optional(),
      reminderTimes: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).max(12).optional(),
      featureFlags: z.record(z.string(), z.unknown()).optional(),
    }).refine((value) => Object.keys(value).length > 0), request.body);
    const result = await database.query<SettingsRow>(
      `UPDATE user_settings SET timezone=COALESCE($2,timezone),locale=COALESCE($3,locale),
         ai_model=COALESCE($4,ai_model),reasoning_effort='high',
         reminder_times=COALESCE($5::jsonb,reminder_times),feature_flags=feature_flags || COALESCE($6::jsonb,'{}'::jsonb)
       WHERE user_id=$1
       RETURNING timezone,locale,ai_provider,ai_model,reasoning_effort,reminder_times,feature_flags,updated_at`,
      [user.id, input.timezone ?? null, input.locale ?? null, input.aiModel ?? null,
        input.reminderTimes ? JSON.stringify(input.reminderTimes) : null,
        input.featureFlags ? JSON.stringify(input.featureFlags) : null],
    );
    await events.publish(user.id, 'config.updated');
    const row = result.rows[0]!;
    return { timezone: row.timezone, locale: row.locale,
      ai: { provider: row.ai_provider, model: row.ai_model, reasoningEffort: row.reasoning_effort },
      reminderTimes: row.reminder_times, featureFlags: row.feature_flags };
  });

  app.get('/dashboard', async (request) => {
    const user = currentUser(request);
    const result = await database.query<{
      nodes: string; inbox: string; connections: string; tasks: string; ai_runs_today: string;
    }>(
      `SELECT
        (SELECT count(*) FROM brain_nodes WHERE user_id=$1 AND status <> 'deleted') AS nodes,
        (SELECT count(*) FROM brain_nodes WHERE user_id=$1 AND status='inbox') AS inbox,
        ((SELECT count(*) FROM whatsapp_connections WHERE user_id=$1 AND status='connected') +
         (SELECT count(*) FROM trello_connections WHERE user_id=$1 AND status='connected')) AS connections,
        (SELECT count(*) FROM brain_nodes WHERE user_id=$1 AND type='task' AND status NOT IN ('done','deleted','archived')) AS tasks,
        (SELECT count(*) FROM ai_runs WHERE user_id=$1 AND created_at >= current_date) AS ai_runs_today`, [user.id],
    );
    const row = result.rows[0]!;
    return { stats: { notes: Number(row.nodes), inbox: Number(row.inbox), connections: Number(row.connections),
      openTasks: Number(row.tasks), aiRunsToday: Number(row.ai_runs_today) } };
  });

  app.get('/workspace/bootstrap', async (request) => {
    const user = currentUser(request);
    const [nodes, activity, cards, automations, edges, counts, usage, workspaceSettings, latestAiBrief, assistantInbox] = await Promise.all([
      database.query<BrainNodeRow>(
        `SELECT id,user_id,type,domain,title,manual_content,generated_content,status,aliases,tags,
                source_type,source_id,source_url,happened_at,metadata,version,created_at,updated_at
         FROM brain_nodes WHERE user_id=$1 AND status <> 'deleted' ORDER BY updated_at DESC LIMIT 200`, [user.id],
      ),
      database.query<{ id: string; event_type: string; payload: Record<string, unknown>; created_at: Date | string; topic: string }>(
        `SELECT id::text,event_type,payload,created_at,topic FROM event_outbox
         WHERE user_id=$1 ORDER BY id DESC LIMIT 20`, [user.id],
      ),
      database.query<{ id: string; title: string; list_name: string; due_at: Date | string | null; labels: unknown }>(
        `SELECT id,title,list_name,due_at,labels FROM trello_cards
         WHERE user_id=$1 AND closed=false ORDER BY due_at NULLS LAST,updated_at DESC LIMIT 100`, [user.id],
      ),
      database.query<{
        id: string; name: string; kind: string; enabled: boolean; last_run_at: Date | string | null;
        last_run_status: string | null; last_error: string | null;
      }>(
        `SELECT id,name,kind,enabled,last_run_at,last_run_status,last_error FROM automations
         WHERE user_id=$1 ORDER BY created_at LIMIT 100`, [user.id],
      ),
      database.query<{ from_node_id: string; to_node_id: string }>(
        `SELECT from_node_id,to_node_id FROM brain_edges WHERE user_id=$1 LIMIT 500`, [user.id],
      ),
      database.query<{ inbox: string; connections: string; whatsapp: string; trello: string; monitored: string; tasks: string }>(
        `SELECT
          (SELECT count(*) FROM brain_nodes WHERE user_id=$1 AND status='inbox') AS inbox,
          (SELECT count(*) FROM whatsapp_connections WHERE user_id=$1 AND status='connected') AS whatsapp,
          (SELECT count(*) FROM trello_connections WHERE user_id=$1 AND status='connected') AS trello,
          (SELECT count(*) FROM monitored_chats WHERE user_id=$1 AND enabled=true) AS monitored,
          ((SELECT count(*) FROM whatsapp_connections WHERE user_id=$1 AND status='connected') +
           (SELECT count(*) FROM trello_connections WHERE user_id=$1 AND status='connected')) AS connections,
          (SELECT count(*) FROM brain_nodes WHERE user_id=$1 AND type='task' AND status NOT IN ('done','deleted','archived')) AS tasks`, [user.id],
      ),
      database.query<{
        calls: string; tokens: string; latency_ms: string | null; errors: string; cost_micros: string;
      }>(
        `SELECT count(*)::text AS calls,
                COALESCE(sum(prompt_tokens + completion_tokens),0)::text AS tokens,
                avg(latency_ms) FILTER (WHERE latency_ms IS NOT NULL)::text AS latency_ms,
                count(*) FILTER (WHERE status='failed')::text AS errors,
                COALESCE(sum(cost_micros),0)::text AS cost_micros
         FROM ai_runs WHERE user_id=$1 AND created_at >= now() - interval '30 days'`, [user.id],
      ),
      database.query<{ timezone: string; reminder_times: string[]; feature_flags: Record<string, unknown> }>(
        'SELECT timezone,reminder_times,feature_flags FROM user_settings WHERE user_id=$1', [user.id],
      ),
      database.query<{ brief: string | null }>(
        `SELECT NULLIF(output->>'briefReason','') AS brief
         FROM ai_runs
         WHERE user_id=$1 AND purpose='whatsapp_triage' AND status='succeeded'
         ORDER BY completed_at DESC NULLS LAST LIMIT 1`,
        [user.id],
      ),
      database.query<{
        id: string; kind: 'task' | 'conflict' | 'duplicate' | 'learning' | 'memory';
        title: string; description: string; confidence: number | null;
        created_at: Date | string; target_id: string | null; total: number;
      }>(
        `WITH task_candidates AS (
           SELECT t.id,t.brain_node_id,t.title,t.description,t.next_action,t.status,t.confidence,t.created_at,
             (t.metadata ?| ARRAY['possibleDuplicateOf','duplicateOf','duplicateTaskId'] OR EXISTS (
               SELECT 1 FROM brain_edges e WHERE e.user_id=t.user_id AND e.relation_type='possible_duplicate'
                 AND t.brain_node_id IS NOT NULL
                 AND (e.from_node_id=t.brain_node_id OR e.to_node_id=t.brain_node_id)
             )) AS is_duplicate
           FROM canonical_tasks t WHERE t.user_id=$1 AND t.status NOT IN ('done','cancelled','merged')
         ), inbox_items AS (
         SELECT 'task:'||id::text AS id,CASE WHEN is_duplicate THEN 'duplicate' ELSE 'task' END AS kind,
                title,COALESCE(NULLIF(description,''),NULLIF(next_action,''),'Tarefa aguardando confirmação.') AS description,
                confidence::float8 AS confidence,created_at,id::text AS target_id
         FROM task_candidates WHERE is_duplicate OR confidence<0.70 OR status='inbox'
         UNION ALL
         SELECT 'conflict:'||l.id::text,'conflict',t.title,
                COALESCE(NULLIF(l.last_error,''),'A sincronização com o Trello está marcada como conflito.'),
                t.confidence::float8,l.updated_at,t.id::text
         FROM task_trello_links l JOIN canonical_tasks t ON t.id=l.task_id AND t.user_id=l.user_id
         WHERE l.user_id=$1 AND l.sync_status='conflict'
         UNION ALL
         SELECT 'learning:'||a.id::text,'learning','Aprendizado sugerido',a.statement,
                a.confidence::float8,a.created_at,a.id::text
         FROM assistant_learnings a WHERE a.user_id=$1 AND a.state='suggested'
         UNION ALL
         SELECT 'memory:'||n.id::text,
                CASE WHEN n.metadata ?| ARRAY['possibleDuplicateOf','duplicateOf'] OR EXISTS (
                  SELECT 1 FROM brain_edges e WHERE e.user_id=n.user_id AND e.relation_type='possible_duplicate'
                    AND (e.from_node_id=n.id OR e.to_node_id=n.id)
                ) THEN 'duplicate' ELSE 'memory' END,
                n.title,left(COALESCE(NULLIF(n.manual_content,''),NULLIF(n.generated_content,''),'Memória aguardando organização.'),500),
                CASE WHEN (n.metadata->>'confidence') ~ '^[0-9]+([.][0-9]+)?$'
                  THEN (n.metadata->>'confidence')::float8 ELSE NULL END,n.created_at,n.id::text
         FROM brain_nodes n WHERE n.user_id=$1 AND n.status='inbox'
           AND NOT EXISTS (SELECT 1 FROM canonical_tasks t WHERE t.user_id=n.user_id AND t.brain_node_id=n.id)
         )
         SELECT inbox_items.*,count(*) OVER()::int AS total FROM inbox_items
         ORDER BY created_at DESC LIMIT 200`, [user.id],
      ),
    ]);
    const noteRows = nodes.rows.filter((row) => ['note', 'meeting', 'decision'].includes(row.type));
    const projectRows = nodes.rows.filter((row) => row.type === 'project');
    const peopleRows = nodes.rows.filter((row) => row.type === 'person');
    const taskRows = nodes.rows.filter((row) => row.type === 'task' && !['done', 'deleted', 'archived'].includes(row.status));
    const settingsRow = workspaceSettings.rows[0];
    let hour = new Date().getUTCHours();
    try {
      hour = Number(new Intl.DateTimeFormat('en-US', {
        timeZone: settingsRow?.timezone ?? 'UTC', hour: '2-digit', hourCycle: 'h23',
      }).format(new Date()));
    } catch {
      // Legacy invalid values fall back to UTC; new writes are validated.
    }
    const greeting = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
    const usageRow = usage.rows[0];
    const usageCalls = Number(usageRow?.calls ?? 0);
    const usageErrors = Number(usageRow?.errors ?? 0);
    const generatedSummary = nodes.rows.find((row) =>
      ['daily_summary', 'weekly_review', 'consolidated_summary'].includes(row.type),
    );
    const fallbackBrief = taskRows.length > 0
      ? `${taskRows.length} prioridade${taskRows.length === 1 ? '' : 's'} aberta${taskRows.length === 1 ? '' : 's'}. Comece por “${taskRows[0]!.title}”.`
      : 'Nenhuma prioridade urgente foi identificada. Use o Inbox para capturar o próximo assunto importante.';
    return {
      greeting: `${greeting}, ${user.displayName.split(' ')[0] ?? user.displayName}`,
      briefing: latestAiBrief.rows[0]?.brief
        ?? generatedSummary?.generated_content.slice(0, 500)
        ?? fallbackBrief,
      focus: taskRows.slice(0, 8).map((row) => ({
        id: row.id, title: row.title, project: String(row.metadata.project ?? row.domain),
        dueLabel: String(row.metadata.dueLabel ?? 'Sem prazo'),
        priority: ['high', 'medium', 'low'].includes(String(row.metadata.priority)) ? row.metadata.priority : 'medium',
        completed: row.status === 'done',
      })),
      activities: activity.rows.map((row) => ({
        id: row.id, title: row.event_type, detail: String(row.payload.title ?? row.payload.message ?? ''),
        at: new Date(row.created_at).toISOString(),
        kind: ['whatsapp', 'trello', 'ai'].includes(row.topic) ? row.topic : 'note',
      })),
      notes: noteRows.map(noteJson),
      inboxItems: nodes.rows.filter((row) => row.status === 'inbox').map(noteJson),
      assistantInbox: assistantInbox.rows.map((row) => ({
        id: row.id, kind: row.kind, title: row.title, description: row.description,
        ...(row.confidence === null ? {} : { confidence: Number(row.confidence) }),
        createdAt: new Date(row.created_at).toISOString(), targetId: row.target_id,
      })),
      projects: projectRows.map((row) => ({
        id: row.id, name: row.title, description: (row.manual_content || row.generated_content).slice(0, 240),
        progress: Number(row.metadata.progress ?? 0),
        status: ['active', 'paused', 'done'].includes(row.status) ? row.status : 'active',
        noteCount: edges.rows.filter((edge) => edge.to_node_id === row.id || edge.from_node_id === row.id).length,
        people: Array.isArray(row.metadata.people) ? row.metadata.people : [], accent: String(row.metadata.accent ?? '#7c5cff'),
      })),
      people: peopleRows.map((row) => ({
        id: row.id, name: row.title, role: String(row.metadata.role ?? row.domain),
        initials: row.title.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase(),
        lastContext: (row.manual_content || row.generated_content).slice(0, 180),
        noteCount: edges.rows.filter((edge) => edge.to_node_id === row.id || edge.from_node_id === row.id).length,
        accent: String(row.metadata.accent ?? '#26a69a'),
      })),
      trelloCards: cards.rows.map((row) => ({
        id: row.id, title: row.title, list: row.list_name,
        due: row.due_at ? new Date(row.due_at).toISOString() : null,
        labels: normalizeTrelloLabels(row.labels),
      })),
      automations: automations.rows.map((row) => ({
        id: row.id, name: row.name, description: row.kind.replaceAll('_', ' '), enabled: row.enabled,
        lastRun: row.last_run_at ? new Date(row.last_run_at).toISOString() : null,
        status: !row.enabled ? 'paused' : row.last_error || row.last_run_status === 'failed' ? 'attention' : 'healthy',
      })),
      graph: {
        nodes: nodes.rows.slice(0, 150).map((row) => ({
          id: row.id, label: row.title,
          kind: row.type === 'project' || row.type === 'person' ? row.type : row.type === 'topic' ? 'topic' : 'note',
          size: 1 + edges.rows.filter((edge) => edge.to_node_id === row.id || edge.from_node_id === row.id).length,
          source: row.source_type === 'trello' ? 'trello'
            : row.source_type === 'whatsapp' || row.domain === 'whatsapp' ? 'whatsapp'
              : row.source_type === 'atlas-ai' || row.source_type === 'atlas-summary' ? 'ai' : 'manual',
          tags: row.tags,
          updatedAt: new Date(row.updated_at).toISOString(),
        })),
        edges: edges.rows.map((row) => ({ source: row.from_node_id, target: row.to_node_id })),
      },
      stats: { inbox: Number(assistantInbox.rows[0]?.total ?? 0), notes: nodes.rows.length,
        connections: Number(counts.rows[0]?.connections ?? 0), openTasks: Number(counts.rows[0]?.tasks ?? 0) },
      integrationStatus: {
        whatsappConnected: Number(counts.rows[0]?.whatsapp ?? 0) > 0,
        trelloConnected: Number(counts.rows[0]?.trello ?? 0) > 0,
        monitoredChats: Number(counts.rows[0]?.monitored ?? 0),
      },
      settings: {
        timezone: settingsRow?.timezone ?? 'America/Sao_Paulo',
        reminderTimes: settingsRow?.reminder_times ?? ['08:00', '18:00'],
        notifySelf: settingsRow?.feature_flags?.notifySelf !== false,
      },
      aiUsage: {
        period: 'Últimos 30 dias', calls: usageCalls, tokens: Number(usageRow?.tokens ?? 0),
        latencyMs: Math.round(Number(usageRow?.latency_ms ?? 0)), errors: usageErrors,
        errorRate: usageCalls ? (usageErrors / usageCalls) * 100 : 0,
        costCents: Number(usageRow?.cost_micros ?? 0) / 10_000,
      },
    };
  });

  app.get('/notes/:id', async (request) => {
    const user = currentUser(request);
    const { id } = parseInput(uuidParams, request.params);
    const result = await database.query<BrainNodeRow>(
      `SELECT id,user_id,type,domain,title,manual_content,generated_content,status,aliases,tags,
              source_type,source_id,source_url,happened_at,metadata,version,created_at,updated_at
       FROM brain_nodes WHERE id=$1 AND user_id=$2`, [id, user.id],
    );
    if (!result.rows[0]) throw new AppError(404, 'NOTE_NOT_FOUND', 'Nota não encontrada.');
    return noteJson(result.rows[0]);
  });

  app.post('/notes', async (request, reply) => {
    const user = currentUser(request);
    const input = parseInput(z.object({
      title: z.string().trim().min(1).max(300).default('Sem título'), contentMarkdown: z.string().max(500_000).default(''),
    }), request.body ?? {});
    const result = await database.userTransaction(user.id, async (client) => {
      const stub = await client.query<{ id: string }>(
        `SELECT id FROM brain_nodes WHERE user_id=$1 AND type='stub' AND status<>'deleted'
           AND (lower(btrim(title))=lower(btrim($2)) OR lower(btrim($2))=ANY(
             SELECT lower(btrim(alias)) FROM unnest(aliases) AS a(alias)))
         ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`, [user.id, input.title],
      );
      const created = stub.rows[0]
        ? await client.query<BrainNodeRow>(
          `UPDATE brain_nodes SET type='note',title=$3,manual_content=$4,generated_content='',
             source_type=NULL,source_id=NULL,metadata='{}'::jsonb
           WHERE id=$1 AND user_id=$2
           RETURNING id,user_id,type,domain,title,manual_content,generated_content,status,aliases,tags,
             source_type,source_id,source_url,happened_at,metadata,version,created_at,updated_at`,
          [stub.rows[0].id, user.id, input.title, input.contentMarkdown],
        )
        : await client.query<BrainNodeRow>(
          `INSERT INTO brain_nodes (user_id,type,title,manual_content) VALUES ($1,'note',$2,$3)
           RETURNING id,user_id,type,domain,title,manual_content,generated_content,status,aliases,tags,
             source_type,source_id,source_url,happened_at,metadata,version,created_at,updated_at`,
          [user.id, input.title, input.contentMarkdown],
        );
      await syncWikilinkEdgesInTransaction(client, {
        userId: user.id,
        fromNodeId: created.rows[0]!.id,
        content: input.contentMarkdown,
      });
      return created;
    });
    await events.publish(user.id, 'brain.node.created', { nodeId: result.rows[0]!.id });
    return reply.status(201).send(noteJson(result.rows[0]!));
  });

  app.put('/notes/:id', async (request) => {
    const user = currentUser(request);
    const { id } = parseInput(uuidParams, request.params);
    const input = parseInput(z.object({ title: z.string().trim().min(1).max(300), contentMarkdown: z.string().max(500_000) }), request.body);
    const result = await database.userTransaction(user.id, async (client) => {
      const updated = await client.query<BrainNodeRow>(
        `UPDATE brain_nodes SET title=$3,manual_content=$4 WHERE id=$1 AND user_id=$2
         RETURNING id,user_id,type,domain,title,manual_content,generated_content,status,aliases,tags,
           source_type,source_id,source_url,happened_at,metadata,version,created_at,updated_at`,
        [id, user.id, input.title, input.contentMarkdown],
      );
      if (updated.rows[0]) {
        await syncWikilinkEdgesInTransaction(client, {
          userId: user.id,
          fromNodeId: id,
          content: input.contentMarkdown,
        });
      }
      return updated;
    });
    if (!result.rows[0]) throw new AppError(404, 'NOTE_NOT_FOUND', 'Nota não encontrada.');
    await events.publish(user.id, 'brain.node.updated', { nodeId: id });
    return noteJson(result.rows[0]);
  });

  app.get('/automations', async (request) => {
    const user = currentUser(request);
    const result = await database.query(
      `SELECT id,name,kind,enabled,schedule,timezone,config,last_run_at AS "lastRunAt",
              last_run_status AS "lastRunStatus",last_error AS "lastError",next_run_at AS "nextRunAt"
       FROM automations WHERE user_id=$1 ORDER BY created_at`, [user.id],
    );
    return { items: result.rows };
  });

  app.post('/automations', async (request, reply) => {
    const user = currentUser(request);
    const input = parseInput(z.object({
      name: z.string().trim().min(1).max(160).optional(), kind: automationKindSchema,
      time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
      enabled: z.boolean().default(true), schedule: z.string().max(160).nullable().optional(),
      timezone: ianaTimezone.optional(), config: z.record(z.string(), z.unknown()).default({}),
    }), request.body);
    const defaults = canonicalAutomationDefinition(input.kind, input.time);
    const settings = input.timezone ? null : await database.query<{ timezone: string }>(
      'SELECT timezone FROM user_settings WHERE user_id=$1', [user.id],
    );
    const timezone = input.timezone ?? settings?.rows[0]?.timezone ?? 'America/Sao_Paulo';
    const schedule = Object.hasOwn(input, 'schedule') ? input.schedule ?? null : defaults.schedule;
    const config = { ...defaults.config, ...input.config, ...(input.time ? { time: input.time } : {}) };
    const result = await database.query(
      `INSERT INTO automations (user_id,name,kind,enabled,schedule,timezone,config)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id,name,kind,enabled,schedule,timezone,config`,
      [user.id, input.name ?? defaults.name, input.kind, input.enabled, schedule, timezone, config],
    );
    await events.publish(user.id, 'automation.created', { automationId: result.rows[0]?.id });
    return reply.status(201).send({
      ...result.rows[0],
      description: input.time
        ? `Executa às ${input.time}.`
        : 'Executa quando o contexto correspondente for detectado.',
      lastRun: null,
      status: input.enabled ? 'healthy' : 'paused',
    });
  });

  app.patch('/automations/:id', async (request) => {
    const user = currentUser(request);
    const { id } = parseInput(uuidParams, request.params);
    const input = parseInput(z.object({
      name: z.string().trim().min(1).max(160).optional(), enabled: z.boolean().optional(),
      schedule: z.string().max(160).nullable().optional(), config: z.record(z.string(), z.unknown()).optional(),
    }).refine((value) => Object.keys(value).length > 0), request.body);
    const result = await database.query(
      `UPDATE automations SET name=COALESCE($3,name),enabled=COALESCE($4,enabled),
         schedule=CASE WHEN $7 THEN $5 ELSE schedule END,config=COALESCE($6,config),
         next_run_at=CASE WHEN $7 OR $4=true THEN NULL ELSE next_run_at END
       WHERE id=$1 AND user_id=$2 RETURNING id,name,kind,enabled,schedule,timezone,config`,
      [id, user.id, input.name ?? null, input.enabled ?? null, input.schedule ?? null, input.config ?? null, Object.hasOwn(input, 'schedule')],
    );
    if (!result.rows[0]) throw new AppError(404, 'AUTOMATION_NOT_FOUND', 'Automação não encontrada.');
    await events.publish(user.id, 'automation.updated', { automationId: id, enabled: input.enabled });
    return result.rows[0];
  });

  app.post('/automations/:id/run', async (request, reply) => {
    const user = currentUser(request);
    const { id } = parseInput(uuidParams, request.params);
    const automation = await database.query<{ kind: string; enabled: boolean }>(
      'SELECT kind,enabled FROM automations WHERE id=$1 AND user_id=$2',
      [id, user.id],
    );
    if (!automation.rows[0]) throw new AppError(404, 'AUTOMATION_NOT_FOUND', 'Automação não encontrada.');
    if (!automation.rows[0].enabled) {
      throw new AppError(409, 'AUTOMATION_DISABLED', 'Ative a automação antes de executá-la.');
    }
    const runnableKind = automationKindSchema.safeParse(automation.rows[0].kind);
    if (!runnableKind.success) {
      throw new AppError(422, 'AUTOMATION_KIND_NOT_RUNNABLE',
        'Esta automação interna não pode ser executada manualmente.', { kind: automation.rows[0].kind });
    }
    const jobKey = `${id}:${Date.now()}`;
    const attempt = await database.query<{ id: string }>(
      `INSERT INTO job_attempts (user_id,job_type,job_key,status,input)
       VALUES ($1,$2,$3,'queued',$4) RETURNING id`,
      [user.id, `automation:${automation.rows[0].kind}`, jobKey, { automationId: id, requestedBy: user.id }],
    );
    await database.query(
      `UPDATE automations SET last_run_at=now(),last_run_status='queued',last_error=NULL WHERE id=$1 AND user_id=$2`, [id, user.id],
    );
    await events.publish(user.id, 'automation.run.queued', { automationId: id, jobAttemptId: attempt.rows[0]!.id });
    return reply.status(202).send({ queued: true, jobAttemptId: attempt.rows[0]!.id });
  });

  app.delete('/automations/:id', async (request, reply) => {
    const user = currentUser(request);
    const { id } = parseInput(uuidParams, request.params);
    const result = await database.query('DELETE FROM automations WHERE id=$1 AND user_id=$2', [id, user.id]);
    if (!result.rowCount) throw new AppError(404, 'AUTOMATION_NOT_FOUND', 'Automação não encontrada.');
    await events.publish(user.id, 'automation.deleted', { automationId: id });
    return reply.status(204).send();
  });

  app.post('/feedback', async (request, reply) => {
    const user = currentUser(request);
    const input = parseInput(z.object({
      itemId: z.string().min(1).max(200).optional(),
      action: z.enum(['edit', 'not_task', 'merge', 'reprocess']).optional(),
      context: z.enum(['inbox', 'activity']).optional(),
      nodeId: z.string().uuid().nullable().optional(), threadId: z.string().uuid().nullable().optional(),
      messageId: z.string().uuid().nullable().optional(), kind: z.string().min(1).max(80).default('general'),
      rating: z.number().int().min(1).max(5).nullable().optional(), comment: z.string().max(10_000).default(''),
      metadata: z.record(z.string(), z.unknown()).default({}),
    }), request.body);
    const correctionAction = z.enum(['edit', 'not_task', 'merge', 'reprocess']).safeParse(input.metadata.action);
    const correctionContext = z.enum(['inbox', 'activity']).safeParse(input.metadata.context);
    const action = input.action ?? (correctionAction.success ? correctionAction.data : undefined);
    const context = input.context ?? (correctionContext.success ? correctionContext.data : undefined);
    const itemId = input.itemId ?? (typeof input.metadata.itemId === 'string' ? input.metadata.itemId : undefined);
    const itemAsUuid = itemId ? z.string().uuid().safeParse(itemId) : null;
    const requestedNodeId = input.nodeId ?? (context === 'inbox' && itemAsUuid?.success ? itemAsUuid.data : null);
    const kind = action ? `ai_${action}` : input.kind;
    const baseMetadata = {
      ...input.metadata,
      ...(itemId ? { itemId } : {}),
      ...(action ? { action } : {}),
      ...(context ? { context } : {}),
    };
    const result = await database.transaction(async (client) => {
      let nodeId = requestedNodeId;
      let taskId: string | null = null;
      let activityPayload: Record<string, unknown> = {};
      if (context === 'activity' && itemId && /^\d+$/.test(itemId)) {
        const activity = await client.query<{ payload: Record<string, unknown> }>(
          'SELECT payload FROM event_outbox WHERE id=$1 AND user_id=$2',
          [itemId, user.id],
        );
        activityPayload = activity.rows[0]?.payload ?? {};
        const eventNodeId = z.string().uuid().safeParse(activityPayload.nodeId);
        if (!nodeId && eventNodeId.success) nodeId = eventNodeId.data;
      }

      let nodeMetadata: Record<string, unknown> = {};
      let targetCardId = typeof activityPayload.cardId === 'string' ? activityPayload.cardId : null;
      if (context === 'inbox' && itemAsUuid?.success) {
        const task = await client.query<{
          id: string; brain_node_id: string | null; metadata: Record<string, unknown>;
          source_message_ids: string[]; version: number; trello_card_id: string | null;
        }>(
          `SELECT t.id,t.brain_node_id,t.metadata,t.source_message_ids,t.version,l.trello_card_id
           FROM canonical_tasks t LEFT JOIN task_trello_links l ON l.user_id=t.user_id AND l.task_id=t.id
           WHERE t.id=$1 AND t.user_id=$2 FOR UPDATE OF t`,
          [itemAsUuid.data, user.id],
        );
        if (task.rows[0]) {
          taskId = task.rows[0].id;
          nodeId = task.rows[0].brain_node_id;
          nodeMetadata = { ...task.rows[0].metadata, sourceMessageIds: task.rows[0].source_message_ids };
          targetCardId = task.rows[0].trello_card_id ?? targetCardId;
          if (action === 'not_task') {
            const updated = await client.query<{ version: number }>(
              `UPDATE canonical_tasks SET status='cancelled',cancelled_at=now(),version=version+1,
                 metadata=metadata || $3::jsonb WHERE id=$1 AND user_id=$2 RETURNING version`,
              [taskId, user.id, { lastAiCorrection: 'not_task', correctedAt: new Date().toISOString() }],
            );
            await client.query(
              `UPDATE task_trello_links SET sync_status='pending',atlas_revision=$3,
                 metadata=metadata || $4::jsonb,last_error=NULL
               WHERE task_id=$1 AND user_id=$2 AND sync_status<>'detached'`,
              [taskId, user.id, updated.rows[0]!.version, { pendingAction: 'cancel' }],
            );
            await client.query(
              `INSERT INTO job_attempts (user_id,job_type,job_key,status,input)
               VALUES ($1,'task:sync_trello',$2,'queued',$3) ON CONFLICT DO NOTHING`,
              [user.id, `${taskId}:v${updated.rows[0]!.version}:feedback-not-task`,
                { taskId, canonicalTaskVersion: updated.rows[0]!.version, action: 'cancel' }],
            );
            await client.query(
              `INSERT INTO task_events (user_id,task_id,event_type,actor_type,actor_user_id,payload)
               VALUES ($1,$2,'not_task','user',$1,$3)`, [user.id, taskId, { source: 'feedback', confirmed: true }],
            );
          }
        }
      }
      if (nodeId) {
        const owned = await client.query<{
          type: string; status: string; source_id: string | null; metadata: Record<string, unknown>; version: number;
        }>(
          'SELECT type,status,source_id,metadata,version FROM brain_nodes WHERE id=$1 AND user_id=$2',
          [nodeId, user.id],
        );
        if (!owned.rows[0]) throw new AppError(404, 'FEEDBACK_TARGET_NOT_FOUND', 'O item corrigido não foi encontrado.');
        nodeMetadata = owned.rows[0].metadata;
        if (!targetCardId && owned.rows[0].source_id && owned.rows[0].type === 'task') {
          targetCardId = owned.rows[0].source_id;
        }
        if (action === 'not_task') {
          await client.query(
            `UPDATE brain_nodes SET status=CASE WHEN type='task' THEN 'archived' ELSE 'active' END,
               metadata=metadata || $3::jsonb WHERE id=$1 AND user_id=$2`,
            [nodeId, user.id, { lastAiCorrection: 'not_task', correctedAt: new Date().toISOString() }],
          );
        }
      }

      const sourceMessageIds = [...new Set([
        ...(Array.isArray(activityPayload.sourceMessageIds) ? activityPayload.sourceMessageIds : []),
        ...(Array.isArray(nodeMetadata.sourceMessageIds) ? nodeMetadata.sourceMessageIds : []),
      ].filter((value): value is string => typeof value === 'string'))];
      if (action === 'reprocess' && sourceMessageIds.length === 0) {
        throw new AppError(
          422,
          'REPROCESS_EVIDENCE_NOT_FOUND',
          'Este item não possui mensagens do WhatsApp que possam ser reprocessadas.',
        );
      }
      const metadata = {
        ...baseMetadata,
        ...(taskId ? { taskId } : {}),
        ...(sourceMessageIds.length ? { sourceMessageIds } : {}),
        ...(targetCardId ? { targetCardId } : {}),
      };
      const saved = await client.query(
        `INSERT INTO feedback (user_id,node_id,thread_id,message_id,kind,rating,comment,metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id,kind,rating,comment,created_at AS "createdAt"`,
        [user.id, nodeId, input.threadId ?? null, input.messageId ?? null,
          kind, input.rating ?? null, input.comment, metadata],
      );
      if (action === 'reprocess') {
        await client.query(
          `INSERT INTO job_attempts (user_id,job_type,job_key,status,input)
           VALUES ($1,'feedback:reprocess',$2,'queued',$3) ON CONFLICT DO NOTHING`,
          [user.id, `feedback:${saved.rows[0]!.id}`, { feedbackId: saved.rows[0]!.id, nodeId, itemId: itemId ?? null, context: context ?? null }],
        );
      }
      return saved;
    });
    await events.publish(user.id, 'feedback.created', { feedbackId: result.rows[0]?.id });
    return reply.status(201).send({ accepted: true, ...result.rows[0] });
  });

  app.get('/feedback', async (request) => {
    const user = currentUser(request);
    const result = await database.query(
      `SELECT id,node_id AS "nodeId",thread_id AS "threadId",message_id AS "messageId",
              kind,rating,comment,metadata,created_at AS "createdAt"
       FROM feedback WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200`, [user.id],
    );
    return { items: result.rows };
  });

  app.get('/ai/usage', async (request) => {
    const user = currentUser(request);
    const query = parseInput(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), request.query);
    const result = await database.query(
      `SELECT date_trunc('day',occurred_at) AS day,provider,model,
              sum(prompt_tokens)::int AS "promptTokens",sum(completion_tokens)::int AS "completionTokens",
              sum(reasoning_tokens)::int AS "reasoningTokens",sum(cached_tokens)::int AS "cachedTokens",
              sum(cost_micros)::text AS "costMicros",count(*)::int AS runs
       FROM ai_usage_events WHERE user_id=$1 AND occurred_at >= now() - ($2 * interval '1 day')
       GROUP BY 1,provider,model ORDER BY 1 DESC`, [user.id, query.days],
    );
    return { items: result.rows };
  });

  app.get('/events', async (request, reply) => {
    const user = currentUser(request);
    const query = parseInput(z.object({ after: z.coerce.number().int().min(0).optional() }), request.query);
    const headerId = Number(request.headers['last-event-id'] ?? 0);
    const after = query.after ?? (Number.isFinite(headerId) ? headerId : 0);
    const replay = await database.query<{
      id: string; topic: string; event_type: string; payload: Record<string, unknown>; created_at: Date | string;
    }>(
      `SELECT id,topic,event_type,payload,created_at FROM event_outbox
       WHERE user_id=$1 AND id>$2 ORDER BY id LIMIT 200`, [user.id, after],
    );
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': connected\n\n');
    let lastSentId = after;
    for (const row of replay.rows) {
      const id = Number(row.id);
      EventHub.write(reply.raw, { id, topic: row.topic, eventType: row.event_type,
        payload: row.payload, createdAt: new Date(row.created_at).toISOString() });
      lastSentId = Math.max(lastSentId, id);
    }
    const unsubscribe = events.subscribe(user.id, (event) => {
      if (event.id <= lastSentId) return;
      EventHub.write(reply.raw, event);
      lastSentId = event.id;
    });
    let polling = false;
    const poll = setInterval(async () => {
      if (polling || reply.raw.destroyed) return;
      polling = true;
      try {
        const rows = await database.query<{
          id: string; topic: string; event_type: string; payload: Record<string, unknown>; created_at: Date | string;
        }>(
          `SELECT id,topic,event_type,payload,created_at FROM event_outbox
           WHERE user_id=$1 AND id>$2 ORDER BY id LIMIT 200`, [user.id, lastSentId],
        );
        for (const row of rows.rows) {
          const id = Number(row.id);
          if (id <= lastSentId) continue;
          EventHub.write(reply.raw, { id, topic: row.topic, eventType: row.event_type,
            payload: row.payload, createdAt: new Date(row.created_at).toISOString() });
          lastSentId = id;
        }
      } catch (error) {
        request.log.warn({ err: error }, 'could not poll event outbox');
      } finally {
        polling = false;
      }
    }, 2_000);
    const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 25_000);
    request.raw.once('close', () => { clearInterval(heartbeat); clearInterval(poll); unsubscribe(); });
    return reply;
  });
}
