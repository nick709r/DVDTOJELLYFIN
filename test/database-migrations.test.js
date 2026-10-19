import assert from "node:assert/strict";
import Database from "better-sqlite3";
import test from "node:test";
import { defaultSettings } from "../dist/infrastructure/database/default-settings.js";
import { migrateDatabase } from "../dist/infrastructure/database/migrations.js";
import { createSqliteRepositories } from "../dist/infrastructure/database/repositories.js";

test("database migrations preserve legacy job history and add current columns", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      disc_label TEXT,
      title TEXT,
      output_path TEXT,
      encoder TEXT,
      output_bytes INTEGER,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      duration_seconds REAL,
      progress REAL NOT NULL DEFAULT 0,
      error TEXT
    );
    CREATE TABLE job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      at TEXT NOT NULL,
      stage TEXT NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL
    );
    INSERT INTO jobs (id, status, disc_label, started_at) VALUES ('legacy-job', 'completed', 'Old DVD', '2025-01-01T00:00:00.000Z');
  `);

  migrateDatabase(db, defaultSettings);
  const columns = db.pragma("table_info(jobs)").map((column) => column.name);
  assert.ok(columns.includes("conversion_seconds"));
  assert.ok(columns.includes("disc_fingerprint"));
  assert.ok(columns.includes("media_type"));
  assert.deepEqual(db.prepare("SELECT id, status, disc_label, media_type FROM jobs").get(), {
    id: "legacy-job",
    status: "completed",
    disc_label: "Old DVD",
    media_type: "dvd"
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM settings").get().count, Object.keys(defaultSettings).length);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 5);
  db.close();
});

test("SQLite repository adapters preserve settings, job, history, event and recovery contracts", () => {
  const db = new Database(":memory:");
  migrateDatabase(db, defaultSettings);
  const repositories = createSqliteRepositories(db, defaultSettings);
  repositories.jobs.add("repo-job", "Test source", "fingerprint", "future_media");
  repositories.jobs.setStatus("repo-job", "ripping", "Acquiring");
  repositories.events.add("repo-job", "test", "info", "Repository event");
  repositories.jobs.finish("repo-job", "completed", null, "fingerprint");

  assert.equal(repositories.settings.get().format, defaultSettings.format);
  assert.equal(repositories.history.get("repo-job").mediaType, "future_media");
  assert.equal(repositories.history.timeline("repo-job").at(-1).message, "Completed successfully");
  assert.equal(repositories.recovery.lastDiscFingerprint(), "fingerprint");
  assert.equal(repositories.history.stats().successful, 1);
  repositories.close();
});
