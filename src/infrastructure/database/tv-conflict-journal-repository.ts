import { dirname, isAbsolute, resolve } from "node:path";
import type Database from "better-sqlite3";
import type {
  TvConflictAuditRecord,
  TvConflictJournalRepository,
  TvConflictSource,
  TvReplacementCandidateEvidence,
  TvReplacementSnapshot,
  TvReplacementState,
  TvReplacementTransaction
} from "../../domain/tv-conflict-journal.js";
import type { TvEpisodePublication } from "../../domain/tv-publication.js";
import { normalizeDiscName } from "../../application/tv-name-normalization.js";

interface AuditRow extends Omit<TvConflictAuditRecord, "incoming" | "existing" | "details"> {
  incomingJson: string;
  existingJson: string;
  detailsJson: string;
}

interface TransactionRow extends Omit<TvReplacementTransaction, "existing" | "incoming"> {
  existingJson: string;
  incomingJson: string;
}

const transitions: Record<TvReplacementState, readonly TvReplacementState[]> = {
  created: ["candidate_ready", "quarantined", "failed", "rolled_back"],
  candidate_ready: ["quarantined", "failed", "rolled_back"],
  quarantined: ["published", "failed", "rolled_back"],
  published: ["completed", "failed", "rolled_back"],
  failed: ["quarantined", "published", "rolled_back"],
  completed: [],
  rolled_back: []
};

const checksumPattern = /^[a-f0-9]{64}$/;

function claimPath(path: string): string {
  const resolved = resolve(path);
  return `path:${process.platform === "win32" ? resolved.toLowerCase() : resolved}`;
}

function claims(transaction: TvReplacementTransaction, snapshot: TvReplacementSnapshot): string[] {
  const pathClaims = [
    transaction.originalPath, transaction.replacementPath, transaction.quarantinePath,
    snapshot.candidatePath, snapshot.stagedSourcePath
  ].map(claimPath);
  const season = claimPath(dirname(transaction.originalPath));
  const episodeClaims = [...snapshot.existingPublications, ...snapshot.replacementPublications]
    .flatMap((publication) => {
      const episode = [publication.seasonNumber, publication.episodeNumber];
      const name = normalizeDiscName(publication.seriesName).toLocaleLowerCase();
      const keys = [
        `episode:${JSON.stringify([season, ...episode])}`,
        `episode:${JSON.stringify(["name", name, ...episode])}`
      ];
      if (publication.providerId) {
        keys.push(`episode:${JSON.stringify(["provider", publication.metadataProvider, publication.providerId, ...episode])}`);
      }
      return keys;
    });
  return [...new Set([...pathClaims, ...episodeClaims])].sort();
}

function sortedPublications(publications: readonly TvEpisodePublication[]): string {
  return JSON.stringify([...publications].map((publication) => [
    publication.outputPath, publication.fingerprint, publication.discLabel, publication.discNumber,
    publication.trackId, publication.trackTitle, publication.seriesName, publication.metadataProvider,
    publication.providerId, publication.seasonNumber, publication.episodeNumber,
    publication.confirmedAt, publication.publishedAt
  ]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}

function transactionFromRow(row: TransactionRow | undefined): TvReplacementTransaction | undefined {
  if (!row) return undefined;
  const { existingJson, incomingJson, ...transaction } = row;
  return {
    ...transaction,
    existing: JSON.parse(existingJson) as TvEpisodePublication,
    incoming: JSON.parse(incomingJson) as TvConflictSource
  };
}

export class SqliteTvConflictJournalRepository implements TvConflictJournalRepository {
  constructor(private readonly db: Database.Database) {}

  appendAudit(record: TvConflictAuditRecord): void {
    if (!record.id || !record.jobId || !record.at || !record.decisionBy.trim() ||
      !Number.isInteger(record.seasonNumber) || record.seasonNumber < 0 ||
      !Number.isInteger(record.episodeNumber) || record.episodeNumber < 0) {
      throw new Error("Conflict audit record is incomplete");
    }
    this.db.prepare(`
      INSERT INTO tv_conflict_audit
        (id, job_id, at, action, season_number, episode_number, incoming_json, existing_json,
         provenance_status, decision_by, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(record.id, record.jobId, record.at, record.action, record.seasonNumber, record.episodeNumber,
      JSON.stringify(record.incoming), JSON.stringify(record.existing), record.provenanceStatus,
      record.decisionBy, JSON.stringify(record.details));
  }

  listAuditForJob(jobId: string): TvConflictAuditRecord[] {
    const rows = this.db.prepare(`
      SELECT id, job_id AS jobId, at, action, season_number AS seasonNumber, episode_number AS episodeNumber,
        incoming_json AS incomingJson, existing_json AS existingJson, provenance_status AS provenanceStatus,
        decision_by AS decisionBy, details_json AS detailsJson
      FROM tv_conflict_audit WHERE job_id = ? ORDER BY at, rowid
    `).all(jobId) as AuditRow[];
    return rows.map(({ incomingJson, existingJson, detailsJson, ...record }) => ({
      ...record,
      incoming: JSON.parse(incomingJson) as TvConflictSource,
      existing: JSON.parse(existingJson) as TvEpisodePublication,
      details: JSON.parse(detailsJson) as Record<string, unknown>
    }));
  }

  createTransaction(transaction: TvReplacementTransaction): void {
    if (!transaction.id || !transaction.jobId || !transaction.createdAt ||
      transaction.state !== "created" || transaction.updatedAt !== transaction.createdAt ||
      transaction.originalChecksum !== null || transaction.replacementChecksum !== null ||
      transaction.failure !== null) {
      throw new Error("Replacement transaction must start in the created state without evidence");
    }
    if (![transaction.originalPath, transaction.quarantinePath, transaction.replacementPath].every(isAbsolute) ||
      resolve(transaction.originalPath) !== resolve(transaction.existing.outputPath) ||
      resolve(transaction.quarantinePath) === resolve(transaction.originalPath) ||
      resolve(transaction.quarantinePath) === resolve(transaction.replacementPath)) {
      throw new Error("Replacement transaction paths are invalid");
    }
    this.db.prepare(`
      INSERT INTO tv_replacement_transactions
        (id, job_id, state, created_at, updated_at, original_path, quarantine_path, replacement_path,
         original_checksum, replacement_checksum, existing_json, incoming_json, failure)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(transaction.id, transaction.jobId, transaction.state, transaction.createdAt, transaction.updatedAt,
      transaction.originalPath, transaction.quarantinePath, transaction.replacementPath,
      transaction.originalChecksum, transaction.replacementChecksum, JSON.stringify(transaction.existing),
      JSON.stringify(transaction.incoming), transaction.failure);
  }

  createReplacementTransaction(transaction: TvReplacementTransaction, snapshot: TvReplacementSnapshot): void {
    const allPaths = [
      transaction.originalPath, transaction.quarantinePath, transaction.replacementPath,
      snapshot.candidatePath, snapshot.stagedSourcePath
    ];
    if (!allPaths.every(isAbsolute) || resolve(transaction.originalPath) !== resolve(transaction.replacementPath) ||
      new Set([transaction.originalPath, transaction.quarantinePath, snapshot.candidatePath, snapshot.stagedSourcePath]
        .map(claimPath)).size !== 4 || !snapshot.decisionBy.trim() ||
      !["verified", "legacy", "unknown"].includes(snapshot.provenanceStatus) ||
      snapshot.replacementPublications.length === 0 ||
      [...snapshot.existingPublications, ...snapshot.replacementPublications]
        .some((publication) => resolve(publication.outputPath) !== resolve(transaction.originalPath) ||
          !normalizeDiscName(publication.seriesName).trim() ||
          !Number.isInteger(publication.seasonNumber) || publication.seasonNumber < 0 ||
          !Number.isInteger(publication.episodeNumber) || publication.episodeNumber < 0) ||
      snapshot.existingPublications.some((existing) => !snapshot.replacementPublications.some((replacement) =>
        existing.seasonNumber === replacement.seasonNumber && existing.episodeNumber === replacement.episodeNumber)) ||
      new Set(snapshot.replacementPublications.map((publication) =>
        JSON.stringify([publication.seasonNumber, publication.episodeNumber]))).size !== snapshot.replacementPublications.length ||
      snapshot.replacementPublications.some((publication) =>
        publication.fingerprint !== transaction.incoming.fingerprint || publication.trackId !== transaction.incoming.trackId ||
        publication.discLabel !== transaction.incoming.discLabel || publication.trackTitle !== transaction.incoming.trackTitle ||
        publication.confirmedAt !== transaction.incoming.confirmedAt)) {
      throw new Error("Replacement transaction snapshot or paths are invalid");
    }
    this.db.transaction(() => {
      const current = this.publicationsForPath(transaction.originalPath);
      if (sortedPublications(current) !== sortedPublications(snapshot.existingPublications)) {
        throw new Error("Existing publication provenance changed before replacement");
      }
      this.createTransaction(transaction);
      this.db.prepare("INSERT INTO tv_replacement_snapshots (transaction_id, snapshot_json) VALUES (?, ?)")
        .run(transaction.id, JSON.stringify(snapshot));
      const insert = this.db.prepare("INSERT INTO tv_replacement_claims (claim_key, transaction_id) VALUES (?, ?)");
      for (const key of claims(transaction, snapshot)) insert.run(key, transaction.id);
      this.addReplacementEvent(transaction.id, transaction.createdAt, "created", {});
    })();
  }

  getReplacementSnapshot(id: string): TvReplacementSnapshot | undefined {
    const row = this.db.prepare("SELECT snapshot_json AS snapshotJson FROM tv_replacement_snapshots WHERE transaction_id = ?")
      .get(id) as { snapshotJson: string } | undefined;
    return row ? JSON.parse(row.snapshotJson) as TvReplacementSnapshot : undefined;
  }

  recordCandidateReady(id: string, evidence: TvReplacementCandidateEvidence): void {
    for (const file of [evidence.candidate, evidence.original, evidence.stagedSource]) {
      if (!checksumPattern.test(file.checksum) ||
        ![file.size, file.device, file.inode, file.modifiedNs, file.changedNs].every((value) =>
          typeof value === "string" && /^\d+$/.test(value)) || BigInt(file.size) === 0n) {
        throw new Error("Replacement candidate evidence is invalid");
      }
    }
    this.db.transaction(() => {
      const transaction = this.getTransaction(id);
      const snapshot = this.getReplacementSnapshot(id);
      if (!transaction || !snapshot || transaction.state !== "created") {
        throw new Error("Replacement transaction is not ready for candidate preparation");
      }
      this.assertClaims(transaction, snapshot);
      const at = new Date().toISOString();
      const changed = this.db.prepare(`
        UPDATE tv_replacement_transactions SET state = 'candidate_ready', updated_at = ?, replacement_checksum = ?
        WHERE id = ? AND state = 'created' AND replacement_checksum IS NULL
      `).run(at, evidence.candidate.checksum, id);
      if (changed.changes !== 1) throw new Error("Replacement transaction state changed");
      this.addReplacementEvent(id, at, "candidate_ready", evidence);
    })();
  }

  getCandidateEvidence(id: string): TvReplacementCandidateEvidence | undefined {
    const row = this.db.prepare(`
      SELECT details_json AS detailsJson FROM tv_replacement_events
      WHERE transaction_id = ? AND state = 'candidate_ready' ORDER BY id DESC LIMIT 1
    `).get(id) as { detailsJson: string } | undefined;
    if (!row) return undefined;
    const value = JSON.parse(row.detailsJson) as Partial<TvReplacementCandidateEvidence>;
    if (!value.candidate || !value.original || !value.stagedSource) return undefined;
    return value as TvReplacementCandidateEvidence;
  }

  assertReplacementClaims(id: string): void {
    const transaction = this.getTransaction(id);
    const snapshot = this.getReplacementSnapshot(id);
    if (!transaction || !snapshot || !["created", "candidate_ready", "quarantined", "published", "failed"].includes(transaction.state)) {
      throw new Error("Replacement transaction has no active claims");
    }
    this.assertClaims(transaction, snapshot);
  }

  private assertClaims(transaction: TvReplacementTransaction, snapshot: TvReplacementSnapshot): void {
    const held = this.db.prepare("SELECT claim_key AS claimKey FROM tv_replacement_claims WHERE transaction_id = ? ORDER BY claim_key")
      .all(transaction.id) as Array<{ claimKey: string }>;
    if (JSON.stringify(held.map((item) => item.claimKey).sort()) !== JSON.stringify(claims(transaction, snapshot))) {
      throw new Error("Replacement claims have changed");
    }
  }

  completeReplacementTransaction(id: string, audit: TvConflictAuditRecord): void {
    this.db.transaction(() => {
      const transaction = this.getTransaction(id);
      const snapshot = this.getReplacementSnapshot(id);
      if (!transaction || !snapshot || transaction.state !== "published" ||
        !transaction.originalChecksum || !transaction.replacementChecksum) {
        throw new Error("Replacement is not ready for atomic completion");
      }
      this.assertClaims(transaction, snapshot);
      if (sortedPublications(this.publicationsForPath(transaction.originalPath)) !== sortedPublications(snapshot.existingPublications)) {
        throw new Error("Existing publication provenance changed during replacement");
      }
      if (audit.action !== "replace_existing" || audit.jobId !== transaction.jobId ||
        audit.incoming.fingerprint !== transaction.incoming.fingerprint ||
        audit.incoming.trackId !== transaction.incoming.trackId ||
        audit.incoming.discLabel !== transaction.incoming.discLabel ||
        audit.incoming.trackTitle !== transaction.incoming.trackTitle ||
        audit.incoming.confirmedAt !== transaction.incoming.confirmedAt ||
        audit.decisionBy !== snapshot.decisionBy || audit.provenanceStatus !== snapshot.provenanceStatus ||
        audit.seasonNumber !== transaction.existing.seasonNumber ||
        audit.episodeNumber !== transaction.existing.episodeNumber ||
        sortedPublications([audit.existing]) !== sortedPublications([transaction.existing])) {
        throw new Error("Replacement audit does not match the transaction snapshot");
      }
      this.db.prepare("DELETE FROM tv_episode_publications WHERE output_path = ?").run(transaction.originalPath);
      const insert = this.db.prepare(`
        INSERT INTO tv_episode_publications
          (output_path, fingerprint, disc_label, disc_number, track_id, track_title, series_name,
           metadata_provider, provider_id, season_number, episode_number, confirmed_at, published_at)
        VALUES (@outputPath, @fingerprint, @discLabel, @discNumber, @trackId, @trackTitle, @seriesName,
          @metadataProvider, @providerId, @seasonNumber, @episodeNumber, @confirmedAt, @publishedAt)
      `);
      for (const publication of snapshot.replacementPublications) insert.run(publication);
      this.appendAudit(audit);
      this.addReplacementEvent(id, audit.at, "completed", { auditId: audit.id });
      const result = this.db.prepare(`
        UPDATE tv_replacement_transactions SET state = 'completed', updated_at = ?, failure = NULL
        WHERE id = ? AND state = 'published'
      `).run(audit.at, id);
      if (result.changes !== 1) throw new Error("Replacement transaction state changed");
      this.db.prepare("DELETE FROM tv_replacement_claims WHERE transaction_id = ?").run(id);
    })();
  }

  private publicationsForPath(path: string): TvEpisodePublication[] {
    return this.db.prepare(`
      SELECT output_path AS outputPath, fingerprint, disc_label AS discLabel, disc_number AS discNumber,
        track_id AS trackId, track_title AS trackTitle, series_name AS seriesName,
        metadata_provider AS metadataProvider, provider_id AS providerId, season_number AS seasonNumber,
        episode_number AS episodeNumber, confirmed_at AS confirmedAt, published_at AS publishedAt
      FROM tv_episode_publications WHERE output_path = ?
    `).all(path) as TvEpisodePublication[];
  }

  private addReplacementEvent(id: string, at: string, state: TvReplacementState, details: object): void {
    this.db.prepare("INSERT INTO tv_replacement_events (transaction_id, at, state, details_json) VALUES (?, ?, ?, ?)")
      .run(id, at, state, JSON.stringify(details));
  }

  getTransaction(id: string): TvReplacementTransaction | undefined {
    return transactionFromRow(this.db.prepare(`
      SELECT id, job_id AS jobId, state, created_at AS createdAt, updated_at AS updatedAt,
        original_path AS originalPath, quarantine_path AS quarantinePath, replacement_path AS replacementPath,
        original_checksum AS originalChecksum, replacement_checksum AS replacementChecksum,
        existing_json AS existingJson, incoming_json AS incomingJson, failure
      FROM tv_replacement_transactions WHERE id = ?
    `).get(id) as TransactionRow | undefined);
  }

  listIncompleteTransactions(): TvReplacementTransaction[] {
    const ids = this.db.prepare(`
      SELECT id FROM tv_replacement_transactions WHERE state IN ('created', 'candidate_ready', 'quarantined', 'published', 'failed')
      ORDER BY created_at, id
    `).all() as Array<{ id: string }>;
    return ids.map(({ id }) => {
      const transaction = this.getTransaction(id);
      if (!transaction) throw new Error(`Replacement transaction ${id} disappeared`);
      return transaction;
    });
  }

  listReplacementJobIds(): string[] {
    const rows = this.db.prepare("SELECT DISTINCT job_id AS jobId FROM tv_replacement_transactions").all() as Array<{ jobId: string }>;
    return rows.map(({ jobId }) => jobId);
  }

  transitionTransaction(
    id: string,
    expected: TvReplacementState,
    next: TvReplacementState,
    evidence: { originalChecksum?: string; replacementChecksum?: string; failure?: string }
  ): void {
    if (!transitions[expected]?.includes(next)) throw new Error(`Invalid replacement transition ${expected} to ${next}`);
    const apply = this.db.transaction(() => {
      const current = this.getTransaction(id);
      if (!current || current.state !== expected) throw new Error("Replacement transaction state changed");
      const snapshot = this.getReplacementSnapshot(id);
      if (snapshot && next === "candidate_ready") {
        throw new Error("Replacement candidate requires a durable evidence checkpoint");
      }
      if (snapshot && next === "completed") {
        throw new Error("Replacement completion requires atomic provenance and audit updates");
      }
      if (snapshot && expected === "created" && next === "quarantined") {
        throw new Error("Replacement candidate must be ready before quarantine");
      }
      const checksums: Array<[string | undefined, string | null]> = [
        [evidence.originalChecksum, current.originalChecksum],
        [evidence.replacementChecksum, current.replacementChecksum]
      ];
      for (const [value, existing] of checksums) {
        if (value !== undefined && (!checksumPattern.test(value) || (existing !== null && existing !== value))) {
          throw new Error("Replacement transaction checksum is invalid or changed");
        }
      }
      const originalChecksum = evidence.originalChecksum ?? current.originalChecksum;
      const replacementChecksum = evidence.replacementChecksum ?? current.replacementChecksum;
      if (snapshot && next === "quarantined") {
        const candidateEvidence = this.getCandidateEvidence(id);
        if (!candidateEvidence || originalChecksum !== candidateEvidence.original.checksum ||
          replacementChecksum !== candidateEvidence.candidate.checksum) {
          throw new Error("Replacement quarantine does not match candidate evidence");
        }
        this.assertClaims(current, snapshot);
      }
      if (snapshot && next === "published") this.assertClaims(current, snapshot);
      if (next === "candidate_ready" && !replacementChecksum) {
        throw new Error("Replacement checksum is required when the candidate is ready");
      }
      if (["quarantined", "published", "completed"].includes(next) && !originalChecksum) {
        throw new Error("Original checksum is required after quarantine");
      }
      if (["published", "completed"].includes(next) && !replacementChecksum) {
        throw new Error("Replacement checksum is required after publication");
      }
      if (next === "failed" && !evidence.failure?.trim()) throw new Error("A failure reason is required");
      const at = new Date().toISOString();
      const changed = this.db.prepare(`
        UPDATE tv_replacement_transactions SET state = ?, updated_at = ?, original_checksum = ?,
          replacement_checksum = ?, failure = ? WHERE id = ? AND state = ?
      `).run(next, at, originalChecksum, replacementChecksum,
        next === "failed" ? evidence.failure : null, id, expected);
      if (changed.changes !== 1) throw new Error("Replacement transaction state changed");
      if (snapshot) this.addReplacementEvent(id, at, next, evidence);
      if (snapshot && next === "rolled_back") {
        this.db.prepare("DELETE FROM tv_replacement_claims WHERE transaction_id = ?").run(id);
      }
    });
    apply();
  }
}
