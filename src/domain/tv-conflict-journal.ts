import type { TvEpisodePublication } from "./tv-publication.js";

export type TvConflictAction = "keep_existing" | "keep_both" | "mark_as_extras" | "replace_existing";
export type TvProvenanceStatus = "verified" | "legacy" | "unknown";
export type TvReplacementState = "created" | "candidate_ready" | "quarantined" | "published" | "completed" | "failed" | "rolled_back";

export interface TvConflictSource {
  fingerprint: string;
  discLabel: string;
  trackId: string;
  trackTitle: string;
  confirmedAt: string | null;
}

export interface TvConflictAuditRecord {
  id: string;
  jobId: string;
  at: string;
  action: TvConflictAction;
  seasonNumber: number;
  episodeNumber: number;
  incoming: TvConflictSource;
  existing: TvEpisodePublication;
  provenanceStatus: TvProvenanceStatus;
  decisionBy: string;
  details: Readonly<Record<string, unknown>>;
}

export interface TvReplacementTransaction {
  id: string;
  jobId: string;
  state: TvReplacementState;
  createdAt: string;
  updatedAt: string;
  originalPath: string;
  quarantinePath: string;
  replacementPath: string;
  originalChecksum: string | null;
  replacementChecksum: string | null;
  existing: TvEpisodePublication;
  incoming: TvConflictSource;
  failure: string | null;
}

export interface TvReplacementSnapshot {
  candidatePath: string;
  stagedSourcePath: string;
  existingPublications: readonly TvEpisodePublication[];
  replacementPublications: readonly TvEpisodePublication[];
  conflict: Readonly<Record<string, unknown>>;
  decisionBy: string;
  provenanceStatus: TvProvenanceStatus;
}

export interface TvReplacementFileEvidence {
  checksum: string;
  size: string;
  device: string;
  inode: string;
  modifiedNs: string;
  changedNs: string;
}

export interface TvReplacementCandidateEvidence {
  candidate: TvReplacementFileEvidence;
  original: TvReplacementFileEvidence;
  stagedSource: TvReplacementFileEvidence;
}

export interface TvConflictJournalRepository {
  appendAudit(record: TvConflictAuditRecord): void;
  listAuditForJob(jobId: string): TvConflictAuditRecord[];
  createTransaction(transaction: TvReplacementTransaction): void;
  createReplacementTransaction(transaction: TvReplacementTransaction, snapshot: TvReplacementSnapshot): void;
  getReplacementSnapshot(id: string): TvReplacementSnapshot | undefined;
  recordCandidateReady(id: string, evidence: TvReplacementCandidateEvidence): void;
  getCandidateEvidence(id: string): TvReplacementCandidateEvidence | undefined;
  assertReplacementClaims(id: string): void;
  completeReplacementTransaction(id: string, audit: TvConflictAuditRecord): void;
  getTransaction(id: string): TvReplacementTransaction | undefined;
  listIncompleteTransactions(): TvReplacementTransaction[];
  listTransactionsForJob(jobId: string): TvReplacementTransaction[];
  listReplacementJobIds(): string[];
  transitionTransaction(
    id: string,
    expected: TvReplacementState,
    next: TvReplacementState,
    evidence: { originalChecksum?: string; replacementChecksum?: string; failure?: string }
  ): void;
}
