import type Database from "better-sqlite3";
import type { CompletedTvDiscHistory, Episode } from "../../domain/television.js";
import type { CompletedTvDiscHistoryRepository } from "../../domain/television.js";

interface CompletedDiscRow {
  jobId: string;
  fingerprint: string;
  completedAt: string;
  metadataProvider: string;
  providerId: string | null;
  seriesName: string;
  seasonNumber: number;
  discNumber: number | null;
  mappingsJson: string;
}

interface StoredEpisodeMapping {
  trackId: string;
  episodes: Episode[];
}

function parseMappings(row: CompletedDiscRow): StoredEpisodeMapping[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.mappingsJson) as unknown;
  } catch (error) {
    throw new Error(`Completed TV disc mappings are invalid for ${row.fingerprint}`, { cause: error });
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Completed TV disc mappings are invalid for ${row.fingerprint}`);
  }
  return parsed.map((value): StoredEpisodeMapping => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Completed TV disc mapping is invalid for ${row.fingerprint}`);
    }
    const mapping = value as { trackId?: unknown; episodes?: unknown };
    if (typeof mapping.trackId !== "string" || !Array.isArray(mapping.episodes)) {
      throw new Error(`Completed TV disc mapping is invalid for ${row.fingerprint}`);
    }
    const episodes = mapping.episodes.map((episode): Episode => {
      if (!episode || typeof episode !== "object" || Array.isArray(episode)) {
        throw new Error(`Completed TV disc episode is invalid for ${row.fingerprint}`);
      }
      const candidate = episode as Partial<Episode>;
      if (typeof candidate.seriesId !== "string" ||
        !Number.isInteger(candidate.seasonNumber) || !Number.isInteger(candidate.episodeNumber) ||
        candidate.seasonNumber! < 0 || candidate.episodeNumber! < 0) {
        throw new Error(`Completed TV disc episode is invalid for ${row.fingerprint}`);
      }
      return candidate as Episode;
    });
    return { trackId: mapping.trackId, episodes };
  });
}

export class SqliteCompletedTvDiscHistoryRepository implements CompletedTvDiscHistoryRepository {
  constructor(private readonly db: Database.Database) {}

  listForSeason(seasonNumber: number, limit = 500): CompletedTvDiscHistory[] {
    if (!Number.isInteger(seasonNumber) || seasonNumber < 0 || seasonNumber > 100) {
      throw new Error("Completed TV disc history requires a season number from 0 to 100");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error("Completed TV disc history limit must be from 1 to 1000");
    }
    const rows = this.db.prepare(`
      SELECT j.id AS jobId, j.disc_fingerprint AS fingerprint, j.finished_at AS completedAt,
        r.metadata_provider AS metadataProvider, r.provider_id AS providerId,
        r.series_name AS seriesName, r.season_number AS seasonNumber,
        r.disc_number AS discNumber, r.mappings_json AS mappingsJson
      FROM jobs j
      INNER JOIN disc_recovery r ON r.fingerprint = j.disc_fingerprint
      WHERE j.status = 'completed' AND j.finished_at IS NOT NULL
        AND j.disc_fingerprint IS NOT NULL
        AND r.final_media_type = 'tv_series'
        AND r.season_number = ? AND r.series_name IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM jobs newer
          WHERE newer.disc_fingerprint = j.disc_fingerprint
            AND newer.status = 'completed' AND newer.finished_at IS NOT NULL
            AND (newer.finished_at > j.finished_at OR
              (newer.finished_at = j.finished_at AND newer.id > j.id))
        )
      ORDER BY j.finished_at DESC, j.id DESC
      LIMIT ?
    `).all(seasonNumber, limit) as CompletedDiscRow[];
    const seenFingerprints = new Set<string>();
    return rows.flatMap((row): CompletedTvDiscHistory[] => {
      if (seenFingerprints.has(row.fingerprint)) return [];
      seenFingerprints.add(row.fingerprint);
      const mappings = parseMappings(row);
      const episodeSet = new Map<string, Episode>();
      for (const episode of mappings.flatMap((mapping) => mapping.episodes)) {
        if (episode.seasonNumber === row.seasonNumber) {
          episodeSet.set(`${episode.seriesId}:${episode.seasonNumber}:${episode.episodeNumber}`, episode);
        }
      }
      return [{
        jobId: row.jobId,
        fingerprint: row.fingerprint,
        metadataProvider: row.metadataProvider,
        providerId: row.providerId,
        seriesName: row.seriesName,
        seasonNumber: row.seasonNumber,
        discNumber: row.discNumber,
        mappings,
        episodes: [...episodeSet.values()],
        completedAt: row.completedAt
      }];
    });
  }
}
