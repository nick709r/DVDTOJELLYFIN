import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { defaultSettings } from "../dist/infrastructure/database/default-settings.js";
import { openSqliteDatabase } from "../dist/infrastructure/database/connection.js";
import { migrateDatabase } from "../dist/infrastructure/database/migrations.js";
import { createSqliteRepositories } from "../dist/infrastructure/database/repositories.js";

test("replacement migration retains legacy journal rows without manufacturing snapshots", () => {
  const db = new Database(":memory:");
  migrateDatabase(db, defaultSettings);
  db.exec(`
    DROP TABLE tv_replacement_claims;
    DROP TABLE tv_replacement_events;
    DROP TABLE tv_replacement_snapshots;
    DROP TABLE tv_replacement_transactions;
    CREATE TABLE tv_replacement_transactions (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL, state TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, original_path TEXT NOT NULL,
      quarantine_path TEXT NOT NULL, replacement_path TEXT NOT NULL, original_checksum TEXT,
      replacement_checksum TEXT, existing_json TEXT NOT NULL, incoming_json TEXT NOT NULL, failure TEXT
    );
    CREATE INDEX tv_replacement_transactions_state ON tv_replacement_transactions(state);
    INSERT INTO tv_replacement_transactions VALUES
      ('legacy', 'job', 'failed', 'time', 'time', '/old', '/quarantine', '/old', NULL, NULL, '{}', '{}', 'interrupted');
    DELETE FROM schema_migrations WHERE version = 32;
  `);
  try {
    migrateDatabase(db, defaultSettings);
    const journal = createSqliteRepositories(db, defaultSettings).tvConflictJournal;
    assert.equal(journal.getTransaction("legacy").failure, "interrupted");
    assert.equal(journal.getReplacementSnapshot("legacy"), undefined);
    assert.deepEqual(journal.listIncompleteTransactions().map((entry) => entry.id), ["legacy"]);
  } finally {
    db.close();
  }
});

test("replacement snapshots, claims and atomic completion survive SQLite failures and restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "autodisc-replacement-transaction-"));
  const dbPath = join(root, "state.sqlite");
  let db = openSqliteDatabase(dbPath);
  migrateDatabase(db, defaultSettings);
  let repositories = createSqliteRepositories(db, defaultSettings);
  t.after(async () => {
    repositories.close();
    await rm(root, { recursive: true, force: true });
  });
  const originalPath = join(root, "S01E07.mkv");
  const existing = {
    outputPath: originalPath, fingerprint: "old-disc", discLabel: "Disc 1", discNumber: 1,
    trackId: "7", trackTitle: "Old title", seriesName: "Show", metadataProvider: "manual",
    providerId: null, seasonNumber: 1, episodeNumber: 7,
    confirmedAt: "2026-01-01", publishedAt: "2026-01-02"
  };
  const incoming = {
    fingerprint: "new-disc", discLabel: "Disc 2", trackId: "1", trackTitle: "Episode 7",
    confirmedAt: "2026-01-03"
  };
  const replacement = { ...existing, ...incoming, discNumber: 2, publishedAt: "2026-01-04" };
  const at = "2026-01-04T00:00:00.000Z";
  const tx = {
    id: "tx-1", jobId: "job-1", state: "created", createdAt: at, updatedAt: at,
    originalPath, replacementPath: originalPath, quarantinePath: join(root, "quarantine.mkv"),
    originalChecksum: null, replacementChecksum: null, existing, incoming, failure: null
  };
  const snapshot = {
    candidatePath: join(root, "candidate.mkv"), stagedSourcePath: join(root, "staged.mkv"),
    existingPublications: [existing], replacementPublications: [replacement],
    conflict: { episode: 7 }, decisionBy: "admin", provenanceStatus: "verified"
  };
  const audit = {
    id: "audit", jobId: tx.jobId, at, action: "replace_existing", seasonNumber: 1, episodeNumber: 7,
    incoming, existing, provenanceStatus: "verified", decisionBy: "admin", details: {}
  };
  repositories.tvEpisodePublications.record([existing]);
  const journal = repositories.tvConflictJournal;
  assert.throws(() => journal.createReplacementTransaction(tx, {
    ...snapshot, existingPublications: []
  }), /provenance changed/);
  journal.createReplacementTransaction(tx, snapshot);
  assert.deepEqual(journal.getReplacementSnapshot(tx.id), snapshot);
  assert.throws(() => db.prepare("UPDATE tv_replacement_snapshots SET snapshot_json = '{}'").run(), /immutable/);
  assert.throws(() => db.prepare("DELETE FROM tv_replacement_snapshots").run(), /immutable/);
  assert.throws(() => journal.createReplacementTransaction({
    ...tx, id: "tx-2", quarantinePath: join(root, "q2.mkv")
  }, { ...snapshot, candidatePath: join(root, "c2.mkv"), stagedSourcePath: join(root, "s2.mkv") }), /UNIQUE/);
  assert.equal(journal.getTransaction("tx-2"), undefined);
  const otherPath = join(root, "different-library", "alternate-S01E07.mkv");
  const otherExisting = { ...existing, outputPath: otherPath };
  const otherReplacement = { ...replacement, outputPath: otherPath };
  repositories.tvEpisodePublications.record([otherExisting]);
  assert.throws(() => journal.createReplacementTransaction({
    ...tx, id: "tx-3", originalPath: otherPath, replacementPath: otherPath,
    quarantinePath: join(root, "q3.mkv"), existing: otherExisting
  }, {
    ...snapshot, candidatePath: join(root, "c3.mkv"), stagedSourcePath: join(root, "s3.mkv"),
    existingPublications: [otherExisting], replacementPublications: [otherReplacement]
  }), /UNIQUE/);
  assert.equal(journal.getTransaction("tx-3"), undefined);
  db.prepare("DELETE FROM tv_episode_publications WHERE output_path = ?").run(otherPath);
  assert.throws(() => journal.transitionTransaction(tx.id, "created", "quarantined", {
    originalChecksum: "a".repeat(64)
  }), /candidate must be ready/);
  assert.throws(() => journal.transitionTransaction(tx.id, "created", "candidate_ready", {
    replacementChecksum: "b".repeat(64)
  }), /durable evidence/);
  const fileEvidence = { checksum: "b".repeat(64), size: "2048", device: "1", inode: "2",
    modifiedNs: "3", changedNs: "4" };
  const evidence = { candidate: fileEvidence, original: { ...fileEvidence, checksum: "a".repeat(64) },
    stagedSource: { ...fileEvidence, inode: "3" } };
  journal.recordCandidateReady(tx.id, evidence);
  assert.deepEqual(journal.getCandidateEvidence(tx.id), evidence);
  assert.deepEqual(journal.listIncompleteTransactions().map((entry) => entry.id), [tx.id]);
  assert.throws(() => journal.transitionTransaction(tx.id, "candidate_ready", "quarantined", {
    originalChecksum: "c".repeat(64)
  }), /does not match candidate evidence/);
  journal.transitionTransaction(tx.id, "candidate_ready", "quarantined", { originalChecksum: "a".repeat(64) });
  journal.transitionTransaction(tx.id, "quarantined", "published", {});
  assert.throws(() => journal.transitionTransaction(tx.id, "published", "completed", {}), /atomic provenance/);

  journal.appendAudit(audit);
  assert.throws(() => journal.completeReplacementTransaction(tx.id, audit), /UNIQUE/);
  assert.deepEqual(repositories.tvEpisodePublications.listForSeason(1).map((row) => ({ ...row })), [existing]);
  assert.equal(journal.getTransaction(tx.id).state, "published");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tv_replacement_claims WHERE transaction_id = ?").get(tx.id).count, 6);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tv_replacement_events WHERE transaction_id = ? AND state = 'completed'").get(tx.id).count, 0);

  repositories.close();
  db = openSqliteDatabase(dbPath);
  migrateDatabase(db, defaultSettings);
  repositories = createSqliteRepositories(db, defaultSettings);
  repositories.tvConflictJournal.completeReplacementTransaction(tx.id, { ...audit, id: "completion-audit" });
  assert.deepEqual(repositories.tvEpisodePublications.listForSeason(1).map((row) => ({ ...row })), [replacement]);
  assert.deepEqual(repositories.tvConflictJournal.getReplacementSnapshot(tx.id), snapshot);
  assert.equal(repositories.tvConflictJournal.getTransaction(tx.id).state, "completed");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tv_replacement_claims WHERE transaction_id = ?").get(tx.id).count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tv_replacement_events WHERE transaction_id = ? AND state = 'completed'").get(tx.id).count, 1);
  assert.throws(() => repositories.tvConflictJournal.completeReplacementTransaction(tx.id, audit), /not ready/);
});
