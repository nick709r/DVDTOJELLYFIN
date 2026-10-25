import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import test from "node:test";
import { ReviewQueueCleanupService } from "../dist/application/review-queue-cleanup-service.js";
import {
  StorageLifecycleService,
  shouldWarnForReviewStorage
} from "../dist/application/storage-lifecycle-service.js";
import { defaultSettings } from "../dist/infrastructure/database/default-settings.js";
import { migrateDatabase } from "../dist/infrastructure/database/migrations.js";
import { createSqliteRepositories } from "../dist/infrastructure/database/repositories.js";
import { tvStagingDirectory } from "../dist/storage-paths.js";

const ids = {
  completed: "4f6ca529-6b88-4da9-a03d-f16618a77c11",
  active: "4f6ca529-6b88-4da9-a03d-f16618a77c12",
  failed: "4f6ca529-6b88-4da9-a03d-f16618a77c13",
  task: "4f6ca529-6b88-4da9-a03d-f16618a77c14",
  orphan: "4f6ca529-6b88-4da9-a03d-f16618a77c15"
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "autodisc-storage-lifecycle-"));
  const workDir = join(root, "work");
  const stagingDir = join(root, "staging");
  const moviesDir = join(root, "movies");
  const musicDir = join(root, "music");
  const tvDir = join(root, "tv");
  const lidarrImportDir = join(root, "lidarr");
  await Promise.all([workDir, stagingDir, moviesDir, musicDir, tvDir, lidarrImportDir]
    .map((path) => mkdir(path, { recursive: true })));
  const db = new Database(":memory:");
  migrateDatabase(db, defaultSettings);
  const repositories = createSqliteRepositories(db, defaultSettings);
  const profile = defaultSettings.outputDestinations.profiles[0];
  repositories.settings.save({
    workDir,
    tvStagingDir: stagingDir,
    moviesDir,
    musicDir,
    tvRootDir: tvDir,
    lidarrImportDir,
    storageWarningThresholdGb: 50,
    autoWarnLargeReviewQueues: true,
    outputDestinations: {
      activeProfileId: "storage-test",
      profiles: [{
        ...profile,
        id: "storage-test",
        jellyfin: { ...profile.jellyfin, paths: { tv: tvDir, movies: moviesDir, music: musicDir } }
      }]
    }
  });
  const settings = () => repositories.settings.get();
  const cleanupService = new ReviewQueueCleanupService(db, settings);
  const service = new StorageLifecycleService(db, settings, cleanupService);
  const addJob = (id, status, outputPath = null) => {
    repositories.jobs.add(id, `Job ${id}`, `fingerprint-${id}`);
    db.prepare("UPDATE jobs SET status = ?, output_path = ? WHERE id = ?").run(status, outputPath, id);
  };
  const addTask = (id) => {
    const stagingPath = join(tvStagingDirectory(settings()), id);
    db.prepare(`
      INSERT INTO tv_matching_tasks
        (job_id, fingerprint, status, staging_path, source_json, diagnostics_json, files_json,
         assignments_json, created_at, updated_at)
      VALUES (?, ?, 'awaiting-identification', ?, '{}', '{}', '{}', '[]', ?, ?)
    `).run(id, `fingerprint-${id}`, stagingPath, new Date().toISOString(), new Date().toISOString());
    return stagingPath;
  };
  return {
    root, workDir, stagingDir, moviesDir, repositories, db, cleanupService, service, addJob, addTask,
    async close() {
      repositories.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

test("storage accounting includes hard-linked data once and separates active processing", async () => {
  const f = await fixture();
  try {
    f.addJob(ids.completed, "completed");
    const completedWork = join(f.workDir, ids.completed);
    await mkdir(completedWork);
    const first = join(completedWork, "first.tmp");
    await writeFile(first, Buffer.alloc(512));
    await link(first, join(completedWork, "second.tmp"));

    f.addJob(ids.active, "ripping");
    const activeWork = join(f.workDir, ids.active);
    await mkdir(activeWork);
    await writeFile(join(activeWork, "active.mkv"), Buffer.alloc(256));

    const summary = await f.service.getStorageSummary();
    const conversions = summary.categories.find((item) => item.id === "temporary-conversion-files");
    assert.equal(conversions.bytes, 512);
    assert.equal(conversions.reclaimableBytes, 512);
    assert.equal(summary.activeProcessingBytes, 256);
    assert.equal(summary.reviewQueueWarningThresholdGb, 50);
    assert.equal(summary.autoWarnLargeReviewQueues, true);
    assert.equal(summary.publishedMediaExcluded, true);
  } finally {
    await f.close();
  }
});

test("review storage warnings activate exactly at configured GiB thresholds", () => {
  for (const threshold of [50, 100, 250, 500]) {
    const boundary = threshold * 1024 ** 3;
    assert.equal(shouldWarnForReviewStorage(boundary - 1, threshold, true), false);
    assert.equal(shouldWarnForReviewStorage(boundary, threshold, true), true);
    assert.equal(shouldWarnForReviewStorage(boundary, threshold, false), false);
  }
  assert.equal(shouldWarnForReviewStorage(1_000_000_000_000, null, true), false);
});

test("conversion cleanup removes only owned temporary output and leaves published media untouched", async () => {
  const f = await fixture();
  try {
    const finalOutput = join(f.moviesDir, "Film", "film.mp4");
    await mkdir(join(f.moviesDir, "Film"));
    await writeFile(finalOutput, Buffer.alloc(2048));
    f.addJob(ids.failed, "failed", finalOutput);
    const temporary = join(dirname(finalOutput), `.autodisc-${ids.failed}-${randomUUID()}.mp4`);
    await writeFile(temporary, Buffer.alloc(1024));

    const impact = await f.service.getCleanupImpact("temporary-conversion-files");
    assert.equal(impact.files, 1);
    assert.equal(impact.bytes, 1024);
    const result = await f.service.cleanupCategory("temporary-conversion-files");
    assert.equal(result.success, true);
    assert.equal(result.filesDeleted, 1);
    assert.equal(result.bytesRecovered, 1024);
    assert.equal((await stat(finalOutput)).size, 2048);
    await assert.rejects(stat(temporary), { code: "ENOENT" });
    assert.equal(f.repositories.history.get(ids.failed).status, "failed");
  } finally {
    await f.close();
  }
});

test("orphan analysis reports age and cleanup removes only untracked workspaces", async () => {
  const f = await fixture();
  try {
    const orphanPath = join(f.workDir, ids.orphan);
    await mkdir(orphanPath);
    await writeFile(join(orphanPath, "abandoned.tmp"), Buffer.alloc(64));
    const orphans = await f.service.getOrphanedResources();
    assert.equal(orphans.items.length, 1);
    assert.equal(orphans.items[0].path, orphanPath);
    assert.equal(orphans.items[0].size, 64);
    assert.equal(orphans.items[0].originalJobId, null);
    assert.deepEqual(orphans.errors, []);

    const result = await f.service.cleanupCategory("orphaned-data");
    assert.equal(result.success, true);
    assert.equal(result.filesDeleted, 1);
    await assert.rejects(stat(orphanPath), { code: "ENOENT" });
  } finally {
    await f.close();
  }
});

test("scheduled cleanup removes aged failed conversion temp files but preserves unmatched TV media", async () => {
  const f = await fixture();
  try {
    const finalOutput = join(f.moviesDir, "Film", "film.mp4");
    await mkdir(join(f.moviesDir, "Film"));
    await writeFile(finalOutput, Buffer.alloc(1024));
    f.addJob(ids.failed, "failed", finalOutput);
    const temporary = join(dirname(finalOutput), `.autodisc-${ids.failed}-${randomUUID()}.mp4`);
    await writeFile(temporary, Buffer.alloc(512));
    const old = new Date(Date.now() - 3 * 86_400_000);
    await utimes(temporary, old, old);

    f.addJob(ids.task, "completed");
    const stagingPath = f.addTask(ids.task);
    await mkdir(stagingPath);
    const stagedTrack = join(stagingPath, "S01E01.mkv");
    await writeFile(stagedTrack, Buffer.alloc(2048));
    f.repositories.settings.save({
      autoCleanTempLogsAfterDays: null,
      autoCleanFailedConversionsAfterDays: 1
    });

    const results = await f.service.runScheduledMaintenance();
    assert.equal(results.length, 1);
    assert.equal(results[0].filesDeleted, 1);
    await assert.rejects(stat(temporary), { code: "ENOENT" });
    assert.equal((await stat(stagedTrack)).size, 2048);
    assert.equal((await stat(finalOutput)).size, 1024);
  } finally {
    await f.close();
  }
});

test("metadata cache cleanup deletes rows but preserves the application database", async () => {
  const f = await fixture();
  try {
    const now = new Date().toISOString();
    f.db.prepare(`
      INSERT INTO tv_metadata_cache
        (cache_key, provider_id, entity_type, query_text, result_json, cached_at, expires_at)
      VALUES ('storage-cache-test', 'tvdb', 'series', 'test', '{"title":"Test"}', ?, ?)
    `).run(now, now);
    const impact = await f.service.getCleanupImpact("metadata-cache");
    assert.equal(impact.items, 1);
    assert.ok(impact.bytes > 0);
    const result = await f.service.cleanupCategory("metadata-cache");
    assert.equal(result.recordsDeleted, 1);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM tv_metadata_cache").get().count, 0);
    assert.equal(f.db.open, true);
  } finally {
    await f.close();
  }
});

test("Clean Everything Safe retains active jobs, staged TV media, published output, and job history", async () => {
  const f = await fixture();
  try {
    f.addJob(ids.failed, "failed");
    const failedWork = join(f.workDir, ids.failed);
    await mkdir(failedWork);
    await writeFile(join(failedWork, "conversion.log"), "failed conversion");
    const failedRip = join(failedWork, "rip-preserved");
    await mkdir(failedRip);
    const failedRipTrack = join(failedRip, "source.mkv");
    await writeFile(failedRipTrack, Buffer.alloc(128));

    f.addJob(ids.active, "ripping");
    const activeWork = join(f.workDir, ids.active);
    await mkdir(activeWork);
    const activeFile = join(activeWork, "active.mkv");
    await writeFile(activeFile, Buffer.alloc(512));

    const stagingPath = f.addTask(ids.task);
    await mkdir(stagingPath);
    const stagedTrack = join(stagingPath, "S01E01.mkv");
    await writeFile(stagedTrack, Buffer.alloc(1024));

    const published = join(f.moviesDir, "published.mp4");
    await writeFile(published, Buffer.alloc(2048));
    const orphanPath = join(f.workDir, ids.orphan);
    await mkdir(orphanPath);
    await writeFile(join(orphanPath, "abandoned.log"), "orphan log");

    const result = await f.service.cleanupEverythingSafe();
    assert.equal(result.success, true);
    assert.ok(result.filesDeleted >= 2);
    assert.equal((await stat(activeFile)).size, 512);
    assert.equal((await stat(stagedTrack)).size, 1024);
    assert.equal((await stat(published)).size, 2048);
    assert.equal((await stat(failedRipTrack)).size, 128);
    await assert.rejects(stat(join(failedWork, "conversion.log")), { code: "ENOENT" });
    await assert.rejects(stat(orphanPath), { code: "ENOENT" });
    assert.equal(f.repositories.history.get(ids.failed).status, "failed");
    assert.equal(f.repositories.history.get(ids.active).status, "ripping");
  } finally {
    await f.close();
  }
});

test("review cleanup preserves a fingerprint still referenced by another job", async () => {
  const f = await fixture();
  try {
    f.addJob(ids.failed, "failed");
    f.addJob(ids.completed, "completed");
    const sharedFingerprint = "shared-storage-fingerprint";
    f.db.prepare("UPDATE jobs SET disc_fingerprint = ? WHERE id IN (?, ?)")
      .run(sharedFingerprint, ids.failed, ids.completed);
    const review = f.repositories.reviewItems.create({
      category: "tv_review",
      severity: "medium",
      title: "TV match needs review",
      description: "Manual identification required",
      relatedJobId: ids.failed,
      discFingerprint: sharedFingerprint,
      suggestedActions: []
    });
    f.addTask(ids.completed);
    f.db.prepare("UPDATE tv_matching_tasks SET fingerprint = ? WHERE job_id = ?")
      .run(sharedFingerprint, ids.completed);
    f.db.prepare(`
      INSERT INTO disc_recovery
        (fingerprint, detected_disc_type, final_disc_type, detected_media_type, final_media_type, updated_at)
      VALUES (?, 'dvd', 'dvd', 'tv', 'tv', ?)
    `).run(sharedFingerprint, new Date().toISOString());

    const result = await f.cleanupService.deleteReviewItem(review.id);
    assert.equal(result.success, true);
    assert.ok(f.db.prepare("SELECT 1 FROM disc_recovery WHERE fingerprint = ?").get(sharedFingerprint));
    assert.ok(f.db.prepare("SELECT 1 FROM tv_matching_tasks WHERE job_id = ?").get(ids.completed));
  } finally {
    await f.close();
  }
});
