import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("classification review API validates, corrects and exports", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autodisc-cls-"));
  process.env.DATABASE_PATH = path.join(root, "state.sqlite");
  process.env.MOVIES_DIR = root;
  process.env.WORK_DIR = root;
  const { app } = await import("../dist/server.js");
  const { repositories } = await import("../dist/db.js");
  const setup = await app.inject({
    method: "POST",
    url: "/api/v1/setup",
    payload: {
      username: "audit-admin",
      password: "SecureAuditPassword123!",
      confirmPassword: "SecureAuditPassword123!"
    }
  });
  assert.equal(setup.statusCode, 201);
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/login",
    payload: { username: "audit-admin", password: "SecureAuditPassword123!" }
  });
  assert.equal(login.statusCode, 200);
  const cookie = login.headers["set-cookie"]?.split(";")[0];
  const authenticatedInject = (options) => app.inject({
    ...options,
    headers: { ...(cookie ? { cookie } : {}), ...(options.headers || {}) }
  });
  repositories.jobs.add("cls-job", "The Matrix", null, "dvd");
  const id = repositories.classificationAudit.getByJob("cls-job").id;
  const bad = await authenticatedInject({ method: "POST", url: `/api/v1/classification/audit/${id}/review`, payload: { finalType: "bluray" } });
  assert.equal(bad.statusCode, 400);
  const missing = await authenticatedInject({ method: "POST", url: "/api/v1/classification/audit/nope/review", payload: { finalType: "dvd" } });
  assert.equal(missing.statusCode, 404);
  const ok = await authenticatedInject({ method: "POST", url: `/api/v1/classification/audit/${id}/review`,
    payload: { finalType: "bluray", overrideReason: "filesystem_detection_incorrect" } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().record.detectedType, "dvd");
  assert.equal(ok.json().record.finalType, "bluray");
  assert.equal(ok.json().record.reviewedBy, "audit-admin");
  assert.ok(ok.json().record.reviewedAt);
  const metrics = await authenticatedInject({ method: "GET", url: "/api/v1/classification/metrics" });
  assert.equal(metrics.json().metrics.manualCorrections, 1);
  const text = await authenticatedInject({ method: "GET", url: "/api/v1/classification/export/text" });
  assert.match(text.headers["content-type"], /text\/plain/);
  assert.match(text.body, /manually_corrected/);
  assert.match(text.body, /Reviewed by:\naudit-admin/);
  const json = await authenticatedInject({ method: "GET", url: "/api/v1/classification/export/json" });
  assert.equal(json.json().records[0].finalType, "bluray");
  assert.equal(json.json().records[0].reviewedBy, "audit-admin");
  await app.close();
});
