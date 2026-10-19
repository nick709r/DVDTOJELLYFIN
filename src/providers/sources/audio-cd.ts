import type { MediaSourceCandidate, MediaSourceProvider, SourceAcquisitionOptions } from "../../contracts/media-source.js";
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

  async inspect(sourceId: string, signal?: AbortSignal): Promise<MediaSourceCandidate | null> {
    const disc = await inspectAudioCd(sourceId, signal);
    if (!disc) return null;
    return {
      providerId: descriptor.id,
      mediaKind: "audio_cd",
      sourceId,
      label: disc.discId ? `Audio CD ${disc.discId}` : "Audio CD",
      fingerprint: disc.fingerprint,
      manifest: {
        mediaKind: "audio_cd",
        ...(disc.discId ? { identifiers: { musicBrainzDiscId: disc.discId } } : {}),
        items: disc.trackNumbers.map((number) => ({
          id: `track-${number}`,
          kind: "audio-track",
          trackNumber: number
        }))
      }
    };
  }

  async acquire(
    candidate: MediaSourceCandidate,
    workspacePath: string,
    _options?: SourceAcquisitionOptions,
    signal?: AbortSignal
  ) {
    if (candidate.mediaKind !== "audio_cd" || candidate.providerId !== descriptor.id) {
      throw new Error("Audio CD provider received a candidate it does not own");
    }
    const tracks = await ripAudioTracks(candidate.sourceId, workspacePath, signal);
    return {
      source: {
        id: candidate.sourceId,
        providerId: descriptor.id,
        kind: candidate.mediaKind,
        location: candidate.sourceId
      },
      artifacts: tracks.map((track) => ({
        id: `audio-track-${track.number}`,
        kind: "audio-track",
        mediaType: "audio/wav",
        path: track.path,
        trackNumber: track.number,
        attributes: { bytes: track.bytes }
      }))
    };
  }
}
