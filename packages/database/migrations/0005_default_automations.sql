INSERT INTO automations (user_id, name, kind, schedule, config)
SELECT u.id, defaults.name, defaults.kind, defaults.schedule, defaults.config
FROM users u
CROSS JOIN (VALUES
  ('Briefings de prioridades'::text, 'pending_reminder'::text, '0 8,18 * * *'::text, '{"notifySelf":true}'::jsonb),
  ('Captura de conversas'::text, 'message_ingestion'::text, NULL::text, '{"quietWindowSeconds":10,"maxMessages":30}'::jsonb)
) AS defaults(name, kind, schedule, config)
WHERE NOT EXISTS (
  SELECT 1 FROM automations a WHERE a.user_id = u.id AND a.kind = defaults.kind
);
