# AutoDisc

**An intelligent optical media ingestion platform that automates the identification, organisation, processing and publishing of physical media collections.**

AutoDisc watches your optical drive, works out what you have inserted, explains how it reached that conclusion, and publishes the result to the library structure you choose: for Jellyfin, Sonarr, Radarr, Lidarr, or any custom layout. When it is unsure, it does not guess. It asks you through the Review Centre.

Run it as a web dashboard for hands-on control, or as a headless Linux service for unattended operation.

---

## Contents

- [What Is AutoDisc?](#what-is-autodisc)
- [Key Features](#key-features)
- [How It Works](#how-it-works)
- [Media Support](#media-support)
- [Automation Modes](#automation-modes)
- [Review Centre](#review-centre)
- [TV Matching](#tv-matching)
- [Destination Profiles](#destination-profiles)
- [Explainable Classification](#explainable-classification)
- [Disc Fingerprinting](#disc-fingerprinting)
- [Disc Diagnostics](#disc-diagnostics)
- [Architecture Overview](#architecture-overview)
- [Getting Started](#getting-started)
- [Screenshots](#screenshots)
- [Roadmap](#roadmap)
- [Why AutoDisc?](#why-autodisc)
- [Contributing](#contributing)
- [Disclaimer](#disclaimer)

---

## What Is AutoDisc?

AutoDisc is a platform for the **automatic ingestion and organisation of optical media**. Insert a disc and AutoDisc detects it, analyses its structure, classifies it, looks up metadata, routes it through the correct workflow and publishes the finished files to your library.

**Supported media today**

| Media | Workflow |
| --- | --- |
| DVD Movies | Detect, classify, identify, rip, encode, publish |
| DVD TV Series | Episodic analysis, staging, series and episode mapping, publish |
| Audio CDs | Rip to tagged FLAC, MusicBrainz lookup, publish |

**Designed for extension**

- Blu-ray workflows
- Archival and preservation workflows
- Additional metadata and media providers

AutoDisc is built on a provider and workflow model, so new media types and metadata sources plug into the same detection, review and publishing pipeline.

> AutoDisc is **not tied to any media server**. Jellyfin, Sonarr-compatible, Radarr-compatible and custom folder layouts are all supported output targets.

---

## Key Features

- **Automatic disc detection**: udev-driven insertion events with a periodic presence check and retry/backoff for drives that are slow to become readable.
- **Movie classification**: separates feature films from other DVD content.
- **TV classification**: episodic structure and runtime analysis, with unidentified discs ripped to a TV staging area rather than published as movies.
- **TV Disc Review**: identify staged series, review tracks with video previews, save episode matches, and resume publishing without reinserting or re-ripping the disc.
- **Audio CD processing**: lossless FLAC ripping with tagging and MusicBrainz lookup.
- **Disc diagnostics**: a live view of detection, classification, metadata and processing.
- **Explainable decisions**: confidence scores with per-criterion evidence.
- **Review Centre**: a single place to resolve failed jobs, unknown media and metadata conflicts.
- **Media-type overrides**: correct a disc to Movie, TV Series, Music or Data Disc; automatic detection remains visible and every correction records the administrator, time and optional reason.
- **Destination profiles**: named output profiles with per-media routing.
- **Automated workflows**: Regular Auto, Full Auto and Review-Based modes.
- **Fingerprint tracking**: recognises discs it has seen and reuses prior decisions.
- **Metadata lookup**: TMDB, TVDB, IMDb (via TMDB) and MusicBrainz, with caching and provider fallback.
- **Manual recovery tools**: override media types, set series and episode mappings, and enter metadata by hand.
- **Multi-platform output**: Jellyfin, Sonarr-compatible, Radarr-compatible, Lidarr and generic folder structures.

---

## How It Works

```text
 Disc inserted
      │
      ▼
 ┌───────────┐   ┌──────────┐   ┌────────────────┐   ┌──────────┐
 │ Detection │──▶│ Analysis │──▶│ Classification │──▶│ Metadata │
 └───────────┘   └──────────┘   └────────────────┘   └────┬─────┘
                                                          │
                                       confident?         ▼
                                   ┌─────── yes ───┐  ┌────────┐
                                   │               │  │ Review │◀── no / failure
                                   ▼               │  │ Centre │
                             ┌────────────┐        │  └───┬────┘
                             │ Processing │◀───────┴──────┘  (approved / corrected)
                             └─────┬──────┘
                                   ▼
                             ┌────────────┐
                             │ Publishing │──▶ Movies / TV / Music destinations
                             └────────────┘
```

1. **Detection**: the drive reports media and AutoDisc inspects it.
2. **Analysis**: titles, runtimes, track structure and disc labels are gathered.
3. **Classification**: the disc is identified as a movie, a TV series or music, with a confidence score.
4. **Metadata**: providers supply titles, years, series, episodes, albums and artwork.
5. **Review, if needed**: uncertain, conflicting or failed results go to the Review Centre. Unidentified TV discs continue ripping into the TV staging area and create a TV Matching task.
6. **Processing**: ripping, encoding or extraction, depending on the media type. Staged TV content waits for identification and episode mapping.
7. **Publishing**: finished media is placed in the destination profile's folder structure.

---

## Media Support

### Movies

- Automatic detection of video DVDs and identification of the main feature.
- DVD ripping via MakeMKV and conversion via FFmpeg, with hardware encoder detection and software fallback.
- Metadata and artwork lookup, NFO generation and safe naming templates.
- Output such as `Movies/Title (Year)/Title (Year).mkv`, adjustable per destination profile.

### TV Series

TV discs are treated as a first-class workflow, not an afterthought.

- **Episodic detection**: multi-title discs with episode-shaped content are recognised as likely TV.
- **Runtime analysis**: title durations are compared to find consistent episode lengths and to separate extras from episodes.
- **Season workflows**: confirmed episodes are published into series and season folders (for example `Series/Season 01/…`).
- **Disc-centric review**: every TV disc is fully ripped to protected staging before review; automatic suggestions never publish without user confirmation.
- **Identify and continue**: search by title or TVDB, TMDB or IMDb ID; assign a series and season; select episodes with searchable dropdowns and preview tracks; publish without reinsertion or re-ripping.
- **Partial matches**: save completed mappings while leaving other tracks staged for later. Fully matched discs resume publishing automatically.
- **Staging safety**: unmatched content and interrupted staging files are never automatically deleted. Explicitly delete unmatched tracks or remove the disc from review when ready.
- **Fingerprint mapping**: a confirmed disc-to-series and track-to-episode mapping is stored against the disc fingerprint for reuse.

Metadata comes from TVDB and TMDB, with configurable provider preference, fallback, health-aware failover and caching. Series can also be recovered by direct TVDB, TMDB or IMDb ID.

> Automatic episode suggestions never publish by themselves. Publication requires an explicitly confirmed mapping. Unidentified discs can be recovered from the TV Matching queue using their staged content.

### Music

- Audio CDs are ripped with cdparanoia into **numbered, tagged FLAC** tracks.
- MusicBrainz lookup (optional) supplies artist, album, year and track titles.
- If no match is found, the job pauses with the disc in the drive and asks for a release ID or manual metadata. It resumes as soon as you submit.
- Output as `Music/Artist/Album`, with collision-safe handling of existing albums.
- Optional Lidarr hand-off for library import and organisation.

---

## Automation Modes

Choose how much autonomy AutoDisc has. Each output profile has its own mode.

| Mode | Behaviour | Good for |
| --- | --- | --- |
| **Regular Auto** (default) | Processes confident results automatically and sends uncertain ones to the Review Centre. | Everyday use |
| **Full Auto** | Keeps going. Failures are recorded in Review and AutoDisc tries to eject the disc so the drive can continue. | Working through a stack of discs unattended |
| **Review-Based** | Every detected disc is queued for your approval before any processing starts. | Careful curation, or testing new setups |

**Examples**

- *Regular Auto*: a clearly identified movie DVD is ripped and published. A disc that looks like TV but cannot be mapped is ripped to staging and queued for identification.
- *Full Auto*: you load a box set overnight. Discs that fail to read are logged to Review and ejected, and the rest keep going. You fix the exceptions in the morning.
- *Review-Based*: each inserted disc appears as a pending item. You check the classification, correct it if needed, then approve processing.

---

## Review Centre

The Review Centre is where AutoDisc's automation hands control back to you, and where nothing is silently lost.

It collects:

- **Failed jobs**: disc read errors, processing failures, destination folder or permission problems
- **Unknown media**: discs that could not be confidently identified
- **Unknown TV series**: TV-shaped discs without a confirmed series or episode mapping
- **Metadata conflicts**: providers disagree, or no usable result was found
- **Classification overrides**: change the media type with a structured reason and notes
- **Recovery actions**: retry where safe, set provider IDs, map tracks to episodes, enter metadata manually, fix folders and retry

Every manual correction is recorded with the administrator and time. The original detection is never overwritten, and an append-only audit trail with text and JSON export supports later analysis.
Unknown TV discs are also listed here with their workflow state and confidence.
Choose **Identify** to search series candidates, select a series and season,
optionally add disc information, preview provider metadata, and confirm. AutoDisc
then presents the staged tracks for review. Automatic suggestions remain
unconfirmed until saved. Partially matched discs remain in Review Centre with
their saved mappings; fully matched discs resume publishing automatically.

---

## TV Matching

All TV discs are fully ripped into protected staging before review; even
high-confidence suggestions do not publish automatically. **TV Disc Review**
shows series and season information, cover art and overview when available,
confidence, episode counts, and searchable episode selectors for staged tracks.
Track previews provide a short video clip, thumbnail strip, runtime, and
resolution.

Saving progress immediately persists confirmed mappings. Partially matched
discs remain visible with unmatched tracks and can be revisited after a restart.
When every remaining track is matched, AutoDisc automatically resumes
processing and publishing. You can instead explicitly delete unmatched tracks
to publish saved matches, or remove the whole disc from review. Staged content
is never automatically deleted; the disc does not need to be reinserted or
re-ripped.

An override is stored with the disc fingerprint, so it survives restarts,
rescans and recovery. Publishing continues to use the effective manual
classification; unsupported media are held rather than routed through the
wrong encoder. History and diagnostics show both automatic and manual values.

When series, season and disc are confidently identified, provider DVD order
(including TVDB disc ordering when available) assigns tracks without runtime
ambiguity checks. If provider disc order is unavailable or incomplete, AutoDisc
falls back to sequential episode ordering after excluding extras and confirmed
duplicates. Assignment reports record whether provider order, sequential order
or runtime matching was used. Volume labels and disc titles are also parsed for
series, season and disc hints (including compact forms such as `S03D02`); these
hints are confidence evidence and are weighed against completed-disc history.
The TV review card shows the parsed label suggestion and previously completed
discs for the same season.

### TV staging and storage paths

**Settings → Storage & Output** shows the Work Directory, TV Staging Directory,
Review Directory, Cache Directory and active publishing directories. Leave the
TV Staging Directory blank to preserve the existing default derived from the
Work Directory (`<work>/tv-staging/unidentified`), or set a separate absolute
path. The same setting can be supplied on first start with `TV_STAGING_DIR`.
The Review Directory is `<work>/reviews`; metadata cache entries are stored in
SQLite, so the displayed Cache Directory is the parent of `DATABASE_PATH`.

The path validation panel reports access problems and overlaps with active
publishing directories. Diagnostics shows the resolved Jellyfin, Sonarr,
Radarr and Custom paths. If TV staging overlaps a library, the error includes
both paths and directs you back to Storage & Output. Use **Move TV staging to
recommended location** to select and prepare a non-overlapping directory.
Changing the staging location is blocked while jobs or staged TV tasks are
active, protecting files and recovery state.

---

## Destination Profiles

Destination profiles control **where and how** finished media is published. AutoDisc is not tied to a particular media server.

- **Multiple profiles**: create named profiles and choose which one is active.
- **Media-specific destinations**: separate routes for movies, TV and music.
- **Jellyfin-compatible structures**: movie, season and music folder layouts that Jellyfin scans natively.
- **Sonarr-compatible structures**: TV layouts for Sonarr-managed libraries.
- **Radarr-compatible structures**: movie layouts for Radarr-managed libraries.
- **Lidarr**: staging and import hand-off for music.
- **Custom folder structures**: generic folder output for any other tool or workflow.
- **Category overrides**: route a specific category to a different destination than the profile default.
- **Output previews**: see the resulting path before anything is written.

Profiles also carry their automation mode and only need the destinations their selected routes use. See [Output Destination Profiles](./docs/OUTPUT-DESTINATION-PROFILES.md) for routes, migrations and details.

---

## Explainable Classification

AutoDisc shows its working. Each classification includes a confidence score and per-criterion evidence, stored in job history and logs.

**Why was this identified as TV?**

```text
Classification: TV Series          Confidence: 87%
  ✔ 4–6 titles of similar runtime (41–44 min)
  ✔ Runtime variance within episode tolerance
  ✔ Disc label matches a series pattern ("SHOW_S02_D1")
  ✔ No single dominant feature-length title
  ✖ Series not yet confirmed by metadata   → sent to Review
```

**Why was this identified as a movie?**

```text
Classification: Movie              Confidence: 94%
  ✔ One dominant title (1h 52m)
  ✔ Remaining titles are short, extras-shaped content
  ✔ Disc label resolves to a single film via metadata
  ✖ No episodic runtime pattern found
```

*Illustrative output; exact criteria and wording vary by release.*

Low confidence never turns into a silent guess. Uncertain, TV-shaped discs are held for analysis and review instead of being published as movies.

---

## Disc Fingerprinting

Each disc gets a **signature** derived from its structure. AutoDisc uses it to:

- **Identify** a disc it has seen before and avoid processing the same disc twice
- **Reuse prior mappings**: media-type overrides, series choices and track-to-episode mappings persist against the fingerprint
- **Support multi-disc sets**, where earlier decisions inform later discs
- **Enable future archival use cases**: a stable identity for each physical disc, such as provenance records and verification

---

## Disc Diagnostics

The Disc Diagnostics page is a live view of what AutoDisc is doing and why:

- **Detection information**: drive state, source providers tried, disc structure
- **Classification reasoning**: scorecards and per-criterion results
- **Metadata attempts**: providers queried, fallbacks, cache use and outcomes
- **Processing stages**: a streamed event timeline and job logs
- **Failure analysis**: why a disc went back to waiting, returned no titles, or failed

It turns "nothing happened" into an answer.

---

## Architecture Overview

```text
┌──────────────────────────────────────────────────────────┐
│                  Frontend (web dashboard)                │
│  Dashboard · Review Centre · Diagnostics · Settings      │
└───────────────────────────┬──────────────────────────────┘
                            │ API + live events
┌───────────────────────────▼──────────────────────────────┐
│                  Backend (job coordinator)               │
│       SQLite storage · auth · settings · history         │
├───────────┬────────────────┬───────────┬────────┬────────┤
│ Detection │ Classification │ Metadata  │ Review │Publishing│
│ drives &  │ movie / TV /   │ TMDB TVDB │ queue, │ destination│
│ fingerprint│ music + scores│ MusicBrainz│ audit │ profiles │
└───────────┴────────────────┴───────────┴────────┴────────┘
        MakeMKV · FFmpeg · cdparanoia · udev (external tools)
```

- **Frontend**: a browser dashboard with live job progress.
- **Backend**: a Node.js service (TypeScript) that runs one job at a time, backed by SQLite.
- **Detection**: udev events, presence checks and fingerprinting.
- **Classification**: explainable scoring for movie, TV and music.
- **Metadata**: pluggable providers with caching and fallback.
- **Review**: queue, recovery actions and audit trail.
- **Publishing**: destination profiles, naming templates, NFO and artwork.

More detail: [Version 2 architecture](./docs/V2-ARCHITECTURE.md).

---

## Getting Started

AutoDisc targets Linux (Ubuntu, Debian and Lubuntu are tested) and runs as a systemd service.

```sh
sudo apt-get update && sudo apt-get install -y curl ca-certificates && \
  curl --fail --silent --show-error --location https://github.com/nick709r/DVDTOJELLYFIN/archive/refs/heads/main.tar.gz --output autodisc.tar.gz && \
  tar xzf autodisc.tar.gz && cd DVDTOJELLYFIN-main && sudo ./scripts/install.sh
```

The installer sets up Node.js 22+, FFmpeg, cdparanoia, cd-discid and helper tools, builds AutoDisc, and enables the `autodisc.service` unit. It is safe to rerun for updates. It also configures library roots for group inheritance and adds AutoDisc to their groups. AutoDisc publishes directories with `775` permissions and files with `664`; world-write access is never enabled. For a custom destination profile, add the `autodisc` service account to the library group and restart the service so new content inherits that group.

1. **Optional: install MakeMKV** to enable DVD ripping. It is separately licensed and is not bundled. Audio CD ripping works without it.
2. **Open the dashboard** at `http://<server-ip>:8787`. If it is bound only locally, use an SSH tunnel: `ssh -L 8787:127.0.0.1:8787 user@server`.
3. **Complete first-run setup** by creating the administrator account. Disc processing stays disabled until then.
4. **Create a destination profile** in Settings and choose the routes and automation mode.
5. **Insert a disc.**

Do not expose the dashboard port to the internet.

**Useful commands**

```sh
sudo systemctl status autodisc.service
sudo journalctl -u autodisc.service -f
```

**Further documentation**

- [Output Destination Profiles](./docs/OUTPUT-DESTINATION-PROFILES.md)
- [Library Metadata & Organization](./docs/METADATA-LIBRARY-ORGANIZATION.md)
- [TV workflow integration](./docs/TV-WORKFLOW-INTEGRATION.md)
- [TV manual recovery guide](./docs/TV-MANUAL-RECOVERY.md)
- [Version 2 architecture](./docs/V2-ARCHITECTURE.md)
- [Roadmap](./docs/ROADMAP.md)

---

## Screenshots

> Screenshots will be added as the interface stabilises.

| Area | Preview |
| --- | --- |
| Dashboard | ![AutoDisc dashboard](./docs/screenshots/dashboard.png) |
| Review Centre | _Coming soon_ |
| Destination Profiles | _Coming soon_ |
| Explainable Classification | _Coming soon_ |
| Disc Diagnostics | _Coming soon_ |
| TV Series Mapping | _Coming soon_ |
| Music / Audio CD | _Coming soon_ |

---

## Release History

### Version 1.30.0

- Corrected TV continuity to prioritize the earliest known missing canonical episodes and added imported, highest, missing, and expected-continuation diagnostics.

### Version 1.29.0

- Added imported-episode continuity evidence to TV disc-position confidence scoring, including expected next episodes, missing episode ranges, overlap penalties, and duplicate-disc explanations.

### Version 1.28.0

- Added structured positive, negative, and neutral TV disc-matching evidence with score breakdowns and alternative-candidate explanations.

### Version 1.27.0

- Standardized published-media permissions across movie, TV, music and review workflows, with destination-group inheritance and no world-write access.

### Version 1.26.3

- Confirmed the reported TypeScript build errors are resolved and `npm run build` completes successfully.

### Version 1.26.2

- Fixed TypeScript build errors in review processing, storage lifecycle, process tracking, and the DVD TV workflow.

### Version 1.26.1

- Fixed fresh installs by copying build-time scripts into `/opt/autodisc` before running the build.

### Version 1.26.0

- Clean generated JavaScript before builds and prevent TypeScript from emitting output when compilation reports errors.

### Version 1.25.0

- Fixed the Review Queue cleanup service method scope so TypeScript can parse the class.

### Version 1.24.0

- Fixed the Linux updater helper shell parsing failure that prevented updates from reaching download and installation.
- Added structured update diagnostics, installed-file checks, post-restart version verification, and clearer UI status reporting.

### Version 1.23.0

- Added optical-drive capability diagnostics and more resilient cross-platform ejection with fallback methods.
- Fixed TV match continuation so jobs resume at their current processing stage instead of restarting ripping.
- Added ownership-validated Review Queue deletion and a Storage Manager with safe cleanup, recovery estimates, and scheduled maintenance.

### Version 1.22.0

- Consolidated primary navigation around the media workflow and unified review queue.
- Added Dashboard attention summaries and quick access to unmatched TV content and items requiring review.
- Improved review and diagnostics refresh reliability, including protection against stale concurrent responses.
- Improved Dashboard review counts and synchronized updates across open clients.

### Version 1.21.0

- Assign TV episodes from provider DVD disc ordering when available, with a sequential disc-order fallback when provider mapping is missing or incomplete.
- Avoid runtime-based ambiguity for confidently identified discs and require structural evidence before classifying duplicate tracks.
- Record the assignment method and preserve provider mapping confidence in processing plans.

### Version 1.20.0

- Redesigned TV Disc Review around staged discs, with searchable episode matching, match progress, and video previews.
- Keep partially matched discs and unmatched tracks in staging until the user completes or explicitly removes them.
- Automatically resume publishing when every retained track has a confirmed episode mapping.
- Preserve TV matching state and mappings through application recovery and database upgrades.

---

## Roadmap

**Near-term**

- [ ] Improved TV identification, validated against a broad set of real discs
- [ ] Disc-to-series mapping
- [ ] Enhanced metadata
- [ ] Blu-ray support
- [ ] Expanded review workflows

**Long-term**

- [ ] **Archivist Mode**
- [ ] Collection management
- [ ] Large-scale ingestion, including multi-drive scheduling
- [ ] Preservation workflows
- [ ] Advanced media identification

Roadmap items are goals and not commitments. See [docs/ROADMAP.md](./docs/ROADMAP.md) for implementation status.

---

## Why AutoDisc?

Ripping tools extract data from a disc. They do not decide what the disc is, where it belongs, what it should be called or what to do when something goes wrong.

AutoDisc is more than a ripper. It is **an intelligent optical media ingestion platform designed to automate the organisation, identification, processing and publishing of physical media collections.**

- It **explains** its decisions instead of hiding them.
- It **asks** when unsure instead of guessing.
- It **remembers** the discs it has seen.
- It **adapts** to your library instead of requiring a specific media server.

---

## Contributing

Contributions are welcome, whether code, documentation, testing against real discs, or ideas.

1. **Open an issue** to discuss bugs, features or larger changes first.
2. **Fork and branch** from `main` with a descriptive branch name.
3. **Make focused changes** with tests where practical, and keep documentation up to date.
4. **Open a pull request** describing what changed and why.

Particularly valuable: reports of misclassified discs (a disc label, title runtimes and the diagnostics output are very helpful), new metadata providers and destination layouts, and documentation improvements. Never include licence keys or personal API keys in issues or pull requests.

---

## Disclaimer

AutoDisc is an independent project. It is not affiliated with or endorsed by Jellyfin, Sonarr, Radarr, Lidarr, MakeMKV, TMDB, TVDB, MusicBrainz or any other third party named here. All trademarks belong to their owners.

- **Content ownership**: use AutoDisc only with media you own or are otherwise legally entitled to copy and process. You are responsible for complying with the copyright and licensing laws that apply where you live.
- **No copy-protection circumvention**: AutoDisc does not bypass copy protection, and it does not provide or distribute copyrighted content.
- **Third-party software**: MakeMKV is separately licensed and is not bundled or redistributed. Metadata and artwork are subject to each provider's terms.
- **No warranty**: the software is provided "as is". Back up your data and test on your own hardware before running unattended.
