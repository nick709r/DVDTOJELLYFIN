import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import test from "node:test";
import { defaultSettings } from "../dist/infrastructure/database/default-settings.js";
import { migrateDatabase } from "../dist/infrastructure/database/migrations.js";
import { createSqliteRepositories } from "../dist/infrastructure/database/repositories.js";

test("startup reconciles a published output and resolves its original review item", {
  skip: process.platform === "win32" && "The ffprobe test stub requires a POSIX shell"
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "autodisc-published-recovery-"));
  const outputDir = join(root, "alternate-output");
  const workDir = join(root, "work");
  await Promise.all([mkdir(outputDir), mkdir(workDir)]);
  const outputPath = join(outputDir, "Movie.mkv");
  await writeFile(outputPath, Buffer.alloc(2048));
  const ffprobe = join(root, "ffprobe");
  await writeFile(ffprobe, "#!/bin/sh\necho 120\n", { mode: 0o750 });
  await chmod(ffprobe, 0o750);

  const previousFfprobe = process.env.FFPROBE_COMMAND;
  process.env.FFPROBE_COMMAND = ffprobe;
  try {
    const { recoverTemporaryFiles } = await import("../dist/recovery.js");
    const db = new Database(":memory:");
    migrateDatabase(db, defaultSettings);
    const repositories = createSqliteRepositories(db, defaultSettings);
    repositories.settings.save({ workDir, moviesDir: outputDir });
    const jobId = "d07deddd-79e0-4dc7-a2d4-a8e8df68e12d";
    repositories.jobs.add(jobId, "Movie disc", "published-fingerprint");
    repositories.jobs.setStatus(jobId, "publishing", "Publishing");
    repositories.jobs.update(jobId, { outputPath });
    repositories.reviewItems.create({
      category: "processing_failure",
      severity: "high",
      title: "Processing interrupted",
      description: "The service stopped during publication",
      relatedJobId: jobId,
      discFingerprint: "published-fingerprint",
      suggestedActions: [{ type: "retry", label: "Retry" }]
    });

    migrateDatabase(db, defaultSettings);
    await recoverTemporaryFiles(repositories);

    assert.equal(repositories.history.get(jobId).status, "completed");
    assert.equal(repositories.history.get(jobId).outputBytes, 2048);
    assert.equal(repositories.reviewItems.list({ status: "resolved" }).length, 1);
    assert.equal(repositories.recovery.lastDiscFingerprint(), "published-fingerprint");
    repositories.close();
  } finally {
    if (previousFfprobe === undefined) delete process.env.FFPROBE_COMMAND;
    else process.env.FFPROBE_COMMAND = previousFfprobe;
    await rm(root, { recursive: true, force: true });
  }
});
