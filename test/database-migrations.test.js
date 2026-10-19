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
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 7);
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

test("TV episode feedback repository persists accepted, rejected, and manual group corrections", () => {
  const db = new Database(":memory:");
  migrateDatabase(db, defaultSettings);
  const repositories = createSqliteRepositories(db, defaultSettings);
  const episode = { seriesId: "series-1", seasonNumber: 1, episodeNumber: 1, title: "Pilot" };
  const accepted = repositories.tvEpisodeFeedback.record({
    fingerprint: "disc-a",
    itemSignature: "item-a",
    outcome: "accepted",
    episodes: [episode],
    reason: "Confirmed from original release"
  });
  repositories.tvEpisodeFeedback.record({
    fingerprint: "disc-a",
    itemSignature: "item-b",
    outcome: "rejected",
    episodes: [episode],
    reason: "Wrong episode"
  });
  const manual = repositories.tvEpisodeFeedback.record({
    fingerprint: "disc-a",
    itemSignature: "item-c",
    outcome: "manual-assignment",
    episodes: [
      episode,
      { seriesId: "series-1", seasonNumber: 1, episodeNumber: 2, title: "Part Two" }
    ]
  });

  assert.equal(accepted.id.length > 0, true);
  assert.equal(repositories.tvEpisodeFeedback.findForItemSignature("item-a")[0].outcome, "accepted");
  assert.equal(repositories.tvEpisodeFeedback.findForItemSignature("item-b")[0].reason, "Wrong episode");
  assert.deepEqual(repositories.tvEpisodeFeedback.listForFingerprint("disc-a").map((record) => record.outcome), [
    "accepted", "rejected", "manual-assignment"
  ]);
  assert.equal(manual.episodes.length, 2);
  assert.throws(() => repositories.tvEpisodeFeedback.record({
    fingerprint: "disc-a",
    itemSignature: "invalid",
    outcome: "manual-assignment",
    episodes: []
  }), /at least one episode/);
  repositories.close();
});

test("TV processing-plan repository persists review disposition and episode assignments", () => {
  const db = new Database(":memory:");
  migrateDatabase(db, defaultSettings);
  const repositories = createSqliteRepositories(db, defaultSettings);
  const plan = repositories.tvProcessingPlans.save({
    sourceId: "drive-1",
    manifestId: "manifest-1",
    fingerprint: "tv-disc",
    series: { id: "series-1", title: "Example Show" },
    seriesConfidence: 0.95,
    season: { seriesId: "series-1", number: 1 },
    seasonConfidence: 0.93,
    discPosition: {
      discNumber: 1,
      discCount: 2,
      confidence: 1,
      evidence: ["Disc label"],
      scoreComponents: { discStructure: 1 }
    },
    assignments: [{
      itemId: "title-1",
      decision: "suggested",
      episodes: [{ seriesId: "series-1", seasonNumber: 1, episodeNumber: 1 }],
      confidence: 0.94,
      confidenceBand: "high",
      explanation: ["Metadata and runtime matched"],
      reviewRequirement: "none"
    }],
    confidence: 0.93,
    confidenceBand: "high",
    automaticProcessingSafe: true,
    reviewRequirement: "none",
    reviewReasons: [],
    duplicateTracks: [],
    alternateTracks: [],
    commentaryTracks: [],
    bonusFeatures: [],
    specialFeatures: [],
    approvalRequired: false,
    executionEnabled: false,
    executionBlocker: "TV output processing is not implemented"
  });

  assert.equal(plan.state, "ready");
  assert.equal(repositories.tvProcessingPlans.get(plan.id).assignments[0].episodes[0].episodeNumber, 1);
  assert.equal(repositories.tvProcessingPlans.latestForFingerprint("tv-disc").id, plan.id);
  const approvedPlan = repositories.tvProcessingPlans.setState(plan.id, "approved", "admin");
  assert.equal(approvedPlan.state, "approved");
  assert.equal(approvedPlan.reviewedBy, "admin");
  assert.ok(approvedPlan.reviewedAt);
  assert.throws(() => repositories.tvProcessingPlans.setState(plan.id, "rejected", "admin"), /already approved/);
  assert.throws(() => repositories.tvProcessingPlans.save({
    ...plan,
    executionEnabled: true
  }), /analysis-only/);
  repositories.close();
});
