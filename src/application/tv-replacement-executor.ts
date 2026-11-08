import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { mediaDuration } from "../encoding.js";
import type { TvConflictJournalRepository, TvReplacementFileEvidence } from "../domain/tv-conflict-journal.js";
import type { AppSettings } from "../model.js";
import { pathsOverlap } from "../storage-paths.js";
import { copyToQuarantine, inspectRetainedFile, verifyRetainedFile } from "./tv-replacement-quarantine.js";
import { restoreQuarantinedFile } from "./tv-replacement-rollback.js";

async function validateQuarantinePath(settings: AppSettings, quarantinePath: string): Promise<void> {
  const quarantineRoot = resolve(settings.workDir, ".autodisc", "quarantine");
  const directory = resolve(dirname(quarantinePath));
  if (directory === quarantineRoot || !pathsOverlap(quarantineRoot, directory) ||
    !directory.startsWith(`${quarantineRoot}${sep}`)) {
    throw new Error("Replacement quarantine must be inside a transaction directory");
  }
  if (await realpath(quarantineRoot) !== quarantineRoot || await realpath(directory) !== directory) {
    throw new Error("Replacement quarantine must not traverse symbolic links");
  }
  const paths = [settings.tvRootDir, settings.moviesDir, settings.musicDir, settings.lidarrImportDir];
  for (const profile of settings.outputDestinations.profiles) {
    paths.push(profile.jellyfin.root, ...Object.values(profile.jellyfin.paths), profile.sonarr.seriesRoot,
      profile.radarr.movieRoot, profile.lidarr.artistRoot, ...Object.values(profile.folder));
  }
  for (const path of paths.filter((value) => value.trim())) {
    if (pathsOverlap(quarantineRoot, path)) throw new Error("Replacement quarantine overlaps a media library");
    const target = resolve(path);
    let ancestor = target;
    let actual: string;
    for (;;) {
      try {
        actual = resolve(await realpath(ancestor), relative(ancestor, target));
        break;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw new Error(`Cannot resolve media library: ${path}`, { cause: error });
        ancestor = parent;
      }
    }
    if (pathsOverlap(quarantineRoot, actual)) throw new Error("Replacement quarantine resolves into a media library");
  }
}

function sameEvidence(first: object, second: object): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

async function verifyPublishedCandidate(
  candidatePath: string,
  destinationPath: string,
  evidence: TvReplacementFileEvidence
): Promise<void> {
  const directoryPath = resolve(dirname(destinationPath));
  if (resolve(dirname(candidatePath)) !== directoryPath || await realpath(directoryPath) !== directoryPath) {
    throw new Error("Replacement publication directory changed");
  }
  const file = await open(destinationPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 2n || before.dev.toString() !== evidence.device ||
      before.ino.toString() !== evidence.inode || before.size.toString() !== evidence.size ||
      before.mtimeNs.toString() !== evidence.modifiedNs) {
      throw new Error("Published replacement does not match the candidate identity");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (hash.digest("hex") !== evidence.checksum) {
      throw new Error("Published replacement checksum does not match the candidate");
    }
    await file.sync();
    const directory = await open(directoryPath, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    for (const info of [await file.stat({ bigint: true }), await lstat(candidatePath, { bigint: true }),
      await lstat(destinationPath, { bigint: true })]) {
      if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino ||
        info.nlink !== before.nlink || info.size !== before.size ||
        info.mtimeNs !== before.mtimeNs || info.ctimeNs !== before.ctimeNs) {
        throw new Error("Published replacement changed during verification");
      }
    }
    if (await realpath(directoryPath) !== directoryPath) {
      throw new Error("Replacement publication directory changed");
    }
  } finally {
    await file.close();
  }
}

export async function publishReplacement(
  journal: TvConflictJournalRepository,
  settings: AppSettings,
  id: string,
  checkpoint?: (step: "before-publication" | "after-publication" | "before-journal" | "after-journal") => void
): Promise<void> {
  const transaction = journal.getTransaction(id);
  const snapshot = journal.getReplacementSnapshot(id);
  const evidence = journal.getCandidateEvidence(id);
  if (!transaction || !snapshot || !evidence || transaction.state !== "quarantined" ||
    transaction.originalChecksum !== evidence.original.checksum ||
    transaction.replacementChecksum !== evidence.candidate.checksum) {
    throw new Error("Replacement transaction is not ready for publication");
  }
  journal.assertReplacementClaims(id);
  await validateQuarantinePath(settings, transaction.quarantinePath);
  await verifyRetainedFile(transaction.quarantinePath, {
    checksum: evidence.original.checksum, size: BigInt(evidence.original.size)
  });
  if (!sameEvidence(await inspectRetainedFile(snapshot.candidatePath), evidence.candidate) ||
    !sameEvidence(await inspectRetainedFile(snapshot.stagedSourcePath), evidence.stagedSource)) {
    throw new Error("Replacement source identity changed; all files have been retained");
  }
  journal.assertReplacementClaims(id);
  checkpoint?.("before-publication");
  await link(snapshot.candidatePath, transaction.replacementPath);
  checkpoint?.("after-publication");
  await verifyPublishedCandidate(snapshot.candidatePath, transaction.replacementPath, evidence.candidate);
  await verifyRetainedFile(transaction.quarantinePath, {
    checksum: evidence.original.checksum, size: BigInt(evidence.original.size)
  });
  if (!sameEvidence(await inspectRetainedFile(snapshot.stagedSourcePath), evidence.stagedSource)) {
    throw new Error("Replacement staged source changed; all files have been retained");
  }
  journal.assertReplacementClaims(id);
  checkpoint?.("before-journal");
  journal.transitionTransaction(id, "quarantined", "published", {});
  checkpoint?.("after-journal");
}

export async function replaceOccupiedOriginal(
  journal: TvConflictJournalRepository,
  settings: AppSettings,
  id: string,
  checkpoint?: (step: "before-publication" | "after-publication" | "before-journal" | "after-journal") => void
): Promise<void> {
  const transaction = journal.getTransaction(id);
  const snapshot = journal.getReplacementSnapshot(id);
  const evidence = journal.getCandidateEvidence(id);
  if (!transaction || !snapshot || !evidence || transaction.state !== "quarantined" ||
    transaction.originalChecksum !== evidence.original.checksum ||
    transaction.replacementChecksum !== evidence.candidate.checksum) {
    throw new Error("Replacement transaction is not ready to replace the original");
  }
  journal.assertReplacementClaims(id);
  await validateQuarantinePath(settings, transaction.quarantinePath);
  await verifyRetainedFile(transaction.quarantinePath, {
    checksum: evidence.original.checksum, size: BigInt(evidence.original.size)
  });
  if (!sameEvidence(await inspectRetainedFile(transaction.originalPath), evidence.original) ||
    !sameEvidence(await inspectRetainedFile(snapshot.candidatePath), evidence.candidate) ||
    !sameEvidence(await inspectRetainedFile(snapshot.stagedSourcePath), evidence.stagedSource)) {
    throw new Error("Replacement source identity changed; all files have been retained");
  }
  const directoryPath = dirname(transaction.originalPath);
  const holdingDirectory = `${snapshot.candidatePath}.original`;
  if (dirname(holdingDirectory) !== directoryPath) {
    throw new Error("Replacement candidate must be in the original file's directory");
  }
  await mkdir(holdingDirectory, { mode: 0o700 });
  const parent = await open(directoryPath, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await parent.sync();
    journal.assertReplacementClaims(id);
    if (!sameEvidence(await inspectRetainedFile(transaction.originalPath), evidence.original)) {
      throw new Error("Original changed before replacement; all files have been retained");
    }
    const heldPath = join(holdingDirectory, "original");
    await rename(transaction.originalPath, heldPath);
    const holding = await open(holdingDirectory, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await holding.sync();
    } finally {
      await holding.close();
    }
    await parent.sync();
    const held = await inspectRetainedFile(heldPath);
    if (held.device !== evidence.original.device || held.inode !== evidence.original.inode ||
      held.size !== evidence.original.size || held.checksum !== evidence.original.checksum ||
      held.modifiedNs !== evidence.original.modifiedNs) {
      throw new Error("Moved original does not match the transaction; all files have been retained");
    }
    await publishReplacement(journal, settings, id, checkpoint);
  } finally {
    await parent.close();
  }
}

export async function executeReplacementTransaction(
  journal: TvConflictJournalRepository,
  settings: AppSettings,
  id: string
): Promise<void> {
  const transaction = journal.getTransaction(id);
  if (!transaction) throw new Error("Replacement transaction was not found");
  if (transaction.state === "created") await prepareReplacementCandidate(journal, id);
  const ready = journal.getTransaction(id);
  if (ready?.state === "candidate_ready") await quarantineReplacementOriginal(journal, settings, id);
  const quarantined = journal.getTransaction(id);
  if (quarantined?.state !== "quarantined") throw new Error("Replacement transaction is not ready to publish");
  await replaceOccupiedOriginal(journal, settings, id);
  const result = await reconcileReplacementTransaction(journal, settings, id);
  if (result.outcome !== "completed") {
    throw new Error(`Replacement requires review: ${result.reason ?? result.outcome}`);
  }
}

export async function reconcileReplacementTransaction(
  journal: TvConflictJournalRepository,
  settings: AppSettings,
  id: string
): Promise<{ outcome: "completed" | "rolled_back" | "review"; reason?: string }> {
  const transaction = journal.getTransaction(id);
  const snapshot = journal.getReplacementSnapshot(id);
  const evidence = journal.getCandidateEvidence(id);
  if (!transaction || !snapshot || !evidence ||
    !["quarantined", "published", "completed", "rolled_back"].includes(transaction.state)) {
    return { outcome: "review", reason: "Replacement transaction lacks a supported verified checkpoint" };
  }
  try {
    if (transaction.state !== "completed" && transaction.state !== "rolled_back") {
      journal.assertReplacementClaims(id);
    }
    await validateQuarantinePath(settings, transaction.quarantinePath);
    await verifyRetainedFile(transaction.quarantinePath, {
      checksum: evidence.original.checksum, size: BigInt(evidence.original.size)
    });
    if (transaction.originalChecksum !== evidence.original.checksum ||
      transaction.replacementChecksum !== evidence.candidate.checksum ||
      !sameEvidence(await inspectRetainedFile(snapshot.stagedSourcePath), evidence.stagedSource)) {
      throw new Error("Replacement evidence does not match the retained source");
    }
    if (transaction.state === "rolled_back") {
      await verifyRetainedFile(transaction.originalPath, {
        checksum: evidence.original.checksum, size: BigInt(evidence.original.size)
      });
      if (!sameEvidence(await inspectRetainedFile(snapshot.candidatePath), evidence.candidate)) {
        throw new Error("Replacement candidate identity changed after rollback");
      }
      return { outcome: "rolled_back" };
    }
    if (transaction.state === "completed") {
      await verifyPublishedCandidate(snapshot.candidatePath, transaction.replacementPath, evidence.candidate);
      return { outcome: "completed" };
    }
    let destinationExists = true;
    try {
      await lstat(transaction.replacementPath);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      destinationExists = false;
    }
    if (!destinationExists) {
      if (transaction.state !== "quarantined" ||
        !sameEvidence(await inspectRetainedFile(snapshot.candidatePath), evidence.candidate)) {
        throw new Error("Replacement destination is missing or candidate identity changed");
      }
      journal.assertReplacementClaims(id);
      await restoreQuarantinedFile(transaction.originalPath, transaction.quarantinePath, {
        checksum: evidence.original.checksum, size: BigInt(evidence.original.size)
      });
      journal.assertReplacementClaims(id);
      journal.transitionTransaction(id, "quarantined", "rolled_back", {});
      return { outcome: "rolled_back" };
    }
    if (transaction.state === "quarantined") {
      const info = await lstat(transaction.replacementPath, { bigint: true });
      const destination = info.isFile() && info.nlink === 1n
        ? await inspectRetainedFile(transaction.replacementPath) : null;
      if (destination && destination.checksum === evidence.original.checksum &&
        destination.size === evidence.original.size &&
        sameEvidence(await inspectRetainedFile(snapshot.candidatePath), evidence.candidate)) {
        journal.assertReplacementClaims(id);
        journal.transitionTransaction(id, "quarantined", "rolled_back", {});
        return { outcome: "rolled_back" };
      }
    }
    await verifyPublishedCandidate(snapshot.candidatePath, transaction.replacementPath, evidence.candidate);
    journal.assertReplacementClaims(id);
    if (transaction.state === "quarantined") {
      journal.transitionTransaction(id, "quarantined", "published", {});
    }
    journal.completeReplacementTransaction(id, {
      id: randomUUID(), jobId: transaction.jobId, at: new Date().toISOString(), action: "replace_existing",
      seasonNumber: transaction.existing.seasonNumber, episodeNumber: transaction.existing.episodeNumber,
      incoming: transaction.incoming, existing: transaction.existing, provenanceStatus: snapshot.provenanceStatus,
      decisionBy: snapshot.decisionBy, details: { transactionId: id }
    });
    return { outcome: "completed" };
  } catch (error) {
    return { outcome: "review", reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function reconcileReplacementTransactions(
  journal: TvConflictJournalRepository,
  settings: AppSettings
): Promise<Array<{ id: string; outcome: "completed" | "rolled_back" | "review"; reason?: string }>> {
  const results: Array<{ id: string; outcome: "completed" | "rolled_back" | "review"; reason?: string }> = [];
  for (const transaction of journal.listIncompleteTransactions()) {
    const result = await reconcileReplacementTransaction(journal, settings, transaction.id);
    results.push({ id: transaction.id, ...result });
  }
  return results;
}

export async function quarantineReplacementOriginal(
  journal: TvConflictJournalRepository,
  settings: AppSettings,
  id: string
): Promise<void> {
  const transaction = journal.getTransaction(id);
  const snapshot = journal.getReplacementSnapshot(id);
  const evidence = journal.getCandidateEvidence(id);
  if (!transaction || !snapshot || !evidence || transaction.state !== "candidate_ready") {
    throw new Error("Replacement transaction is not ready for quarantine");
  }
  journal.assertReplacementClaims(id);
  await validateQuarantinePath(settings, transaction.quarantinePath);
  if (!sameEvidence(await inspectRetainedFile(transaction.originalPath), evidence.original) ||
    !sameEvidence(await inspectRetainedFile(snapshot.candidatePath), evidence.candidate) ||
    !sameEvidence(await inspectRetainedFile(snapshot.stagedSourcePath), evidence.stagedSource)) {
    throw new Error("Replacement source identity changed; all files have been retained");
  }
  journal.assertReplacementClaims(id);
  const copy = await copyToQuarantine(transaction.originalPath, transaction.quarantinePath);
  if (copy.checksum !== evidence.original.checksum || copy.size.toString() !== evidence.original.size) {
    throw new Error("Replacement quarantine differs from the original snapshot; all files have been retained");
  }
  await verifyRetainedFile(transaction.quarantinePath, {
    checksum: evidence.original.checksum, size: BigInt(evidence.original.size)
  });
  if (!sameEvidence(await inspectRetainedFile(transaction.originalPath), evidence.original) ||
    !sameEvidence(await inspectRetainedFile(snapshot.candidatePath), evidence.candidate) ||
    !sameEvidence(await inspectRetainedFile(snapshot.stagedSourcePath), evidence.stagedSource)) {
    throw new Error("Replacement source identity changed during quarantine; all files have been retained");
  }
  journal.transitionTransaction(id, "candidate_ready", "quarantined", { originalChecksum: copy.checksum });
}

export async function prepareReplacementCandidate(
  journal: TvConflictJournalRepository,
  id: string
): Promise<void> {
  const transaction = journal.getTransaction(id);
  const snapshot = journal.getReplacementSnapshot(id);
  if (!transaction || !snapshot || transaction.state !== "created") {
    throw new Error("Replacement transaction is not ready for candidate preparation");
  }
  if (resolve(dirname(snapshot.candidatePath)) !== resolve(dirname(transaction.originalPath))) {
    throw new Error("Replacement candidate must be in the original file's directory");
  }
  const original = await inspectRetainedFile(transaction.originalPath);
  const stagedSource = await inspectRetainedFile(snapshot.stagedSourcePath);
  const candidate = await inspectRetainedFile(snapshot.candidatePath);
  if (BigInt(candidate.size) < 1024n) throw new Error("Replacement candidate is unexpectedly small");
  await mediaDuration(snapshot.candidatePath);
  const verifiedCandidate = await inspectRetainedFile(snapshot.candidatePath);
  const verifiedOriginal = await inspectRetainedFile(transaction.originalPath);
  const verifiedStaged = await inspectRetainedFile(snapshot.stagedSourcePath);
  if (JSON.stringify(candidate) !== JSON.stringify(verifiedCandidate) ||
    JSON.stringify(original) !== JSON.stringify(verifiedOriginal) ||
    JSON.stringify(stagedSource) !== JSON.stringify(verifiedStaged)) {
    throw new Error("Replacement files changed during candidate preparation; all files have been retained");
  }
  journal.recordCandidateReady(id, { candidate, original, stagedSource });
}
