import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from './index.js';
import { runMigrations } from './migrations.js';

const connectionString = process.env.TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;

suite('PostgreSQL integration', () => {
  let database: Database;

  beforeAll(async () => {
    database = createDatabase({ connectionString: connectionString! });
    await runMigrations(database);
  });

  afterAll(async () => {
    await database?.close();
  });

  it('supports Portuguese search, strict tenant isolation and non-destructive generated refreshes', async () => {
    await database.transaction(async (client) => {
      const user = await client.query<{ id: string }>(
        "INSERT INTO users (email, password_hash, display_name, preferred_name) VALUES ($1, 'test', 'Teste', 'Teste') RETURNING id",
        [`integration-${Date.now()}@example.test`],
      );
      const userId = user.rows[0]!.id;
      const otherUser = await client.query<{ id: string }>(
        "INSERT INTO users (email, password_hash, display_name, preferred_name) VALUES ($1, 'test', 'Outro', 'Outro') RETURNING id",
        [`integration-other-${Date.now()}@example.test`],
      );
      const otherUserId = otherUser.rows[0]!.id;
      await client.query('INSERT INTO user_profiles (user_id) VALUES ($1),($2)', [userId, otherUserId]);
      const node = await client.query<{ id: string }>(
        `INSERT INTO brain_nodes
           (user_id, type, domain, title, manual_content, generated_content, source_type, source_id)
         VALUES ($1, 'procedure', 'work', 'Revisão do projeto', 'Anotação manual que deve permanecer',
           'Primeiro resumo ambiental', 'integration', 'shared-source') RETURNING id`,
        [userId],
      );
      await client.query(
        `INSERT INTO brain_nodes
           (user_id, type, domain, title, manual_content, generated_content, source_type, source_id)
         VALUES ($1, 'procedure', 'work', 'Relatório privado de outra pessoa', 'Não pode vazar',
           'Outro resumo ambiental', 'integration', 'shared-source')`,
        [otherUserId],
      );

      const refreshed = await client.query<{ manual_content: string; generated_content: string }>(
        `INSERT INTO brain_nodes
           (user_id, type, domain, title, generated_content, source_type, source_id)
         VALUES ($1, 'procedure', 'work', 'Revisão do projeto', 'Resumo ambiental atualizado', 'integration', 'shared-source')
         ON CONFLICT (user_id, source_type, source_id)
           WHERE source_type IS NOT NULL AND source_id IS NOT NULL
         DO UPDATE SET generated_content = EXCLUDED.generated_content
         RETURNING manual_content, generated_content`,
        [userId],
      );
      expect(refreshed.rows[0]).toEqual({
        manual_content: 'Anotação manual que deve permanecer',
        generated_content: 'Resumo ambiental atualizado',
      });

      const found = await client.query<{ title: string }>(
        `SELECT title FROM brain_nodes
         WHERE user_id = $1 AND search_vector @@ websearch_to_tsquery('portuguese', $2)
         ORDER BY title`,
        [userId, 'ambiental'],
      );
      expect(found.rows.map((row) => row.title)).toEqual(['Revisão do projeto']);

      const listed = await client.query<{ id: string; title: string }>(
        'SELECT id,title FROM brain_nodes WHERE user_id=$1 ORDER BY title', [userId],
      );
      expect(listed.rows).toEqual([{ id: node.rows[0]!.id, title: 'Revisão do projeto' }]);
      expect(listed.rows.some((row) => row.title.includes('outra pessoa'))).toBe(false);
      throw new Error('rollback fixture');
    }).catch((error: unknown) => {
      if (!(error instanceof Error) || error.message !== 'rollback fixture') throw error;
    });
  });
});
