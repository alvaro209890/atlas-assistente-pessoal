import { randomUUID } from 'node:crypto';
import { createDatabase, runMigrations, type Database } from '@atlas/database';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { WhatsAppAdapter } from '../src/integrations.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? '';
const describeWithPostgres = testDatabaseUrl ? describe : describe.skip;
const suffix = randomUUID().replaceAll('-', '');
const emailA = `platform-pg-a-${suffix}@example.test`;
const emailB = `platform-pg-b-${suffix}@example.test`;
const password = 'Senha-integracao-123!';

interface AuthPayload {
  user: { id: string; name: string; email: string };
  onboardingComplete: boolean;
}

interface NotePayload {
  id: string;
  title: string;
  contentMarkdown: string;
}

interface AutomationPayload {
  id: string;
  kind: string;
  enabled: boolean;
  schedule: string | null;
  timezone: string;
  config: Record<string, unknown>;
}

function cookieFrom(header: string | string[] | undefined): string {
  const serialized = Array.isArray(header) ? header[0] : header;
  if (!serialized) throw new Error('Expected the response to set a session cookie');
  return serialized.split(';', 1)[0]!;
}

describeWithPostgres('platform API with PostgreSQL', () => {
  let database: Database | undefined;
  let app: FastifyInstance | undefined;
  let cookieA = '';
  let cookieB = '';
  let registrationCookieA = '';
  let userA!: AuthPayload['user'];
  let userB!: AuthPayload['user'];
  let registrationAStatus = 0;
  let registrationBStatus = 0;
  let logoutStatus = 0;
  let loggedOutSessionStatus = 0;
  let loginStatus = 0;
  let sessionAStatus = 0;
  let sessionBStatus = 0;
  const whatsappPairingCalls: Array<{ userId: string; connectionId: string }> = [];

  const whatsapp: WhatsAppAdapter = {
    async beginPairing(input) {
      whatsappPairingCalls.push(input);
      return {
        status: 'pairing',
        qrDataUrl: 'data:image/png;base64,ZmFrZQ==',
        expiresAt: new Date(Date.now() + 60_000),
      };
    },
    async readSession() {
      return null;
    },
    async disconnect() {},
    async listChats() {
      return [];
    },
  };

  beforeAll(async () => {
    database = createDatabase({
      connectionString: testDatabaseUrl,
      applicationName: `atlas-api-pg-test-${suffix}`,
    });
    await runMigrations(database);

    app = await buildApp({
      database,
      config: loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        BCRYPT_ROUNDS: '8',
        SESSION_COOKIE_NAME: 'platform_pg_session',
        SESSION_SECRET: 'platform-pg-integration-test-session-secret',
      }),
      whatsapp,
      ai: {
        async answer() {
          return {
            answer: 'Preparei uma proposta para sua confirmação.', provider: 'test', model: 'deepseek-v4-flash',
            usage: { promptTokens: 10, completionTokens: 8, reasoningTokens: 2, cachedTokens: 0 },
          };
        },
      },
      logger: false,
    });

    const registrationA = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: emailA, password, preferredName: 'Conta A', fullName: 'Conta A Completa' },
    });
    registrationAStatus = registrationA.statusCode;
    registrationCookieA = cookieFrom(registrationA.headers['set-cookie']);
    userA = (registrationA.json() as AuthPayload).user;

    const registrationB = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: emailB, password, preferredName: 'Conta B' },
    });
    registrationBStatus = registrationB.statusCode;
    cookieB = cookieFrom(registrationB.headers['set-cookie']);
    userB = (registrationB.json() as AuthPayload).user;

    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: registrationCookieA },
    });
    logoutStatus = logout.statusCode;

    loggedOutSessionStatus = (await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: registrationCookieA },
    })).statusCode;

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: emailA.toUpperCase(), password },
    });
    loginStatus = login.statusCode;
    cookieA = cookieFrom(login.headers['set-cookie']);

    sessionAStatus = (await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: cookieA },
    })).statusCode;
    sessionBStatus = (await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: cookieB },
    })).statusCode;
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
    if (database) {
      try {
        await database.query('DELETE FROM users WHERE email = ANY($1::text[])', [[emailA, emailB]]);
      } finally {
        await database.close();
      }
    }
  });

  it('registers two users, invalidates a logged-out cookie and creates a fresh login cookie', () => {
    expect(registrationAStatus).toBe(201);
    expect(registrationBStatus).toBe(201);
    expect(userA).toMatchObject({ name: 'Conta A', email: emailA });
    expect(userB).toMatchObject({ name: 'Conta B', email: emailB });
    expect(userA.id).not.toBe(userB.id);

    expect(registrationCookieA).toMatch(/^platform_pg_session=/);
    expect(logoutStatus).toBe(204);
    expect(loggedOutSessionStatus).toBe(401);
    expect(loginStatus).toBe(200);
    expect(cookieA).toMatch(/^platform_pg_session=/);
    expect(cookieA).not.toBe(registrationCookieA);
    expect(cookieB).toMatch(/^platform_pg_session=/);
    expect(sessionAStatus).toBe(200);
    expect(sessionBStatus).toBe(200);
  });

  it('creates the default automations independently for each account', async () => {
    const [responseA, responseB] = await Promise.all([
      app!.inject({ method: 'GET', url: '/api/automations', headers: { cookie: cookieA } }),
      app!.inject({ method: 'GET', url: '/api/automations', headers: { cookie: cookieB } }),
    ]);
    expect(responseA.statusCode).toBe(200);
    expect(responseB.statusCode).toBe(200);

    for (const response of [responseA, responseB]) {
      const items = (response.json() as { items: AutomationPayload[] }).items;
      expect(items.map((item) => item.kind).sort()).toEqual(['message_ingestion', 'pending_reminder']);
      expect(items).toHaveLength(2);
      expect(items.find((item) => item.kind === 'pending_reminder')).toMatchObject({
        enabled: true,
        schedule: '0 8,18 * * *',
        timezone: 'America/Sao_Paulo',
        config: { notifySelf: true },
      });
      expect(items.find((item) => item.kind === 'message_ingestion')).toMatchObject({
        enabled: true,
        schedule: null,
        config: { quietWindowSeconds: 10, maxMessages: 30 },
      });
    }
  });

  it('accepts the compact canonical automation DTO and derives schedule and timezone', async () => {
    const created = await app!.inject({
      method: 'POST', url: '/api/automations', headers: { cookie: cookieA },
      payload: { kind: 'weekly_review', time: '18:10' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      name: 'Revisão semanal', kind: 'weekly_review', schedule: '10 18 * * 1',
      timezone: 'America/Sao_Paulo', config: { canonicalKind: 'weekly_review', time: '18:10' },
    });
    const automationId = (created.json() as { id: string }).id;
    const run = await app!.inject({
      method: 'POST', url: `/api/automations/${automationId}/run`, headers: { cookie: cookieA },
    });
    expect(run.statusCode).toBe(202);
    const existing = await app!.inject({ method: 'GET', url: '/api/automations', headers: { cookie: cookieA } });
    const internal = (existing.json() as { items: Array<{ id: string; kind: string }> }).items
      .find((item) => item.kind === 'pending_reminder')!;
    const rejectedRun = await app!.inject({
      method: 'POST', url: `/api/automations/${internal.id}/run`, headers: { cookie: cookieA },
    });
    expect(rejectedRun.statusCode).toBe(422);
    expect(rejectedRun.json()).toMatchObject({ error: { code: 'AUTOMATION_KIND_NOT_RUNNABLE' } });
  });

  it('keeps profiles and canonical tasks isolated while task actions remain explicit', async () => {
    const updatedProfile = await app!.inject({
      method: 'PATCH', url: '/api/profile', headers: { cookie: cookieA },
      payload: {
        preferredName: 'Ana', fullName: 'Ana da Conta A', occupation: 'Engenharia',
        goals: ['Organizar entregas', 'Reduzir atrasos'], timezone: 'America/Manaus',
        workDays: [1, 2, 3, 4, 5, 7], workStart: '09:00', workEnd: '18:00',
        quietStart: '21:30', quietEnd: '07:30', communicationStyle: 'concise',
      },
    });
    expect(updatedProfile.statusCode).toBe(200);
    expect(updatedProfile.json()).toMatchObject({
      preferredName: 'Ana', occupation: 'Engenharia', goals: ['Organizar entregas', 'Reduzir atrasos'],
      timezone: 'America/Manaus', communicationStyle: 'concise', workDays: [1, 2, 3, 4, 5, 7],
    });
    const profileB = await app!.inject({ method: 'GET', url: '/api/profile', headers: { cookie: cookieB } });
    expect(profileB.statusCode).toBe(200);
    expect(profileB.json()).toMatchObject({ preferredName: 'Conta B', occupation: null, goals: [] });

    const created = await app!.inject({
      method: 'POST', url: '/api/tasks', headers: { cookie: cookieA },
      payload: { title: 'Revisar contrato', description: 'Conferir cláusulas', priority: 'high', risk: 'medium' },
    });
    expect(created.statusCode).toBe(201);
    const task = created.json() as { id: string; status: string; title: string };
    expect(task).toMatchObject({ title: 'Revisar contrato', status: 'open' });
    expect((await app!.inject({ method: 'GET', url: `/api/tasks/${task.id}`, headers: { cookie: cookieB } })).statusCode).toBe(404);

    const completed = await app!.inject({
      method: 'POST', url: `/api/tasks/${task.id}/actions`, headers: { cookie: cookieA },
      payload: { action: 'complete' },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({ action: 'complete', confirmed: true, task: { id: task.id, status: 'done' } });
    expect((await app!.inject({ method: 'GET', url: '/api/tasks?status=open', headers: { cookie: cookieA } })).json())
      .toMatchObject({ items: [] });

  });

  it('materializes recurrence-only reminders and cancels the superseded occurrence', async () => {
    const created = await app!.inject({
      method: 'POST', url: '/api/reminders', headers: { cookie: cookieA },
      payload: { title: 'Revisão recorrente', scheduleType: 'recurring', recurrence: { intervalMinutes: 60 } },
    });
    expect(created.statusCode).toBe(201);
    const reminder = created.json() as { id: string; scheduledFor: string; status: string };
    expect(reminder.scheduledFor).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await database!.query(
      `UPDATE reminder_occurrences SET status='failed',last_error='falha simulada'
       WHERE user_id=$1 AND reminder_id=$2 AND status='pending'`, [userA.id, reminder.id],
    );

    const rescheduled = await app!.inject({
      method: 'PATCH', url: `/api/reminders/${reminder.id}`, headers: { cookie: cookieA },
      payload: { action: 'update', recurrence: { intervalMinutes: 120 } },
    });
    expect(rescheduled.statusCode).toBe(200);
    expect(rescheduled.json()).toMatchObject({ id: reminder.id, status: 'scheduled' });

    const occurrences = await database!.query<{ status: string }>(
      `SELECT status FROM reminder_occurrences WHERE user_id=$1 AND reminder_id=$2 ORDER BY scheduled_at`,
      [userA.id, reminder.id],
    );
    expect(occurrences.rows.map((row) => row.status)).toEqual(['cancelled', 'pending']);
  });

  it('derives the assistant Inbox from real tenant-scoped records', async () => {
    const uncertain = await app!.inject({
      method: 'POST', url: '/api/tasks', headers: { cookie: cookieA },
      payload: { title: 'Confirmar fornecedor', status: 'inbox', confidence: 0.64 },
    });
    expect(uncertain.statusCode).toBe(201);
    const taskId = (uncertain.json() as { id: string }).id;
    const learning = await app!.inject({
      method: 'POST', url: '/api/assistant/learnings', headers: { cookie: cookieB },
      payload: { learningKey: `isolated-${suffix}`, statement: 'Prefere revisar pela manhã', sourceType: 'inferred', confidence: 0.9 },
    });
    expect(learning.statusCode).toBe(201);
    const learningId = (learning.json() as { id: string }).id;

    const [workspaceA, workspaceB] = await Promise.all([
      app!.inject({ method: 'GET', url: '/api/workspace/bootstrap', headers: { cookie: cookieA } }),
      app!.inject({ method: 'GET', url: '/api/workspace/bootstrap', headers: { cookie: cookieB } }),
    ]);
    const bodyA = workspaceA.json() as { assistantInbox: Array<Record<string, unknown>>; stats: { inbox: number } };
    const bodyB = workspaceB.json() as { assistantInbox: Array<Record<string, unknown>>; stats: { inbox: number } };
    expect(bodyA.assistantInbox).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'task', title: 'Confirmar fornecedor', confidence: 0.64, targetId: taskId,
        createdAt: expect.any(String), description: expect.any(String) }),
    ]));
    expect(bodyA.assistantInbox.some((item) => item.targetId === learningId)).toBe(false);
    expect(bodyA.stats.inbox).toBe(bodyA.assistantInbox.length);
    expect(bodyB.assistantInbox).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'learning', description: 'Prefere revisar pela manhã', targetId: learningId }),
    ]));
    expect(bodyB.assistantInbox.some((item) => item.targetId === taskId)).toBe(false);
    expect(bodyB.stats.inbox).toBe(bodyB.assistantInbox.length);
  });

  it('reapplies a stable Fazer sempre rule only for its owner and reversible proposals', async () => {
    const first = await app!.inject({
      method: 'POST', url: '/api/brain/chat', headers: { cookie: cookieA },
      payload: { message: 'Crie uma tarefa: organizar os arquivos' },
    });
    expect(first.statusCode).toBe(200);
    const firstProposal = (first.json() as { proposals: Array<{ id: string; status: string }> }).proposals[0]!;
    expect(firstProposal.status).toBe('pending');
    const always = await app!.inject({
      method: 'PATCH', url: `/api/assistant/proposals/${firstProposal.id}`, headers: { cookie: cookieA },
      payload: { action: 'always' },
    });
    expect(always.statusCode).toBe(200);

    const stableRule = await database!.query<{ id: string }>(
      `SELECT id FROM assistant_learnings WHERE user_id=$1 AND scope_type='global' AND scope_id IS NULL
         AND learning_key='proposal:create_task:always'`, [userA.id],
    );
    expect(stableRule.rows).toHaveLength(1);
    await app!.inject({
      method: 'PATCH', url: `/api/assistant/learnings/${stableRule.rows[0]!.id}`,
      headers: { cookie: cookieA }, payload: { action: 'pause' },
    });
    const whilePaused = await app!.inject({
      method: 'POST', url: '/api/brain/chat', headers: { cookie: cookieA },
      payload: { message: 'Crie uma tarefa: arquivar os recibos' },
    });
    const pausedProposal = (whilePaused.json() as { proposals: Array<{ id: string; status: string }> }).proposals[0]!;
    expect(pausedProposal.status).toBe('pending');
    expect((await app!.inject({
      method: 'PATCH', url: `/api/assistant/proposals/${pausedProposal.id}`, headers: { cookie: cookieA },
      payload: { action: 'always' },
    })).statusCode).toBe(200);

    const second = await app!.inject({
      method: 'POST', url: '/api/brain/chat', headers: { cookie: cookieA },
      payload: { message: 'Crie uma tarefa: revisar os documentos' },
    });
    expect(second.statusCode, second.body).toBe(200);
    const autoProposal = (second.json() as {
      proposals: Array<{ id: string; status: string; requiresConfirmation: boolean; autoExecuted: boolean }>;
    }).proposals[0]!;
    expect(autoProposal).toMatchObject({ status: 'confirmed', requiresConfirmation: false, autoExecuted: true });
    const stableRules = await database!.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM assistant_learnings
       WHERE user_id=$1 AND scope_type='global' AND scope_id IS NULL
         AND learning_key='proposal:create_task:always' AND state='active'`, [userA.id],
    );
    expect(stableRules.rows[0]!.count).toBe(1);
    const queued = await database!.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM job_attempts
       WHERE user_id=$1 AND job_type='action_proposal:execute' AND input->>'proposalId'=$2`,
      [userA.id, autoProposal.id],
    );
    expect(queued.rows[0]!.count).toBe(1);

    const otherUser = await app!.inject({
      method: 'POST', url: '/api/brain/chat', headers: { cookie: cookieB },
      payload: { message: 'Crie uma tarefa: tarefa da outra conta' },
    });
    const otherProposal = (otherUser.json() as {
      proposals: Array<{ status: string; requiresConfirmation: boolean; autoExecuted: boolean }>;
    }).proposals[0]!;
    expect(otherProposal).toMatchObject({ status: 'pending', requiresConfirmation: true, autoExecuted: false });

    await app!.inject({
      method: 'POST', url: '/api/assistant/learnings', headers: { cookie: cookieA },
      payload: {
        learningKey: 'proposal:task_mutation:always',
        statement: 'Regra malformada que nunca deve autorizar ação destrutiva', sourceType: 'explicit',
      },
    });
    const destructive = await app!.inject({
      method: 'POST', url: '/api/brain/chat', headers: { cookie: cookieA },
      payload: { message: 'Cancele a tarefa antiga' },
    });
    const destructiveProposal = (destructive.json() as {
      proposals: Array<{ status: string; requiresConfirmation: boolean; autoExecuted: boolean; risk: string }>;
    }).proposals[0]!;
    expect(destructiveProposal).toMatchObject({
      status: 'pending', requiresConfirmation: true, autoExecuted: false, risk: 'destructive',
    });
  });

  it('keeps notes tenant-scoped and synchronizes a backlink after editing a wikilink', async () => {
    const createNote = async (cookie: string, title: string, contentMarkdown = '') => {
      const response = await app!.inject({
        method: 'POST',
        url: '/api/notes',
        headers: { cookie },
        payload: { title, contentMarkdown },
      });
      expect(response.statusCode).toBe(201);
      return response.json() as NotePayload;
    };

    const targetA = await createNote(cookieA, 'Projeto Aurora');
    const targetB = await createNote(cookieB, 'Projeto Aurora');
    const sourceA = await createNote(cookieA, 'Reuniao inicial', 'Sem conexoes ainda.');

    const updated = await app!.inject({
      method: 'PUT',
      url: `/api/notes/${sourceA.id}`,
      headers: { cookie: cookieA },
      payload: {
        title: 'Reuniao atualizada',
        contentMarkdown: 'A proxima acao pertence a [[Projeto Aurora|Aurora]].',
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      id: sourceA.id,
      title: 'Reuniao atualizada',
      contentMarkdown: 'A proxima acao pertence a [[Projeto Aurora|Aurora]].',
    });

    const backlinksA = await app!.inject({
      method: 'GET',
      url: `/api/brain/nodes/${targetA.id}/backlinks`,
      headers: { cookie: cookieA },
    });
    expect(backlinksA.statusCode).toBe(200);
    expect(backlinksA.json()).toMatchObject({
      items: [{ node: { id: sourceA.id, title: 'Reuniao atualizada' }, relationType: 'wikilink' }],
    });

    const backlinksB = await app!.inject({
      method: 'GET',
      url: `/api/brain/nodes/${targetB.id}/backlinks`,
      headers: { cookie: cookieB },
    });
    expect(backlinksB.statusCode).toBe(200);
    expect(backlinksB.json()).toEqual({ items: [] });

    expect((await app!.inject({
      method: 'GET',
      url: `/api/notes/${targetA.id}`,
      headers: { cookie: cookieB },
    })).statusCode).toBe(404);
    expect((await app!.inject({
      method: 'PUT',
      url: `/api/notes/${sourceA.id}`,
      headers: { cookie: cookieB },
      payload: { title: 'Tentativa cruzada', contentMarkdown: 'Nao deve alterar.' },
    })).statusCode).toBe(404);

    const [nodesA, nodesB] = await Promise.all([
      app!.inject({ method: 'GET', url: '/api/brain/nodes?limit=100', headers: { cookie: cookieA } }),
      app!.inject({ method: 'GET', url: '/api/brain/nodes?limit=100', headers: { cookie: cookieB } }),
    ]);
    const idsA = (nodesA.json() as { items: NotePayload[] }).items.map((node) => node.id);
    const idsB = (nodesB.json() as { items: NotePayload[] }).items.map((node) => node.id);
    expect(idsA).toEqual(expect.arrayContaining([targetA.id, sourceA.id]));
    expect(idsA).not.toContain(targetB.id);
    expect(idsB).toContain(targetB.id);
    expect(idsB).not.toEqual(expect.arrayContaining([targetA.id, sourceA.id]));
  });

  it('creates a fake WhatsApp pairing session only for its owner', async () => {
    const created = await app!.inject({
      method: 'POST',
      url: '/api/whatsapp/sessions',
      headers: { cookie: cookieA },
      payload: { displayName: 'WhatsApp principal de teste' },
    });
    expect(created.statusCode).toBe(201);
    const session = created.json() as { id: string; name: string; status: string; qrDataUrl: string };
    expect(session).toMatchObject({
      name: 'WhatsApp principal de teste',
      status: 'qr',
      qrDataUrl: 'data:image/png;base64,ZmFrZQ==',
    });
    expect(whatsappPairingCalls).toEqual([{ userId: userA.id, connectionId: session.id }]);

    const foreignRead = await app!.inject({
      method: 'GET',
      url: `/api/whatsapp/sessions/${session.id}`,
      headers: { cookie: cookieB },
    });
    expect(foreignRead.statusCode).toBe(404);

    const [connectionsA, connectionsB] = await Promise.all([
      app!.inject({ method: 'GET', url: '/api/whatsapp/connections', headers: { cookie: cookieA } }),
      app!.inject({ method: 'GET', url: '/api/whatsapp/connections', headers: { cookie: cookieB } }),
    ]);
    expect(connectionsA.json()).toMatchObject({ items: [{ id: session.id, status: 'qr' }] });
    expect(connectionsB.json()).toEqual({ items: [] });
  });

  it('keeps one active WhatsApp connection under concurrent create requests', async () => {
    const [first, second] = await Promise.all([
      app!.inject({ method: 'POST', url: '/api/whatsapp/sessions', headers: { cookie: cookieA }, payload: { name: 'Concorrente A' } }),
      app!.inject({ method: 'POST', url: '/api/whatsapp/sessions', headers: { cookie: cookieA }, payload: { name: 'Concorrente B' } }),
    ]);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect((first.json() as { id: string }).id).toBe((second.json() as { id: string }).id);
    const connections = await database!.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM whatsapp_connections WHERE user_id=$1 AND status<>'logged_out'`,
      [userA.id],
    );
    expect(connections.rows[0]!.count).toBe(1);
  });

  it('completes onboarding only after every tenant-owned prerequisite is valid', async () => {
    const incompleteProfile = await app!.inject({
      method: 'POST', url: '/api/onboarding/complete', headers: { cookie: cookieB },
      payload: { selectedChatIds: [randomUUID()], notifySelf: true },
    });
    expect(incompleteProfile.statusCode).toBe(409);
    expect(incompleteProfile.json()).toMatchObject({ error: { code: 'ONBOARDING_PROFILE_INCOMPLETE' } });

    const whatsappMissing = await app!.inject({
      method: 'POST', url: '/api/onboarding/complete', headers: { cookie: cookieA },
      payload: { selectedChatIds: [randomUUID()], notifySelf: true },
    });
    expect(whatsappMissing.statusCode).toBe(409);
    expect(whatsappMissing.json()).toMatchObject({ error: { code: 'ONBOARDING_WHATSAPP_NOT_CONNECTED' } });

    const fixture = await database!.transaction(async (client) => {
      const whatsapp = await client.query<{ id: string }>(
        `UPDATE whatsapp_connections SET status='connected',phone_number='5511999999999',jid=$2
         WHERE user_id=$1 AND status<>'logged_out' RETURNING id`,
        [userA.id, `5511999999999-${suffix}@s.whatsapp.net`],
      );
      const chat = await client.query<{ id: string }>(
        `INSERT INTO monitored_chats (user_id,whatsapp_connection_id,jid,display_name,enabled)
         VALUES ($1,$2,$3,'Conversa de teste',false) RETURNING id`,
        [userA.id, whatsapp.rows[0]!.id, `chat-${suffix}@s.whatsapp.net`],
      );
      const trello = await client.query<{ id: string }>(
        `INSERT INTO trello_connections
          (user_id,display_name,api_key,access_token,member_id,member_name,status)
         VALUES ($1,'Trello teste','test-key','test-token',$2,'Conta teste','connected') RETURNING id`,
        [userA.id, `member-${suffix}`],
      );
      await client.query(
        `INSERT INTO trello_board_configs
          (user_id,trello_connection_id,board_id,board_name,inbox_list_id,in_progress_list_id,paused_list_id,done_list_id)
         VALUES ($1,$2,$3,'Quadro teste','list-inbox','list-progress','list-paused','list-done')`,
        [userA.id, trello.rows[0]!.id, `board-${suffix}`],
      );
      return { chatId: chat.rows[0]!.id };
    });

    const invalidChat = await app!.inject({
      method: 'POST', url: '/api/onboarding/complete', headers: { cookie: cookieA },
      payload: { selectedChatIds: [randomUUID()], notifySelf: true },
    });
    expect(invalidChat.statusCode).toBe(422);
    expect(invalidChat.json()).toMatchObject({ error: { code: 'ONBOARDING_CHAT_INVALID' } });
    const flagsBefore = await database!.query<{ complete: boolean }>(
      `SELECT COALESCE((feature_flags->>'onboardingComplete')::boolean,false) AS complete
       FROM user_settings WHERE user_id=$1`, [userA.id],
    );
    expect(flagsBefore.rows[0]!.complete).toBe(false);

    const completed = await app!.inject({
      method: 'POST', url: '/api/onboarding/complete', headers: { cookie: cookieA },
      payload: { selectedChatIds: [fixture.chatId], notifySelf: true },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({
      onboardingComplete: true,
      user: { preferredName: 'Ana', fullName: 'Ana da Conta A', email: emailA },
    });
    expect((await app!.inject({ method: 'GET', url: '/api/onboarding', headers: { cookie: cookieA } })).json())
      .toMatchObject({ step: 7, totalSteps: 7, profile: { preferredName: 'Ana', workDays: [1, 2, 3, 4, 5, 7] } });
  });

  it('manages tenant-scoped monitored conversations and manual groups', async () => {
    const connection = await database!.query<{ id: string }>(
      `SELECT id FROM whatsapp_connections WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 1`, [userA.id],
    );
    expect(connection.rows[0]).toBeDefined();
    const chat = await database!.query<{ id: string }>(
      `INSERT INTO monitored_chats (user_id,whatsapp_connection_id,jid,display_name,enabled)
       VALUES ($1,$2,$3,'Contato com nome',false)
       ON CONFLICT (user_id,whatsapp_connection_id,jid)
       DO UPDATE SET display_name=EXCLUDED.display_name
       RETURNING id`,
      [userA.id, connection.rows[0]!.id, `contact-groups-${suffix}@s.whatsapp.net`],
    );

    const defaults = await app!.inject({ method: 'GET', url: '/api/whatsapp/chat-groups', headers: { cookie: cookieA } });
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json()).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Trabalho', system: true })]));

    const created = await app!.inject({
      method: 'POST', url: '/api/whatsapp/chat-groups', headers: { cookie: cookieA },
      payload: { name: 'Clientes prioritários', description: 'Contatos profissionais importantes.' },
    });
    expect(created.statusCode).toBe(201);
    const group = created.json() as { id: string; name: string };

    const updated = await app!.inject({
      method: 'PATCH', url: `/api/whatsapp/chats/${chat.rows[0]!.id}`, headers: { cookie: cookieA },
      payload: { enabled: true, groupId: group.id },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ selected: true, group: { id: group.id, name: group.name }, classification: { source: 'manual' } });

    const foreign = await app!.inject({
      method: 'PATCH', url: `/api/whatsapp/chats/${chat.rows[0]!.id}`, headers: { cookie: cookieB },
      payload: { enabled: false },
    });
    expect(foreign.statusCode).toBe(404);

    const removed = await app!.inject({
      method: 'DELETE', url: `/api/whatsapp/chat-groups/${group.id}`, headers: { cookie: cookieA },
    });
    expect(removed.statusCode).toBe(204);
    const assignment = await database!.query<{ conversation_group_id: string | null; group_assignment_source: string | null }>(
      'SELECT conversation_group_id,group_assignment_source FROM monitored_chats WHERE id=$1 AND user_id=$2',
      [chat.rows[0]!.id, userA.id],
    );
    expect(assignment.rows[0]).toEqual({ conversation_group_id: null, group_assignment_source: null });
  });

  it('marks an existing Trello projection pending and queues an idempotent versioned sync after PATCH', async () => {
    const created = await app!.inject({
      method: 'POST', url: '/api/tasks', headers: { cookie: cookieA },
      payload: { title: 'Tarefa com projeção', description: 'Conteúdo manual original', priority: 'medium' },
    });
    expect(created.statusCode).toBe(201);
    const task = created.json() as { id: string; version: number };
    const manualContent = async () => database!.query<{ manual_content: string }>(
      `SELECT n.manual_content FROM brain_nodes n JOIN canonical_tasks t ON t.brain_node_id=n.id AND t.user_id=n.user_id
       WHERE t.id=$1 AND t.user_id=$2`, [task.id, userA.id],
    );
    expect((await manualContent()).rows[0]!.manual_content).toBe('Conteúdo manual original');
    const trello = await database!.query<{ connection_id: string; board_config_id: string; board_id: string; list_id: string }>(
      `SELECT tc.id AS connection_id,bc.id AS board_config_id,bc.board_id,bc.inbox_list_id AS list_id
       FROM trello_connections tc JOIN trello_board_configs bc
         ON bc.trello_connection_id=tc.id AND bc.user_id=tc.user_id
       WHERE tc.user_id=$1 AND tc.status='connected' AND bc.is_active=true LIMIT 1`, [userA.id],
    );
    const setup = trello.rows[0]!;
    const card = await database!.query<{ id: string }>(
      `INSERT INTO trello_cards
        (user_id,trello_connection_id,trello_board_config_id,trello_card_id,board_id,list_id,title)
       VALUES ($1,$2,$3,$4,$5,$6,'Tarefa com projeção') RETURNING id`,
      [userA.id, setup.connection_id, setup.board_config_id, `card-${suffix}`, setup.board_id, setup.list_id],
    );
    await database!.query(
      `INSERT INTO task_trello_links (user_id,task_id,trello_card_id,sync_status,atlas_revision)
       VALUES ($1,$2,$3,'synced',$4)`, [userA.id, task.id, card.rows[0]!.id, task.version],
    );

    const updated = await app!.inject({
      method: 'PATCH', url: `/api/tasks/${task.id}`, headers: { cookie: cookieA },
      payload: { title: 'Tarefa projetada atualizada' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ id: task.id, version: 2, title: 'Tarefa projetada atualizada' });
    expect((await manualContent()).rows[0]!.manual_content).toBe('Conteúdo manual original');
    const link = await database!.query<{ sync_status: string; atlas_revision: number; metadata: Record<string, unknown> }>(
      'SELECT sync_status,atlas_revision,metadata FROM task_trello_links WHERE user_id=$1 AND task_id=$2',
      [userA.id, task.id],
    );
    expect(link.rows[0]).toMatchObject({
      sync_status: 'pending', atlas_revision: 2,
      metadata: { canonicalTaskVersion: 2, pendingAction: 'update' },
    });
    const jobs = await database!.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM job_attempts
       WHERE user_id=$1 AND job_type='task:sync_trello' AND job_key=$2`,
      [userA.id, `${task.id}:v2:update`],
    );
    expect(jobs.rows[0]!.count).toBe(1);

    const terminalPatch = await app!.inject({
      method: 'PATCH', url: `/api/tasks/${task.id}`, headers: { cookie: cookieA }, payload: { status: 'done' },
    });
    expect(terminalPatch.statusCode).toBe(400);

    const comment = await app!.inject({
      method: 'POST', url: `/api/tasks/${task.id}/actions`, headers: { cookie: cookieA },
      payload: { action: 'comment', comment: 'Validar com o responsável.' },
    });
    expect(comment.statusCode).toBe(200);
    const commentJob = await database!.query<{ input: Record<string, unknown> }>(
      `SELECT input FROM job_attempts WHERE user_id=$1 AND job_type='task:sync_trello'
         AND input->>'taskId'=$2 AND input->>'action'='comment' ORDER BY created_at DESC LIMIT 1`,
      [userA.id, task.id],
    );
    expect(commentJob.rows[0]!.input).toMatchObject({
      taskId: task.id, canonicalTaskVersion: 2, action: 'comment', comment: 'Validar com o responsável.',
    });

    await database!.query(
      `UPDATE trello_cards SET title='Título vindo do Trello',description='Descrição do Trello',due_complete=true
       WHERE id=$1 AND user_id=$2`, [card.rows[0]!.id, userA.id],
    );
    await database!.query(
      `UPDATE task_trello_links SET sync_status='conflict',last_error='edições concorrentes'
       WHERE task_id=$1 AND user_id=$2`, [task.id, userA.id],
    );
    const keepTrello = await app!.inject({
      method: 'POST', url: `/api/tasks/${task.id}/conflict`, headers: { cookie: cookieA },
      payload: { resolution: 'keep_trello' },
    });
    expect(keepTrello.statusCode).toBe(200);
    expect(keepTrello.json()).toMatchObject({
      resolution: 'keep_trello', syncStatus: 'synced',
      task: { title: 'Título vindo do Trello', description: 'Descrição do Trello', status: 'done', version: 3 },
    });
    const manual = await manualContent();
    expect(manual.rows[0]!.manual_content).toBe('Conteúdo manual original');

    await database!.query(
      `UPDATE task_trello_links SET sync_status='conflict' WHERE task_id=$1 AND user_id=$2`, [task.id, userA.id],
    );
    const keepAtlas = await app!.inject({
      method: 'POST', url: `/api/tasks/${task.id}/conflict`, headers: { cookie: cookieA },
      payload: { resolution: 'keep_atlas' },
    });
    expect(keepAtlas.statusCode).toBe(200);
    expect(keepAtlas.json()).toMatchObject({ resolution: 'keep_atlas', syncStatus: 'pending' });
  });
});
