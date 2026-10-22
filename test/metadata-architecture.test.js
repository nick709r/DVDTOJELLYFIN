import assert from "node:assert/strict";
import test from "node:test";
import { MetadataProviderRegistry } from "../dist/application/metadata-provider-registry.js";
import { MetadataResolver } from "../dist/application/metadata-resolver.js";
import { TmdbMovieMetadataProvider } from "../dist/providers/metadata/tmdb-movie.js";

function provider(id, identify, healthCheck = async () => ({ status: "available" })) {
  return {
    describe: () => ({ id, apiVersion: "1.0.0", kind: "metadata", capabilities: ["metadata.movie.identification"] }),
    initialize: async () => {},
    healthCheck,
    dispose: async () => {},
    identify
  };
}

test("metadata resolver ranks candidates across registered providers with deterministic ties", async () => {
  const registry = new MetadataProviderRegistry();
  registry.register(provider("metadata.first", async () => [
    { id: "first", entityType: "movie", title: "First", confidence: 0.8, metadata: {} }
  ]));
  registry.register(provider("metadata.second", async () => [
    { id: "second", entityType: "movie", title: "Second", confidence: 0.8, metadata: {} },
    { id: "third", entityType: "movie", title: "Third", confidence: 0.4, metadata: {} }
  ]));
  const resolver = new MetadataResolver(registry.list());

  const result = await resolver.resolve({ entityType: "movie", query: "Example" });
  assert.equal(result.selected?.providerId, "metadata.first");
  assert.deepEqual(result.candidates.map((candidate) => candidate.title), ["First", "Second", "Third"]);
  assert.deepEqual(await registry.healthCheckAll(), [
    { providerId: "metadata.first", health: { status: "available" } },
    { providerId: "metadata.second", health: { status: "available" } }
  ]);
});

test("metadata resolver records provider failure and falls back to remaining candidates", async () => {
  const resolver = new MetadataResolver([
    provider("metadata.offline", async () => { throw new Error("offline"); }),
    provider("metadata.fallback", async () => [
      { id: "fallback", entityType: "series", title: "Series", confidence: 0.6, metadata: {} }
    ])
  ]);

  const result = await resolver.resolve({ entityType: "series", query: "Example" });
  assert.equal(result.selected?.title, "Series");
  assert.deepEqual(result.providerFailures, [{ providerId: "metadata.offline", message: "offline" }]);
});

test("metadata resolver enriches selected metadata through its owning provider", async () => {
  const resolver = new MetadataResolver([{
    ...provider("metadata.details", async () => [
      { id: "movie-1", entityType: "movie", title: "Example", confidence: 0.9, metadata: { title: "Example" } }
    ]),
    enrich: async (candidate) => ({ ...candidate, metadata: { ...candidate.metadata, overview: "Imported details" } })
  }]);
  const result = await resolver.resolve({ entityType: "movie", query: "Example" });
  assert.equal((await resolver.enrich(result.selected)).metadata.overview, "Imported details");
});

test("metadata provider registry rejects non-metadata providers and duplicate IDs", () => {
  const registry = new MetadataProviderRegistry();
  const first = provider("metadata.same", async () => []);
  registry.register(first);
  assert.throws(() => registry.register(first), /already registered/);
  assert.throws(() => registry.register({
    ...provider("source.wrong-kind", async () => []),
    describe: () => ({ id: "source.wrong-kind", apiVersion: "1.0.0", kind: "source", capabilities: ["source.read"] })
  }), /not a metadata provider/);
});

test("metadata provider health failures become explicit unavailable health results", async () => {
  const registry = new MetadataProviderRegistry();
  registry.register(provider("metadata.broken-health", async () => [], async () => {
    throw new Error("health endpoint failed");
  }));
  assert.deepEqual(await registry.healthCheckAll(), [{
    providerId: "metadata.broken-health",
    health: {
      status: "unavailable",
      message: "Metadata provider health check failed: health endpoint failed"
    }
  }]);
});

test("TMDB metadata provider scores title similarity above raw popularity", async () => {
  const provider = new TmdbMovieMetadataProvider(() => ({
    metadataEnabled: true,
    metadataApiKey: "test-key"
  }), async () => new Response(JSON.stringify({
    results: [
      { id: 1, title: "The Exact Film", popularity: 2, release_date: "2020-01-01" },
      { id: 2, title: "Unrelated Blockbuster", popularity: 1000, release_date: "2024-01-01" }
    ]
  }), { status: 200 }));

  const result = await new MetadataResolver([provider])
    .resolve({ entityType: "movie", query: "The Exact Film" });
  assert.equal(result.selected?.id, "1");
  assert.ok(result.candidates[0].confidence > result.candidates[1].confidence);
});

test("TMDB movie enrichment returns normalized details, ratings, cast, and provider artwork", async () => {
  let requestedUrl;
  const provider = new TmdbMovieMetadataProvider(() => ({
    metadataEnabled: true,
    metadataApiKey: "test-key"
  }), async (url) => {
    requestedUrl = new URL(url);
    return new Response(JSON.stringify({
      id: 123,
      title: "Example",
      release_date: "2022-03-04",
      overview: "A plot",
      vote_average: 8.5,
      genres: [{ name: "Drama" }],
      credits: { cast: [{ name: "Actor" }] },
      poster_path: "/poster.jpg",
      images: { logos: [{ file_path: "/logo.png" }] }
    }), { status: 200 });
  });
  const enriched = await provider.enrich({
    id: "123", entityType: "movie", title: "Example", confidence: 0.9,
    metadata: {}, identifiers: { tmdbMovieId: "123" }
  });
  assert.equal(requestedUrl.pathname, "/3/movie/123");
  assert.equal(enriched.metadata.rating, 8.5);
  assert.deepEqual(enriched.metadata.genres, ["Drama"]);
  assert.deepEqual(enriched.metadata.cast, ["Actor"]);
  assert.deepEqual(enriched.metadata.artwork.map((asset) => asset.kind), ["poster", "logo"]);
});
