import assert from "node:assert/strict";
import Database from "better-sqlite3";
import test from "node:test";
import { MetadataResolver } from "../dist/application/metadata-resolver.js";
import { MetadataUsageService } from "../dist/application/metadata-usage-service.js";
import { defaultSettings } from "../dist/infrastructure/database/default-settings.js";
import { migrateDatabase } from "../dist/infrastructure/database/migrations.js";
import { TmdbMovieMetadataProvider } from "../dist/providers/metadata/tmdb-movie.js";
import { MusicBrainzMetadataProvider } from "../dist/providers/metadata/musicbrainz.js";

function tmdbResponse() {
  return { ok: true, status: 200, json: async () => ({ results: [
    { id: 11, title: "Shrek the Third", release_date: "2007-05-16", popularity: 50 },
    { id: 12, title: "Shrek 2", release_date: "2004-05-19", popularity: 40 }
  ] }) };
}

function createDatabase() {
  const db = new Database(":memory:");
  migrateDatabase(db, defaultSettings);
  return db;
}

function provider(id, identify) {
  return {
    describe: () => ({ id, apiVersion: "1.0.0", kind: "metadata", capabilities: [] }),
    initialize: async () => {},
    healthCheck: async () => ({ status: "available" }),
    dispose: async () => {},
    identify
  };
}

test("resolver records usage for every media type through the same path", async () => {
  const db = createDatabase();
  const usage = new MetadataUsageService(db);
  const candidate = { id: "1", entityType: "movie", title: "Shrek", confidence: 0.9, metadata: {}, identifiers: {} };
  const resolver = new MetadataResolver([
    provider("metadata.tmdb.movie", async (input) => input.entityType === "movie" ? [candidate] : []),
    provider("metadata.musicbrainz.release", async () => { throw new Error("rate limited"); })
  ], usage);
  await resolver.resolve({ entityType: "movie", query: "Shrek" });
  await resolver.resolve({ entityType: "movie", query: "Nothing" }).then(() => undefined);

  const rows = Object.fromEntries(usage.providerUsage().map((row) => [row.providerId, row]));
  assert.equal(rows["metadata.tmdb.movie"].requests, 2);
  assert.equal(rows["metadata.tmdb.movie"].successfulMatches, 2);
  assert.equal(rows["metadata.musicbrainz.release"].failures, 2);
  assert.equal(rows["metadata.musicbrainz.release"].lastFailure, "rate limited");
  assert.equal(rows["metadata.musicbrainz.release"].successRate, 0);
});

test("a lookup with no candidates counts as an empty result, not a failure", () => {
  const usage = new MetadataUsageService(createDatabase());
  usage.record({ providerId: "metadata.tmdb.movie", entityType: "movie", matches: 0, durationMs: 100, success: true });
  usage.record({ providerId: "metadata.tmdb.movie", entityType: "movie", matches: 3, durationMs: 300, success: true });
  const [row] = usage.providerUsage();
  assert.equal(row.requests, 2);
  assert.equal(row.successfulMatches, 1);
  assert.equal(row.emptyResults, 1);
  assert.equal(row.failures, 0);
  assert.equal(row.averageLookupTimeMs, 200);
});

test("aggregate TV provider rows are replaced by the per-provider TV lookup audit", () => {
  const db = createDatabase();
  const usage = new MetadataUsageService(db);
  usage.record({ providerId: "metadata.tv.configured", entityType: "series", matches: 1, durationMs: 5, success: true });
  db.prepare(`
    INSERT INTO tv_metadata_lookup_audit
      (provider_id, entity_type, query_text, attempted_at, success, cache_hit, duration_ms, provider_called, cache_enabled)
    VALUES ('tvdb', 'series', 'Show', ?, 1, 0, 120, 1, 0)
  `).run(new Date().toISOString());
  const ids = usage.providerUsage().map((row) => row.providerId);
  assert.deepEqual(ids, ["tvdb"]);
});

test("usage recording never throws when the table is unavailable", () => {
  const db = createDatabase();
  const usage = new MetadataUsageService(db);
  db.exec("DROP TABLE metadata_provider_usage");
  assert.doesNotThrow(() => usage.record({
    providerId: "x", entityType: "movie", matches: 0, durationMs: 1, success: true
  }));
});

test("identification stats cover movies, TV, music and match origin", () => {
  const db = createDatabase();
  const usage = new MetadataUsageService(db);
  const insert = db.prepare(`
    INSERT INTO disc_recovery
      (fingerprint, detected_disc_type, final_disc_type, detected_media_type, final_media_type,
       media_type_overridden, metadata_provider, updated_at)
    VALUES (?, 'dvd', 'dvd', ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();
  insert.run("a", "movie", "movie", 0, "tmdb", now);
  insert.run("b", "movie", "movie", 0, "manual", now);
  insert.run("c", "tv_series", "tv_series", 0, "tvdb", now);
  insert.run("d", "music_album", "music_album", 0, "musicbrainz", now);
  insert.run("e", "movie", "tv_series", 1, "tvdb", now);

  const stats = usage.identificationStats(12);
  assert.equal(stats.moviesIdentified, 2);
  assert.equal(stats.tvSeriesIdentified, 2);
  assert.equal(stats.tvEpisodesIdentified, 12);
  assert.equal(stats.musicCdsIdentified, 1);
  assert.equal(stats.automaticMatches, 3);
  assert.equal(stats.manualMatches, 2);
  assert.equal(stats.reviewRequiredMatches, 0);
});

test("SHREK_THE_THIRD: disabled TMDB lookup is reported as skipped with the reason, not as a request", async () => {
  const db = createDatabase();
  const usage = new MetadataUsageService(db);
  let fetched = 0;
  const tmdb = new TmdbMovieMetadataProvider(
    () => ({ ...defaultSettings, metadataEnabled: false, metadataApiKey: "key" }),
    async () => { fetched += 1; return tmdbResponse(); }
  );
  const resolver = new MetadataResolver([tmdb, new MusicBrainzMetadataProvider(() => defaultSettings)], usage);
  const result = await resolver.resolve({ entityType: "movie", query: "Shrek The Third" });
  assert.equal(fetched, 0);
  assert.equal(result.selected, undefined);
  assert.match(result.providerSkips[0].reason, /disabled/);
  const [row] = usage.providerUsage();
  assert.equal(row.providerId, "metadata.tmdb.movie");
  assert.equal(row.requests, 0);
  assert.equal(row.skipped, 1);
  assert.match(row.lastSkipReason, /Enable TMDB title lookup/);
});

test("enabled TMDB lookup queries the provider, selects the best match and counts the request", async () => {
  const db = createDatabase();
  const usage = new MetadataUsageService(db);
  const urls = [];
  const tmdb = new TmdbMovieMetadataProvider(
    () => ({ ...defaultSettings, metadataEnabled: true, metadataApiKey: "key" }),
    async (url) => { urls.push(String(url)); return tmdbResponse(); }
  );
  const resolver = new MetadataResolver([tmdb, new MusicBrainzMetadataProvider(() => defaultSettings)], usage);
  const result = await resolver.resolve({ entityType: "movie", query: "Shrek The Third" });
  assert.equal(urls.length, 1);
  assert.match(urls[0], /search\/movie/);
  assert.equal(result.selected.metadata.title, "Shrek the Third");
  assert.equal(result.providerSkips.length, 0);
  const rows = usage.providerUsage();
  assert.equal(rows.length, 1, "MusicBrainz is not applicable to movie lookups and must not be counted");
  assert.equal(rows[0].requests, 1);
  assert.equal(rows[0].successfulMatches, 1);
});

test("music lookups are counted for MusicBrainz and skipped with a reason when disabled", async () => {
  const usage = new MetadataUsageService(createDatabase());
  const music = new MusicBrainzMetadataProvider(() => ({ ...defaultSettings, musicMetadataEnabled: false }));
  const tmdb = new TmdbMovieMetadataProvider(() => ({ ...defaultSettings, metadataEnabled: true, metadataApiKey: "k" }),
    async () => { throw new Error("must not be called for albums"); });
  const resolver = new MetadataResolver([tmdb, music], usage);
  const result = await resolver.resolve({
    entityType: "album",
    identifiers: { musicBrainzDiscId: "abc", fingerprint: "f" },
    attributes: { trackNumbers: [1, 2] }
  });
  assert.equal(result.providerSkips.length, 1);
  assert.equal(result.providerSkips[0].providerId, "metadata.musicbrainz.release");
  const rows = usage.providerUsage();
  assert.deepEqual(rows.map((row) => row.providerId), ["metadata.musicbrainz.release"]);
  assert.equal(rows[0].skipped, 1);
});

test("provider overview lists registered movie and music providers even before any lookup", async () => {
  const usage = new MetadataUsageService(createDatabase());
  usage.setProviderStatusSource(async () => [
    { providerId: "metadata.tmdb.movie", health: { status: "degraded", message: "TMDB metadata lookup is disabled" } },
    { providerId: "metadata.musicbrainz.release", health: { status: "available" } },
    { providerId: "metadata.tv.configured", health: { status: "available" } }
  ]);
  const overview = await usage.providerOverview();
  assert.deepEqual(overview.map((row) => [row.providerId, row.mediaType]), [
    ["metadata.tmdb.movie", "Movies"],
    ["metadata.musicbrainz.release", "Music"]
  ]);
  assert.equal(overview[0].statusMessage, "TMDB metadata lookup is disabled");
  assert.equal(overview[0].requests, 0);
});
