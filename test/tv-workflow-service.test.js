import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MetadataResolver } from "../dist/application/metadata-resolver.js";
import {
  assessTvDisc,
  TvWorkflowService,
  isPotentialTvDisc,
  tvPrefilterRejectionReasons
} from "../dist/application/tv-workflow-service.js";
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

function createTvService({ candidates = [], feedback = [], savedPlans = [], completedDiscHistory } = {}) {
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
    },
    undefined,
    undefined,
    undefined,
    completedDiscHistory ? { completedDiscHistory } : {}
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

function detectedRecovery(fingerprint, discType, mediaType) {
  return {
    fingerprint,
    detectedDiscType: discType,
    finalDiscType: discType,
    detectedMediaType: mediaType,
    finalMediaType: mediaType,
    discTypeOverridden: false,
    mediaTypeOverridden: false,
    metadataProvider: "manual",
    providerId: null,
    seriesName: null,
    seasonNumber: null,
    mappings: [],
    notes: null,
    updatedAt: new Date().toISOString()
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
  const source = tvSource();
  assert.equal(assessTvDisc(source).classification, "tv");
  const result = await service.prepare(source, "fingerprint-1");

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
  assert.equal(result.metadataLookups.length, 4);
  assert.ok(result.metadataLookups.some((lookup) => lookup.entityType === "episode-disc"));
  assert.ok(result.metadataLookups.every((lookup) => lookup.durationMs >= 0));
  assert.equal(savedPlans.length, 1);
});

test("TV workflow applies provider disc order and records the automatic assignment method", async () => {
  const candidates = [
    ...metadataCandidates(),
    ...[1, 2].map((episodeNumber) => ({
      id: `dvd-episode-${episodeNumber}`,
      providerId: "metadata.test.tv",
      entityType: "episode-disc",
      title: `Episode ${episodeNumber}`,
      confidence: 1,
      metadata: {
        seriesId: "series-1",
        seasonNumber: 1,
        episodeNumber,
        discNumber: 1,
        discOrder: episodeNumber,
        title: `Episode ${episodeNumber}`
      }
    }))
  ];
  const result = await createTvService({ candidates }).prepare(tvSource(), "fingerprint-provider-disc");

  assert.ok(result);
  const providerLookup = result.metadataLookups.find((lookup) => lookup.entityType === "episode-disc");
  assert.equal(providerLookup.candidates.length, 2);
  assert.deepEqual(result.matches.items.map((item) => item.suggestedEpisodes[0]?.episodeNumber), [1, 2]);
  assert.deepEqual(result.matches.items.map((item) => ({
    decision: item.decision,
    assignmentMethod: item.assignmentMethod,
    confidence: item.confidence,
    alternativeCount: item.alternatives.length
  })), [1, 2].map(() => ({
    decision: "suggested",
    assignmentMethod: "provider-disc-mapping",
    confidence: 1,
    alternativeCount: 0
  })));
  assert.ok(result.plan.assignments.every((item) => item.assignmentMethod === "provider-disc-mapping"));
  assert.equal(result.plan.confidence, 1);
});

test("a Disc 2 label and completed Disc 1 history override conflicting Disc 1 metadata", async () => {
  const episodes = [1, 2, 3, 4];
  const candidates = [
    {
      id: "series-1",
      providerId: "metadata.test.tv",
      entityType: "series",
      title: "Fresh Off the Boat",
      confidence: 0.96,
      metadata: { seriesId: "series-1", title: "Fresh Off the Boat" }
    },
    {
      id: "season-3",
      providerId: "metadata.test.tv",
      entityType: "season",
      title: "Season 3",
      confidence: 0.96,
      metadata: { seriesId: "series-1", seasonNumber: 3, title: "Season 3" }
    },
    ...["1", "2"].flatMap((itemId) => episodes.map((episodeNumber) => ({
      id: `${itemId}-${episodeNumber}`,
      providerId: "metadata.test.tv",
      entityType: "episode",
      title: `Episode ${episodeNumber}`,
      confidence: 0.95,
      metadata: {
        itemId,
        seriesId: "series-1",
        seasonNumber: 3,
        episodeNumber,
        title: `Episode ${episodeNumber}`,
        runtimeSeconds: 1200
      }
    }))),
    ...[1, 2].map((episodeNumber) => ({
      id: `disc-1-${episodeNumber}`,
      providerId: "metadata.test.tv",
      entityType: "episode-disc",
      title: `Episode ${episodeNumber}`,
      confidence: 1,
      metadata: {
        seriesId: "series-1",
        seasonNumber: 3,
        episodeNumber,
        discNumber: 1,
        discOrder: episodeNumber
      }
    }))
  ];
  const completedDiscHistory = {
    listForSeason: () => [{
      jobId: "completed-disc-1",
      fingerprint: "previous-disc-1",
      metadataProvider: "metadata.test.tv",
      providerId: "series-1",
      seriesName: "Fresh Off the Boat",
      seasonNumber: 3,
      discNumber: 1,
      mappings: [
        { trackId: "1", episodes: [{ seriesId: "series-1", seasonNumber: 3, episodeNumber: 1 }] },
        { trackId: "2", episodes: [{ seriesId: "series-1", seasonNumber: 3, episodeNumber: 2 }] }
      ],
      episodes: [1, 2].map((episodeNumber) => ({
        seriesId: "series-1",
        seasonNumber: 3,
        episodeNumber
      })),
      completedAt: "2026-10-24T12:00:00.000Z"
    }]
  };
  const saved = {
    seriesName: "Fresh Off the Boat",
    seriesId: "series-1",
    provider: "metadata.test.tv",
    seasonNumber: 3,
    discNumber: 1,
    discName: null,
    origin: "fingerprint"
  };
  const result = await createTvService({ candidates, completedDiscHistory }).prepare(
    tvSource("fresh-off-the-boat-s3-d2"),
    "new-disc-2",
    undefined,
    saved
  );

  assert.ok(result);
  assert.equal(result.plan.discPosition.discNumber, 2);
  assert.equal(result.identification.discLabelSuggestion.seasonNumber, 3);
  assert.equal(result.identification.discLabelSuggestion.discNumber, 2);
  assert.ok(result.analysis.discPositionCandidates[0].evidence.some((evidence) =>
    evidence.includes("Optical disc volume label")
  ));
  assert.deepEqual(result.matches.items.map((item) => item.suggestedEpisodes[0]?.episodeNumber), [3, 4]);
  assert.ok(result.matches.items.every((item) =>
    item.assignmentMethod === "sequential-disc-assignment"
  ));
});

test("an already completed fingerprint keeps its original disc and episode assignments", async () => {
  const episodes = [1, 2, 3, 4];
  const candidates = [
    {
      id: "series-1",
      providerId: "metadata.test.tv",
      entityType: "series",
      title: "Fresh Off the Boat",
      confidence: 0.96,
      metadata: { seriesId: "series-1", title: "Fresh Off the Boat" }
    },
    ...["1", "2"].flatMap((itemId) => episodes.map((episodeNumber) => ({
      id: `${itemId}-${episodeNumber}`,
      providerId: "metadata.test.tv",
      entityType: "episode",
      title: `Episode ${episodeNumber}`,
      confidence: 0.95,
      metadata: {
        itemId,
        seriesId: "series-1",
        seasonNumber: 3,
        episodeNumber,
        title: `Episode ${episodeNumber}`,
        runtimeSeconds: 1200
      }
    })))
  ];
  const completedDiscHistory = {
    listForSeason: () => [{
      jobId: "completed-disc-1",
      fingerprint: "same-fingerprint",
      metadataProvider: "metadata.test.tv",
      providerId: "series-1",
      seriesName: "Fresh Off the Boat",
      seasonNumber: 3,
      discNumber: 1,
      mappings: [
        { trackId: "1", episodes: [{ seriesId: "series-1", seasonNumber: 3, episodeNumber: 1 }] },
        { trackId: "2", episodes: [{ seriesId: "series-1", seasonNumber: 3, episodeNumber: 2 }] }
      ],
      episodes: [1, 2].map((episodeNumber) => ({
        seriesId: "series-1",
        seasonNumber: 3,
        episodeNumber
      })),
      completedAt: "2026-10-24T12:00:00.000Z"
    }]
  };
  const result = await createTvService({ candidates, completedDiscHistory }).prepare(
    tvSource("fresh-off-the-boat-s3-d1"),
    "same-fingerprint"
  );

  assert.ok(result);
  assert.equal(result.plan.discPosition.discNumber, 1);
  assert.deepEqual(result.matches.items.map((item) => item.suggestedEpisodes[0]?.episodeNumber), [1, 2]);
  assert.ok(result.matches.items.every((item) =>
    item.assignmentMethod === "exact-fingerprint-history"
  ));
});

test("completed TV disc history reads successful imports from job and recovery records", () => {
  const db = new Database(":memory:");
  migrateDatabase(db, defaultSettings);
  const repositories = createSqliteRepositories(db, defaultSettings);
  try {
    repositories.discRecovery.recordDetection("completed-fingerprint", "dvd", "tv_series", 0.95);
    repositories.discRecovery.update("completed-fingerprint", {
      finalMediaType: "tv_series",
      metadataProvider: "tvdb",
      providerId: "series-1",
      seriesName: "Fresh Off the Boat",
      seasonNumber: 3,
      discNumber: 1,
      mappings: [{
        trackId: "track-1",
        episodes: [{ seriesId: "series-1", seasonNumber: 3, episodeNumber: 1 }]
      }]
    });
    db.prepare(`
      INSERT INTO jobs (id, status, disc_fingerprint, started_at, finished_at)
      VALUES (?, 'completed', ?, ?, ?)
    `).run("completed-job", "completed-fingerprint", "2026-10-24T11:00:00.000Z", "2026-10-24T12:00:00.000Z");

    const history = repositories.completedTvDiscHistory.listForSeason(3);
    assert.equal(history.length, 1);
    assert.equal(history[0].discNumber, 1);
    assert.equal(history[0].fingerprint, "completed-fingerprint");
    assert.deepEqual(history[0].episodes.map((episode) => episode.episodeNumber), [1]);
    assert.equal(history[0].completedAt, "2026-10-24T12:00:00.000Z");
  } finally {
    repositories.close();
  }
});

test("TV workflow keeps incomplete metadata low-confidence and requires review", async () => {
  const service = createTvService();
  const result = await service.prepare(tvSource(), "fingerprint-2");
  assert.ok(result);
  assert.equal(result.plan.confidenceBand, "low");
  assert.equal(result.plan.automaticProcessingSafe, false);
  assert.equal(result.plan.reviewRequirement, "required");
  assert.ok(result.plan.reviewReasons.includes("Series identity is unknown"));
  assert.ok(result.plan.executionBlocker.includes("manual recovery mappings"));
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
  const source = {
    ...tvSource("TV Edition"),
    manifest: {
      mediaKind: "dvd",
      items: [{ id: "1", kind: "title", title: "Feature", durationSeconds: 7200 }]
    }
  };
  assert.equal(isPotentialTvDisc(source), false);
  assert.deepEqual(tvPrefilterRejectionReasons(source), [
    'Disc label "TV Edition" contains no season, series, or episode marker',
    "0 titles fall within the configured episode runtime range",
    "Fewer than 3 episode-length titles were found",
    "Not enough episode-length titles to compare runtimes",
    "At least one title exceeds the configured maximum episode runtime"
  ]);
});

test("two consistent episode-length titles classify as uncertain TV with an explainable scorecard", () => {
  const source = {
    ...tvSource("DISC_01"),
    manifest: {
      mediaKind: "dvd",
      items: [
        { id: "1", kind: "title", title: "Title 1", durationSeconds: 1320 },
        { id: "2", kind: "title", title: "Title 2", durationSeconds: 1350 }
      ]
    }
  };
  const assessment = assessTvDisc(source);

  assert.equal(assessment.classification, "review");
  assert.equal(assessment.confidence, 0.35);
  assert.deepEqual(assessment.criteria.map(({ id, passed }) => [id, passed]), [
    ["explicit-series-label", false],
    ["two-episode-length-titles", true],
    ["three-episode-length-titles", false],
    ["consistent-episode-runtimes", true],
    ["no-feature-length-title", true]
  ]);
  assert.equal(isPotentialTvDisc(source), true);
  const inconsistentSource = {
    ...source,
    manifest: {
      ...source.manifest,
      items: [
        source.manifest.items[0],
        { id: "2", kind: "title", title: "Title 2", durationSeconds: 3300 }
      ]
    }
  };
  assert.equal(assessTvDisc(inconsistentSource).classification, "review");
  assert.ok(assessTvDisc(inconsistentSource).reasons.includes(
    "Episode-length title runtime ratio exceeds 1.6"
  ));
  const sourceWithLongTitle = {
    ...source,
    manifest: {
      ...source.manifest,
      items: [...source.manifest.items, {
        id: "3",
        kind: "title",
        title: "Long program",
        durationSeconds: 7200
      }]
    }
  };
  assert.equal(assessTvDisc(sourceWithLongTitle).classification, "review");
  assert.ok(assessTvDisc(sourceWithLongTitle).reasons.includes(
    "At least one title exceeds the configured maximum episode runtime"
  ));
});

test("DVD with no usable titles logs why no job was created", async () => {
  const workflow = new DvdWorkflow();
  const messages = [];
  const originalWarn = console.warn;
  console.warn = (message) => messages.push(JSON.parse(message));
  try {
    const result = await workflow.process({
      source: {
        provider: {},
        candidate: {
          providerId: "source.video-dvd.makemkv",
          sourceId: "drive-1",
          mediaKind: "dvd",
          label: "Burned TV disc",
          manifest: { mediaKind: "dvd", items: [] }
        }
      },
      sources: {},
      jobs: { getSettings: () => ({ tvDetectionEnabled: true }) },
      metadata: {},
      signal: new AbortController().signal,
      devicePath: "/dev/sr0"
    });
    assert.equal(result, false);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(messages.length, 1);
  assert.equal(messages[0].message, "Disc inspection produced no usable video titles; no job was created and detection will retry");
  assert.equal(messages[0].sourceId, "drive-1");
  assert.equal(messages[0].titleItemCount, 0);
});

test("TV prefilter retains its explainable classification for episode-length discs", () => {
  const assessment = assessTvDisc({
    sourceId: "drive-1",
    providerId: "source.video-dvd.makemkv",
    mediaKind: "dvd",
    label: "Example Show Season 1 Disc 1",
    manifest: tvSource().manifest
  });
  assert.equal(assessment.classification, "tv");
  assert.deepEqual(assessment.criteria.map(({ passed }) => passed), [true, true, false, true, true]);
});

test("manual TV recovery maps and publishes each selected disc track", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autodisc-tv-publish-"));
  const workDir = path.join(root, "work");
  const tvRootDir = path.join(root, "TV");
  const jobContext = { id: "job-manual-tv", throwIfCancelled() {} };
  const publishedSteps = [];
  const selectedTracks = [];
  const mappings = [
    { trackId: "1", episodes: [{ seriesId: "manual:Example Show", seasonNumber: 1, episodeNumber: 1, title: "Pilot" }] },
    { trackId: "2", episodes: [{ seriesId: "manual:Example Show", seasonNumber: 1, episodeNumber: 2, title: "Second" }] }
  ];
  const recovery = {
    fingerprint: "manual-tv-fingerprint",
    detectedDiscType: "dvd",
    finalDiscType: "dvd",
    detectedMediaType: "movie",
    finalMediaType: "tv_series",
    discTypeOverridden: false,
    mediaTypeOverridden: true,
    metadataProvider: "manual",
    providerId: null,
    seriesName: "Example Show",
    seasonNumber: 1,
    mappings,
    notes: null,
    updatedAt: new Date().toISOString()
  };
  const jobCalls = [];
  const jobs = {
    getSettings: () => ({
      workDir, tvRootDir, moviesDir: path.join(root, "Movies"),
      tvDetectionEnabled: false, autoEject: false, format: "mkv",
      libraryMetadata: defaultSettings.libraryMetadata
    }),
    lastDiscFingerprint: () => null,
    listDiscRecoveries: () => [],
    listTvMatchingTasks: () => [],
    recordDiscDetection: () => recovery,
    begin: () => jobContext,
    record: (...args) => jobCalls.push(["record", ...args]),
    update: (...args) => jobCalls.push(["update", ...args]),
    step: (...args) => jobCalls.push(["step", ...args]),
    complete: (...args) => jobCalls.push(["complete", ...args]),
    fail: (...args) => jobCalls.push(["fail", ...args]),
    holdForReview: (...args) => jobCalls.push(["review", ...args]),
    wasJobCancelled: () => false,
    warn: (...args) => jobCalls.push(["warn", ...args])
  };
  const converter = async (_input, target, title, _settings, onPublishing, onProgress) => {
    await writeFile(target, Buffer.alloc(2048));
    onPublishing({ name: "Test encoder", codec: "libx264", hardware: false });
    onProgress(1);
    publishedSteps.push(title);
    return { encoder: { name: "Test encoder", codec: "libx264", hardware: false }, outputBytes: 2048 };
  };
  const workflow = new DvdWorkflow(undefined, undefined, converter, async () => {});
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
  try {
    const result = await workflow.process({
      source,
      sources: {
        acquire: async (_candidate, _directory, options) => {
          selectedTracks.push(options.selection.manifestItemId);
          return { artifacts: [{ id: `track-${options.selection.manifestItemId}`, kind: "video", path: "source.mkv" }] };
        }
      },
      jobs,
      metadata: { resolve: async () => { throw new Error("TV recovery must not depend on online metadata"); } },
      signal: new AbortController().signal,
      devicePath: "/dev/sr0"
    });
    assert.equal(result, true);
    assert.deepEqual(jobCalls.filter(([kind]) => kind === "fail"), []);
    assert.deepEqual(selectedTracks, ["1", "2"]);
    assert.equal(publishedSteps.length, 2);
    assert.ok(jobCalls.some(([kind]) => kind === "complete"));
    assert.equal(jobCalls.some(([kind]) => kind === "fail" || kind === "review"), false);
    await access(path.join(tvRootDir, "Example Show", "Season 01", "Example Show - S01E01 - Pilot.mkv"));
    await access(path.join(tvRootDir, "Example Show", "Season 01", "Example Show - S01E02 - Second.mkv"));
    await access(path.join(tvRootDir, "Example Show", "tvshow.nfo"));
    await access(path.join(tvRootDir, "Example Show", "Season 01", "season.nfo"));
    await access(path.join(tvRootDir, "Example Show", "Season 01", "Example Show - S01E01 - Pilot.nfo"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unlabeled two-episode DVD remains a TV review candidate", () => {
  const assessment = assessTvDisc({
    sourceId: "drive-1",
    providerId: "source.video-dvd.makemkv",
    mediaKind: "dvd",
    label: "DISC_01",
    manifest: {
      mediaKind: "dvd",
      items: [
        { id: "1", kind: "title", title: "Title 1", durationSeconds: 1320 },
        { id: "2", kind: "title", title: "Title 2", durationSeconds: 1350 }
      ]
    }
  });
  assert.equal(assessment.classification, "review");
  assert.equal(assessment.confidence, 0.35);
  assert.deepEqual(assessment.criteria.map(({ passed }) => passed), [false, true, false, true, true]);
});

test("DVD workflow classifies an ordinary feature as Movie and does not invoke TV analysis", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autodisc-dvd-movie-route-"));
  const blockedWorkDir = path.join(root, "work-is-a-file");
  await writeFile(blockedWorkDir, "block directory creation");
  const calls = [];
  let tvAnalysisCalls = 0;
  const workflow = new DvdWorkflow({
    prepare: async () => {
      tvAnalysisCalls += 1;
      throw new Error("Movie classification must not invoke TV analysis");
    }
  });
  const jobs = {
    getSettings: () => ({ tvDetectionEnabled: true, workDir: blockedWorkDir, moviesDir: root }),
    lastDiscFingerprint: () => null,
    listDiscRecoveries: () => [],
    recordDiscDetection: (fingerprint, discType, mediaType) => detectedRecovery(fingerprint, discType, mediaType),
    begin: () => ({ id: "job-confirmed-movie" }),
    record: (...args) => calls.push(["record", ...args]),
    fail: (...args) => calls.push(["fail", ...args]),
    wasJobCancelled: () => false
  };
  try {
    const result = await workflow.process({
      source: {
        provider: {},
        candidate: {
          providerId: "source.video-dvd.makemkv",
          sourceId: "drive-1",
          mediaKind: "dvd",
          label: "Movie Disc",
          manifest: {
            mediaKind: "dvd",
            items: [{ id: "1", kind: "title", title: "Feature", durationSeconds: 7200 }]
          }
        }
      },
      sources: {},
      jobs,
      metadata: {},
      signal: new AbortController().signal,
      devicePath: "/dev/sr0"
    });
    assert.equal(result, true);
    assert.equal(tvAnalysisCalls, 0);
    const classificationEvent = calls.find(([name, , stage]) =>
      name === "record" && stage === "tv-classification"
    );
    assert.ok(classificationEvent);
    assert.equal(JSON.parse(classificationEvent[4]).decision, "movie");
    assert.ok(calls.some(([name]) => name === "fail"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
    const episode = firstItem.suggestedEpisodes[0] ?? firstItem.alternatives[0]?.episodes[0];
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

test("reviewer can mark a track unknown and persist the decision without affecting matching", async () => {
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
    const result = await service.prepare(tvSource(), "fingerprint-unknown");
    assert.ok(result);
    const review = new TvReviewService(repositories.tvEpisodeFeedback, repositories.tvProcessingPlans);
    const updated = review.markUnknown(result.plan.id, "1", "admin", "Disc label is ambiguous");
    assert.equal(updated.state, "awaiting-review");
    assert.equal(updated.executionEnabled, false);
    assert.equal(updated.assignments.find((assignment) => assignment.itemId === "1").decision, "unknown");
    assert.deepEqual(
      repositories.tvProcessingPlans.list(10, "awaiting-review").map((plan) => plan.id),
      [result.plan.id]
    );
    assert.equal(updated.reviewHistory.at(-1).decision, "mark-unknown");
    assert.equal(repositories.tvEpisodeFeedback.listForFingerprint("fingerprint-unknown").length, 0);
  } finally {
    repositories.close();
  }
});
