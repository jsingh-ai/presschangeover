\set ON_ERROR_STOP on
\pset pager off

-- Usage after radius-readonly-discovery.sql has verified the identifiers:
-- psql -X -d press_radius_db \
--   -v radius_schema=VERIFIED_SCHEMA \
--   -v radius_table=machine_status_history \
--   -f create-processintelligence-readonly.sql
--
-- The password is requested silently by psql and is never stored in this file.

\if :{?radius_schema}
\else
  \echo radius_schema must be supplied from verified live discovery.
  \quit 3
\endif

\if :{?radius_table}
\else
  \echo radius_table must be supplied from verified live discovery.
  \quit 3
\endif

SELECT current_database() = 'press_radius_db' AS correct_database
\gset
\if :correct_database
\else
  \echo Refusing role creation outside press_radius_db.
  \quit 3
\endif

SELECT to_regclass(format('%I.%I', :'radius_schema', :'radius_table')) IS NOT NULL
  AS verified_table_exists
\gset
\if :verified_table_exists
\else
  \echo The verified Radius table does not exist; role creation stopped.
  \quit 3
\endif

SELECT EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles
  WHERE rolname = 'processintelligence_readonly'
) AS role_already_exists
\gset
\if :role_already_exists
  \echo Role processintelligence_readonly already exists; refusing to overwrite it.
  \quit 4
\endif

\prompt -s 'New processintelligence_readonly password: ' role_password

CREATE ROLE processintelligence_readonly
  LOGIN
  NOINHERIT
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION
  NOBYPASSRLS
  CONNECTION LIMIT 5
  PASSWORD :'role_password';

ALTER ROLE processintelligence_readonly
  SET default_transaction_read_only = on;
ALTER ROLE processintelligence_readonly IN DATABASE press_radius_db
  SET statement_timeout = '5s';
ALTER ROLE processintelligence_readonly IN DATABASE press_radius_db
  SET lock_timeout = '2s';

GRANT CONNECT ON DATABASE press_radius_db
  TO processintelligence_readonly;
GRANT USAGE ON SCHEMA :"radius_schema"
  TO processintelligence_readonly;
GRANT SELECT ON TABLE :"radius_schema".:"radius_table"
  TO processintelligence_readonly;

-- Verification must show SELECT=true and every writer/elevated/create flag=false.
SELECT
  has_database_privilege(
    'processintelligence_readonly',
    'press_radius_db',
    'CONNECT'
  ) AS can_connect,
  has_schema_privilege(
    'processintelligence_readonly',
    :'radius_schema',
    'USAGE'
  ) AS can_use_schema,
  has_table_privilege(
    'processintelligence_readonly',
    format('%I.%I', :'radius_schema', :'radius_table'),
    'SELECT'
  ) AS can_select,
  has_table_privilege(
    'processintelligence_readonly',
    format('%I.%I', :'radius_schema', :'radius_table'),
    'INSERT'
  ) OR has_table_privilege(
    'processintelligence_readonly',
    format('%I.%I', :'radius_schema', :'radius_table'),
    'UPDATE'
  ) OR has_table_privilege(
    'processintelligence_readonly',
    format('%I.%I', :'radius_schema', :'radius_table'),
    'DELETE'
  ) OR has_table_privilege(
    'processintelligence_readonly',
    format('%I.%I', :'radius_schema', :'radius_table'),
    'TRUNCATE'
  ) AS has_any_table_write;

SELECT
  role.rolsuper,
  role.rolcreatedb,
  role.rolcreaterole,
  role.rolinherit,
  role.rolreplication,
  role.rolbypassrls,
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.member = role.oid
  ) AS has_role_membership,
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace AS namespace
    WHERE namespace.nspname NOT LIKE 'pg_temp_%'
      AND has_schema_privilege(
        'processintelligence_readonly',
        namespace.oid,
        'CREATE'
      )
  ) AS can_create_in_any_persistent_schema
FROM pg_catalog.pg_roles AS role
WHERE role.rolname = 'processintelligence_readonly';

-- PostgreSQL grants CONNECT to PUBLIC by default. Audit effective access to every
-- database. Do not revoke PUBLIC globally without a separate impact review.
SELECT
  database.datname,
  has_database_privilege(
    'processintelligence_readonly',
    database.oid,
    'CONNECT'
  ) AS effective_connect
FROM pg_catalog.pg_database AS database
WHERE database.datallowconn
ORDER BY database.datname;
