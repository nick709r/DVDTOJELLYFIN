import type Database from "better-sqlite3";
import type { RecoveryRepository } from "../../contracts/repositories.js";
import type { SqliteEventRepository } from "./event-repository.js";
import type { ClassificationAuditRepository } from "../../domain/classification.js";

export class SqliteRecoveryRepository implements RecoveryRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly events: SqliteEventRepository,
    private readonly audit?: ClassificationAuditRepository
  ) {}

  interruptedOutputs(): Array<{ id: string; outputPath: string; mediaType: string }> {
    return this.db.prepare(`
      SELECT id, output_path AS outputPath, media_type AS mediaType FROM jobs
      WHERE status = 'interrupted' AND output_path IS NOT NULL
    `).all() as Array<{ id: string; outputPath: string; mediaType: string }>;
  }

  interruptedJobs(): Array<{ id: string; outputPath: string | null; mediaType: string; discFingerprint: string | null }> {
    return this.db.prepare(`
      SELECT id, output_path AS outputPath, media_type AS mediaType,
        disc_fingerprint AS discFingerprint
      FROM jobs WHERE status = 'interrupted'
    `).all() as Array<{ id: string; outputPath: string | null; mediaType: string; discFingerprint: string | null }>;
  }

  jobIds(): string[] {
    return (this.db.prepare("SELECT id FROM jobs").all() as Array<{ id: string }>).map((row) => row.id);
  }

  recoverPublished(id: string, outputBytes: number): boolean {
    const now = new Date().toISOString();
    const recover = this.db.transaction(() => {
      const updated = this.db.prepare(`
        UPDATE jobs SET status = 'completed', output_bytes = ?, error = NULL,
          finished_at = ?, duration_seconds = MAX(0, (julianday(?) - julianday(started_at)) * 86400),
          progress = 100
        WHERE id = ? AND status = 'interrupted'
      `).run(outputBytes, now, now, id);
      if (updated.changes !== 1) return false;
      const fingerprint = this.db.prepare("SELECT disc_fingerprint AS value FROM jobs WHERE id = ?")
        .get(id) as { value: string | null } | undefined;
      if (fingerprint?.value) {
        this.db.prepare("UPDATE drive_state SET last_fingerprint = ?, processed_at = ? WHERE id = 1")
          .run(fingerprint.value, now);
        this.db.prepare(`
          UPDATE review_items SET status = 'resolved', resolved_at = ?, resolution_details = ?
          WHERE disc_fingerprint = ? AND status IN ('active', 'retrying')
        `).run(now, "Related disc processing completed successfully", fingerprint.value);
      }
      this.audit?.setProcessingStatus(id, "completed");
      this.events.add(id, "completed", "info", "Recovered validated media published before service restart");
      return true;
    });
    return recover();
  }

  failInterrupted(id: string, reason: string): boolean {
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE jobs SET status = 'failed', error = ?, finished_at = ?,
          duration_seconds = MAX(0, (julianday(?) - julianday(started_at)) * 86400)
        WHERE id = ? AND status = 'interrupted'
      `).run(reason.slice(0, 1000), now, now, id);
      if (result.changes !== 1) return false;
      this.audit?.setProcessingStatus(id, "failed");
      this.events.add(id, "failed", "error", reason);
      return true;
    })();
  }

  lastDiscFingerprint(): string | null {
    const row = this.db.prepare("SELECT last_fingerprint AS fingerprint FROM drive_state WHERE id = 1")
      .get() as { fingerprint: string | null } | undefined;
    return row?.fingerprint ?? null;
  }

  clearInsertedDisc(): void {
    this.db.prepare("UPDATE drive_state SET last_fingerprint = NULL, processed_at = NULL WHERE id = 1").run();
  }
}
