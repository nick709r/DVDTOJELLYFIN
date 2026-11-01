# AutoDisc Release History

The full per-version change log. For an overview, see the [README](../README.md).

### Version 2.0.0

- **UI-only release.** Added a theme engine and a theme picker in the top bar, where the Light/Dark button used to be: Modern Light, Modern Dark, Windows 95 Classic and DOS Terminal. The choice is a per-browser preference (`localStorage`, key `autodisc-theme`); earlier `light`/`dark` values are migrated automatically.
- Themes change colours, borders, fonts, spacing, glyphs and chrome layout only (for example a title-bar header and bevelled panels in Windows 95, a text brand, `[ buttons ]` and double-line borders in DOS). Behaviour, workflows, actions, APIs, the database, the settings schema, ripping, metadata and review logic are unchanged and identical in every theme.
- Functional parity with 1.37.0 is enforced by `test/themes.test.js` against `test/fixtures/v1.37.0-ui-hooks.json`: every element id, form field name, page and navigation target from 1.37.0 must still exist, and the theme picker is the only new element.
- Adding a theme: add an entry in `web/themes.js` and a `:root[data-theme="…"]` block in `web/themes.css`.

### Version 1.37.0

- Movie (TMDB), TV (TVDB, TMDB TV) and music CD (MusicBrainz) metadata are now first-class in Settings → Metadata & Identification: one provider list shows Enabled/Disabled, Configured/Not configured, API key status, media type, request/match/skip/failure counts, last failure and the reason a provider is disabled.
- The separate movie and music integration cards were folded into that section. Setting names, lookup behaviour and APIs are unchanged.
- Metadata lookups are logged with media type, provider, query, result count, selection and failure reason; skipped lookups are recorded separately (migration 29).

### Version 1.36.1

- Made the dashboard and settings media-type agnostic: "TV Metadata" is now "Metadata Providers", "TV statistics" is now "Media Statistics", and "TV Matching & Analysis" is now "Identification & Matching".
- Added a Media Identification dashboard card (movies, TV episodes, Music CDs; automatic, review-required and manual matches), a Provider usage card (requests, matches, failures, average lookup time) and a Metadata & Identification settings section.
- Added read-only `GET /api/v1/metadata/usage` and `GET /api/v1/identification/stats` and a `metadata_provider_usage` table (migration 28). Existing APIs and settings are unchanged.

### Version 1.36.0

- Added a hard upper limit to MakeMKV disc discovery, `makemkvDiscoveryAbsoluteTimeoutMs` (default 900000 ms). Discovery now ends when MakeMKV is silent for `makemkvDiscoveryTimeoutMs` or when the absolute limit elapses, so continuous output can no longer keep it running forever. Timeout kills are logged as "inactivity" or "absolute".

### Version 1.35.0

- MakeMKV disc discovery no longer uses a fixed 2-minute limit. It is terminated only after the configurable `makemkvDiscoveryTimeoutMs` setting (default 300000 ms) passes with no output, so large, dual-layer, CSS-protected and damaged discs that are still being analysed can finish.
- Added `makemkv` logging for command start (command, drive, timeout), completion (elapsed time, exit code) and timeout kills (elapsed time, timeout, last-output age).

### Version 1.34.1

- Fixed a TypeScript build error (TS2741) by populating the required `source` field on unified review items created for staged TV discs.

### Version 1.34.0

- Unified Movie, TV and TV-plan reviews behind a single `MediaReviewItem` model, queue and search workflow, with media-specific behaviour isolated in adapters.
- Movie and TV reviews now complete through one endpoint, `POST /api/v1/review/items/:id/complete`; the legacy TV matching and review-job continue endpoints are compatibility wrappers.
- Fixed movie metadata searches silently returning no results when the movie provider was disabled or had no API key, and added logging for provider requests, responses, filtering and empty results.
- Fixed concurrent completions starting processing twice, completed TV tasks reporting "started", movie reviews resuming without a title, blank titles overriding a selected candidate, and invalid candidate ids being ignored. See [Unified media review](./docs/UNIFIED-REVIEW.md).

### Version 1.33.0

- Use the filesystem volume name consistently for movie lookup and fallback naming, and hold uncertain identifications for candidate review and explicit title confirmation.
- Add a configurable minimum movie-match confidence and prevent generated unknown titles from publishing without explicit confirmation.

### Version 1.32.0

- Require movie or TV structure evidence before TV metadata matching, and log separate movie/TV confidence with classification evidence.

### Version 1.31.0

- Generated TV episode candidates from imported episode continuity and confident disc position before runtime ranking; sequential fallback now uses the earliest unimported canonical episodes.

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

