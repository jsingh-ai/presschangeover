# Changeover Intelligence

Changeover Intelligence is a deterministic, read-only ProcessIntelligence product for studying the physical transition from one production Order to the next. Version 1 deliberately excludes AI interpretation, color/ink/deck scope, persistence, materialization, and source-system changes.

## Authority and evidence model

The evidence hierarchy is explicit:

1. Canonical `machine.speed.actual` telemetry defines the physical stop and recovery envelope.
2. Canonical `production.order` evidence confirms whether the physical stop is a changeover.
3. Radius explains the time inside the already-established physical envelope.

Radius never starts or ends a physical changeover. An Order change without a physical stop is tracked separately as a metadata-only transition and is not counted as a changeover.

The default definition is:

- stop when actual speed is below `1`, with a two-sample debounce;
- recover at the first actual-speed sample above `500` that remains above the threshold for five minutes;
- confirm a changeover only when the stable Order before the stop differs from the resolved Order after it.

Exact threshold values do not qualify: speed `1` is not below the stop threshold and speed `500` is not above the recovery threshold. A confirmed stop is backdated to the first qualifying sample. A confirmed recovery ends physical downtime at the recovery candidate start, not at the later confirmation timestamp. Failed recovery attempts are retained. Telemetry gaps interrupt evidence and are never bridged.

Users may change all three thresholds. Responses and the UI label the rule as `DEFAULT` or `CUSTOM`, and stable event IDs include the press, physical bounds, and algorithm version.

## Asynchronous Order identity

Order changes use the same five-minute settling semantics as Job Intelligence. Each coalesced transition preserves:

- `identityChangeFirstSeenAtUtc` — the first usable next-Order indication;
- `identityLastChangeAtUtc` — the final Order field change in the cluster;
- `identitySettledAtUtc` — five minutes after the final change, when the transition can be confirmed;
- the previous resolved Order, final resolved Order, and intermediate values.

The first-seen time is an inferred metadata boundary, not physical ground truth. A pending, missing, or conflicting transition produces an ambiguous stop instead of a confirmed changeover. This prevents asynchronous metadata propagation from being reported as real process duration.

## Radius alignment and reconciliation

Raw Radius intervals retain their original timestamps and exact event type, status code, and description. For analysis, contributions are clipped to `[physicalStartUtc, physicalRecoveryUtc)`. Uncovered time becomes `UNKNOWN_UNCLASSIFIED`; offline intervals become `RADIUS_DATA_GAP`; Radius production recorded during a physical stop becomes `RADIUS_PRODUCTION_MISMATCH`.

The adjusted contributions reconcile to the physical duration with a zero difference. Annotation start and end lag are neutral recording-alignment measures. They are not used to move the telemetry-derived physical bounds.

## Product surface

The route is `/changeover-intelligence`. It is fleet-first and keeps a press focus in the fleet context. The default view contains confirmed changeovers; `ALL STOPS` is context only. The page includes:

- fleet cards and an all-press performance board;
- median, P25, P75, P90, IQR, sample size, and evidence support;
- adjusted phase and exact Radius-loss summaries;
- failed recovery and sequence patterns, including loops;
- Order-to-Order transition pairs;
- a daily timeline that retains zero-event days and trend summaries;
- an inline inspector with actual speed, stop/recovery/confirmation markers, Order timing, raw Radius, adjusted Radius, exact reasons, and reconciliation.

Small cohorts remain visible but are explicitly marked insufficient; the product does not make “best” claims for tiny N.

## API and operational safety

`GET /api/changeover-intelligence/report` accepts a bounded UTC range, mode, optional focus press, and definition thresholds. `GET /api/changeover-intelligence/changeovers/:changeoverId` reconstructs one bounded evidence window for the inline inspector.

The service:

- uses the `TelemetryFoundationService` constructed by the production app;
- uses the already-injected singleton `RadiusService` and its existing read-only pool;
- passes all Changeover Radius work through a Changeover-owned process-wide FIFO acquisition guard (cap `1`) while retaining the existing singleton Radius service and production pool;
- performs fleet Radius acquisition sequentially by press;
- coalesces equivalent report requests and caches successful results briefly;
- isolates Radius failure as `PARTIAL` when speed and Order evidence remain usable;
- distinguishes `INSUFFICIENT_EVIDENCE` from source failure;
- reads only canonical `machine.speed.actual` samples and canonical `production.order` changes through the established chunked semantic-history path;
- analyzes at most the latest 24 hours from live sources. Longer requests return `LIMITED_HISTORY` and do not launch a broad live scan.

There is no Changeover database schema, repository, materializer, backfill command, role, pool, writer, or migration. No raw telemetry, Radius history, or derived Changeover rows are stored.

If controlled acceptance later proves that broader history is valuable, a minimal derived-history proposal can be evaluated through a separate approval gate. No such design or persistence is implemented in v1.

## Local verification

Deterministic fixtures A–K cover physical boundaries, exact thresholds, debounce, failed recovery, gaps, same/missing/conflicting Order identity, metadata-only transitions, Radius mismatch, clipping/reconciliation, zero-day timelines, aggregation, and support behavior. Service tests cover 12-press sequential acquisition, request coalescing, cancellation isolation, and Radius-failure isolation. Client checks cover the route, read-only calls, desktop layout, required sections, and uncertainty timestamps.

Live production browser or fleet validation is intentionally outside this implementation task and requires a separate controlled read-only approval gate.
