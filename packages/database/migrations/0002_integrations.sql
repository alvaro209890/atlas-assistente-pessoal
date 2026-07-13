CREATE TABLE IF NOT EXISTS whatsapp_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name text NOT NULL DEFAULT 'WhatsApp principal',
  status text NOT NULL DEFAULT 'disconnected'
    CHECK (status IN ('disconnected', 'pairing', 'connected', 'reconnecting', 'logged_out', 'error')),
  phone_number text,
  jid text,
  session_ref text,
  pairing_qr text,
  pairing_expires_at timestamptz,
  last_connected_at timestamptz,
  last_error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);
CREATE INDEX IF NOT EXISTS whatsapp_connections_user_idx ON whatsapp_connections (user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_connections_user_jid_uidx
  ON whatsapp_connections (user_id, jid) WHERE jid IS NOT NULL;
CREATE TRIGGER whatsapp_connections_set_updated_at BEFORE UPDATE ON whatsapp_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS monitored_chats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  whatsapp_connection_id uuid NOT NULL,
  jid text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  is_group boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  UNIQUE (user_id, whatsapp_connection_id, jid),
  FOREIGN KEY (whatsapp_connection_id, user_id)
    REFERENCES whatsapp_connections(id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS monitored_chats_user_idx ON monitored_chats (user_id, enabled, display_name);
CREATE TRIGGER monitored_chats_set_updated_at BEFORE UPDATE ON monitored_chats
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS trello_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name text NOT NULL DEFAULT 'Trello',
  api_key text NOT NULL,
  access_token text NOT NULL,
  member_id text,
  member_name text,
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'revoked', 'error')),
  last_verified_at timestamptz,
  last_error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);
CREATE INDEX IF NOT EXISTS trello_connections_user_idx ON trello_connections (user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS trello_connections_user_member_uidx
  ON trello_connections (user_id, member_id) WHERE member_id IS NOT NULL;
CREATE TRIGGER trello_connections_set_updated_at BEFORE UPDATE ON trello_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS trello_board_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trello_connection_id uuid NOT NULL,
  board_id text NOT NULL,
  board_name text NOT NULL DEFAULT '',
  inbox_list_id text,
  in_progress_list_id text,
  paused_list_id text,
  done_list_id text,
  project_list_map jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  UNIQUE (user_id, trello_connection_id, board_id),
  FOREIGN KEY (trello_connection_id, user_id)
    REFERENCES trello_connections(id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS trello_board_configs_user_idx ON trello_board_configs (user_id, is_active, board_name);
CREATE TRIGGER trello_board_configs_set_updated_at BEFORE UPDATE ON trello_board_configs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS automations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  schedule text,
  timezone text NOT NULL DEFAULT 'America/Sao_Paulo',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_run_at timestamptz,
  last_run_status text,
  last_error text,
  next_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automations_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT automations_kind_not_blank CHECK (btrim(kind) <> '')
);
CREATE INDEX IF NOT EXISTS automations_user_idx ON automations (user_id, enabled, next_run_at);
CREATE TRIGGER automations_set_updated_at BEFORE UPDATE ON automations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  node_id uuid,
  thread_id uuid,
  message_id uuid,
  kind text NOT NULL DEFAULT 'general',
  rating smallint CHECK (rating BETWEEN 1 AND 5),
  comment text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (node_id, user_id) REFERENCES brain_nodes(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (thread_id, user_id) REFERENCES brain_chat_threads(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (message_id, user_id) REFERENCES brain_chat_messages(id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS feedback_user_idx ON feedback (user_id, created_at DESC);
