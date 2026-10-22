import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultSettings } from "../dist/infrastructure/database/default-settings.js";
import { TvMetadataProviderRegistry } from "../dist/application/tv-metadata-provider-registry.js";

test("TV metadata settings, provider lookup, caching, auditing, and metrics work end to end", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autodisc-tv-metadata-"));
  process.env.DATABASE_PATH = path.join(root, "state.sqlite");
  process.env.MOVIES_DIR = root;
  process.env.WORK_DIR = root;

  const { app } = await import("../dist/server.js");
  const { db } = await import("../dist/db.js");
  const originalFetch = globalThis.fetch;
  const setup = await app.inject({
    method: "POST",
    url: "/api/v1/setup",
    payload: {
      username: "metadata-admin",
      password: "MetadataSecurePassword123!",
      confirmPassword: "MetadataSecurePassword123!"
    }
  });
  assert.equal(setup.statusCode, 201);
  let sessionCookie = "";
  const originalInject = app.inject.bind(app);
  app.inject = async (options) => {
    const response = await originalInject({
      ...options,
      headers: { ...(sessionCookie ? { cookie: sessionCookie } : {}), ...(options.headers || {}) }
    });
    const setCookie = response.headers["set-cookie"];
    if (typeof setCookie === "string") sessionCookie = setCookie.split(";")[0];
    return response;
  };
  try {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/login",
      payload: { username: "metadata-admin", password: "MetadataSecurePassword123!" }
    });
    assert.equal(login.statusCode, 200);
    const initial = await app.inject({ method: "GET", url: "/api/v1/tv/metadata" });
    assert.equal(initial.statusCode, 200);
    assert.deepEqual(initial.json().providers.map((provider) => provider.id), ["tvdb", "tmdb-tv"]);
    assert.equal(initial.json().settings.lookupEnabled, false);
    assert.equal(initial.json().settings.cacheEnabled, false);
    assert.equal(initial.json().providers[0].health, "disabled");

    const save = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      payload: {
        tvMetadataLookupEnabled: true,
        tvMetadataPreferredProviderId: "tvdb",
        tvMetadataFallbackProviderId: "tmdb-tv",
        tvMetadataCacheEnabled: true,
        tvMetadataCacheDurationHours: 336,
        tvMetadataProviderEnabled: { tvdb: true, "tmdb-tv": true },
        tvMetadataProviderApiKeys: { tvdb: "tvdb-test-secret", "tmdb-tv": "tmdb-test-secret" }
      }
    });
    assert.equal(save.statusCode, 200);
    assert.equal(save.json().settings.tvMetadataLookupEnabled, true);
    assert.equal(save.json().settings.tvMetadataCacheDurationHours, 336);
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
    let tmdbConnectionFailure = true;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.includes("thetvdb.com/v4/login")) {
        return new Response(JSON.stringify({ data: { token: "provider-session-token" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (url.includes("thetvdb.com/v4/search")) return new Response("{}", { status: 503 });
      if (url.includes("themoviedb.org/3/configuration")) return new Response("{}", { status: tmdbConnectionFailure ? 401 : 200 });
      if (url.includes("themoviedb.org/3/search/tv")) {
        return new Response(JSON.stringify({
          results: [{ id: 44, name: "Example Series", first_air_date: "2020-01-01", overview: "Example" }]
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
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
    assert.equal(providers.json().providers[0].health, "healthy");
    assert.equal(providers.json().providers[1].lastValidation.status, "failure");
    assert.equal(providers.json().providers[1].health, "authentication_failure");

    tmdbConnectionFailure = false;
    const providerRefresh = await app.inject({ method: "POST", url: "/api/v1/tv/metadata/providers/refresh" });
    assert.equal(providerRefresh.statusCode, 200);
    assert.equal(providerRefresh.json().providers.find((provider) => provider.id === "tmdb-tv").status, "healthy");

    const { tvMetadataLookupService } = await import("../dist/bootstrap/tv-metadata-runtime.js");
    const lookup = await tvMetadataLookupService.lookup({ entityType: "series", query: "Example Series" });
    assert.equal(lookup[0].title, "Example Series");
    assert.equal(lookup[0].identifiers.tmdbTvId, "44");
    assert.equal(lookup[0].lookupDiagnostics.cacheHit, false);
    assert.equal(lookup[0].lookupDiagnostics.sourceProviderId, "tmdb-tv");
    assert.equal(lookup[0].lookupDiagnostics.fallbackUsed, true);
    const cachedLookup = await tvMetadataLookupService.lookup({ entityType: "series", query: "Example Series" });
    assert.equal(cachedLookup[0].id, "44");
    assert.equal(cachedLookup[0].lookupDiagnostics.cacheHit, true);

    const metrics = await app.inject({ method: "GET", url: "/api/v1/tv/metadata/metrics" });
    assert.equal(metrics.json().lookupsAttempted, 4);
    assert.equal(metrics.json().lookupsSuccessful, 2);
    assert.equal(metrics.json().lookupsFailed, 2);
    assert.equal(metrics.json().cacheHits, 1);
    assert.equal(metrics.json().cacheMisses, 2);
    assert.equal(metrics.json().providers.find((provider) => provider.id === "tmdb-tv").usageCount, 1);
    assert.equal(metrics.json().providers.find((provider) => provider.id === "tmdb-tv").status, "healthy");

    db.prepare("UPDATE tv_metadata_cache SET expires_at = ?").run("2000-01-01T00:00:00.000Z");
    const beforeExpiryLookup = requests.length;
    await tvMetadataLookupService.lookup({ entityType: "series", query: "Example Series" });
    assert.equal(requests.length, beforeExpiryLookup + 1);

    const refresh = await app.inject({ method: "POST", url: "/api/v1/tv/metadata/cache/refresh" });
    assert.equal(refresh.statusCode, 200);
    assert.equal(refresh.json().refreshed, 1);
    const cleared = await app.inject({ method: "DELETE", url: "/api/v1/tv/metadata/cache" });
    assert.equal(cleared.statusCode, 200);
    assert.equal(cleared.json().cleared, 1);

    await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      payload: { tvMetadataPreferredProviderId: "tmdb-tv", tvMetadataFallbackProviderId: "" }
    });
    const requestCountBeforePreferred = requests.length;
    const preferredLookup = await tvMetadataLookupService.lookup({ entityType: "series", query: "Preferred Series" });
    assert.equal(preferredLookup[0].title, "Example Series");
    assert.equal(requests.length, requestCountBeforePreferred + 1);
    assert.match(requests.at(-1).url, /themoviedb\.org/);

    const settings = await app.inject({ method: "GET", url: "/api/v1/settings" });
    assert.equal(settings.json().settings.tvMetadataProviderApiKeysConfigured.tvdb, true);
    assert.equal(JSON.stringify(settings.json()).includes("tvdb-test-secret"), false);
    for (const retired of [
      "tvMetadataAutomaticRefresh", "tvMetadataIncludeSpecials", "tvMetadataIncludeBonusContent",
      "tvMetadataIncludeMultipartEpisodes", "tvStoreAnalysisEvidence", "tvStoreMatchingEvidence"
    ]) {
      assert.equal(retired in settings.json().settings, false);
    }
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

test("TV metadata registry keeps non-implemented providers out of user-facing provider listings", async () => {
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
  ]);
  assert.equal(registry.isLookupImplemented("future-tv"), false);
  assert.equal(registry.isLookupImplemented("missing-provider"), false);
  registry.register({ ...future, id: "another-provider", lookupImplemented: true });
  assert.equal(registry.list(settings).length, 1);
  assert.equal(registry.isLookupImplemented("another-provider"), true);
  await registry.validateConnection("future-tv", "");
  assert.equal(called, true);
  assert.throws(() => registry.register(future), /already registered/);
  await assert.rejects(registry.validateConnection("missing-provider", ""), /not registered/);
});

test("TV metadata dashboard and settings render live metrics and operational controls", async () => {
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  assert.match(html, /id="tv-metadata-dashboard-stats"/);
  assert.match(html, /id="tv-metadata-providers"/);
  assert.match(html, /id="tv-metadata-matching-policy"/);
  assert.match(html, /src="\/autodisc-logo\.png"/);
  assert.match(script, /async function loadTvMetadataMetrics/);
  assert.match(script, /function renderTvMetadataProviders/);
  assert.match(html, /id="clear-tv-metadata-cache"/);
  assert.match(html, /id="refresh-tv-metadata-providers"/);
  assert.match(script, /metrics\.lookupsAttempted/);
  assert.doesNotMatch(html, /tvMetadataAutomaticRefresh|tvMetadataIncludeSpecials|tvMetadataIncludeBonusContent|tvMetadataIncludeMultipartEpisodes/);
});
