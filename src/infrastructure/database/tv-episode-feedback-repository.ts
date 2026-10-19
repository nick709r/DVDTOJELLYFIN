import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  Episode,
  TvEpisodeFeedback,
  TvEpisodeFeedbackInput,
  TvEpisodeFeedbackRepository
} from "../../domain/television.js";

interface TvEpisodeFeedbackRow {
  id: string;
  fingerprint: string;
  item_signature: string;
  outcome: TvEpisodeFeedback["outcome"];
  episodes_json: string;
  reason: string | null;
  created_at: string;
}

function toFeedback(row: TvEpisodeFeedbackRow): TvEpisodeFeedback {
  const episodes = JSON.parse(row.episodes_json) as Episode[];
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    itemSignature: row.item_signature,
    outcome: row.outcome,
    episodes,
    ...(row.reason === null ? {} : { reason: row.reason }),
    createdAt: row.created_at
  };
}

function validateFeedback(feedback: TvEpisodeFeedbackInput): void {
  if (!feedback.fingerprint.trim() || !feedback.itemSignature.trim()) {
    throw new Error("TV episode feedback requires a fingerprint and item signature");
  }
  if (!["accepted", "rejected", "manual-assignment"].includes(feedback.outcome)) {
    throw new Error("TV episode feedback outcome is invalid");
  }
  if (feedback.episodes.length === 0) {
    throw new Error("TV episode feedback requires at least one episode");
  }
  if (feedback.outcome !== "manual-assignment" && feedback.episodes.length !== 1) {
    throw new Error("Accepted and rejected feedback must reference exactly one episode");
  }
  for (const episode of feedback.episodes) {
    if (!episode.seriesId.trim() || !Number.isInteger(episode.seasonNumber) ||
      episode.seasonNumber < 0 || !Number.isInteger(episode.episodeNumber) || episode.episodeNumber < 0) {
      throw new Error("TV episode feedback contains an invalid episode identity");
    }
  }
  if (feedback.reason !== undefined && feedback.reason.length > 2000) {
    throw new Error("TV episode feedback reason must not exceed 2000 characters");
  }
}

export class SqliteTvEpisodeFeedbackRepository implements TvEpisodeFeedbackRepository {
  constructor(private readonly db: Database.Database) {}

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM tv_episode_feedback").get() as { count: number }).count;
  }

  record(feedback: TvEpisodeFeedbackInput): TvEpisodeFeedback {
    validateFeedback(feedback);
    const now = new Date().toISOString();
    const latestCapturedEvidence = this.db.prepare(`
      SELECT MAX(captured_at) AS captured_at
      FROM tv_validation_evidence WHERE fingerprint = ? AND origin = 'captured'
    `).get(feedback.fingerprint) as { captured_at: string | null };
    const afterEvidence = latestCapturedEvidence.captured_at &&
      now <= latestCapturedEvidence.captured_at
      ? new Date(Date.parse(latestCapturedEvidence.captured_at) + 1).toISOString()
      : now;
    const result: TvEpisodeFeedback = {
      ...feedback,
      id: randomUUID(),
      createdAt: afterEvidence
    };
    this.db.prepare(`
      INSERT INTO tv_episode_feedback
        (id, fingerprint, item_signature, outcome, episodes_json, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      result.id,
      result.fingerprint,
      result.itemSignature,
      result.outcome,
      JSON.stringify(result.episodes),
      result.reason ?? null,
      result.createdAt
    );
    return result;
  }

  findForItemSignature(itemSignature: string, limit = 100): TvEpisodeFeedback[] {
    if (!itemSignature.trim()) throw new Error("TV episode feedback lookup requires an item signature");
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error("TV episode feedback limit must be between 1 and 1000");
    }
    const rows = this.db.prepare(`
      SELECT id, fingerprint, item_signature, outcome, episodes_json, reason, created_at
      FROM tv_episode_feedback WHERE item_signature = ?
      ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(itemSignature, limit) as TvEpisodeFeedbackRow[];
    return rows.map(toFeedback);
  }

  listForFingerprint(fingerprint: string): TvEpisodeFeedback[] {
    if (!fingerprint.trim()) throw new Error("TV episode feedback lookup requires a fingerprint");
    const rows = this.db.prepare(`
      SELECT id, fingerprint, item_signature, outcome, episodes_json, reason, created_at
      FROM tv_episode_feedback WHERE fingerprint = ?
      ORDER BY created_at, rowid
    `).all(fingerprint) as TvEpisodeFeedbackRow[];
    return rows.map(toFeedback);
  }
}
