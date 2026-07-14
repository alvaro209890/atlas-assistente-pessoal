-- Alinha o esforço de raciocínio padrão do DeepSeek V4 Flash para "medium".
-- O valor efetivo enviado à API já é fixado no código; estas colunas são de
-- auditoria/metadados e passam a registrar "medium" em novos registros.
ALTER TABLE user_settings ALTER COLUMN reasoning_effort SET DEFAULT 'medium';
ALTER TABLE ai_runs ALTER COLUMN reasoning_effort SET DEFAULT 'medium';

-- Normaliza registros existentes de configuração de usuário.
UPDATE user_settings SET reasoning_effort = 'medium' WHERE reasoning_effort = 'high';
