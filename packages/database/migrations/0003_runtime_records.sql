-- Durable records used by the ingestion, intelligence and delivery workers.
-- Every tenant-owned table carries user_id and composite foreign keys prevent
-- accidentally connecting records that belong to different users.

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  whatsapp_connection_id uuid NOT NULL,
  monitored_chat_id uuid,
  external_message_id text NOT NULL,
  chat_jid text NOT NULL,
  sender_jid text,
  recipient_jid text,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  from_me boolean NOT NULL DEFAULT false,
  message_type text NOT NULL DEFAULT 'text',
  body text NOT NULL DEFAULT '',
  quoted_external_message_id text,
  media_ref text,
  sent_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processing_status text NOT NULL DEFAULT 'pending'
    CHECK (processing_status IN ('pending', 'batched', 'processed', 'ignored', 'failed')),
  brain_node_id uuid,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  UNIQUE (user_id, whatsapp_connection_id, external_message_id),
  FOREIGN KEY (whatsapp_connection_id, user_id)
    REFERENCES whatsapp_connections(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (monitored_chat_id, user_id)
    REFERENCES monitored_chats(id, user_id) ON DELETE SET NULL (monitored_chat_id),
  FOREIGN KEY (brain_node_id, user_id)
    REFERENCES brain_nodes(id, user_id) ON DELETE SET NULL (brain_node_id)
);
CREATE INDEX IF NOT EXISTS whatsapp_messages_chat_time_idx
  ON whatsapp_messages (user_id, chat_jid, sent_at DESC);
CREATE INDEX IF NOT EXISTS whatsapp_messages_pending_idx
  ON whatsapp_messages (user_id, processing_status, received_at)
  WHERE processing_status IN ('pending', 'batched');
CREATE INDEX IF NOT EXISTS whatsapp_messages_external_idx
  ON whatsapp_messages (user_id, external_message_id);
CREATE TRIGGER whatsapp_messages_set_updated_at BEFORE UPDATE ON whatsapp_messages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS message_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  whatsapp_connection_id uuid NOT NULL,
  chat_jid text NOT NULL,
  batch_key text NOT NULL,
  status text NOT NULL DEFAULT 'collecting'
    CHECK (status IN ('collecting', 'ready', 'processing', 'completed', 'failed', 'cancelled')),
  window_started_at timestamptz NOT NULL,
  window_ends_at timestamptz NOT NULL,
  message_count integer NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  combined_text text NOT NULL DEFAULT '',
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  locked_by text,
  locked_at timestamptz,
  completed_at timestamptz,
  last_error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  UNIQUE (user_id, batch_key),
  FOREIGN KEY (whatsapp_connection_id, user_id)
    REFERENCES whatsapp_connections(id, user_id) ON DELETE CASCADE,
  CONSTRAINT message_batches_window_valid CHECK (window_ends_at >= window_started_at)
);
CREATE INDEX IF NOT EXISTS message_batches_ready_idx
  ON message_batches (status, window_ends_at)
  WHERE status IN ('collecting', 'ready', 'processing');
CREATE INDEX IF NOT EXISTS message_batches_user_chat_idx
  ON message_batches (user_id, chat_jid, window_started_at DESC);
CREATE TRIGGER message_batches_set_updated_at BEFORE UPDATE ON message_batches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS message_batch_items (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL,
  message_id uuid NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, message_id),
  UNIQUE (batch_id, position),
  FOREIGN KEY (batch_id, user_id)
    REFERENCES message_batches(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (message_id, user_id)
    REFERENCES whatsapp_messages(id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS message_batch_items_user_message_idx
  ON message_batch_items (user_id, message_id);

CREATE TABLE IF NOT EXISTS ai_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  provider text NOT NULL DEFAULT 'deepseek',
  model text NOT NULL DEFAULT 'deepseek-v4-flash',
  reasoning_effort text NOT NULL DEFAULT 'high'
    CHECK (reasoning_effort IN ('low', 'medium', 'high')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  prompt_version text,
  request_id text,
  idempotency_key text,
  thread_id uuid,
  chat_message_id uuid,
  brain_node_id uuid,
  message_batch_id uuid,
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  output jsonb NOT NULL DEFAULT '{}'::jsonb,
  prompt_tokens integer NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  completion_tokens integer NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
  reasoning_tokens integer NOT NULL DEFAULT 0 CHECK (reasoning_tokens >= 0),
  cached_tokens integer NOT NULL DEFAULT 0 CHECK (cached_tokens >= 0),
  cost_micros bigint NOT NULL DEFAULT 0 CHECK (cost_micros >= 0),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  error_code text,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  FOREIGN KEY (thread_id, user_id)
    REFERENCES brain_chat_threads(id, user_id) ON DELETE SET NULL (thread_id),
  FOREIGN KEY (chat_message_id, user_id)
    REFERENCES brain_chat_messages(id, user_id) ON DELETE SET NULL (chat_message_id),
  FOREIGN KEY (brain_node_id, user_id)
    REFERENCES brain_nodes(id, user_id) ON DELETE SET NULL (brain_node_id),
  FOREIGN KEY (message_batch_id, user_id)
    REFERENCES message_batches(id, user_id) ON DELETE SET NULL (message_batch_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_runs_idempotency_uidx
  ON ai_runs (user_id, purpose, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_runs_user_created_idx ON ai_runs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_runs_status_idx ON ai_runs (status, created_at)
  WHERE status IN ('queued', 'running');
CREATE TRIGGER ai_runs_set_updated_at BEFORE UPDATE ON ai_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS ai_usage_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ai_run_id uuid NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  purpose text NOT NULL,
  prompt_tokens integer NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  completion_tokens integer NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
  reasoning_tokens integer NOT NULL DEFAULT 0 CHECK (reasoning_tokens >= 0),
  cached_tokens integer NOT NULL DEFAULT 0 CHECK (cached_tokens >= 0),
  cost_micros bigint NOT NULL DEFAULT 0 CHECK (cost_micros >= 0),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (ai_run_id),
  FOREIGN KEY (ai_run_id, user_id) REFERENCES ai_runs(id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ai_usage_events_user_day_idx
  ON ai_usage_events (user_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  namespace text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text,
  status text NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'completed', 'failed')),
  response_status integer,
  response_body jsonb,
  resource_type text,
  resource_id text,
  locked_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  UNIQUE (user_id, namespace, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idempotency_keys_expiry_idx ON idempotency_keys (expires_at);
CREATE TRIGGER idempotency_keys_set_updated_at BEFORE UPDATE ON idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS job_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_type text NOT NULL,
  job_key text NOT NULL,
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'retrying', 'cancelled')),
  idempotency_key_id uuid,
  worker_id text,
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  output jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  error_message text,
  retry_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, job_type, job_key, attempt),
  FOREIGN KEY (idempotency_key_id, user_id)
    REFERENCES idempotency_keys(id, user_id) ON DELETE SET NULL (idempotency_key_id)
);
CREATE INDEX IF NOT EXISTS job_attempts_retry_idx ON job_attempts (status, retry_at)
  WHERE status IN ('queued', 'retrying');
CREATE INDEX IF NOT EXISTS job_attempts_user_job_idx
  ON job_attempts (user_id, job_type, job_key, attempt DESC);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel text NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp', 'web', 'email')),
  whatsapp_connection_id uuid,
  recipient_jid text,
  subject text,
  body text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
  priority smallint NOT NULL DEFAULT 5 CHECK (priority BETWEEN 0 AND 9),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  locked_at timestamptz,
  sent_at timestamptz,
  external_message_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (whatsapp_connection_id, user_id)
    REFERENCES whatsapp_connections(id, user_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS notification_outbox_dedupe_uidx
  ON notification_outbox (user_id, channel, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS notification_outbox_delivery_idx
  ON notification_outbox (status, priority, scheduled_at)
  WHERE status IN ('pending', 'sending', 'failed');
CREATE INDEX IF NOT EXISTS notification_outbox_user_idx
  ON notification_outbox (user_id, created_at DESC);
CREATE TRIGGER notification_outbox_set_updated_at BEFORE UPDATE ON notification_outbox
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS trello_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trello_connection_id uuid NOT NULL,
  trello_board_config_id uuid,
  trello_card_id text NOT NULL,
  board_id text NOT NULL,
  list_id text NOT NULL,
  list_name text NOT NULL DEFAULT '',
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  url text,
  due_at timestamptz,
  due_complete boolean NOT NULL DEFAULT false,
  closed boolean NOT NULL DEFAULT false,
  position double precision,
  labels jsonb NOT NULL DEFAULT '[]'::jsonb,
  members jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_activity_at timestamptz,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  UNIQUE (user_id, trello_connection_id, trello_card_id),
  FOREIGN KEY (trello_connection_id, user_id)
    REFERENCES trello_connections(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (trello_board_config_id, user_id)
    REFERENCES trello_board_configs(id, user_id) ON DELETE SET NULL (trello_board_config_id)
);
CREATE INDEX IF NOT EXISTS trello_cards_board_list_idx
  ON trello_cards (user_id, board_id, list_id, closed, position);
CREATE INDEX IF NOT EXISTS trello_cards_due_idx
  ON trello_cards (user_id, due_at) WHERE closed = false;
CREATE INDEX IF NOT EXISTS trello_cards_title_trgm_idx
  ON trello_cards USING gin (title gin_trgm_ops);
CREATE TRIGGER trello_cards_set_updated_at BEFORE UPDATE ON trello_cards
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS trello_card_node_map (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trello_card_id uuid NOT NULL,
  brain_node_id uuid NOT NULL,
  relation_type text NOT NULL DEFAULT 'represents',
  is_primary boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trello_card_id, brain_node_id, relation_type),
  FOREIGN KEY (trello_card_id, user_id)
    REFERENCES trello_cards(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (brain_node_id, user_id)
    REFERENCES brain_nodes(id, user_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS trello_card_node_map_primary_uidx
  ON trello_card_node_map (user_id, trello_card_id)
  WHERE is_primary;
CREATE INDEX IF NOT EXISTS trello_card_node_map_node_idx
  ON trello_card_node_map (user_id, brain_node_id);
CREATE TRIGGER trello_card_node_map_set_updated_at BEFORE UPDATE ON trello_card_node_map
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS trello_sync_cursors (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trello_connection_id uuid NOT NULL,
  board_id text NOT NULL,
  cursor text,
  last_synced_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, trello_connection_id, board_id),
  FOREIGN KEY (trello_connection_id, user_id)
    REFERENCES trello_connections(id, user_id) ON DELETE CASCADE
);
