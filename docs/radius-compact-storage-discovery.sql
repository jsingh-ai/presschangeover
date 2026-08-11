SET default_transaction_read_only = on;
SET statement_timeout = '10s';
SET lock_timeout = '2s';

-- ProcessIntelligence read-only discovery for the verified Radius database.
-- Run only against press_radius_db. Payload and credential-bearing fields are
-- deliberately excluded from data samples.

select current_database() as database_name,
       current_user as login_name,
       current_setting('default_transaction_read_only') as default_read_only;

-- Exact compact-table columns.
select table_name, ordinal_position, column_name, data_type, udt_name,
       is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name in (
    'machine_status_current',
    'machine_status_events',
    'machine_status_poll_runs'
  )
order by table_name, ordinal_position;

-- Primary/unique/foreign-key constraints and their ordered columns.
select tc.table_name, tc.constraint_name, tc.constraint_type,
       kcu.ordinal_position, kcu.column_name,
       ccu.table_name as referenced_table,
       ccu.column_name as referenced_column
from information_schema.table_constraints tc
left join information_schema.key_column_usage kcu
  on kcu.constraint_schema = tc.constraint_schema
 and kcu.constraint_name = tc.constraint_name
left join information_schema.constraint_column_usage ccu
  on ccu.constraint_schema = tc.constraint_schema
 and ccu.constraint_name = tc.constraint_name
where tc.table_schema = 'public'
  and tc.table_name in (
    'machine_status_current',
    'machine_status_events',
    'machine_status_poll_runs'
  )
  and tc.constraint_type in ('PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY')
order by tc.table_name, tc.constraint_type, tc.constraint_name,
         kcu.ordinal_position;

-- Index definitions and predicates. pg_get_indexdef only describes catalog
-- metadata; it does not execute the returned definition.
select table_class.relname as table_name,
       index_class.relname as index_name,
       index_data.indisprimary as is_primary,
       index_data.indisunique as is_unique,
       pg_get_indexdef(index_data.indexrelid) as index_definition,
       pg_get_expr(index_data.indpred, index_data.indrelid) as predicate
from pg_catalog.pg_index index_data
join pg_catalog.pg_class table_class
  on table_class.oid = index_data.indrelid
join pg_catalog.pg_namespace table_namespace
  on table_namespace.oid = table_class.relnamespace
join pg_catalog.pg_class index_class
  on index_class.oid = index_data.indexrelid
where table_namespace.nspname = 'public'
  and table_class.relname in (
    'machine_status_current',
    'machine_status_events',
    'machine_status_poll_runs'
  )
order by table_class.relname, index_class.relname;

-- Planner estimates plus exact bounded counts for the compact tables.
select table_class.relname as table_name,
       greatest(table_class.reltuples, 0)::bigint as estimated_rows
from pg_catalog.pg_class table_class
join pg_catalog.pg_namespace table_namespace
  on table_namespace.oid = table_class.relnamespace
where table_namespace.nspname = 'public'
  and table_class.relname in (
    'machine_status_current',
    'machine_status_events',
    'machine_status_poll_runs'
  )
order by table_class.relname;

select
  (select count(*) from public.machine_status_current) as current_rows,
  (select count(*) from public.machine_status_events) as event_rows,
  (select count(*) from public.machine_status_poll_runs) as poll_run_rows;

-- Current state: safe fields only; raw_payload is intentionally omitted.
select machine_id, kco, plant_code, job_code, operation_code,
       event_type, status_code, status_description, event_start_time,
       event_seq_code, last_fetched_at, last_seen_at, is_present, updated_at
from public.machine_status_current
order by machine_id;

select count(*) as current_rows,
       count(distinct machine_id) as distinct_machines,
       min(last_fetched_at) as oldest_state_change_fetch,
       max(last_fetched_at) as newest_state_change_fetch,
       min(last_seen_at) as oldest_last_seen,
       max(last_seen_at) as newest_last_seen,
       count(*) filter (where is_present) as present_rows
from public.machine_status_current;

-- Compact event extent, open-event state, and representative samples.
select count(*) as event_rows,
       count(distinct machine_id) as distinct_machines,
       min(started_at) as first_started_at,
       max(started_at) as latest_started_at,
       max(last_observed_at) as latest_observed_at,
       count(*) filter (where ended_at is null) as open_events
from public.machine_status_events;

select id, machine_id, started_at, last_observed_at, ended_at,
       kco, plant_code, job_code, operation_code, event_type, status_code,
       status_description, event_start_time, event_seq_code, created_at
from public.machine_status_events
order by started_at, id
limit 30;

select id, machine_id, started_at, last_observed_at, ended_at,
       kco, plant_code, job_code, operation_code, event_type, status_code,
       status_description, event_start_time, event_seq_code, created_at
from public.machine_status_events
order by started_at desc, id desc
limit 30;

select id, machine_id, started_at, last_observed_at, ended_at,
       event_type, status_code, status_description, event_start_time,
       event_seq_code, created_at
from public.machine_status_events
where machine_id = '213'
order by started_at, id;

-- A nonzero count would show adjacent event rows whose full persisted state is
-- unchanged. event_start_time is included because source code treats it as
-- part of the state identity.
with ordered as (
  select event_data.*,
         lag(kco) over machine_order as previous_kco,
         lag(plant_code) over machine_order as previous_plant_code,
         lag(job_code) over machine_order as previous_job_code,
         lag(operation_code) over machine_order as previous_operation_code,
         lag(event_type) over machine_order as previous_event_type,
         lag(status_code) over machine_order as previous_status_code,
         lag(status_description) over machine_order as previous_status_description,
         lag(event_start_time) over machine_order as previous_event_start_time,
         lag(event_seq_code) over machine_order as previous_event_seq_code,
         row_number() over machine_order as machine_row_number
  from public.machine_status_events event_data
  window machine_order as (partition by machine_id order by started_at, id)
)
select count(*) as adjacent_unchanged_event_pairs
from ordered
where machine_row_number > 1
  and kco is not distinct from previous_kco
  and plant_code is not distinct from previous_plant_code
  and job_code is not distinct from previous_job_code
  and operation_code is not distinct from previous_operation_code
  and event_type is not distinct from previous_event_type
  and status_code is not distinct from previous_status_code
  and status_description is not distinct from previous_status_description
  and event_start_time is not distinct from previous_event_start_time
  and event_seq_code is not distinct from previous_event_seq_code;

-- Poll-run extent and recent collector evidence. Source JSON is omitted.
select count(*) as poll_run_rows,
       min(fetched_at) as first_poll_utc,
       max(fetched_at) as latest_poll_utc,
       min(machine_count) as minimum_machine_count,
       max(machine_count) as maximum_machine_count,
       count(*) filter (where machine_count < 12) as partial_poll_count,
       count(*) filter (where stale_machine_count > 0) as stale_poll_count
from public.machine_status_poll_runs;

select id, fetched_at, machine_count, changed_machine_count,
       stale_machine_count, created_at
from public.machine_status_poll_runs
order by fetched_at desc, id desc
limit 20;

-- Exact compact/legacy boundary globally.
select
  (select max(fetched_at) from public.machine_status_history) as legacy_last_utc,
  (select min(started_at) from public.machine_status_events) as events_first_utc,
  (select min(fetched_at) from public.machine_status_poll_runs) as poll_runs_first_utc,
  (select min(created_at) from public.machine_status_events) as events_first_created_utc,
  (select min(updated_at) from public.machine_status_current) as current_first_known_update_utc;

-- Boundary continuity by machine: final legacy observation and first compact
-- event. These rows establish whether the event is a seed or a later change.
with machines(machine_id) as (
  values ('203'), ('205'), ('206'), ('207'), ('208'), ('209'),
         ('210'), ('211'), ('212'), ('213'), ('214'), ('215')
)
select machines.machine_id,
       legacy.fetched_at as legacy_last_utc,
       legacy.event_type as legacy_event_type,
       legacy.status_code as legacy_status_code,
       legacy.status_description as legacy_status_description,
       legacy.event_start_time as legacy_event_start_time,
       compact.started_at as first_event_started_utc,
       compact.event_type as first_event_type,
       compact.status_code as first_event_status_code,
       compact.status_description as first_event_status_description,
       compact.event_start_time as first_event_event_start_time
from machines
left join lateral (
  select fetched_at, event_type, status_code, status_description,
         event_start_time
  from public.machine_status_history
  where machine_id = machines.machine_id
  order by fetched_at desc, id desc
  limit 1
) legacy on true
left join lateral (
  select started_at, event_type, status_code, status_description,
         event_start_time
  from public.machine_status_events
  where machine_id = machines.machine_id
  order by started_at, id
  limit 1
) compact on true
order by machines.machine_id;

-- Real August 10 collector incident, 17:00-17:20 America/Chicago (CDT).
select id, fetched_at,
       fetched_at at time zone 'America/Chicago' as fetched_at_plant,
       machine_count, changed_machine_count, stale_machine_count, created_at
from public.machine_status_poll_runs
where fetched_at >= timestamptz '2026-08-10 17:00:00-05'
  and fetched_at <= timestamptz '2026-08-10 17:20:00-05'
order by fetched_at, id;

with incident as (
  select fetched_at,
         lag(fetched_at) over (order by fetched_at, id) as previous_fetched_at,
         machine_count, changed_machine_count, stale_machine_count
  from public.machine_status_poll_runs
  where fetched_at >= timestamptz '2026-08-10 16:55:00-05'
    and fetched_at <= timestamptz '2026-08-10 17:25:00-05'
)
select previous_fetched_at, fetched_at,
       extract(epoch from fetched_at - previous_fetched_at) as gap_seconds,
       machine_count, changed_machine_count, stale_machine_count
from incident
where previous_fetched_at is not null
order by fetched_at;

-- Representative planner validation. EXPLAIN only; these statements do not
-- execute the underlying data scans.
explain (costs true, verbose false)
select id, machine_id, started_at, last_observed_at, ended_at,
       event_type, status_description
from public.machine_status_events
where machine_id = '213'
  and started_at < now()
  and coalesce(ended_at, now()) >= date_trunc('day', now())
order by started_at, id;

explain (costs true, verbose false)
select id, machine_id, started_at, last_observed_at, ended_at,
       event_type, status_description
from public.machine_status_events
where machine_id = '213'
  and started_at < now()
  and coalesce(ended_at, now()) >= now() - interval '24 hours'
order by started_at, id;

explain (costs true, verbose false)
select id, machine_id, started_at, last_observed_at, ended_at,
       event_type, status_description
from public.machine_status_events
where machine_id = '213'
  and started_at < now()
  and coalesce(ended_at, now()) >= now() - interval '7 days'
order by started_at, id;

explain (costs true, verbose false)
select id, machine_id, started_at, last_observed_at, ended_at,
       event_type, status_description
from public.machine_status_events
where machine_id = '213'
  and started_at < now() - interval '24 hours'
order by started_at desc, id desc
limit 1;

explain (costs true, verbose false)
select machine_id, event_type, status_description, last_fetched_at,
       last_seen_at, is_present
from public.machine_status_current
where machine_id = '213';

explain (costs true, verbose false)
select id, fetched_at, machine_count, changed_machine_count,
       stale_machine_count
from public.machine_status_poll_runs
order by fetched_at desc, id desc
limit 1;

explain (costs true, verbose false)
select id, fetched_at, machine_count, changed_machine_count,
       stale_machine_count
from public.machine_status_poll_runs
where fetched_at >= now() - interval '24 hours'
  and fetched_at <= now()
order by fetched_at, id;
