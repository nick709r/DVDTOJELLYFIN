# Unified Media Review

Movie, TV and TV-plan reviews share one search workflow, one queue model and one completion endpoint. Media-specific
behaviour lives in adapters. The Review Center also contains the existing issue and preserved-media views and an
expandable section for TV analysis and episode suggestions.

Cards use action-oriented labels: Needs Match, Needs Identification, Episode Conflict, Metadata Conflict,
Processing Warnings, and Needs User Decision. The existing issue filters still filter issue records; they do not
filter every section of the Review Center.

Staged TV discs and preserved review workspaces provide **Forget Disc** alongside their existing deletion actions.
After confirmation, this removes disc-owned review and recovery records and staged media; it does not remove published
library files. Removing a review item alone is distinct from forgetting the disc.

## TV episode conflicts

For episodes published after database migration 30, AutoDisc records the disc fingerprint, label and number, source
title, episode numbers, output path, confirmation time (when assigned through TV matching), and publication time.
Assignments to an existing recorded episode are held in the Review Center and display both sources. A publishing-time
check also protects against a collision after the assignment was saved. Missing recorded files do not block publishing.
Existing output paths are still protected even for episodes published before provenance was recorded.
Conflicts are labelled **Verified** when publication provenance is present (this does not verify the file's contents),
**Legacy** only when a single historical
disc mapping and the recorded job output establish the source, or **Unknown** when that evidence is unavailable or
ambiguous. Exact output-path collisions and standard `S01E07`-style filenames in the configured season directory
without provenance are also shown for review; files elsewhere or filenames that do not encode episode numbers and do
not match the output path cannot be inferred safely. The conflict card displays the available disc IDs, source titles,
mapping confirmation times, and the previous publication time. It explicitly distinguishes recorded provenance from
verification of the current file's contents.
The incoming title is labelled Verified only for its recorded user-confirmed assignment; otherwise its provenance is
Unknown. This label does not mean that the incoming file has already been published.

Conflict decisions apply to the **entire incoming title**, including any episodes without conflicts. The user is
prompted when a title contains multiple episodes. All displayed existing sources for that title must still match when
the decision is saved. The available actions are:

- **Keep Existing** dismisses the incoming title without changing either file.
- **Keep Both** publishes the incoming title using a distinct alternate filename and records episode provenance.
- **Mark As Extras** publishes the incoming title in the series `Extras` folder and records its source and output in
  the audit journal. It does not record the extra as an episode.
- **Replace Existing** converts the staged title and replaces one existing file with verified publication provenance.
  The original remains in quarantine. Replacement requires Linux and an existing file in the selected output format.

Saving a decision does not modify media files. The staged source remains on disk even after a resolved job completes;
explicit Forget Disc or staged-disc deletion can remove retained staged media. The dismissal or extra mapping is
removed from disc recovery so it is not learned as a published episode. Source snapshots and decisions are recorded
in the conflict audit journal; the existing file is checked again by checksum at the publishing boundary. Changed or
missing sources invalidate the decision. If publication fails or is interrupted after creating an output, the staged
source and created outputs are retained, and manual review may be required before retrying.

Migration 31 adds an independent conflict-audit journal and replacement-transaction journal. Non-replacement
actions use the audit journal; replacement uses both journals. Startup reconciles incomplete replacement transactions
before cleanup and retains associated staged media for review. Replacement journal states are not proof that
filesystem operations have occurred.
Audit records are displayed on staged-disc cards, but an audit record alone does not resolve a conflict.
See [the replacement design](./TV-EPISODE-REPLACEMENT-DESIGN.md) for the remaining safety work.

## Workflow

1. Media enters the review queue.
2. `POST /api/v1/review/search` searches the metadata providers for the media type and returns ranked results.
3. The user selects a result, refines the search, or (as a fallback) types a title manually.
4. The user confirms with **Confirm & Continue**.
5. `POST /api/v1/review/items/:id/complete` validates the decision and continues processing.

Metadata searches log the requests sent to each provider, the responses, filtering decisions, and the reason when zero
results are presented. Movie searches previously returned nothing because the movie provider silently returned `[]`
when its own enable flag or API key was unset (TV uses separate settings); this is now logged and surfaced.

## `MediaReviewItem`

Every review source is converted by an adapter into a `MediaReviewItem` (`src/domain/media-review.ts`): `id`,
`mediaType`, `status`, `kind`, `reviewReason`, `confidence`, `originalTitle`, `selectedTitle`, ranked `candidates`,
`metadata`, `source`, `legacy`, timestamps, and optional `tv` details (series, season, disc, tracks with episode
numbers, progress, and what is still required).

Ids are `kind:sourceId`: `review-job:ID`, `tv-matching-task:ID`, `tv-plan:ID`.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/review/items` | List items; filter by `mediaType`, `status`, `source` |
| `GET /api/v1/review/items/:id` | One item |
| `POST /api/v1/review/items/:id/complete` | Complete an item |

`MediaReviewItem` is distinct from the review-centre issue record (`ReviewItem`, `/api/v1/reviews`).

## Completion

Request body (all optional; what is valid depends on the item):

- Movies: `candidateId` or `title`.
- TV discs: `identification` (series, provider, season, disc) and `assignments` (`trackId` and up to three
  `episodeNumbers`; an empty list un-matches a track), plus `publish`.
- TV plans: `reviewer` (completion approves the plan).

`publish` is `never`, `when-ready` (default; publish only when every track is matched) or `required`.

Response: `{ item, continuation }` where `continuation` is `started`, `queued`, `blocked` or `not-ready`. The status is
202 for `started`/`queued` and 200 otherwise. Errors: 400 invalid input, 404 unknown item, 409 conflict, 422 not
completable by this kind, 503 service unavailable.

Behaviour guarantees:

- Input is fully validated before anything is saved.
- Concurrent completions of the same item are rejected with 409 while the first is in flight.
- A movie job must still be `pending` for its title to change or processing to resume.
- Completed TV tasks are rejected with 409 for every request.
- A blank `title` is ignored in favour of `candidateId`; an unknown `candidateId` is rejected with 400.
- A movie with no title resumes only if a title is stored or `movieIdentificationConfirmed` is set.

## Legacy compatibility

Stored movie candidates written by earlier versions (bare strings, missing ids, string confidences, `name` for
`title`) are converted when read and flagged `legacy: true`; stored data is not rewritten.

These endpoints keep their URLs and response shapes and are wrappers over the same completion service:

| Legacy endpoint | Equivalent completion |
| --- | --- |
| `PUT /api/v1/tv/matching/:id/identification` | `identification`, `publish: "never"` |
| `PUT /api/v1/tv/matching/:id/assignments` | `assignments`, `publish: "when-ready"` |
| `POST /api/v1/tv/matching/:id/continue` | `publish: "required"` |
| `POST /api/v1/review-jobs/:id/continue` | movie completion with no title |

Wording of some 404/409 messages changed, and assignment validation (400) now runs before the "identify the series
first" conflict (409).

## Remaining media-specific paths

- TV plan reject/defer and the plan-card approve (which applies recovery mappings first) use `/api/v1/tv/plans/:id/review`.
- `/api/v1/discs/:fingerprint/identification` and `/api/v1/tv/plans/:id/identification` identify discs that are not
  review items.
- `/api/v1/review-jobs/:id/metadata` saves a title without continuing.

## Adding a media type

Implement `MediaReviewItemAdapter` (`list`, `get`, optional `complete`) and register it on the queue in `server.ts`.
No UI changes are needed.
