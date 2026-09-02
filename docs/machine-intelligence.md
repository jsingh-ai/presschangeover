# Machine Intelligence

Machine Intelligence replaces the former Job Intelligence user interface with a compact fleet-relative view. The page remains read-only against Telemetry and Radius.

## Evidence model

- Process Intelligence is telemetry-led. The current physical-stop classification is used, and the latest operator review overrides the prediction.
- Radius G/M/B remains separate recorded operational context. It is aligned beside Process Intelligence rather than used to move physical stop boundaries.
- Routine and predicted Uncertain time are accounted as Downtime. Bad or unavailable evidence remains Missing Data.
- Temporary Order or Recipe gaps do not create a new occurrence. An unchanged identity that resumes after a bounded evidence gap remains one occurrence.

## Presentation hierarchy

The surface contains fleet-relative bar charts for all presses: Process Intelligence time, Radius time, and paired non-good time. It does not declare a single press to be the opportunity.

Press rows load progressively and retain a compact summary. Expansion reveals recipe families, exact recipe IDs, occurrences, individual time segments, rolls, and aligned Radius context. These are nested expansions so detailed evidence is not placed on the page until requested.

Recipe-family comparison currently removes a trailing `E` identifier. For example, `1600-GAP01-E459` is displayed as the exact recipe and compared under `1600-GAP01`. Recipes without that explicit suffix remain unchanged.

## Range behavior

The page supports 24 hours, 72 hours, 14 days, and custom ranges up to 31 days. The existing Stop Intelligence / Press Downtime endpoint remains bounded to 72 hours, so longer Machine Intelligence ranges are composed from adjacent read-only windows. Adjacent windows with the same Order and Recipe are merged back into one occurrence.

This is progressive client composition over the existing validated evidence contract, not a persisted leadership fact store. Cold 14–31-day fleet loads are therefore still dependent on historian performance; the shared completed-read cache and global semantic-history limiter reduce duplication and protect the upstream service but do not eliminate cold computation.
