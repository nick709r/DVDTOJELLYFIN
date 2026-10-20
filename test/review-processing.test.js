import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import test from "node:test";
import { JobCoordinator } from "../dist/application/job-coordinator.js";
import { ReviewWorkspaceService } from "../dist/application/review-workspace-service.js";
import { DvdWorkflow } from "../dist/providers/workflows/dvd.js";
import { defaultSettings } from "../dist/infrastructure/database/default-settings.js";
import { migrateDatabase } from "../dist/infrastructure/database/migrations.js";
import { createSqliteRepositories } from "../dist/infrastructure/database/repositories.js";

test("DVD metadata failure queues verified extraction without requiring another rip", async () => {
  const root = await mkdtemp(join(tmpdir(), "dvd-review-processing-"));
  const db = new Database(":memory:");
  migrateDatabase(db, defaultSettings);
  const repositories = createSqliteRepositories(db, defaultSettings);
  try {
    const workDir = join(root, "working");
    const moviesDir = join(root, "movies");
    repositories.settings.save({ workDir, moviesDir, metadataEnabled: true, autoEject: false });
    const jobs = new JobCoordinator(repositories, { publish() {} }, {
      begin() {},
      end() {},
      register() {},
      cancel() { return false; },
      wasCancelled() { return false; }
    });
    const workspaces = new ReviewWorkspaceService(repositories.reviewJobs);
    const workflow = new DvdWorkflow(undefined, workspaces);
    let ripCount = 0;
    const source = {
      provider: {},
      candidate: {
        providerId: "source.video-dvd.makemkv",
        sourceId: "drive-1",
        mediaKind: "dvd",
        label: "Example Film",
        manifest: {
          mediaKind: "dvd",
          items: [{ id: "1", kind: "title", title: "Feature", durationSeconds: 7200 }]
        }
      }
    };
    const handled = await workflow.process({
      source,
      sources: {
        acquire: async (_source, workspacePath) => {
          ripCount += 1;
          const mediaPath = join(workspacePath, "extracted.mkv");
          await writeFile(mediaPath, Buffer.alloc(4096, 4));
          return {
            source: { id: "drive-1", providerId: "source.video-dvd.makemkv", kind: "dvd" },
            artifacts: [{ id: "video-1", kind: "video", path: mediaPath }]
          };
        }
      },
      jobs,
      metadata: {
        resolve: async () => ({
          selected: undefined,
          candidates: [],
          providerFailures: [{ providerId: "metadata.test", message: "Provider offline" }]
        })
      },
      signal: new AbortController().signal,
      devicePath: "/dev/sr0"
    });

    assert.equal(handled, true);
    assert.equal(ripCount, 1);
    const reviewJob = repositories.reviewJobs.list()[0];
    assert.equal(reviewJob.status, "pending");
    assert.equal(reviewJob.failureStage, "metadata");
    const [mediaPath] = await workspaces.mediaFiles(reviewJob.id);
    assert.equal((await stat(mediaPath)).size, 4096);
    assert.equal(JSON.parse(await readFile(join(reviewJob.storagePath, "review.json"), "utf8")).ripCompleted, true);
    assert.equal(repositories.history.get(reviewJob.originalJobId).status, "review");
  } finally {
    repositories.close();
    await rm(root, { recursive: true, force: true });
  }
});
