-- Separa o WhatsApp pessoal, usado apenas para leitura, do WhatsApp central
-- da plataforma, usado para conversar com os usuarios e enviar lembretes.

ALTER TABLE whatsapp_connections ADD COLUMN IF NOT EXISTS self_jid text;

UPDATE whatsapp_connections
SET self_jid = jid
WHERE self_jid IS NULL AND jid IS NOT NULL;

CREATE INDEX IF NOT EXISTS whatsapp_connections_self_jid_idx
  ON whatsapp_connections (self_jid)
  WHERE self_jid IS NOT NULL;

CREATE TABLE IF NOT EXISTS platform_whatsapp_connection (
  singleton_key text PRIMARY KEY DEFAULT 'mother'
    CHECK (singleton_key = 'mother'),
  display_name text NOT NULL DEFAULT 'WhatsApp mae do Atlas',
  status text NOT NULL DEFAULT 'disconnected'
    CHECK (status IN ('disconnected','pairing','connected','reconnecting','logged_out','error')),
  phone_number text,
  self_jid text,
  pairing_qr text,
  pairing_expires_at timestamptz,
  last_connected_at timestamptz,
  last_error text,
  welcome_message text NOT NULL DEFAULT
    'Oi, {nome}! Eu sou o Atlas. Seu WhatsApp foi conectado com sucesso. A partir de agora vou falar com voce por este numero para enviar lembretes, resumos e ajudar com sua rotina.',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO platform_whatsapp_connection (singleton_key)
VALUES ('mother')
ON CONFLICT (singleton_key) DO NOTHING;

CREATE TRIGGER platform_whatsapp_connection_set_updated_at
  BEFORE UPDATE ON platform_whatsapp_connection
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS platform_whatsapp_auth_records (
  singleton_key text NOT NULL DEFAULT 'mother'
    REFERENCES platform_whatsapp_connection(singleton_key) ON DELETE CASCADE,
  category text NOT NULL,
  record_key text NOT NULL,
  record_value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (singleton_key, category, record_key)
);

CREATE TABLE IF NOT EXISTS platform_whatsapp_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  external_message_id text NOT NULL UNIQUE,
  chat_jid text NOT NULL,
  sender_jid text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('inbound','outbound')),
  body text NOT NULL,
  sent_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS platform_whatsapp_messages_user_idx
  ON platform_whatsapp_messages (user_id, sent_at DESC);

-- The personal connection is no longer the sender. Existing rows may still keep
-- the reference for audit purposes, while new central deliveries leave it null.
