import type {
  AudioCdMediaCandidate,
  MediaSourceCandidate,
  MediaSourceProvider,
  SourceAcquisitionOptions
} from "../../contracts/media-source.js";
import type { ProviderDescriptor } from "../../contracts/provider.js";
import { inspectAudioCd, ripAudioTracks } from "../../audio-cd.js";
import { executableAvailable } from "../../executable.js";

const descriptor: ProviderDescriptor = {
  id: "source.audio-cd.cdparanoia",
  apiVersion: "1.0.0",
  kind: "source",
  capabilities: ["audio.disc.cd", "audio.track-extraction"]
};
const cdparanoia = process.env.CDPARANOIA_COMMAND ?? "cdparanoia";

export class CdParanoiaSourceProvider implements MediaSourceProvider {
  describe(): ProviderDescriptor {
    return descriptor;
  }

  async initialize(): Promise<void> {}

  async healthCheck(): Promise<{ status: "available" | "degraded" | "unavailable"; message?: string }> {
    if (await executableAvailable(cdparanoia)) return { status: "available" };
    return { status: "unavailable", message: "cdparanoia is not executable on the service PATH" };
  }

  async dispose(): Promise<void> {}

  async inspect(sourceId: string, signal?: AbortSignal): Promise<AudioCdMediaCandidate | null> {
    const disc = await inspectAudioCd(sourceId, signal);
    if (!disc) return null;
    return {
      providerId: descriptor.id,
      mediaType: "audio_cd",
      sourceId,
      label: disc.discId ? `Audio CD ${disc.discId}` : "Audio CD",
      fingerprint: disc.fingerprint,
      discId: disc.discId,
      trackNumbers: disc.trackNumbers
    };
  }

  async acquire(
    candidate: MediaSourceCandidate,
    workspacePath: string,
    _options?: SourceAcquisitionOptions,
    signal?: AbortSignal
  ) {
    if (candidate.mediaType !== "audio_cd" || candidate.providerId !== descriptor.id) {
      throw new Error("Audio CD provider received a candidate it does not own");
    }
    return {
      mediaType: "audio_cd" as const,
      tracks: await ripAudioTracks(candidate.sourceId, workspacePath, signal)
    };
  }
}
