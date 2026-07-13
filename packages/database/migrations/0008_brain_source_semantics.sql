ALTER TABLE brain_node_sources
  ADD COLUMN IF NOT EXISTS valid_from timestamptz,
  ADD COLUMN IF NOT EXISTS valid_until timestamptz,
  ADD COLUMN IF NOT EXISTS confidence numeric(4,3),
  ADD COLUMN IF NOT EXISTS importance smallint NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS supersedes_source_id uuid,
  ADD COLUMN IF NOT EXISTS contradicts_source_id uuid;

DO $$ BEGIN
  ALTER TABLE brain_node_sources ADD CONSTRAINT brain_node_sources_validity_check
    CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE brain_node_sources ADD CONSTRAINT brain_node_sources_confidence_check
    CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE brain_node_sources ADD CONSTRAINT brain_node_sources_importance_check
    CHECK (importance BETWEEN 0 AND 5);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE brain_node_sources ADD CONSTRAINT brain_node_sources_supersedes_fk
    FOREIGN KEY (supersedes_source_id,user_id) REFERENCES brain_node_sources(id,user_id)
    ON DELETE SET NULL (supersedes_source_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE brain_node_sources ADD CONSTRAINT brain_node_sources_contradicts_fk
    FOREIGN KEY (contradicts_source_id,user_id) REFERENCES brain_node_sources(id,user_id)
    ON DELETE SET NULL (contradicts_source_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS brain_node_sources_validity_idx
  ON brain_node_sources (user_id,valid_until,importance DESC);
