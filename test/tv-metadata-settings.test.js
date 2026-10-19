import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultSettings } from "../dist/infrastructure/database/default-settings.js";
import { TvMetadataProviderRegistry } from "../dist/application/tv-metadata-provider-registry.js";

test("TV metadata settings persist safely and provider tests report health without enabling lookup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autodisc-tv-metadata-"));
  process.env.DATABASE_PATH = path.join(root, "state.sqlite");
  process.env.MOVIES_DIR = root;
  process.env.WORK_DIR = root;

  const { app } = await import("../dist/server.js");
  const { db } = await import("../dist/db.js");
  const originalFetch = globalThis.fetch;
  try {
    const initial = await app.inject({ method: "GET", url: "/api/v1/tv/metadata" });
    assert.equal(initial.statusCode, 200);
    assert.deepEqual(initial.json().providers.map((provider) => provider.id), ["tvdb", "tmdb-tv"]);
    assert.equal(initial.json().settings.lookupEnabled, false);
    assert.equal(initial.json().settings.cacheEnabled, false);
    assert.equal(initial.json().providers[0].health, "lookup_unavailable");

    const save = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      payload: {
        tvMetadataLookupEnabled: true,
        tvMetadataPreferredProviderId: "tvdb",
        tvMetadataFallbackProviderId: "tmdb-tv",
        tvMetadataCacheEnabled: true,
        tvMetadataCacheDurationHours: 336,
        tvMetadataAutomaticRefresh: true,
        tvMetadataIncludeSpecials: true,
        tvMetadataIncludeBonusContent: true,
        tvMetadataIncludeMultipartEpisodes: false,
        tvMetadataProviderEnabled: { tvdb: true, "tmdb-tv": true },
        tvMetadataProviderApiKeys: { tvdb: "tvdb-test-secret", "tmdb-tv": "tmdb-test-secret" }
      }
    });
    assert.equal(save.statusCode, 200);
    assert.equal(save.json().settings.tvMetadataLookupEnabled, true);
    assert.equal(save.json().settings.tvMetadataCacheDurationHours, 336);
    assert.equal(save.json().settings.tvMetadataIncludeMultipartEpisodes, false);
    assert.deepEqual(save.json().settings.tvMetadataProviderApiKeysConfigured, {
      tvdb: true,
      "tmdb-tv": true
    });
    assert.equal("tvMetadataProviderApiKeys" in save.json().settings, false);
    assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = ?").get("tvMetadataProviderApiKeys").value).tvdb, "tvdb-test-secret");

    const invalidProvider = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      payload: { tvMetadataPreferredProviderId: "unregistered-provider" }
    });
    assert.equal(invalidProvider.statusCode, 400);
    const invalidProviderMap = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      payload: { tvMetadataProviderEnabled: { "unregistered-provider": true } }
    });
    assert.equal(invalidProviderMap.statusCode, 400);
    const sameFallback = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      payload: { tvMetadataFallbackProviderId: "tvdb" }
    });
    assert.equal(sameFallback.statusCode, 400);

    const requests = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.includes("thetvdb.com")) {
        return new Response(JSON.stringify({ data: { token: "provider-session-token" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (url.includes("themoviedb.org")) return new Response("{}", { status: 401 });
      throw new Error("Unexpected provider URL");
    };

    const tvdbResult = await app.inject({
      method: "POST",
      url: "/api/v1/tv/metadata/providers/tvdb/test"
    });
    assert.equal(tvdbResult.statusCode, 200);
    assert.equal(tvdbResult.json().validation.status, "success");
    assert.match(requests[0].init.body, /tvdb-test-secret/);
    assert.equal(tvdbResult.body.includes("tvdb-test-secret"), false);
    assert.equal(tvdbResult.body.includes("provider-session-token"), false);

    const tmdbResult = await app.inject({
      method: "POST",
      url: "/api/v1/tv/metadata/providers/tmdb-tv/test"
    });
    assert.equal(tmdbResult.statusCode, 502);
    assert.equal(tmdbResult.json().validation.status, "failure");
    assert.match(tmdbResult.json().error, /HTTP 401/);
    assert.equal(tmdbResult.body.includes("tmdb-test-secret"), false);

    const providers = await app.inject({ method: "GET", url: "/api/v1/tv/metadata/providers" });
    assert.equal(providers.json().providers[0].lastValidation.status, "success");
    assert.equal(providers.json().providers[0].health, "lookup_unavailable");
    assert.equal(providers.json().providers[1].lastValidation.status, "failure");

    const metrics = await app.inject({ method: "GET", url: "/api/v1/tv/metadata/metrics" });
    assert.equal(metrics.json().available, false);
    assert.equal(metrics.json().activeProvider, null);
    assert.equal(metrics.json().totalSearches, null);
    assert.equal(metrics.json().cacheHitRate, null);
    const refresh = await app.inject({ method: "POST", url: "/api/v1/tv/metadata/cache/refresh" });
    assert.equal(refresh.statusCode, 501);
    assert.match(refresh.json().error, /no metadata was refreshed/);

    const settings = await app.inject({ method: "GET", url: "/api/v1/settings" });
    assert.equal(settings.json().settings.tvMetadataProviderApiKeysConfigured.tvdb, true);
    assert.equal(JSON.stringify(settings.json()).includes("tvdb-test-secret"), false);
    const clearKey = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      payload: { tvMetadataProviderApiKeys: { tvdb: "" } }
    });
    assert.equal(clearKey.statusCode, 200);
    assert.equal(clearKey.json().settings.tvMetadataProviderApiKeysConfigured.tvdb, false);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("TV metadata registry supports independently registered future providers and health reporting", async () => {
  const registry = new TvMetadataProviderRegistry();
  let called = false;
  const future = {
    id: "future-tv",
    name: "Future TV Provider",
    apiKeyRequired: false,
    lookupImplemented: false,
    async validateConnection() { called = true; }
  };
  registry.register(future);
  const settings = {
    ...defaultSettings,
    tvMetadataProviderEnabled: { "future-tv": true },
    tvMetadataProviderApiKeys: {},
    tvMetadataProviderValidation: {}
  };
  assert.deepEqual(registry.list(settings).map(({ id, enabled, health }) => ({ id, enabled, health })), [
    { id: "future-tv", enabled: true, health: "lookup_unavailable" }
  ]);
  registry.register({ ...future, id: "another-provider" });
  assert.equal(registry.list(settings).length, 2);
  await registry.validateConnection("future-tv", "");
  assert.equal(called, true);
  assert.throws(() => registry.register(future), /already registered/);
  await assert.rejects(registry.validateConnection("missing-provider", ""), /not registered/);
});

test("TV metadata dashboard and settings render registered-provider and unavailable-metric states", async () => {
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  assert.match(html, /id="tv-metadata-dashboard-stats"/);
  assert.match(html, /id="tv-metadata-providers"/);
  assert.match(html, /id="tv-metadata-matching-policy"/);
  assert.match(html, /src="\/autodisc-logo\.png"/);
  assert.match(script, /async function loadTvMetadataMetrics/);
  assert.match(script, /function renderTvMetadataProviders/);
  assert.match(script, /metrics\.activeProvider\?\.name \|\| "Not active"/);
  assert.match(script, /"Unavailable"/);
});
