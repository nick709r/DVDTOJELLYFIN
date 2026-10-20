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
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 16);
  assert.deepEqual(
    db.pragma("table_info(review_jobs)").map((column) => column.name),
    ["id", "original_job_id", "status", "disc_type", "disc_label", "failure_reason", "failure_stage",
      "storage_path", "media_size", "created_at", "updated_at", "resume_stage", "metadata_json", "notification_active"]
  );
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run(
    "tvStoreAnalysisEvidence", "true", "2026-01-01T00:00:00.000Z"
  );
  db.prepare("DELETE FROM schema_migrations WHERE version = 13").run();
  migrateDatabase(db, defaultSettings);
  assert.equal(db.prepare("SELECT 1 FROM settings WHERE key = ?").get("tvStoreAnalysisEvidence"), undefined);
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

test("review item repository persists searchable lifecycle data and summary counts", () => {
  const db = new Database(":memory:");
  migrateDatabase(db, defaultSettings);
  const repositories = createSqliteRepositories(db, defaultSettings);
  const review = repositories.reviewItems.create({
    category: "folder_creation_failure",
    severity: "critical",
    title: "Music folder is unavailable",
    description: "AutoDisc could not create the artist folder",
    relatedJobId: undefined,
    relatedDisc: "Music CD 0123",
    discFingerprint: "review-disc",
    relatedDrive: "/dev/sr0",
    requestedPath: "/music/Artist/Album",
    errorDetails: { code: "EACCES" },
    suggestedActions: [{ type: "retry", label: "Retry" }]
  });
  repositories.reviewItems.create({
    category: "tv_review",
    severity: "medium",
    title: "TV plan needs review",
    description: "Low confidence match",
    suggestedActions: [{ type: "view-job", label: "View" }]
  });

  assert.equal(repositories.reviewItems.get(review.id).errorDetails.code, "EACCES");
  assert.equal(repositories.reviewItems.list({
    category: "folder_creation_failure",
    severity: "critical",
    status: "active"
  }).length, 1);
  assert.equal(repositories.reviewItems.summary().active, 2);
  assert.equal(repositories.reviewItems.summary().critical, 1);

  const retrying = repositories.reviewItems.updateStatus(review.id, "retrying", "Retry requested");
  assert.equal(retrying.status, "retrying");
  assert.equal(retrying.retryCount, 1);
  const refreshedReview = repositories.reviewItems.create({
    category: "folder_creation_failure",
    severity: "high",
    title: "Music folder still unavailable",
    description: "Retry failed",
    relatedDisc: "Music CD 0123",
    discFingerprint: "review-disc",
    relatedDrive: "/dev/sr0",
    requestedPath: "/music/Artist/Album",
    errorDetails: { code: "EACCES", stage: "publish" },
    suggestedActions: [{ type: "retry", label: "Retry again" }]
  });
  assert.equal(refreshedReview.id, review.id);
  assert.equal(refreshedReview.status, "active");
  assert.equal(refreshedReview.retryCount, 1);
  assert.equal(refreshedReview.severity, "high");
  repositories.reviewItems.updateStatus(review.id, "resolved", "Folder is writable now");
  assert.equal(repositories.reviewItems.get(review.id).status, "resolved");
  assert.equal(repositories.reviewItems.resolveForDisc("review-disc", "Completed"), 0);
  assert.equal(repositories.reviewItems.summary().active, 1);
  repositories.close();
});

test("review job repository persists queue status, metadata, and cleanup notifications", () => {
  const db = new Database(":memory:");
  migrateDatabase(db, defaultSettings);
  const repositories = createSqliteRepositories(db, defaultSettings);
  repositories.jobs.add("review-job", "Preserved DVD", "review-fingerprint", "dvd");
  const reviewJob = repositories.reviewJobs.create({
    id: "review-job",
    originalJobId: "review-job",
    discType: "dvd",
    discLabel: "Preserved DVD",
    failureReason: "Metadata lookup failed",
    failureStage: "metadata",
    storagePath: "/working/reviews/review-job",
    mediaSize: 1024,
    resumeStage: "metadata",
    metadata: { title: "Corrected title" }
  });
  assert.equal(reviewJob.status, "pending");
  assert.equal(reviewJob.metadata.title, "Corrected title");
  assert.equal(repositories.reviewJobs.list().length, 1);
  assert.equal(repositories.reviewJobs.update("review-job", {
    status: "retrying",
    notificationActive: false
  }).notificationActive, false);
  assert.equal(repositories.reviewJobs.delete("review-job"), true);
  assert.equal(repositories.reviewJobs.get("review-job"), undefined);
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
  const approvedPlan = repositories.tvProcessingPlans.recordReview(plan.id, "approved", "admin");
  assert.equal(approvedPlan.state, "approved");
  assert.equal(approvedPlan.reviewedBy, "admin");
  assert.ok(approvedPlan.reviewedAt);
  assert.equal(approvedPlan.reviewHistory[0].decision, "approved");
  assert.throws(() => repositories.tvProcessingPlans.recordReview(plan.id, "rejected", "admin", "reason"), /already approved/);
  assert.throws(() => repositories.tvProcessingPlans.save({
    ...plan,
    executionEnabled: true
  }), /analysis-only/);
  repositories.close();
});
