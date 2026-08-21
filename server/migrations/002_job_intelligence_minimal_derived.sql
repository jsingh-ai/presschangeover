\set ON_ERROR_STOP on

DO $$
BEGIN
  IF current_database() <> 'processintelligence_db' THEN RAISE EXCEPTION 'Job Intelligence derived schema may only be installed in processintelligence_db'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'processintelligence_app') THEN RAISE EXCEPTION 'Required restricted role processintelligence_app does not exist'; END IF;
END $$;

CREATE TABLE public.job_intelligence_runs (
  algorithm_version text NOT NULL,
  run_id text NOT NULL,
  press_key text NOT NULL,
  previous_run_id text,
  run_start_utc timestamptz NOT NULL,
  run_end_utc timestamptz NOT NULL,
  duration_seconds double precision NOT NULL CHECK (duration_seconds >= 0),
  order_value text,
  recipe_value text,
  customer_value text,
  material_value text,
  previous_order text,
  previous_recipe text,
  previous_customer text,
  previous_material text,
  identity_first_seen_at timestamptz,
  identity_last_change_at timestamptz,
  identity_settled_at timestamptz,
  identity_uncertainty_seconds double precision CHECK (identity_uncertainty_seconds IS NULL OR identity_uncertainty_seconds >= 0),
  settle_state text NOT NULL CHECK (settle_state IN ('confirmed','pending_range_end','range_start','after_data_gap')),
  inferred_boundary boolean NOT NULL,
  identity_availability jsonb NOT NULL DEFAULT '{}'::jsonb,
  identity_confidence text NOT NULL CHECK (identity_confidence IN ('high','moderate','limited')),
  coverage_percent double precision NOT NULL CHECK (coverage_percent BETWEEN 0 AND 100),
  source_gap boolean NOT NULL,
  good_seconds double precision NOT NULL CHECK (good_seconds >= 0),
  make_ready_seconds double precision NOT NULL CHECK (make_ready_seconds >= 0),
  bad_seconds double precision NOT NULL CHECK (bad_seconds >= 0),
  other_radius_seconds double precision NOT NULL CHECK (other_radius_seconds >= 0),
  unavailable_seconds double precision NOT NULL CHECK (unavailable_seconds >= 0),
  production_state_efficiency double precision,
  stable_production_at timestamptz,
  transition_seconds double precision,
  transition_make_ready_seconds double precision,
  transition_bad_seconds double precision,
  transition_valid boolean NOT NULL,
  running_good_seconds double precision NOT NULL CHECK (running_good_seconds >= 0),
  running_bad_seconds double precision NOT NULL CHECK (running_bad_seconds >= 0),
  interruption_count integer NOT NULL CHECK (interruption_count >= 0),
  interruptions_per_hour double precision,
  restart_count integer NOT NULL CHECK (restart_count >= 0),
  median_good_episode_seconds double precision,
  speed_source_unit text,
  speed_unit_status text,
  speed_sample_count integer NOT NULL CHECK (speed_sample_count >= 0),
  speed_median double precision,
  speed_time_weighted_mean double precision,
  speed_p25 double precision,
  speed_p75 double precision,
  speed_p90 double precision,
  speed_variability double precision,
  deck_evidence_available boolean NOT NULL,
  active_decks smallint[] NOT NULL DEFAULT '{}',
  reused_decks smallint[] NOT NULL DEFAULT '{}',
  added_decks smallint[] NOT NULL DEFAULT '{}',
  removed_decks smallint[] NOT NULL DEFAULT '{}',
  changed_deck_count smallint NOT NULL CHECK (changed_deck_count >= 0),
  is_closed boolean NOT NULL,
  source_from_utc timestamptz NOT NULL,
  source_to_utc timestamptz NOT NULL,
  calculated_at_utc timestamptz NOT NULL,
  source_fingerprint char(64) NOT NULL,
  PRIMARY KEY (algorithm_version, run_id),
  CHECK (run_end_utc >= run_start_utc)
);

CREATE INDEX job_intelligence_runs_time_idx ON public.job_intelligence_runs (algorithm_version, run_start_utc);
CREATE INDEX job_intelligence_runs_press_time_idx ON public.job_intelligence_runs (algorithm_version, press_key, run_start_utc);
CREATE INDEX job_intelligence_runs_recipe_time_idx ON public.job_intelligence_runs (algorithm_version, recipe_value, run_start_utc);
CREATE INDEX job_intelligence_runs_order_time_idx ON public.job_intelligence_runs (algorithm_version, order_value, run_start_utc);
CREATE INDEX job_intelligence_runs_customer_time_idx ON public.job_intelligence_runs (algorithm_version, customer_value, run_start_utc);
CREATE INDEX job_intelligence_runs_material_time_idx ON public.job_intelligence_runs (algorithm_version, material_value, run_start_utc);

CREATE TABLE public.job_intelligence_run_losses (
  algorithm_version text NOT NULL,
  run_id text NOT NULL,
  press_key text NOT NULL,
  event_type text NOT NULL,
  status_code text NOT NULL DEFAULT '',
  status_description text NOT NULL,
  loss_category text NOT NULL CHECK (loss_category IN ('make_ready','bad','other')),
  total_seconds double precision NOT NULL CHECK (total_seconds >= 0),
  occurrence_count integer NOT NULL CHECK (occurrence_count > 0),
  median_episode_seconds double precision NOT NULL CHECK (median_episode_seconds >= 0),
  PRIMARY KEY (algorithm_version, run_id, event_type, status_description, status_code),
  FOREIGN KEY (algorithm_version, run_id) REFERENCES public.job_intelligence_runs (algorithm_version, run_id) ON DELETE CASCADE
);

CREATE TABLE public.job_intelligence_materialization_state (
  algorithm_version text NOT NULL,
  press_key text NOT NULL,
  processed_through_utc timestamptz NOT NULL,
  source_coverage_start_utc timestamptz NOT NULL,
  source_coverage_end_utc timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('running','complete','failed')),
  updated_at_utc timestamptz NOT NULL,
  last_error_code text,
  PRIMARY KEY (algorithm_version, press_key)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.job_intelligence_runs, public.job_intelligence_run_losses, public.job_intelligence_materialization_state TO processintelligence_app;
