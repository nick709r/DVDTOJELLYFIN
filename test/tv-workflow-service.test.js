import assert from "node:assert/strict";
import Database from "better-sqlite3";
import test from "node:test";
import { MetadataResolver } from "../dist/application/metadata-resolver.js";
import { TvWorkflowService, isPotentialTvDisc } from "../dist/application/tv-workflow-service.js";
import { TvReviewService } from "../dist/application/tv-review-service.js";
import { defaultSettings } from "../dist/infrastructure/database/default-settings.js";
import { migrateDatabase } from "../dist/infrastructure/database/migrations.js";
import { createSqliteRepositories } from "../dist/infrastructure/database/repositories.js";
import { DvdWorkflow } from "../dist/providers/workflows/dvd.js";

function metadataProvider(identify) {
  return {
    describe: () => ({
      id: "metadata.test.tv",
      apiVersion: "1.0.0",
      kind: "metadata",
      capabilities: ["metadata.tv"]
    }),
    initialize: async () => {},
    healthCheck: async () => ({ status: "available" }),
    dispose: async () => {},
    identify
  };
}

function createTvService({ candidates = [], feedback = [], savedPlans = [] } = {}) {
  const resolver = new MetadataResolver([metadataProvider(async (input) =>
    candidates.filter((candidate) => candidate.entityType === input.entityType)
  )]);
  return new TvWorkflowService(
    resolver,
    {
      findForItemSignature: (signature) => feedback.filter((record) => record.itemSignature === signature)
    },
    {
      save: (plan) => {
        const saved = {
          ...plan,
          id: `plan-${savedPlans.length + 1}`,
          createdAt: "2026-10-19T12:00:00.000Z",
          state: plan.automaticProcessingSafe ? "ready" : "awaiting-review"
        };
        savedPlans.push(saved);
        return saved;
      }
    }
  );
}

function tvSource(label = "Example Show Season 1 Disc 1") {
  return {
    sourceId: "drive-1",
    providerId: "source.video-dvd.makemkv",
    mediaKind: "dvd",
    label,
    manifest: {
      mediaKind: "dvd",
      items: [
        { id: "1", kind: "title", title: "Episode 1", durationSeconds: 1200 },
        { id: "2", kind: "title", title: "Episode 2", durationSeconds: 1210 }
      ]
    }
  };
}

function metadataCandidates() {
  return [
    {
      id: "series-1",
      providerId: "metadata.test.tv",
      entityType: "series",
      title: "Example Show",
      confidence: 0.96,
      metadata: { title: "Example Show", year: 2020 }
    },
    {
      id: "season-1",
      providerId: "metadata.test.tv",
      entityType: "season",
      title: "Season 1",
      confidence: 0.96,
      metadata: { seriesId: "series-1", seasonNumber: 1, title: "Season 1" }
    },
    ...[1, 2].map((episodeNumber) => ({
      id: `episode-${episodeNumber}`,
      providerId: "metadata.test.tv",
      entityType: "episode",
      title: `Episode ${episodeNumber}`,
      confidence: 0.96,
      metadata: {
        itemId: String(episodeNumber),
        seriesId: "series-1",
        seasonNumber: 1,
        episodeNumber,
        title: `Episode ${episodeNumber}`,
        runtimeSeconds: episodeNumber === 1 ? 1200 : 1210
      }
    }))
  ];
}

test("TV workflow creates analysis, match report, and confidence-gated processing plan", async () => {
  const savedPlans = [];
  const service = createTvService({ candidates: metadataCandidates(), savedPlans });
  const result = await service.prepare(tvSource(), "fingerprint-1");

  assert.ok(result);
  assert.equal(result.analysis.detectedSeries.series.id, "series-1");
  assert.equal(result.matches.items.length, 2);
  assert.ok(result.matches.items.every((item) => item.decision === "suggested"));
  assert.equal(result.plan.series.title, "Example Show");
  assert.equal(result.plan.season.number, 1);
  assert.equal(result.plan.discPosition.discNumber, 1);
  assert.equal(result.plan.confidenceBand, "high");
  assert.equal(result.plan.automaticProcessingSafe, true);
  assert.equal(result.plan.executionEnabled, false);
  assert.equal(result.plan.state, "ready");
  assert.equal(savedPlans.length, 1);
});

test("TV workflow keeps incomplete metadata low-confidence and requires review", async () => {
  const service = createTvService();
  const result = await service.prepare(tvSource(), "fingerprint-2");
  assert.ok(result);
  assert.equal(result.plan.confidenceBand, "low");
  assert.equal(result.plan.automaticProcessingSafe, false);
  assert.equal(result.plan.reviewRequirement, "required");
  assert.ok(result.plan.reviewReasons.includes("Series identity is unknown"));
  assert.ok(result.plan.executionBlocker.includes("not implemented"));
});

test("TV workflow only queries TV metadata for a structurally plausible series disc", async () => {
  let lookups = 0;
  const resolver = new MetadataResolver([metadataProvider(async () => {
    lookups += 1;
    return [];
  })]);
  const service = new TvWorkflowService(resolver, { findForItemSignature: () => [] }, { save: (plan) => plan });

  assert.equal(isPotentialTvDisc({
    ...tvSource("Movie Disc"),
    manifest: {
      mediaKind: "dvd",
      items: [
        { id: "1", kind: "title", title: "Feature", durationSeconds: 7200 },
        { id: "2", kind: "title", title: "Trailer", durationSeconds: 120 },
        { id: "3", kind: "title", title: "Behind the Scenes", durationSeconds: 600 }
      ]
    }
  }), false);
  assert.equal(await service.prepare({
    ...tvSource("Movie Disc"),
    manifest: {
      mediaKind: "dvd",
      items: [
        { id: "1", kind: "title", title: "Feature", durationSeconds: 7200 },
        { id: "2", kind: "title", title: "Trailer", durationSeconds: 120 },
        { id: "3", kind: "title", title: "Behind the Scenes", durationSeconds: 600 }
      ]
    }
  }, "movie-fingerprint"), undefined);
  assert.equal(lookups, 0);
});

test("generic TV wording alone does not divert a movie disc from the movie workflow", () => {
  assert.equal(isPotentialTvDisc({
    ...tvSource("TV Edition"),
    manifest: {
      mediaKind: "dvd",
      items: [{ id: "1", kind: "title", title: "Feature", durationSeconds: 7200 }]
    }
  }), false);
});

test("DVD workflow holds potential TV discs for review and never invokes movie acquisition", async () => {
  const service = createTvService({ candidates: metadataCandidates() });
  const workflow = new DvdWorkflow(service);
  const calls = [];
  const context = { id: "job-tv" };
  const jobs = {
    getSettings: () => ({ workDir: "unused", moviesDir: "unused", autoEject: true }),
    lastDiscFingerprint: () => null,
    begin: (...args) => { calls.push(["begin", ...args]); return context; },
    update: (...args) => calls.push(["update", ...args]),
    record: (...args) => calls.push(["record", ...args]),
    holdForReview: (...args) => calls.push(["review", ...args]),
    wasJobCancelled: () => false
  };
  let acquireCalls = 0;
  const source = {
    provider: {},
    candidate: {
      providerId: "source.video-dvd.makemkv",
      sourceId: "drive-1",
      mediaKind: "dvd",
      label: "Example Show Season 1 Disc 1",
      manifest: tvSource().manifest
    }
  };

  assert.equal(await workflow.process({
    source,
    sources: {
      acquire: async () => { acquireCalls += 1; throw new Error("Movie ripping must not run"); }
    },
    jobs,
    metadata: { resolve: async () => { throw new Error("Movie metadata lookup must not run"); } },
    signal: new AbortController().signal,
    devicePath: "/dev/sr0"
  }), true);
  assert.equal(acquireCalls, 0);
  assert.ok(calls.some(([name]) => name === "review"));
  assert.ok(calls.some(([name, contextArg]) => name === "record" && contextArg === context));
});

test("TV review corrections persist and are consumed by a later matching run", async () => {
  const db = new Database(":memory:");
  migrateDatabase(db, defaultSettings);
  const repositories = createSqliteRepositories(db, defaultSettings);
  try {
    const service = new TvWorkflowService(
      new MetadataResolver([metadataProvider(async (input) =>
        metadataCandidates().filter((candidate) => candidate.entityType === input.entityType)
      )]),
      repositories.tvEpisodeFeedback,
      repositories.tvProcessingPlans
    );
    const first = await service.prepare(tvSource(), "fingerprint-correct");
    assert.ok(first);
    const firstItem = first.matches.items.find((item) => item.itemId === "1");
    assert.ok(firstItem);
    const episode = firstItem.alternatives[0].episodes[0];
    assert.ok(episode);
    const review = new TvReviewService(repositories.tvEpisodeFeedback, repositories.tvProcessingPlans);
    const rejection = review.applyCorrection({
      type: "reject-match",
      planId: first.plan.id,
      itemId: "1",
      episodes: [episode],
      reason: "Disc evidence contradicts this provider result"
    });
    assert.equal(rejection.outcome, "rejected");
    assert.equal(rejection.fingerprint, "fingerprint-correct");

    const next = await service.prepare(tvSource(), "fingerprint-correct");
    assert.ok(next);
    const nextItem = next.matches.items.find((item) => item.itemId === "1");
    assert.equal(nextItem.decision, "unknown");
    assert.match(nextItem.evidence.join(" "), /Previously rejected episode match/);

    const rejectedPlan = review.applyApproval({
      type: "reject-plan",
      planId: first.plan.id,
      reviewer: "admin",
      reason: "Manual review found conflicting disc evidence"
    });
    assert.equal(rejectedPlan.state, "rejected");
    assert.equal(rejectedPlan.reviewedBy, "admin");
    assert.equal(rejectedPlan.reviewReason, "Manual review found conflicting disc evidence");
    assert.equal(repositories.tvProcessingPlans.get(first.plan.id).reviewedBy, "admin");
  } finally {
    repositories.close();
  }
});

test("reviewer can approve a low-confidence plan without enabling automatic execution", async () => {
  const db = new Database(":memory:");
  migrateDatabase(db, defaultSettings);
  const repositories = createSqliteRepositories(db, defaultSettings);
  try {
    const service = new TvWorkflowService(
      new MetadataResolver([metadataProvider(async () => [])]),
      repositories.tvEpisodeFeedback,
      repositories.tvProcessingPlans
    );
    const result = await service.prepare(tvSource(), "fingerprint-manual-approval");
    assert.ok(result);
    assert.equal(result.plan.automaticProcessingSafe, false);
    const review = new TvReviewService(repositories.tvEpisodeFeedback, repositories.tvProcessingPlans);
    const approved = review.applyApproval({
      type: "approve-plan",
      planId: result.plan.id,
      reviewer: "admin"
    });
    assert.equal(approved.state, "approved");
    assert.equal(approved.automaticProcessingSafe, false);
    assert.equal(approved.executionEnabled, false);
  } finally {
    repositories.close();
  }
});
