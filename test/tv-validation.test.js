import assert from "node:assert/strict";
import Database from "better-sqlite3";
import test from "node:test";
import { MetadataResolver } from "../dist/application/metadata-resolver.js";
import { TvReviewService } from "../dist/application/tv-review-service.js";
import { TvValidationService } from "../dist/application/tv-validation-service.js";
import { TvWorkflowService } from "../dist/application/tv-workflow-service.js";
import { defaultSettings } from "../dist/infrastructure/database/default-settings.js";
import { migrateDatabase } from "../dist/infrastructure/database/migrations.js";
import { createSqliteRepositories } from "../dist/infrastructure/database/repositories.js";

function createEnvironment() {
  const db = new Database(":memory:");
  migrateDatabase(db, defaultSettings);
  const repositories = createSqliteRepositories(db, defaultSettings);
  const validation = new TvValidationService(
    repositories.tvValidationEvidence,
    repositories.tvEpisodeFeedback,
    repositories.tvProcessingPlans
  );
  return { db, repositories, validation };
}

function provider() {
  return {
    describe: () => ({
      id: "metadata.validation.fixture",
      apiVersion: "1.0.0",
      kind: "metadata",
      capabilities: ["metadata.tv"]
    }),
    initialize: async () => {},
    healthCheck: async () => ({ status: "available" }),
    dispose: async () => {},
    identify: async (input) => {
      if (input.entityType === "series") return [{
        id: "series-fixture",
        providerId: "metadata.validation.fixture",
        entityType: "series",
        title: "Fixture Show",
        confidence: 0.95,
        metadata: { title: "Fixture Show" }
      }];
      if (input.entityType === "season") return [{
        id: "season-fixture",
        providerId: "metadata.validation.fixture",
        entityType: "season",
        title: "Season 1",
        confidence: 0.94,
        metadata: { seriesId: "series-fixture", seasonNumber: 1 }
      }];
      if (input.entityType === "episode") return [1, 2].map((episodeNumber) => ({
        id: `episode-${episodeNumber}`,
        providerId: "metadata.validation.fixture",
        entityType: "episode",
        title: `Episode ${episodeNumber}`,
        confidence: 0.94,
        metadata: {
          itemId: String(episodeNumber),
          seriesId: "series-fixture",
          seasonNumber: 1,
          episodeNumber,
          title: `Episode ${episodeNumber}`,
          runtimeSeconds: 1200
        }
      }));
      return [];
    }
  };
}

async function captureFixture(validation, repositories) {
  const workflow = new TvWorkflowService(
    new MetadataResolver([provider()]),
    repositories.tvEpisodeFeedback,
    repositories.tvProcessingPlans,
    validation
  );
  return workflow.prepare({
    sourceId: "drive-fixture",
    providerId: "source.video-dvd.makemkv",
    mediaKind: "dvd",
    label: "Fixture Show Season 1 Disc 1",
    manifest: {
      mediaKind: "dvd",
      items: [
        { id: "1", kind: "title", title: "Episode 1", durationSeconds: 1200 },
        { id: "2", kind: "title", title: "Episode 2", durationSeconds: 1200 }
      ]
    }
  }, "fixture-fingerprint");
}

test("TV workflow captures input structure, metadata candidates and explainable decisions", async () => {
  const environment = createEnvironment();
  const { validation, repositories } = environment;
  try {
    const result = await captureFixture(validation, repositories);
    assert.ok(result);
    const [evidence] = validation.list();
    assert.equal(evidence.source.fingerprint, "fixture-fingerprint");
    assert.equal(evidence.source.manifest.items.length, 2);
    assert.equal(evidence.metadata.rawCandidates.length, 4);
    assert.equal(evidence.metadata.seriesCandidates[0].providerId, "metadata.validation.fixture");
    assert.equal(evidence.analysis.items.length, 2);
    assert.equal(evidence.matches.items.length, 2);
    assert.equal(evidence.plan.executionEnabled, false);
    const report = validation.report(evidence.id);
    assert.match(report, /Confidence policy/);
    assert.match(report, /Ranked alternatives/);
    assert.match(report, /minimum-confidence|episode candidate ranking/);
    assert.match(report, /Unresolved tracks/);
    assert.equal(validation.summary().cases, 1);
    assert.equal(validation.summary().tracks, 2);
    assert.ok(validation.summary().meanPlanConfidence >= 0);
  } finally {
    repositories.close();
  }
});

test("TV evidence export includes later review decisions and corrections; import round-trips", async () => {
  const source = createEnvironment();
  let dataset;
  let caseId;
  try {
    const result = await captureFixture(source.validation, source.repositories);
    assert.ok(result);
    const evidence = source.validation.list()[0];
    caseId = evidence.id;
    const assignment = evidence.plan.assignments[0];
    const episode = assignment.episodes[0] ?? assignment.alternatives[0]?.episodes[0];
    assert.ok(episode);
    const review = new TvReviewService(source.repositories.tvEpisodeFeedback, source.repositories.tvProcessingPlans);
    review.applyCorrection({
      type: "assign-episodes",
      planId: result.plan.id,
      itemId: assignment.itemId,
      episodes: [episode],
      reason: "Checked against the disc menu"
    });
    const deferred = review.applyApproval({
      type: "defer-plan",
      planId: result.plan.id,
      reviewer: "fixture-reviewer",
      reason: "Compare with another release"
    });
    assert.equal(deferred.state, result.plan.state);
    review.applyApproval({
      type: "reject-plan",
      planId: result.plan.id,
      reviewer: "fixture-reviewer",
      reason: "Needs a second review"
    });
    dataset = source.validation.exportDataset();
    assert.equal(dataset.cases[0].plan.reviewReason, "Needs a second review");
    assert.deepEqual(dataset.cases[0].plan.reviewHistory.map((entry) => entry.decision), ["deferred", "rejected"]);
    assert.equal(dataset.cases[0].feedback[0].outcome, "manual-assignment");
    assert.match(source.validation.report(dataset.cases[0].id), /deferred by fixture-reviewer/);
    assert.match(source.validation.report(dataset.cases[0].id), /Held-out feedback checks/);
    assert.equal(source.validation.summary().heldOutLabeledTracks, 1);
  } finally {
    source.repositories.close();
  }

  const destination = createEnvironment();
  try {
    const imported = destination.validation.importDataset(JSON.stringify(dataset));
    assert.equal(imported.imported, 1);
    const importedCase = destination.validation.get(caseId);
    assert.equal(importedCase.origin, "imported");
    assert.equal(importedCase.plan.state, "rejected");
    assert.equal(importedCase.feedback[0].reason, "Checked against the disc menu");
    assert.throws(() => destination.validation.importDataset(JSON.stringify(dataset)), /already exists/);
    assert.equal(destination.validation.list().length, 1);
  } finally {
    destination.repositories.close();
  }
});

test("TV evidence import rejects malformed and duplicate cases without partial writes", () => {
  const environment = createEnvironment();
  try {
    assert.throws(() => environment.validation.importDataset("{"), /not valid JSON/);
    assert.throws(() => environment.validation.importDataset(JSON.stringify({
      format: "autodisc-tv-validation",
      schemaVersion: 1,
      cases: [{ id: "incomplete" }]
    })), /unsupported format or schema version|missing required/);
    assert.equal(environment.validation.list().length, 0);
  } finally {
    environment.repositories.close();
  }
});
