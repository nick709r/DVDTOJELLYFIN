import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ReviewItem, ReviewItemInput, ReviewItemRepository, ReviewStatus, ReviewSummary } from "../../domain/reviews.js";

interface ReviewRow {
  id: string;
  category: ReviewItem["category"];
  severity: ReviewItem["severity"];
  status: ReviewStatus;
  title: string;
  description: string;
  created_at: string;
  resolved_at: string | null;
  related_job_id: string | null;
  related_disc: string | null;
  disc_fingerprint: string | null;
  related_drive: string | null;
  error_details_json: string | null;
  requested_path: string | null;
  suggested_actions_json: string;
  resolution_details: string | null;
  retry_count: number;
}

function fromRow(row: ReviewRow | undefined): ReviewItem | undefined {
  if (!row) return undefined;
  return {
    id: row.id,
    category: row.category,
    severity: row.severity,
    status: row.status,
    title: row.title,
    description: row.description,
    createdAt: row.created_at,
    ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
    ...(row.related_job_id === null ? {} : { relatedJobId: row.related_job_id }),
    ...(row.related_disc === null ? {} : { relatedDisc: row.related_disc }),
    ...(row.disc_fingerprint === null ? {} : { discFingerprint: row.disc_fingerprint }),
    ...(row.related_drive === null ? {} : { relatedDrive: row.related_drive }),
    ...(row.error_details_json === null ? {} : { errorDetails: JSON.parse(row.error_details_json) as Record<string, unknown> }),
    ...(row.requested_path === null ? {} : { requestedPath: row.requested_path }),
    suggestedActions: JSON.parse(row.suggested_actions_json) as ReviewItem["suggestedActions"],
    ...(row.resolution_details === null ? {} : { resolutionDetails: row.resolution_details }),
    retryCount: row.retry_count
  };
}

const columns = `id, category, severity, status, title, description, created_at, resolved_at,
  related_job_id, related_disc, related_drive, error_details_json, requested_path,
  suggested_actions_json, resolution_details, retry_count, disc_fingerprint`;

export class SqliteReviewItemRepository implements ReviewItemRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: ReviewItemInput): ReviewItem {
    if (!input.title.trim() || !input.description.trim()) {
      throw new Error("Review item requires a title and description");
    }
    if (input.relatedJobId && input.category !== "folder_creation_failure") {
      const existing = this.db.prepare(`
        SELECT ${columns} FROM review_items
        WHERE category = ? AND related_job_id = ? AND status IN ('active', 'retrying')
        ORDER BY created_at DESC LIMIT 1
      `).get(input.category, input.relatedJobId) as ReviewRow | undefined;
      if (existing) {
        this.db.prepare(`
          UPDATE review_items SET status = 'active', resolved_at = NULL, resolution_details = NULL,
            severity = ?, title = ?, description = ?, related_disc = ?, disc_fingerprint = ?,
            related_drive = ?, error_details_json = ?, requested_path = ?, suggested_actions_json = ?
          WHERE id = ?
        `).run(input.severity, input.title, input.description, input.relatedDisc ?? null,
          input.discFingerprint ?? null, input.relatedDrive ?? null,
          input.errorDetails === undefined ? null : JSON.stringify(input.errorDetails),
          input.requestedPath ?? null, JSON.stringify(input.suggestedActions), existing.id);
        const refreshed = this.get(existing.id);
        if (!refreshed) throw new Error(`Review item ${existing.id} could not be refreshed`);
        return refreshed;
      }
    }
    if (input.category === "disc_read_error") {
      const existing = this.db.prepare(`
        SELECT ${columns} FROM review_items
        WHERE category = ? AND status = 'active' AND related_drive IS ?
          AND title = ? AND description = ?
        ORDER BY created_at DESC LIMIT 1
      `).get(input.category, input.relatedDrive ?? null, input.title, input.description) as ReviewRow | undefined;
      const item = fromRow(existing);
      if (item) return item;
    }
    if (input.category === "configuration_issue") {
      const existing = this.db.prepare(`
        SELECT ${columns} FROM review_items
        WHERE category = ? AND status IN ('active', 'retrying')
          AND title = ? AND requested_path IS ?
        ORDER BY created_at DESC LIMIT 1
      `).get(input.category, input.title, input.requestedPath ?? null) as ReviewRow | undefined;
      if (existing) {
        this.db.prepare(`
          UPDATE review_items SET status = 'active', resolved_at = NULL, resolution_details = NULL,
            severity = ?, description = ?, related_job_id = ?, related_disc = ?,
            related_drive = ?, error_details_json = ?, suggested_actions_json = ?
          WHERE id = ?
        `).run(input.severity, input.description, input.relatedJobId ?? null,
          input.relatedDisc ?? null, input.relatedDrive ?? null,
          input.errorDetails === undefined ? null : JSON.stringify(input.errorDetails),
          JSON.stringify(input.suggestedActions), existing.id);
        const refreshed = this.get(existing.id);
        if (!refreshed) throw new Error(`Review item ${existing.id} could not be refreshed`);
        return refreshed;
      }
    }
    if (input.category === "folder_creation_failure") {
      const existing = this.db.prepare(`
        SELECT ${columns} FROM review_items
        WHERE category = ? AND status IN ('active', 'retrying')
          AND disc_fingerprint IS ? AND requested_path = ?
        ORDER BY created_at DESC LIMIT 1
      `).get(input.category, input.discFingerprint ?? null, input.requestedPath ?? null) as ReviewRow | undefined;
      if (existing) {
        this.db.prepare(`
          UPDATE review_items SET status = 'active', resolved_at = NULL, resolution_details = NULL,
            severity = ?, title = ?, description = ?, related_job_id = ?, related_disc = ?,
            related_drive = ?, error_details_json = ?, suggested_actions_json = ?
          WHERE id = ?
        `).run(input.severity, input.title, input.description, input.relatedJobId ?? null,
          input.relatedDisc ?? null, input.relatedDrive ?? null,
          input.errorDetails === undefined ? null : JSON.stringify(input.errorDetails),
          JSON.stringify(input.suggestedActions), existing.id);
        const refreshed = this.get(existing.id);
        if (!refreshed) throw new Error(`Review item ${existing.id} could not be refreshed`);
        return refreshed;
      }
    }
    const item: ReviewItem = {
      ...input,
      id: randomUUID(),
      status: "active",
      createdAt: new Date().toISOString(),
      retryCount: 0
    };
    this.db.prepare(`
      INSERT INTO review_items
        (id, category, severity, status, title, description, created_at, related_job_id,
         related_disc, disc_fingerprint, related_drive, error_details_json, requested_path, suggested_actions_json, retry_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(item.id, item.category, item.severity, item.status, item.title, item.description, item.createdAt,
      item.relatedJobId ?? null, item.relatedDisc ?? null, item.discFingerprint ?? null, item.relatedDrive ?? null,
      item.errorDetails === undefined ? null : JSON.stringify(item.errorDetails),
      item.requestedPath ?? null, JSON.stringify(item.suggestedActions));
    return item;
  }

  get(id: string): ReviewItem | undefined {
    return fromRow(this.db.prepare(`SELECT ${columns} FROM review_items WHERE id = ?`).get(id) as ReviewRow | undefined);
  }

  list(options: Parameters<ReviewItemRepository["list"]>[0] = {}): ReviewItem[] {
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 ||
      !Number.isInteger(offset) || offset < 0 || offset > 1000000) {
      throw new Error("Review list pagination is invalid");
    }
    if (options.from && !Number.isFinite(Date.parse(options.from))) throw new Error("Review start date is invalid");
    if (options.to && !Number.isFinite(Date.parse(options.to))) throw new Error("Review end date is invalid");
    const filters: string[] = [];
    const values: Array<string | number> = [];
    for (const [field, value] of [
      ["category", options.category], ["severity", options.severity], ["status", options.status]
    ] as const) {
      if (value !== undefined) {
        filters.push(`${field} = ?`);
        values.push(value);
      }
    }
    if (options.from) { filters.push("created_at >= ?"); values.push(options.from); }
    if (options.to) { filters.push("created_at <= ?"); values.push(options.to); }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const rows = this.db.prepare(`
      SELECT ${columns} FROM review_items ${where}
      ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'retrying' THEN 1 ELSE 2 END,
        CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        created_at DESC LIMIT ? OFFSET ?
    `).all(...values, limit, offset) as ReviewRow[];
    return rows.map((row) => {
      const item = fromRow(row);
      if (!item) throw new Error(`Review item ${row.id} could not be loaded`);
      return item;
    });
  }

  updateStatus(id: string, status: ReviewStatus, resolutionDetails?: string): ReviewItem | undefined {
    if (status === "retrying") {
      this.db.prepare(`UPDATE review_items SET status = ?, retry_count = retry_count + 1 WHERE id = ? AND status IN ('active', 'retrying')`)
        .run(status, id);
    } else {
      const resolvedAt = status === "resolved" || status === "dismissed" ? new Date().toISOString() : null;
      this.db.prepare(`
        UPDATE review_items SET status = ?, resolved_at = ?, resolution_details = ?
        WHERE id = ? AND status IN ('active', 'retrying')
      `).run(status, resolvedAt, resolutionDetails ?? null, id);
    }
    return this.get(id);
  }

  resolveForDisc(fingerprint: string, resolutionDetails: string): number {
    if (!fingerprint.trim()) return 0;
    return this.db.prepare(`
      UPDATE review_items SET status = 'resolved', resolved_at = ?, resolution_details = ?
      WHERE disc_fingerprint = ? AND status IN ('active', 'retrying')
    `).run(new Date().toISOString(), resolutionDetails, fingerprint).changes;
  }

  summary(): ReviewSummary {
    const today = new Date().toISOString().slice(0, 10);
    return this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN status IN ('active', 'retrying') THEN 1 ELSE 0 END), 0) AS active,
        COALESCE(SUM(CASE WHEN status IN ('active', 'retrying') AND severity = 'critical' THEN 1 ELSE 0 END), 0) AS critical,
        COALESCE(SUM(CASE WHEN status IN ('active', 'retrying') AND category = 'tv_review' THEN 1 ELSE 0 END), 0) AS tv,
        COALESCE(SUM(CASE WHEN status IN ('active', 'retrying') AND category IN ('cd_review', 'metadata_issue', 'folder_creation_failure') THEN 1 ELSE 0 END), 0) AS cd,
        COALESCE(SUM(CASE WHEN status IN ('active', 'retrying') AND category IN ('processing_failure', 'disc_read_error') THEN 1 ELSE 0 END), 0) AS processingFailures,
        COALESCE(SUM(CASE WHEN status = 'resolved' AND substr(resolved_at, 1, 10) = ? THEN 1 ELSE 0 END), 0) AS resolvedToday
      FROM review_items
    `).get(today) as ReviewSummary;
  }
}
