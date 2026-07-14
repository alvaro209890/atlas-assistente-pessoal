-- Catálogo de nomes do WhatsApp e organização privada das conversas monitoradas.

CREATE TABLE IF NOT EXISTS whatsapp_contact_catalog (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  whatsapp_connection_id uuid NOT NULL,
  jid text NOT NULL,
  display_name text NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, whatsapp_connection_id, jid),
  FOREIGN KEY (whatsapp_connection_id, user_id)
    REFERENCES whatsapp_connections(id, user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS conversation_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  color text NOT NULL DEFAULT '#7c5cff',
  is_system boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  CONSTRAINT conversation_groups_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT conversation_groups_color_hex CHECK (color ~ '^#[0-9A-Fa-f]{6}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS conversation_groups_user_name_uidx
  ON conversation_groups (user_id, lower(btrim(name)));
CREATE INDEX IF NOT EXISTS conversation_groups_user_order_idx
  ON conversation_groups (user_id, sort_order, name);
CREATE TRIGGER conversation_groups_set_updated_at BEFORE UPDATE ON conversation_groups
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION create_default_conversation_groups(target_user_id uuid)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO conversation_groups (user_id, name, description, color, is_system, sort_order)
  VALUES
    (target_user_id, 'Trabalho', 'Clientes, colegas, fornecedores e assuntos profissionais.', '#7C5CFF', true, 10),
    (target_user_id, 'Estudos', 'Cursos, escola, faculdade, pesquisas e aprendizado.', '#3B82F6', true, 20),
    (target_user_id, 'Relacionamentos', 'Relacionamento afetivo e vida a dois.', '#EC4899', true, 30),
    (target_user_id, 'Família', 'Familiares e assuntos da família.', '#F59E0B', true, 40),
    (target_user_id, 'Amigos', 'Amizades e vida social.', '#10B981', true, 50),
    (target_user_id, 'Saúde', 'Profissionais, tratamentos e cuidados de saúde.', '#EF4444', true, 60),
    (target_user_id, 'Finanças', 'Bancos, contabilidade, cobranças e organização financeira.', '#14B8A6', true, 70),
    (target_user_id, 'Outros', 'Conversas que ainda não se encaixam nos demais grupos.', '#64748B', true, 80)
  ON CONFLICT DO NOTHING;
$$;

SELECT create_default_conversation_groups(id) FROM users;

CREATE OR REPLACE FUNCTION create_default_conversation_groups_for_new_user()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM create_default_conversation_groups(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_create_default_conversation_groups ON users;
CREATE TRIGGER users_create_default_conversation_groups
  AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION create_default_conversation_groups_for_new_user();

ALTER TABLE monitored_chats
  ADD COLUMN IF NOT EXISTS conversation_group_id uuid,
  ADD COLUMN IF NOT EXISTS group_assignment_source text,
  ADD COLUMN IF NOT EXISTS group_confidence numeric(5,4),
  ADD COLUMN IF NOT EXISTS group_reason text,
  ADD COLUMN IF NOT EXISTS group_last_classified_at timestamptz,
  ADD COLUMN IF NOT EXISTS classification_message_count integer NOT NULL DEFAULT 0;

ALTER TABLE monitored_chats
  ADD CONSTRAINT monitored_chats_conversation_group_tenant_safe
  FOREIGN KEY (conversation_group_id, user_id)
    REFERENCES conversation_groups(id, user_id) ON DELETE SET NULL (conversation_group_id),
  ADD CONSTRAINT monitored_chats_group_assignment_source_check
    CHECK (group_assignment_source IS NULL OR group_assignment_source IN ('manual', 'ai')),
  ADD CONSTRAINT monitored_chats_group_confidence_check
    CHECK (group_confidence IS NULL OR (group_confidence >= 0 AND group_confidence <= 1));

CREATE INDEX IF NOT EXISTS monitored_chats_group_idx
  ON monitored_chats (user_id, conversation_group_id, enabled);
