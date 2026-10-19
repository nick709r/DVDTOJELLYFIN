import type {
  AcquiredSource,
  MediaSourceCandidate,
  MediaSourceProvider,
  SourceAcquisitionOptions
} from "../contracts/media-source.js";

export interface InspectedMediaSource {
  provider: MediaSourceProvider;
  candidate: MediaSourceCandidate;
}

export class MediaSourceCoordinator {
  constructor(private readonly providers: readonly MediaSourceProvider[]) {
    if (!providers.length) throw new Error("At least one media source provider must be registered");
  }

  async inspect(sourceId: string, signal?: AbortSignal): Promise<InspectedMediaSource | null> {
    for (const provider of this.providers) {
      if (signal?.aborted) throw signal.reason ?? new Error("Source inspection cancelled");
      const candidate = await provider.inspect(sourceId, signal);
      if (!candidate) continue;
      if (candidate.providerId !== provider.describe().id || candidate.sourceId !== sourceId) {
        throw new Error(`Source provider ${provider.describe().id} returned a candidate with mismatched identity`);
      }
      return { provider, candidate };
    }
    return null;
  }

  acquire(
    source: InspectedMediaSource,
    workspacePath: string,
    options?: SourceAcquisitionOptions,
    signal?: AbortSignal
  ): Promise<AcquiredSource> {
    return source.provider.acquire(source.candidate, workspacePath, options, signal);
  }
}
