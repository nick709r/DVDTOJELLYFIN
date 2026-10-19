import type Database from "better-sqlite3";
import type { Job, JobStatus } from "../../model.js";
import type { JobRepository } from "../../contracts/repositories.js";
import type { SqliteEventRepository } from "./event-repository.js";

export class SqliteJobRepository implements JobRepository {
  constructor(private readonly db: Database.Database, private readonly events: SqliteEventRepository) {}

  add(id: string, label: string | null, fingerprint: string | null = null, mediaKind = "dvd"): void {
    this.db.prepare("INSERT INTO jobs (id, status, media_type, disc_label, disc_fingerprint, started_at) VALUES (?, 'inspecting', ?, ?, ?, ?)")
      .run(id, mediaKind, label, fingerprint, new Date().toISOString());
    this.events.add(id, "inspecting", "info", `Media accepted (${mediaKind})`);
  }

  setStatus(id: string, status: JobStatus, message: string): void {
    this.db.prepare("UPDATE jobs SET status = ?, progress = CASE WHEN ? = 'completed' THEN 100 ELSE progress END WHERE id = ?")
      .run(status, status, id);
    this.events.add(id, status, status === "failed" ? "error" : "info", message);
  }

  update(id: string, patch: Partial<Pick<Job, "title" | "outputPath" | "encoder" | "outputBytes" | "progress" | "conversionSeconds">>): void {
    const columns: string[] = [];
    const values: unknown[] = [];
    const mapping: Record<string, string> = {
      title: "title",
      outputPath: "output_path",
      encoder: "encoder",
      outputBytes: "output_bytes",
      progress: "progress",
      conversionSeconds: "conversion_seconds"
    };
    for (const [property, column] of Object.entries(mapping)) {
      if (patch[property as keyof typeof patch] !== undefined) {
        columns.push(`${column} = ?`);
        values.push(patch[property as keyof typeof patch]);
      }
    }
    if (columns.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE jobs SET ${columns.join(", ")} WHERE id = ?`).run(...values);
  }

  finish(id: string, status: "completed" | "failed" | "cancelled" | "interrupted", error: string | null, fingerprint?: string): void {
    const now = new Date().toISOString();
    const finish = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE jobs SET status = ?, error = ?, finished_at = ?,
          duration_seconds = MAX(0, (julianday(?) - julianday(started_at)) * 86400),
          progress = CASE WHEN ? = 'completed' THEN 100 ELSE progress END
        WHERE id = ?
      `).run(status, error, now, now, status, id);
      if (status === "completed" && fingerprint) {
        this.db.prepare("UPDATE drive_state SET last_fingerprint = ?, processed_at = ? WHERE id = 1")
          .run(fingerprint, now);
      }
      this.events.add(id, status, status === "failed" ? "error" : "info", error ?? "Completed successfully");
    });
    finish();
  }

  active(): Job | null {
    return this.db.prepare(`
      SELECT id, status, media_type AS mediaType, disc_label AS discLabel, title, output_path AS outputPath,
        encoder, output_bytes AS outputBytes, started_at AS startedAt,
        finished_at AS finishedAt, duration_seconds AS durationSeconds,
        conversion_seconds AS conversionSeconds, progress, error
      FROM jobs WHERE status IN ('inspecting', 'ripping', 'converting', 'publishing')
      ORDER BY started_at DESC LIMIT 1
    `).get() as Job | undefined ?? null;
  }

  addWarning(id: string, message: string): void {
    this.db.prepare("UPDATE jobs SET error = ? WHERE id = ?").run(message.slice(0, 1000), id);
    this.events.add(id, "warning", "warn", message);
  }
}
