import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AppSettings, Job, JobStatus } from "./model.js";

const defaultSettings: AppSettings = {
  moviesDir: process.env.MOVIES_DIR ?? "/srv/jellyfin/Movies",
  musicDir: process.env.MUSIC_DIR ?? "/srv/jellyfin/Music",
  workDir: process.env.WORK_DIR ?? "/var/cache/autodisc",
  opticalDevice: process.env.OPTICAL_DEVICE ?? "/dev/sr0",
  format: "mp4",
  quality: 23,
  preset: "ultrafast",
  encoder: "auto",
  autoEject: true,
  metadataEnabled: false,
  metadataProvider: "tmdb",
  metadataApiKey: "",
  musicMetadataEnabled: false,
  lidarrEnabled: false,
  lidarrUrl: process.env.LIDARR_URL ?? "http://127.0.0.1:8686",
  lidarrApiKey: process.env.LIDARR_API_KEY ?? "",
  lidarrImportDir: process.env.LIDARR_IMPORT_DIR ?? "/var/cache/autodisc/lidarr-import",
  adminPasswordSalt: "",
  adminPasswordHash: "",
  logLevel: "info"
};

export const dbPath = process.env.DATABASE_PATH ?? "./data/autodisc.sqlite";
mkdirSync(dirname(dbPath), { recursive: true });
export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

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
    for (const [key, value] of Object.entries(defaultSettings)) {
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

const interrupted = db.prepare(`
  UPDATE jobs SET status = 'interrupted', error = 'Service restarted while this job was active',
  finished_at = ?, duration_seconds = MAX(0, (julianday(?) - julianday(started_at)) * 86400)
  WHERE status IN ('inspecting', 'ripping', 'converting', 'publishing')
`);
const recoveryTime = new Date().toISOString();
const markInterrupted = db.transaction(() => {
  const jobs = db.prepare(`
    SELECT id FROM jobs
    WHERE status IN ('inspecting', 'ripping', 'converting', 'publishing')
  `).all() as Array<{ id: string }>;
  interrupted.run(recoveryTime, recoveryTime);
  const event = db.prepare("INSERT INTO job_events (job_id, at, stage, level, message) VALUES (?, ?, ?, ?, ?)");
  for (const job of jobs) {
    event.run(job.id, recoveryTime, "interrupted", "warn", "Service restarted while this job was active");
  }
});
markInterrupted();

export function getSettings(): AppSettings {
  const rows = db.prepare("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>;
  const values: Record<string, unknown> = {};
  for (const row of rows) values[row.key] = JSON.parse(row.value) as unknown;
  return { ...defaultSettings, ...values } as AppSettings;
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const now = new Date().toISOString();
  const update = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  const save = db.transaction(() => {
    for (const [key, value] of Object.entries(patch)) {
      update.run(key, JSON.stringify(value), now);
    }
  });
  save();
  return getSettings();
}

export function addJob(
  id: string,
  discLabel: string | null,
  fingerprint: string | null = null,
  mediaType: Job["mediaType"] = "dvd"
): void {
  db.prepare("INSERT INTO jobs (id, status, media_type, disc_label, disc_fingerprint, started_at) VALUES (?, 'inspecting', ?, ?, ?, ?)")
    .run(id, mediaType, discLabel, fingerprint, new Date().toISOString());
  addEvent(id, "inspecting", "info", mediaType === "audio_cd" ? "Audio CD accepted" : "Video DVD accepted");
}

export function setJobStatus(id: string, status: JobStatus, message: string): void {
  db.prepare("UPDATE jobs SET status = ?, progress = CASE WHEN ? = 'completed' THEN 100 ELSE progress END WHERE id = ?")
    .run(status, status, id);
  addEvent(id, status, status === "failed" ? "error" : "info", message);
}

export function updateJob(id: string, patch: Partial<Pick<Job, "title" | "outputPath" | "encoder" | "outputBytes" | "progress" | "conversionSeconds">>): void {
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
  db.prepare(`UPDATE jobs SET ${columns.join(", ")} WHERE id = ?`).run(...values);
}

export function finishJob(
  id: string,
  status: "completed" | "failed" | "cancelled" | "interrupted",
  error: string | null,
  fingerprint?: string
): void {
  const now = new Date().toISOString();
  const finish = db.transaction(() => {
    db.prepare(`
      UPDATE jobs SET status = ?, error = ?, finished_at = ?,
        duration_seconds = MAX(0, (julianday(?) - julianday(started_at)) * 86400),
        progress = CASE WHEN ? = 'completed' THEN 100 ELSE progress END
      WHERE id = ?
    `).run(status, error, now, now, status, id);
    if (status === "completed" && fingerprint) {
      db.prepare("UPDATE drive_state SET last_fingerprint = ?, processed_at = ? WHERE id = 1")
        .run(fingerprint, now);
    }
    addEvent(id, status, status === "failed" ? "error" : "info", error ?? "Completed successfully");
  });
  finish();
}

export function interruptedOutputs(): Array<{ id: string; outputPath: string; mediaType: Job["mediaType"] }> {
  return db.prepare(`
    SELECT id, output_path AS outputPath, media_type AS mediaType FROM jobs
    WHERE status = 'interrupted' AND output_path IS NOT NULL
      AND error = 'Service restarted while this job was active'
  `).all() as Array<{ id: string; outputPath: string; mediaType: Job["mediaType"] }>;
}

export function recoverPublishedJob(id: string, outputBytes: number): void {
  const now = new Date().toISOString();
  const recover = db.transaction(() => {
    db.prepare(`
      UPDATE jobs SET status = 'completed', output_bytes = ?, error = NULL,
        finished_at = ?, duration_seconds = MAX(0, (julianday(?) - julianday(started_at)) * 86400),
        progress = 100
      WHERE id = ? AND status = 'interrupted'
    `).run(outputBytes, now, now, id);
    const fingerprint = db.prepare("SELECT disc_fingerprint AS value FROM jobs WHERE id = ?").get(id) as { value: string | null } | undefined;
    if (fingerprint?.value) {
      db.prepare("UPDATE drive_state SET last_fingerprint = ?, processed_at = ? WHERE id = 1")
        .run(fingerprint.value, now);
    }
    addEvent(id, "completed", "info", "Recovered validated media published before service restart");
  });
  recover();
}

export function lastDiscFingerprint(): string | null {
  const row = db.prepare("SELECT last_fingerprint AS fingerprint FROM drive_state WHERE id = 1")
    .get() as { fingerprint: string | null } | undefined;
  return row?.fingerprint ?? null;
}

export function clearInsertedDisc(): void {
  db.prepare("UPDATE drive_state SET last_fingerprint = NULL, processed_at = NULL WHERE id = 1").run();
}

export function addEvent(jobId: string, stage: string, level: string, message: string): void {
  db.prepare("INSERT INTO job_events (job_id, at, stage, level, message) VALUES (?, ?, ?, ?, ?)")
    .run(jobId, new Date().toISOString(), stage, level, message.slice(0, 1000));
}

export function addJobWarning(id: string, message: string): void {
  db.prepare("UPDATE jobs SET error = ? WHERE id = ?").run(message.slice(0, 1000), id);
  addEvent(id, "warning", "warn", message);
}

export function activeJob(): Job | null {
  return db.prepare(`
    SELECT id, status, media_type AS mediaType, disc_label AS discLabel, title, output_path AS outputPath,
      encoder, output_bytes AS outputBytes, started_at AS startedAt,
      finished_at AS finishedAt, duration_seconds AS durationSeconds,
      conversion_seconds AS conversionSeconds,
      progress, error
    FROM jobs WHERE status IN ('inspecting', 'ripping', 'converting', 'publishing')
    ORDER BY started_at DESC LIMIT 1
  `).get() as Job | undefined ?? null;
}

export function listJobs(limit = 100): Job[] {
  return db.prepare(`
    SELECT id, status, media_type AS mediaType, disc_label AS discLabel, title, output_path AS outputPath,
      encoder, output_bytes AS outputBytes, started_at AS startedAt,
      finished_at AS finishedAt, duration_seconds AS durationSeconds,
      conversion_seconds AS conversionSeconds,
      progress, error
    FROM jobs ORDER BY started_at DESC LIMIT ?
  `).all(limit) as Job[];
}

export function deleteJob(id: string): boolean {
  return db.prepare("DELETE FROM jobs WHERE id = ? AND status NOT IN ('inspecting', 'ripping', 'converting', 'publishing')")
    .run(id).changes > 0;
}

export function jobStats(): {
  total: number;
  successful: number;
  failures: number;
  averageSeconds: number | null;
} {
  return db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS successful,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures,
      AVG(CASE WHEN status = 'completed' THEN conversion_seconds END) AS averageSeconds
    FROM jobs WHERE status IN ('completed', 'failed')
  `).get() as { total: number; successful: number; failures: number; averageSeconds: number | null };
}
