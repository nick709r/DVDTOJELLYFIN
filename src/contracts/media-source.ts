import type { AudioTrackFile } from "../audio-cd.js";
import type { DiscTitle } from "../model.js";
import type { Provider } from "./provider.js";

export interface DvdMediaCandidate {
  providerId: string;
  mediaType: "dvd";
  sourceId: string;
  label: string;
  titles: DiscTitle[];
}

export interface AudioCdMediaCandidate {
  providerId: string;
  mediaType: "audio_cd";
  sourceId: string;
  label: string;
  fingerprint: string;
  discId: string | null;
  trackNumbers: number[];
}

export type MediaSourceCandidate = DvdMediaCandidate | AudioCdMediaCandidate;

export interface SourceAcquisitionOptions {
  titleId?: number;
}

export type AcquiredSource =
  | { mediaType: "dvd"; path: string }
  | { mediaType: "audio_cd"; tracks: AudioTrackFile[] };

export interface MediaSourceProvider extends Provider {
  inspect(sourceId: string, signal?: AbortSignal): Promise<MediaSourceCandidate | null>;
  acquire(
    candidate: MediaSourceCandidate,
    workspacePath: string,
    options?: SourceAcquisitionOptions,
    signal?: AbortSignal
  ): Promise<AcquiredSource>;
}
