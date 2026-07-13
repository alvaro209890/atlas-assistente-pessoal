-- Atlas V2: perfis pessoais, tarefas canônicas, lembretes, compromissos,
-- aprendizado auditável, fontes do cérebro e propostas confirmáveis.

ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_name text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name text;
UPDATE users
SET preferred_name = COALESCE(NULLIF(btrim(display_name), ''), 'Pessoa')
WHERE preferred_name IS NULL OR btrim(preferred_name) = '';
ALTER TABLE users ALTER COLUMN preferred_name SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_preferred_name_not_blank
    CHECK (btrim(preferred_name) <> '');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  professional_area text,
  goals text[] NOT NULL DEFAULT '{}',
  whatsapp_name_suggestion text,
  whatsapp_name_suggested_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_profiles_goals_limit CHECK (cardinality(goals) <= 3)
);
CREATE TRIGGER user_profiles_set_updated_at BEFORE UPDATE ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO user_profiles (user_id)
SELECT id FROM users
ON CONFLICT (user_id) DO NOTHING;

ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS work_days smallint[] NOT NULL DEFAULT '{1,2,3,4,5}';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS work_start time NOT NULL DEFAULT '08:00';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS work_end time NOT NULL DEFAULT '18:00';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS quiet_start time NOT NULL DEFAULT '21:00';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS quiet_end time NOT NULL DEFAULT '07:00';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS communication_style text NOT NULL DEFAULT 'balanced';

DO $$ BEGIN
  ALTER TABLE user_settings ADD CONSTRAINT user_settings_work_days_valid
    CHECK (work_days <@ ARRAY[0,1,2,3,4,5,6]::smallint[] AND cardinality(work_days) BETWEEN 1 AND 7);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE user_settings ADD CONSTRAINT user_settings_work_hours_valid
    CHECK (work_start <> work_end);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE user_settings ADD CONSTRAINT user_settings_communication_style_valid
    CHECK (communication_style IN ('concise', 'balanced', 'detailed', 'encouraging'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS canonical_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brain_node_id uuid,
  project_node_id uuid,
  person_node_id uuid,
  merged_into_task_id uuid,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('inbox','open','in_progress','paused','done','cancelled','merged')),
  priority text NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('low','medium','high','urgent')),
  risk text NOT NULL DEFAULT 'low'
    CHECK (risk IN ('low','medium','high','critical')),
  next_action text,
  due_at timestamptz,
  estimated_minutes integer CHECK (estimated_minutes IS NULL OR estimated_minutes > 0),
  recurrence jsonb,
  expected_owner text,
  source_fingerprint text,
  confidence numeric(4,3) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  completed_at timestamptz,
  cancelled_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT canonical_tasks_title_not_blank CHECK (btrim(title) <> ''),
  UNIQUE (id, user_id),
  FOREIGN KEY (brain_node_id, user_id) REFERENCES brain_nodes(id, user_id) ON DELETE SET NULL (brain_node_id),
  FOREIGN KEY (project_node_id, user_id) REFERENCES brain_nodes(id, user_id) ON DELETE SET NULL (project_node_id),
  FOREIGN KEY (person_node_id, user_id) REFERENCES brain_nodes(id, user_id) ON DELETE SET NULL (person_node_id),
  FOREIGN KEY (merged_into_task_id, user_id) REFERENCES canonical_tasks(id, user_id) ON DELETE SET NULL (merged_into_task_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS canonical_tasks_brain_node_uidx
  ON canonical_tasks (user_id, brain_node_id) WHERE brain_node_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS canonical_tasks_fingerprint_uidx
  ON canonical_tasks (user_id, source_fingerprint) WHERE source_fingerprint IS NOT NULL;
CREATE INDEX IF NOT EXISTS canonical_tasks_status_due_idx
  ON canonical_tasks (user_id, status, due_at NULLS LAST, priority);
CREATE INDEX IF NOT EXISTS canonical_tasks_project_idx
  ON canonical_tasks (user_id, project_node_id, status);
CREATE INDEX IF NOT EXISTS canonical_tasks_title_trgm_idx
  ON canonical_tasks USING gin (title gin_trgm_ops);
CREATE TRIGGER canonical_tasks_set_updated_at BEFORE UPDATE ON canonical_tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS task_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  event_type text NOT NULL,
  actor_type text NOT NULL DEFAULT 'atlas'
    CHECK (actor_type IN ('user','atlas','worker','trello','import')),
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_events_actor_tenant_safe CHECK (actor_user_id IS NULL OR actor_user_id = user_id),
  UNIQUE (id, user_id),
  UNIQUE (user_id, task_id, idempotency_key),
  FOREIGN KEY (task_id, user_id) REFERENCES canonical_tasks(id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS task_events_task_idx ON task_events (user_id, task_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS task_trello_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  trello_card_id uuid NOT NULL,
  sync_status text NOT NULL DEFAULT 'pending'
    CHECK (sync_status IN ('pending','synced','conflict','error','detached')),
  atlas_section_marker text NOT NULL DEFAULT 'Atlas',
  atlas_revision integer NOT NULL DEFAULT 1 CHECK (atlas_revision > 0),
  trello_revision text,
  last_synced_at timestamptz,
  last_error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  UNIQUE (user_id, task_id),
  UNIQUE (user_id, trello_card_id),
  FOREIGN KEY (task_id, user_id) REFERENCES canonical_tasks(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (trello_card_id, user_id) REFERENCES trello_cards(id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS task_trello_links_sync_idx ON task_trello_links (user_id, sync_status, updated_at);
CREATE TRIGGER task_trello_links_set_updated_at BEFORE UPDATE ON task_trello_links
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS commitments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id uuid,
  person_node_id uuid,
  direction text NOT NULL CHECK (direction IN ('owed_by_me','owed_to_me')),
  title text NOT NULL,
  details text NOT NULL DEFAULT '',
  counterpart_name text,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','waiting','fulfilled','cancelled')),
  due_at timestamptz,
  next_follow_up_at timestamptz,
  source_fingerprint text,
  confidence numeric(4,3) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  fulfilled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commitments_title_not_blank CHECK (btrim(title) <> ''),
  UNIQUE (id, user_id),
  FOREIGN KEY (task_id, user_id) REFERENCES canonical_tasks(id, user_id) ON DELETE SET NULL (task_id),
  FOREIGN KEY (person_node_id, user_id) REFERENCES brain_nodes(id, user_id) ON DELETE SET NULL (person_node_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS commitments_fingerprint_uidx
  ON commitments (user_id, source_fingerprint) WHERE source_fingerprint IS NOT NULL;
CREATE INDEX IF NOT EXISTS commitments_follow_up_idx
  ON commitments (user_id, status, next_follow_up_at NULLS LAST, due_at NULLS LAST);
CREATE TRIGGER commitments_set_updated_at BEFORE UPDATE ON commitments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id uuid,
  commitment_id uuid,
  kind text NOT NULL DEFAULT 'custom'
    CHECK (kind IN ('custom','task_due','urgent_24h','due_2h','follow_up','briefing')),
  schedule_type text NOT NULL DEFAULT 'absolute'
    CHECK (schedule_type IN ('absolute','relative','recurring','due','follow_up')),
  title text NOT NULL,
  message text NOT NULL DEFAULT '',
  scheduled_for timestamptz,
  recurrence jsonb,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','sent','acknowledged','snoozed','cancelled','ignored','missed')),
  priority smallint NOT NULL DEFAULT 5 CHECK (priority BETWEEN 0 AND 9),
  respect_quiet_hours boolean NOT NULL DEFAULT true,
  last_sent_at timestamptz,
  acknowledged_at timestamptz,
  cancelled_at timestamptz,
  dedupe_key text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reminders_title_not_blank CHECK (btrim(title) <> ''),
  CONSTRAINT reminders_schedule_present CHECK (scheduled_for IS NOT NULL OR recurrence IS NOT NULL),
  UNIQUE (id, user_id),
  FOREIGN KEY (task_id, user_id) REFERENCES canonical_tasks(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (commitment_id, user_id) REFERENCES commitments(id, user_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS reminders_dedupe_uidx
  ON reminders (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS reminders_delivery_idx
  ON reminders (user_id, status, scheduled_for) WHERE status IN ('scheduled','snoozed');
CREATE TRIGGER reminders_set_updated_at BEFORE UPDATE ON reminders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DO $$ BEGIN
  ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_id_user_unique
    UNIQUE (id, user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS reminder_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reminder_id uuid NOT NULL,
  scheduled_at timestamptz NOT NULL,
  deliver_after timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sending','sent','acknowledged','snoozed','cancelled','missed','failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  locked_by text,
  locked_at timestamptz,
  sent_at timestamptz,
  acknowledged_at timestamptz,
  notification_outbox_id bigint,
  last_error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  UNIQUE (user_id, reminder_id, scheduled_at),
  FOREIGN KEY (reminder_id, user_id) REFERENCES reminders(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (notification_outbox_id, user_id)
    REFERENCES notification_outbox(id, user_id) ON DELETE SET NULL (notification_outbox_id)
);
CREATE INDEX IF NOT EXISTS reminder_occurrences_due_idx
  ON reminder_occurrences (status, deliver_after) WHERE status IN ('pending','failed','snoozed');
CREATE TRIGGER reminder_occurrences_set_updated_at BEFORE UPDATE ON reminder_occurrences
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS assistant_learnings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  supersedes_learning_id uuid,
  scope_type text NOT NULL DEFAULT 'global'
    CHECK (scope_type IN ('global','conversation','person','project')),
  scope_id text,
  learning_key text NOT NULL,
  statement text NOT NULL,
  source_type text NOT NULL DEFAULT 'inferred' CHECK (source_type IN ('explicit','inferred')),
  state text NOT NULL DEFAULT 'suggested'
    CHECK (state IN ('suggested','active','paused','rejected','obsolete','forgotten','superseded')),
  confidence numeric(4,3) NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
  evidence_count integer NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
  distinct_evidence_days integer NOT NULL DEFAULT 0 CHECK (distinct_evidence_days >= 0),
  requires_confirmation boolean NOT NULL DEFAULT true,
  first_evidence_at timestamptz,
  last_evidence_at timestamptz,
  activated_at timestamptz,
  review_after timestamptz,
  expires_at timestamptz,
  last_used_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assistant_learnings_statement_not_blank CHECK (btrim(statement) <> ''),
  CONSTRAINT assistant_learnings_scope_id CHECK (scope_type='global' OR scope_id IS NOT NULL),
  UNIQUE (id, user_id),
  UNIQUE NULLS NOT DISTINCT (user_id, scope_type, scope_id, learning_key, version),
  FOREIGN KEY (supersedes_learning_id, user_id)
    REFERENCES assistant_learnings(id, user_id) ON DELETE SET NULL (supersedes_learning_id)
);
CREATE INDEX IF NOT EXISTS assistant_learnings_active_idx
  ON assistant_learnings (user_id, state, scope_type, last_used_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS assistant_learnings_review_idx
  ON assistant_learnings (state, review_after) WHERE state='active';
CREATE TRIGGER assistant_learnings_set_updated_at BEFORE UPDATE ON assistant_learnings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS assistant_learning_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  learning_id uuid NOT NULL,
  evidence_type text NOT NULL,
  source_id text,
  excerpt text NOT NULL DEFAULT '',
  signal text NOT NULL DEFAULT 'supports' CHECK (signal IN ('supports','contradicts','confirms','rejects')),
  weight numeric(4,3) NOT NULL DEFAULT 1 CHECK (weight BETWEEN 0 AND 1),
  observed_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  UNIQUE NULLS NOT DISTINCT (user_id, learning_id, evidence_type, source_id),
  FOREIGN KEY (learning_id, user_id) REFERENCES assistant_learnings(id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS assistant_learning_evidence_idx
  ON assistant_learning_evidence (user_id, learning_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS assistant_action_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  learning_id uuid,
  task_id uuid,
  action_type text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('accepted','edited','completed','snoozed','rejected','undone','failed')),
  score numeric(5,4) CHECK (score IS NULL OR score BETWEEN -1 AND 1),
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  FOREIGN KEY (learning_id, user_id) REFERENCES assistant_learnings(id, user_id) ON DELETE SET NULL (learning_id),
  FOREIGN KEY (task_id, user_id) REFERENCES canonical_tasks(id, user_id) ON DELETE SET NULL (task_id)
);
CREATE INDEX IF NOT EXISTS assistant_action_outcomes_learning_idx
  ON assistant_action_outcomes (user_id, learning_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS brain_node_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  node_id uuid NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('brain_node','whatsapp_message','trello_card','task','commitment','url','manual')),
  source_id text,
  source_url text,
  title text,
  excerpt text NOT NULL DEFAULT '',
  captured_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  UNIQUE (user_id, node_id, source_kind, source_id),
  FOREIGN KEY (node_id, user_id) REFERENCES brain_nodes(id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS brain_node_sources_node_idx
  ON brain_node_sources (user_id, node_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS action_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id uuid,
  chat_message_id uuid,
  proposal_type text NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','confirmed','edited','cancelled','executing','completed','failed')),
  risk text NOT NULL DEFAULT 'low' CHECK (risk IN ('low','medium','high','destructive')),
  reversible boolean NOT NULL DEFAULT true,
  requires_confirmation boolean NOT NULL DEFAULT true,
  proposed_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  edited_payload jsonb,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  idempotency_key text,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  executed_at timestamptz,
  error_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  UNIQUE (user_id, idempotency_key),
  FOREIGN KEY (thread_id, user_id) REFERENCES brain_chat_threads(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (chat_message_id, user_id) REFERENCES brain_chat_messages(id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS action_proposals_pending_idx
  ON action_proposals (user_id, status, created_at DESC);
CREATE TRIGGER action_proposals_set_updated_at BEFORE UPDATE ON action_proposals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Backfill não destrutivo dos perfis e tarefas já representadas no cérebro.
UPDATE users SET preferred_name = display_name
WHERE btrim(display_name) <> '' AND preferred_name IS DISTINCT FROM display_name;

INSERT INTO canonical_tasks (
  user_id, brain_node_id, title, description, status, priority,
  source_fingerprint, confidence, metadata, created_at, updated_at
)
SELECT
  n.user_id, n.id, n.title, COALESCE(NULLIF(n.manual_content,''), n.generated_content),
  CASE n.status
    WHEN 'done' THEN 'done' WHEN 'archived' THEN 'cancelled'
    WHEN 'inbox' THEN 'inbox' ELSE 'open' END,
  CASE WHEN n.metadata->>'priority' IN ('low','medium','high','urgent')
    THEN n.metadata->>'priority' ELSE 'medium' END,
  'legacy-brain:' || n.id::text, NULL, jsonb_build_object('backfilledFrom','brain_nodes'),
  n.created_at, n.updated_at
FROM brain_nodes n
WHERE n.type='task'
ON CONFLICT (user_id, brain_node_id) WHERE brain_node_id IS NOT NULL DO NOTHING;

INSERT INTO task_trello_links (user_id, task_id, trello_card_id, sync_status, last_synced_at, metadata)
SELECT m.user_id, t.id, m.trello_card_id, 'synced', c.synced_at,
       jsonb_build_object('backfilledFrom','trello_card_node_map')
FROM trello_card_node_map m
JOIN canonical_tasks t ON t.user_id=m.user_id AND t.brain_node_id=m.brain_node_id
JOIN trello_cards c ON c.user_id=m.user_id AND c.id=m.trello_card_id
ON CONFLICT DO NOTHING;
