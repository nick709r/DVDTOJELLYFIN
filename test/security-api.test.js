import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("login is rate-limited and saved Lidarr credentials stay bound to the configured URL", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autodisc-security-"));
  process.env.DATABASE_PATH = path.join(root, "state.sqlite");
  process.env.MOVIES_DIR = root;
  process.env.WORK_DIR = root;
  const { app } = await import("../dist/server.js");
  const { db, repositories, saveSettings } = await import("../dist/db.js");
  const originalFetch = globalThis.fetch;
  try {
    const setup = await app.inject({
      method: "POST", url: "/api/v1/setup",
      payload: { username: "admin", password: "password", confirmPassword: "password" }
    });
    assert.equal(setup.statusCode, 201);
    const login = await app.inject({
      method: "POST", url: "/api/v1/login",
      remoteAddress: "127.0.0.2",
      payload: { username: "admin", password: "password" }
    });
    assert.equal(login.statusCode, 200);
    const cookie = login.headers["set-cookie"].split(";")[0];
    for (let i = 0; i < 10; i++) {
      const failed = await app.inject({
        method: "POST", url: "/api/v1/login",
        remoteAddress: "127.0.0.3",
        payload: { username: "admin", password: "wrong" }
      });
      assert.equal(failed.statusCode, 401);
    }
    const limited = await app.inject({
      method: "POST", url: "/api/v1/login",
      remoteAddress: "127.0.0.3",
      payload: { username: "admin", password: "password" }
    });
    assert.equal(limited.statusCode, 429);
    assert.ok(limited.headers["retry-after"]);
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/settings", headers: { cookie } })).statusCode, 200);
    for (let i = 0; i < 60; i++) {
      const unauthorized = await app.inject({
        method: "GET", url: "/api/v1/settings", remoteAddress: "127.0.0.4"
      });
      assert.equal(unauthorized.statusCode, 401);
    }
    const unauthorizedLimited = await app.inject({
      method: "GET", url: "/api/v1/settings", remoteAddress: "127.0.0.4"
    });
    assert.equal(unauthorizedLimited.statusCode, 429);
    assert.ok(unauthorizedLimited.headers["retry-after"]);

    saveSettings({ lidarrUrl: "http://localhost:8686/lidarr/", lidarrApiKey: "stored-secret" });
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), key: new Headers(init.headers).get("X-Api-Key") });
      return Response.json({ version: "2.0.0" });
    };
    const request = (payload) => app.inject({ method: "POST", url: "/api/v1/lidarr/test", headers: { cookie }, payload });
    assert.equal((await request({ url: "http://localhost:8686/lidarr/" })).statusCode, 200);
    assert.equal(requests[0].key, "stored-secret");
    assert.equal((await request({})).statusCode, 200);
    assert.equal((await request({ url: "http://other-host:8686/lidarr" })).statusCode, 400);
    assert.equal((await request({ url: "http://localhost:8686/other" })).statusCode, 400);
    assert.equal(requests.length, 2);
    assert.equal((await request({ url: "http://other-host:8686/lidarr", apiKey: "new-key" })).statusCode, 200);
    assert.equal(requests[2].key, "new-key");
    const update = (payload) => app.inject({ method: "PUT", url: "/api/v1/settings", headers: { cookie }, payload });
    assert.equal((await update({ lidarrUrl: "http://other-host:8686/lidarr" })).statusCode, 400);
    assert.equal((await update({ lidarrUrl: "http://localhost:8686/lidarr/" })).statusCode, 200);
    assert.equal((await update({ lidarrUrl: "http://other-host:8686/lidarr", lidarrApiKey: "new-key" })).statusCode, 200);

    const stagingPath = path.join(root, "tv-staging", "job");
    await mkdir(stagingPath, { recursive: true });
    await writeFile(path.join(stagingPath, "episode.mp4"), Buffer.alloc(2048));
    repositories.jobs.add("job", "Disc", "fingerprint", "dvd");
    repositories.tvMatchingTasks.create({
      jobId: "job", fingerprint: "fingerprint", status: "awaiting-identification", stagingPath,
      source: { sourceId: "dvd", providerId: "source.video-dvd.makemkv", mediaKind: "dvd",
        label: "Disc", manifest: { mediaKind: "dvd", attributes: {}, items: [] } },
      diagnostics: { status: "analysis-unavailable" },
      files: { "1": "episode.mp4", unassigned: "episode.mp4" },
      assignments: [{ trackId: "1", title: "Title 1", durationSeconds: 100, episodeCandidates: [] }]
    });
    const preview = (trackId) => app.inject({
      method: "GET", url: `/api/v1/tv/matching/job/preview/${trackId}`, headers: { cookie, range: "bytes=0-3" }
    });
    assert.equal((await preview("1")).statusCode, 206);
    for (const trackId of ["__proto__", "constructor", "%2e%2e%2fepisode.mp4", "missing", "unassigned"]) {
      assert.equal((await preview(trackId)).statusCode, 404);
    }
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
