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
  repositories.jobs.add("cls-job", "The Matrix", null, "dvd");
  const id = repositories.classificationAudit.getByJob("cls-job").id;
  const bad = await app.inject({ method: "POST", url: `/api/v1/classification/audit/${id}/review`, payload: { finalType: "bluray" } });
  assert.equal(bad.statusCode, 400);
  const missing = await app.inject({ method: "POST", url: "/api/v1/classification/audit/nope/review", payload: { finalType: "dvd" } });
  assert.equal(missing.statusCode, 404);
  const ok = await app.inject({ method: "POST", url: `/api/v1/classification/audit/${id}/review`,
    payload: { finalType: "bluray", overrideReason: "filesystem_detection_incorrect" } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().record.detectedType, "dvd");
  assert.equal(ok.json().record.finalType, "bluray");
  const metrics = await app.inject({ method: "GET", url: "/api/v1/classification/metrics" });
  assert.equal(metrics.json().metrics.manualCorrections, 1);
  const text = await app.inject({ method: "GET", url: "/api/v1/classification/export/text" });
  assert.match(text.headers["content-type"], /text\/plain/);
  assert.match(text.body, /manually_corrected/);
  const json = await app.inject({ method: "GET", url: "/api/v1/classification/export/json" });
  assert.equal(json.json().records[0].finalType, "bluray");
  await app.close();
});
