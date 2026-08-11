-- Target: processintelligence_db only. Run as a separately provisioned migration owner.
-- Never run this migration against press_radius_db or any telemetry database.
BEGIN;

DO $$
BEGIN
  IF current_database() <> 'processintelligence_db' THEN
    RAISE EXCEPTION 'Refusing classification migration outside processintelligence_db';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'processintelligence_app') THEN
    RAISE EXCEPTION 'Restricted runtime role processintelligence_app must be provisioned first';
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS process_intelligence;

CREATE TABLE IF NOT EXISTS process_intelligence.operational_groups (
  id text PRIMARY KEY,
  stable_key text NOT NULL UNIQUE,
  display_name text NOT NULL,
  description text NOT NULL,
  light_color text NOT NULL,
  dark_color text NOT NULL,
  icon_key text NOT NULL,
  sort_order integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS process_intelligence.process_families (
  id text PRIMARY KEY,
  stable_key text NOT NULL UNIQUE,
  display_name text NOT NULL,
  description text NOT NULL,
  sort_order integer NOT NULL
);

CREATE TABLE IF NOT EXISTS process_intelligence.radius_state_classifications (
  identity_key text PRIMARY KEY,
  event_type text NOT NULL,
  status_code text NULL,
  status_description text NOT NULL,
  operational_group_id text NOT NULL REFERENCES process_intelligence.operational_groups(id),
  process_family_id text NOT NULL REFERENCES process_intelligence.process_families(id),
  display_label text NULL,
  explanation text NOT NULL DEFAULT '',
  confidence text NOT NULL CHECK (confidence IN ('HIGH','MEDIUM','LOW')),
  needs_review boolean NOT NULL DEFAULT false,
  default_timeline_visibility boolean NOT NULL DEFAULT true,
  obsolete boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (identity_key)
);

CREATE TABLE IF NOT EXISTS process_intelligence.classification_versions (
  version integer PRIMARY KEY,
  published_at timestamptz NOT NULL,
  published_by text NOT NULL,
  change_count integer NOT NULL,
  snapshot jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS process_intelligence.classification_drafts (
  singleton_id boolean PRIMARY KEY DEFAULT true CHECK (singleton_id),
  base_version integer NOT NULL,
  revision integer NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by text NOT NULL,
  snapshot jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS process_intelligence.classification_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version integer NULL,
  action text NOT NULL,
  target text NOT NULL,
  summary text NOT NULL,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_radius_state_classifications_group ON process_intelligence.radius_state_classifications(operational_group_id);
CREATE INDEX IF NOT EXISTS idx_radius_state_classifications_review ON process_intelligence.radius_state_classifications(needs_review) WHERE needs_review;
CREATE INDEX IF NOT EXISTS idx_classification_audit_created ON process_intelligence.classification_audit(created_at DESC);

REVOKE ALL ON SCHEMA process_intelligence FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA process_intelligence FROM PUBLIC;
GRANT USAGE ON SCHEMA process_intelligence TO processintelligence_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA process_intelligence TO processintelligence_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA process_intelligence TO processintelligence_app;

COMMIT;
