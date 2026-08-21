# Job Intelligence V1

Job Intelligence is a deterministic, read-only decision-support layer over the existing Radius and TelemetryQueryApi boundaries. It does not write source data, change production configuration, or call OpenAI.

## Production Run boundary

Order, Recipe, Customer, and Material are independent canonical telemetry fields. A usable change begins an identity-settling cluster. Each subsequent usable identity change within five minutes of the prior change extends that cluster. The final usable value of every changed field becomes the resolved identity. A new run is created only when that final composite identity differs from the prior composite identity. Unavailable fields remain absent and never invalidate other fields. Radius offline intervals break continuity and do not become run time.

If a combined production-context read fails because one mapped identity is temporarily unavailable, Job Intelligence retries the canonical identity fields independently. A failed field is marked temporarily unavailable while usable fields remain eligible; an unsupported field remains explicitly unsupported.

The run boundary may use the cluster's first change for deterministic segmentation, but the contract separately preserves:

- `identityChangeFirstSeenAtUtc`
- `identityLastChangeAtUtc`
- `identitySettledAtUtc` (last change plus five quiet minutes, or pending at the range edge)
- prior and final resolved identities
- incoming/outgoing Radius stable-production timestamps
- separate nullable telemetry physical-production timing

This prevents metadata propagation time from being silently presented as physical changeover time.

Range-start and post-gap segments do not receive a transition-duration proxy. A post-gap segment may retain the incoming stable Radius timestamp as evidence, but continuity, predecessor identity, and transition duration remain unavailable.

## Metrics and support

Production State Efficiency is the composition of observed Radius G/M/B time. It is not OEE and Radius Good is not a finished-product quality result. Exact event type, status code, and description remain attached to every loss episode.

Evidence is Strong at 10 runs, 8 observed hours, and 90% coverage; Moderate at 5 runs, 3 hours, and 80% coverage; Limited at 3 runs and 1 hour; otherwise Insufficient. Comparable results must also meet the equivalent matched-run threshold. Preferred-press and sequence recommendations require Strong or Moderate evidence.

Like-for-like matching uses the same selected identity, a run-duration band of 0.5x–2x, and exact Recipe/Material plus predecessor when at least three candidates survive. It falls back to same-identity/duration only. Results describe historical association, not causation.

Each transition summary includes a bounded fingerprint: its recurring exact Radius sequence, metadata-settling and timing-uncertainty medians, exact Radius loss causes, interruption behavior, and deterministic active-deck reuse/add/remove evidence where supported. Physical speed timing is explicitly `not_loaded_in_summary`; the Telemetry Event Explorer link is retained for bounded inspection instead of dumping or bulk-querying telemetry.

Job Intelligence ranges are capped at seven days because upstream semantic history is intentionally read in bounded two-hour chunks. Fleet reads occur only after the user selects a value/group and run with concurrency three. Deck continuity is evaluated only where canonical `deck.active` is supported and every deck has a usable boolean/0–1 value at the boundary.
