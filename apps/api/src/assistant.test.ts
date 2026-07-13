import type { PoolClient, QueryResult, QueryResultRow } from '@atlas/database';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { inferProposals } from './routes/chat.js';
import { materializeNextOccurrence, normalizeWorkDays } from './routes/assistant.js';
import { assertOnboardingPrerequisites, canonicalAutomationDefinition, normalizeTrelloLabels } from './routes/platform.js';
import type { AppDatabase } from './types.js';
import { alwaysLearningKey, canAutoExecuteProposal } from './proposal-policy.js';

function emptyResult<T extends QueryResultRow = QueryResultRow>(): QueryResult<T> {
  return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
}

function fakeDatabase(): AppDatabase {
  return {
    query: async () => emptyResult(),
    transaction: async <T>(fn: (client: PoolClient) => Promise<T>) => fn({} as PoolClient),
    userTransaction: async <T>(_userId: string, fn: (client: PoolClient) => Promise<T>) => fn({} as PoolClient),
    close: async () => undefined,
  };
}

describe('Atlas V2 API contracts', () => {
  const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  it('requires a real preferredName instead of deriving it from the email', async () => {
    const app = await buildApp({
      database: fakeDatabase(), config: loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }), logger: false,
    });
    apps.push(app);
    const missing = await app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { email: 'pessoa@example.test', password: 'Senha-segura-123!', name: 'Campo legado' },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('registers the new multi-user resources behind authentication', async () => {
    const app = await buildApp({
      database: fakeDatabase(), config: loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }), logger: false,
    });
    apps.push(app);
    for (const url of ['/api/profile', '/api/tasks', '/api/reminders', '/api/commitments',
      '/api/assistant/learnings', '/api/assistant/proposals']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
    }
  });

  it('turns action-like chat requests into confirmable drafts without executing them', () => {
    expect(inferProposals('Crie uma tarefa: revisar o contrato')).toEqual([
      expect.objectContaining({ proposalType: 'create_task', risk: 'low', reversible: true,
        payload: { title: 'revisar o contrato' } }),
    ]);
    expect(inferProposals('Cancele a tarefa antiga')).toEqual([
      expect.objectContaining({ proposalType: 'task_mutation', risk: 'destructive', reversible: false,
        payload: expect.objectContaining({ needsTargetResolution: true }) }),
    ]);
  });

  it('normalizes Sunday and materializes recurrence-only reminders deterministically', () => {
    expect(normalizeWorkDays([1, 2, 7])).toEqual([0, 1, 2]);
    expect(normalizeWorkDays([0, 7, 1])).toEqual([0, 1]);
    const now = new Date('2026-07-13T12:00:00.000Z');
    expect(materializeNextOccurrence({ intervalMinutes: 90 }, now).toISOString())
      .toBe('2026-07-13T13:30:00.000Z');
    expect(materializeNextOccurrence({ frequency: 'weekly' }, now).toISOString())
      .toBe('2026-07-20T12:00:00.000Z');
  });

  it('reports the first incomplete onboarding stage with a stable error code', () => {
    const complete = {
      preferredName: 'Ana', professionalArea: 'Engenharia', goals: ['Organizar projetos'], workDays: [1, 2, 3],
      whatsappConnected: true, trelloConnected: true, mappingComplete: true,
      selectedChatCount: 1, validSelectedChatCount: 1,
    };
    const cases = [
      [{ ...complete, professionalArea: null }, 'ONBOARDING_PROFILE_INCOMPLETE'],
      [{ ...complete, whatsappConnected: false }, 'ONBOARDING_WHATSAPP_NOT_CONNECTED'],
      [{ ...complete, trelloConnected: false }, 'ONBOARDING_TRELLO_NOT_CONNECTED'],
      [{ ...complete, mappingComplete: false }, 'ONBOARDING_TRELLO_MAPPING_INCOMPLETE'],
      [{ ...complete, selectedChatCount: 0, validSelectedChatCount: 0 }, 'ONBOARDING_CHAT_REQUIRED'],
      [{ ...complete, validSelectedChatCount: 0 }, 'ONBOARDING_CHAT_INVALID'],
    ] as const;
    for (const [snapshot, code] of cases) {
      expect(() => assertOnboardingPrerequisites(snapshot)).toThrow(expect.objectContaining({ code }));
    }
    expect(() => assertOnboardingPrerequisites(complete)).not.toThrow();
  });

  it('normalizes the compact automation DTO used by the workspace', () => {
    expect(canonicalAutomationDefinition('briefing', '07:45')).toEqual({
      name: 'Briefing pessoal', schedule: '45 7 * * *',
      config: { canonicalKind: 'briefing', time: '07:45' },
    });
    expect(canonicalAutomationDefinition('weekly_review', '18:10')).toMatchObject({
      name: 'Revisão semanal', schedule: '10 18 * * 1',
    });
    expect(canonicalAutomationDefinition('deadline')).toMatchObject({ schedule: '*/15 * * * *' });
  });

  it('normalizes Trello labels from legacy strings and object snapshots', () => {
    expect(normalizeTrelloLabels(['Urgente', ' Projeto ', 'Urgente'])).toEqual(['Urgente', 'Projeto']);
    expect(normalizeTrelloLabels([
      { name: 'Cliente', color: 'red' }, { name: '', color: 'blue' }, { color: 'green' }, null,
    ])).toEqual(['Cliente', 'blue', 'green']);
    expect(normalizeTrelloLabels(null)).toEqual([]);
  });

  it('uses stable always-rule keys and never auto-executes destructive proposals', () => {
    expect(alwaysLearningKey('create_task')).toBe('proposal:create_task:always');
    expect(alwaysLearningKey('create_task')).not.toContain('proposal-id');
    expect(canAutoExecuteProposal({ reversible: true, risk: 'low' })).toBe(true);
    expect(canAutoExecuteProposal({ reversible: true, risk: 'destructive' })).toBe(false);
    expect(canAutoExecuteProposal({ reversible: false, risk: 'low' })).toBe(false);
    expect(canAutoExecuteProposal({ reversible: true, risk: 'low', proposalType: 'profile_change' })).toBe(false);
    expect(canAutoExecuteProposal({ reversible: true, risk: 'low', proposalType: 'external_recipient' })).toBe(false);
  });
});
