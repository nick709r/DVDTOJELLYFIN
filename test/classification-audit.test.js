import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrateDatabase } from "../dist/infrastructure/database/migrations.js";
import { defaultSettings } from "../dist/infrastructure/database/default-settings.js";
import { createSqliteRepositories } from "../dist/infrastructure/database/repositories.js";
import { exportClassificationJson, exportClassificationText } from "../dist/application/classification-export.js";

function setup() {
  const db = new Database(":memory:");
  migrateDatabase(db, defaultSettings);
  return { db, repos: createSqliteRepositories(db, defaultSettings) };
}

test("jobs create audit records and track processing status", () => {
  const { repos } = setup();
  repos.jobs.add("j1", "The Matrix", null, "dvd");
  repos.jobs.finish("j1", "completed", null);
  repos.jobs.add("j0", "x", null, "unknown");
  const record = repos.classificationAudit.getByJob("j1");
  assert.equal(record.detectedType, "dvd");
  assert.equal(record.finalType, "dvd");
  assert.equal(record.reviewStatus, "auto_accepted");
  assert.equal(record.confidence, null);
  assert.equal(repos.classificationAudit.getByJob("j0").reviewStatus, "review_required");
  assert.equal(repos.classificationAudit.getByJob("j1").processingStatus, "completed");
});

test("manual correction preserves detection and validates input", () => {
  const { db, repos } = setup();
  repos.jobs.add("j1", "The Matrix", null, "dvd");
  const audit = repos.classificationAudit;
  const id = audit.getByJob("j1").id;
  assert.throws(() => audit.review(id, { finalType: "bluray" }), /overrideReason/);
  assert.throws(() => audit.review(id, { finalType: "bluray", overrideReason: "custom" }), /notes/);
  assert.throws(() => audit.review(id, { finalType: "Bad Type!", overrideReason: "damaged_disc" }), /finalType/);
  const fixed = audit.review(id, { finalType: "bluray", overrideReason: "filesystem_detection_incorrect", notes: "UHD" });
  assert.equal(fixed.detectedType, "dvd");
  assert.equal(fixed.finalType, "bluray");
  assert.equal(fixed.reviewStatus, "manually_corrected");
  assert.equal(audit.review(id, { finalType: "dvd" }).reviewStatus, "reviewed_no_change");
  audit.review(id, { finalType: "bluray", overrideReason: "mixed_media" });
  repos.history.delete("j1");
  assert.equal(audit.get(id).detectedType, "dvd", "audit survives history deletion");
  assert.throws(() => audit.recordDetection({ jobId: null, diskName: "d", detectedType: "dvd", confidence: 2 }), /confidence/);
  assert.equal(audit.recordDetection({ jobId: null, diskName: "d", detectedType: "dvd", confidence: 0.62 }).reviewStatus, "review_required");
  db.close();
});

test("metrics and exports derive from audit records", () => {
  const { repos } = setup();
  const audit = repos.classificationAudit;
  for (const [id, type] of [["a", "dvd"], ["b", "cdrom"], ["c", "unknown"]]) {
    repos.jobs.add(id, id.toUpperCase(), null, type);
    repos.jobs.finish(id, "completed", null);
  }
  audit.review(audit.getByJob("b").id, { finalType: "audio_cd", overrideReason: "damaged_disc" });
  audit.review(audit.getByJob("a").id, { finalType: "dvd" });
  const m = audit.metrics();
  assert.deepEqual({ ...m, corrections: undefined }, {
    totalProcessed: 3, autoAccepted: 0, reviewed: 2, manualCorrections: 1, reviewRequired: 1, corrections: undefined
  });
  assert.deepEqual(m.corrections, [{ from: "cdrom", to: "audio_cd", count: 1 }]);
  const text = exportClassificationText(audit.list());
  assert.match(text, /DISK PROCESSING LOG/);
  assert.match(text, /Detected Type:\nCD-ROM\n\nFinal Type:\nCD Audio/);
  assert.match(text, /Reason:\ndamaged_disc/);
  const json = exportClassificationJson(audit.list());
  assert.equal(json.count, 3);
  assert.equal(json.records[0].confidence, null);
});

test("legacy jobs are backfilled into the audit table", () => {
  const db = new Database(":memory:");
  migrateDatabase(db, defaultSettings);
  db.prepare("DELETE FROM schema_migrations WHERE version = 16").run();
  db.exec("DROP TABLE disk_classification_audit");
  db.prepare("INSERT INTO jobs (id, status, media_type, disc_label, started_at) VALUES ('old','completed','dvd','Old','2020-01-01T00:00:00Z')").run();
  migrateDatabase(db, defaultSettings);
  const row = db.prepare("SELECT * FROM disk_classification_audit WHERE job_id = 'old'").get();
  assert.equal(row.detected_type, "dvd");
  assert.equal(row.review_status, "auto_accepted");
});
