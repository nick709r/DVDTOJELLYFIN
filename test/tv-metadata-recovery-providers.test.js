import assert from "node:assert/strict";
import test from "node:test";
import { tvMetadataProviderRegistry } from "../dist/bootstrap/tv-metadata-providers.js";

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

test("TVDB direct ID lookup authenticates and returns the identified series", async () => {
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push({ url: String(url), options });
    return requests.length === 1
      ? jsonResponse({ data: { token: "test-token" } })
      : jsonResponse({ data: { id: 80379, name: "Example Show", year: "2020" } });
  };

  const series = await tvMetadataProviderRegistry.lookupById("tvdb", "80379", "test-key", fetcher);

  assert.equal(series.title, "Example Show");
  assert.equal(series.identifiers.tvdbId, "80379");
  assert.match(requests[1].url, /\/series\/80379\/extended$/);
  assert.equal(requests[1].options.headers.Authorization, "Bearer test-token");
});

test("TMDB and IMDb direct lookups resolve a TV series with provider identifiers", async () => {
  const tmdbSeries = await tvMetadataProviderRegistry.lookupById(
    "tmdb-tv",
    "1396",
    "test-key",
    async () => jsonResponse({ id: 1396, name: "Example Show", first_air_date: "2011-04-17" })
  );
  assert.equal(tmdbSeries.title, "Example Show");
  assert.equal(tmdbSeries.identifiers.tmdbTvId, "1396");

  const imdbSeries = await tvMetadataProviderRegistry.lookupImdbId(
    "tt0944947",
    "test-key",
    async (url) => {
      if (String(url).includes("/find/")) {
        assert.match(String(url), /\/find\/tt0944947\?/);
        assert.match(String(url), /external_source=imdb_id/);
        return jsonResponse({ tv_results: [{ id: 1396, name: "Example Show" }] });
      }
      assert.match(String(url), /\/tv\/1396\?/);
      assert.match(String(url), /append_to_response=aggregate_credits/);
      return jsonResponse({ id: 1396, name: "Example Show", first_air_date: "2011-04-17" });
    }
  );
  assert.equal(imdbSeries.title, "Example Show");
  assert.equal(imdbSeries.identifiers.imdbId, "tt0944947");
  assert.equal(imdbSeries.identifiers.tmdbTvId, "1396");
});

test("TMDB season lookup returns episode numbers and titles for manual mapping", async () => {
  const episodes = await tvMetadataProviderRegistry.lookupEpisodesById(
    "tmdb-tv",
    "1396",
    1,
    "test-key",
    async (url) => {
      assert.match(String(url), /\/tv\/1396\/season\/1\?/);
      return jsonResponse({
        episodes: [
          { name: "Episode One", season_number: 1, episode_number: 1 },
          { name: "Episode Two", season_number: 1, episode_number: 2 }
        ]
      });
    }
  );

  assert.deepEqual(episodes.map(({ seriesId, seasonNumber, episodeNumber, title }) =>
    ({ seriesId, seasonNumber, episodeNumber, title })), [
    { seriesId: "1396", seasonNumber: 1, episodeNumber: 1, title: "Episode One" },
    { seriesId: "1396", seasonNumber: 1, episodeNumber: 2, title: "Episode Two" }
  ]);
});

test("TVDB DVD lookup exposes disc order mapped back to aired episode identities", async () => {
  const requests = [];
  const result = await tvMetadataProviderRegistry.lookup(
    "tvdb",
    { entityType: "episode-disc", query: "Example Show", seasonNumber: 1 },
    "test-key",
    async (url, options) => {
      requests.push({ url: String(url), options });
      if (requests.length === 1) return jsonResponse({ data: { token: "test-token" } });
      if (requests.length === 2) {
        return jsonResponse({ data: [{ tvdb_id: "80379", name: "Example Show" }] });
      }
      if (String(url).includes("/episodes/default")) {
        return jsonResponse({ data: { episodes: [
          { id: 101, name: "Aired Episode One", seasonNumber: 1, number: 1 },
          { id: 102, name: "Aired Episode Two", seasonNumber: 1, number: 2 }
        ] } });
      }
      return jsonResponse({ data: { episodes: [
        { id: 102, dvdDiscNumber: 1, dvdEpisodeNumber: 1 },
        { id: 101, dvdDiscNumber: 1, dvdEpisodeNumber: 2 }
      ] } });
    }
  );

  assert.deepEqual(result.map((entry) => ({
    entityType: entry.entityType,
    seriesId: entry.metadata.seriesId,
    seasonNumber: entry.metadata.seasonNumber,
    episodeNumber: entry.metadata.episodeNumber,
    discNumber: entry.metadata.discNumber,
    discOrder: entry.metadata.discOrder
  })), [
    {
      entityType: "episode-disc",
      seriesId: "80379",
      seasonNumber: 1,
      episodeNumber: 2,
      discNumber: 1,
      discOrder: 1
    },
    {
      entityType: "episode-disc",
      seriesId: "80379",
      seasonNumber: 1,
      episodeNumber: 1,
      discNumber: 1,
      discOrder: 2
    }
  ]);
  assert.match(requests[3].url, /\/episodes\/dvd\?season=1&page=0/);
});
