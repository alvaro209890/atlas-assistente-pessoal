import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from 'pg';

export interface DatabaseConfig {
  connectionString: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  applicationName?: string;
  ssl?: boolean | { rejectUnauthorized: boolean };
}

export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<T>>;
}

export interface Database extends Queryable {
  readonly pool: Pool;
  transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
  userTransaction<T>(userId: string, fn: (client: PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

class PgDatabase implements Database {
  readonly pool: Pool;

  constructor(config: DatabaseConfig) {
    const poolConfig: PoolConfig = {
      connectionString: config.connectionString,
      max: config.max ?? 10,
      idleTimeoutMillis: config.idleTimeoutMillis ?? 30_000,
      connectionTimeoutMillis: config.connectionTimeoutMillis ?? 10_000,
      application_name: config.applicationName ?? 'atlas-api',
    };
    if (config.ssl !== undefined) poolConfig.ssl = config.ssl;
    this.pool = new Pool(poolConfig);
  }

  query<T extends QueryResultRow = QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, [...values]);
  }

  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  userTransaction<T>(userId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(async (client) => {
      await client.query("SELECT set_config('app.actor_user_id', $1, true)", [userId]);
      return fn(client);
    });
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}

export function createDatabase(config: DatabaseConfig): Database {
  if (!config.connectionString) throw new Error('Database connectionString is required');
  return new PgDatabase(config);
}

export function createDatabaseFromEnv(env: NodeJS.ProcessEnv = process.env): Database {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const ssl = env.DATABASE_SSL === '1'
    ? { rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED !== '0' }
    : undefined;
  return createDatabase({
    connectionString,
    max: Number(env.DATABASE_POOL_MAX || 10),
    applicationName: env.DATABASE_APPLICATION_NAME || 'atlas-api',
    ...(ssl === undefined ? {} : { ssl }),
  });
}

export { runMigrations, discoverMigrations, type Migration } from './migrations.js';
export { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
