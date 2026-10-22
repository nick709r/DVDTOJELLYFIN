import type Database from "better-sqlite3";
import type { ReviewJob, ReviewJobInput, ReviewJobRepository, ReviewJobStatus, ReviewResumeStage } from "../../domain/review-jobs.js";

interface ReviewJobRow {
  id: string;
  original_job_id: string;
  status: ReviewJobStatus;
  disc_type: string;
  disc_label: string | null;
  failure_reason: string;
  failure_stage: string;
  storage_path: string;
  media_size: number;
  created_at: string;
  updated_at: string;
  resume_stage: ReviewResumeStage;
  metadata_json: string;
  notification_active: number;
}

const columns = `id, original_job_id, status, disc_type, disc_label, failure_reason, failure_stage,
  storage_path, media_size, created_at, updated_at, resume_stage, metadata_json, notification_active`;

function fromRow(row: ReviewJobRow | undefined): ReviewJob | undefined {
  if (!row) return undefined;
  return {
    id: row.id,
    originalJobId: row.original_job_id,
    status: row.status,
    discType: row.disc_type,
    discLabel: row.disc_label,
    failureReason: row.failure_reason,
    failureStage: row.failure_stage,
    storagePath: row.storage_path,
    mediaSize: row.media_size,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resumeStage: row.resume_stage,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    notificationActive: row.notification_active === 1
  };
}

export class SqliteReviewJobRepository implements ReviewJobRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: ReviewJobInput): ReviewJob {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO review_jobs
        (id, original_job_id, status, disc_type, disc_label, failure_reason, failure_stage,
         storage_path, media_size, created_at, updated_at, resume_stage, metadata_json, notification_active)
      VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET
        status = 'pending', disc_type = excluded.disc_type, disc_label = excluded.disc_label,
        failure_reason = excluded.failure_reason, failure_stage = excluded.failure_stage,
        storage_path = excluded.storage_path, media_size = excluded.media_size,
        updated_at = excluded.updated_at, resume_stage = excluded.resume_stage,
        metadata_json = excluded.metadata_json, notification_active = 1
    `).run(input.id, input.originalJobId, input.discType, input.discLabel, input.failureReason,
      input.failureStage, input.storagePath, input.mediaSize, now, now, input.resumeStage,
      JSON.stringify(input.metadata));
    const item = this.get(input.id);
    if (!item) throw new Error(`Review job ${input.id} could not be loaded after creation`);
    return item;
  }

  get(id: string): ReviewJob | undefined {
    return fromRow(this.db.prepare(`SELECT ${columns} FROM review_jobs WHERE id = ?`).get(id) as ReviewJobRow | undefined);
  }

  list(): ReviewJob[] {
    return (this.db.prepare(`
      SELECT ${columns} FROM review_jobs
      ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'retrying' THEN 1 ELSE 2 END, created_at DESC
    `).all() as ReviewJobRow[]).map((row) => {
      const item = fromRow(row);
      if (!item) throw new Error(`Review job ${row.id} could not be loaded`);
      return item;
    });
  }

  update(id: string, patch: Parameters<ReviewJobRepository["update"]>[1]): ReviewJob | undefined {
    const fields: Record<string, string> = {
      status: "status",
      failureReason: "failure_reason",
      failureStage: "failure_stage",
      mediaSize: "media_size",
      resumeStage: "resume_stage",
      metadata: "metadata_json",
      notificationActive: "notification_active"
    };
    const assignments: string[] = [];
    const values: Array<string | number> = [];
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      const column = fields[key];
      if (!column) continue;
      assignments.push(`${column} = ?`);
      values.push(key === "metadata" ? JSON.stringify(value) : key === "notificationActive" ? Number(value) : value as string | number);
    }
    if (assignments.length) {
      assignments.push("updated_at = ?");
      values.push(new Date().toISOString(), id);
      this.db.prepare(`UPDATE review_jobs SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
    }
    return this.get(id);
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM review_jobs WHERE id = ?").run(id).changes > 0;
  }
}
