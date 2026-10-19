# TV Metadata Lookup

AutoDisc v1.11.0 can retrieve TV series, season, and episode candidates during
TV analysis. Metadata influences explainable suggestions only: it does not
automatically assign episodes or publish TV files.

## Providers

`TvMetadataProviderRegistry` owns provider registration and lookup dispatch.
`ConfiguredTvMetadataProvider` adapts its results to the existing
`MetadataResolver` contract, so the TV workflow can use metadata without
vendor-specific logic in the analysis or matching engines.

| Provider ID | Lookup behavior |
|---|---|
| `tvdb` | TVDB v4 authentication, series search, season identification, and episode retrieval |
| `tmdb-tv` | TMDB TV series search and season episode retrieval |

The preferred provider is tried first. The configured fallback is used when
the preferred provider fails or has no results. Providers disabled by the
administrator, missing credentials, or a known authentication, rate-limit, or
availability failure are not queried. Use **Refresh provider metadata** to
recheck provider connectivity and refresh cached results.

Connection testing checks saved credentials against provider endpoints.
Lookup health is separately updated from actual lookup attempts. Provider API
keys are stored in the local SQLite settings database and are not returned by
settings or health APIs; they are not encrypted at rest, so host filesystem
permissions must protect the database.

## Cache and audit

Optional SQLite caching is provider-aware and keyed by entity type, query,
season, and track details. Entries expire after the configured duration.
**Refresh metadata cache** re-fetches existing entries from their original
providers and updates their expiry. **Clear metadata cache** deletes all
entries. When caching is disabled, lookups still run and are audited, but no
results are written to the cache.

Each provider attempt, fallback, cache hit, and failure is recorded with query,
timestamp, duration, outcome, and safe error details. The dashboard reports
attempts, successful and failed attempts, cache hits/misses, provider usage,
average live lookup time, provider health, last successful lookup, and last
failure time/message. These are observed service metrics, not estimates.

## Settings

- **Enable TV metadata lookup during analysis** gates all TV provider calls.
- **Preferred provider** and **fallback provider** control lookup order.
- **Enable provider** gates a provider independently; a required API key must
  also be configured.
- **Cache metadata lookup results** controls whether result data is cached.
- **Cache duration** controls entry expiry when caching is enabled.

The earlier automatic-refresh and include-specials/bonus/multipart controls
were removed because they did not affect current lookup behavior. Evidence
capture remains controlled by the TV Processing setting; obsolete
`tvStoreAnalysisEvidence` and `tvStoreMatchingEvidence` keys are removed during
database migration.

## API

- `GET /api/v1/tv/metadata` returns active settings, operational providers, and
  the read-only matching policy.
- `GET /api/v1/tv/metadata/providers` returns provider health and lookup
  timestamps without credentials.
- `POST /api/v1/tv/metadata/providers/:id/test` tests saved credentials.
- `POST /api/v1/tv/metadata/providers/refresh` checks enabled providers and
  refreshes stored provider-specific metadata entries.
- `GET /api/v1/tv/metadata/metrics` returns values aggregated from lookup audit
  records.
- `POST /api/v1/tv/metadata/cache/refresh` re-fetches cached metadata entries.
- `DELETE /api/v1/tv/metadata/cache` clears all cached entries.
- `PUT /api/v1/settings` validates and persists lookup, provider, and cache
  configuration.

TV lookups use bounded provider requests. If all eligible providers fail, the
workflow records provider failure evidence and retains its conservative
review-only behavior. Provider results remain candidates; no automatic
episode assignment or TV publishing is enabled.
