import type Database from "better-sqlite3";
import type { AppSettings } from "../../model.js";

export function migrateDatabase(db: Database.Database, defaults: AppSettings): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      media_type TEXT NOT NULL DEFAULT 'dvd',
      disc_fingerprint TEXT,
      disc_label TEXT,
      title TEXT,
      output_path TEXT,
      encoder TEXT,
      output_bytes INTEGER,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      duration_seconds REAL,
      conversion_seconds REAL,
      progress REAL NOT NULL DEFAULT 0,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS jobs_started_at ON jobs(started_at DESC);
    CREATE INDEX IF NOT EXISTS jobs_status_started_at ON jobs(status, started_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_job
      ON jobs((1)) WHERE status IN ('inspecting', 'ripping', 'converting', 'publishing');
    CREATE TABLE IF NOT EXISTS job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      at TEXT NOT NULL,
      stage TEXT NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS job_events_job_id ON job_events(job_id, id);
  `);

  const existingSettings = db.prepare("SELECT COUNT(*) AS count FROM settings").get() as { count: number };
  if (existingSettings.count === 0) {
    const insertSetting = db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)");
    const now = new Date().toISOString();
    const insertDefaults = db.transaction(() => {
      for (const [key, value] of Object.entries(defaults)) {
        insertSetting.run(key, JSON.stringify(value), now);
      }
    });
    insertDefaults();
  }

  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, ?)")
    .run(new Date().toISOString());
  const jobColumns = db.pragma("table_info(jobs)") as Array<{ name: string }>;
  if (!jobColumns.some((column) => column.name === "conversion_seconds")) {
    db.exec("ALTER TABLE jobs ADD COLUMN conversion_seconds REAL");
  }
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (2, ?)")
    .run(new Date().toISOString());
  const currentJobColumns = db.pragma("table_info(jobs)") as Array<{ name: string }>;
  if (!currentJobColumns.some((column) => column.name === "disc_fingerprint")) {
    db.exec("ALTER TABLE jobs ADD COLUMN disc_fingerprint TEXT");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS drive_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_fingerprint TEXT,
      processed_at TEXT
    );
    INSERT OR IGNORE INTO drive_state (id, last_fingerprint, processed_at) VALUES (1, NULL, NULL);
  `);
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (3, ?)")
    .run(new Date().toISOString());
  const columnsAfterMigrationThree = db.pragma("table_info(jobs)") as Array<{ name: string }>;
  if (!columnsAfterMigrationThree.some((column) => column.name === "media_type")) {
    db.exec("ALTER TABLE jobs ADD COLUMN media_type TEXT NOT NULL DEFAULT 'dvd'");
  }
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (4, ?)")
    .run(new Date().toISOString());
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (5, ?)")
    .run(new Date().toISOString());
  db.exec(`
    CREATE TABLE IF NOT EXISTS tv_episode_feedback (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      item_signature TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'rejected', 'manual-assignment')),
      episodes_json TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tv_episode_feedback_item_signature
      ON tv_episode_feedback(item_signature, created_at DESC);
    CREATE INDEX IF NOT EXISTS tv_episode_feedback_fingerprint
      ON tv_episode_feedback(fingerprint, created_at DESC);
  `);
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (6, ?)")
    .run(new Date().toISOString());
  db.exec(`
    CREATE TABLE IF NOT EXISTS tv_processing_plans (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('ready', 'awaiting-review', 'approved', 'rejected')),
      plan_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tv_processing_plans_fingerprint
      ON tv_processing_plans(fingerprint, created_at DESC);
    CREATE INDEX IF NOT EXISTS tv_processing_plans_state
      ON tv_processing_plans(state, created_at DESC);
  `);
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (7, ?)")
    .run(new Date().toISOString());
  db.exec(`
    CREATE TABLE IF NOT EXISTS tv_validation_evidence (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      origin TEXT NOT NULL CHECK (origin IN ('captured', 'imported')),
      evidence_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tv_validation_evidence_fingerprint
      ON tv_validation_evidence(fingerprint, captured_at);
    CREATE INDEX IF NOT EXISTS tv_validation_evidence_captured_at
      ON tv_validation_evidence(captured_at);
  `);
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (8, ?)")
    .run(new Date().toISOString());
  const recoveryTime = new Date().toISOString();
  const markInterrupted = db.transaction(() => {
    const jobs = db.prepare(`
      SELECT id FROM jobs
      WHERE status IN ('inspecting', 'ripping', 'converting', 'publishing')
    `).all() as Array<{ id: string }>;
    db.prepare(`
      UPDATE jobs SET status = 'interrupted', error = 'Service restarted while this job was active',
        finished_at = ?, duration_seconds = MAX(0, (julianday(?) - julianday(started_at)) * 86400)
      WHERE status IN ('inspecting', 'ripping', 'converting', 'publishing')
    `).run(recoveryTime, recoveryTime);
    const event = db.prepare("INSERT INTO job_events (job_id, at, stage, level, message) VALUES (?, ?, ?, ?, ?)");
    for (const job of jobs) {
      event.run(job.id, recoveryTime, "interrupted", "warn", "Service restarted while this job was active");
    }
  });
  markInterrupted();
}
