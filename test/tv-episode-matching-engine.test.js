import assert from "node:assert/strict";
import test from "node:test";
import { TvAnalysisEngine } from "../dist/application/tv-analysis-engine.js";
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
    { id: "episode", kind: "title", title: "Pilot", durationSeconds: 1200 },
    { id: "duplicate", kind: "title", title: "Pilot", durationSeconds: 1200 },
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
