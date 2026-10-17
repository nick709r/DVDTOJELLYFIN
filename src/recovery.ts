import { readdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getSettings, interruptedOutputs, recoverPublishedJob } from "./db.js";
import { mediaDuration } from "./encoding.js";
import { log } from "./logger.js";

const uuidDirectory = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const partialOutput = new RegExp(`^\\.autodisc-${uuid}\\.(mp4|mkv)$`, "i");
const partialAlbumDirectory = new RegExp(`^\\.autodisc-${uuid}$`, "i");

export async function recoverTemporaryFiles(): Promise<void> {
  const settings = getSettings();
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
  let recoveredJobs = 0;
  for (const job of interruptedOutputs()) {
    const isMovieOutput = dirname(resolve(job.outputPath)) === resolve(settings.moviesDir);
    const isMusicOutput = job.mediaType === "audio_cd" && dirname(resolve(job.outputPath)) === resolve(settings.musicDir);
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
        recoverPublishedJob(job.id, outputBytes);
      } else {
        if (!info.isFile() || info.size < 1024) continue;
        await mediaDuration(job.outputPath);
        recoverPublishedJob(job.id, info.size);
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
