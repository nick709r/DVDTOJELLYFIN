import { log } from "../logger.js";
import type {
  MediaReviewAdapter,
  ReviewSearchCandidate,
  ReviewSearchOutcome,
  ReviewSearchProviderReport
} from "../domain/review-search.js";
import { searchVariants } from "./tv-name-normalization.js";

const directIdQuery = /^(?:(?:tvdb|tmdb|imdb)\s*[:=#-]?\s*\d+|tt\d{5,})$/i;

/** Shared search/rank/dedupe pipeline used by every media type's review workflow. */
export class MediaReviewSearchService {
  private readonly adapters = new Map<string, MediaReviewAdapter>();

  register(adapter: MediaReviewAdapter): void {
    if (this.adapters.has(adapter.mediaType)) throw new Error(`Review adapter for ${adapter.mediaType} is already registered`);
    this.adapters.set(adapter.mediaType, adapter);
  }

  mediaTypes(): Array<{ mediaType: string; label: string; searchPlaceholder: string }> {
    return [...this.adapters.values()].map(({ mediaType, label, searchPlaceholder }) =>
      ({ mediaType, label, searchPlaceholder }));
  }

  has(mediaType: string): boolean {
    return this.adapters.has(mediaType);
  }

  async search(mediaType: string, query: string, signal?: AbortSignal): Promise<ReviewSearchOutcome> {
    const adapter = this.adapters.get(mediaType);
    if (!adapter) throw new Error(`No review adapter is registered for media type "${mediaType}"`);
    const trimmed = query.trim();
    const terms = directIdQuery.test(trimmed)
      ? [trimmed]
      : [trimmed, ...searchVariants(trimmed).filter((variant) =>
        variant.toLocaleLowerCase() !== trimmed.toLocaleLowerCase())].slice(0, 3);
    log("info", "review-search", "Review metadata search started", { mediaType, query: trimmed, terms });

    const reports: ReviewSearchProviderReport[] = [];
    const collected: ReviewSearchCandidate[] = [];
    for (const term of terms) {
      const result = await adapter.search(term, signal);
      reports.push(...result.providers);
      collected.push(...result.candidates);
      log("info", "review-search", "Review metadata search term completed", {
        mediaType,
        term,
        candidates: result.candidates.length,
        providers: result.providers.map((provider) => ({
          providerId: provider.providerId,
          matches: provider.matches,
          durationMs: provider.durationMs,
          ...(provider.failure ? { failure: provider.failure } : {})
        }))
      });
      if (result.candidates.length > 0) break;
      if (signal?.aborted) break;
    }

    const seen = new Set<string>();
    const candidates = collected.filter((candidate) => {
      const key = `${candidate.provider}:${candidate.id}`;
      if (seen.has(key)) {
        log("debug", "review-search", "Duplicate candidate filtered", { mediaType, key, title: candidate.title });
        return false;
      }
      seen.add(key);
      return true;
    }).sort((left, right) => right.confidence - left.confidence);
    if (collected.length !== candidates.length) {
      log("info", "review-search", "Candidates filtered", {
        mediaType, received: collected.length, presented: candidates.length, reason: "duplicate provider results"
      });
    }

    const outcome: ReviewSearchOutcome = {
      mediaType,
      label: adapter.label,
      query: trimmed,
      candidates,
      queries: reports
    };
    if (candidates.length > 0) return outcome;

    const failures = reports.filter((report) => report.failure);
    const emptyReason = reports.length === 0
      ? "No metadata provider was queried"
      : failures.length === reports.length
        ? `Every metadata provider failed: ${failures.map((report) => `${report.providerId} (${report.failure})`).join("; ")}`
        : failures.length > 0
          ? `No provider returned matches; ${failures.map((report) => `${report.providerId} failed (${report.failure})`).join("; ")}`
          : `Providers answered but returned no matches for: ${terms.map((term) => `"${term}"`).join(", ")}`;
    log("warn", "review-search", "Zero review search results presented", {
      mediaType, query: trimmed, terms, reason: emptyReason
    });
    return { ...outcome, emptyReason };
  }
}
