import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import type { DiscRecovery } from "../domain/disc-recovery.js";
import type { TvMatchingAssignment } from "../domain/tv-matching.js";
import type { TvEpisodeConflict } from "./tv-episode-conflicts.js";

type Identity = Pick<DiscRecovery, "seriesName" | "metadataProvider" | "providerId" | "seasonNumber">;

export function storedKeepExistingConflict(assignment: TvMatchingAssignment): TvEpisodeConflict | undefined {
  if (!assignment.keepExisting) return undefined;
  const saved = JSON.parse(assignment.keepExisting.conflicts) as Array<{ conflict: TvEpisodeConflict }>;
  if (!Array.isArray(saved) || !saved[0]?.conflict) throw new Error("Stored conflict decision is invalid");
  return saved[0].conflict;
}

export function keepExistingMapping(identity: Identity, assignment: TvMatchingAssignment): string {
  return JSON.stringify({
    seriesName: identity.seriesName,
    metadataProvider: identity.metadataProvider,
    providerId: identity.providerId,
    seasonNumber: identity.seasonNumber,
    trackId: assignment.trackId,
    confirmed: assignment.confirmed,
    confirmedAt: assignment.confirmedAt ?? null,
    episodes: assignment.selectedEpisodes
  });
}

async function fileDigest(path: string): Promise<{ checksum: string; identity: string }> {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Episode output is not a regular file: ${path}`);
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  const after = await lstat(path, { bigint: true });
  if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino ||
    before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
    throw new Error(`Episode output changed while checking it: ${path}`);
  }
  return {
    checksum: digest.digest("hex"),
    identity: JSON.stringify([String(after.dev), String(after.ino), String(after.size),
      String(after.mtimeNs), String(after.ctimeNs)])
  };
}

export async function keepExistingConflicts(conflicts: readonly TvEpisodeConflict[]): Promise<string> {
  const snapshots = await Promise.all(conflicts.map(async (conflict) => {
    const digest = await fileDigest(conflict.existing.outputPath);
    return { conflict, ...digest };
  }));
  snapshots.sort((left, right) => JSON.stringify(left.conflict).localeCompare(JSON.stringify(right.conflict)));
  return JSON.stringify(snapshots);
}

export async function isKeepExistingValid(
  identity: Identity,
  assignment: TvMatchingAssignment,
  conflicts: readonly TvEpisodeConflict[],
  verifyContents = true
): Promise<boolean> {
  const decision = assignment.keepExisting;
  if (!decision || !assignment.confirmed || !assignment.selectedEpisodes?.length || conflicts.length === 0 ||
    (decision.action !== undefined && !["keep_existing", "keep_both", "mark_as_extras", "replace_existing"].includes(decision.action)) ||
    decision.mapping !== keepExistingMapping(identity, assignment) ||
    conflicts.some((conflict) => conflict.trackId !== assignment.trackId)) return false;
  const saved = JSON.parse(decision.conflicts) as Array<{
    conflict: TvEpisodeConflict; checksum: string; identity: string
  }>;
  if (!Array.isArray(saved) || saved.length !== conflicts.length) return false;
  for (const conflict of conflicts) {
    const snapshot = saved.find((item) => JSON.stringify(item.conflict) === JSON.stringify(conflict));
    if (!snapshot) return false;
    if (verifyContents) {
      if ((await fileDigest(conflict.existing.outputPath)).checksum !== snapshot.checksum) return false;
    } else {
      const info = await lstat(conflict.existing.outputPath, { bigint: true });
      if (!info.isFile() || info.isSymbolicLink()) return false;
      const currentIdentity = JSON.stringify([String(info.dev), String(info.ino), String(info.size),
        String(info.mtimeNs), String(info.ctimeNs)]);
      if (currentIdentity !== snapshot.identity) return false;
    }
  }
  return true;
}

export async function resolvedKeepExistingTracks(
  identity: Identity,
  assignments: readonly TvMatchingAssignment[],
  conflicts: readonly TvEpisodeConflict[],
  verifyContents = true
): Promise<Set<string>> {
  const resolved = new Set<string>();
  for (const assignment of assignments) {
    if (await isKeepExistingValid(identity, assignment, conflicts.filter((conflict) =>
      conflict.trackId === assignment.trackId), verifyContents)) resolved.add(assignment.trackId);
  }
  return resolved;
}
