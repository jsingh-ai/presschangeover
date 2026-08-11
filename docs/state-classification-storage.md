# State Classification storage and security boundary

State Classification uses one application database, one runtime login, and one table:

- Database: `processintelligence_db`
- Runtime login: `processintelligence_app`
- Table: `public.classification_documents`

There are no application owner or migrator roles. A local PostgreSQL administrator creates the database and restricted login, then applies `server/migrations/001_radius_semantic_classification.sql`. The migration refuses to run unless the connected database is exactly `processintelligence_db` and the `processintelligence_app` role already exists. It does not create or alter roles.

The migration must be applied as one transaction with error-stop behavior:

```powershell
& 'C:\Program Files\PostgreSQL\17\bin\psql.exe' -X -h 127.0.0.1 -p 5432 -U postgres -d processintelligence_db -W -v ON_ERROR_STOP=1 -1 -f 'C:\ProcessIntelligence\server\migrations\001_radius_semantic_classification.sql'
```

The runtime login receives database connect, public-schema usage, table CRUD, and identity-sequence usage only. It does not receive database creation, role creation, schema creation, or table creation privileges. The migration revokes default public database, schema-creation, table, and sequence privileges within `processintelligence_db` before granting the runtime permissions.

## Document and version model

Each row represents one complete semantic configuration version. The JSONB `document` contains:

- all eight stable operational groups, including editable names, descriptions, colors, icons, and order;
- the process-family catalog;
- seeded or explicitly classified exact Radius identity mappings;
- mapping explanations, confidence, review flags, visibility, and obsolete-state metadata;
- draft change details used by the existing audit presentation.

The application does not copy the complete observed Radius catalog into PostgreSQL. It merges the published mappings with the live, read-only catalog when serving the workspace. An unseen exact identity is returned dynamically as `ADMIN_UNKNOWN`, low confidence, and Needs classification until an administrator explicitly maps and publishes it.

A draft uses the next unique version and is updated with a monotonically increasing `revision`. Update and publication statements include the expected revision, producing the existing HTTP 409 response for stale edits. A partial unique index permits at most one draft. Publishing atomically promotes that draft row to `published`; prior published rows are not modified by the repository. The current published configuration is the highest published version for the document type. Historical rows, `supersedes_id`, `changed_by`, timestamps, and the JSON change list provide version and audit history without auxiliary tables.

Discarding removes only the unpublished draft. The current and historical published rows remain unchanged. The application currently has no version-rollback endpoint; if rollback is added later, it should create and publish a new version copied from a historical document rather than mutating history.

## Runtime configuration

The application accepts exactly these five settings as an all-or-nothing group:

- `APP_DB_HOST`
- `APP_DB_PORT`
- `APP_DB_NAME`
- `APP_DB_USER`
- `APP_DB_PASSWORD`

`APP_DB_NAME` must be `processintelligence_db`, `APP_DB_USER` must be `processintelligence_app`, and the host must remain local to FORMPRODSVR02. The public schema is fixed by the application and has no environment setting. Production values belong only in the ignored external configuration file `C:\ProcessIntelligence\config\processintelligence.env`; never commit them.

When the five settings are absent, reviewed seed semantics remain available in memory for read-only presentation. Draft mutations remain disabled. When configured, startup expects the migration to exist and seeds the first published JSON document if the table has no published row; it never creates database objects at runtime.

Classification editing also remains denied unless a trusted authentication proxy is explicitly configured. Do not enable `PROCESS_INTELLIGENCE_TRUST_AUTH_PROXY` until IIS removes client-supplied identity headers, authenticates the request, and supplies the trusted identity. The normalized identity must also be listed in `PROCESS_INTELLIGENCE_CLASSIFICATION_ADMINS`.

## Backup and recovery

Back up `public.classification_documents` with the organization’s approved PostgreSQL backup process before a schema change or administrative recovery. Keep dumps outside the repository; database dumps and archives are ignored by Git. Restore only into `processintelligence_db` under administrator supervision. Prefer restoring a historical document as a new version instead of overwriting or deleting published rows.

## Source-system boundaries

`press_radius_db` remains accessible only through the dedicated SELECT-only Radius connection. Classification storage never targets it. Telemetry remains read-only behind TelemetryQueryApi, and ProcessIntelligence never connects directly to the telemetry historian. Exact Radius event type, status code, and description values remain unchanged in mappings and evidence.

Collector heartbeats determine availability independently of classification. Expected downtime is rendered as Data unavailable evidence, is excluded from operational classification and percentages, and does not turn into a Radius identity or database mapping.
