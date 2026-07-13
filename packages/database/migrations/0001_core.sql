CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  email_verified_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_not_blank CHECK (btrim(email) <> '')
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uidx ON users (lower(email));
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  user_agent text,
  ip_address inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_expires_idx ON sessions (user_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  timezone text NOT NULL DEFAULT 'America/Sao_Paulo',
  locale text NOT NULL DEFAULT 'pt-BR',
  ai_provider text NOT NULL DEFAULT 'deepseek',
  ai_model text NOT NULL DEFAULT 'deepseek-v4-flash',
  reasoning_effort text NOT NULL DEFAULT 'high' CHECK (reasoning_effort IN ('low', 'medium', 'high')),
  reminder_times jsonb NOT NULL DEFAULT '["08:00", "18:00"]'::jsonb,
  feature_flags jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER user_settings_set_updated_at BEFORE UPDATE ON user_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS brain_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL DEFAULT 'note',
  domain text NOT NULL DEFAULT 'general',
  title text NOT NULL,
  manual_content text NOT NULL DEFAULT '',
  generated_content text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  aliases text[] NOT NULL DEFAULT '{}',
  tags text[] NOT NULL DEFAULT '{}',
  source_type text,
  source_id text,
  source_url text,
  happened_at timestamptz,
  source_updated_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  search_vector tsvector,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brain_nodes_title_not_blank CHECK (btrim(title) <> ''),
  CONSTRAINT brain_nodes_type_not_blank CHECK (btrim(type) <> ''),
  CONSTRAINT brain_nodes_domain_not_blank CHECK (btrim(domain) <> ''),
  UNIQUE (id, user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS brain_nodes_source_uidx
  ON brain_nodes (user_id, source_type, source_id)
  WHERE source_type IS NOT NULL AND source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS brain_nodes_user_recent_idx ON brain_nodes (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS brain_nodes_user_type_idx ON brain_nodes (user_id, type, status);
CREATE INDEX IF NOT EXISTS brain_nodes_user_domain_idx ON brain_nodes (user_id, domain, updated_at DESC);
CREATE INDEX IF NOT EXISTS brain_nodes_search_gin_idx ON brain_nodes USING gin (search_vector);
CREATE INDEX IF NOT EXISTS brain_nodes_title_trgm_idx ON brain_nodes USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS brain_nodes_aliases_gin_idx ON brain_nodes USING gin (aliases);
CREATE INDEX IF NOT EXISTS brain_nodes_tags_gin_idx ON brain_nodes USING gin (tags);

CREATE OR REPLACE FUNCTION refresh_brain_node_search_vector()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_vector =
    setweight(to_tsvector('portuguese', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('portuguese', coalesce(array_to_string(NEW.aliases, ' '), '')), 'A') ||
    setweight(to_tsvector('portuguese', coalesce(array_to_string(NEW.tags, ' '), '')), 'B') ||
    setweight(to_tsvector('portuguese', coalesce(NEW.generated_content, '')), 'B') ||
    setweight(to_tsvector('portuguese', coalesce(NEW.manual_content, '')), 'C');
  RETURN NEW;
END;
$$;
CREATE TRIGGER brain_nodes_refresh_search BEFORE INSERT OR UPDATE OF title, aliases, tags, manual_content, generated_content
  ON brain_nodes FOR EACH ROW EXECUTE FUNCTION refresh_brain_node_search_vector();
CREATE TRIGGER brain_nodes_set_updated_at BEFORE UPDATE ON brain_nodes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS brain_node_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  node_id uuid NOT NULL,
  revision integer NOT NULL,
  title text NOT NULL,
  manual_content text NOT NULL,
  generated_content text NOT NULL,
  status text NOT NULL,
  aliases text[] NOT NULL,
  tags text[] NOT NULL,
  metadata jsonb NOT NULL,
  changed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (node_id, revision),
  FOREIGN KEY (node_id, user_id) REFERENCES brain_nodes(id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS brain_node_revisions_user_node_idx
  ON brain_node_revisions (user_id, node_id, revision DESC);

CREATE OR REPLACE FUNCTION capture_brain_node_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO brain_node_revisions (
    user_id, node_id, revision, title, manual_content, generated_content,
    status, aliases, tags, metadata, changed_by
  ) VALUES (
    OLD.user_id, OLD.id, OLD.version, OLD.title, OLD.manual_content,
    OLD.generated_content, OLD.status, OLD.aliases, OLD.tags, OLD.metadata,
    NULLIF(current_setting('app.actor_user_id', true), '')::uuid
  );
  NEW.version = OLD.version + 1;
  RETURN NEW;
END;
$$;
CREATE TRIGGER brain_nodes_capture_revision
  BEFORE UPDATE OF title, manual_content, generated_content, status, aliases, tags, metadata
  ON brain_nodes FOR EACH ROW
  WHEN (
    OLD.title IS DISTINCT FROM NEW.title OR
    OLD.manual_content IS DISTINCT FROM NEW.manual_content OR
    OLD.generated_content IS DISTINCT FROM NEW.generated_content OR
    OLD.status IS DISTINCT FROM NEW.status OR
    OLD.aliases IS DISTINCT FROM NEW.aliases OR
    OLD.tags IS DISTINCT FROM NEW.tags OR
    OLD.metadata IS DISTINCT FROM NEW.metadata
  )
  EXECUTE FUNCTION capture_brain_node_revision();

CREATE TABLE IF NOT EXISTS brain_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_node_id uuid NOT NULL,
  to_node_id uuid NOT NULL,
  relation_type text NOT NULL,
  weight real NOT NULL DEFAULT 1 CHECK (weight >= 0 AND weight <= 1),
  provenance text NOT NULL DEFAULT 'manual' CHECK (provenance IN ('manual', 'rule', 'ai', 'import')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brain_edges_not_self CHECK (from_node_id <> to_node_id),
  CONSTRAINT brain_edges_relation_not_blank CHECK (btrim(relation_type) <> ''),
  UNIQUE (user_id, from_node_id, to_node_id, relation_type),
  FOREIGN KEY (from_node_id, user_id) REFERENCES brain_nodes(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (to_node_id, user_id) REFERENCES brain_nodes(id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS brain_edges_from_idx ON brain_edges (user_id, from_node_id, relation_type);
CREATE INDEX IF NOT EXISTS brain_edges_to_idx ON brain_edges (user_id, to_node_id, relation_type);
CREATE TRIGGER brain_edges_set_updated_at BEFORE UPDATE ON brain_edges
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS brain_chat_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'Nova conversa',
  archived_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);
CREATE INDEX IF NOT EXISTS brain_chat_threads_user_idx ON brain_chat_threads (user_id, updated_at DESC);
CREATE TRIGGER brain_chat_threads_set_updated_at BEFORE UPDATE ON brain_chat_threads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS brain_chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content text NOT NULL,
  status text NOT NULL DEFAULT 'complete' CHECK (status IN ('pending', 'streaming', 'complete', 'error')),
  model text,
  citations jsonb NOT NULL DEFAULT '[]'::jsonb,
  token_usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  FOREIGN KEY (thread_id, user_id) REFERENCES brain_chat_threads(id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS brain_chat_messages_thread_idx ON brain_chat_messages (user_id, thread_id, created_at);

CREATE TABLE IF NOT EXISTS event_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic text NOT NULL DEFAULT 'app',
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_outbox_user_id_idx ON event_outbox (user_id, id DESC);
CREATE INDEX IF NOT EXISTS event_outbox_created_idx ON event_outbox (created_at);
