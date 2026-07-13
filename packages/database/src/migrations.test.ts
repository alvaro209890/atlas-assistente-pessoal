import { describe, expect, it } from 'vitest';
import { discoverMigrations } from './migrations.js';

describe('database migrations', () => {
  it('ship ordered core and integration migrations with tenant and search primitives', async () => {
    const migrations = await discoverMigrations();
    const names = migrations.map((migration) => migration.name);
    expect(names.slice(0, 4)).toEqual([
      '0001_core.sql',
      '0002_integrations.sql',
      '0003_runtime_records.sql',
      '0004_whatsapp_runtime.sql',
    ]);
    expect(names).toEqual([...names].sort());
    const sql = migrations.map((migration) => migration.sql).join('\n');
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    expect(sql).toContain('search_vector tsvector');
    expect(sql).toContain('user_id uuid NOT NULL');
    expect(sql).toContain('brain_node_revisions');
    expect(sql).toContain('brain_chat_messages');
    expect(sql).toContain('UNIQUE (id, user_id)');
    for (const table of [
      'whatsapp_messages', 'message_batches', 'ai_runs', 'ai_usage_events',
      'job_attempts', 'idempotency_keys', 'notification_outbox',
      'trello_cards', 'trello_card_node_map',
      'whatsapp_auth_records', 'whatsapp_conversation_catalog',
      'user_profiles', 'canonical_tasks', 'task_events', 'task_trello_links',
      'reminders', 'reminder_occurrences', 'commitments', 'assistant_learnings',
      'assistant_learning_evidence', 'assistant_action_outcomes', 'brain_node_sources',
      'action_proposals',
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(sql).toContain('preferred_name text');
    expect(sql).toContain("status IN ('inbox','open','in_progress','paused','done','cancelled','merged')");
    expect(sql).toContain('FOREIGN KEY (task_id, user_id)');
    expect(sql).toContain('assistant_learnings_scope_id');
    expect(sql).toContain('UNIQUE NULLS NOT DISTINCT (user_id, scope_type, scope_id, learning_key, version)');
    expect(sql).toContain('UNIQUE NULLS NOT DISTINCT (user_id, learning_id, evidence_type, source_id)');
    expect(sql).toContain('task_events_actor_tenant_safe');
    expect(sql).toContain('FOREIGN KEY (notification_outbox_id, user_id)');
    expect(sql).toContain('whatsapp_connections_one_active_per_user_idx');
  });
});
