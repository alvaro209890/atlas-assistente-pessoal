import { randomUUID } from 'node:crypto';
import { createDatabase, runMigrations, type Database } from '@atlas/database';
import type { AiTask } from '@atlas/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkerRepository } from '../src/repository.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? '';
const describeWithPostgres = testDatabaseUrl ? describe : describe.skip;

function task(title: string, evidenceMessageId: string): AiTask {
  return {
    clientRef: evidenceMessageId, operation: 'create', authorization: 'inferred', authorizationMessageId: null,
    canonicalTaskId: null, candidateCardId: null, mergeSourceCardIds: [], title,
    description: 'Relatório financeiro mensal para João.', priority: 'high', targetListRole: 'inbox',
    nextAction: 'Revisar e enviar o relatório', waitingOn: null, risk: 'low', checklist: [],
    dueAt: '2026-07-20T17:00:00-03:00', dueBasis: 'explicit_absolute', labelsToRemove: [],
    memberIdsToAdd: [], memberIdsToRemove: [], project: 'Financeiro', person: 'João',
    estimateMinutes: 30, recurrence: null, labels: [], confidence: 0.95,
    evidenceMessageIds: [evidenceMessageId], missingInformation: [],
  };
}

describeWithPostgres('canonical task semantic deduplication with PostgreSQL', () => {
  let database: Database;
  let userId: string;

  beforeAll(async () => {
    database = createDatabase({ connectionString: testDatabaseUrl, applicationName: 'atlas-worker-dedupe-test' });
    await runMigrations(database);
    userId = randomUUID();
    await database.query(
      `INSERT INTO users (id,email,password_hash,display_name,preferred_name) VALUES ($1,$2,'test','Teste','Teste')`,
      [userId, `worker-dedupe-${userId}@example.test`],
    );
  });

  afterAll(async () => {
    if (database && userId) await database.query('DELETE FROM users WHERE id=$1', [userId]);
    await database?.close();
  });

  it('reuses one canonical task for a Portuguese reformulation in a later batch', async () => {
    const repository = new WorkerRepository(database);
    const first = await repository.prepareCanonicalTask(userId, task('Enviar o relatório financeiro ao João', 'mensagem-a'));
    const second = await repository.prepareCanonicalTask(userId, task('Mandar relatório financeiro para João', 'mensagem-b'));
    expect(second.taskId).toBe(first.taskId);
    const count = await database.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM canonical_tasks WHERE user_id=$1', [userId],
    );
    expect(count.rows[0]!.count).toBe(1);
  });
});
