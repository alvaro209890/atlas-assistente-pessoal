-- Keep exactly one non-logged-out WhatsApp connection per user.
WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY user_id ORDER BY (status='connected') DESC,updated_at DESC,id) AS position
  FROM whatsapp_connections
  WHERE status<>'logged_out'
)
UPDATE whatsapp_connections w
SET status='logged_out',pairing_qr=NULL,pairing_expires_at=NULL,
    last_error='Conexão antiga desativada pela migração Atlas de conta única'
FROM ranked r
WHERE w.id=r.id AND r.position>1;

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_connections_one_active_per_user_idx
  ON whatsapp_connections (user_id)
  WHERE status<>'logged_out';
