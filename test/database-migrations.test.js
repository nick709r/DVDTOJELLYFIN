import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { scryptSync } from "node:crypto";
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
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 27);
  assert.deepEqual(
    db.pragma("table_info(media_type_override_audit)").map((column) => column.name),
    ["id", "fingerprint", "job_id", "original_type", "new_type", "username", "reason", "created_at"]
  );
  assert.deepEqual(
    db.pragma("table_info(tv_matching_tasks)").map((column) => column.name),
    ["job_id", "fingerprint", "status", "staging_path", "source_json", "diagnostics_json", "files_json",
      "assignments_json", "failure", "created_at", "updated_at"]
  );
  assert.deepEqual(
    db.pragma("table_info(review_jobs)").map((column) => column.name),
    ["id", "original_job_id", "status", "disc_type", "disc_label", "failure_reason", "failure_stage",
      "storage_path", "media_size", "created_at", "updated_at", "resume_stage", "metadata_json", "notification_active"]
  );
  assert.equal(db.prepare("SELECT setup_complete FROM setup_state WHERE id = 1").get().setup_complete, 0);
  assert.ok(db.pragma("table_info(disk_classification_audit)").some((column) => column.name === "reviewed_by"));
  assert.deepEqual(
    db.pragma("table_info(disc_recovery)").map((column) => column.name),
    ["fingerprint", "detected_disc_type", "final_disc_type", "detected_media_type", "detected_confidence",
      "final_media_type", "disc_type_overridden", "media_type_overridden", "metadata_provider", "provider_id", "series_name",
      "season_number", "mappings_json", "notes", "updated_at", "imported_metadata_json", "artwork_references_json",
      "disc_number", "disc_name", "identified_by", "identification_diagnostics_json"]
  );
  const repositories = createSqliteRepositories(db, defaultSettings);
  const recovery = repositories.discRecovery;
  recovery.recordDetection("recovery-disc", "dvd", "movie");
  const updatedRecovery = recovery.update("recovery-disc", {
    finalDiscType: "dvd",
    finalMediaType: "tv_series",
    mediaTypeOverrideAudit: { username: "admin", reason: "Disc label indicates television" },
    metadataProvider: "manual",
    seriesName: "Example Show",
    seasonNumber: 1,
    mappings: [{
      trackId: "1",
      episodes: [{ seriesId: "manual:Example Show", seasonNumber: 1, episodeNumber: 1, title: "Pilot" }]
    }],
    importedMetadata: { title: "Example Show", year: 2024 },
    artworkReferences: [{ kind: "poster", url: "https://image.tmdb.org/t/p/original/poster.jpg" }]
  });
  assert.equal(updatedRecovery.detectedMediaType, "movie");
  assert.equal(updatedRecovery.finalMediaType, "tv_series");
  assert.equal(updatedRecovery.mediaTypeOverridden, true);
  assert.deepEqual(recovery.mediaTypeOverrideAudit("recovery-disc").map((entry) => ({
    originalType: entry.originalType,
    newType: entry.newType,
    username: entry.username,
    reason: entry.reason
  })), [{
    originalType: "movie",
    newType: "tv_series",
    username: "admin",
    reason: "Disc label indicates television"
  }]);
  assert.equal(updatedRecovery.mappings[0].episodes[0].title, "Pilot");
  assert.equal(updatedRecovery.importedMetadata.year, 2024);
  assert.equal(updatedRecovery.artworkReferences[0].kind, "poster");
  assert.throws(() => recovery.update("recovery-disc", { seasonNumber: 101 }), /Season number/);
  assert.throws(() => recovery.update("recovery-disc", {
    artworkReferences: [{ kind: "poster", url: "http://example.invalid/poster.jpg" }]
  }), /Artwork references/);
  repositories.jobs.add("staged-tv-job", "Example TV disc", "staged-tv-fingerprint", "dvd");
  const task = repositories.tvMatchingTasks.create({
    jobId: "staged-tv-job",
    fingerprint: "staged-tv-fingerprint",
    status: "awaiting-identification",
    stagingPath: "/work/tv-staging/unidentified/staged-tv-job",
    source: {
      sourceId: "dvd0",
      providerId: "source.video-dvd.makemkv",
      mediaKind: "dvd",
      label: "",
      manifest: { mediaKind: "dvd", items: [], attributes: {} }
    },
    diagnostics: { status: "analysis-unavailable" },
    files: {},
    assignments: []
  });
  assert.equal(task.jobId, "staged-tv-job");
  assert.equal(repositories.tvMatchingTasks.list().length, 1);
  repositories.jobs.finish(task.jobId, "review", null);
  repositories.jobs.add("ready-tv-job", "Matched TV disc", "ready-tv-fingerprint", "dvd");
  const readyTask = repositories.tvMatchingTasks.create({
    jobId: "ready-tv-job",
    fingerprint: "ready-tv-fingerprint",
    status: "ready-to-publish",
    stagingPath: "/work/tv-staging/unidentified/ready-tv-job",
    source: {
      sourceId: "dvd0",
      providerId: "source.video-dvd.makemkv",
      mediaKind: "dvd",
      label: "Example series",
      manifest: { mediaKind: "dvd", items: [], attributes: {} }
    },
    diagnostics: {},
    files: { "1": "episode01.mkv" },
    assignments: [{
      trackId: "1",
      title: "Pilot",
      durationSeconds: 1200,
      episodeCandidates: [],
      selectedEpisodes: [{ seriesId: "series-1", seasonNumber: 1, episodeNumber: 1, title: "Pilot" }],
      confirmed: true
    }]
  });
  assert.equal(readyTask.status, "ready-to-publish");
  assert.equal(repositories.tvMatchingTasks.get(readyTask.jobId).assignments[0].confirmed, true);
  repositories.jobs.finish(readyTask.jobId, "review", null);
  repositories.tvMatchingTasks.deleteTemporaryRecords(readyTask.jobId, readyTask.fingerprint);
  repositories.tvMatchingTasks.update(task.jobId, { failure: "temporary issue" });
  assert.equal(repositories.tvMatchingTasks.get(task.jobId).failure, "temporary issue");
  repositories.tvMatchingTasks.update(task.jobId, { failure: null });
  assert.equal(repositories.tvMatchingTasks.get(task.jobId).failure, undefined);
  assert.equal(repositories.tvMatchingTasks.deleteTemporaryRecords(task.jobId, task.fingerprint), true);
  assert.equal(repositories.tvMatchingTasks.get(task.jobId), undefined);
  assert.equal(db.prepare("SELECT status FROM jobs WHERE id = ?").get(task.jobId).status, "deleted");
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run(
    "tvStoreAnalysisEvidence", "true", "2026-01-01T00:00:00.000Z"
  );
  db.prepare("DELETE FROM schema_migrations WHERE version = 13").run();
  migrateDatabase(db, defaultSettings);
  assert.equal(db.prepare("SELECT 1 FROM settings WHERE key = ?").get("tvStoreAnalysisEvidence"), undefined);
  db.close();
});

test("migration 27 preserves existing TV matching records and accepts review states", () => {
  const db = new Database(":memory:");
  migrateDatabase(db, defaultSettings);
  const repositories = createSqliteRepositories(db, defaultSettings);
  repositories.jobs.add("existing-tv-job", "Existing TV disc", "existing-tv-fingerprint", "dvd");
  const task = repositories.tvMatchingTasks.create({
    jobId: "existing-tv-job",
    fingerprint: "existing-tv-fingerprint",
    status: "awaiting-mapping",
    stagingPath: "/work/tv-staging/existing-tv-job",
    source: {
      sourceId: "dvd0",
      providerId: "source.video-dvd.makemkv",
      mediaKind: "dvd",
      label: "Example series",
      manifest: { mediaKind: "dvd", items: [], attributes: {} }
    },
    diagnostics: { confidence: 0.62 },
    files: { "1": "episode01.mkv" },
    assignments: [{
      trackId: "1",
      title: "Pilot",
      durationSeconds: 1200,
      episodeCandidates: [],
      selectedEpisodes: [],
      confirmed: false
    }]
  });
  repositories.jobs.finish(task.jobId, "review", null);

  db.exec(`
    ALTER TABLE tv_matching_tasks RENAME TO tv_matching_tasks_v27;
    DROP INDEX tv_matching_tasks_status_updated;
    DROP INDEX tv_matching_tasks_fingerprint;
    CREATE TABLE tv_matching_tasks (
      job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'awaiting-identification', 'awaiting-mapping', 'processing', 'completed'
      )),
      staging_path TEXT NOT NULL,
      source_json TEXT NOT NULL,
      diagnostics_json TEXT NOT NULL,
      files_json TEXT NOT NULL,
      assignments_json TEXT NOT NULL,
      failure TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO tv_matching_tasks SELECT * FROM tv_matching_tasks_v27;
    DROP TABLE tv_matching_tasks_v27;
    CREATE INDEX tv_matching_tasks_status_updated
      ON tv_matching_tasks(status, updated_at DESC);
    CREATE INDEX tv_matching_tasks_fingerprint ON tv_matching_tasks(fingerprint);
    DELETE FROM schema_migrations WHERE version = 27;
  `);
  assert.throws(() => db.prepare("UPDATE tv_matching_tasks SET status = 'partially-matched' WHERE job_id = ?")
    .run(task.jobId), /CHECK constraint failed/);

  migrateDatabase(db, defaultSettings);

  const restoredTask = repositories.tvMatchingTasks.get(task.jobId);
  assert.equal(restoredTask.status, "awaiting-mapping");
  assert.equal(restoredTask.fingerprint, task.fingerprint);
  assert.deepEqual(restoredTask.files, { "1": "episode01.mkv" });
  assert.equal(restoredTask.assignments[0].title, "Pilot");
  assert.equal(restoredTask.diagnostics.confidence, 0.62);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tv_matching_tasks").get().count, 1);
  repositories.tvMatchingTasks.update(task.jobId, { status: "partially-matched" });
  assert.equal(repositories.tvMatchingTasks.get(task.jobId).status, "partially-matched");
  repositories.close();
});

test("setup state repository completes once and migrates legacy administrator credentials", () => {
  const db = new Database(":memory:");
  const salt = Buffer.from("legacy salt");
  const password = "LegacyStrongPassword123!";
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)");
  const now = new Date().toISOString();
  const insert = db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)");
  insert.run("adminPasswordSalt", JSON.stringify(salt.toString("hex")), now);
  insert.run("adminPasswordHash", JSON.stringify(scryptSync(password, salt, 64).toString("hex")), now);
  migrateDatabase(db, defaultSettings);
  const repositories = createSqliteRepositories(db, defaultSettings);
  assert.equal(repositories.setup.get().setupComplete, true);
  assert.equal(repositories.setup.get().adminUsername, "admin");
  assert.equal(repositories.setup.authenticate("admin", password), true);
  assert.equal(repositories.setup.authenticate("admin", "wrong password"), false);
  assert.equal(repositories.setup.get().passwordChangeRequired, true);
  repositories.setup.updatePassword("00", "00");
  assert.equal(repositories.setup.get().passwordChangeRequired, false);
  migrateDatabase(db, defaultSettings);
  assert.equal(repositories.setup.get().passwordChangeRequired, false);
  assert.throws(() => repositories.setup.complete("other-admin", "salt", "hash"), /already been completed/);
  repositories.close();
});

test("destination migration preserves saved legacy library paths and routes existing Lidarr users", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)");
  const updatedAt = new Date().toISOString();
  insert.run("moviesDir", JSON.stringify("/legacy/Movies"), updatedAt);
  insert.run("tvRootDir", JSON.stringify("/legacy/TV"), updatedAt);
  insert.run("musicDir", JSON.stringify("/legacy/Music"), updatedAt);
  insert.run("lidarrEnabled", JSON.stringify(true), updatedAt);

  migrateDatabase(db, defaultSettings);
  const destinations = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'outputDestinations'").get().value);
  const profile = destinations.profiles[0];
  assert.equal(destinations.activeProfileId, profile.id);
  assert.deepEqual(profile.jellyfin.paths, {
    tv: "/legacy/TV",
    movies: "/legacy/Movies",
    music: "/legacy/Music"
  });
  assert.equal(profile.routes.music, "lidarr");
  assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'automationMode'").get().value), "regular_auto");
  assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 27);
  db.close();
});

test("Migration 26 is repeatable and media overrides survive restart and rescan", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autodisc-media-override-migration-"));
  const filename = path.join(root, "state.sqlite");
  let db = new Database(filename);
  let repositories = createSqliteRepositories(db, defaultSettings);
  try {
    migrateDatabase(db, defaultSettings);
    migrateDatabase(db, defaultSettings);
    assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 27);
    repositories.discRecovery.recordDetection("persistent-override", "dvd", "movie", 0.81);
    repositories.discRecovery.update("persistent-override", {
      finalMediaType: "tv_series",
      mediaTypeOverrideAudit: { username: "admin", reason: "Episode-shaped titles" }
    });
    repositories.close();

    db = new Database(filename);
    migrateDatabase(db, defaultSettings);
    repositories = createSqliteRepositories(db, defaultSettings);
    const persisted = repositories.discRecovery.get("persistent-override");
    assert.equal(persisted.finalMediaType, "tv_series");
    assert.equal(persisted.mediaTypeOverridden, true);
    assert.equal(repositories.discRecovery.mediaTypeOverrideAudit("persistent-override")[0].reason, "Episode-shaped titles");

    repositories.discRecovery.recordDetection("persistent-override", "dvd", "movie", 0.95);
    assert.equal(repositories.discRecovery.get("persistent-override").finalMediaType, "tv_series");
    assert.equal(repositories.discRecovery.mediaTypeOverrideAudit("persistent-override").length, 1);
  } finally {
    repositories.close();
    await rm(root, { recursive: true, force: true });
  }
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

test("job initialization is atomic and terminal states reject later processing transitions", () => {
  const db = new Database(":memory:");
  migrateDatabase(db, defaultSettings);
  const repositories = createSqliteRepositories(db, defaultSettings);
  const addEvent = repositories.events.add;
  repositories.events.add = () => {
    throw new Error("event storage unavailable");
  };
  assert.throws(() => repositories.jobs.add("partial-job", "Test source", "partial-fingerprint"), /event storage unavailable/);
  assert.equal(repositories.history.get("partial-job"), undefined);
  assert.equal(repositories.classificationAudit.getByJob("partial-job"), undefined);
  repositories.events.add = addEvent;

  repositories.jobs.add("terminal-job", "Test source", "terminal-fingerprint");
  repositories.jobs.setStatus("terminal-job", "ripping", "Acquiring");
  repositories.jobs.finish("terminal-job", "completed", null, "terminal-fingerprint");
  assert.throws(() => repositories.jobs.setStatus("terminal-job", "publishing", "Publishing again"), /Rejected/);
  assert.throws(() => repositories.jobs.finish("terminal-job", "failed", "Late failure"), /Rejected/);
  assert.equal(repositories.history.get("terminal-job").status, "completed");
  repositories.close();
});

test("job state machine rejects backward phase transitions including publishing to ripping", () => {
  const db = new Database(":memory:");
  migrateDatabase(db, defaultSettings);
  const repositories = createSqliteRepositories(db, defaultSettings);
  repositories.jobs.add("backward-transition-job", "TV disc", "backward-transition-fingerprint");
  repositories.jobs.setStatus("backward-transition-job", "ripping", "Extracting TV episodes");
  repositories.jobs.setStatus("backward-transition-job", "converting", "Converting extracted episodes");
  assert.throws(
    () => repositories.jobs.setStatus("backward-transition-job", "ripping", "Unexpected reacquisition"),
    /Rejected invalid job state transition converting -> ripping/
  );
  repositories.jobs.setStatus("backward-transition-job", "publishing", "Publishing an episode");
  assert.throws(
    () => repositories.jobs.setStatus("backward-transition-job", "ripping", "Unexpected reacquisition"),
    /Rejected invalid job state transition publishing -> ripping/
  );
  assert.equal(repositories.history.get("backward-transition-job").status, "publishing");
  repositories.close();
});

test("active Review Centre entries are deduplicated by job and category", () => {
  const db = new Database(":memory:");
  migrateDatabase(db, defaultSettings);
  const repositories = createSqliteRepositories(db, defaultSettings);
  repositories.jobs.add("review-dedup-job", "Test source", "review-dedup-fingerprint");
  const input = {
    category: "processing_failure",
    severity: "high",
    title: "Processing failed",
    description: "First failure",
    relatedJobId: "review-dedup-job",
    discFingerprint: "review-dedup-fingerprint",
    suggestedActions: [{ type: "retry", label: "Retry" }]
  };
  const first = repositories.reviewItems.create(input);
  const second = repositories.reviewItems.create({ ...input, description: "Repeated failure" });
  assert.equal(second.id, first.id);
  assert.equal(repositories.reviewItems.list({ status: "active" }).length, 1);
  assert.equal(second.description, "Repeated failure");
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
