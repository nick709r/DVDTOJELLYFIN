import type {
  MetadataIdentificationInput,
  MetadataProvider,
  MetadataProviderCandidate
} from "../../contracts/metadata-provider.js";
import type { ProviderDescriptor, ProviderHealth } from "../../contracts/provider.js";
import type { AppSettings } from "../../model.js";
import { resolveMusicMetadata, type MusicAlbumMetadata } from "../../music-metadata.js";

export class MusicBrainzMetadataProvider implements MetadataProvider {
  constructor(private readonly getSettings: () => AppSettings) {}

  describe(): ProviderDescriptor {
    return {
      id: "metadata.musicbrainz.release",
      apiVersion: "1.0.0",
      kind: "metadata",
      capabilities: ["metadata.album.identification", "metadata.track.identification"]
    };
  }

  async initialize(): Promise<void> {
  }

  async healthCheck(): Promise<ProviderHealth> {
    return { status: this.getSettings().musicMetadataEnabled ? "available" : "degraded",
      ...(!this.getSettings().musicMetadataEnabled ? { message: "Music metadata lookup is disabled" } : {}) };
  }

  async dispose(): Promise<void> {
    return Promise.resolve();
  }

  async identify(input: MetadataIdentificationInput, signal?: AbortSignal): Promise<readonly MetadataProviderCandidate[]> {
    if (input.entityType !== "album" || !this.getSettings().musicMetadataEnabled) return [];
    const discId = input.identifiers?.musicBrainzDiscId;
    const trackNumbers = input.attributes?.trackNumbers;
    if (!discId || !Array.isArray(trackNumbers) ||
      !trackNumbers.every((number): number is number => Number.isInteger(number) && Number(number) > 0)) return [];
    const metadata = await resolveMusicMetadata({
      discId,
      trackNumbers,
      fingerprint: input.identifiers?.fingerprint ?? ""
    }, true, signal, this.getSettings().musicBrainzContactEmail);
    if (metadata.source !== "musicbrainz") return [];
    return [{
      id: discId,
      entityType: "album",
      title: metadata.album,
      confidence: 0.95,
      metadata: {
        artist: metadata.artist,
        album: metadata.album,
        year: metadata.year,
        tracks: metadata.tracks,
        source: metadata.source
      },
      identifiers: { musicBrainzDiscId: discId }
    }];
  }
}

export function isMusicAlbumMetadata(value: unknown): value is MusicAlbumMetadata {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.artist === "string" &&
    typeof candidate.album === "string" &&
    (candidate.year === null || typeof candidate.year === "string") &&
    Array.isArray(candidate.tracks) &&
    candidate.tracks.every((track) =>
      typeof track === "object" && track !== null &&
      Number.isInteger((track as Record<string, unknown>).number) &&
      typeof (track as Record<string, unknown>).title === "string"
    );
}
