import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import test from "node:test";
import { ReviewQueueCleanupService } from "../dist/application/review-queue-cleanup-service.js";
import { defaultSettings } from "../dist/infrastructure/database/default-settings.js";
import { migrateDatabase } from "../dist/infrastructure/database/migrations.js";
import { createSqliteRepositories } from "../dist/infrastructure/database/repositories.js";
import { tvStagingDirectory } from "../dist/storage-paths.js";

const ids = {
  job: "d07deddd-79e0-4dc7-a2d4-a8e8df68e12d",
  other: "d07deddd-79e0-4dc7-a2d4-a8e8df68e13d",
  orphan: "d07deddd-79e0-4dc7-a2d4-a8e8df68e14d",
  reviewWorkspace: "d07deddd-79e0-4dc7-a2d4-a8e8df68e15d"
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "autodisc-review-cleanup-"));
  const workDir = join(root, "work");
  const stagingRoot = join(root, "staging");
  const moviesDir = join(root, "movies");
  const musicDir = join(root, "music");
  const tvDir = join(root, "tv");
  const lidarrImportDir = join(root, "lidarr");
  await Promise.all([workDir, stagingRoot, moviesDir, musicDir, tvDir, lidarrImportDir].map((path) => mkdir(path, { recursive: true })));
  const db = new Database(":memory:");
  migrateDatabase(db, defaultSettings);
  const repositories = createSqliteRepositories(db, defaultSettings);
  const baseProfile = defaultSettings.outputDestinations.profiles[0];
  const outputDestinations = {
    activeProfileId: "cleanup-test",
    profiles: [{
      ...baseProfile,
      id: "cleanup-test",
      jellyfin: { ...baseProfile.jellyfin, paths: { tv: tvDir, movies: moviesDir, music: musicDir } }
    }]
  };
  repositories.settings.save({
    workDir, tvStagingDir: stagingRoot, moviesDir, musicDir, tvRootDir: tvDir, lidarrImportDir,
    outputDestinations
  });
  const service = new ReviewQueueCleanupService(db, () => repositories.settings.get());
  const cleanup = async () => {
    repositories.close();
    await rm(root, { recursive: true, force: true });
  };
  const addJob = (id, fingerprint, status = "failed") => {
    repositories.jobs.add(id, `Disc ${id}`, fingerprint);
    db.prepare("UPDATE jobs SET status = ? WHERE id = ?").run(status, id);
  };
  const addReview = (jobId, fingerprint) => repositories.reviewItems.create({
    category: "tv_review",
    severity: "medium",
    title: "TV matching requires review",
    description: "Episode assignment needs attention",
    relatedJobId: jobId,
    discFingerprint: fingerprint,
    suggestedActions: []
  });
  const addTask = (jobId, fingerprint) => {
    const stagingPath = join(tvStagingDirectory(repositories.settings.get()), jobId);
    db.prepare(`
      INSERT INTO tv_matching_tasks
        (job_id, fingerprint, status, staging_path, source_json, diagnostics_json, files_json,
         assignments_json, created_at, updated_at)
      VALUES (?, ?, 'awaiting-identification', ?, '{}', '{}', '{}', '[]', ?, ?)
    `).run(jobId, fingerprint, stagingPath, new Date().toISOString(), new Date().toISOString());
    return stagingPath;
  };
  return { root, workDir, stagingRoot, moviesDir, repositories, db, service, cleanup, addJob, addReview, addTask };
}

test("deleting an unmatched TV review cleans staged season, temp conversion, artwork and subtitles", async () => {
  const f = await fixture();
  try {
    const fingerprint = "cleanup-unique-fingerprint";
    f.addJob(ids.job, fingerprint);
    const review = f.addReview(ids.job, fingerprint);
    const taskPath = f.addTask(ids.job, fingerprint);
    const jobPath = join(f.workDir, ids.job);
    const reviewWorkspace = join(f.workDir, "reviews", ids.reviewWorkspace);
    await Promise.all([mkdir(taskPath, { recursive: true }), mkdir(jobPath), mkdir(reviewWorkspace, { recursive: true })]);
    await writeFile(join(taskPath, "S03E01.mkv"), Buffer.alloc(512));
    await writeFile(join(jobPath, "conversion.tmp"), Buffer.alloc(128));
    await mkdir(join(reviewWorkspace, "artwork"));
    await mkdir(join(reviewWorkspace, "subtitles"));
    await mkdir(join(reviewWorkspace, "metadata"));
    await writeFile(join(reviewWorkspace, "artwork", "poster.jpg"), Buffer.alloc(64));
    await writeFile(join(reviewWorkspace, "subtitles", "en.srt"), Buffer.from("subtitle"));
    await writeFile(join(reviewWorkspace, "metadata", "current.json"), Buffer.alloc(12));
    f.repositories.reviewJobs.create({
      id: ids.reviewWorkspace,
      originalJobId: ids.job,
      discType: "dvd",
      discLabel: "Season disc",
      failureReason: "Needs metadata",
      failureStage: "metadata",
      storagePath: reviewWorkspace,
      mediaSize: 512,
      resumeStage: "metadata",
      metadata: {}
    });
    f.db.prepare("INSERT INTO disc_recovery (fingerprint, detected_disc_type, final_disc_type, detected_media_type, final_media_type, updated_at) VALUES (?, 'dvd', 'dvd', 'tv', 'tv', ?)")
      .run(fingerprint, new Date().toISOString());
    f.db.prepare("INSERT INTO tv_metadata_cache (cache_key, provider_id, entity_type, query_text, result_json, cached_at, expires_at) VALUES ('shared-cache', 'tvdb', 'series', 'query', '{}', ?, ?)")
      .run(new Date().toISOString(), new Date(Date.now() + 86400000).toISOString());

    const impact = await f.service.getDeletionImpact(review.id);
    assert.equal(impact.files, 5);
    const result = await f.service.deleteReviewItem(review.id);
    assert.equal(result.success, true);
    assert.equal(result.filesDeleted, 5);
    assert.equal(result.bytesRecovered, 724);
    assert.equal(f.repositories.reviewItems.get(review.id), undefined);
    assert.equal(f.repositories.history.get(ids.job), undefined);
    assert.equal(f.repositories.reviewJobs.get(ids.reviewWorkspace), undefined);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM tv_matching_tasks WHERE job_id = ?").get(ids.job).count, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM disc_recovery WHERE fingerprint = ?").get(fingerprint).count, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM tv_metadata_cache WHERE cache_key = 'shared-cache'").get().count, 1);
    await assert.rejects(stat(taskPath));
    await assert.rejects(stat(jobPath));
    await assert.rejects(stat(reviewWorkspace));
  } finally {
    await f.cleanup();
  }
});

test("deleting one review preserves shared fingerprint records and unrelated job files", async () => {
  const f = await fixture();
  try {
    const fingerprint = "shared-fingerprint";
    f.addJob(ids.job, fingerprint);
    f.addJob(ids.other, fingerprint);
    const review = f.addReview(ids.job, fingerprint);
    const firstPath = join(f.workDir, ids.job);
    const otherPath = join(f.workDir, ids.other);
    await Promise.all([mkdir(firstPath), mkdir(otherPath)]);
    await writeFile(join(firstPath, "temporary.mkv"), Buffer.alloc(64));
    await writeFile(join(otherPath, "keep.mkv"), Buffer.alloc(96));
    f.db.prepare("INSERT INTO tv_episode_feedback (id, fingerprint, item_signature, outcome, episodes_json, created_at) VALUES ('feedback', ?, 'signature', 'accepted', '[]', ?)")
      .run(fingerprint, new Date().toISOString());
    const result = await f.service.deleteReviewItem(review.id);
    assert.equal(result.success, true);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM tv_episode_feedback WHERE fingerprint = ?").get(fingerprint).count, 1);
    assert.equal(f.repositories.history.get(ids.other).id, ids.other);
    await assert.rejects(stat(firstPath));
    assert.equal((await stat(join(otherPath, "keep.mkv"))).size, 96);
  } finally {
    await f.cleanup();
  }
});

test("deletion refuses active jobs and preserves their files and review records", async () => {
  const f = await fixture();
  try {
    f.addJob(ids.job, "active-fingerprint", "ripping");
    const review = f.addReview(ids.job, "active-fingerprint");
    const path = join(f.workDir, ids.job);
    await mkdir(path);
    await writeFile(join(path, "still-ripping.mkv"), Buffer.alloc(64));
    const ownership = await f.service.validateOwnership(review.id);
    assert.equal(ownership.valid, false);
    assert.match(ownership.errors.join(" "), /still processing/);
    await assert.rejects(f.service.deleteReviewItem(review.id), /still processing/);
    assert.equal((await stat(join(path, "still-ripping.mkv"))).size, 64);
    assert.ok(f.repositories.reviewItems.get(review.id));
  } finally {
    await f.cleanup();
  }
});

test("startup orphan scan retains untracked temporary data until explicitly confirmed", async () => {
  const f = await fixture();
  try {
    const workOrphan = join(f.workDir, ids.orphan);
    const reviewOrphan = join(f.workDir, "reviews", ids.reviewWorkspace);
    const stagingOrphan = join(f.stagingRoot, ids.other);
    await Promise.all([workOrphan, reviewOrphan, stagingOrphan].map((path) => mkdir(path, { recursive: true })));
    await writeFile(join(workOrphan, "conversion.tmp"), Buffer.alloc(10));
    await writeFile(join(reviewOrphan, "metadata.json"), Buffer.alloc(20));
    await writeFile(join(stagingOrphan, "staged.mkv"), Buffer.alloc(30));
    const report = await f.service.scanOrphanedData();
    assert.equal(report.items.length, 3);
    assert.equal(report.files, 3);
    assert.equal(report.bytes, 60);
    assert.equal((await stat(join(workOrphan, "conversion.tmp"))).size, 10);
    const result = await f.service.deleteOrphanedData();
    assert.equal(result.success, true);
    assert.equal(result.filesDeleted, 3);
    assert.equal(result.bytesRecovered, 60);
    for (const path of [workOrphan, reviewOrphan, stagingOrphan]) await assert.rejects(stat(path));
  } finally {
    await f.cleanup();
  }
});

test("published media is protected even when the job references it as output", async () => {
  const f = await fixture();
  try {
    f.addJob(ids.job, "published-fingerprint");
    const review = f.addReview(ids.job, "published-fingerprint");
    const published = join(f.moviesDir, "published.mkv");
    await writeFile(published, Buffer.alloc(128));
    f.db.prepare("UPDATE jobs SET output_path = ? WHERE id = ?").run(published, ids.job);
    const result = await f.service.deleteReviewItem(review.id);
    assert.equal(result.success, true);
    assert.equal((await stat(published)).size, 128);
  } finally {
    await f.cleanup();
  }
});

test("review-job deletion removes preserved media and its original job history", async () => {
  const f = await fixture();
  try {
    f.addJob(ids.job, "review-job-fingerprint");
    const workspace = join(f.workDir, "reviews", ids.reviewWorkspace);
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "preserved.mkv"), Buffer.alloc(256));
    f.repositories.reviewJobs.create({
      id: ids.reviewWorkspace,
      originalJobId: ids.job,
      discType: "dvd",
      discLabel: "Preserved media",
      failureReason: "Metadata unavailable",
      failureStage: "metadata",
      storagePath: workspace,
      mediaSize: 256,
      resumeStage: "metadata",
      metadata: {}
    });
    const result = await f.service.deleteReviewJob(ids.reviewWorkspace);
    assert.equal(result.success, true);
    assert.equal(result.filesDeleted, 1);
    assert.equal(result.bytesRecovered, 256);
    assert.equal(f.repositories.reviewJobs.get(ids.reviewWorkspace), undefined);
    assert.equal(f.repositories.history.get(ids.job), undefined);
    await assert.rejects(stat(workspace));
  } finally {
    await f.cleanup();
  }
});

test("deletion rejects a staged path that does not belong to the selected job", async () => {
  const f = await fixture();
  try {
    f.addJob(ids.job, "path-owner-fingerprint");
    const review = f.addReview(ids.job, "path-owner-fingerprint");
    const wrongPath = join(f.stagingRoot, ids.other);
    const actualPath = f.addTask(ids.job, "path-owner-fingerprint");
    await Promise.all([mkdir(actualPath, { recursive: true }), mkdir(wrongPath)]);
    await writeFile(join(wrongPath, "other-job.mkv"), Buffer.alloc(128));
    f.db.prepare("UPDATE tv_matching_tasks SET staging_path = ? WHERE job_id = ?").run(wrongPath, ids.job);
    const ownership = await f.service.validateOwnership(review.id);
    assert.equal(ownership.valid, false);
    assert.match(ownership.errors.join(" "), /staging path does not match/i);
    await assert.rejects(f.service.deleteReviewItem(review.id), /staging path does not match/i);
    assert.equal((await stat(join(wrongPath, "other-job.mkv"))).size, 128);
  } finally {
    await f.cleanup();
  }
});
