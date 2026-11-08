import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import test from "node:test";
import { defaultSettings } from "../dist/infrastructure/database/default-settings.js";
import { migrateDatabase } from "../dist/infrastructure/database/migrations.js";
import { createSqliteRepositories } from "../dist/infrastructure/database/repositories.js";
import { openSqliteDatabase } from "../dist/infrastructure/database/connection.js";

test("conflict audit and replacement journal survive restart and reject unsafe transitions", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autodisc-conflict-journal-"));
  const dbPath = path.join(root, "state.sqlite");
  let db = new Database(dbPath);
  migrateDatabase(db, defaultSettings);
  let repositories = createSqliteRepositories(db, defaultSettings);
  t.after(async () => {
    repositories.close();
    await rm(root, { recursive: true, force: true });
  });
  const incoming = {
    fingerprint: "disc-2", discLabel: "Disc 2", trackId: "1",
    trackTitle: "Episode 7", confirmedAt: "2026-01-02T00:00:00.000Z"
  };
  const existing = {
    outputPath: path.join(root, "S01E07.mkv"), fingerprint: "disc-1", discLabel: "Disc 1",
    discNumber: 1, trackId: "7", trackTitle: "Blooper", seriesName: "Example",
    metadataProvider: "manual", providerId: null, seasonNumber: 1, episodeNumber: 7,
    confirmedAt: "2026-01-01T00:00:00.000Z", publishedAt: "2026-01-01T01:00:00.000Z"
  };
  const audit = {
    id: "audit-1", jobId: "job-1", at: "2026-01-03T00:00:00.000Z", action: "keep_existing",
    seasonNumber: 1, episodeNumber: 7, incoming, existing, provenanceStatus: "verified",
    decisionBy: "admin", details: { reason: "reviewed" }
  };
  const transaction = {
    id: "tx-1", jobId: "job-1", state: "created",
    createdAt: "2026-01-03T00:00:00.000Z", updatedAt: "2026-01-03T00:00:00.000Z",
    originalPath: existing.outputPath, quarantinePath: path.join(root, ".autodisc", "quarantine", "tx-1"),
    replacementPath: existing.outputPath, originalChecksum: null, replacementChecksum: null,
    existing, incoming, failure: null
  };
  const journal = repositories.tvConflictJournal;
  const audits = ["keep_existing", "keep_both", "mark_as_extras", "replace_existing"].map((action, index) => ({
    ...audit, id: `audit-${index + 1}`, action
  }));
  for (const entry of audits) journal.appendAudit(entry);
  assert.throws(() => journal.appendAudit(audit), /UNIQUE/);
  assert.throws(() => journal.appendAudit({ ...audit, id: "invalid-action", action: "other" }), /CHECK/);
  journal.createTransaction(transaction);
  assert.throws(() => journal.transitionTransaction("tx-1", "created", "published", {}), /Invalid replacement transition/);
  assert.throws(() => journal.transitionTransaction("tx-1", "created", "quarantined", {}), /checksum is required/);
  assert.throws(() => journal.transitionTransaction("tx-1", "created", "failed", {}), /failure reason is required/);
  assert.equal(journal.getTransaction("tx-1").state, "created");
  journal.transitionTransaction("tx-1", "created", "failed", { failure: "Interrupted" });
  assert.throws(() => journal.transitionTransaction("tx-1", "created", "rolled_back", {}), /state changed/);
  assert.deepEqual(journal.listIncompleteTransactions().map((entry) => entry.id), ["tx-1"]);
  repositories.close();

  db = new Database(dbPath);
  migrateDatabase(db, defaultSettings);
  repositories = createSqliteRepositories(db, defaultSettings);
  assert.deepEqual(repositories.tvConflictJournal.listAuditForJob("job-1"), audits);
  const reloaded = repositories.tvConflictJournal.getTransaction("tx-1");
  assert.equal(reloaded.state, "failed");
  assert.equal(reloaded.failure, "Interrupted");
  assert.deepEqual(reloaded.existing, existing);
  assert.deepEqual(reloaded.incoming, incoming);
  const originalChecksum = "a".repeat(64);
  const replacementChecksum = "b".repeat(64);
  repositories.tvConflictJournal.transitionTransaction("tx-1", "failed", "quarantined", { originalChecksum });
  assert.throws(() => repositories.tvConflictJournal.transitionTransaction("tx-1", "quarantined", "published", {
    originalChecksum: "c".repeat(64), replacementChecksum
  }), /checksum is invalid or changed/);
  repositories.tvConflictJournal.transitionTransaction("tx-1", "quarantined", "published", { replacementChecksum });
  repositories.tvConflictJournal.transitionTransaction("tx-1", "published", "completed", {});
  assert.equal(repositories.tvConflictJournal.listIncompleteTransactions().length, 0);
  assert.equal(repositories.tvConflictJournal.getTransaction("tx-1").originalChecksum, originalChecksum);
  assert.throws(() => repositories.tvConflictJournal.transitionTransaction("tx-1", "completed", "failed", {
    failure: "too late"
  }), /Invalid replacement transition/);
});

test("the application database uses full SQLite synchronous durability", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autodisc-sqlite-durability-"));
  const db = openSqliteDatabase(path.join(root, "state.sqlite"));
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(db.pragma("synchronous")[0].synchronous, 2);
});

test("replacement journal rejects invalid initial states and paths", () => {
  const db = new Database(":memory:");
  migrateDatabase(db, defaultSettings);
  const repositories = createSqliteRepositories(db, defaultSettings);
  try {
    const originalPath = path.resolve("original.mkv");
    const tx = {
      id: "tx", jobId: "job", state: "created", createdAt: "now", updatedAt: "now",
      originalPath, quarantinePath: originalPath, replacementPath: originalPath,
      originalChecksum: null, replacementChecksum: null, existing: { outputPath: originalPath },
      incoming: {}, failure: null
    };
    assert.throws(() => repositories.tvConflictJournal.createTransaction(tx), /paths are invalid/);
    assert.throws(() => repositories.tvConflictJournal.createTransaction({
      ...tx, state: "quarantined", quarantinePath: path.resolve("quarantine")
    }), /must start in the created state/);
    assert.equal(repositories.tvConflictJournal.listIncompleteTransactions().length, 0);
  } finally {
    repositories.close();
  }
});
