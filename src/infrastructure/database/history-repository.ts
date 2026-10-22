import type Database from "better-sqlite3";
import type { HistoryRepository } from "../../contracts/repositories.js";
import type { Job } from "../../model.js";

export class SqliteHistoryRepository implements HistoryRepository {
  constructor(private readonly db: Database.Database) {}

  list(limit = 100): Job[] {
    return this.db.prepare(`
      SELECT id, status, media_type AS mediaType, disc_label AS discLabel, title, output_path AS outputPath,
        encoder, output_bytes AS outputBytes, started_at AS startedAt,
        finished_at AS finishedAt, duration_seconds AS durationSeconds,
        conversion_seconds AS conversionSeconds, progress, error
      FROM jobs WHERE status != 'deleted' ORDER BY started_at DESC LIMIT ?
    `).all(limit) as Job[];
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM jobs WHERE id = ? AND status NOT IN ('inspecting', 'ripping', 'converting', 'publishing')")
      .run(id).changes > 0;
  }

  stats(): { total: number; successful: number; failures: number; averageSeconds: number | null } {
    return this.db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS successful,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures,
        AVG(CASE WHEN status = 'completed' THEN conversion_seconds END) AS averageSeconds
      FROM jobs WHERE status IN ('completed', 'failed')
    `).get() as { total: number; successful: number; failures: number; averageSeconds: number | null };
  }

  statsByMediaType(): Array<{ mediaType: string; total: number; successful: number; failures: number; averageSeconds: number | null }> {
    return this.db.prepare(`
      SELECT media_type AS mediaType, COUNT(*) AS total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS successful,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures,
        AVG(CASE WHEN status = 'completed' THEN conversion_seconds END) AS averageSeconds
      FROM jobs WHERE status IN ('completed', 'failed')
      GROUP BY media_type ORDER BY media_type
    `).all() as Array<{ mediaType: string; total: number; successful: number; failures: number; averageSeconds: number | null }>;
  }

  get(id: string): Job | undefined {
    return this.db.prepare(`
      SELECT id, status, media_type AS mediaType, disc_label AS discLabel, title, output_path AS outputPath,
        encoder, output_bytes AS outputBytes, started_at AS startedAt,
        finished_at AS finishedAt, duration_seconds AS durationSeconds,
        conversion_seconds AS conversionSeconds, progress, error
      FROM jobs WHERE id = ? AND status != 'deleted'
    `).get(id) as Job | undefined;
  }

  timeline(id: string): Array<{ at: string; stage: string; level: string; message: string }> {
    return this.db.prepare("SELECT at, stage, level, message FROM job_events WHERE job_id = ? ORDER BY id")
      .all(id) as Array<{ at: string; stage: string; level: string; message: string }>;
  }

  dailyStats(days: number): unknown[] {
    return this.db.prepare(`
      SELECT date(started_at) AS day,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS successful,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures,
        AVG(CASE WHEN status = 'completed' THEN conversion_seconds END) AS averageSeconds
      FROM jobs
      WHERE started_at >= datetime('now', ?)
      GROUP BY date(started_at) ORDER BY day
    `).all(`-${days} days`) as unknown[];
  }
}
