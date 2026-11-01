import assert from "node:assert/strict";
import test from "node:test";
import { MediaReviewSearchService } from "../dist/application/media-review-search-service.js";
import { MovieReviewAdapter, TvReviewAdapter } from "../dist/application/media-review-adapters.js";
import { MetadataResolver } from "../dist/application/metadata-resolver.js";
import { TmdbMovieMetadataProvider } from "../dist/providers/metadata/tmdb-movie.js";

const tmdbResponse = (results) => async () => new Response(JSON.stringify({ results }), { status: 200 });

test("movie review search works with only the TMDB TV key and automatic lookup disabled", async () => {
  const provider = new TmdbMovieMetadataProvider(() => ({
    metadataEnabled: false,
    metadataApiKey: "",
    tvMetadataProviderApiKeys: { "tmdb-tv": "tv-key" }
  }), tmdbResponse([{ id: 7, title: "The Break-Up", release_date: "2006-06-02", popularity: 10, poster_path: "/p.jpg" }]));
  const service = new MediaReviewSearchService();
  service.register(new MovieReviewAdapter(new MetadataResolver([provider])));
  const outcome = await service.search("movie", "THE_BREAK_UP");
  assert.equal(outcome.candidates.length, 1);
  assert.equal(outcome.candidates[0].title, "The Break-Up");
  assert.equal(outcome.candidates[0].year, 2006);
  assert.equal(outcome.candidates[0].attributes.confirmTitle, "The Break-Up (2006)");
  assert.equal(outcome.emptyReason, undefined);
});

test("automatic movie lookup stays disabled when metadataEnabled is false", async () => {
  const provider = new TmdbMovieMetadataProvider(() => ({
    metadataEnabled: false, metadataApiKey: "key"
  }), tmdbResponse([{ id: 1, title: "X" }]));
  assert.deepEqual(await provider.identify({ entityType: "movie", query: "X" }), []);
});

test("review search reports why zero results are shown", async () => {
  const provider = new TmdbMovieMetadataProvider(() => ({ metadataEnabled: false, metadataApiKey: "" }));
  const service = new MediaReviewSearchService();
  service.register(new MovieReviewAdapter(new MetadataResolver([provider])));
  const outcome = await service.search("movie", "Anything");
  assert.equal(outcome.candidates.length, 0);
  assert.match(outcome.emptyReason, /API key is not configured/);
});

test("review search retries looser variants and ranks across media types identically", async () => {
  const queries = [];
  const provider = new TmdbMovieMetadataProvider(() => ({ metadataEnabled: true, metadataApiKey: "k" }), async (url) => {
    const query = new URL(url).searchParams.get("query");
    queries.push(query);
    return new Response(JSON.stringify({ results: query === "Up" ? [{ id: 2, title: "Up", release_date: "2009-01-01" }] : [] }), { status: 200 });
  });
  const tvLookup = {
    async searchSeries() {
      return [{ providerId: "tvdb", query: "Show", durationMs: 1, candidates: [
        { provider: "tvdb", providerName: "TVDB", seriesId: "1", title: "Show", seasonCount: 2, confidence: 0.4, identifiers: {} },
        { provider: "tvdb", providerName: "TVDB", seriesId: "1", title: "Show", seasonCount: 2, confidence: 0.4, identifiers: {} },
        { provider: "tvdb", providerName: "TVDB", seriesId: "2", title: "Show 2", confidence: 0.9, identifiers: {} }
      ] }];
    }
  };
  const service = new MediaReviewSearchService();
  service.register(new MovieReviewAdapter(new MetadataResolver([provider])));
  service.register(new TvReviewAdapter(tvLookup));
  const movie = await service.search("movie", "The Up");
  assert.deepEqual(queries.slice(0, 2), ["The Up", "Up"]);
  assert.equal(movie.candidates[0].id, "2");
  const tv = await service.search("tv", "Show");
  assert.deepEqual(tv.candidates.map((candidate) => candidate.id), ["2", "1"]);
  assert.equal(tv.candidates[1].detail, "2 seasons");
  await assert.rejects(service.search("music", "x"), /No review adapter/);
});
