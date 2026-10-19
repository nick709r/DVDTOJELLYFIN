import type {
  MediaAcquisitionResult,
  MediaCandidate,
  MediaSource
} from "../domain/media.js";
import type { Provider } from "./provider.js";

export type MediaSourceCandidate = MediaCandidate;
export type AcquiredSource = MediaAcquisitionResult;

export interface SourceAcquisitionOptions {
  selection?: {
    manifestItemId: string;
  };
  attributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface MediaSourceProvider extends Provider {
  inspect(sourceId: string, signal?: AbortSignal): Promise<MediaSourceCandidate | null>;
  acquire(
    candidate: MediaSourceCandidate,
    workspacePath: string,
    options?: SourceAcquisitionOptions,
    signal?: AbortSignal
  ): Promise<AcquiredSource>;
}

export type { MediaSource };
