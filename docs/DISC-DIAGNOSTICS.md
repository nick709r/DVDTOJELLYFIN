# Disc Diagnostics

Disc Diagnostics combines the in-memory state of the current detection attempt
with the durable event timeline stored for each job. The dashboard subscribes
to the existing status event stream while visible and reloads diagnostics when
new events arrive. It does not start a separate metrics sampler; CPU, memory,
GPU, and disk monitoring remain limited to an actively viewed main dashboard.

## Dashboard sections

- **Live disc:** drive/device, detection method and time, media kind, label,
  fingerprint, source provider, classification, and current status.
- **Classification:** the DVD TV-prefilter decision, heuristic confidence,
  passed/failed criteria, criterion weights, and score contributions.
- **Disc structure:** DVD title manifest, runtimes, longest-title candidate,
  episode-length candidates, and bonus-title candidates; for audio CDs the
  disc ID and detected track numbers are shown.
- **TV analysis:** series/season candidates, item classification, duplicate
  and alternate evidence, bonus/commentary detection, episode match proposals,
  alternatives, confidence scores, and explanations.
- **Metadata:** provider candidates, provider failures, per-entity lookup time,
  and confidence where the provider resolver reports them.
- **Pipeline and live log:** chronological job events with event level and
  timestamps. Elapsed time is the interval until the next recorded event (or
  until the active/finished job endpoint); it is not a separately instrumented
  wall-clock duration for an internal stage.

Use the disc/job selector to inspect one of the most recent 50 jobs. Selecting
the live option shows the current drive snapshot alongside empty history
panels until a processing job exists.

## API and persistence

- `GET /api/v1/diagnostics` returns the active job or latest job, its event
  timeline, recent job choices, and the current in-memory detection snapshot.
- `GET /api/v1/diagnostics?jobId=<id>` returns a selected job's persisted
  diagnostics.
- `GET /api/v1/diagnostics?live=1` returns only live detection state and the
  recent job choices.
- `GET /api/v1/events` sends the existing status SSE event, including the
  current detection snapshot. Job event writes now publish status updates so
  the diagnostics page refreshes as processing advances.

Disc source manifests and structured classification/analysis details are
recorded in the existing `job_events` table. The live pre-job detection
snapshot is held in memory and is cleared when the drive reports disc removal;
it is not a durable record until a job has been created.

## Current provider limitations

- The MakeMKV inspection adapter currently reports title IDs, names, and
  runtimes, but not chapter counts. The UI explicitly shows chapter data as
  unavailable.
- The audio-CD inspection adapter currently reports the disc ID and track
  numbers but does not normalize track durations; lengths are shown as
  unavailable rather than guessed.
- TV metadata lookups report candidates, failures, confidence, and elapsed
  resolver time. Returned candidates include source-provider, fallback-use,
  and cache hit/miss details. A lookup that produces no candidate has no
  candidate-level cache details to display; the UI reports that as
  unavailable.
- GPU utilization and resource metrics are intentionally not repeated on this
  page to avoid background work when only diagnostics is open.

The page is read-only. It does not change classification, matching, review,
ripping, conversion, or publishing behavior.
