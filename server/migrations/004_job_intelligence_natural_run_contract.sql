\set ON_ERROR_STOP on

DO $$
BEGIN
  IF current_database() <> 'processintelligence_db' THEN RAISE EXCEPTION 'Job Intelligence derived schema may only be changed in processintelligence_db'; END IF;
  IF to_regclass('public.job_intelligence_runs') IS NULL THEN RAISE EXCEPTION 'Job Intelligence minimal derived schema must be installed first'; END IF;
END $$;

ALTER TABLE public.job_intelligence_runs
  ADD COLUMN transition_previous_order text,
  ADD COLUMN transition_previous_recipe text,
  ADD COLUMN transition_previous_customer text,
  ADD COLUMN transition_previous_material text,
  ADD CONSTRAINT job_intelligence_speed_variability_derived CHECK (
    (speed_median IS NULL AND speed_variability IS NULL)
    OR
    (speed_median IS NOT NULL AND speed_variability IS NOT DISTINCT FROM speed_p75 - speed_p25)
  ) NOT VALID;

-- Existing v3 rows retain their original compact representation. The v4
-- algorithm writes the two previous-identity concepts independently. A future
-- audited reconciliation may remove superseded v3 rows only after v4 parity.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.job_intelligence_runs TO processintelligence_app;
