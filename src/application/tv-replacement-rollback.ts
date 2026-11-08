import { copyToQuarantine, verifyRetainedFile } from "./tv-replacement-quarantine.js";

type FileEvidence = { checksum: string; size: bigint };
type RollbackCheckpoint =
  | "quarantine-verified"
  | "copy-created"
  | "copy-copied"
  | "copy-file-synced"
  | "copy-verified"
  | "copy-directory-synced"
  | "restored";

export async function restoreQuarantinedFile(
  originalPath: string,
  quarantinePath: string,
  evidence: FileEvidence,
  checkpoint?: (step: RollbackCheckpoint) => void
): Promise<void> {
  await verifyRetainedFile(quarantinePath, evidence);
  checkpoint?.("quarantine-verified");

  try {
    const restored = await copyToQuarantine(quarantinePath, originalPath, (step) => checkpoint?.(`copy-${step}`));
    if (restored.checksum !== evidence.checksum || restored.size !== evidence.size) {
      throw new Error("Restored file does not match quarantine evidence; all files have been retained");
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }

  await verifyRetainedFile(originalPath, evidence);
  await verifyRetainedFile(quarantinePath, evidence);
  checkpoint?.("restored");
}
