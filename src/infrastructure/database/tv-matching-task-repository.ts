import type Database from "better-sqlite3";
import type {
  TvMatchingAssignment,
  TvMatchingStatus,
  TvMatchingTask,
  TvMatchingTaskInput,
  TvMatchingTaskRepository
} from "../../domain/tv-matching.js";
import type { MediaCandidate } from "../../domain/media.js";

interface TaskRow {
  job_id: string;
  fingerprint: string;
  status: TvMatchingStatus;
  staging_path: string;
  source_json: string;
  diagnostics_json: string;
  files_json: string;
  assignments_json: string;
  failure: string | null;
  created_at: string;
  updated_at: string;
}

const columns = `job_id, fingerprint, status, staging_path, source_json, diagnostics_json,
  files_json, assignments_json, failure, created_at, updated_at`;

function fromRow(row: TaskRow | undefined): TvMatchingTask | undefined {
  if (!row) return undefined;
  return {
    jobId: row.job_id,
    fingerprint: row.fingerprint,
    status: row.status,
    stagingPath: row.staging_path,
    source: JSON.parse(row.source_json) as MediaCandidate,
    diagnostics: JSON.parse(row.diagnostics_json) as Record<string, unknown>,
    files: JSON.parse(row.files_json) as Record<string, string>,
    assignments: JSON.parse(row.assignments_json) as TvMatchingAssignment[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.failure ? { failure: row.failure } : {})
  };
}

export class SqliteTvMatchingTaskRepository implements TvMatchingTaskRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: TvMatchingTaskInput): TvMatchingTask {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO tv_matching_tasks
        (job_id, fingerprint, status, staging_path, source_json, diagnostics_json, files_json,
         assignments_json, failure, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.jobId, input.fingerprint, input.status, input.stagingPath, JSON.stringify(input.source),
      JSON.stringify(input.diagnostics), JSON.stringify(input.files), JSON.stringify(input.assignments),
      input.failure ?? null, now, now);
    const task = this.get(input.jobId);
    if (!task) throw new Error(`TV matching task ${input.jobId} could not be loaded after creation`);
    return task;
  }

  get(jobId: string): TvMatchingTask | undefined {
    return fromRow(this.db.prepare(`SELECT ${columns} FROM tv_matching_tasks WHERE job_id = ?`).get(jobId) as
      TaskRow | undefined);
  }

  list(): TvMatchingTask[] {
    return (this.db.prepare(`SELECT ${columns} FROM tv_matching_tasks
      WHERE status != 'completed' ORDER BY created_at ASC`).all() as TaskRow[]).map((row) => {
      const task = fromRow(row);
      if (!task) throw new Error(`TV matching task ${row.job_id} could not be loaded`);
      return task;
    });
  }

  update(jobId: string, patch: Partial<Pick<TvMatchingTask,
    "status" | "stagingPath" | "diagnostics" | "files" | "assignments">> & { failure?: string | null }): TvMatchingTask | undefined {
    const values: unknown[] = [];
    const assignments: string[] = [];
    const fields: Array<[keyof typeof patch, string]> = [
      ["status", "status"],
      ["stagingPath", "staging_path"],
      ["diagnostics", "diagnostics_json"],
      ["files", "files_json"],
      ["assignments", "assignments_json"],
      ["failure", "failure"]
    ];
    for (const [key, column] of fields) {
      const value = patch[key];
      if (value === undefined) continue;
      assignments.push(`${column} = ?`);
      values.push(key === "diagnostics" || key === "files" || key === "assignments"
        ? JSON.stringify(value) : value);
    }
    if (assignments.length) {
      assignments.push("updated_at = ?");
      values.push(new Date().toISOString(), jobId);
      this.db.prepare(`UPDATE tv_matching_tasks SET ${assignments.join(", ")} WHERE job_id = ?`).run(...values);
    }
    return this.get(jobId);
  }

  delete(jobId: string): boolean {
    return this.db.prepare("DELETE FROM tv_matching_tasks WHERE job_id = ?").run(jobId).changes > 0;
  }

  deleteTemporaryRecords(jobId: string, fingerprint: string): boolean {
    const remove = this.db.transaction(() => {
      const task = this.db.prepare("SELECT 1 FROM tv_matching_tasks WHERE job_id = ?").get(jobId);
      if (!task) return false;
      this.db.prepare("DELETE FROM review_items WHERE related_job_id = ?").run(jobId);
      this.db.prepare("DELETE FROM tv_processing_plans WHERE fingerprint = ?").run(fingerprint);
      this.db.prepare("DELETE FROM tv_episode_feedback WHERE fingerprint = ?").run(fingerprint);
      this.db.prepare("DELETE FROM tv_validation_evidence WHERE fingerprint = ?").run(fingerprint);
      this.db.prepare(`DELETE FROM disc_recovery WHERE fingerprint = ?
        AND identified_by IS NULL AND mappings_json = '[]'`).run(fingerprint);
      this.db.prepare("DELETE FROM job_events WHERE job_id = ?").run(jobId);
      this.db.prepare("DELETE FROM tv_matching_tasks WHERE job_id = ?").run(jobId);
      this.db.prepare(`UPDATE jobs SET status = 'deleted', title = NULL, output_path = NULL,
        encoder = NULL, output_bytes = NULL, progress = 0, error = 'Deleted unmatched TV disc',
        finished_at = ?, duration_seconds = NULL, conversion_seconds = NULL
        WHERE id = ?`).run(new Date().toISOString(), jobId);
      return true;
    });
    return remove();
  }
}
