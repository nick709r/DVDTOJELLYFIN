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
