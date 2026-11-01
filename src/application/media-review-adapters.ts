import type { MetadataResolver } from "./metadata-resolver.js";
import type { TvMetadataLookupService } from "./tv-metadata-lookup-service.js";
import type {
  MediaReviewAdapter,
  ReviewAdapterSearchResult,
  ReviewSearchCandidate,
  ReviewSearchProviderReport
} from "../domain/review-search.js";

const providerNames: Record<string, string> = {
  "metadata.tmdb.movie": "TMDB"
};

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d{4}$/.test(value)) return Number(value);
  return undefined;
}

export class MovieReviewAdapter implements MediaReviewAdapter {
  readonly mediaType = "movie";
  readonly label = "Movie";
  readonly searchPlaceholder = "Movie title";

  constructor(private readonly resolver: MetadataResolver) {}

  async search(term: string, signal?: AbortSignal): Promise<ReviewAdapterSearchResult> {
    const startedAt = Date.now();
    const result = await this.resolver.resolve({
      entityType: "movie",
      query: term,
      attributes: { interactive: true }
    }, signal);
    const durationMs = Date.now() - startedAt;
    const candidates: ReviewSearchCandidate[] = result.candidates.map((candidate) => {
      const title = stringValue(candidate.metadata.title) ?? candidate.title;
      const year = numberValue(candidate.metadata.year);
      return {
        mediaType: "movie",
        provider: candidate.providerId,
        providerName: providerNames[candidate.providerId] ?? candidate.providerId,
        id: candidate.identifiers?.tmdbMovieId ?? candidate.id,
        title,
        ...(year === undefined ? {} : { year }),
        ...(stringValue(candidate.metadata.overview) ? { overview: stringValue(candidate.metadata.overview)! } : {}),
        ...(stringValue(candidate.metadata.searchPosterUrl) ? { posterUrl: stringValue(candidate.metadata.searchPosterUrl)! } : {}),
        confidence: candidate.confidence,
        attributes: { confirmTitle: candidate.title }
      };
    });
    const providers: ReviewSearchProviderReport[] = [];
    for (const providerId of new Set(candidates.map((candidate) => candidate.provider))) {
      providers.push({
        providerId, query: term, durationMs,
        matches: candidates.filter((candidate) => candidate.provider === providerId).length
      });
    }
    for (const failure of result.providerFailures) {
      providers.push({ providerId: failure.providerId, query: term, durationMs, matches: 0, failure: failure.message });
    }
    return { candidates, providers };
  }
}

export class TvReviewAdapter implements MediaReviewAdapter {
  readonly mediaType = "tv";
  readonly label = "TV series";
  readonly searchPlaceholder = "Series title, tvdb:12345, tmdb:12345 or tt1234567";

  constructor(private readonly lookup: Pick<TvMetadataLookupService, "searchSeries">) {}

  async search(term: string, signal?: AbortSignal): Promise<ReviewAdapterSearchResult> {
    const results = await this.lookup.searchSeries(term, signal);
    const candidates = results.flatMap((entry) => entry.candidates).map((candidate): ReviewSearchCandidate => ({
      mediaType: "tv",
      provider: candidate.provider,
      providerName: candidate.providerName,
      id: candidate.seriesId,
      title: candidate.title,
      ...(candidate.year === undefined ? {} : { year: candidate.year }),
      ...(candidate.overview === undefined ? {} : { overview: candidate.overview }),
      ...(candidate.posterUrl === undefined ? {} : { posterUrl: candidate.posterUrl }),
      detail: candidate.seasonCount
        ? `${candidate.seasonCount} season${candidate.seasonCount === 1 ? "" : "s"}`
        : "Seasons not reported",
      confidence: candidate.confidence,
      attributes: {
        seasonCount: candidate.seasonCount ?? 0,
        confirmTitle: candidate.title,
        identifiers: candidate.identifiers
      }
    }));
    return {
      candidates,
      providers: results.map((entry) => ({
        providerId: entry.providerId,
        query: entry.query,
        matches: entry.candidates.length,
        durationMs: entry.durationMs,
        ...(entry.failure ? { failure: entry.failure } : {})
      }))
    };
  }
}
