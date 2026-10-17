import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("settings endpoint redacts secrets and enforces configured admin authentication", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autodisc-test-"));
  process.env.DATABASE_PATH = path.join(root, "state.sqlite");
  process.env.MOVIES_DIR = root;
  process.env.WORK_DIR = root;

  const { app } = await import("../dist/server.js");
  const { db } = await import("../dist/db.js");
  const jobs = await import("../dist/db.js");
  try {
    const home = await app.inject({ method: "GET", url: "/" });
    assert.equal(home.statusCode, 200);
    assert.match(home.body, /AutoDisc/);

    const initial = await app.inject({ method: "GET", url: "/api/v1/settings" });
    assert.equal(initial.statusCode, 200);
    assert.equal(initial.json().settings.adminPasswordConfigured, false);
    assert.equal("adminPasswordHash" in initial.json().settings, false);

    jobs.addJob("active-job-one", "Disc One");
    assert.throws(() => jobs.addJob("active-job-two", "Disc Two"));
    jobs.finishJob("active-job-one", "failed", "expected test failure");
    jobs.addJob("active-job-two", "Disc Two");
    jobs.updateJob("active-job-two", { conversionSeconds: 12 });
    jobs.finishJob("active-job-two", "completed", null, "test-disc-fingerprint");
    assert.equal(jobs.jobStats().total, 2);
    assert.equal(jobs.jobStats().successful, 1);
    assert.equal(jobs.jobStats().failures, 1);
    assert.equal(jobs.jobStats().averageSeconds, 12);
    assert.equal(jobs.lastDiscFingerprint(), "test-disc-fingerprint");
    jobs.clearInsertedDisc();
    assert.equal(jobs.lastDiscFingerprint(), null);

    const setPassword = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      payload: { adminPassword: "a-test-password-long-enough", logLevel: "error" }
    });
    assert.equal(setPassword.statusCode, 200);
    assert.equal(setPassword.json().settings.logLevel, "error");

    const unauthorized = await app.inject({ method: "GET", url: "/api/v1/settings" });
    assert.equal(unauthorized.statusCode, 401);

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/login",
      payload: { username: "admin", password: "a-test-password-long-enough" }
    });
    assert.equal(login.statusCode, 200);
    const setCookie = login.headers["set-cookie"];
    assert.equal(typeof setCookie, "string");
    const cookie = setCookie.split(";")[0];

    const authenticated = await app.inject({
      method: "GET",
      url: "/api/v1/settings",
      headers: { cookie }
    });
    assert.equal(authenticated.statusCode, 200);
    assert.equal(authenticated.json().settings.adminPasswordConfigured, true);
    assert.equal("metadataApiKey" in authenticated.json().settings, false);
    assert.equal("adminPasswordHash" in authenticated.json().settings, false);

    const invalidBody = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: { cookie },
      payload: null
    });
    assert.equal(invalidBody.statusCode, 400);

    const invalidQuality = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: { cookie },
      payload: { quality: 99 }
    });
    assert.equal(invalidQuality.statusCode, 400);
  } finally {
    await app.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
