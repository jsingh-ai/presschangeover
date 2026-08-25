# Industrial Analytics V1

`IndustrialAnalyticsService` is a deterministic, calculation-only boundary shared by ProcessIntelligence analytics. The service accepts already-resolved Radius, production-context, or trusted canonical telemetry evidence and performs no I/O. Raw historian samples stay in process memory, while analytical results retain deterministic metrics, observation identity, support, and limitations.

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

## Selection and bounds

Press and observation selection is deterministic: adequate coverage first, followed by materiality, magnitude, support, and stable identity. Related observations remain grouped by press, retain their event IDs, and are de-duplicated by stable observation ID.

The analytics boundary performs no broad tag scan, database write, statistical machine learning, clustering, causal modeling, forecasting, PCA, change-point modeling, or learned-threshold inference.
