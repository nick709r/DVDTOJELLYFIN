# Unified Media Review

Movie, TV and TV-plan reviews share one search workflow, one queue model and one completion endpoint. Media-specific
behaviour lives in adapters; the Review Queue UI is media-agnostic.

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
