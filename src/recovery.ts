import { readdir, rmdir, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AutoDiscRepositories } from "./contracts/repositories.js";
import { mediaDuration } from "./encoding.js";
import { log } from "./logger.js";

const uuidDirectory = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const partialOutput = new RegExp(`^\\.autodisc-${uuid}\\.(mp4|mkv)$`, "i");
const partialAlbumDirectory = new RegExp(`^\\.autodisc-${uuid}$`, "i");

function isWithin(directory: string, path: string): boolean {
  const relativePath = relative(resolve(directory), resolve(path));
  return relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

export async function recoverTemporaryFiles(repositories: AutoDiscRepositories): Promise<void> {
  const settings = repositories.settings.get();
  let removedWorkdirs = 0;
  let removedOutputs = 0;
  const workEntries = await readdir(settings.workDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of workEntries) {
    if (entry.isDirectory() && uuidDirectory.test(entry.name)) {
      await rm(join(settings.workDir, entry.name), { recursive: true, force: true });
      removedWorkdirs += 1;
    }
  }
  const outputEntries = await readdir(settings.moviesDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of outputEntries) {
    if (entry.isFile() && partialOutput.test(entry.name)) {
      await rm(join(settings.moviesDir, entry.name), { force: true });
      removedOutputs += 1;
    } else if (entry.isDirectory()) {
      const movieDirectory = join(settings.moviesDir, entry.name);
      const children = await readdir(movieDirectory, { withFileTypes: true });
      let removedPartial = false;
      for (const child of children) {
        if (child.isFile() && partialOutput.test(child.name)) {
          await rm(join(movieDirectory, child.name), { force: true });
          removedOutputs += 1;
          removedPartial = true;
        }
      }
      if (removedPartial) {
        try {
          await rmdir(movieDirectory);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOTEMPTY" && code !== "ENOENT") throw error;
        }
      }
    }
  }
  const musicEntries = await readdir(settings.musicDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of musicEntries) {
    if (entry.isDirectory() && partialAlbumDirectory.test(entry.name)) {
      await rm(join(settings.musicDir, entry.name), { recursive: true, force: true });
      removedOutputs += 1;
    }
  }
  if (resolve(settings.lidarrImportDir) !== resolve(settings.musicDir)) {
    const importEntries = await readdir(settings.lidarrImportDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of importEntries) {
      if (entry.isDirectory() && partialAlbumDirectory.test(entry.name)) {
        await rm(join(settings.lidarrImportDir, entry.name), { recursive: true, force: true });
        removedOutputs += 1;
      }
    }
  }
  let recoveredJobs = 0;
  for (const job of repositories.recovery.interruptedOutputs()) {
    const isMovieOutput = job.mediaType === "dvd" && isWithin(settings.moviesDir, job.outputPath);
    const isMusicOutput = job.mediaType === "audio_cd" && isWithin(settings.musicDir, job.outputPath);
    if (!isMovieOutput && !isMusicOutput) continue;
    try {
      const info = await stat(job.outputPath);
      if (isMusicOutput) {
        if (!info.isDirectory()) continue;
        const tracks = await readdir(job.outputPath, { withFileTypes: true });
        const audioFiles = tracks.filter((track) => track.isFile() && track.name.toLowerCase().endsWith(".flac"));
        if (audioFiles.length === 0) continue;
        let outputBytes = 0;
        for (const track of audioFiles) {
          const path = join(job.outputPath, track.name);
          const trackInfo = await stat(path);
          if (trackInfo.size < 1024) throw new Error(`Recovered audio track is too small: ${track.name}`);
          await mediaDuration(path);
          outputBytes += trackInfo.size;
        }
        repositories.recovery.recoverPublished(job.id, outputBytes);
      } else {
        if (!info.isFile() || info.size < 1024) continue;
        await mediaDuration(job.outputPath);
        repositories.recovery.recoverPublished(job.id, info.size);
      }
      recoveredJobs += 1;
    } catch (error) {
      log("warn", "recovery", "Could not validate previously published output; leaving job interrupted", {
        jobId: job.id,
        error: error instanceof Error ? error.message : "unknown validation error"
      });
    }
  }
  if (removedWorkdirs || removedOutputs || recoveredJobs) {
    log("info", "recovery", "Removed abandoned AutoDisc temporary files", {
      workDirectories: removedWorkdirs,
      partialOutputs: removedOutputs,
      completedJobsRecovered: recoveredJobs
    });
  }
}
