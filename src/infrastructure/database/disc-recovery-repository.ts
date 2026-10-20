import type Database from "better-sqlite3";
import type {
  DiscRecovery,
  DiscRecoveryRepository,
  DiscRecoveryUpdate,
  DiscType,
  EpisodeMapping,
  MediaType,
  MetadataProviderId
} from "../../domain/disc-recovery.js";
import { discTypes, isValidAirDate, mediaTypes, metadataProviderIds } from "../../domain/disc-recovery.js";

interface RecoveryRow {
  fingerprint: string;
  detected_disc_type: DiscType;
  final_disc_type: DiscType;
  detected_media_type: MediaType;
  detected_confidence: number | null;
  final_media_type: MediaType;
  disc_type_overridden: number;
  media_type_overridden: number;
  metadata_provider: MetadataProviderId;
  provider_id: string | null;
  series_name: string | null;
  season_number: number | null;
  mappings_json: string;
  notes: string | null;
  updated_at: string;
}

function mapRow(row: RecoveryRow | undefined): DiscRecovery | undefined {
  if (!row) return undefined;
  let mappings: EpisodeMapping[];
  try {
    mappings = JSON.parse(row.mappings_json) as EpisodeMapping[];
  } catch (error) {
    throw new Error(`Stored disc recovery mappings are invalid for ${row.fingerprint}`, { cause: error });
  }
  if (!Array.isArray(mappings)) throw new Error(`Stored disc recovery mappings are invalid for ${row.fingerprint}`);
  return {
    fingerprint: row.fingerprint,
    detectedDiscType: row.detected_disc_type,
    finalDiscType: row.final_disc_type,
    detectedMediaType: row.detected_media_type,
    detectedConfidence: row.detected_confidence,
    finalMediaType: row.final_media_type,
    discTypeOverridden: row.disc_type_overridden === 1,
    mediaTypeOverridden: row.media_type_overridden === 1,
    metadataProvider: row.metadata_provider,
    providerId: row.provider_id,
    seriesName: row.series_name,
    seasonNumber: row.season_number,
    mappings,
    notes: row.notes,
    updatedAt: row.updated_at
  };
}

function validatePatch(patch: DiscRecoveryUpdate): void {
  if (patch.finalDiscType !== undefined && !discTypes.includes(patch.finalDiscType)) {
    throw new Error("Unsupported physical disc type");
  }
  if (patch.finalMediaType !== undefined && !mediaTypes.includes(patch.finalMediaType)) {
    throw new Error("Unsupported media type");
  }
  if (patch.metadataProvider !== undefined && !metadataProviderIds.includes(patch.metadataProvider)) {
    throw new Error("Unsupported metadata provider");
  }
  if (patch.providerId !== undefined && patch.providerId !== null &&
    (patch.providerId.trim().length === 0 || patch.providerId.length > 200)) {
    throw new Error("Provider ID must contain 1 to 200 characters");
  }
  if (patch.seriesName !== undefined && patch.seriesName !== null &&
    (patch.seriesName.trim().length === 0 || patch.seriesName.length > 200)) {
    throw new Error("Series name must contain 1 to 200 characters");
  }
  if (patch.seasonNumber !== undefined && patch.seasonNumber !== null &&
    (!Number.isInteger(patch.seasonNumber) || patch.seasonNumber < 0 || patch.seasonNumber > 100)) {
    throw new Error("Season number must be an integer from 0 to 100");
  }
  if (patch.notes !== undefined && patch.notes !== null && patch.notes.length > 2000) {
    throw new Error("Notes must not exceed 2000 characters");
  }
  if (patch.mappings !== undefined) {
    if (patch.mappings.length > 100) throw new Error("Episode mappings must not exceed 100 tracks");
    const trackIds = new Set<string>();
    for (const mapping of patch.mappings) {
      if (!mapping.trackId.trim() || mapping.trackId.length > 80 || trackIds.has(mapping.trackId)) {
        throw new Error("Episode mappings contain an invalid or duplicate track ID");
      }
      trackIds.add(mapping.trackId);
      if (!Array.isArray(mapping.episodes) || mapping.episodes.length < 1 || mapping.episodes.length > 3) {
        throw new Error("Each track must map to between 1 and 3 episodes");
      }
      for (const episode of mapping.episodes) {
        if (!episode.seriesId.trim() || episode.seriesId.length > 200 ||
          !Number.isInteger(episode.seasonNumber) || episode.seasonNumber < 0 || episode.seasonNumber > 100 ||
          !Number.isInteger(episode.episodeNumber) || episode.episodeNumber < 0 || episode.episodeNumber > 1000 ||
          (episode.title !== undefined && episode.title.length > 500) ||
          (episode.airDate !== undefined && !isValidAirDate(episode.airDate)) ||
          (episode.notes !== undefined && episode.notes.length > 1000)) {
          throw new Error("Episode mapping contains invalid episode metadata");
        }
      }
    }
  }
}

export class SqliteDiscRecoveryRepository implements DiscRecoveryRepository {
  constructor(private readonly db: Database.Database) {}

  get(fingerprint: string): DiscRecovery | undefined {
    if (!fingerprint.trim()) throw new Error("Disc recovery lookup requires a fingerprint");
    return mapRow(this.db.prepare("SELECT * FROM disc_recovery WHERE fingerprint = ?").get(fingerprint) as
      RecoveryRow | undefined);
  }

  recordDetection(fingerprint: string, discType: DiscType, mediaType: MediaType, confidence?: number): DiscRecovery {
    if (!fingerprint.trim()) throw new Error("Disc recovery detection requires a fingerprint");
    if (!discTypes.includes(discType) || !mediaTypes.includes(mediaType)) {
      throw new Error("Disc recovery detection contains an unsupported type");
    }
    if (confidence !== undefined && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
      throw new Error("Disc recovery confidence must be between 0 and 1");
    }
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO disc_recovery (
        fingerprint, detected_disc_type, final_disc_type, detected_media_type, detected_confidence, final_media_type,
        disc_type_overridden, media_type_overridden, metadata_provider, mappings_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 'manual', '[]', ?)
      ON CONFLICT(fingerprint) DO NOTHING
    `).run(fingerprint, discType, discType, mediaType, confidence ?? null, mediaType, now);
    const recovery = this.get(fingerprint);
    if (!recovery) throw new Error(`Disc recovery record could not be loaded for ${fingerprint}`);
    return recovery;
  }

  update(fingerprint: string, patch: DiscRecoveryUpdate): DiscRecovery | undefined {
    if (!fingerprint.trim()) throw new Error("Disc recovery update requires a fingerprint");
    validatePatch(patch);
    const current = this.get(fingerprint);
    if (!current) return undefined;
    const updatedAt = new Date().toISOString();
    const updated: DiscRecovery = {
      ...current,
      ...(patch.finalDiscType === undefined ? {} : {
        finalDiscType: patch.finalDiscType,
        discTypeOverridden: patch.finalDiscType !== current.detectedDiscType
      }),
      ...(patch.finalMediaType === undefined ? {} : {
        finalMediaType: patch.finalMediaType,
        mediaTypeOverridden: patch.finalMediaType !== current.detectedMediaType
      }),
      ...(patch.metadataProvider === undefined ? {} : { metadataProvider: patch.metadataProvider }),
      ...(patch.providerId === undefined ? {} : { providerId: patch.providerId?.trim() || null }),
      ...(patch.seriesName === undefined ? {} : { seriesName: patch.seriesName?.trim() || null }),
      ...(patch.seasonNumber === undefined ? {} : { seasonNumber: patch.seasonNumber }),
      ...(patch.mappings === undefined ? {} : { mappings: patch.mappings }),
      ...(patch.notes === undefined ? {} : { notes: patch.notes?.trim() || null }),
      updatedAt
    };
    this.db.prepare(`
      UPDATE disc_recovery SET final_disc_type = ?, final_media_type = ?,
        disc_type_overridden = ?, media_type_overridden = ?, metadata_provider = ?, provider_id = ?,
        series_name = ?, season_number = ?, mappings_json = ?, notes = ?, updated_at = ?
      WHERE fingerprint = ?
    `).run(updated.finalDiscType, updated.finalMediaType, Number(updated.discTypeOverridden),
      Number(updated.mediaTypeOverridden), updated.metadataProvider, updated.providerId, updated.seriesName,
      updated.seasonNumber, JSON.stringify(updated.mappings), updated.notes, updatedAt, fingerprint);
    return this.get(fingerprint);
  }

  list(limit = 100): DiscRecovery[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error("Disc recovery list requires a limit from 1 to 1000");
    }
    const rows = this.db.prepare("SELECT * FROM disc_recovery ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as RecoveryRow[];
    return rows.map((row) => {
      const recovery = mapRow(row);
      if (!recovery) throw new Error(`Disc recovery record could not be loaded for ${row.fingerprint}`);
      return recovery;
    });
  }
}
