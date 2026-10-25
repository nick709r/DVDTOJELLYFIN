import assert from "node:assert/strict";
import test from "node:test";
import { TvAnalysisEngine, tvItemSignature } from "../dist/application/tv-analysis-engine.js";

const engine = new TvAnalysisEngine();

function baseInput(overrides = {}) {
  return {
    sourceId: "drive-1",
    manifestId: "manifest-1",
    fingerprint: "disc-fingerprint",
    discLabel: "The Example Show Season 2 Disc 1",
    disc: { seasonNumber: 2, discNumber: 1, discCount: 3 },
    manifest: {
      mediaKind: "dvd",
      items: [
        { id: "1", kind: "title", title: "The Long Journey", durationSeconds: 2700 },
        { id: "2", kind: "title", title: "The Quiet Room", durationSeconds: 2640 }
      ]
    },
    metadata: {
      seriesCandidates: [{
        series: { id: "series-1", title: "The Example Show" },
        providerId: "metadata.test",
        confidence: 0.95
      }],
      seasonCandidates: [{
        seriesId: "series-1",
        season: { seriesId: "series-1", number: 2 },
        providerId: "metadata.test",
        confidence: 0.9
      }],
      episodeCandidates: [
        {
          itemId: "1",
          episode: { seriesId: "series-1", seasonNumber: 2, episodeNumber: 1, title: "The Long Journey" },
          providerId: "metadata.test",
          confidence: 0.8,
          runtimeSeconds: 2700
        },
        {
          itemId: "2",
          episode: { seriesId: "series-1", seasonNumber: 2, episodeNumber: 2, title: "The Quiet Room" },
          providerId: "metadata.test",
          confidence: 0.8,
          runtimeSeconds: 2700
        }
      ]
    },
    ...overrides
  };
}

function episodeNumbers(start, end) {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function providerDiscEpisodes(discEpisodeSets, confidence = 1) {
  return discEpisodeSets.flatMap(({ discNumber, episodes }) => episodes.map((episodeNumber, index) => ({
    episode: { seriesId: "series-1", seasonNumber: 2, episodeNumber },
    providerId: "tvdb",
    discNumber,
    discOrder: index + 1,
    confidence
  })));
}

function completedDisc(episodes, { fingerprint = "previous-disc", discNumber = 1 } = {}) {
  return {
    jobId: `completed-disc-${discNumber}`,
    fingerprint,
    metadataProvider: "metadata.test",
    providerId: "series-1",
    seriesName: "The Example Show",
    seasonNumber: 2,
    discNumber,
    mappings: [],
    episodes: episodes.map((episodeNumber) => ({
      seriesId: "series-1",
      seasonNumber: 2,
      episodeNumber
    })),
    completedAt: "2026-10-24T12:00:00.000Z"
  };
}

function assertConfidenceBreakdown(candidate) {
  const { baseScore, evidence, finalScore } = candidate.confidenceBreakdown;
  const total = baseScore + evidence.reduce((sum, entry) => sum + entry.scoreImpact, 0);
  assert.ok(Math.abs(total - finalScore) < 1e-8);
}

test("TV analysis combines metadata, title, runtime, and disc structure with explainable confidence", () => {
  const report = engine.analyze(baseInput());

  assert.equal(report.sourceId, "drive-1");
  assert.equal(report.manifestId, "manifest-1");
  assert.equal(report.detectedSeries.series.id, "series-1");
  assert.equal(report.detectedSeason.season.number, 2);
  assert.equal(report.items[0].candidates[0].episode.episodeNumber, 1);
  assert.ok(report.items[0].candidates[0].confidence > 0.8);
  assert.match(report.items[0].candidates[0].evidence.join(" "), /Runtime differs/);
  assert.equal(report.items[0].candidates[0].scoreComponents.metadata, 0.8);
  assert.equal(report.items[0].candidates[0].scoreComponents.titleSimilarity, 1);
  assert.equal(report.items[0].candidates[0].scoreComponents.runtimeSimilarity, 1);
  assert.ok(report.probableEpisodes.length >= 2);
});

test("TV analysis uses matching history and previous corrections as evidence without auto-assignment", () => {
  const input = baseInput();
  input.disc = { seasonNumber: 2 };
  const firstItem = input.manifest.items[0];
  const signature = tvItemSignature(firstItem);
  input.history = [{
    fingerprint: input.fingerprint,
    series: { id: "series-1", title: "The Example Show" },
    seasonNumber: 2,
    discNumber: 1,
    discCount: 3,
    episodeMatches: [{
      itemSignature: signature,
      episode: { seriesId: "series-1", seasonNumber: 2, episodeNumber: 1, title: "The Long Journey" },
      confidence: 0.9
    }]
  }];
  input.corrections = [{
    fingerprint: input.fingerprint,
    itemSignature: signature,
    episode: { seriesId: "series-1", seasonNumber: 2, episodeNumber: 9, title: "User-corrected episode" },
    reason: "Disc ordering is non-linear"
  }];

  const report = engine.analyze(input);
  assert.equal(report.disc.discNumber, 1);
  assert.equal(report.disc.discCount, 3);
  const corrected = report.items[0].candidates.find((candidate) => candidate.episode.episodeNumber === 9);
  assert.equal(corrected.confidence, 1);
  assert.match(corrected.evidence.join(" "), /non-linear/);
  assert.equal(report.items[0].candidates[0].episode.episodeNumber, 9);
  assert.equal(report.items[0].selected, undefined);
  assert.ok(report.recommendations.some((recommendation) => recommendation.action === "confirm-disc-position") === false);
});

test("a user-confirmed disc position is not overturned by a conflicting parsed label", () => {
  const report = engine.analyze(baseInput({
    disc: { seasonNumber: 2, discNumber: 1 },
    discStructureHints: [{
      source: "Optical disc volume label",
      seasonNumber: 2,
      discNumber: 2,
      confidence: 0.98
    }],
    discNumberUserConfirmed: true
  }));

  assert.equal(report.discPositionCandidates[0].discNumber, 1);
  assert.equal(report.disc.discNumber, 1);
});

test("completed episode history favors provider discs covering missing episodes", () => {
  const report = engine.analyze(baseInput({
    completedDiscHistory: [{
      jobId: "completed-disc-1",
      fingerprint: "older-disc",
      metadataProvider: "metadata.test",
      providerId: "series-1",
      seriesName: "The Example Show",
      seasonNumber: 2,
      discNumber: 1,
      mappings: [],
      episodes: [{ seriesId: "series-1", seasonNumber: 2, episodeNumber: 1 }],
      completedAt: "2026-10-24T12:00:00.000Z"
    }],
    providerDiscEpisodes: [
      {
        episode: { seriesId: "series-1", seasonNumber: 2, episodeNumber: 1 },
        providerId: "tvdb",
        discNumber: 1,
        discOrder: 1,
        confidence: 1
      },
      {
        episode: { seriesId: "series-1", seasonNumber: 2, episodeNumber: 2 },
        providerId: "tvdb",
        discNumber: 2,
        discOrder: 1,
        confidence: 0.8
      }
    ]
  }));

  assert.equal(report.discPositionCandidates[0].discNumber, 2);
  assert.ok(report.discPositionCandidates[0].confidence >= 0.9);
  assert.ok(report.discPositionCandidates[0].evidence.some((evidence) =>
    evidence.includes("Unimported episodes")
  ));
});

test("disc-position confidence exposes positive evidence and score impacts", () => {
  const report = engine.analyze(baseInput({
    disc: { seasonNumber: 2 },
    discStructureHints: [{
      source: "Optical disc volume label",
      seasonNumber: 2,
      discNumber: 2,
      confidence: 0.98
    }],
    completedDiscHistory: [{
      jobId: "completed-disc-1",
      fingerprint: "older-disc",
      metadataProvider: "metadata.test",
      providerId: "series-1",
      seriesName: "The Example Show",
      seasonNumber: 2,
      discNumber: 1,
      mappings: [],
      episodes: [{ seriesId: "series-1", seasonNumber: 2, episodeNumber: 1 }],
      completedAt: "2026-10-24T12:00:00.000Z"
    }],
    providerDiscEpisodes: [{
      episode: { seriesId: "series-1", seasonNumber: 2, episodeNumber: 2 },
      providerId: "tvdb",
      discNumber: 2,
      discOrder: 1,
      confidence: 1
    }]
  }));
  const candidate = report.discPositionCandidates.find((entry) => entry.discNumber === 2);
  const evidence = candidate.confidenceBreakdown.evidence;

  assert.ok(evidence.some((entry) =>
    entry.type === "positive" && entry.category === "disc-label" &&
    entry.message === "Disc label suggests Season 2 Disc 2"
  ));
  assert.ok(evidence.some((entry) =>
    entry.type === "positive" && entry.category === "missing-episodes" &&
    entry.message.includes("episodes not found")
  ));
  assert.ok(evidence.some((entry) =>
    entry.type === "neutral" && entry.category === "metadata"
  ));
  const scoreTotal = candidate.confidenceBreakdown.baseScore +
    evidence.reduce((sum, entry) => sum + entry.scoreImpact, 0);
  assert.ok(Math.abs(scoreTotal - candidate.confidenceBreakdown.finalScore) < 1e-8);
});

test("disc-position evidence explains completed discs, overlap, label conflicts, and alternatives", () => {
  const report = engine.analyze(baseInput({
    disc: { seasonNumber: 2, discNumber: 1 },
    discStructureHints: [{
      source: "Optical disc volume label",
      seasonNumber: 2,
      discNumber: 2,
      confidence: 0.98
    }],
    completedDiscHistory: [{
      jobId: "completed-disc-1",
      fingerprint: "older-disc",
      metadataProvider: "metadata.test",
      providerId: "series-1",
      seriesName: "The Example Show",
      seasonNumber: 2,
      discNumber: 1,
      mappings: [],
      episodes: [
        { seriesId: "series-1", seasonNumber: 2, episodeNumber: 1 },
        { seriesId: "series-1", seasonNumber: 2, episodeNumber: 2 }
      ],
      completedAt: "2026-10-24T12:00:00.000Z"
    }],
    providerDiscEpisodes: [
      ...[1, 2].map((episodeNumber) => ({
        episode: { seriesId: "series-1", seasonNumber: 2, episodeNumber },
        providerId: "tvdb",
        discNumber: 1,
        discOrder: episodeNumber,
        confidence: 1
      })),
      ...[3, 4].map((episodeNumber) => ({
        episode: { seriesId: "series-1", seasonNumber: 2, episodeNumber },
        providerId: "tvdb",
        discNumber: 2,
        discOrder: episodeNumber - 2,
        confidence: 1
      }))
    ]
  }));
  const completedCandidate = report.discPositionCandidates.find((entry) => entry.discNumber === 1);
  const negativeEvidence = completedCandidate.confidenceBreakdown.evidence.filter((entry) =>
    entry.type === "negative"
  );

  assert.ok(negativeEvidence.some((entry) =>
    entry.category === "completed-disc-history" && entry.message.includes("already completed")
  ));
  assert.ok(negativeEvidence.some((entry) =>
    entry.category === "episode-overlap" && entry.message.includes("overlaps imported episodes")
  ));
  assert.ok(negativeEvidence.some((entry) =>
    entry.category === "disc-label" && entry.message.includes("conflicts with disc-label")
  ));
  assert.ok(report.discPositionCandidates.some((candidate) =>
    candidate.discNumber !== report.discPositionCandidates[0].discNumber &&
    candidate.confidenceBreakdown.evidence.some((entry) => entry.category === "candidate-ranking")
  ));
  for (const candidate of report.discPositionCandidates) {
    const scoreTotal = candidate.confidenceBreakdown.baseScore +
      candidate.confidenceBreakdown.evidence.reduce((sum, entry) => sum + entry.scoreImpact, 0);
    assert.ok(Math.abs(scoreTotal - candidate.confidenceBreakdown.finalScore) < 1e-8);
  }
});

test("disc-position evidence reports fingerprint history and user confirmation neutrally", () => {
  const history = [{
    jobId: "completed-disc-1",
    fingerprint: "disc-fingerprint",
    metadataProvider: "metadata.test",
    providerId: "series-1",
    seriesName: "The Example Show",
    seasonNumber: 2,
    discNumber: 1,
    mappings: [],
    episodes: [{ seriesId: "series-1", seasonNumber: 2, episodeNumber: 1 }],
    completedAt: "2026-10-24T12:00:00.000Z"
  }];
  const report = engine.analyze(baseInput({
    completedDiscHistory: history,
    seasonNumberUserConfirmed: true
  }));
  const candidate = report.discPositionCandidates.find((entry) => entry.discNumber === 1);

  assert.ok(candidate.confidenceBreakdown.evidence.some((entry) =>
    entry.category === "fingerprint" && entry.type === "neutral" &&
    entry.message.includes("matches a previously processed disc")
  ));
  assert.ok(candidate.confidenceBreakdown.evidence.some((entry) =>
    entry.category === "user-confirmation" && entry.type === "neutral"
  ));
  assert.equal(candidate.confidence, 1);
  assert.ok(!candidate.confidenceBreakdown.evidence.some((entry) =>
    entry.category === "completed-disc-history" && entry.type === "negative"
  ));
});

test("completed Disc 1 history identifies Disc 2 as the expected continuation", () => {
  const report = engine.analyze(baseInput({
    fingerprint: "new-disc-2",
    disc: { seasonNumber: 2, discNumber: 2 },
    completedDiscHistory: [completedDisc(episodeNumbers(1, 8))],
    providerDiscEpisodes: providerDiscEpisodes([
      { discNumber: 1, episodes: episodeNumbers(1, 8) },
      { discNumber: 2, episodes: episodeNumbers(9, 16) },
      { discNumber: 3, episodes: episodeNumbers(17, 22) }
    ], 0.3)
  }));
  const discTwo = report.discPositionCandidates.find((candidate) => candidate.discNumber === 2);
  const continuity = discTwo.confidenceBreakdown.continuity;
  const evidence = discTwo.confidenceBreakdown.evidence;

  assert.equal(continuity.highestImportedEpisodeNumber, 8);
  assert.equal(continuity.expectedNextEpisodeNumber, 9);
  assert.deepEqual(continuity.expectedRemainingEpisodeRange, { start: 9, end: 22 });
  assert.deepEqual(continuity.importedEpisodeRanges, [{ start: 1, end: 8 }]);
  assert.deepEqual(continuity.remainingEpisodeRanges, [{ start: 9, end: 22 }]);
  assert.ok(evidence.some((entry) => entry.message === "Expected next episode: S02E09"));
  assert.ok(evidence.some((entry) => entry.message === "Expected remaining episode range: S02E09-S02E22"));
  assert.ok(evidence.some((entry) =>
    entry.type === "positive" && entry.message.includes("begins near expected continuation S02E09") &&
    entry.scoreImpact > 0
  ));
  assert.ok(evidence.some((entry) =>
    entry.type === "positive" && entry.message.includes("covers missing episodes S02E09-S02E16") &&
    entry.scoreImpact > 0
  ));
  assert.ok(discTwo.confidence > report.discPositionCandidates.find((candidate) =>
    candidate.discNumber === 1
  ).confidence);
  assertConfidenceBreakdown(discTwo);
});

test("partial imports make the first unimported episode the continuity boundary", () => {
  const report = engine.analyze(baseInput({
    fingerprint: "partial-disc",
    disc: { seasonNumber: 2, discNumber: 2 },
    completedDiscHistory: [completedDisc(episodeNumbers(1, 4))],
    providerDiscEpisodes: providerDiscEpisodes([
      { discNumber: 1, episodes: episodeNumbers(1, 4) },
      { discNumber: 2, episodes: episodeNumbers(5, 8) },
      { discNumber: 3, episodes: episodeNumbers(9, 12) }
    ], 0.2)
  }));
  const discTwo = report.discPositionCandidates.find((candidate) => candidate.discNumber === 2);

  assert.equal(discTwo.confidenceBreakdown.continuity.highestImportedEpisodeNumber, 4);
  assert.equal(discTwo.confidenceBreakdown.continuity.expectedNextEpisodeNumber, 5);
  assert.deepEqual(discTwo.confidenceBreakdown.continuity.expectedRemainingEpisodeRange, {
    start: 5,
    end: 12
  });
  assert.ok(discTwo.confidenceBreakdown.evidence.some((entry) =>
    entry.type === "positive" && entry.message.includes("begins near expected continuation S02E05")
  ));
  assert.ok(discTwo.confidenceBreakdown.evidence.some((entry) =>
    entry.type === "positive" && entry.message.includes("covers missing episodes S02E05-S02E08")
  ));
  assertConfidenceBreakdown(discTwo);
});

test("continuity preserves missing episode gaps in a partially imported season", () => {
  const importedEpisodeNumbers = [
    ...episodeNumbers(1, 4),
    ...episodeNumbers(9, 12)
  ];
  const report = engine.analyze(baseInput({
    fingerprint: "midseason-gap",
    disc: { seasonNumber: 2, discNumber: 4 },
    completedDiscHistory: [completedDisc(importedEpisodeNumbers, { discNumber: 3 })],
    providerDiscEpisodes: providerDiscEpisodes([
      { discNumber: 1, episodes: episodeNumbers(1, 4) },
      { discNumber: 2, episodes: episodeNumbers(5, 8) },
      { discNumber: 3, episodes: episodeNumbers(9, 12) },
      { discNumber: 4, episodes: episodeNumbers(13, 20) }
    ], 0.2)
  }));
  const discFour = report.discPositionCandidates.find((candidate) => candidate.discNumber === 4);
  const continuity = discFour.confidenceBreakdown.continuity;

  assert.equal(continuity.highestImportedEpisodeNumber, 12);
  assert.equal(continuity.expectedNextEpisodeNumber, 13);
  assert.deepEqual(continuity.expectedRemainingEpisodeRange, { start: 13, end: 20 });
  assert.deepEqual(continuity.remainingEpisodeRanges, [
    { start: 5, end: 8 },
    { start: 13, end: 20 }
  ]);
  const discTwo = report.discPositionCandidates.find((candidate) => candidate.discNumber === 2);
  assert.ok(discTwo.confidenceBreakdown.evidence.some((entry) =>
    entry.type === "positive" && entry.message.includes("covers missing episodes S02E05-S02E08")
  ));
  assert.ok(discTwo.confidenceBreakdown.evidence.some((entry) =>
    entry.type === "negative" && entry.message.includes("starts before imported episode boundary S02E13")
  ));
  assertConfidenceBreakdown(discFour);
  assertConfidenceBreakdown(discTwo);
});

test("duplicate disc insertion exposes overlap, duplicate, and before-boundary penalties", () => {
  const report = engine.analyze(baseInput({
    disc: { seasonNumber: 2, discNumber: 1 },
    completedDiscHistory: [completedDisc(episodeNumbers(1, 8), { fingerprint: "disc-fingerprint" })],
    providerDiscEpisodes: providerDiscEpisodes([
      { discNumber: 1, episodes: episodeNumbers(1, 8) },
      { discNumber: 2, episodes: episodeNumbers(9, 16) }
    ])
  }));
  const duplicateDisc = report.discPositionCandidates.find((candidate) => candidate.discNumber === 1);
  const evidence = duplicateDisc.confidenceBreakdown.evidence;

  assert.ok(evidence.some((entry) =>
    entry.type === "negative" && entry.message.includes("overlaps already imported episodes S02E01-S02E08")
  ));
  assert.ok(evidence.some((entry) =>
    entry.type === "negative" && entry.message.includes("duplicates imported episodes S02E01-S02E08")
  ));
  assert.ok(evidence.some((entry) =>
    entry.type === "negative" && entry.message.includes("starts before imported episode boundary S02E09")
  ));
  const continuationDisc = report.discPositionCandidates.find((candidate) => candidate.discNumber === 2);
  assert.ok(continuationDisc.confidenceBreakdown.evidence.some((entry) =>
    entry.type === "positive" && entry.message.includes("begins near expected continuation S02E09")
  ));
  assert.ok(report.discPositionCandidates.includes(duplicateDisc));
  assert.equal(report.discPositionCandidates[0].discNumber, 1);
  assertConfidenceBreakdown(duplicateDisc);
});

test("TV analysis identifies duplicate episodes and alternate cuts", () => {
  const input = baseInput({
    manifest: {
      mediaKind: "dvd",
      items: [
        { id: "1", kind: "title", title: "Pilot", durationSeconds: 2700, attributes: {
          chapterCount: 8, streamLayout: "1 video/2 audio/1 subtitle", videoCodec: "mpeg2",
          width: 720, height: 480, playbackStructure: "playlist-1"
        } },
        { id: "2", kind: "title", title: "Pilot", durationSeconds: 2690, attributes: {
          chapterCount: 8, streamLayout: "1 video/2 audio/1 subtitle", videoCodec: "mpeg2",
          width: 720, height: 480, playbackStructure: "playlist-1"
        } },
        { id: "3", kind: "title", title: "Pilot Extended", durationSeconds: 3300 }
      ]
    },
    metadata: {
      seriesCandidates: [{
        series: { id: "series-1", title: "The Example Show" },
        providerId: "metadata.test",
        confidence: 0.9
      }],
      seasonCandidates: [],
      episodeCandidates: [1, 2, 3].map((itemNumber) => ({
        itemId: String(itemNumber),
        episode: { seriesId: "series-1", seasonNumber: 1, episodeNumber: 1, title: "Pilot" },
        providerId: "metadata.test",
        confidence: 0.9,
        runtimeSeconds: 2700
      }))
    }
  });
  const report = engine.analyze(input);
  assert.equal(report.probableDuplicates.length, 1);
  assert.deepEqual(report.probableDuplicates[0], {
    itemId: "2",
    relatedItemId: "1",
    confidence: 0.99,
    evidence: [
      "Chapter structure, stream layout, video properties, and playback structure match",
      "Runtime differs by no more than 3%",
      "Track titles are highly similar (1.00)"
    ]
  });
  assert.ok(report.probableAlternates.some((relationship) => relationship.itemId === "3"));
  assert.ok(report.recommendations.some((recommendation) => recommendation.action === "review-duplicates"));
  assert.ok(report.recommendations.some((recommendation) => recommendation.action === "review-alternates"));
});

test("TV analysis does not classify similar episode candidates as duplicates without matching structure", () => {
  const input = baseInput({
    manifest: {
      mediaKind: "dvd",
      items: [
        { id: "1", kind: "title", title: "Episode", durationSeconds: 2700 },
        { id: "2", kind: "title", title: "Episode", durationSeconds: 2690 }
      ]
    },
    metadata: {
      seriesCandidates: [{
        series: { id: "series-1", title: "The Example Show" },
        providerId: "metadata.test",
        confidence: 0.95
      }],
      seasonCandidates: [],
      episodeCandidates: [1, 2].map((itemNumber) => ({
        itemId: String(itemNumber),
        episode: { seriesId: "series-1", seasonNumber: 1, episodeNumber: 1, title: "Episode" },
        providerId: "metadata.test",
        confidence: 0.9,
        runtimeSeconds: 2700
      }))
    }
  });
  const report = engine.analyze(input);
  assert.equal(report.probableDuplicates.length, 0);
  assert.ok(report.items.every((item) => item.kind === "episode-candidate"));
});

test("TV analysis classifies bonus, commentary, and short special features", () => {
  const report = engine.analyze(baseInput({
    manifest: {
      mediaKind: "dvd",
      items: [
        { id: "extra", kind: "title", title: "Behind the Scenes", durationSeconds: 900 },
        { id: "commentary", kind: "title", title: "Episode 1 Director Commentary", durationSeconds: 2700 },
        { id: "short", kind: "title", title: "Studio Logo", durationSeconds: 30 }
      ]
    },
    metadata: { seriesCandidates: [], seasonCandidates: [], episodeCandidates: [] }
  }));
  assert.equal(report.probableBonusContent[0].itemId, "extra");
  assert.equal(report.commentaryTracks[0].itemId, "commentary");
  assert.equal(report.specialFeatures[0].itemId, "short");
  assert.ok(report.recommendations.some((recommendation) => recommendation.action === "review-bonus-content"));
  assert.ok(report.recommendations.some((recommendation) => recommendation.action === "review-special-features"));
});

test("TV analysis retains uncertain candidates and recommends review rather than assigning", () => {
  const report = engine.analyze(baseInput({
    metadata: {
      seriesCandidates: [],
      seasonCandidates: [],
      episodeCandidates: [{
        itemId: "1",
        episode: { seriesId: "series-unknown", seasonNumber: 2, episodeNumber: 4 },
        providerId: "metadata.test",
        confidence: 0.2
      }]
    }
  }));
  assert.equal(report.detectedSeries, undefined);
  assert.equal(report.items[0].candidates[0].confidence, 0.2);
  assert.ok(report.recommendations.some((recommendation) => recommendation.action === "confirm-series"));
  assert.ok(report.recommendations.some((recommendation) => recommendation.action === "review-episode-candidates"));
  assert.equal(report.items[0].selected, undefined);
});

test("TV analysis rejects invalid IDs, duplicate manifest items, and non-finite confidence", () => {
  assert.throws(() => engine.analyze(baseInput({ sourceId: " " })), /source and manifest IDs/);
  assert.throws(() => engine.analyze(baseInput({
    manifest: { mediaKind: "dvd", items: [{ id: "1", kind: "title" }, { id: "1", kind: "title" }] }
  })), /duplicate item ID/);
  assert.throws(() => engine.analyze(baseInput({
    metadata: {
      seriesCandidates: [{ series: { title: "Example" }, providerId: "metadata.test", confidence: Number.NaN }],
      seasonCandidates: [],
      episodeCandidates: []
    }
  })), /finite number/);
});
