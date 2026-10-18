import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";

export async function executableAvailable(
  command: string,
  pathValue = process.env.PATH ?? ""
): Promise<boolean> {
  const candidates = command.includes("/") || isAbsolute(command)
    ? [resolve(command)]
    : pathValue.split(delimiter).filter(Boolean).map((directory) => join(directory, command));

  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      await access(candidate, constants.X_OK);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM") continue;
      throw error;
    }
  }
  return false;
}
