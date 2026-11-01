import type {
  MetadataIdentificationInput,
  MetadataProvider
} from "../contracts/metadata-provider.js";
import { normalizeConfidence, type MetadataCandidate, type MetadataResult } from "../domain/metadata.js";
import { log } from "../logger.js";
import type { MetadataUsageRecorder } from "./metadata-usage-service.js";

export class MetadataResolver {
  constructor(
    private readonly providers: readonly MetadataProvider[],
    private readonly usage?: MetadataUsageRecorder
  ) {
    const ids = providers.map((provider) => provider.describe().id);
    if (new Set(ids).size !== ids.length) throw new Error("Metadata provider IDs must be unique");
  }

  async resolve(input: MetadataIdentificationInput, signal?: AbortSignal): Promise<MetadataResult> {
    const settled = await Promise.all(this.providers.map(async (provider) => {
      if (signal?.aborted) throw signal.reason ?? new Error("Metadata lookup cancelled");
      const providerId = provider.describe().id;
      const availability = provider.lookupAvailability?.(input);
      if (availability && !availability.applicable) {
        return { providerId, candidates: [], failure: undefined, skipReason: undefined };
      }
      if (availability?.skipReason) {
        log("info", "metadata", "Metadata lookup skipped", {
          mediaType: input.entityType, providerId, query: input.query, reason: availability.skipReason
        });
        this.usage?.record({
          providerId, entityType: input.entityType, matches: 0, durationMs: 0, success: true,
          skipped: true, error: availability.skipReason
        });
        return { providerId, candidates: [], failure: undefined, skipReason: availability.skipReason };
      }
      const startedAt = Date.now();
      try {
        log("info", "metadata", "Metadata lookup request", {
          mediaType: input.entityType, providerId, query: input.query ?? null,
          identifiers: input.identifiers ?? null
        });
        const candidates = await provider.identify(input, signal);
        this.usage?.record({
          providerId, entityType: input.entityType, matches: candidates.length,
          durationMs: Date.now() - startedAt, success: true
        });
        log("info", "metadata", "Metadata lookup response", {
          mediaType: input.entityType, providerId, query: input.query ?? null,
          resultCount: candidates.length,
          topResult: candidates[0] ? { id: candidates[0].id, title: candidates[0].title, confidence: candidates[0].confidence } : null,
          durationMs: Date.now() - startedAt
        });
        return { providerId, candidates, failure: undefined, skipReason: undefined };
      } catch (error) {
        if (signal?.aborted) throw error;
        const message = error instanceof Error ? error.message : "Unknown metadata provider failure";
        this.usage?.record({
          providerId, entityType: input.entityType, matches: 0,
          durationMs: Date.now() - startedAt, success: false, error: message
        });
        log("warn", "metadata", "Metadata lookup failed", {
          mediaType: input.entityType, providerId, query: input.query ?? null, failureReason: message
        });
        return { providerId, candidates: [], failure: message, skipReason: undefined };
      }
    }));
    const candidates = settled.flatMap(({ providerId, candidates }) =>
      candidates.map((candidate) => ({
        ...candidate,
        providerId,
        confidence: normalizeConfidence(candidate.confidence)
      }))
    ).sort((left, right) =>
      right.confidence - left.confidence ||
      left.providerId.localeCompare(right.providerId) ||
      left.id.localeCompare(right.id)
    );
    const failures = settled.flatMap(({ providerId, failure }) =>
      failure === undefined ? [] : [{ providerId, message: failure }]
    );
    const skips = settled.flatMap(({ providerId, skipReason }) =>
      skipReason === undefined ? [] : [{ providerId, reason: skipReason }]
    );
    const selected = candidates[0];
    log(selected ? "info" : "warn", "metadata", "Metadata lookup result", {
      mediaType: input.entityType,
      query: input.query ?? null,
      resultCount: candidates.length,
      selected: selected ? { providerId: selected.providerId, id: selected.id, title: selected.title, confidence: selected.confidence } : null,
      failures,
      skipped: skips,
      ...(selected ? {} : {
        reason: failures.length ? "provider failures" : skips.length ? "providers skipped" : "providers returned no matches"
      })
    });
    return {
      ...(selected ? { selected } : {}),
      candidates,
      providerFailures: failures,
      providerSkips: skips
    };
  }

  async enrich(candidate: MetadataCandidate, signal?: AbortSignal): Promise<MetadataCandidate> {
    if (signal?.aborted) throw signal.reason ?? new Error("Metadata enrichment cancelled");
    const provider = this.providers.find((item) => item.describe().id === candidate.providerId);
    if (!provider?.enrich) return candidate;
    const enriched = await provider.enrich(candidate, signal);
    return {
      ...candidate,
      ...enriched,
      providerId: candidate.providerId,
      confidence: candidate.confidence,
      metadata: { ...candidate.metadata, ...enriched.metadata },
      identifiers: { ...candidate.identifiers, ...enriched.identifiers }
    };
  }
}
