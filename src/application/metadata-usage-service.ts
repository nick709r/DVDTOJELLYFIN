import type Database from "better-sqlite3";

export interface MetadataUsageEntry {
  providerId: string;
  entityType: string;
  /** Number of candidates returned; 0 for an empty or failed lookup. */
  matches: number;
  durationMs: number;
  success: boolean;
  error?: string | undefined;
  /** The provider handles this media type but did not query it (disabled, no key, missing input). */
  skipped?: boolean;
}

export interface MetadataUsageRecorder {
  record(entry: MetadataUsageEntry): void;
}

export interface ProviderUsageSummary {
  providerId: string;
  requests: number;
  successfulMatches: number;
  emptyResults: number;
  failures: number;
  skipped: number;
  lastSkipReason: string | null;
  averageLookupTimeMs: number | null;
  successRate: number | null;
  lastFailure: string | null;
  lastFailureAt: string | null;
}

export interface ProviderOverview extends ProviderUsageSummary {
  mediaType: string;
  status: string;
  statusMessage: string | null;
}

export interface ProviderStatusSource {
  (): Promise<Array<{ providerId: string; health: { status: string; message?: string | undefined } }>>;
}

export interface IdentificationStats {
  moviesIdentified: number;
  tvSeriesIdentified: number;
  tvEpisodesIdentified: number;
  musicCdsIdentified: number;
  automaticMatches: number;
  reviewRequiredMatches: number;
  manualMatches: number;
}

const tvConfiguredProviderId = "metadata.tv.configured";

/**
 * Provider-agnostic lookup usage. Every provider reached through MetadataResolver is recorded here,
 * so movie and music lookups are counted the same way TV lookups are.
 */
export class MetadataUsageService implements MetadataUsageRecorder {
  private statusSource: ProviderStatusSource | undefined;

  constructor(private readonly db: Database.Database) {}

  setProviderStatusSource(source: ProviderStatusSource): void {
    this.statusSource = source;
  }

  record(entry: MetadataUsageEntry): void {
    try {
      this.db.prepare(`
        INSERT INTO metadata_provider_usage
          (provider_id, entity_type, attempted_at, success, matches, duration_ms, error_message, skipped)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.providerId, entry.entityType, new Date().toISOString(), entry.success ? 1 : 0,
        Math.max(0, Math.trunc(entry.matches)), Math.max(0, Math.round(entry.durationMs)), entry.error ?? null,
        entry.skipped ? 1 : 0
      );
    } catch {
      // Usage statistics must never break a metadata lookup.
    }
  }

  /**
   * Every registered metadata provider (movie, music and TV) with its health and usage, including
   * providers that have not been used yet, so a disabled or unconfigured provider is still visible.
   */
  async providerOverview(): Promise<ProviderOverview[]> {
    const usage = new Map(this.providerUsage().map((row) => [row.providerId, row]));
    const registered = this.statusSource ? await this.statusSource() : [];
    const empty = (providerId: string): ProviderUsageSummary => ({
      providerId, requests: 0, successfulMatches: 0, emptyResults: 0, failures: 0, skipped: 0,
      lastSkipReason: null, averageLookupTimeMs: null, successRate: null, lastFailure: null, lastFailureAt: null
    });
    const rows: ProviderOverview[] = registered
      .filter((provider) => provider.providerId !== tvConfiguredProviderId)
      .map((provider) => {
        const summary = usage.get(provider.providerId) ?? empty(provider.providerId);
        usage.delete(provider.providerId);
        return {
          ...summary, mediaType: mediaTypeOf(provider.providerId),
          status: provider.health.status, statusMessage: provider.health.message ?? null
        };
      });
    // TV providers are not individually registered with the resolver; they come from the TV lookup audit.
    for (const summary of usage.values()) {
      rows.push({ ...summary, mediaType: mediaTypeOf(summary.providerId), status: "available", statusMessage: null });
    }
    return rows.sort((left, right) =>
      left.mediaType.localeCompare(right.mediaType) || left.providerId.localeCompare(right.providerId));
  }

  providerUsage(): ProviderUsageSummary[] {
    const resolverRows = this.db.prepare(`
      SELECT provider_id AS providerId,
        SUM(CASE WHEN skipped = 0 THEN 1 ELSE 0 END) AS requests,
        SUM(CASE WHEN skipped = 0 AND success = 1 AND matches > 0 THEN 1 ELSE 0 END) AS successfulMatches,
        SUM(CASE WHEN skipped = 0 AND success = 1 AND matches = 0 THEN 1 ELSE 0 END) AS emptyResults,
        SUM(CASE WHEN skipped = 0 AND success = 0 THEN 1 ELSE 0 END) AS failures,
        SUM(CASE WHEN skipped = 1 THEN 1 ELSE 0 END) AS skipped,
        AVG(CASE WHEN skipped = 0 THEN duration_ms END) AS averageLookupTimeMs,
        MAX(CASE WHEN skipped = 0 AND success = 0 THEN attempted_at END) AS lastFailureAt,
        (SELECT error_message FROM metadata_provider_usage last
          WHERE last.provider_id = grouped.provider_id AND last.skipped = 0 AND last.success = 0
          ORDER BY last.attempted_at DESC, last.id DESC LIMIT 1) AS lastFailure,
        (SELECT error_message FROM metadata_provider_usage last
          WHERE last.provider_id = grouped.provider_id AND last.skipped = 1
          ORDER BY last.attempted_at DESC, last.id DESC LIMIT 1) AS lastSkipReason
      FROM metadata_provider_usage grouped
      WHERE provider_id <> ?
      GROUP BY provider_id
    `).all(tvConfiguredProviderId) as RawUsageRow[];
    // The resolver sees TV lookups only as one aggregate provider; the lookup audit has the real TVDB/TMDB rows.
    const tvRows = this.db.prepare(`
      SELECT provider_id AS providerId, COUNT(*) AS requests,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS successfulMatches,
        0 AS emptyResults,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failures,
        0 AS skipped,
        AVG(duration_ms) AS averageLookupTimeMs,
        MAX(CASE WHEN success = 0 THEN attempted_at END) AS lastFailureAt,
        (SELECT error_message FROM tv_metadata_lookup_audit last
          WHERE last.provider_id = grouped.provider_id AND last.success = 0 AND last.provider_called = 1
          ORDER BY last.attempted_at DESC LIMIT 1) AS lastFailure,
        NULL AS lastSkipReason
      FROM tv_metadata_lookup_audit grouped
      WHERE provider_called = 1
      GROUP BY provider_id
    `).all() as RawUsageRow[];
    return [...resolverRows, ...tvRows]
      .map(toSummary)
      .sort((left, right) => left.providerId.localeCompare(right.providerId));
  }

  identificationStats(tvEpisodesIdentified: number): IdentificationStats {
    const recovery = this.db.prepare(`
      SELECT
        SUM(CASE WHEN final_media_type = 'movie' THEN 1 ELSE 0 END) AS movies,
        SUM(CASE WHEN final_media_type = 'tv_series' THEN 1 ELSE 0 END) AS tvSeries,
        SUM(CASE WHEN final_media_type = 'music_album' THEN 1 ELSE 0 END) AS music,
        SUM(CASE WHEN metadata_provider <> 'manual' AND media_type_overridden = 0 THEN 1 ELSE 0 END) AS automatic,
        SUM(CASE WHEN metadata_provider = 'manual' OR media_type_overridden = 1 THEN 1 ELSE 0 END) AS manual
      FROM disc_recovery
    `).get() as Record<string, number | null>;
    const pendingJobs = this.db.prepare(
      "SELECT COUNT(*) AS count FROM review_jobs WHERE status IN ('pending', 'retrying')"
    ).get() as { count: number };
    const pendingTv = this.db.prepare(`
      SELECT COUNT(*) AS count FROM tv_matching_tasks
      WHERE status IN ('awaiting-identification', 'awaiting-mapping', 'partially-matched', 'ready-to-publish')
    `).get() as { count: number };
    return {
      moviesIdentified: recovery.movies ?? 0,
      tvSeriesIdentified: recovery.tvSeries ?? 0,
      tvEpisodesIdentified,
      musicCdsIdentified: recovery.music ?? 0,
      automaticMatches: recovery.automatic ?? 0,
      reviewRequiredMatches: pendingJobs.count + pendingTv.count,
      manualMatches: recovery.manual ?? 0
    };
  }
}

type RawUsageRow = Record<string, string | number | null> & { providerId: string };

function toSummary(row: RawUsageRow): ProviderUsageSummary {
  const requests = Number(row.requests ?? 0);
  const successfulMatches = Number(row.successfulMatches ?? 0);
  const emptyResults = Number(row.emptyResults ?? 0);
  const failures = Number(row.failures ?? 0);
  return {
    providerId: row.providerId,
    requests,
    successfulMatches,
    emptyResults,
    failures,
    skipped: Number(row.skipped ?? 0),
    lastSkipReason: row.lastSkipReason == null ? null : String(row.lastSkipReason),
    averageLookupTimeMs: row.averageLookupTimeMs == null ? null : Math.round(Number(row.averageLookupTimeMs)),
    successRate: requests ? (requests - failures) / requests : null,
    lastFailure: row.lastFailure == null ? null : String(row.lastFailure),
    lastFailureAt: row.lastFailureAt == null ? null : String(row.lastFailureAt)
  };
}

function mediaTypeOf(providerId: string): string {
  if (providerId === "metadata.tmdb.movie") return "Movies";
  if (providerId === "metadata.musicbrainz.release") return "Music";
  return "TV";
}
