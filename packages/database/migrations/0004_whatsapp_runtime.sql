-- Credenciais multiusuário do Baileys e catálogo usado pelo onboarding.
-- Os registros pertencem ao mesmo PostgreSQL persistente da aplicação.

CREATE TABLE IF NOT EXISTS whatsapp_auth_records (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category text NOT NULL,
  record_key text NOT NULL,
  record_value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category, record_key)
);

CREATE TABLE IF NOT EXISTS whatsapp_conversation_catalog (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  whatsapp_connection_id uuid NOT NULL,
  jid text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  is_group boolean NOT NULL DEFAULT false,
  conversation_timestamp timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (user_id, whatsapp_connection_id, jid),
  FOREIGN KEY (whatsapp_connection_id, user_id)
    REFERENCES whatsapp_connections(id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS whatsapp_conversation_catalog_user_idx
  ON whatsapp_conversation_catalog (user_id, conversation_timestamp DESC NULLS LAST);
