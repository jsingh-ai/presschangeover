-- Target: processintelligence_db only. Apply locally as a PostgreSQL administrator.
-- Run with psql -X -v ON_ERROR_STOP=1 -1 so the complete file is one transaction.

DO $$
BEGIN
  IF current_database() <> 'processintelligence_db' THEN
    RAISE EXCEPTION 'Refusing classification migration outside processintelligence_db';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'processintelligence_app') THEN
    RAISE EXCEPTION 'Restricted runtime role processintelligence_app must be provisioned first';
  END IF;
END $$;

REVOKE ALL ON DATABASE processintelligence_db FROM PUBLIC;
GRANT CONNECT ON DATABASE processintelligence_db TO processintelligence_app;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO processintelligence_app;

CREATE TABLE public.classification_documents (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_type text NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  revision integer NOT NULL CHECK (revision >= 1),
  status text NOT NULL CHECK (status IN ('draft', 'published')),
  document jsonb NOT NULL,
  changed_by text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz NULL,
  supersedes_id bigint NULL REFERENCES public.classification_documents(id),
  CONSTRAINT classification_documents_type_not_empty CHECK (btrim(document_type) <> ''),
  CONSTRAINT classification_documents_publish_state CHECK (
    (status = 'draft' AND published_at IS NULL)
    OR (status = 'published' AND published_at IS NOT NULL)
  ),
  CONSTRAINT classification_documents_version_unique UNIQUE (document_type, version)
);

CREATE UNIQUE INDEX classification_documents_one_draft
  ON public.classification_documents (document_type)
  WHERE status = 'draft';

-- The current published document is the highest published version for a type.
CREATE INDEX classification_documents_published_history
  ON public.classification_documents (document_type, version DESC)
  WHERE status = 'published';

REVOKE ALL ON TABLE public.classification_documents FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.classification_documents_id_seq FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.classification_documents TO processintelligence_app;
GRANT USAGE, SELECT ON SEQUENCE public.classification_documents_id_seq TO processintelligence_app;
