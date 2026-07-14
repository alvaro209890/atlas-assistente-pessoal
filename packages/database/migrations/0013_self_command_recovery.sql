-- Mantém comandos do chat próprio distinguíveis de texto livre que deve seguir
-- para a triagem de notas e observações.
ALTER TABLE whatsapp_messages
  DROP CONSTRAINT IF EXISTS whatsapp_messages_processing_status_check;

ALTER TABLE whatsapp_messages
  ADD CONSTRAINT whatsapp_messages_processing_status_check
  CHECK (processing_status IN (
    'pending', 'batched', 'processed', 'ignored', 'failed',
    'self_command_processing', 'self_command_failed'
  ));
