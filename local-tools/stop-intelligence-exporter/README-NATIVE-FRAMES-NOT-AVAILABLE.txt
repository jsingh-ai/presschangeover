PROCESSINTELLIGENCE STOP INTELLIGENCE EXPORTER
NATIVE FRAME CAPABILITY BLOCKER

Status
======

The standalone lossless raw-frame exporter was intentionally NOT implemented.

As of 2026-08-25, the approved TelemetryQueryApi interface available to
ProcessIntelligence does not expose a read-only bulk operation that returns
complete native telemetry frames for a sourceId and bounded UTC range.

Building an exporter on the available sparse/aggregate routes would incorrectly
label incomplete data as "all raw telemetry" and would violate the purpose of
the offline Stop Intelligence study.


Evidence inspected
==================

The deployed production-aligned source defines these raw telemetry operations:

1. POST /api/raw-telemetry/changes

   This operation reads native frames internally, but returns aggregate
   per-signal change summaries. Its response includes fields such as
   framesRead, rawCatalogIdentityCount, usableIdentityCount, changeCount,
   firstValue, lastValue, minimum, and maximum. It does NOT return the original
   frame records or their complete payloads.

2. POST /api/raw-telemetry/history

   This operation requires one exact rawIdentity and returns sparse history for
   that selected identity. It is not a bulk frame operation. Using it for every
   catalog identity would require thousands of requests and still would not
   prove reconstruction of each original native frame.

3. GET /api/telemetry/sources/{sourceId}/signals

   This returns the current raw signal catalog, not frame contents.

The ProcessIntelligence TelemetryApiClient contains no native-frame method or
contract beyond the operations above.


Short bounded route verification
================================

Three sequential probes were made with a five-second Press 14 UTC range. They
did not retrieve source data because each route was absent:

  POST /api/raw-telemetry/frames                 -> HTTP 404
  GET  /api/telemetry/sources/1/raw-frames       -> HTTP 404
  GET  /api/telemetry/sources/1/frames           -> HTTP 404

No broad range, parallel request, per-signal fleet, or retry loop was used.


Missing API capability
======================

A reviewed read-only operation is required with semantics equivalent to:

  sourceId: integer
  startUtc: inclusive UTC timestamp
  endUtc: exclusive UTC timestamp
  bounded page/chunk size or continuation cursor

For every native historian frame, it must return at least:

  frame timestamp
  received timestamp, if present
  source timestamp, if present
  frame ID/ordinal/sequence, if present
  the complete original payload
  all original quality and frame metadata

The payload must preserve signal IDs, booleans, numbers, strings, nulls,
arrays, objects, quality values, timestamps, duplicate observations, and any
unknown fields without normalization or filtering.

The operation also needs deterministic ordering and documented inclusive/
exclusive range boundaries so adjacent chunks can be exported without
inventing gaps or silently removing duplicates.


Closest safe alternatives
=========================

Preferred alternative:

Ask the TelemetryQueryApi owner to expose a reviewed, streaming or paginated,
read-only native-frame route with the contract above. Once that route exists,
the standalone exporter can safely write one frame per NDJSON.gz or Parquet
record, chunk sequentially, resume, and validate local files.

Second alternative, requiring separate authorization and design review:

Use a dedicated read-only database boundary to stream the historian's native
frame table directly with indexed source/time predicates. The exact physical
schema/table is not exposed to ProcessIntelligence, and no telemetry database
credentials are available here, so this alternative cannot be implemented by
this utility under the current boundary.

Not acceptable:

Do not loop over all 1,176 Press 14 and 754 Press 15 identities using
/api/raw-telemetry/history. That would create excessive source load and would
produce sparse per-tag history rather than confirmed lossless native frames.

Do not treat /api/raw-telemetry/changes as raw-frame output. It is an aggregate
change-discovery response and omits complete unchanged frame payloads.


Safety statement
================

No exporter was run. No source database connection was opened. No source SQL
was executed. No files in the production-aligned worktree were modified. No
.env, service, deployment, TelemetryQueryApi, Radius, PostgreSQL, MQTT,
Kepware, schema, index, role, permission, or configuration was changed.

