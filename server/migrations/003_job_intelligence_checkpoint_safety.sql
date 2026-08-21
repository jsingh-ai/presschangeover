\set ON_ERROR_STOP on

DO $$
BEGIN
  IF current_database() <> 'processintelligence_db' THEN RAISE EXCEPTION 'Job Intelligence checkpoint safety migration may only be installed in processintelligence_db'; END IF;
  IF to_regclass('public.job_intelligence_materialization_state') IS NULL THEN RAISE EXCEPTION 'Job Intelligence minimal derived schema must be installed first'; END IF;
END $$;

ALTER TABLE public.job_intelligence_materialization_state
  ADD COLUMN started_at_utc timestamptz,
  ADD COLUMN finished_at_utc timestamptz,
  ADD COLUMN last_success_at_utc timestamptz,
  ADD COLUMN lease_run_id text,
  ADD COLUMN lease_expires_at_utc timestamptz,
  ADD COLUMN last_error_message text,
  ADD CONSTRAINT job_intelligence_state_lease_id_length CHECK (lease_run_id IS NULL OR char_length(lease_run_id) <= 80),
  ADD CONSTRAINT job_intelligence_state_error_code_length CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 120),
  ADD CONSTRAINT job_intelligence_state_error_message_length CHECK (last_error_message IS NULL OR char_length(last_error_message) <= 500);

-- A legacy `running` row has no lease and is therefore deliberately treated as
-- stale by the updated materializer. Its processed-through value remains the
-- last fully committed safe boundary; this migration never advances it.
