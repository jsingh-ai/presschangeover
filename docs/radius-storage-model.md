# Radius production storage model

Verified read-only on FORMPRODSVR02 against `press_radius_db` on 2026-08-10. Evidence came from the production Radius persistence source and a live session with `default_transaction_read_only=on`, a 10-second statement timeout, and a 2-second lock timeout. No payload columns were sampled.

## Architecture and persistence behavior

Radius polls the upstream shop-floor API approximately every 60 seconds. A successful fetch is persisted in one PostgreSQL transaction:

1. Compare incoming machine state with `machine_status_current` and the open event.
2. Close the prior event and insert a new `machine_status_events` row only when any persisted state field changes, a machine returns after absence, or an open event is missing.
3. UPSERT `machine_status_current` only for changed/reappearing machines.
4. Mark machines omitted from a successful poll `is_present = false` and close their event.
5. Insert one `machine_status_poll_runs` heartbeat and commit.

Failed upstream fetches do not reach the persistence transaction, so no failed poll row is written. A missing sequence of poll runs is therefore the evidence for collector outage. Legacy `machine_status_history` and `machine_status_fetches` writes are deliberately absent from the current save path.

The state identity comparison includes `kco`, plant, job, operation, event type, status code, status description, upstream event start time, and event sequence code. Compact events can therefore split when job/operation metadata changes even if the operational event/status pair is unchanged; ProcessIntelligence merges adjacent segments with the same operational pair.

## `public.machine_status_current`

One latest state row per machine. Live count at discovery: 12 rows and 12 distinct machines; all were present.

| Column | Type | Null |
|---|---|---|
| `machine_id` | text | no |
| `kco` | integer | yes |
| `plant_code` | text | yes |
| `job_code` | text | yes |
| `operation_code` | text | yes |
| `event_type` | text | yes |
| `status_code` | text | yes |
| `status_description` | text | yes |
| `event_start_time` | timestamptz | yes |
| `event_seq_code` | text | yes |
| `last_fetched_at` | timestamptz | no |
| `updated_at` | timestamptz | no, default `now()` |
| `raw_payload` | jsonb | no |
| `last_seen_at` | timestamptz | yes |
| `is_present` | boolean | no, default true |

Primary key: `machine_status_current_pkey (machine_id)`.

Other index: `idx_machine_status_current_status_description (status_description)`.

There are no foreign keys. The primary-key lookup plan used a sequential scan because the live table has only 12 rows; this is an efficient planner choice at that size.

Timestamp semantics: `last_fetched_at`, `last_seen_at`, and `updated_at` advance only when the row is changed or reappears. They are state-change/UPSERT timestamps, not collector-heartbeat timestamps. A current row is live only when the latest poll run is fresh. `event_start_time` is upstream optional metadata and was null in sampled live rows.

## `public.machine_status_events`

Compact operational history with one row per full persisted state change. Live count at discovery: 128 rows across 12 machines, including 12 open rows. No adjacent pair had an identical full state.

| Column | Type | Null |
|---|---|---|
| `id` | bigint | no |
| `machine_id` | text | no |
| `started_at` | timestamptz | no |
| `last_observed_at` | timestamptz | no |
| `ended_at` | timestamptz | yes |
| `kco` | integer | yes |
| `plant_code` | text | yes |
| `job_code` | text | yes |
| `operation_code` | text | yes |
| `event_type` | text | yes |
| `status_code` | text | yes |
| `status_description` | text | yes |
| `event_start_time` | timestamptz | yes |
| `event_seq_code` | text | yes |
| `created_at` | timestamptz | no, default `now()` |

Primary key: `machine_status_events_pkey (id)`.

Indexes:

- `idx_machine_status_events_one_open_per_machine`, unique on `machine_id` where `ended_at is null`
- `idx_machine_status_events_machine_started (machine_id, started_at desc)`
- `idx_machine_status_events_started (started_at desc)`
- `idx_machine_status_events_status_started (status_code, started_at desc)`
- Expression index on normalized `status_code, started_at desc`

There are no foreign keys. `started_at` is the canonical ProcessIntelligence transition timestamp: the collector supplies its successful poll `fetchedAt` when it first observes the new state. `ended_at` is the next observed state/absence boundary. `last_observed_at` is advanced when an event closes, but an unchanged open event is not rewritten on heartbeat polls, so it must not determine freshness. `created_at` is database insertion time. `event_start_time` is upstream metadata, participates in state comparison, and was null in the sampled live data.

The first 12 event rows all have `started_at = 2026-08-10T14:29:00.415Z` and were inserted in the same transaction. They are compact-model seed snapshots, not proof that all 12 machines transitioned simultaneously.

## `public.machine_status_poll_runs`

One small row per successfully persisted collector cycle. Live count at discovery: 469. All observed rows had `machine_count = 12`; none had `stale_machine_count > 0`.

| Column | Type | Null |
|---|---|---|
| `id` | bigint | no |
| `fetched_at` | timestamptz | no |
| `machine_count` | integer | no, default 0 |
| `source` | jsonb | no |
| `changed_machine_count` | integer | no, default 0 |
| `stale_machine_count` | integer | no, default 0 |
| `created_at` | timestamptz | no, default `now()` |

Primary key: `machine_status_poll_runs_pkey (id)`.

Index: `idx_machine_status_poll_runs_fetched_at (fetched_at desc)`. There are no foreign keys.

`fetched_at` is the canonical `latestPollUtc`. `created_at` is commit-side insertion time. `changed_machine_count` is informational, not health: zero means a successful unchanged poll. `stale_machine_count` counts previously-present current rows omitted from that poll. The table has no status, error, started, completed, success-count, or failure-count columns. Failed upstream calls leave a gap rather than a failure row.

Feed classification:

- `OFFLINE`: no poll, or latest poll age is strictly greater than `RADIUS_STALE_SECONDS`.
- `DEGRADED`: latest poll is fresh but `machine_count < 12` or `stale_machine_count > 0`.
- `ONLINE`: latest poll is fresh, `machine_count >= 12`, and `stale_machine_count = 0`.

## Legacy history

`public.machine_status_history` is the preserved per-machine, per-poll snapshot store. Its verified schema remains the 14-column legacy schema (`id`, `fetched_at`, `machine_id`, state fields, `raw_payload`, `created_at`). It is no longer written by the current persistence path and must never determine current feed health.

### Historical record limitation

Before the compact-storage cutover, `machine_status_history` contains the actual repeated per-poll records written by the legacy collector. After the cutover, `machine_status_events` intentionally contains only meaningful state transitions. ProcessIntelligence carries each compact event state forward while successful `machine_status_poll_runs` prove collector availability; it does not manufacture minute-by-minute snapshots that never existed. User-facing history collapses unchanged legacy snapshots into operational transitions, and no synthetic history is written back to Radius.

Exact global and per-machine final legacy timestamp:

`2026-08-10T14:27:52.383Z` (`2026-08-10 09:27:52.383 America/Chicago`)

## Exact cutover and state continuity

| Evidence | UTC | Plant local |
|---|---|---|
| Last legacy snapshot | `2026-08-10T14:27:52.383Z` | 09:27:52.383 CDT |
| First compact event seed | `2026-08-10T14:29:00.415Z` | 09:29:00.415 CDT |
| First compact poll run | `2026-08-10T14:29:00.415Z` | 09:29:00.415 CDT |
| First compact event insertion | `2026-08-10T14:29:00.579420Z` | 09:29:00.579420 CDT |

The effective historical cutover is `2026-08-10T14:29:00.415Z`, because it is the first successful compact poll and the common start of the 12 seed events. The handoff gap is 68.032 seconds, below the 180-second stale threshold. ProcessIntelligence carries the final legacy state to the compact seed and does not insert OFFLINE at cutover.

For 11 machines, the final legacy and first compact event operational states match. Machine 205 changed from `B / Drum Clean` to `B / Substrate - Web Break`; its first-observed compact transition is timestamped at the cutover poll. No fake transition is inserted between the two evidence points.

## Machine mapping

Radius source formats a machine as `Press <last two digits of machine_id>`. Live current/event rows contain exactly these 12 IDs:

| Machine | Press |
|---:|---:|
| 203 | Press 3 |
| 205 | Press 5 |
| 206 | Press 6 |
| 207 | Press 7 |
| 208 | Press 8 |
| 209 | Press 9 |
| 210 | Press 10 |
| 211 | Press 11 |
| 212 | Press 12 |
| 213 | Press 13 |
| 214 | Press 14 |
| 215 | Press 15 |

## August 10 collector outages

The requested 17:00–17:20 inspection found healthy 12-machine polls through `2026-08-10T22:07:37.728Z` (17:07:37.728 CDT), then no poll rows until `2026-08-11T02:36:11.056Z` (21:36:11.056 CDT). The exact collector gap is 16,113.328 seconds. With a 180-second threshold:

- Trusted state ends / OFFLINE begins: `2026-08-10T22:10:37.728Z` (17:10:37.728 CDT)
- Collector recovery / OFFLINE ends: `2026-08-11T02:36:11.056Z` (21:36:11.056 CDT)
- Derived OFFLINE duration: 15,933.328 seconds

No failed poll rows were persisted. The recovery poll covered all 12 machines and reported 11 changed machines.

A second earlier gap was also discovered: `2026-08-10T15:51:40.699Z` to `2026-08-10T16:05:14.122Z` (813.423 seconds), producing derived OFFLINE from `15:54:40.699Z` to `16:05:14.122Z`.

## Hybrid query and availability algorithm

For each machine, ProcessIntelligence performs bounded, read-only queries:

1. Legacy seed: latest snapshot before the requested context and before cutover, `LIMIT 1`.
2. Legacy window: snapshots within the context, strictly before cutover.
3. Compact seed: latest event before the context and at/after cutover, `LIMIT 1`. If absent, retain the legacy seed.
4. Compact window: events at/after both context start and cutover.
5. Poll-run seed: latest compact heartbeat before context, `LIMIT 1`.
6. Poll-run window: compact heartbeats in the context.

Legacy snapshots are compressed into operational transitions. Compact events are already sparse transitions. Matching adjacent operational pairs are merged, so the boundary is continuous and not duplicated.

Availability is overlaid separately. Before cutover, legacy snapshot timestamps are heartbeat evidence. At/after cutover, poll-run timestamps are heartbeat evidence. A state remains trusted through exactly the stale threshold; OFFLINE begins only when heartbeat age is greater, at `lastHeartbeat + threshold`, and ends at the next successful poll. Sparse events with healthy polls mean **no event**, not **no data**.

Current state comes from `machine_status_current`, but is displayed as live only if the poll feed is fresh and the row is present. The row's state-change timestamp is retained separately from `latestPollUtc`.

Production requires the exact verified pair `event_type = 'G'` and `status_description = 'Run Production'`. Five-minute confirmation is measured only over trusted online state. True poll gaps interrupt episodes with `DATA_INTERRUPTED`; the storage cutover does not.

## Query plans and index support

At the live sizes (128 events, 469 polls, 12 current rows), PostgreSQL chose sequential scans for event ranges/current lookup because scanning these tiny tables is cheaper than index traversal. The latest-poll plan used `idx_machine_status_poll_runs_fetched_at` with an incremental sort for deterministic `id` ordering.

Existing indexes support the intended machine/start and latest-poll access patterns. The overlap predicate on `coalesce(ended_at, ...)` is not fully indexable, and deterministic `(timestamp, id)` order requires a small sort. No index change is justified at current volume. If future growth produces degraded plans, review—not automatically create—covering indexes such as `(machine_id, started_at desc, id desc)` and `(fetched_at desc, id desc)`.

## Known limitations

- Poll runs store aggregate coverage, not the IDs omitted from a historical partial poll. Current missing machines are identifiable through `is_present = false`, and event closure/recovery bounds their absence, but the poll row alone cannot attribute a historical partial failure to a specific machine.
- Failed polls are represented by missing rows, not explicit error records, so PostgreSQL can prove collector silence but not its external cause.
- `event_start_time` is optional upstream metadata and cannot replace collector-observed `started_at` without new verified upstream behavior.
- The permanent `processintelligence_readonly` role does not yet exist; live ProcessIntelligence remains intentionally unconfigured.
