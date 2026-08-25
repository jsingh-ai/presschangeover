# Job Intelligence natural-run persistence contract

## Former range-dependent path

Before algorithm v4, `baseRuns()` seeded its first boundary at the evidence
`fromUtc`, selected the next identity cluster (or evidence `toUtc`) as the end,
and hashed that selected start plus identity into `runId`. The materializer then
used its chunk boundary to determine `isClosed` and assigned the chunk request
to `source_from_utc` / `source_to_utc`. `deriveProductionRuns()` assigned
`previousRunId` from the preceding derived interval. Consequently, the broad
August 19 observation started the physical interval at its source-proven
transition, while the narrow observation started it at `09:50:00Z`; those two
starts produced `236729...` and `4901a4...` for one physical interval.

## Algorithm v4

`deriveProductionRuns()` receives an evidence range and a separate requested
range. Historical acquisition asks for at most 48 hours of context on each
side. The requested range only filters intersecting results; it never creates a
persistent boundary.

A natural run:

- starts at the first usable change in a coalesced identity-transition cluster;
- ends at the first usable change in the next coalesced identity-transition
  cluster;
- is not cut by a Radius evidence gap; and
- has both boundaries present in source evidence.

Its ID is `press.job.<sha256-prefix>` over the natural start timestamp and the
ordered final Order/Recipe/Customer/Material identity. Acquisition bounds are
not hash inputs. Persisted canonical facts do not fingerprint adjacency IDs,
because the set of loaded neighbours is acquisition-dependent. Inspector reads
reconstruct those IDs from stored natural chronology. Previous identity values
remain independently persisted evidence and are never reconstructed from an
adjacency ID.

The five-minute coalescing interval remains explicit. The contract retains
`identity_change_first_seen_at`, `identity_last_change_at`,
`identity_settled_at`, final resolved identity, transition-time previous
resolved identity, inferred-boundary status, Radius stable-production timing,
and telemetry physical timing when available. First-seen time is therefore not
treated as an unquestioned physical changeover timestamp.

The first identity cluster in an acquisition is natural only when its first
change is at least one complete five-minute settling interval after the
identity-context start. The exact five-minute boundary is sufficient; anything
earlier is conservatively unresolved because an unseen change could still
belong to the same asynchronous cluster. Requested ranges remain filters and
may begin before, inside, or after a cluster without moving its boundary. If
bounded prior context is absent, the seed supplies state only: it never proves
or fabricates a transition boundary.

## Boundary fragments

An evidence-start interval, an unresolved acquisition-start identity cluster,
an evidence-end interval, or either side of a source
gap is labelled `left_fragment`, `right_fragment`, `isolated_fragment`, or
`gap_fragment`. Fragments have diagnostic `.fragment.` IDs only for the live
response. `persistenceEligible` is false and the repository rejects direct
fragment persistence. A fragment never becomes a normal closed history row.
If 48-hour context cannot prove a natural boundary, materialization skips the
fragment instead of guessing.

## Checkpoints and validation

Forward/resumable materialization owns the history checkpoint. Before every
commit, one centralized checkpoint-safety assessment walks the requested chunk
from its current watermark. Only contiguous natural, persistence-eligible
intervals prove coverage. A fragment of any current or future type, or an
uncovered hole, stops progress at the last proven timestamp. Zero proven
coverage leaves the watermark unchanged and fails closed. Both the
materializer and PostgreSQL update enforce `processed_through_utc` and source
coverage end with `GREATEST`, and source coverage start with `LEAST`. A narrower
forward re-read may refresh facts but cannot regress progress.

Bounded validation is a separate mode. It upserts proven natural facts but
does not claim, create, fail, or advance a checkpoint. The representative
validator additionally requires a different localhost PostgreSQL port and the
exact database comment `ProcessIntelligence disposable Job validation
database`; it cannot select the configured production application database.

Representative parity compares the union of expected and stored IDs. Each
entry is classified as `expected_and_stored`, `missing_from_store`,
`extra_in_store`, `fingerprint_mismatch`, `field_mismatch`, and/or
`loss_mismatch`. All entries are collected before failure. Extra rows include
their interval, previous ID, fingerprint, and the exact requested-range
intersection reason.

## Persistence integrity

The two previous-identity concepts use separate columns. `previous_*` is the
adjacent derived-production identity; `transition_previous_*` is the resolved
metadata identity observed around the asynchronous transition. Neither falls
back to the other on write, canonicalization, or readback.

Every repository write path canonicalizes and validates the full persistence
object before connecting or issuing SQL. It requires a closed natural interval,
first-seen equal to the natural start, final-change plus five minutes equal to
settled time, resolved final identity equality, the deterministic natural ID,
valid source coverage, finite/ranged persisted numbers, and a caller fingerprint
equal to a repository recomputation. The recomputed value—not the caller value—
is sent to PostgreSQL.

On a same-ID conflict, v4 updates every mutable fingerprinted semantic column
and `source_fingerprint` in the same SQL statement, expands source coverage
with `LEAST`/`GREATEST`, and replaces exact-loss children in the same database
transaction. A fingerprint therefore cannot be committed ahead of its facts.

`speed_variability` is redundant derived storage, not an additional canonical
fact: it must equal canonical `speed_p75 - speed_p25`. Migration 004 adds a
constraint for new writes, the encoder always derives it, and the decoder
rejects disagreement. The p25 and p75 inputs remain fingerprinted.

Loss identity is the tuple `(event_type, normalized_status_code,
status_description)`. Null and empty status codes deliberately share the
database empty-string sentinel. Canonicalization rejects duplicate normalized
tuples and validates category from event type before SQL, so a primary-key
collision cannot silently merge distinct aggregate values.

## Existing v3 overlap reconciliation (future, not executed)

Existing production v3 rows are left unchanged. After v4 history is approved
and independently materialized, a cleanup report can be built without source
mutation:

1. Partition v3 and v4 rows by press and intersecting time.
2. Match only when the v3 interval overlaps one v4 natural interval and the
   ordered resolved identity is equal.
3. Classify v3 rows as exact predecessor, acquisition-bound fragment,
   ambiguous multi-match, or unmatched.
4. Emit old/new IDs, intervals, fingerprints, identity, overlap seconds, and
   classification to an immutable review artifact.
5. Require explicit approval for a ProcessIntelligence-owned v3 deletion;
   ambiguous or unmatched rows remain untouched.

No Radius or telemetry row participates in, or can be changed by, that future
procedure.

## Test oracles

The segmentation lifecycle test uses hard-coded IDs calculated from the
published natural-ID contract (independent contract oracle). The optional real
PostgreSQL test uses literal expected decoded facts and executes migrations
002-004 in a fresh, explicitly marked disposable database. Production
canonicalization and repository code supply the actual path, not the expected
values. Other unit tests that verify canonical implementation mechanics use
the production implementation as their oracle and are not claimed as an
independent SQL-fidelity proof.
