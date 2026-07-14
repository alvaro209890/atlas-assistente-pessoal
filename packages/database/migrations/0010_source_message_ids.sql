-- source_message_ids tracks WhatsApp message origin for canonical tasks
ALTER TABLE canonical_tasks
  ADD COLUMN IF NOT EXISTS source_message_ids text[] NOT NULL DEFAULT '{}';
