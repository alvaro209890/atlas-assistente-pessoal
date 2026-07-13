import { createDatabaseFromEnv } from './index.js';
import { runMigrations } from './migrations.js';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the opt-in development seed`);
  return value;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PRODUCTION_SEED !== '1') {
    throw new Error('Development seed is disabled in production. Set ALLOW_PRODUCTION_SEED=1 only for an intentional one-off run.');
  }

  const email = requiredEnv('SEED_USER_EMAIL').toLowerCase();
  const password = requiredEnv('SEED_USER_PASSWORD');
  const displayName = process.env.SEED_USER_NAME?.trim() || 'Pessoa Atlas';
  if (password.length < 10) throw new Error('SEED_USER_PASSWORD must have at least 10 characters');

  const database = createDatabaseFromEnv();
  try {
    await runMigrations(database);
    const userId = await database.transaction(async (client) => {
      const existing = await client.query<{ id: string }>(
        'SELECT id FROM users WHERE lower(email) = lower($1)',
        [email],
      );

      let id: string;
      if (existing.rows[0]) {
        id = existing.rows[0].id;
        if (process.env.SEED_RESET_PASSWORD === '1') {
          await client.query(
            `UPDATE users
             SET display_name = $2, preferred_name = $2, password_hash = crypt($3, gen_salt('bf', 12))
             WHERE id = $1`,
            [id, displayName, password],
          );
        } else {
          await client.query('UPDATE users SET display_name = $2, preferred_name = $2 WHERE id = $1', [id, displayName]);
        }
      } else {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO users (email, password_hash, display_name, preferred_name)
           VALUES (lower($1), crypt($2, gen_salt('bf', 12)), $3, $3)
           RETURNING id`,
          [email, password, displayName],
        );
        id = inserted.rows[0]!.id;
      }

      await client.query(
        `INSERT INTO user_settings (user_id, feature_flags)
         VALUES ($1, '{"onboardingComplete":true,"notifySelf":true}'::jsonb)
         ON CONFLICT (user_id) DO UPDATE
         SET feature_flags = user_settings.feature_flags || EXCLUDED.feature_flags`,
        [id],
      );
      await client.query(
        `INSERT INTO user_profiles (user_id)
         VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
        [id],
      );

      const seedNodes = [
        {
          sourceId: 'project-aurora',
          type: 'project',
          domain: 'trabalho',
          title: 'Projeto Aurora',
          content: 'Preparar o lançamento da Aurora. A prioridade desta semana é concluir a apresentação e alinhar a comunicação com a equipe.',
          tags: ['projeto', 'prioridade'],
          metadata: { status: 'active', progress: 68, accent: '#7c5cff' },
        },
        {
          sourceId: 'person-marina',
          type: 'person',
          domain: 'pessoas',
          title: 'Marina Costa',
          content: 'Responsável pela comunicação do Projeto Aurora. Prefere decisões objetivas e contexto por escrito.',
          tags: ['pessoa', 'aurora'],
          metadata: { role: 'Comunicação', accent: '#26a69a' },
        },
        {
          sourceId: 'weekly-decisions',
          type: 'note',
          domain: 'trabalho',
          title: 'Decisões da semana',
          content: 'O lançamento da Aurora segue para quinta-feira. Marina revisa o texto; a apresentação final precisa estar pronta antes das 14:00.',
          tags: ['decisão', 'semana'],
          metadata: { pinned: true },
        },
        {
          sourceId: 'product-meeting',
          type: 'meeting',
          domain: 'trabalho',
          title: 'Reunião de produto',
          content: 'A equipe confirmou o escopo do lançamento, separou os responsáveis e registrou os riscos de prazo.',
          tags: ['reunião', 'produto'],
          metadata: { participants: ['Marina Costa'] },
        },
        {
          sourceId: 'presentation-task',
          type: 'task',
          domain: 'trabalho',
          title: 'Revisar apresentação final',
          content: 'Fechar os últimos slides, revisar dados e enviar para Marina antes das 14:00.',
          tags: ['hoje', 'aurora'],
          metadata: { priority: 'high', status: 'active', dueLabel: 'Hoje, 14:00' },
        },
      ] as const;

      const nodeIds = new Map<string, string>();
      for (const node of seedNodes) {
        const result = await client.query<{ id: string }>(
          `INSERT INTO brain_nodes (
             user_id, type, domain, title, manual_content, tags,
             source_type, source_id, metadata, happened_at
           ) VALUES ($1, $2, $3, $4, $5, $6, 'seed', $7, $8, now())
           ON CONFLICT (user_id, source_type, source_id)
             WHERE source_type IS NOT NULL AND source_id IS NOT NULL
           DO UPDATE SET
             type = EXCLUDED.type,
             domain = EXCLUDED.domain,
             title = EXCLUDED.title,
             manual_content = EXCLUDED.manual_content,
             tags = EXCLUDED.tags,
             metadata = EXCLUDED.metadata
           RETURNING id`,
          [id, node.type, node.domain, node.title, node.content, [...node.tags], node.sourceId, node.metadata],
        );
        nodeIds.set(node.sourceId, result.rows[0]!.id);
      }

      const edges = [
        ['weekly-decisions', 'project-aurora', 'belongs_to'],
        ['product-meeting', 'project-aurora', 'relates_to'],
        ['presentation-task', 'project-aurora', 'belongs_to'],
        ['person-marina', 'project-aurora', 'works_on'],
        ['weekly-decisions', 'person-marina', 'mentions'],
      ] as const;
      for (const [from, to, relation] of edges) {
        await client.query(
          `INSERT INTO brain_edges (user_id, from_node_id, to_node_id, relation_type, provenance)
           VALUES ($1, $2, $3, $4, 'import')
           ON CONFLICT (user_id, from_node_id, to_node_id, relation_type) DO NOTHING`,
          [id, nodeIds.get(from), nodeIds.get(to), relation],
        );
      }

      const automations = [
        ['Resumo matinal', 'morning_digest', '0 8 * * *', { notifySelf: true }],
        ['Lembrete de pendências', 'pending_reminder', '0 18 * * 1-5', { notifySelf: true }],
        ['Organizar novas conversas', 'message_ingestion', null, { batchWindowMinutes: 5 }],
      ] as const;
      for (const [name, kind, schedule, config] of automations) {
        const current = await client.query<{ id: string }>(
          'SELECT id FROM automations WHERE user_id = $1 AND kind = $2 LIMIT 1',
          [id, kind],
        );
        if (current.rows[0]) {
          await client.query(
            'UPDATE automations SET name = $3, schedule = $4, config = $5 WHERE id = $2 AND user_id = $1',
            [id, current.rows[0].id, name, schedule, config],
          );
        } else {
          await client.query(
            `INSERT INTO automations (user_id, name, kind, schedule, config)
             VALUES ($1, $2, $3, $4, $5)`,
            [id, name, kind, schedule, config],
          );
        }
      }

      return id;
    });

    process.stdout.write(`Development seed ready for ${email} (user ${userId}).\n`);
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Seed failed: ${message}\n`);
  process.exitCode = 1;
});
