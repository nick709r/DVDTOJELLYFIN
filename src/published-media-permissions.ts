import { chmod, chown, lstat, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

interface PublishedEntry {
  path: string;
  info: Awaited<ReturnType<typeof lstat>>;
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function collectEntries(path: string, entries: PublishedEntry[], recursive: boolean): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    throw new Error(`Published output contains a symbolic link and was not permission-adjusted: ${path}`);
  }
  if (info.isDirectory() && recursive) {
    for (const name of await readdir(path)) {
      await collectEntries(resolve(path, name), entries, recursive);
    }
  } else if (!info.isDirectory() && !info.isFile()) {
    throw new Error(`Published output contains an unsupported filesystem entry: ${path}`);
  }
  entries.push({ path, info });
}

export async function applyPublishedPermissions(
  targetPath: string,
  libraryRoot: string,
  recursive = true
): Promise<void> {
  const root = resolve(libraryRoot);
  const target = resolve(targetPath);
  const rootRealPath = await realpath(root);
  const targetRealPath = await realpath(target);
  if (!isWithin(rootRealPath, targetRealPath)) {
    throw new Error(`Published output must be inside its destination library: ${targetPath}`);
  }
  const rootInfo = await stat(rootRealPath);
  if (!rootInfo.isDirectory()) throw new Error(`Destination library is not a directory: ${libraryRoot}`);

  const entries: PublishedEntry[] = [];
  await collectEntries(target, entries, recursive);
  const targetGroup = rootInfo.gid;
  const isWindows = process.platform === "win32";
  if (!isWindows) {
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const gid = typeof process.getgid === "function" ? process.getgid() : undefined;
    const groups = typeof process.getgroups === "function" ? process.getgroups() : [];
    if (uid !== 0 && (gid === undefined || (targetGroup !== gid && !groups.includes(targetGroup)))) {
      throw new Error(
        `AutoDisc is not a member of destination library group ${targetGroup}; add the service account to that group and restart the service.`
      );
    }
  }

  for (const entry of entries) {
    const current = await lstat(entry.path);
    if (current.isSymbolicLink() || current.dev !== entry.info.dev || current.ino !== entry.info.ino) {
      throw new Error(`Published output changed while permissions were being applied: ${entry.path}`);
    }
    if (!isWindows && current.gid !== targetGroup) {
      await chown(entry.path, current.uid, targetGroup);
    }
    const currentMode = current.mode & 0o7777;
    const requiredMode = current.isDirectory()
      ? (currentMode & 0o2000 ? 0o2775 : 0o775)
      : 0o664;
    if (currentMode !== requiredMode) {
      await chmod(entry.path, requiredMode);
    }
  }
}
