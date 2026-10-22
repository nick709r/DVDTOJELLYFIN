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
  await Promise.all([workDir, moviesDir, musicDir, lidarrImportDir].map((path) => mkdir(path)));
  const db = new Database(":memory:");
  migrateDatabase(db, defaultSettings);
  const repositories = createSqliteRepositories(db, defaultSettings);
  repositories.settings.save({ workDir, moviesDir, musicDir, lidarrImportDir });

  const knownJobId = "d07deddd-79e0-4dc7-a2d4-a8e8df68e12d";
  const orphanId = "d07deddd-79e0-4dc7-a2d4-a8e8df68e13d";
  await mkdir(join(workDir, knownJobId));
  await mkdir(join(workDir, orphanId));
  await writeFile(join(moviesDir, "Published Movie.mkv"), Buffer.alloc(2048));
  repositories.jobs.add(knownJobId, "Interrupted DVD", "crashed-disc");
  repositories.jobs.setStatus(knownJobId, "ripping", "Ripping");
  repositories.jobs.update(knownJobId, { outputPath: join(moviesDir, "missing-output.mkv") });

  migrateDatabase(db, defaultSettings);
  await recoverTemporaryFiles(repositories);

  assert.equal(repositories.history.get(knownJobId).status, "failed");
  assert.match(repositories.history.get(knownJobId).error, /recovery failed/i);
  await assert.doesNotReject(stat(join(workDir, knownJobId)));
  await assert.rejects(stat(join(workDir, orphanId)));
  await assert.doesNotReject(stat(join(moviesDir, "Published Movie.mkv")));
  repositories.close();
  await rm(root, { recursive: true, force: true });
});
