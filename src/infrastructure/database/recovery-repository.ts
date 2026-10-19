import type Database from "better-sqlite3";
import type { RecoveryRepository } from "../../contracts/repositories.js";
import type { SqliteEventRepository } from "./event-repository.js";

export class SqliteRecoveryRepository implements RecoveryRepository {
  constructor(private readonly db: Database.Database, private readonly events: SqliteEventRepository) {}

  interruptedOutputs(): Array<{ id: string; outputPath: string; mediaType: string }> {
    return this.db.prepare(`
      SELECT id, output_path AS outputPath, media_type AS mediaType FROM jobs
      WHERE status = 'interrupted' AND output_path IS NOT NULL
        AND error = 'Service restarted while this job was active'
    `).all() as Array<{ id: string; outputPath: string; mediaType: string }>;
  }

  recoverPublished(id: string, outputBytes: number): void {
    const now = new Date().toISOString();
    const recover = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE jobs SET status = 'completed', output_bytes = ?, error = NULL,
          finished_at = ?, duration_seconds = MAX(0, (julianday(?) - julianday(started_at)) * 86400),
          progress = 100
        WHERE id = ? AND status = 'interrupted'
      `).run(outputBytes, now, now, id);
      const fingerprint = this.db.prepare("SELECT disc_fingerprint AS value FROM jobs WHERE id = ?")
        .get(id) as { value: string | null } | undefined;
      if (fingerprint?.value) {
        this.db.prepare("UPDATE drive_state SET last_fingerprint = ?, processed_at = ? WHERE id = 1")
          .run(fingerprint.value, now);
      }
      this.events.add(id, "completed", "info", "Recovered validated media published before service restart");
    });
    recover();
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
