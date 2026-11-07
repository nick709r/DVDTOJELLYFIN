export interface TvEpisodePublication {
  outputPath: string;
  fingerprint: string;
  discLabel: string;
  discNumber: number | null;
  trackId: string;
  trackTitle: string;
  seriesName: string;
  metadataProvider: string;
  providerId: string | null;
  seasonNumber: number;
  episodeNumber: number;
  confirmedAt: string | null;
  publishedAt: string;
}

export interface TvEpisodePublicationRepository {
  record(publications: readonly TvEpisodePublication[]): void;
  listForSeason(seasonNumber: number): TvEpisodePublication[];
}
