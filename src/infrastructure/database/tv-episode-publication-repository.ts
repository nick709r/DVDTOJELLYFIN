import type Database from "better-sqlite3";
import type { TvEpisodePublication, TvEpisodePublicationRepository } from "../../domain/tv-publication.js";

export class SqliteTvEpisodePublicationRepository implements TvEpisodePublicationRepository {
  constructor(private readonly db: Database.Database) {}

  record(publications: readonly TvEpisodePublication[]): void {
    const removePrevious = this.db.prepare("DELETE FROM tv_episode_publications WHERE output_path = ?");
    const insert = this.db.prepare(`
      INSERT INTO tv_episode_publications
        (output_path, fingerprint, disc_label, disc_number, track_id, track_title, series_name,
         metadata_provider, provider_id, season_number, episode_number, confirmed_at, published_at)
      VALUES (@outputPath, @fingerprint, @discLabel, @discNumber, @trackId, @trackTitle, @seriesName,
        @metadataProvider, @providerId, @seasonNumber, @episodeNumber, @confirmedAt, @publishedAt)
    `);
    this.db.transaction(() => {
      for (const path of new Set(publications.map((publication) => publication.outputPath))) removePrevious.run(path);
      for (const publication of publications) insert.run(publication);
    })();
  }

  listForSeason(seasonNumber: number): TvEpisodePublication[] {
    return this.db.prepare(`
      SELECT output_path AS outputPath, fingerprint, disc_label AS discLabel, disc_number AS discNumber,
        track_id AS trackId, track_title AS trackTitle, series_name AS seriesName,
        metadata_provider AS metadataProvider, provider_id AS providerId, season_number AS seasonNumber,
        episode_number AS episodeNumber, confirmed_at AS confirmedAt, published_at AS publishedAt
      FROM tv_episode_publications WHERE season_number = ?
      ORDER BY published_at DESC, output_path
    `).all(seasonNumber) as TvEpisodePublication[];
  }
}
