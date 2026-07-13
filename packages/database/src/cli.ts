#!/usr/bin/env node
import { createDatabaseFromEnv } from './index.js';
import { runMigrations } from './migrations.js';

async function main(): Promise<void> {
  const command = process.argv[2] || 'migrate';
  if (command !== 'migrate') throw new Error(`Unknown database command: ${command}`);
  const database = createDatabaseFromEnv();
  try {
    const applied = await runMigrations(database, process.env.MIGRATIONS_DIR);
    process.stdout.write(applied.length ? `Applied: ${applied.join(', ')}\n` : 'Database is up to date.\n');
  } finally {
    await database.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
