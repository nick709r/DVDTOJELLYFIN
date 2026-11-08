import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import test from "node:test";
import { defaultSettings } from "../dist/infrastructure/database/default-settings.js";
import { migrateDatabase } from "../dist/infrastructure/database/migrations.js";
import { createSqliteRepositories } from "../dist/infrastructure/database/repositories.js";
import { recoverTemporaryFiles } from "../dist/recovery.js";
import { ReviewQueueCleanupService } from "../dist/application/review-queue-cleanup-service.js";
import { StorageLifecycleService } from "../dist/application/storage-lifecycle-service.js";

test("startup retains replacement-owned files while unresolved transactions require review", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "autodisc-replacement-recovery-"));
  const db = new Database(":memory:");
  migrateDatabase(db, defaultSettings);
  const repositories = createSqliteRepositories(db, defaultSettings);
  t.after(async () => {
    repositories.close();
    await rm(root, { recursive: true, force: true });
  });
  const workDir = join(root, "work");
  await mkdir(workDir);
  repositories.settings.save({ workDir });
  const jobId = "d07deddd-79e0-4dc7-a2d4-a8e8df68e12d";
  const source = join(workDir, jobId, "source.mkv");
  await mkdir(join(workDir, jobId));
  await writeFile(source, "original staged source");
  repositories.jobs.add(jobId, "TV disc", "disc");
  repositories.jobs.setStatus(jobId, "converting", "Publishing");
  const originalPath = join(root, "episode.mkv");
  const at = "2026-01-03T00:00:00.000Z";
  const transaction = {
    id: "tx-created", jobId, state: "created", createdAt: at, updatedAt: at,
    originalPath, quarantinePath: join(root, "quarantine"), replacementPath: originalPath,
    originalChecksum: null, replacementChecksum: null,
    existing: { outputPath: originalPath }, incoming: {}, failure: null
  };
  repositories.tvConflictJournal.createTransaction(transaction);
  const review = repositories.reviewItems.create({
    category: "tv_review", severity: "medium", title: "TV review", description: "Interrupted",
    relatedJobId: jobId, suggestedActions: []
  });
  const cleanup = new ReviewQueueCleanupService(db, () => repositories.settings.get());
  const storage = new StorageLifecycleService(db, () => repositories.settings.get(), cleanup);
  migrateDatabase(db, defaultSettings);
  await recoverTemporaryFiles(repositories);
  assert.equal(repositories.history.get(jobId).status, "failed");
  assert.match(repositories.history.get(jobId).error, /replacement recovery.*review/i);
  await assert.rejects(cleanup.deleteReviewItem(review.id), /Replacement transaction files must be retained/);
  assert.throws(() => repositories.forgetDisc.forgetDisc(jobId), /replacement transaction/);
  await storage.cleanupCategory("failed-processing-jobs");
  await storage.cleanupCategory("temporary-conversion-files");
  assert.equal((await stat(source)).size, Buffer.byteLength("original staged source"));
  repositories.tvConflictJournal.transitionTransaction("tx-created", "created", "candidate_ready", {
    replacementChecksum: "b".repeat(64)
  });
  await recoverTemporaryFiles(repositories);
  repositories.tvConflictJournal.transitionTransaction("tx-created", "candidate_ready", "quarantined", {
    originalChecksum: "a".repeat(64)
  });
  await recoverTemporaryFiles(repositories);
  repositories.tvConflictJournal.transitionTransaction("tx-created", "quarantined", "published", {
    replacementChecksum: "b".repeat(64)
  });
  await recoverTemporaryFiles(repositories);
  repositories.tvConflictJournal.transitionTransaction("tx-created", "published", "failed", { failure: "interrupted" });
  await recoverTemporaryFiles(repositories);
  repositories.tvConflictJournal.transitionTransaction("tx-created", "failed", "rolled_back", {});
  await recoverTemporaryFiles(repositories);
  assert.equal((await stat(source)).size, Buffer.byteLength("original staged source"));
});

test("startup reconciliation fails stranded interruptions and retains untracked temporary data", async () => {
  const root = await mkdtemp(join(tmpdir(), "autodisc-recovery-"));
  const workDir = join(root, "work");
  const moviesDir = join(root, "movies");
  const musicDir = join(root, "music");
  const lidarrImportDir = join(root, "lidarr");
  const alternateMoviesDir = join(root, "alternate-movies");
  await Promise.all([workDir, moviesDir, musicDir, lidarrImportDir, alternateMoviesDir].map((path) => mkdir(path)));
  const db = new Database(":memory:");
  migrateDatabase(db, defaultSettings);
  const repositories = createSqliteRepositories(db, defaultSettings);
  const baseProfile = defaultSettings.outputDestinations.profiles[0];
  const outputDestinations = {
    activeProfileId: baseProfile.id,
    profiles: [
      { ...baseProfile, jellyfin: { ...baseProfile.jellyfin, paths: { ...baseProfile.jellyfin.paths, movies: moviesDir } } },
      {
        ...baseProfile,
        id: "alternate",
        name: "Alternate",
        jellyfin: { ...baseProfile.jellyfin, paths: { ...baseProfile.jellyfin.paths, movies: alternateMoviesDir } }
      }
    ]
  };
  repositories.settings.save({ workDir, moviesDir, musicDir, lidarrImportDir, outputDestinations });

  const knownJobId = "d07deddd-79e0-4dc7-a2d4-a8e8df68e12d";
  const orphanId = "d07deddd-79e0-4dc7-a2d4-a8e8df68e13d";
  const retainedJobId = "d07deddd-79e0-4dc7-a2d4-a8e8df68e14d";
  await mkdir(join(workDir, knownJobId));
  await mkdir(join(workDir, orphanId));
  await mkdir(join(workDir, retainedJobId));
  await writeFile(join(workDir, retainedJobId, "source.mkv"), Buffer.alloc(2048, 7));
  await writeFile(join(moviesDir, "Published Movie.mkv"), Buffer.alloc(2048));
  const interruptedPartial = join(moviesDir, `.autodisc-${knownJobId}.mkv`);
  const abandonedPartial = join(alternateMoviesDir, `.autodisc-${orphanId}.mp4`);
  await writeFile(interruptedPartial, Buffer.alloc(2048));
  await writeFile(abandonedPartial, Buffer.alloc(2048));
  repositories.jobs.add(retainedJobId, "TV disc", "retained-disc", "dvd");
  repositories.jobs.finish(retainedJobId, "failed", "Publication interrupted");
  repositories.tvMatchingTasks.create({
    jobId: retainedJobId, fingerprint: "retained-disc", status: "awaiting-mapping",
    stagingPath: join(workDir, retainedJobId),
    source: { sourceId: "dvd", providerId: "dvd", mediaKind: "dvd", label: "TV disc",
      manifest: { mediaKind: "dvd", items: [] } },
    diagnostics: {}, files: { "1": "source.mkv" }, assignments: [{
      trackId: "1", title: "Episode", durationSeconds: 1000, episodeCandidates: [], confirmed: true,
      selectedEpisodes: [{ seriesId: "show", seasonNumber: 1, episodeNumber: 1 }],
      keepExisting: { action: "keep_both", mapping: "mapping", conflicts: "snapshot" }
    }]
  });
  repositories.jobs.add(knownJobId, "Interrupted DVD", "crashed-disc");
  repositories.jobs.setStatus(knownJobId, "ripping", "Ripping");
  repositories.jobs.update(knownJobId, { outputPath: join(moviesDir, "missing-output.mkv") });

  migrateDatabase(db, defaultSettings);
  await recoverTemporaryFiles(repositories);

  assert.equal(repositories.history.get(knownJobId).status, "failed");
  assert.match(repositories.history.get(knownJobId).error, /recovery failed/i);
  assert.equal(repositories.reviewItems.list({ status: "active" }).length, 1);
  await assert.rejects(stat(join(workDir, knownJobId)));
  await assert.doesNotReject(stat(join(workDir, orphanId)));
  assert.equal((await stat(join(workDir, retainedJobId, "source.mkv"))).size, 2048);
  await assert.rejects(stat(interruptedPartial));
  await assert.doesNotReject(stat(abandonedPartial));
  await assert.doesNotReject(stat(join(moviesDir, "Published Movie.mkv")));
  assert.equal((await stat(join(workDir, retainedJobId, "source.mkv"))).size, 2048);
  await recoverTemporaryFiles(repositories);
  await assert.rejects(stat(join(workDir, knownJobId)));
  await assert.rejects(stat(interruptedPartial));
  await assert.doesNotReject(stat(join(moviesDir, "Published Movie.mkv")));
  repositories.close();
  await rm(root, { recursive: true, force: true });
});
