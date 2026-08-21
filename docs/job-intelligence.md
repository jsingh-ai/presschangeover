# Job Intelligence fleet product

Job Intelligence is deterministic fleet analysis over the approved read-only Radius and TelemetryQueryApi boundaries. Original operational evidence is never mutated. Only three compact, disposable structures in the isolated `processintelligence_db` application boundary retain expensive per-run derived facts; they are not operational truth or a replacement historian. The feature does not infer production state from speed, call OpenAI, or include ink/color enrichment.

## Identity and timing policy

Order, Recipe, Customer, and Material are independent canonical fields. A usable change begins a rolling five-minute cluster; every later usable identity change within five minutes extends it. A run may use the first change as an inferred segmentation boundary while retaining the first indication, final field change, settled timestamp, previous and final resolved identities, incoming stable Radius production, nullable telemetry physical timing, uncertainty, and gap state.

The first metadata indication is never unquestioned physical ground truth. Range-start and post-gap runs have no invented predecessor or transition proxy. Gaps remain unavailable and transitions never cross them.

## Minimal derived schema

Migration `server/migrations/002_job_intelligence_minimal_derived.sql` creates exactly:

- `job_intelligence_runs`: one compact row per versioned run containing identity/timing, previous identity, G/M/B/unavailable totals, transition-phase M/B, running/speed statistics, compact deck sets, quality, provenance, fingerprint, and open/closed state;
- `job_intelligence_run_losses`: one row per run plus exact Radius event type/code/description, containing only total seconds, occurrence count, median episode seconds, and deterministic M/B category;
- `job_intelligence_materialization_state`: one tiny checkpoint row per press and algorithm version.

No raw speed samples, raw telemetry payloads, deck traces, full Radius episodes, transition table, fleet aggregate, recommendation, ranking, decision card, matrix cell, or time-range summary is persisted. Those remain source evidence or are calculated dynamically from the compact rows.

The active version is `job-intelligence-2026.08.v3-minimal`. A source fingerprint covers persisted derived facts and is independent of the arbitrary processing window. Reprocessing is idempotent; unchanged closed rows are not rewritten, while open or genuinely changed rows can update. A major algorithm change uses a deliberate new active version/rebuild rather than accumulating generations indefinitely.

Six focused run indexes support version/time, press/time, and each identity/time. The loss primary key begins with version/run, so a separate speculative loss index is unnecessary. Source-system indexes are untouched.

## Backfill and live tail

Backfill is limited to seven-day source chunks with a five-minute reconciliation overlap. Migration `003_job_intelligence_checkpoint_safety.sql` adds only lease and lifecycle fields to the existing tiny checkpoint table; it creates no new data structure. A 15-minute lease prevents a second legitimate worker from claiming the same press/version. A lease-less legacy `running` row or an expired lease is stale and resumes from the unchanged last fully committed watermark.

Run/loss upserts and safe-watermark advancement commit in one application-database transaction. Starting work changes only lifecycle/lease fields. Success advances `processed_through_utc` to the last closed safe boundary; source, cancellation, derivation, or persistence failure changes the checkpoint to `failed`, records a bounded category/message, clears the lease, and does not advance the watermark. A process crash may leave `running`, but the bounded lease makes it recoverable without treating partially processed work as complete.

```powershell
npm run backfill:job-intelligence --workspace server -- --from=2026-08-10T14:29:00.415Z --to=2026-08-20T00:00:00.000Z --press=press5
```

Use `--no-resume` only for a deliberate rebuild. Normal fleet reports read closed derived rows plus a small recent/unclosed live tail. With all press checkpoints present, the tail begins five minutes before the oldest watermark. Wide unmaterialized live windows defer full-fleet canonical speed instead of recreating the observed 79-second raw-speed path; offline materialization retains per-run speed statistics.

## Fleet API and bounded detail

- `GET /api/job-intelligence/values` discovers Order, Recipe, Customer, or Material values.
- `GET /api/job-intelligence/report` takes a generic group/refinements and returns all matching presses, a few supported decisions, compact comparisons, aggregate losses, previous-job effects, and a bounded historical page.
- `GET /api/job-intelligence/runs/:runId` loads only an existing compact stored/cached run. It returns identity, performance, the top five aggregate Radius losses, transition/deck context, and the distinct metadata/Radius/telemetry timing fields; it does not reread source data or return raw episodes/samples.
- `GET /api/job-intelligence/diagnostics` returns lightweight in-memory Radius acquisition counters for controlled validation; it performs no source acquisition itself.

History supports 7, 30, 90, and all available (ten-year HTTP safety maximum). A page is at most 100 rows. Analysis reads at most 25,001 matching rows so the 25,000 guard is surfaced explicitly and never silently truncates. Matching uses safe exact/contains/prefix/suffix/position/delimiter operations, never unrestricted regex.

## Radius acquisition safety

All Job Intelligence raw Radius timeline reads pass through one module-owned, process-wide FIFO semaphore capped at one active acquisition. Within a Node process, values, fleet reports, refinements, legacy report support, and materialization service instances therefore share the same cap across HTTP requests. Remaining acquisitions queue; cancellation while queued removes the waiter, and active success, cancellation, or failure releases its permit in `finally` before the queue drains. Compact run inspection does not acquire Radius evidence.

The normal ProcessIntelligence Node process owns its existing Radius pool, uses `processintelligence_readonly`, and retains its code default of five connections; there is no environment pool-size override. Maintenance materialization reuses that same secured configuration only while `ProcessIntelligence.Node` is confirmed stopped. The one-shot pool is named `ProcessIntelligenceJobMaterializer`, is fixed at one physical connection, starts every session with `default_transaction_read_only=on`, verifies that setting, and verifies SELECT-without-INSERT/UPDATE/DELETE/TRUNCATE on the four exact Radius tables before any acquisition. No new role, credential, grant, or source configuration is required.

The Radius contract does not directly cancel an already-dispatched PostgreSQL query. Such queries remain bounded by the five-second statement timeout; Job Intelligence drains the active Radius promise before propagating telemetry cancellation/error, `pg.Pool.query` releases its checked-out client on success or error, and the standalone owner closes its pool in `finally`. Deterministic service isolation means the one-slot maintenance pool never competes with the normal five-slot web pool.

Fleet evidence retains single-flight coalescing above the semaphore: equivalent values/report work shares one in-flight result and one set of press acquisitions. Diagnostics expose the configured cap plus current active/queued counts and lifetime peak, and the most recent fleet scope exposes its total and peak without production log noise.

The browser smoke is disabled unless explicitly approved, uses one controlled browser session, holds a cross-process lock, performs its interactions sequentially, and has bounded polling. It must not be run alongside another full-fleet validation or before production health is confirmed.

Materialization entry points fail closed unless `--maintenance-mode` is explicit, the Windows service is `Stopped`, no production Node child remains, the exclusive cross-process lock is held, and no duplicate backfill/representative/validation/browser consumer exists. These checks happen before the Radius pool opens. Materialization never probes role headroom, retries connection acquisition, or runs concurrently with the production web service.

## Derived-history activation gate

The migration is approval-gated and is not part of an application build or startup. Before it is executed, the checked-in DDL is audited to contain exactly the compact run table, aggregate exact-loss table, and per-press/version checkpoint table described above. No raw Radius episode, telemetry observation, speed sample, historian payload, source-system DDL, or source-system grant is present.

The available captured seven-day fleet Recipe inventory contained 51 observed Production Runs across the 12 supported presses: 7.29 fleet runs/day, or 0.61 runs/press/day. A separately validated three-run Press 5 sample contained at least three distinct exact Radius loss codes (47, 82, and 125), establishing a measured lower bound of one aggregate loss row/run. Until representative materialization supplies the exact mean, storage planning uses four loss rows/run and checks a conservative one-to-eight-row envelope.

Pre-migration sizing assumes about 1.5 KiB per compact run including its six secondary indexes and primary key, and 0.5 KiB per aggregate loss including its primary key. These are engineering estimates, not measured PostgreSQL relation sizes:

| Horizon | Run rows | Planning loss rows | Planning storage | Conservative 1–8 loss rows/run envelope |
| --- | ---: | ---: | ---: | ---: |
| 30 days | 219 | 876 | about 1.0 MiB | about 0.6–1.6 MiB |
| 1 year | 2,659 | 10,636 | about 12 MiB | about 7–19 MiB |
| 3 years | 7,977 | 31,908 | about 35 MiB | about 20–56 MiB |

The estimates include 30% allowance for page overhead and ordinary bloat. After an approved representative materialization, actual run/loss/checkpoint counts and `pg_relation_size`, `pg_indexes_size`, and `pg_total_relation_size` must replace these estimates before broader backfill is proposed. The same interval must then pass live-versus-derived parity, idempotent rerun, and interrupted checkpoint/resume checks.

## Metrics and support

Production State Efficiency is the observed Radius G/M/B composition. Radius Good is not finished-product quality. Transition Make Ready/Bad ends at incoming stable Radius production. Running metrics begin only there and include Good/Bad, interruptions/hour, uninterrupted Good episodes, restarts, and canonical actual-speed distributions. Speed is descriptive and never assigns Radius state or claims throughput without trusted semantics.

Support is Strong at 10 runs, 8 observed hours, and 90% coverage; Moderate at 5 runs, 3 hours, and 80%; Limited at 3 runs and 1 hour; otherwise Insufficient. Only Strong or Moderate evidence can generate a recommendation. Like-for-like matching is transparent historical association, not a causal estimate or opaque score.

Every Job Intelligence inspection remains inline. Press focus, a small affected-run loss summary, the previous-job matrix, historical runs, and light run detail preserve the selected group, refinements, history, and fleet context. The page intentionally does not recreate raw episode explorers, synchronized trace workbenches, or AI analysis.

## Source safety

Job Intelligence makes zero writes to Radius or telemetry/raw historian data; zero source schema/index, permission, credential, or collector changes; and no direct telemetry-database connection. Its only mutations target the three allowlisted, rebuildable ProcessIntelligence-derived structures above through the restricted application role.
