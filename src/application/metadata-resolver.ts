import type {
  MetadataIdentificationInput,
  MetadataProvider
} from "../contracts/metadata-provider.js";
import { normalizeConfidence, type MetadataResult } from "../domain/metadata.js";

export class MetadataResolver {
  constructor(private readonly providers: readonly MetadataProvider[]) {
    const ids = providers.map((provider) => provider.describe().id);
    if (new Set(ids).size !== ids.length) throw new Error("Metadata provider IDs must be unique");
  }

  async resolve(input: MetadataIdentificationInput, signal?: AbortSignal): Promise<MetadataResult> {
    const settled = await Promise.all(this.providers.map(async (provider) => {
      if (signal?.aborted) throw signal.reason ?? new Error("Metadata lookup cancelled");
      try {
        const candidates = await provider.identify(input, signal);
        return { providerId: provider.describe().id, candidates, failure: undefined };
      } catch (error) {
        if (signal?.aborted) throw error;
        return {
          providerId: provider.describe().id,
          candidates: [],
          failure: error instanceof Error ? error.message : "Unknown metadata provider failure"
        };
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
    return {
      ...(candidates[0] ? { selected: candidates[0] } : {}),
      candidates,
      providerFailures: failures
    };
  }
}
