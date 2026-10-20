import type { Episode } from "./television.js";

export type DiscType = "cd" | "dvd" | "bluray" | "uhd_bluray" | "data_disc" | "unknown";
export type MediaType =
  | "movie"
  | "tv_series"
  | "music_album"
  | "audiobook"
  | "music_video"
  | "concert"
  | "documentary"
  | "mixed_content"
  | "other";
export type MetadataProviderId = "tvdb" | "tmdb" | "imdb" | "anidb" | "manual";

export interface EpisodeMapping {
  trackId: string;
  episodes: readonly Episode[];
}

export interface DiscRecovery {
  fingerprint: string;
  detectedDiscType: DiscType;
  finalDiscType: DiscType;
  detectedMediaType: MediaType;
  detectedConfidence: number | null;
  finalMediaType: MediaType;
  discTypeOverridden: boolean;
  mediaTypeOverridden: boolean;
  metadataProvider: MetadataProviderId;
  providerId: string | null;
  seriesName: string | null;
  seasonNumber: number | null;
  mappings: readonly EpisodeMapping[];
  notes: string | null;
  updatedAt: string;
}

export interface DiscRecoveryUpdate {
  finalDiscType?: DiscType;
  finalMediaType?: MediaType;
  metadataProvider?: MetadataProviderId;
  providerId?: string | null;
  seriesName?: string | null;
  seasonNumber?: number | null;
  mappings?: readonly EpisodeMapping[];
  notes?: string | null;
}

export interface DiscRecoveryRepository {
  get(fingerprint: string): DiscRecovery | undefined;
  recordDetection(fingerprint: string, discType: DiscType, mediaType: MediaType, confidence?: number): DiscRecovery;
  update(fingerprint: string, patch: DiscRecoveryUpdate): DiscRecovery | undefined;
  list(limit?: number): DiscRecovery[];
}

export const discTypes: readonly DiscType[] =
  ["cd", "dvd", "bluray", "uhd_bluray", "data_disc", "unknown"];
export const mediaTypes: readonly MediaType[] =
  ["movie", "tv_series", "music_album", "audiobook", "music_video", "concert", "documentary", "mixed_content", "other"];
export const metadataProviderIds: readonly MetadataProviderId[] = ["tvdb", "tmdb", "imdb", "anidb", "manual"];

export function isValidAirDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
