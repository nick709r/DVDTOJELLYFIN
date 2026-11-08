import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { TvReplacementFileEvidence } from "../domain/tv-conflict-journal.js";

type FileIdentity = {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};

function sameIdentity(first: FileIdentity, second: FileIdentity): boolean {
  return first.dev === second.dev && first.ino === second.ino && first.size === second.size &&
    first.mtimeNs === second.mtimeNs && first.ctimeNs === second.ctimeNs;
}

async function checksum(file: FileHandle): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  for (;;) {
    const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) return hash.digest("hex");
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
}

export async function inspectRetainedFile(path: string): Promise<TvReplacementFileEvidence> {
  if (process.platform !== "linux") {
    throw new Error("Replacement verification requires supported Linux filesystem durability");
  }
  if (!isAbsolute(path)) throw new Error("Replacement file path must be absolute");
  const directoryPath = resolve(dirname(path));
  if (await realpath(directoryPath) !== directoryPath) {
    throw new Error("Replacement path must not traverse symbolic links");
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size === 0n) {
      throw new Error("Replacement source must be a nonempty regular file without additional hard links");
    }
    const digest = await checksum(file);
    await file.sync();
    const directory = await open(directoryPath, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    if (!sameIdentity(before, await file.stat({ bigint: true })) ||
      !sameIdentity(before, await lstat(path, { bigint: true })) ||
      await realpath(directoryPath) !== directoryPath) {
      throw new Error("Replacement file changed during verification; all files have been retained");
    }
    return {
      checksum: digest, size: before.size.toString(), device: before.dev.toString(),
      inode: before.ino.toString(), modifiedNs: before.mtimeNs.toString(), changedNs: before.ctimeNs.toString()
    };
  } finally {
    await file.close();
  }
}

export async function verifyRetainedFile(
  path: string,
  expected: { checksum: string; size: bigint }
): Promise<void> {
  if (process.platform !== "linux") {
    throw new Error("Replacement verification requires supported Linux filesystem durability");
  }
  if (!isAbsolute(path) || !/^[a-f0-9]{64}$/.test(expected.checksum) || expected.size < 0n) {
    throw new Error("Replacement file verification requires an absolute path, checksum and size");
  }
  const directoryPath = resolve(dirname(path));
  if (await realpath(directoryPath) !== directoryPath) {
    throw new Error("Replacement path must not traverse symbolic links");
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size !== expected.size ||
      await checksum(file) !== expected.checksum ||
      !sameIdentity(before, await file.stat({ bigint: true })) ||
      !sameIdentity(before, await lstat(path, { bigint: true }))) {
      throw new Error("Replacement file verification failed; all files have been retained");
    }
    await file.sync();
    const directory = await open(directoryPath, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    if (!sameIdentity(before, await file.stat({ bigint: true })) ||
      !sameIdentity(before, await lstat(path, { bigint: true })) ||
      await realpath(directoryPath) !== directoryPath) {
      throw new Error("Replacement file changed during verification; all files have been retained");
    }
  } finally {
    await file.close();
  }
}

export async function copyToQuarantine(
  originalPath: string,
  quarantinePath: string,
  checkpoint?: (step: "created" | "copied" | "file-synced" | "verified" | "directory-synced") => void
): Promise<{ checksum: string; size: bigint }> {
  if (process.platform !== "linux") {
    throw new Error("Replacement quarantine requires supported Linux filesystem durability");
  }
  if (!isAbsolute(originalPath) || !isAbsolute(quarantinePath) ||
    resolve(originalPath) === resolve(quarantinePath)) {
    throw new Error("Quarantine requires distinct absolute paths");
  }
  const originalDir = resolve(dirname(originalPath));
  const quarantineDir = resolve(dirname(quarantinePath));
  if (await realpath(originalDir) !== originalDir || await realpath(quarantineDir) !== quarantineDir) {
    throw new Error("Quarantine paths must not traverse symbolic links");
  }
  const original = await open(originalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await original.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n) {
      throw new Error("Quarantine source must be a regular file without additional hard links");
    }
    const copy = await open(
      quarantinePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600
    );
    try {
      checkpoint?.("created");
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      const hash = createHash("sha256");
      let position = 0;
      for (;;) {
        const { bytesRead } = await original.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        let written = 0;
        while (written < bytesRead) {
          const result = await copy.write(buffer, written, bytesRead - written, position + written);
          if (result.bytesWritten === 0) throw new Error("Quarantine copy made no progress");
          written += result.bytesWritten;
        }
        position += bytesRead;
      }
      const digest = hash.digest("hex");
      checkpoint?.("copied");
      await copy.sync();
      checkpoint?.("file-synced");
      const copied = await copy.stat({ bigint: true });
      if (copied.size !== before.size || !sameIdentity(before, await original.stat({ bigint: true })) ||
        digest !== await checksum(copy) || digest !== await checksum(original) ||
        !sameIdentity(before, await original.stat({ bigint: true })) ||
        !sameIdentity(before, await lstat(originalPath, { bigint: true })) ||
        !sameIdentity(copied, await lstat(quarantinePath, { bigint: true }))) {
        throw new Error("Quarantine verification failed; original and copy have been retained");
      }
      checkpoint?.("verified");
      const directory = await open(quarantineDir, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      checkpoint?.("directory-synced");
      if (!sameIdentity(before, await original.stat({ bigint: true })) ||
        !sameIdentity(before, await lstat(originalPath, { bigint: true })) ||
        !sameIdentity(copied, await copy.stat({ bigint: true })) ||
        !sameIdentity(copied, await lstat(quarantinePath, { bigint: true })) ||
        await realpath(originalDir) !== originalDir || await realpath(quarantineDir) !== quarantineDir) {
        throw new Error("Quarantine paths or files changed during verification; all files have been retained");
      }
      return { checksum: digest, size: before.size };
    } finally {
      await copy.close();
    }
  } finally {
    await original.close();
  }
}
