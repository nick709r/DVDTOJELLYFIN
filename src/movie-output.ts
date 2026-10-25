import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { safeTitle } from "./media.js";

export interface MovieOutput {
  directory: string;
  path: string;
}

export async function createMovieOutput(
  directory: string,
  title: string,
  format: string,
  fileTitle = title
): Promise<MovieOutput> {
  const base = safeTitle(title);
  const fileBase = safeTitle(fileTitle);
  await mkdir(directory, { recursive: true, mode: 0o775 });
  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const name = suffix === 0 ? base : `${base} (${suffix + 1})`;
    const fileName = suffix === 0 ? fileBase : `${fileBase} (${suffix + 1})`;
    const movieDirectory = join(directory, name);
    try {
      await mkdir(movieDirectory, { mode: 0o775 });
      return { directory: movieDirectory, path: join(movieDirectory, `${fileName}.${format}`) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("Could not generate a unique movie folder");
}
