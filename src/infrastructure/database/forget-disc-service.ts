import type Database from "better-sqlite3";
import type { ForgetDiscResult, ForgetDiscService } from "../../contracts/repositories.js";

const ACTIVE = ["inspecting", "ripping", "converting", "publishing"];

export class SqliteForgetDiscService implements ForgetDiscService {
  constructor(private readonly db: Database.Database) {}

  forgetDisc(discId: string): ForgetDiscResult {
    const tx = this.db.transaction(() => {
      const job = this.db.prepare("SELECT id, status, disc_fingerprint AS fingerprint FROM jobs WHERE id = ?")
        .get(discId) as { id: string; status: string; fingerprint: string | null } | undefined;
      const fingerprint = job?.fingerprint || (job ? null : discId);
      const jobs = (fingerprint
        ? this.db.prepare("SELECT id, status FROM jobs WHERE id = ? OR disc_fingerprint = ?").all(discId, fingerprint)
        : job ? [{ id: job.id, status: job.status }] : []) as Array<{ id: string; status: string }>;
      const represented = job || (fingerprint && this.db.prepare(`
        SELECT 1 FROM jobs WHERE disc_fingerprint = ?
        UNION ALL SELECT 1 FROM review_items WHERE disc_fingerprint = ?
        UNION ALL SELECT 1 FROM disc_recovery WHERE fingerprint = ?
        UNION ALL SELECT 1 FROM tv_matching_tasks WHERE fingerprint = ?
        UNION ALL SELECT 1 FROM tv_episode_feedback WHERE fingerprint = ?
        UNION ALL SELECT 1 FROM tv_processing_plans WHERE fingerprint = ?
        UNION ALL SELECT 1 FROM tv_validation_evidence WHERE fingerprint = ?
        UNION ALL SELECT 1 FROM drive_state WHERE last_fingerprint = ?
        LIMIT 1
      `).get(fingerprint, fingerprint, fingerprint, fingerprint, fingerprint, fingerprint, fingerprint, fingerprint));
      if (!represented) throw new Error("Disc not found");
      if (jobs.some((row) => ACTIVE.includes(row.status))) throw new Error("An active disc job cannot be forgotten");

      const ids = jobs.map((row) => row.id);
      const counts: Record<string, number> = {};
      const run = (name: string, sql: string, ...params: unknown[]) => {
        counts[name] = (counts[name] ?? 0) + this.db.prepare(sql).run(...params).changes;
      };
      for (const id of ids) {
        run("reviewItems", "DELETE FROM review_items WHERE related_job_id = ?", id);
        run("reviewJobs", "DELETE FROM review_jobs WHERE original_job_id = ?", id);
        run("tvMatchingTasks", "DELETE FROM tv_matching_tasks WHERE job_id = ?", id);
        run("classificationAudit", "DELETE FROM disk_classification_audit WHERE job_id = ?", id);
        run("processingLogs", "DELETE FROM job_events WHERE job_id = ?", id);
      }
      if (fingerprint) {
        run("reviewItems", "DELETE FROM review_items WHERE disc_fingerprint = ?", fingerprint);
        run("tvMatchingTasks", "DELETE FROM tv_matching_tasks WHERE fingerprint = ?", fingerprint);
        run("tvEpisodeFeedback", "DELETE FROM tv_episode_feedback WHERE fingerprint = ?", fingerprint);
        run("tvProcessingPlans", "DELETE FROM tv_processing_plans WHERE fingerprint = ?", fingerprint);
        run("tvValidationEvidence", "DELETE FROM tv_validation_evidence WHERE fingerprint = ?", fingerprint);
      }
      for (const id of ids) run("jobs", "DELETE FROM jobs WHERE id = ?", id);
      if (fingerprint) {
        run("discRecovery", "DELETE FROM disc_recovery WHERE fingerprint = ?", fingerprint);
        run("driveState", "UPDATE drive_state SET last_fingerprint = NULL, processed_at = NULL WHERE last_fingerprint = ?", fingerprint);
      }
      return { discId, fingerprint: fingerprint || null, removed: counts };
    });
    return tx();
  }
}
