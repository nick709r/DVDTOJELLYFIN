import assert from "node:assert/strict";
import Database from "better-sqlite3";
import test from "node:test";
import { JobCoordinator } from "../dist/application/job-coordinator.js";
import { MediaSourceCoordinator } from "../dist/application/media-source-coordinator.js";
import { MediaWorkflowRegistry } from "../dist/application/media-workflow-registry.js";
import { createSqliteRepositories } from "../dist/infrastructure/database/repositories.js";
import { defaultSettings } from "../dist/infrastructure/database/default-settings.js";
import { migrateDatabase } from "../dist/infrastructure/database/migrations.js";
import { processInsertedDisc } from "../dist/pipeline.js";

test("Review-Based queues detected media before processing and approval verifies the same disc", async () => {
  const db = new Database(":memory:");
  migrateDatabase(db, defaultSettings);
  const repositories = createSqliteRepositories(db, defaultSettings);
  repositories.setup.complete("admin", "salt", "hash");
  repositories.settings.save({ automationMode: "review_based" });
  const candidate = {
    providerId: "source.video-dvd.test",
    sourceId: "/dev/sr0",
    mediaKind: "dvd",
    label: "Review Me",
    manifest: { mediaKind: "dvd", items: [{ id: "title-1", kind: "title", durationSeconds: 90 }] }
  };
  const sourceProvider = {
    describe: () => ({ id: candidate.providerId, name: "Test DVD source", version: "1.0.0", capabilities: [] }),
    inspect: async () => candidate,
    acquire: async () => assert.fail("Review-Based must not rip before approval")
  };
  const sources = new MediaSourceCoordinator([sourceProvider]);
  const workflows = new MediaWorkflowRegistry();
  let workflowCalls = 0;
  workflows.register({
    mediaKind: "dvd",
    process: async () => {
      workflowCalls += 1;
      return true;
    }
  });
  const jobs = new JobCoordinator(repositories, { publish() {} }, {
    begin() {},
    end() {},
    register() {},
    cancel() { return false; },
    wasCancelled() { return false; }
  });
  const metadata = { resolve: async () => ({ selected: null, candidates: [], providerFailures: [] }) };
  const signal = new AbortController().signal;
  try {
    assert.equal(await processInsertedDisc(sources, workflows, jobs, metadata, signal), true);
    assert.equal(workflowCalls, 0);
    const queued = repositories.reviewItems.list({ category: "configuration_issue", status: "active", limit: 10 });
    assert.equal(queued.length, 1);
    assert.equal(queued[0].errorDetails.approvalRequired, true);
    assert.equal(queued[0].suggestedActions[0].type, "approve-process");

    await assert.rejects(
      processInsertedDisc(sources, workflows, jobs, metadata, signal, { detectionSignature: "not-the-same-disc" }),
      /no longer matches/
    );
    assert.equal(workflowCalls, 0);

    const approved = await processInsertedDisc(sources, workflows, jobs, metadata, signal, {
      detectionSignature: queued[0].errorDetails.detectionSignature
    });
    assert.equal(approved, true);
    assert.equal(workflowCalls, 1);
  } finally {
    repositories.close();
  }
});
