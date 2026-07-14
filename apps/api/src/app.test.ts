import type { PoolClient, QueryResult, QueryResultRow } from '@atlas/database';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import type { AppDatabase } from './types.js';
import { frontendWhatsappStatus } from './routes/integrations.js';

function emptyResult<T extends QueryResultRow = QueryResultRow>(): QueryResult<T> {
  return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
}

function fakeDatabase(overrides: Partial<AppDatabase> = {}): AppDatabase {
  return {
    query: async () => emptyResult(),
    transaction: async <T>(fn: (client: PoolClient) => Promise<T>) => fn({} as PoolClient),
    userTransaction: async <T>(_userId: string, fn: (client: PoolClient) => Promise<T>) => fn({} as PoolClient),
    close: async () => undefined,
    ...overrides,
  };
}

describe('API health probes', () => {
  const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  it('keeps liveness independent and checks the database for readiness', async () => {
    const app = await buildApp({
      database: fakeDatabase(), config: loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }), logger: false,
    });
    apps.push(app);
    const health = await app.inject({ method: 'GET', url: '/health' });
    const ready = await app.inject({ method: 'GET', url: '/ready' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: 'ok', service: 'atlas-api' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ status: 'ready', checks: { database: { ok: true } } });
  });

  it('returns 503 readiness while liveness stays up when PostgreSQL is unavailable', async () => {
    const app = await buildApp({
      database: fakeDatabase({ query: async () => { throw new Error('offline'); } }),
      config: loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }), logger: false,
    });
    apps.push(app);
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(503);
  });

  it('serves the admin WhatsApp console without a user session', async () => {
    const database = fakeDatabase({
      query: async <T extends QueryResultRow>(text: string) => {
        if (text.includes('FROM platform_whatsapp_connection')) {
          return {
            ...emptyResult<T>(), rowCount: 1, rows: [{
              display_name: 'WhatsApp mãe do Atlas', status: 'disconnected', phone_number: null,
              pairing_qr: null, pairing_expires_at: null, last_connected_at: null, last_error: null,
              welcome_message: 'Mensagem de boas-vindas para {nome}.', updated_at: new Date(),
            } as T],
          };
        }
        return emptyResult<T>();
      },
    });
    const app = await buildApp({ database, config: loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }), logger: false });
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/api/admin/whatsapp' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'disconnected', displayName: 'WhatsApp mãe do Atlas' });
  });
});
describe('WhatsApp status contract', () => {
  it('preserves reconnecting and only reports qr when a code exists', () => {
    expect(frontendWhatsappStatus('reconnecting')).toBe('reconnecting');
    expect(frontendWhatsappStatus('pairing')).toBe('connecting');
    expect(frontendWhatsappStatus('pairing', true)).toBe('qr');
    expect(frontendWhatsappStatus('error')).toBe('error');
    expect(frontendWhatsappStatus('logged_out')).toBe('disconnected');
  });
});
