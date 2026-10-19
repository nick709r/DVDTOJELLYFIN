import type Database from "better-sqlite3";
import type { TvValidationEvidence, TvValidationEvidenceRepository } from "../../domain/tv-validation.js";

interface TvValidationEvidenceRow {
  id: string;
  evidence_json: string;
}

function parseEvidence(row: TvValidationEvidenceRow | undefined): TvValidationEvidence | undefined {
  if (!row) return undefined;
  const evidence = JSON.parse(row.evidence_json) as TvValidationEvidence;
  if (evidence.id !== row.id) throw new Error(`Persisted TV validation evidence ${row.id} has a mismatched ID`);
  return evidence;
}

export class SqliteTvValidationEvidenceRepository implements TvValidationEvidenceRepository {
  constructor(private readonly db: Database.Database) {}

  save(evidence: TvValidationEvidence): void {
    this.saveMany([evidence]);
  }

  saveMany(evidence: readonly TvValidationEvidence[]): void {
    for (const item of evidence) {
      if (!item.id.trim() || !item.source.fingerprint.trim()) {
        throw new Error("TV validation evidence requires an ID and disc fingerprint");
      }
      if (item.format !== "autodisc-tv-validation" || item.schemaVersion !== 1) {
        throw new Error("TV validation evidence format or schema version is unsupported");
      }
    }
    const insert = this.db.prepare(`
      INSERT INTO tv_validation_evidence (id, fingerprint, captured_at, origin, evidence_json)
      VALUES (?, ?, ?, ?, ?)
    `);
    const saveAll = this.db.transaction((items: readonly TvValidationEvidence[]) => {
      for (const item of items) {
        insert.run(item.id, item.source.fingerprint, item.capturedAt, item.origin, JSON.stringify(item));
      }
    });
    saveAll(evidence);
  }

  get(id: string): TvValidationEvidence | undefined {
    if (!id.trim()) throw new Error("TV validation evidence lookup requires an ID");
    return parseEvidence(this.db.prepare(`
      SELECT id, evidence_json FROM tv_validation_evidence WHERE id = ?
    `).get(id) as TvValidationEvidenceRow | undefined);
  }

  list(limit = 1000, offset = 0): TvValidationEvidence[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000) {
      throw new Error("TV validation evidence limit must be between 1 and 10000");
    }
    if (!Number.isInteger(offset) || offset < 0 || offset > 1000000) {
      throw new Error("TV validation evidence offset must be between 0 and 1000000");
    }
    const rows = this.db.prepare(`
      SELECT id, evidence_json FROM tv_validation_evidence
      ORDER BY captured_at, rowid LIMIT ? OFFSET ?
    `).all(limit, offset) as TvValidationEvidenceRow[];
    return rows.map((row) => {
      const evidence = parseEvidence(row);
      if (!evidence) throw new Error(`Persisted TV validation evidence ${row.id} could not be loaded`);
      return evidence;
    });
  }
}
