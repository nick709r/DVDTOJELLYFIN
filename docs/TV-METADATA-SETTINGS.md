# TV Metadata Settings

AutoDisc 1.9.1 exposes TV metadata configuration and provider credential
validation in the dashboard. This is a configuration and visibility release:
TVDB/TMDB TV lookups, metadata caching, and automatic refresh are not connected
to TV analysis, episode matching, or disc processing. Enabling these settings
does not change processing behavior.

## Provider catalog

`TvMetadataProviderRegistry` is a separate catalog in
`src/application/tv-metadata-provider-registry.ts`. It intentionally does not
register providers in the production `MetadataProviderRegistry` or
`MetadataResolver`, so planned TV providers cannot affect the existing movie or
TV workflows.

The bootstrap catalog currently registers:

| Provider ID | Display name | Credential validation | TV lookup |
|---|---|---|---|
| `tvdb` | TVDB | TVDB v4 login/token response | Not implemented |
| `tmdb-tv` | TMDB TV | TMDB v3 configuration endpoint | Not implemented |

Future providers register a descriptor with an ID, display name, credential
requirements, implementation state, and connection validator. The dashboard
renders the provider list and configuration controls from the registry; no
provider-specific dashboard markup is needed.

Provider health distinguishes configuration/credential state from lookup
capability. A successful connection test means credentials reached and were
accepted by the provider; it does not claim that AutoDisc can perform TV
metadata searches.

## Settings and secret handling

TV metadata preferences are persisted through the existing SQLite settings
repository. Provider IDs in preferred/fallback selections and dynamic provider
maps are validated against the registered catalog. API keys are stored in the
settings table (not encrypted at rest) and never included in settings,
provider-health, dashboard, or validation responses. Protect the local
database with normal host filesystem permissions. The dashboard only receives
whether a key is configured.

Connection tests use the saved key and a bounded 10-second request. The latest
outcome, safe message, and timestamp are persisted per provider. Validation
failure does not enable or disable a provider and does not alter the active
metadata resolver.

## API

- `GET /api/v1/tv/metadata` returns settings, registered providers, and the
  current read-only confidence/review policy.
- `GET /api/v1/tv/metadata/providers` returns provider health and last
  validation outcomes without credentials.
- `POST /api/v1/tv/metadata/providers/:id/test` validates the saved provider
  credentials and records the result.
- `GET /api/v1/tv/metadata/metrics` returns metadata activity. Values are
  nullable and `available` is false until lookup instrumentation exists.
- `POST /api/v1/tv/metadata/cache/refresh` currently returns HTTP 501 with an
  explicit message because no TV lookup/cache backend is implemented.
- `PUT /api/v1/settings` persists and validates the TV metadata preferences.

## Remaining implementation gates

Before the preferences can affect processing, implement concrete TV metadata
providers, provider-owned settings/secret storage, an explicit cache backend
and invalidation policy, lookup metrics, and workflow integration with
confidence-aware handling of incomplete or conflicting results. These changes
must remain separate from the analysis and episode-matching engines and require
their own integration tests.
