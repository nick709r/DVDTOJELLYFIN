import assert from "node:assert/strict";
import test from "node:test";
import { TvAnalysisEngine, tvItemSignature } from "../dist/application/tv-analysis-engine.js";
import { TvEpisodeMatchingEngine } from "../dist/application/tv-episode-matching-engine.js";

const analysisEngine = new TvAnalysisEngine();
const matchingEngine = new TvEpisodeMatchingEngine();

function analysisInput(items, episodeCandidates = []) {
  return {
    sourceId: "drive-1",
    manifestId: "manifest-1",
    fingerprint: "disc-fingerprint",
    manifest: { mediaKind: "dvd", items },
    disc: { seasonNumber: 1, discNumber: 1, discCount: 2 },
    metadata: {
      seriesCandidates: [{ series: { id: "series-1", title: "Example Show" }, providerId: "test", confidence: 0.95 }],
      seasonCandidates: [{ seriesId: "series-1", season: { seriesId: "series-1", number: 1 }, providerId: "test", confidence: 0.95 }],
      episodeCandidates
    }
  };
}

function episodeCandidate(itemId, episodeNumber, confidence = 0.96, overrides = {}) {
  return {
    itemId,
    episode: { seriesId: "series-1", seasonNumber: 1, episodeNumber, title: `Episode ${episodeNumber}` },
    providerId: "test",
    confidence,
    runtimeSeconds: 1200,
    ...overrides
  };
}

function analyze(items, candidates, overrides = {}) {
  return analysisEngine.analyze({
    ...analysisInput(items, candidates),
    ...overrides
  });
}

test("episode matcher suggests a high-confidence episode with confidence components and explanations", () => {
  const analysis = analyze(
    [{ id: "track-1", kind: "title", title: "Episode 1", durationSeconds: 1200 }],
    [episodeCandidate("track-1", 1)]
  );
  const report = matchingEngine.match({ analysis });

  assert.equal(report.items[0].decision, "suggested");
  assert.equal(report.items[0].suggestedEpisodes[0].episodeNumber, 1);
  assert.ok(report.items[0].confidence >= 0.72);
  assert.match(report.items[0].evidence.join(" "), /runtime|metadata|title/i);
  assert.equal(report.items[0].manualReviewRequired, false);
});

test("episode matcher returns unknown for weak or ambiguous candidates instead of forcing a match", () => {
  const weak = analyze(
    [{ id: "weak", kind: "title", title: "Unclear", durationSeconds: 1200 }],
    [episodeCandidate("weak", 3, 0.2)]
  );
  assert.equal(matchingEngine.match({ analysis: weak }).items[0].decision, "unknown");

  const ambiguous = analyze(
    [{ id: "ambiguous", kind: "title", title: "Unclear", durationSeconds: 1200 }],
    [episodeCandidate("ambiguous", 3, 0.9), episodeCandidate("ambiguous", 4, 0.88)]
  );
  const result = matchingEngine.match({ analysis: ambiguous }).items[0];
  assert.equal(result.decision, "unknown");
  assert.equal(result.suggestedEpisodes.length, 0);
  assert.match(result.evidence.join(" "), /below the .* required margin/);
});

test("episode matcher combines explicit multi-part metadata and total runtime", () => {
  const candidates = [
    episodeCandidate("double", 4, 0.9, {
      runtimeSeconds: 1100, multiPartGroupId: "finale", partNumber: 1, partCount: 2
    }),
    episodeCandidate("double", 5, 0.9, {
      runtimeSeconds: 1200, multiPartGroupId: "finale", partNumber: 2, partCount: 2
    })
  ];
  const analysis = analyze([{ id: "double", kind: "title", title: "Season finale", durationSeconds: 2300 }], candidates);
  const result = matchingEngine.match({ analysis, episodeMetadata: candidates }).items[0];

  assert.equal(result.decision, "suggested");
  assert.equal(result.suggestedEpisodes.length, 2);
  assert.deepEqual(result.suggestedEpisodes.map((episode) => episode.episodeNumber), [4, 5]);
  assert.match(result.evidence.join(" "), /groups 2 consecutive episodes/);
  assert.ok(result.alternatives.some((option) => option.kind === "multi-part"));
});

test("incomplete multi-part metadata remains unknown rather than degrading to one episode", () => {
  const candidates = [
    episodeCandidate("double", 4, 0.98, {
      runtimeSeconds: 1100, multiPartGroupId: "incomplete", partNumber: 1, partCount: 2
    })
  ];
  const analysis = analyze([{ id: "double", kind: "title", title: "Finale", durationSeconds: 2200 }], candidates);
  const result = matchingEngine.match({ analysis, episodeMetadata: candidates }).items[0];

  assert.equal(result.decision, "unknown");
  assert.equal(result.suggestedEpisodes.length, 0);
  assert.match(result.evidence.join(" "), /incomplete or inconsistent/);
});

test("episode matcher applies exact-disc accepted, rejected, and manual correction history", () => {
  const candidate = episodeCandidate("track", 2, 0.95);
  const analysis = analyze([{ id: "track", kind: "title", title: "Episode 2", durationSeconds: 1200 }], [candidate]);
  const item = analysis.items[0];
  const feedback = (outcome, episodes, reason) => ({
    id: `feedback-${outcome}`,
    fingerprint: analysis.fingerprint,
    itemSignature: item.itemSignature,
    outcome,
    episodes,
    reason,
    createdAt: "2026-10-19T12:00:00.000Z"
  });
  const accepted = matchingEngine.match({
    analysis,
    feedback: [feedback("accepted", [candidate.episode], "Verified on disc")]
  }).items[0];
  assert.equal(accepted.decision, "accepted");
  assert.equal(accepted.confidence, 1);

  const rejected = matchingEngine.match({
    analysis,
    feedback: [feedback("rejected", [candidate.episode], "Metadata lists the wrong order")]
  }).items[0];
  assert.equal(rejected.decision, "unknown");
  assert.match(rejected.evidence.join(" "), /Previously rejected/);

  const manualEpisodes = [
    candidate.episode,
    { seriesId: "series-1", seasonNumber: 1, episodeNumber: 3, title: "Episode 3" }
  ];
  const manual = matchingEngine.match({
    analysis,
    feedback: [feedback("manual-assignment", manualEpisodes, "One title contains two episodes")]
  }).items[0];
  assert.equal(manual.decision, "manual-assignment");
  assert.equal(manual.suggestedEpisodes.length, 2);
  assert.equal(manual.assignmentMethod, "user-correction");
});

test("exact fingerprint history takes priority over disc mapping and runtime matching", () => {
  const item = { id: "track", kind: "title", title: "Unclear", durationSeconds: 1200 };
  const signature = tvItemSignature(item);
  const episode = { seriesId: "series-1", seasonNumber: 1, episodeNumber: 4, title: "Historical Episode" };
  const analysis = analyze([item], [
    episodeCandidate("track", 2, 0.99),
    episodeCandidate("track", 3, 0.98)
  ], {
    history: [{
      fingerprint: "disc-fingerprint",
      series: { id: "series-1", title: "Example Show" },
      seasonNumber: 1,
      discNumber: 1,
      episodeMatches: [{ itemSignature: signature, episode, confidence: 1 }]
    }]
  });
  const result = matchingEngine.match({
    analysis,
    providerDiscEpisodes: [{
      episode: { seriesId: "series-1", seasonNumber: 1, episodeNumber: 1 },
      providerId: "tvdb",
      discNumber: 1,
      discOrder: 1,
      confidence: 1
    }]
  }).items[0];

  assert.equal(result.assignmentMethod, "exact-fingerprint-history");
  assert.equal(result.suggestedEpisodes[0].episodeNumber, 4);
  assert.equal(result.confidence, 1);
});

test("a later rejection supersedes an earlier acceptance for the same track", () => {
  const candidate = episodeCandidate("track", 2, 0.95);
  const analysis = analyze([{ id: "track", kind: "title", title: "Episode 2", durationSeconds: 1200 }], [candidate]);
  const item = analysis.items[0];
  const report = matchingEngine.match({
    analysis,
    feedback: [
      {
        id: "rejected-later",
        fingerprint: analysis.fingerprint,
        itemSignature: item.itemSignature,
        outcome: "rejected",
        episodes: [candidate.episode],
        reason: "Episode numbering differs on this release",
        createdAt: "2026-10-19T12:01:00.000Z"
      },
      {
        id: "accepted-earlier",
        fingerprint: analysis.fingerprint,
        itemSignature: item.itemSignature,
        outcome: "accepted",
        episodes: [candidate.episode],
        createdAt: "2026-10-19T12:00:00.000Z"
      }
    ]
  }).items[0];
  assert.equal(report.decision, "unknown");
  assert.match(report.evidence.join(" "), /Previously rejected/);
});

test("episode matcher reports duplicate, alternate, commentary, and bonus items for review", () => {
  const analysis = analyze([
    { id: "episode", kind: "title", title: "Pilot", durationSeconds: 1200, attributes: {
      chapterCount: 8, streamLayout: "1 video/2 audio/1 subtitle", videoCodec: "mpeg2",
      width: 720, height: 480, playbackStructure: "playlist-1"
    } },
    { id: "duplicate", kind: "title", title: "Pilot", durationSeconds: 1200, attributes: {
      chapterCount: 8, streamLayout: "1 video/2 audio/1 subtitle", videoCodec: "mpeg2",
      width: 720, height: 480, playbackStructure: "playlist-1"
    } },
    { id: "alternate", kind: "title", title: "Pilot Extended", durationSeconds: 1800 },
    { id: "commentary", kind: "title", title: "Pilot Director Commentary", durationSeconds: 1200 },
    { id: "bonus", kind: "title", title: "Behind the Scenes", durationSeconds: 800 }
  ], [
    episodeCandidate("episode", 1),
    episodeCandidate("duplicate", 1),
    episodeCandidate("alternate", 1),
    episodeCandidate("commentary", 1)
  ]);
  const report = matchingEngine.match({ analysis });

  assert.equal(report.items.find((item) => item.itemId === "duplicate").decision, "duplicate");
  assert.equal(report.items.find((item) => item.itemId === "alternate").decision, "alternate-review");
  assert.equal(report.items.find((item) => item.itemId === "commentary").decision, "commentary");
  assert.equal(report.items.find((item) => item.itemId === "bonus").decision, "bonus");
  assert.ok(report.recommendations.some((recommendation) => recommendation.action === "review-duplicates"));
  assert.ok(report.recommendations.some((recommendation) => recommendation.action === "review-bonus-content"));
});

test("similar sitcom runtimes use sequential disc ordering rather than ambiguous runtime ranking", () => {
  const items = Array.from({ length: 8 }, (_, index) => ({
    id: `track-${index + 1}`,
    kind: "title",
    title: `Title ${index + 1}`,
    trackNumber: index + 1,
    durationSeconds: 1200
  }));
  const metadata = items.flatMap((item) =>
    Array.from({ length: 8 }, (_, index) => episodeCandidate(item.id, index + 1, 0.95))
  );
  const freshMetadata = metadata.map((candidate) => ({
    ...candidate,
    episode: {
      ...candidate.episode,
      seriesId: "fresh-off-the-boat",
      seasonNumber: 3
    }
  }));
  const analysis = analysisEngine.analyze({
    ...analysisInput(items, freshMetadata),
    discLabel: "Fresh Off the Boat Season 3 Disc 1",
    disc: { seasonNumber: 3, discNumber: 1, discCount: 3 },
    metadata: {
      seriesCandidates: [{
        series: { id: "fresh-off-the-boat", title: "Fresh Off the Boat" },
        providerId: "tvdb",
        confidence: 0.95
      }],
      seasonCandidates: [{
        seriesId: "fresh-off-the-boat",
        season: { seriesId: "fresh-off-the-boat", number: 3 },
        providerId: "tvdb",
        confidence: 0.95
      }],
      episodeCandidates: freshMetadata
    }
  });
  const report = matchingEngine.match({ analysis, episodeMetadata: freshMetadata });

  assert.deepEqual(report.items.map((item) => item.suggestedEpisodes[0]?.episodeNumber), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(report.items.every((item) =>
    item.decision === "suggested" &&
    item.confidence === 0.9 &&
    item.assignmentMethod === "sequential-disc-assignment" &&
    item.alternatives.length === 0 &&
    item.evidence.includes("Episode assigned using sequential disc ordering.")
  ));
});

test("provider DVD disc mapping wins without runtime ranking or candidate competition", () => {
  const items = Array.from({ length: 8 }, (_, index) => ({
    id: `track-${index + 1}`,
    kind: "title",
    title: `Title ${index + 1}`,
    trackNumber: index + 1,
    durationSeconds: 1200
  }));
  const metadata = items.flatMap((item) =>
    Array.from({ length: 8 }, (_, index) => episodeCandidate(item.id, index + 1, 0.95))
  );
  const providerDiscEpisodes = Array.from({ length: 8 }, (_, index) => ({
    episode: { seriesId: "series-1", seasonNumber: 1, episodeNumber: index + 1 },
    providerId: "tvdb",
    discNumber: 1,
    discOrder: index + 1,
    confidence: 1
  }));
  const analysis = analyze(items, metadata, {
    discLabel: "Example Show Season 1 Disc 1",
    providerDiscEpisodes
  });
  const report = matchingEngine.match({ analysis, episodeMetadata: metadata, providerDiscEpisodes });

  assert.ok(analysis.items.every((item) => item.candidates.length === 0));
  assert.deepEqual(report.items.map((item) => item.suggestedEpisodes[0]?.episodeNumber), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(report.items.every((item) =>
    item.decision === "suggested" &&
    item.confidence === 1 &&
    item.assignmentMethod === "provider-disc-mapping" &&
    item.alternatives.length === 0 &&
    item.evidence.includes("Episode assigned from provider disc mapping.")
  ));
});

test("multi-disc sequential fallback uses the disc offset and excludes obvious extras", () => {
  const items = [
    ...Array.from({ length: 8 }, (_, index) => ({
      id: `track-${index + 1}`,
      kind: "title",
      title: `Title ${index + 1}`,
      trackNumber: index + 1,
      durationSeconds: 1200
    })),
    { id: "bonus", kind: "title", title: "Behind the Scenes", durationSeconds: 900 }
  ];
  const metadata = items.slice(0, 8).flatMap((item) =>
    Array.from({ length: 16 }, (_, index) => episodeCandidate(item.id, index + 1, 0.95))
  );
  const analysis = analyze(items, metadata, {
    discLabel: "Example Show Season 1 Disc 2",
    disc: { seasonNumber: 1, discNumber: 2, discCount: 2 }
  });
  const incompleteProviderMapping = Array.from({ length: 7 }, (_, index) => ({
    episode: { seriesId: "series-1", seasonNumber: 1, episodeNumber: index + 1 },
    providerId: "tvdb",
    discNumber: 2,
    discOrder: index + 1,
    confidence: 1
  }));
  const report = matchingEngine.match({
    analysis,
    episodeMetadata: metadata,
    providerDiscEpisodes: incompleteProviderMapping
  });

  assert.deepEqual(report.items.slice(0, 8).map((item) => item.suggestedEpisodes[0]?.episodeNumber),
    [9, 10, 11, 12, 13, 14, 15, 16]);
  assert.ok(report.items.slice(0, 8).every((item) =>
    item.assignmentMethod === "sequential-disc-assignment" && item.confidence === 0.9
  ));
  assert.equal(report.items[8].decision, "bonus");
});

test("episode matcher keeps globally conflicting suggestions unknown", () => {
  const episode = { seriesId: "series-1", seasonNumber: 1, episodeNumber: 1 };
  const report = matchingEngine.match({
    analysis: {
      sourceId: "source",
      manifestId: "manifest",
      fingerprint: "fp",
      items: ["one", "two"].map((itemId) => ({
        itemId,
        itemSignature: `signature-${itemId}`,
        kind: "episode-candidate",
        confidence: 0.95,
        evidence: ["metadata evidence"],
        candidates: [{ episode, confidence: 0.95, evidence: ["metadata candidate"] }]
      }))
    }
  });
  assert.ok(report.items.every((item) => item.decision === "unknown"));
  assert.ok(report.items.every((item) => item.suggestedEpisodes.length === 0));
  assert.ok(report.items.every((item) => item.manualReviewRequired));
});

test("episode matcher validates confidence policy values", () => {
  const analysis = analyze([{ id: "track", kind: "title", title: "Pilot", durationSeconds: 1200 }], []);
  assert.throws(() => matchingEngine.match({ analysis, minimumConfidence: Number.NaN }), /must be finite/);
});
