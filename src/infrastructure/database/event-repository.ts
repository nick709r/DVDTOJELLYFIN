import type Database from "better-sqlite3";
import type { EventRepository } from "../../contracts/repositories.js";

export interface JobEventRecord {
  at: string;
  stage: string;
  level: string;
  message: string;
}

export class SqliteEventRepository implements EventRepository {
  constructor(private readonly db: Database.Database) {}

  add(jobId: string, stage: string, level: string, message: string): void {
    this.db.prepare("INSERT INTO job_events (job_id, at, stage, level, message) VALUES (?, ?, ?, ?, ?)")
      .run(jobId, new Date().toISOString(), stage, level, message.slice(0, 1000));
  }

  list(jobId: string): JobEventRecord[] {
    return this.db.prepare("SELECT at, stage, level, message FROM job_events WHERE job_id = ? ORDER BY id")
      .all(jobId) as JobEventRecord[];
  }
}
