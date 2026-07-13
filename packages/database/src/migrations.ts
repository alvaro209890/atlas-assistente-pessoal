import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from './index.js';

export interface Migration {
  name: string;
  sql: string;
}
export async function discoverMigrations(directory?: string): Promise<Migration[]> {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = directory
    ? [resolve(directory)]
    : [resolve(moduleDir, '../migrations'), resolve(moduleDir, '../../migrations')];

  let migrationDir: string | undefined;
  let names: string[] = [];
  for (const candidate of candidates) {
    try {
      const files = await readdir(candidate);
      names = files.filter((name) => /^\d+.*\.sql$/i.test(name)).sort();
      if (names.length) {
        migrationDir = candidate;
        break;
      }
    } catch {
      // Try the next package layout (src vs dist).
    }
  }
  if (!migrationDir) throw new Error(`No SQL migrations found in: ${candidates.join(', ')}`);

  return Promise.all(names.map(async (name) => ({
    name,
    sql: await readFile(resolve(migrationDir, name), 'utf8'),
  })));
}
export async function runMigrations(database: Database, directory?: string): Promise<string[]> {
  const migrations = await discoverMigrations(directory);
  const applied: string[] = [];
  const client = await database.pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('atlas-schema-migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const existing = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const done = new Set(existing.rows.map((row) => row.name));

    for (const migration of migrations) {
      if (done.has(migration.name)) continue;
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [migration.name]);
        await client.query('COMMIT');
        applied.push(migration.name);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${migration.name} failed`, { cause: error });
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('atlas-schema-migrations'))").catch(() => undefined);
    client.release();
  }
  return applied;
}
