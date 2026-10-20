import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  LOW_CONFIDENCE_THRESHOLD, OVERRIDE_REASONS,
  type ClassificationAuditRecord, type ClassificationAuditRepository, type ClassificationDetectionInput,
  type ClassificationMetrics, type ClassificationReviewInput, type ClassificationReviewStatus, type OverrideReason
} from "../../domain/classification.js";

interface Row {
  id: string; job_id: string | null; created_at: string; disk_name: string; detected_type: string;
  final_type: string; confidence: number | null; review_status: ClassificationReviewStatus;
  processing_status: string; override_reason: OverrideReason | null; notes: string | null; reviewed_at: string | null;
}

const COLUMNS = `id, job_id, created_at, disk_name, detected_type, final_type, confidence,
  review_status, processing_status, override_reason, notes, reviewed_at`;
const TYPE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function normalizeDiskType(value: unknown, field: string): string {
  const type = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!TYPE_PATTERN.test(type)) throw new Error(`${field} must be a short identifier such as "dvd" or "bluray"`);
  return type;
}

function toRecord(row: Row): ClassificationAuditRecord {
  return {
    id: row.id, jobId: row.job_id, timestamp: row.created_at, diskName: row.disk_name,
    detectedType: row.detected_type, finalType: row.final_type, confidence: row.confidence,
    reviewStatus: row.review_status, processingStatus: row.processing_status,
    overrideReason: row.override_reason, notes: row.notes, reviewedAt: row.reviewed_at
  };
}

/**
 * Append-only audit store. Rows are never deleted (not even when job history is removed),
 * and detected_type is never modified after insertion.
 */
export class SqliteClassificationAuditRepository implements ClassificationAuditRepository {
  constructor(private readonly db: Database.Database) {}

  recordDetection(input: ClassificationDetectionInput): ClassificationAuditRecord {
    const detected = normalizeDiskType(input.detectedType, "detectedType");
    const confidence = input.confidence ?? null;
    if (confidence !== null && (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
      throw new Error("confidence must be between 0 and 1");
    }
    const needsReview = detected === "unknown" || (confidence !== null && confidence < LOW_CONFIDENCE_THRESHOLD);
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO disk_classification_audit
        (id, job_id, created_at, disk_name, detected_type, final_type, confidence, review_status, processing_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'inspecting')
    `).run(id, input.jobId, new Date().toISOString(), input.diskName.trim() || "Unknown disc",
      detected, detected, confidence, needsReview ? "review_required" : "auto_accepted");
    return this.get(id) as ClassificationAuditRecord;
  }

  setProcessingStatus(jobId: string, status: string): void {
    this.db.prepare("UPDATE disk_classification_audit SET processing_status = ? WHERE job_id = ?").run(status, jobId);
  }

  review(id: string, input: ClassificationReviewInput): ClassificationAuditRecord {
    const existing = this.get(id);
    if (!existing) throw new Error("Classification audit record not found");
    const finalType = normalizeDiskType(input.finalType, "finalType");
    const notes = input.notes?.trim() || null;
    if (notes && notes.length > 2000) throw new Error("notes must not exceed 2000 characters");
    const changed = finalType !== existing.detectedType;
    let reason: OverrideReason | null = null;
    if (changed) {
      if (!input.overrideReason || !(OVERRIDE_REASONS as readonly string[]).includes(input.overrideReason)) {
        throw new Error(`overrideReason is required when changing the type and must be one of: ${OVERRIDE_REASONS.join(", ")}`);
      }
      reason = input.overrideReason as OverrideReason;
      if (reason === "custom" && !notes) throw new Error("notes are required when the override reason is custom");
    }
    this.db.prepare(`
      UPDATE disk_classification_audit
      SET final_type = ?, review_status = ?, override_reason = ?, notes = ?, reviewed_at = ?
      WHERE id = ?
    `).run(finalType, changed ? "manually_corrected" : "reviewed_no_change", reason, notes, new Date().toISOString(), id);
    return this.get(id) as ClassificationAuditRecord;
  }

  get(id: string): ClassificationAuditRecord | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM disk_classification_audit WHERE id = ?`).get(id) as Row | undefined;
    return row && toRecord(row);
  }

  getByJob(jobId: string): ClassificationAuditRecord | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM disk_classification_audit WHERE job_id = ?`).get(jobId) as Row | undefined;
    return row && toRecord(row);
  }

  list(options: { limit?: number; offset?: number; newestFirst?: boolean } = {}): ClassificationAuditRecord[] {
    const limit = Math.max(1, Math.min(100000, Math.trunc(options.limit ?? 1000)));
    const offset = Math.max(0, Math.trunc(options.offset ?? 0));
    const order = options.newestFirst ? "DESC" : "ASC";
    const rows = this.db.prepare(`
      SELECT ${COLUMNS} FROM disk_classification_audit ORDER BY created_at ${order}, rowid ${order} LIMIT ? OFFSET ?
    `).all(limit, offset) as Row[];
    return rows.map(toRecord);
  }

  metrics(): ClassificationMetrics {
    const counts = this.db.prepare(`
      SELECT review_status AS status, COUNT(*) AS count FROM disk_classification_audit GROUP BY review_status
    `).all() as Array<{ status: ClassificationReviewStatus; count: number }>;
    const by = (status: ClassificationReviewStatus): number => counts.find((c) => c.status === status)?.count ?? 0;
    const corrections = this.db.prepare(`
      SELECT detected_type AS "from", final_type AS "to", COUNT(*) AS count
      FROM disk_classification_audit WHERE review_status = 'manually_corrected'
      GROUP BY detected_type, final_type ORDER BY count DESC, detected_type, final_type
    `).all() as ClassificationMetrics["corrections"];
    return {
      totalProcessed: counts.reduce((sum, c) => sum + c.count, 0),
      autoAccepted: by("auto_accepted"),
      reviewed: by("reviewed_no_change") + by("manually_corrected"),
      manualCorrections: by("manually_corrected"),
      reviewRequired: by("review_required"),
      corrections
    };
  }
}
