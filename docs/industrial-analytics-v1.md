# Industrial Analytics V1

The AI Investigator uses `IndustrialAnalyticsService` as a deterministic, LLM-independent calculation boundary. The service accepts already-resolved Radius, production-context, or trusted canonical telemetry evidence and performs no I/O. Raw historian samples stay in process memory and are never serialized into the OpenAI request. The model receives only retained observation IDs, deterministic scalar metrics, grounding fact IDs, and narrative instructions.

## Support and materiality rules

| Family | Minimum support | Materiality / rejection rule |
| --- | --- | --- |
| Current vs baseline | 80% coverage in both ranges | Metric-specific absolute delta: production 5 percentage points, interruptions 3, longest interruption 60 minutes, matched Radius-state duration 30 minutes, matched state frequency 2 occurrences. |
| Robust numeric change | 5 usable numeric samples | Maximum of absolute start/end change, adjacent change, or standard deviation must be at least 2 robust scales. Bad/unavailable quality, duplicates, non-numeric values, and constants are rejected. |
| Event aligned | 3 usable samples in each before, event, and after window | Absolute before-to-event median change must be at least 2 baseline robust scales. Event analysis is capped to 20 minutes with at most 20 minutes of context on each side. |
| Value/state transition | 2 usable state observations | Retain at least 2 transitions, or 1 transition within the event context. Exact categorical and boolean values are preserved; reconnects are not inferred as transitions. |
| Radius sequence deviation | 3 other comparable episodes and at least 2 supporting the modal sequence | Retain only a sequence variation with an extra, missing, looped state, or more than one return attempt. States remain exact Radius descriptions. |
| Numeric relationship | 8 aligned pairs | Reject constant signals. Retain absolute bounded-lag correlation of at least 0.70. Pearson, tie-aware Spearman, and lags from -10 to +10 minutes are reported as association, never causation. |
| Cross-press comparison | 2 independently supported presses using the same canonical metric and exact range | Each press must have at least 80% coverage. Retain deviations of at least the larger of 2x median absolute fleet deviation or 20% of the compatible-press median. Press series are never merged. |

All numeric output is finite, rounded deterministically, and includes sample counts, coverage where available, magnitude inputs, limitations, source, and an approved local explorer link. Unsupported, inadequate, constant, sparse, and below-threshold observations are counted but excluded before candidate grouping.

## Ranking and bounds

Press selection is deterministic: adequate coverage first, then material baseline signal count, absolute production change, interruption change, longest-interruption change, and press number. Related observations are grouped by press (and retain their event IDs), de-duplicated by stable observation ID, and ranked by fixed family priority, magnitude, support, then ID. The model package contains at most five all-press candidates, at most three selected-press candidates, and at most three observations per candidate.

The discovery preflight performs two fleet Radius queries, then one Radius episode/context package and at most one bounded trusted-speed query for each selected candidate. No broad tag scan, database write, retry, fallback model request, statistical ML, clustering, anomaly model, causal model, forecasting, PCA, change-point model, or learned threshold is part of V1.
