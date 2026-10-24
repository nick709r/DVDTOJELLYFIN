import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import test from "node:test";
import { defaultSettings } from "../dist/infrastructure/database/default-settings.js";
import { migrateDatabase } from "../dist/infrastructure/database/migrations.js";
import { createSqliteRepositories } from "../dist/infrastructure/database/repositories.js";

test("Forget Disc removes only disc-owned work, review, and TV staging artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "autodisc-forget-"));
  const workDir = join(root, "work");
  const moviesDir = join(root, "movies");
  const musicDir = join(root, "music");
  const tvDir = join(root, "tv");
  const lidarrImportDir = join(root, "lidarr");
  await Promise.all([workDir, moviesDir, musicDir, tvDir, lidarrImportDir].map((path) => mkdir(path)));
  const db = new Database(":memory:");
  migrateDatabase(db, defaultSettings);
  const repositories = createSqliteRepositories(db, defaultSettings);
  const outputDestinations = {
    activeProfileId: "test",
    profiles: [{
      ...defaultSettings.outputDestinations.profiles[0],
      id: "test",
      jellyfin: { root: "", paths: { tv: tvDir, movies: moviesDir, music: musicDir } }
    }]
  };
  repositories.settings.save({ workDir, moviesDir, musicDir, tvRootDir: tvDir, lidarrImportDir, outputDestinations });
  const jobId = "d07deddd-79e0-4dc7-a2d4-a8e8df68e12d";
  const reviewPath = join(workDir, "reviews", jobId);
  const stagingPath = join(workDir, "tv-staging", "unidentified", jobId);
  const processingPath = join(workDir, jobId);
  const publishedPath = join(moviesDir, "Published Movie.mkv");
  await Promise.all([reviewPath, stagingPath, processingPath].map((path) => mkdir(path, { recursive: true })));
  await writeFile(join(reviewPath, "media.mkv"), Buffer.alloc(2048));
  await writeFile(join(stagingPath, "episode.mkv"), Buffer.alloc(2048));
  await writeFile(join(processingPath, "temporary.mkv"), Buffer.alloc(2048));
  await writeFile(publishedPath, Buffer.alloc(2048));
  repositories.jobs.add(jobId, "Test disc", "forget-fingerprint");
  repositories.jobs.finish(jobId, "failed", "test failure");
  repositories.reviewJobs.create({
    id: jobId,
    originalJobId: jobId,
    discType: "dvd",
    discLabel: "Test disc",
    failureReason: "test failure",
    failureStage: "processing",
    storagePath: reviewPath,
    mediaSize: 2048,
    resumeStage: "metadata",
    metadata: {}
  });
  repositories.tvMatchingTasks.create({
    jobId,
    fingerprint: "forget-fingerprint",
    status: "awaiting-identification",
    stagingPath,
    source: {
      sourceId: "dvd0",
      providerId: "source.video-dvd.makemkv",
      mediaKind: "dvd",
      label: "Test disc",
      manifest: { mediaKind: "dvd", items: [], attributes: {} }
    },
    diagnostics: {},
    files: {},
    assignments: []
  });

  const result = repositories.forgetDisc.forgetDisc(jobId);

  assert.equal(result.removed.filesystemArtifacts, 3);
  await assert.rejects(stat(reviewPath));
  await assert.rejects(stat(stagingPath));
  await assert.rejects(stat(processingPath));
  await assert.doesNotReject(stat(publishedPath));
  assert.equal(repositories.history.get(jobId), undefined);
  repositories.close();
  await rm(root, { recursive: true, force: true });
});
