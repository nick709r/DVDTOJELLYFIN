import type {
  AcquiredSource,
  MediaSourceCandidate,
  MediaSourceProvider,
  SourceAcquisitionOptions
} from "../contracts/media-source.js";
import { log } from "../logger.js";

export interface InspectedMediaSource {
  provider: MediaSourceProvider;
  candidate: MediaSourceCandidate;
}

export class MediaSourceCoordinator {
  constructor(private readonly providers: readonly MediaSourceProvider[]) {
    if (!providers.length) throw new Error("At least one media source provider must be registered");
  }

  async inspect(sourceId: string, signal?: AbortSignal): Promise<InspectedMediaSource | null> {
    const attemptedProviders: string[] = [];
    for (const provider of this.providers) {
      if (signal?.aborted) throw signal.reason ?? new Error("Source inspection cancelled");
      attemptedProviders.push(provider.describe().id);
      const candidate = await provider.inspect(sourceId, signal);
      if (!candidate) continue;
      if (typeof candidate !== "object" || candidate === null ||
        typeof candidate.providerId !== "string" || typeof candidate.sourceId !== "string" ||
        typeof candidate.mediaKind !== "string" || typeof candidate.label !== "string" ||
        typeof candidate.manifest !== "object" || candidate.manifest === null ||
        !Array.isArray(candidate.manifest.items)) {
        throw new Error(`Source provider ${provider.describe().id} returned an invalid media candidate`);
      }
      if (candidate.providerId !== provider.describe().id || candidate.sourceId !== sourceId) {
        throw new Error(`Source provider ${provider.describe().id} returned a candidate with mismatched identity`);
      }
      if (!candidate.mediaKind || candidate.manifest.mediaKind !== candidate.mediaKind) {
        throw new Error(`Source provider ${provider.describe().id} returned an invalid media manifest`);
      }
      return { provider, candidate };
    }
    log("warn", "media-source", "No registered source provider recognized the inserted media", {
      sourceId,
      attemptedProviders
    });
    return null;
  }

  async acquire(
    source: InspectedMediaSource,
    workspacePath: string,
    options?: SourceAcquisitionOptions,
    signal?: AbortSignal
  ): Promise<AcquiredSource> {
    const acquired = await source.provider.acquire(source.candidate, workspacePath, options, signal);
    if (typeof acquired !== "object" || acquired === null ||
      typeof acquired.source !== "object" || acquired.source === null ||
      !Array.isArray(acquired.artifacts) ||
      acquired.source.providerId !== source.candidate.providerId ||
      acquired.source.id !== source.candidate.sourceId ||
      acquired.source.kind !== source.candidate.mediaKind) {
      throw new Error(`Source provider ${source.candidate.providerId} returned acquired media with mismatched identity`);
    }
    if (acquired.artifacts.some((artifact) => !artifact.id || !artifact.kind || !artifact.path)) {
      throw new Error(`Source provider ${source.candidate.providerId} returned an invalid media artifact`);
    }
    return acquired;
  }
}
