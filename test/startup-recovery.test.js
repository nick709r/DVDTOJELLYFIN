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

test("startup reconciliation fails stranded interruptions and removes only unowned temporary directories", async () => {
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
  await mkdir(join(workDir, knownJobId));
  await mkdir(join(workDir, orphanId));
  await writeFile(join(moviesDir, "Published Movie.mkv"), Buffer.alloc(2048));
  const interruptedPartial = join(moviesDir, `.autodisc-${knownJobId}.mkv`);
  const abandonedPartial = join(alternateMoviesDir, `.autodisc-${orphanId}.mp4`);
  await writeFile(interruptedPartial, Buffer.alloc(2048));
  await writeFile(abandonedPartial, Buffer.alloc(2048));
  repositories.jobs.add(knownJobId, "Interrupted DVD", "crashed-disc");
  repositories.jobs.setStatus(knownJobId, "ripping", "Ripping");
  repositories.jobs.update(knownJobId, { outputPath: join(moviesDir, "missing-output.mkv") });

  migrateDatabase(db, defaultSettings);
  await recoverTemporaryFiles(repositories);

  assert.equal(repositories.history.get(knownJobId).status, "failed");
  assert.match(repositories.history.get(knownJobId).error, /recovery failed/i);
  assert.equal(repositories.reviewItems.list({ status: "active" }).length, 1);
  await assert.rejects(stat(join(workDir, knownJobId)));
  await assert.rejects(stat(join(workDir, orphanId)));
  await assert.rejects(stat(interruptedPartial));
  await assert.rejects(stat(abandonedPartial));
  await assert.doesNotReject(stat(join(moviesDir, "Published Movie.mkv")));
  await recoverTemporaryFiles(repositories);
  await assert.rejects(stat(join(workDir, knownJobId)));
  await assert.rejects(stat(interruptedPartial));
  await assert.doesNotReject(stat(join(moviesDir, "Published Movie.mkv")));
  repositories.close();
  await rm(root, { recursive: true, force: true });
});
