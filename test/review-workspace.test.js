import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import test from "node:test";
import { ReviewWorkspaceService } from "../dist/application/review-workspace-service.js";
import { defaultSettings } from "../dist/infrastructure/database/default-settings.js";
import { migrateDatabase } from "../dist/infrastructure/database/migrations.js";
import { createSqliteRepositories } from "../dist/infrastructure/database/repositories.js";

test("review workspace preserves verified media, persists review metadata, and cleans up safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "dvd-review-"));
  const db = new Database(":memory:");
  migrateDatabase(db, defaultSettings);
  const repositories = createSqliteRepositories(db, defaultSettings);
  const workspaces = new ReviewWorkspaceService(repositories.reviewJobs);
  const jobId = "d07deddd-79e0-4dc7-a2d4-a8e8df68e12d";
  const originalMedia = join(root, "extracted.mkv");
  await writeFile(originalMedia, Buffer.alloc(2048, 1));
  repositories.jobs.add(jobId, "Review DVD", "review-fingerprint", "dvd");

  const created = await workspaces.create({
    id: jobId,
    originalJobId: jobId,
    discType: "dvd",
    discLabel: "Review DVD",
    metadata: { title: null },
    workDir: root,
    mediaSource: originalMedia
  });
  assert.equal(created.job.status, "processing");
  assert.equal((await stat(created.mediaPath)).size, 2048);
  assert.equal(await readFile(join(created.job.storagePath, "review.json"), "utf8").then((json) => JSON.parse(json).ripCompleted), true);

  const pending = await workspaces.markPending(jobId, {
    reason: "Metadata provider unavailable",
    stage: "metadata",
    resumeStage: "metadata"
  });
  assert.equal(pending.status, "pending");
  assert.equal(pending.mediaSize, 2048);
  await workspaces.updateMetadata(jobId, { title: "Corrected title" });
  assert.equal(repositories.reviewJobs.get(jobId).metadata.title, "Corrected title");
  assert.equal((await workspaces.manifest(jobId)).failureReason, "Metadata provider unavailable");

  await workspaces.remove(jobId);
  assert.equal(repositories.reviewJobs.get(jobId), undefined);
  await assert.rejects(stat(created.job.storagePath));
  repositories.close();
});
