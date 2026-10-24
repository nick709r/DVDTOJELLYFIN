# TV Metadata Recovery and Manual Episode Processing

AutoDisc can persist a manual physical-disc/media classification, series
metadata, and track-to-episode mappings by disc fingerprint. These user values
take precedence over automatic classification and episode suggestions. The
detected values remain stored and are never rewritten by an override.

## Identify Disc (series and season; optional disc number)

TV identification no longer depends on the disc label. `TvWorkflowService.prepare` works through, in order: user-saved identification, saved fingerprint mapping, optical volume label, filesystem volume name, MakeMKV disc name, DVD metadata, TVDB search, TMDB search, runtime/structure analysis and episode-count matching. Names are normalized (`fresh-off-the-boat`, `Fresh_Off_The_Boat` and `FRESH OFF THE BOAT` all become `Fresh Off The Boat`; season/disc markers are stripped) and several search variants are tried. An empty label does not stop the pipeline.

If automatic matching fails, use **Identify Disc** in Review Centre or Disc Diagnostics, or select **Identify** on an unknown-TV card. Search by title, `tvdb:ID`, `tmdb:ID` or an IMDb ID (`tt…`), compare possible matches, choose a series and season, and optionally enter the disc number and name. The confirmation records provider metadata and artwork references, then resumes analysis against the staged files. Reliable episode matches are generated automatically; uncertain tracks remain staged for review rather than being published without confirmation.

Unknown TV discs are visible in Review Centre with an identification-required
status, the detection confidence when available, current task state and a
series-search action. A task in `awaiting-identification` remains durable in
SQLite and its extracted files remain protected in staging across restart and
crash recovery. Reopening the task resumes identification without another rip.

Identification diagnostics (volume label, filesystem name, fingerprint, queries, per-provider matches, failures, candidates, the 10 pipeline steps) appear in the review card and in Disc Diagnostics.

API: `POST /api/v1/tv/identify/search`, `GET|PUT /api/v1/tv/plans/:id/identification`, `PUT /api/v1/discs/:fingerprint/identification`.

## Review workflow

1. Open **Review Centre** for a TV plan, or **Disc Diagnostics** for a recently
   detected disc that AutoDisc classified as a movie.
2. Select the final physical-disc and media types. The DVD workflow only
   processes DVD media; unsupported physical or media types remain held for
   review rather than being routed to the DVD encoder.
3. Enter a series name, season, and provider ID, or choose **Manual Entry**.
   Lookup/import supports TVDB and TMDB IDs. IMDb IDs are resolved through the
   configured TMDB TV provider. AniDB direct lookup is not implemented; use
   Manual Entry to proceed without it.
4. Confirm the returned series, import season episodes when available, and
   map each episode-bearing disc track using the dropdowns or drag-and-drop.
   Manual season, episode, and title values are accepted when lookup fails.
5. Save the metadata and mappings. Optional episode air dates and notes are
   retained with each mapping. A subsequent detection of the same disc
   uses the persisted decisions. If the disc is still inserted, clearing the
   processed-disc latch requests another scan.

Automatic TV matches remain suggestions. TV files are published only when
explicit recovery metadata and track mappings have been saved. The processor
requires mappings for each non-bonus title at least ten minutes long, rejects
unknown track IDs and cross-season multi-episode files, and never overwrites an
existing episode output. Output paths follow:

```text
TV/<Series>/Season NN/<Series> - SnnEnn - <Episode Title>.<mkv|mp4>
```

Multiple episodes assigned to one title are written as a Jellyfin-style
multi-episode filename. If a disc processing attempt fails, outputs created by
that attempt are removed when possible; cleanup failures are recorded in the
job error. Existing output files are never deleted or replaced.

## Provider support

| Provider | Series lookup | Season episode import | Credentials |
|---|---|---|---|
| TVDB | Direct TVDB ID | Direct series/season lookup | Configured TVDB API key |
| TMDB | Direct TMDB TV ID | Direct series/season lookup | Configured TMDB TV API key |
| IMDb | IMDb TV ID via TMDB find | Resolved through TMDB TV ID | Configured TMDB TV API key |
| Manual Entry | User-supplied series name and ID | Manual entry | None |
| AniDB | Not implemented | Not implemented | Not applicable |

Provider operations are behind the TV metadata provider registry. Unsupported
provider requests return an explicit API error; they are not reported as
successful imports. Metadata lookup is optional and users can continue with
manual series and episode values when a provider is unavailable.

## Persistence and precedence

Migration 19 adds the `disc_recovery` table keyed by the normalized disc
fingerprint. It stores detected and final disc/media types, per-type override
flags, detected confidence, provider and provider ID, series name, season
number, episode mappings (including optional air dates and notes), notes, and
the update timestamp. Migration 20 adds imported metadata and validated
artwork references to that recovery record. Existing databases receive the
new columns without rewriting jobs, TV plans, or classification audit history.
Migration 26 adds the append-only `media_type_override_audit` table. Manual
changes retain the prior and new classifications, disc fingerprint, optional
job ID, administrator username, timestamp and optional reason. Updating the
recovery record and appending its audit row are one SQLite transaction.

Supported manual media classifications include Movie (`movie`), TV Series
(`tv_series`), Music (`music_album`) and Data Disc (`data_disc`). Detected
classification is retained as the automatic value. A manual value takes
precedence on later scans; a Data Disc or another unsupported DVD workflow
classification is held for review instead of being sent to the movie publisher.

At processing time, a manual final media classification is checked before the
automatic TV heuristic. Saved episode mappings are used directly and do not
pass through automatic matching. If there is no manual mapping, automatic
suggestions still require review and are never silently used for output.

## TV staging storage configuration

In **Settings → Storage & Output**, the TV Staging Directory can be set
explicitly. Leaving it blank keeps the backwards-compatible location derived
from Work Directory: `<work>/tv-staging/unidentified`. First-start
installations may also set `TV_STAGING_DIR`. The Review Directory is derived as
`<work>/reviews`; metadata cache entries are stored in the SQLite database,
and the Cache Directory display shows that database's parent directory.

The validation panel compares the resolved staging path with the active
Jellyfin, Sonarr, Radarr or Custom publishing directories and checks whether
the directory or its nearest existing parent is writable. The Disc Diagnostics
page displays all resolved storage and output paths. When a collision is
reported, the error names both paths and points to Storage & Output.

**Move TV staging to recommended location** chooses a path outside the active
publishing directories, creates it if necessary and saves it as the explicit
TV staging directory. For safety, the location cannot be changed while a job
is active or staged TV tasks remain. Existing installations with no
`TV_STAGING_DIR` setting continue using the historical work-directory-derived
path. Staged files and their matching-task records remain restart-safe.

## API

These authenticated routes expose the recovery workflow:

- `GET /api/v1/discs/recovery/:fingerprint` reads a disc recovery record.
- `PUT /api/v1/discs/recovery/:fingerprint` saves disc/media classification,
  provider selection, series/season metadata, mappings, and notes. Include
  optional `mediaTypeReason` (up to 500 characters) to annotate a manual
  classification change.
- The recovery GET response includes `mediaTypeAudit`, newest first, with the
  original/new classification, username, timestamp, optional reason and job ID.
- `GET /api/v1/discs/overridden?limit=100` lists records with a classification
  override.
- `GET /api/v1/tv/plans/:id/recovery` reads recovery data for a TV review plan.
- `PUT /api/v1/tv/plans/:id/recovery` saves classification, series metadata,
  and mappings, and accepts the same optional `mediaTypeReason`. A mapping has the shape
  `{ "trackId": "1", "episodes": [{ "seriesId": "provider-id", "seasonNumber": 1, "episodeNumber": 1, "title": "Pilot", "airDate": "2020-01-01", "notes": "Verified" }] }`.
  Optional `importedMetadata` and `artworkReferences` fields preserve the
  confirmed provider result on the disc recovery record.
- `POST /api/v1/tv/metadata/series/lookup` accepts `provider`, `providerId`,
  and (for manual entry) `seriesName`.
- `POST /api/v1/tv/metadata/episodes/lookup` accepts `provider`, `providerId`,
  and `seasonNumber`.

The dashboard provides a dropdown episode assignment for keyboard/mouse
operation and native drag-and-drop from detected tracks to mapping rows.
See [Library Metadata & Organization](./METADATA-LIBRARY-ORGANIZATION.md) for
settings, provider capabilities, NFO behavior, and the full API field list.
