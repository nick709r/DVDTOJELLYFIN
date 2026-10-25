import assert from "node:assert/strict";
import test from "node:test";
import { processInsertedDisc } from "../dist/pipeline.js";

function createJobs(overrides = {}) {
  const calls = { reviews: [], failures: [], active: false };
  const jobs = {
    setupComplete: () => true,
    activeJob: () => calls.active ? {
      id: "active-job",
      mediaType: "dvd",
      discFingerprint: "pipeline-fingerprint",
      discLabel: "Test disc"
    } : null,
    beginOperation: () => {},
    endOperation: () => {},
    getSettings: () => ({ opticalDevice: "/dev/test", automationMode: "full_auto" }),
    hasActiveDiscApproval: () => false,
    createReview: (review) => calls.reviews.push(review),
    failUnexpected: (error, status) => {
      calls.failures.push({ error, status });
      calls.active = false;
    },
    ...overrides
  };
  return { jobs, calls };
}

test("inspection exceptions create a review item without creating an active job", async () => {
  const { jobs, calls } = createJobs();
  const processed = await processInsertedDisc({
    inspect: async () => { throw new Error("inspection crashed"); },
    inspectionDiagnostics: () => ({ attemptedProviders: ["test-provider"] })
  }, {}, jobs, {});

  assert.equal(processed, false);
  assert.equal(calls.reviews.length, 1);
  assert.equal(calls.reviews[0].category, "disc_read_error");
  assert.equal(calls.failures.length, 0);
});

test("unexpected workflow exceptions transition the created job to a terminal failure", async () => {
  const { jobs, calls } = createJobs();
  const processed = await processInsertedDisc({
    inspect: async () => ({
      candidate: {
        providerId: "test-provider",
        mediaKind: "dvd",
        label: "Test disc",
        manifest: { items: [], attributes: {} }
      }
    }),
    inspectionDiagnostics: () => ({ attemptedProviders: ["test-provider"] })
  }, {
    process: async () => {
      calls.active = true;
      throw new Error("metadata lookup crashed");
    }
  }, jobs, {});

  assert.equal(processed, true);
  assert.equal(calls.failures.length, 1);
  assert.equal(calls.failures[0].status, "failed");
  assert.match(calls.failures[0].error.message, /metadata lookup crashed/);
  assert.equal(calls.active, false);
});
