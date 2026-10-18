# AutoDisc Architecture and Implementation Plan

**Status:** Version 1.5 implementation scope; target-hardware acceptance required
**Deployment:** Native Lubuntu/Linux service managed by systemd (no Docker)

## 1. Product boundary and operating assumptions

AutoDisc is a single-user, single-optical-drive appliance. It accepts one disc
at a time: DVDs use MakeMKV and FFmpeg to extract a main feature, while music
CDs use cdparanoia to extract tracks and FFmpeg to encode lossless FLAC. It
publishes each movie atomically inside a title-named folder in Jellyfin Movies
and either publishes named
music albums directly to Jellyfin Music or submits them to Lidarr for import
after naming and tagging. A durable SQLite job record is the source of truth. A small web interface is for
administration, status, history, and configuration—not a prerequisite for normal
disc processing.

The first release assumes:

- Linux with systemd/udev and one optical drive such as `/dev/sr0`.
- A writable Jellyfin Movies directory and a separate work
  directory with enough free space for a full disc rip plus output.
- One AutoDisc instance and one disc-processing worker. Parallel ripping or
  encoding is deliberately out of scope.
- MakeMKV is installed on the host from a user-provided, legally obtained
  distribution. Its license/key and any beta-key renewal are the
  operator's responsibility.
- The appliance does not circumvent copy protection. Disc compatibility and
  permitted use depend on MakeMKV, applicable law, and the operator's rights.
- Network access is local for the UI. Optional external metadata lookup is
  disabled unless configured.

For music CDs, enabling MusicBrainz lookup preserves unattended processing when
a usable match is found. If that lookup cannot identify a matching release and
medium, the audio is retained in the work directory while the active job waits
for dashboard input. An operator can resolve a MusicBrainz release ID against
the detected track count or submit album and per-track names manually. The
job waits without a timeout until submitted or cancelled. Disabling MusicBrainz
lookup retains the existing offline, generic-name behavior.

### Important GPU reality

The product should detect actual FFmpeg and device capabilities at runtime, not
infer them from a GPU name. A card marketed as a GTX 710 is commonly a
Kepler-based GeForce GT 710; those variants generally do **not** contain an
NVENC encoder. CUDA support does not imply NVENC support. Exact board/chip
variants and driver stacks differ, so startup diagnostics must report what is
actually available. On a typical GT 710, FFmpeg will use software encoding;
AutoDisc must continue normally and clearly show that encoder. No architecture
can make NVENC work on hardware without an NVENC block.

## 2. Recommended stack and rationale

| Area | Choice | Reason |
|---|---|---|
| Runtime | Node.js LTS, TypeScript, ESM | Matches preference; good child-process, filesystem, and HTTP support. |
| HTTP/API | Fastify with typed REST handlers and explicit validation | Small REST surface, clear input errors, and structured logging. |
| UI | Server-served static HTML/CSS/vanilla JavaScript | Avoids a heavyweight frontend runtime and keeps the appliance footprint small. |
| Updates | Server-Sent Events (SSE) for live job/dashboard updates; REST for commands | Simple one-way updates without WebSocket infrastructure. |
| Persistence | SQLite using a maintained Node binding, WAL mode, foreign keys, and migrations | Durable local history/settings, no database service to administer. |
| Disc extraction | MakeMKV command-line interface (`makemkvcon`) | Proven DVD extraction software; AutoDisc orchestrates it rather than implementing ripping. |
| Audio CD extraction | cdparanoia and cd-discid | Secure digital audio track extraction, local table-of-contents identity, and MusicBrainz disc matching. |
| Conversion | FFmpeg/ffprobe subprocesses | Proven conversion, probe, and hardware-encoder support. |
| Device integration | Linux udev event subscription plus device-state verification | Event-driven detection avoids a busy polling loop; state verification handles noisy or missed events. |
| Deployment | Native Node.js process managed by systemd | Direct access to host drive, media directories, tools, and GPU avoids container device passthrough complexity. |
| Tests | Node test runner or the repository-standard runner; injectable process/device adapters | Fast unit tests without a real drive, GPU, or MakeMKV installation. |

Pin supported Node.js and package versions in releases. Install MakeMKV/FFmpeg
through host packages or their respective official distribution mechanisms, not
on every service start. Record tool versions in startup diagnostics and jobs.

## 3. Native Linux service architecture and host integration

### Initial topology

```text
Browser on trusted LAN
        |
        | HTTP / SSE (configurable port; default 8787)
        v
autodisc.service (dedicated unprivileged system account)
  Fastify API + static UI
  SQLite job coordinator + single worker
  udev listener -> cdparanoia or MakeMKV -> FFmpeg/ffprobe
        |                     |                     |
        v                     v                     v
 /dev/sr0                 host GPU         Jellyfin Movies and Music folders
 /var/lib/autodisc       /dev/nvidia*       /srv/jellyfin/Movies
 /var/cache/autodisc
```

Run one Node.js service under systemd; a separate worker process/service is not
needed for the single-drive serial pipeline. The unit uses a dedicated
`autodisc` user, supplementary optical/video groups, a persistent state
directory (`/var/lib/autodisc`), and work cache (`/var/cache/autodisc`).
Application source is installed root-owned under `/opt/autodisc`, while runtime
settings are protected under `/etc/default/autodisc`. The unit restarts on
failure, handles SIGTERM to stop child processes, and applies systemd sandboxing
without blocking configured media paths or required devices.

The installer must install Node.js and native build/system dependencies from
trusted, signed apt repositories, then create the service account and
directories, build native Node dependencies, install the unit, and preserve
operator configuration on upgrades. MakeMKV remains a separately licensed
manual prerequisite. The operator must grant the service account
explicit read/write permissions for the selected work and Movies directories,
and device access to the selected optical drive. The default bind is `0.0.0.0` on port 8787 for home-network access; `HOST` and
`PORT` can override it. Passwordless first-run mode grants administration to
anyone who can reach the port, so restrict it to the trusted LAN with the host
firewall and configure a password. Do not
run as root or grant broad capabilities. MakeMKV is separately licensed and is
installed on the host; private/beta keys are never kept in this repository.

### Storage sizing

DVD extraction and conversion require substantial temporary space. Before a
job starts, verify free space and writable permissions in both work and output
locations. Make the required reserve configurable, with a conservative default.
Never start a rip if the work volume cannot satisfy the reserve. Warn if work
and output resolve to the same underlying filesystem, since this can cause
temporary space exhaustion. Keep only one job directory at a time, and delete
it after success or after a bounded, configurable retention period for failures.

## 4. Application components and data flow

```text
UdevDiscMonitor
  -> DiscInspector (drive state + MakeMKV info; ignore data/non-video discs)
  -> JobCoordinator (one active job; durable state transitions)
  -> RipService (MakeMKV CLI, logs, cancellation, timeout)
  -> TitleResolver (disc/volume/MakeMKV labels, optional metadata provider)
  -> EncoderResolver (FFmpeg inventory + device checks + configured policy)
  -> ConvertService (ffprobe, FFmpeg progress pipe, output validation)
  -> PublishService (safe name, same-filesystem temp file, atomic rename)
  -> CleanupService (workdir cleanup, eject policy, final state)

Fastify REST + SSE -> JobCoordinator / SettingsService / HistoryRepository
Dashboard session -> on-demand ResourceSampler (no dashboard, no sampling loop)
```

The worker is a serial state machine:

`idle -> inspecting -> ripping -> resolving_title -> converting -> validating
-> publishing -> completed`

Any active state may transition to `failed` or `cancelled`. Persist each
transition and timestamps before/after irreversible operations. Enforce a
database-backed single active job constraint, and also guard the in-process
worker so a duplicate udev event cannot queue or start a second rip.

### Disc detection and recognition

1. Subscribe to udev block-device events for the configured optical drive.
2. Debounce/coalesce events, then verify the current drive/media state; do not
   treat every event as a new disc.
3. Assign a media fingerprint from available stable disc identity/volume data
   and track the currently inserted medium. This prevents duplicate work from
   repeated events. Clear the inserted-media marker only when the drive is
   verified empty or a different medium is detected.
4. Probe for audio tracks with cdparanoia. If present, fingerprint the table of
   contents and use the audio workflow; otherwise ask MakeMKV for DVD
   information and title/stream metadata. Reject empty, unreadable, and
   unsupported media without creating a conversion job.
5. Persist an accepted job before starting any rip. Keep the drive occupied
   until conversion, publication, cleanup, and configured eject behavior finish.
6. After a disc is removed/ejected, wait for a new verified insertion. Never
   automatically start a second job while one is active.

udev delivery and optical drive state vary across distributions and drive
firmware. Start with a media-presence check and use a lightweight two-second
state reconciliation as a fallback for missed insertion/removal events. Only
schedule a scan on a newly observed insertion, so an unreadable disc is not
re-probed continuously. Queue an insertion scan that arrives while another
check is in progress. A physical-drive integration test is still required;
simulated events alone do not prove detection on the target host.

### Title selection

DVDs do not reliably provide a human movie title. Select in this order:

1. High-confidence match from an explicitly configured metadata provider (opt-in;
   may require internet/API credentials).
2. MakeMKV's disc name or volume label, normalized for a safe filename.
3. A neutral fallback such as `Unknown Title - YYYY-MM-DD`; do not invent a
   movie name from an arbitrary longest track.

Store the raw title evidence, chosen title, and confidence/source. Permit a
single-user rename before or after publishing. A title with low confidence must
not block an unattended conversion. Document that accurate automatic
identification without disc metadata or an external catalog cannot be
guaranteed.

### Music CD policy

Extract each audio track with cdparanoia into the temporary workspace, then
encode and tag every track as lossless FLAC. Name all output tracks before
publication. Direct mode publishes a complete album directory by same-filesystem
rename into Jellyfin Music. Optional Lidarr mode stages the named album in a
shared incoming directory, submits it to Lidarr's manual-import API with Move
semantics, waits for the import command, and leaves the source intact if Lidarr
cannot match or import it. Lidarr and AutoDisc must see the same incoming path,
and the Jellyfin Music directory must be the Lidarr-managed library root.
Lidarr mode requires an existing matching artist/album in Lidarr and enabled
MusicBrainz lookup so metadata can be used for matching. Read-only MusicBrainz
Web Service queries do not require an API key. AutoDisc identifies itself with
an application/version User-Agent and can include an operator-provided contact
email. Never send disc IDs to MusicBrainz unless the setting is enabled.

## 5. Encoding, presets, and configuration

### Encoder policy

- `auto` is the default: enumerate FFmpeg encoders and usable devices; choose a
  configured supported hardware encoder first, with NVIDIA preferred when
  available; otherwise choose the configured software encoder.
- `software` forces the selected CPU encoder.
- Explicit hardware choices are best-effort unless the user chooses strict
  mode. Best-effort failure retries once with software encoding after cleaning
  the incomplete output. Strict mode reports a clear error and is opt-in.
- Distinguish encoder availability from successful initialization. FFmpeg may
  list `h264_nvenc` while the host lacks a usable driver/device. Use a
  bounded initialization probe and, if it fails, record the reason and fall
  back.
- Persist the actual encoder, preset, codec, and relevant arguments in the job
  record and expose them in status/history.
- Do not claim GPU encoding merely because decode or CUDA initialization is
  active. The reported encoder must be the actual selected FFmpeg encoder.

The initial output recommendation is H.264 in MP4 for broad Jellyfin client
compatibility, with a preset biased toward low CPU use when NVENC is usable and
an appropriately conservative software preset otherwise. Expose container,
video codec, quality (CRF or hardware quality), audio policy, and preset as
validated settings. Do not allow arbitrary FFmpeg command-line text in the UI.
The initial implementation transcodes audio to AAC and omits DVD bitmap
subtitles; subtitle handling requires a format-aware policy before it can be
enabled safely.

### Settings

Persist validated settings in SQLite, with defaults and a schema version:

- drive device and eject-on-success/eject-on-failure policy;
- Jellyfin Movies and Music paths, work path, minimum free-space reserve, and failed-job retention;
- output container, codec, quality, preset, audio/subtitle behavior;
- encoder policy, NVIDIA preference, strict/best-effort mode, and GPU device
  access status;
- metadata lookup enabled/disabled, selected provider, and credentials, if
  enabled. Lookup is disabled by default and can be enabled or configured later
  from the Settings page; no external lookup occurs before the user opts in.
- music destination path, Lidarr URL/API key/shared import directory, and
  independent opt-in MusicBrainz lookup setting.
- admin password/session configuration;
- log level and retention.

Changing paths or encoder settings during a job affects the next job only.
Validate paths, permissions, free space, and tool/device availability before
saving a setting that would make the service unable to run. Redact credentials
from API output and logs.

## 6. Database schema

SQLite uses foreign keys, WAL, a busy timeout, and versioned transactional
migrations. All timestamps are UTC ISO-8601. Avoid holding a database
transaction while MakeMKV or FFmpeg runs.

### `jobs`

- `id` (UUID/text primary key)
- `media_type` (`dvd` or `audio_cd`)
- `status` (checked enum: inspecting, ripping, resolving_title, converting,
  validating, publishing, completed, failed, cancelled, interrupted, ignored)
- `disc_fingerprint`, `disc_label`, `title`, `title_source`, `title_confidence`
- `source_path` (workdir-relative where possible), `output_path`
- `encoder`, `video_codec`, `container`, `quality`
- `started_at`, per-stage timestamps, `finished_at`, `duration_seconds`
- `input_bytes`, `output_bytes`, `failure_stage`, `error_code`, sanitized
  `error_message`
- `created_at`, `updated_at`

Add indexes for `(created_at)`, `(status, created_at)`, and active-job lookup.
Enforce at most one active job with a partial unique index over active statuses.

### `job_events`

- `id`, `job_id` foreign key, `at`, `stage`, `level`, `code`, bounded,
  sanitized `message`, optional JSON details.

This supports history and recovery without storing unbounded raw process output
in SQLite. Detailed rotating logs live on disk and are referenced by job ID.

### `settings`

- `key` primary key, validated JSON `value`, `updated_at`, `schema_version`.

Never store a plaintext admin password. Store a modern password hash and a
random session-signing secret with restrictive file/database permissions.
Never return MakeMKV credentials from settings endpoints.

### `schema_migrations`

- `version` primary key, `applied_at`.

### Derived statistics

Compute total/success/failure counts, averages, and daily chart buckets from
indexed job data. At this scale, materialized aggregate tables are unnecessary.
Define which statuses count as processed (completed, failed; not ignored or
cancelled) and how average conversion duration is calculated. Use UTC day
boundaries and let the UI format local time.

## 7. REST API and live updates

REST endpoints use typed request handling and explicit JSON errors. Route APIs
under `/api/v1`; keep liveness/readiness at `/api/health`.

| Method and path | Purpose |
|---|---|
| `GET /api/v1/status` | Current worker state, active job/stage/progress, selected encoder, drive status. |
| `GET /api/v1/dashboard` | Summary counts, average conversion time, and recent jobs. |
| `GET /api/v1/history?limit=` | Bounded recent job history. |
| `GET /api/v1/history/:id` | Job details and bounded event timeline. |
| `DELETE /api/v1/history/:id` | Remove a finished job and its events from SQLite; never deletes media files. |
| `POST /api/v1/jobs/:id/cancel` | Cancel a currently ripping/converting job without stopping disc monitoring or ejecting the disc. |
| `POST /api/v1/paths/check` | Check service-account access and create/remove a temporary probe file in configured folders. |
| `GET /api/v1/stats?range=7d\|30d` | Daily success/failure counts and duration series. |
| `GET /api/v1/settings` | Redacted effective settings and capability diagnostics. |
| `PUT /api/v1/settings` | Validate and persist settings; active jobs retain their snapshot. |
| `GET /api/v1/updates/status` | Installed version and last system-updater state. |
| `GET /api/v1/updates/check` | Check the newest stable, versioned GitHub tag on demand. |
| `POST /api/v1/updates/apply` | Queue a newer tagged version; refuse while a disc job is active. |
| `POST /api/v1/lidarr/test` | Verify the configured Lidarr URL and API key without returning credentials. |
| `GET /api/v1/encoders` | FFmpeg software/NVENC capability report. |
| `POST /api/v1/login` / `POST /api/v1/logout` | Configure a password-protected administrator session. |
| `GET /api/v1/events` | Authenticated SSE for job/status updates. |
| `GET /api/v1/system/events` | Dashboard-session SSE for sampled system metrics. |
| `GET /api/health` | Liveness/readiness without exposing secrets or filesystem details. |

SSE publishes current job `status` and `system.metrics`. Send keepalives, bound
client queues, and clean up subscriber state on disconnect. FFmpeg progress is
parsed from its machine-readable progress pipe, not human-readable stderr text.

### Authentication and network boundary

Honor the requested initial `admin` username and no-password setup, but treat it
as an explicit insecure bootstrap mode. The service binds to all IPv4 interfaces
by default for home-network access; clearly warn that anyone reaching port 8787
can administer it until a password is configured, and recommend limiting
access with the host firewall. Do not claim that LAN-only binding is
authentication. Password-enabled mode uses a
hashed password, short-lived HTTP-only SameSite cookies, session rotation, and
CSRF protection for state-changing requests. Provide logout and password-change
flows. Never log credentials or session tokens. Do not add public internet
access, multi-user roles, or third-party analytics.

## 8. Resource monitoring

Disc monitoring and the one-job worker are always available; CPU/GPU/RAM
sampling is not. Start a sampler only while at least one authenticated,
visible dashboard session is subscribed to system metrics. Prefer explicit
start/stop or visibility signals plus SSE lifecycle cleanup. Stop the sampler
after the last subscriber disconnects or becomes inactive, with a short grace
period for reconnects. A page viewing history/settings alone should not start
metrics sampling.

Collect at a modest interval (for example, 3–5 seconds):

- CPU utilization from `/proc/stat` deltas;
- memory from `/proc/meminfo`;
- filesystem free space from the configured work/output mounts;
- NVIDIA utilization from a bounded `nvidia-smi` query only when the GPU is
  configured and present.

If a metric is unsupported, return an explicit `unavailable` value and reason;
do not report zero as if measured. Cancel in-flight subprocesses on sampler
shutdown. Avoid collecting high-frequency metrics or persisting samples.

## 9. Process execution, errors, recovery, and cleanup

### Child-process rules

- Spawn fixed executable paths with argument arrays; never interpolate a shell
  command. Validate settings before constructing arguments.
- Capture bounded stdout/stderr tails, rotate per-job logs, redact secrets, and
  attach exit code/signal/timeout context to errors.
- Apply stage-specific timeouts and cancellation. On shutdown, stop accepting
  new jobs, persist the current stage, send graceful termination, then escalate
  after a bounded grace period.
- Verify every expected output exists, has plausible size, and can be probed
  before publication. A zero exit code alone is insufficient.

### Publication and cleanup

Create a collision-safe folder named after the selected movie title, with the
video file using the same name and configured extension (for example,
`Movies/Karate Kid/Karate Kid.mkv`). Write converted output to a hidden temporary
filename inside that folder, validate it, fsync as appropriate, then atomically
publish the file to its final safe name.
Handle collisions deterministically (never overwrite an existing movie).
Update SQLite around the publication boundary so recovery can reconcile a file
with a job if the process crashes between rename and commit. Jellyfin sees only
finished files, not partial encodes.

Always attempt work-directory cleanup in a `finally` path. On success, remove
all intermediates before marking the job complete and before ejecting when
configured. If cleanup fails, retain an explicit cleanup error and alert in the
UI/log; do not silently report a clean success. On failure, keep only bounded
diagnostic artifacts for configured retention, then remove them on startup and
periodically during normal service operation. This housekeeping is job-triggered
and startup-triggered, not a high-frequency background scan.

Eject policy should be separately configurable for success and failure, with
success-only as the safe default. Never eject while a process may still be
reading the disc. If eject fails, preserve the job outcome and surface the
eject failure separately.

### Crash recovery

At startup, find nonterminal jobs and reconcile database state, work directory,
temporary output, and final output. Mark a job interrupted with the last
durable stage and an actionable error. Do not automatically restart a rip or
overwrite a final file without a policy the operator explicitly approved.
Offer a safe retry action after checking that the same media is present (for
rip retry) or reusing verified intermediates where valid. The first release
should prefer explicit retry to complex automatic resume.

## 10. Logging, health, and observability

Use structured JSON application logs to stdout for journald and rotating
per-job logs under `/var/lib/autodisc/logs`. Support
debug/info/warn/error levels. Keep logs bounded by size/retention, sanitize
external process output, and never log credentials. Each log entry should
include timestamp, component, job ID when relevant, stage, and stable error
code. The dashboard should show actionable, sanitized errors; detailed logs
remain available to the administrator.

Health endpoints distinguish process liveness from readiness. Readiness reports
missing MakeMKV/FFmpeg, inaccessible configured drive/paths, migration errors,
or SQLite problems. Missing GPU support is a warning, not a readiness failure.
Do not expose detailed host information to unauthenticated callers.

## 11. Phase 2 — Architecture review: weaknesses and risks

| Risk or weakness | Consequence |
|---|---|
| GT 710 variants commonly lack NVENC | The preferred GPU path may be unavailable; software conversion can be CPU-heavy and slower. |
| udev event permissions and delivery vary | Insert events may be missed; validate the systemd service account and device configuration on the target host. |
| MakeMKV distribution/licensing and keys | Host installation and updates require an operator-supplied, lawful installation path and key handling. |
| DVD title data is poor/inconsistent | Fully automatic, correct movie naming is impossible without a catalog or user correction in some cases. |
| DVD reads can fail or take a long time | Scratched discs, drive errors, and MakeMKV hangs need timeouts, cancellation, and recovery rules. |
| Temporary disk demand is large | A full rip plus encode can exhaust disk space or interfere with Jellyfin if locations are poorly chosen. |
| Passwordless bootstrap mode | Anyone with network reachability can administer the appliance until a password is configured. |
| FFmpeg option differences | Encoder and subtitle/audio options vary by build, driver, and source streams; static capability claims are unsafe. |
| Crash at the publish/DB boundary | A final movie may exist while its job is not marked complete, or vice versa, without startup reconciliation. |
| One service process runs UI and worker | A process failure temporarily stops both; persistent job records and systemd restart/recovery are essential. |
| In-app updater needs privileged file replacement | Keep root authority in a fixed systemd path-triggered helper; never run downloaded scripts as root or grant the web service sudo. The helper independently verifies the latest stable repository tag, stages and builds source as the service account, snapshots SQLite while stopped, verifies startup, and retains application/database rollback until healthy. |
| Eject behavior is hardware-dependent | Some drives do not report tray/media changes consistently; never assume eject implies successful removal. |
| Jellyfin scanning is outside AutoDisc | A successful file move does not guarantee immediate library visibility unless Jellyfin's library monitoring works. |

## 12. Phase 3 — Recommended improvements and explicit trade-offs

1. Keep first release to one drive, one worker, and one systemd-managed service.
   Add multi-drive support only after the serial pipeline is proven.
2. Make GPU preference best-effort by default and software fallback mandatory.
   Show a startup capability report and actual per-job encoder; do not promise
   GT 710 hardware encoding.
3. Make metadata lookup optional and transparent. Expose its enable/disable
   switch, provider, and required credentials in the Settings page, with lookup
   disabled by default. Provide useful offline fallback naming and an edit path
   rather than blocking unattended operation.
4. Use event-driven udev monitoring and test it while running under the
   dedicated service account; add a low-frequency recovery fallback only if
   target-distribution tests prove event delivery unreliable.
5. Treat initial passwordless access as a visible, documented bootstrap
   compromise. A future secure-by-default release should require a password or
   setup token; changing that default now would conflict with the stated
   requirement.
6. Make cleanup, disk preflight, idempotent publication, and restart recovery
   release-blocking features, not later polish.
7. Snapshot relevant settings into each job so later settings changes do not
   make history inaccurate or change an active encode.
8. Keep metrics on-demand and ephemeral. Do not store resource histories in
   SQLite.
9. Deliver systemd health/status integration, backup/restore guidance for
   `/var/lib/autodisc`, and an upgrade/migration policy before production use.
10. Add hardware-in-the-loop acceptance tests on the target Lubuntu host;
    mocked tests cannot prove drive events, permissions, MakeMKV, NVENC, or
    actual eject behavior.

## 13. Phase 4 — Proposed project structure

```text
autodisc/
├── README.md
├── LICENSE
├── AUTODISC-ARCHITECTURE.md
├── package.json
├── package-lock.json
├── tsconfig.json
├── service/
│   └── autodisc.service
├── scripts/
│   └── install.sh
├── docs/
│   ├── architecture.md
│   ├── deployment-lubuntu.md
│   ├── gpu-and-encoder-support.md
│   ├── operations-and-recovery.md
│   └── security.md
├── src/
│   ├── main.ts
│   ├── config/
│   │   ├── defaults.ts
│   │   ├── schema.ts
│   │   └── paths.ts
│   ├── api/
│   │   ├── app.ts
│   │   ├── auth.ts
│   │   ├── errors.ts
│   │   ├── routes/
│   │   └── schemas/
│   ├── db/
│   │   ├── database.ts
│   │   ├── migrations/
│   │   └── repositories/
│   ├── domain/
│   │   ├── job.ts
│   │   ├── state-machine.ts
│   │   └── errors.ts
│   ├── worker/
│   │   ├── coordinator.ts
│   │   ├── recovery.ts
│   │   └── pipeline.ts
│   ├── adapters/
│   │   ├── udev-disc-monitor.ts
│   │   ├── makemkv.ts
│   │   ├── ffmpeg.ts
│   │   ├── encoder-resolver.ts
│   │   ├── metadata.ts
│   │   ├── filesystem.ts
│   │   └── eject.ts
│   ├── services/
│   │   ├── settings.ts
│   │   ├── history.ts
│   │   ├── title-resolver.ts
│   │   ├── publisher.ts
│   │   ├── cleanup.ts
│   │   └── resource-monitor.ts
│   ├── events/
│   │   └── event-hub.ts
│   └── web/
│       ├── public/
│       └── client/
├── test/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
├── package.json
├── tsconfig.json
└── <lockfile>
```

Names are provisional and should follow the selected package/test tooling.
Keep hardware and subprocess behavior behind typed adapters so tests can use
fakes without weakening production validation.

## 14. Phase 5 — Implementation roadmap and acceptance gates

### Milestone 0: Confirm deployment decisions

- Confirm drive path, Movies path, work path, expected free space, output
  container/codec/audio/subtitle defaults, and whether optional online metadata
  is acceptable.
- Confirm MakeMKV installation/key approach and the target Lubuntu release.
- Confirm how the appliance will be reached on the LAN and whether passwordless
  bootstrap is acceptable.

**Gate:** systemd service, host-device and filesystem permission model documented; no unresolved choice
blocks a working installation.

### Milestone 1: Build skeleton and durable domain

- Add package/build configuration, typed configuration validation, structured
  logging, SQLite connection, migrations, and job/settings/event repositories.
- Implement and test the serial job state machine and one-active-job invariant.

**Gate:** Unit tests cover legal/illegal transitions, transaction behavior, and
restart-safe job records.

### Milestone 2: Safe process and storage primitives

- Implement subprocess runner with timeouts, cancellation, bounded output, and
  structured errors.
- Implement disk/permission preflight, safe filename generation, collision
  handling, atomic publisher, and cleanup/reconciliation.

**Gate:** Integration tests simulate crashes around final rename and database
updates; no partial file is visible under a final movie name.

### Milestone 3: Drive detection and disc extraction

- Implement udev subscription, event debounce, drive-state inspection, media
  fingerprinting, audio CDDA recognition/extraction with cdparanoia,
  MusicBrainz lookup with local fallback, MakeMKV DVD info/rip adapters, and
  eject.
- Add a fake drive adapter for deterministic tests and a documented real-drive
  acceptance procedure.

**Gate:** Repeated events cannot start duplicate jobs; audio CDs produce
track-complete albums, data discs and empty drives are ignored; actual
target-host insert/remove/eject test passes.

### Milestone 4: FFmpeg conversion and GPU fallback

- Probe FFmpeg/version and encoder capabilities, test hardware initialization,
  implement auto/software/explicit policies, structured progress, output probe,
  and one software fallback retry.
- Snapshot and persist actual encoder/format/quality per job.

**Gate:** Tests cover absent FFmpeg, listed-but-unusable NVENC, no GPU device,
software fallback, conversion failure, and accurate reported encoder. Verify
GT 710 outcome on the target machine rather than relying on model-name guesses.

### Milestone 5: REST, authentication, and on-demand metrics

- Implement versioned APIs, validation, status/history/stats/settings,
  active-job cancellation, history deletion, SSE, password setup/change, and
  health checks.
- Add dashboard-session lifecycle and resource sampling that stops when the
  final metrics subscriber disconnects.

**Gate:** API tests cover errors/auth, and a sampler test proves zero metric
  collection with no dashboard subscriber and prompt shutdown after disconnect.

### Milestone 6: Lightweight UI

- Build dashboard, settings, history, charts, and clear encoder/error status
  using the static client.
- Keep accessible loading/empty/error states and avoid polling loops when SSE
  is connected.

**Gate:** Browser checks cover status transitions, settings validation,
password setup, history pagination, and dashboard metric subscription behavior.

### Milestone 7: systemd service, operations, and release

- Create a least-privilege systemd unit, installer/upgrade flow, persistent
  state and work directories, backup/restore instructions, logs/retention, and
  Lubuntu setup docs.
- Run dependency/build/test checks and end-to-end hardware acceptance on the
  target host.

**Gate:** From a clean host, follow docs to install; insert a video DVD and an
audio CD, verify DVD title policy/actual encoder and music album/track tags,
confirm finished outputs enter Jellyfin Movies or Music respectively, and
confirm work cleanup/eject. Repeat with unreadable media, a data disc, full
disk, absent GPU, and restart during each major stage.

### Release acceptance criteria

- Exactly one disc job can run at a time; non-video media is ignored.
- Audio CDs are ripped as individual lossless FLAC tracks, optionally tagged
  through MusicBrainz, then either atomically published to Jellyfin Music or
  imported through Lidarr after their filenames and tags are complete.
- A completed movie is probed, stored in a collision-safe title-named folder
  with a matching filename, and atomically published.
- Actual encoder is visible and persisted; no GPU/driver/NVENC issue prevents
  software fallback in auto mode.
- Temporary data is removed after success; failed artifacts are bounded and
  retained only per policy.
- Eject is attempted only after the drive is no longer in use and its result is
  visible.
- Job/history/statistics survive restart and interrupted work is reconciled
  without accidental overwrite or duplicate rip.
- Resource sampling runs only for active dashboard metric sessions.
- Default access behavior and passwordless risk are clear to the operator.
- Disk, CPU, memory, GPU, and conversion progress show unavailable/error states
  honestly rather than fabricated zero values.

## 15. Phase 6 — Implementation order

The Version 1.5 implementation follows dependency order: package/build metadata
and configuration; SQLite persistence; process, disc, and filesystem adapters;
serialized pipeline and recovery; REST/auth/SSE and on-demand metrics; static UI;
systemd installation; tests and operational documentation. Real drive, MakeMKV,
FFmpeg/NVENC, systemd-permission, eject, and restart acceptance still must run
on the target Lubuntu server. Versioned application updates are checked only
when requested from Settings and applied through the constrained systemd
updater, with service/database rollback on failed startup.

### Version 1.5 implementation boundary

Version 1.5 includes serial DVD and music-CD workflows: MakeMKV to FFmpeg for
DVDs and cdparanoia to FLAC for audio CDs. Movie files are published into
title-named folders. MusicBrainz lookup is optional and disabled by default;
optional Lidarr import organizes named audio tracks. The application includes
best-effort NVENC with software fallback, atomic output publication, temporary
file cleanup and startup reconciliation, udev monitoring, optional TMDB lookup,
password setup, history/statistics, dashboard-only resource sampling, active
job cancellation, and removal of finished history records without deleting
published media. Cancellation is available during ripping and encoding, before
the publication stage. The default web bind is `0.0.0.0:8787`; passwordless mode is
available to any client that can reach the service, so the host firewall must
limit it to the trusted network until a password is configured.
TV show processing, Radarr integration, and Sonarr integration are planned for
version 2.0 and are not part of this release. Retry controls, title editing,
configurable disk reserves and failed-artifact retention, per-job
rotating logs, and a full readiness report are not included in 1.5. Real
optical-drive, MakeMKV, FFmpeg/NVENC, systemd-permission, eject, and restart
acceptance must still be performed on the target Lubuntu server.
