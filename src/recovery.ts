import { lstat, readdir, rmdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AutoDiscRepositories } from "./contracts/repositories.js";
import { mediaDuration } from "./encoding.js";
import { log } from "./logger.js";
import { outputPath } from "./output-destinations.js";

const uuidDirectory = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const partialOutput = new RegExp(`^\\.autodisc-(${uuid})\\.(mp4|mkv)$`, "i");
const partialAlbumDirectory = new RegExp(`^\\.autodisc-(${uuid})$`, "i");

function cleanableJob(status: string | undefined): boolean {
  return status !== undefined &&
    ["completed", "failed", "cancelled", "ignored", "deleted"].includes(status);
}

export async function recoverTemporaryFiles(repositories: AutoDiscRepositories): Promise<void> {
  const settings = repositories.settings.get();
  let removedWorkdirs = 0;
  let removedOutputs = 0;
  let recoveredJobs = 0;
  let failedJobs = 0;
  for (const job of repositories.recovery.interruptedJobs()) {
    try {
      if (!job.outputPath) throw new Error("No published output path was recorded");
      const info = await lstat(job.outputPath);
      if (info.isSymbolicLink()) throw new Error("Recorded output path is a symbolic link");
      if (job.mediaType === "audio_cd") {
        if (!info.isDirectory()) throw new Error("Recorded audio output is not a directory");
        const tracks = await readdir(job.outputPath, { withFileTypes: true });
        const audioFiles = tracks.filter((track) => track.isFile() && track.name.toLowerCase().endsWith(".flac"));
        if (audioFiles.length === 0) throw new Error("No audio tracks were found in the recorded output directory");
        let outputBytes = 0;
        for (const track of audioFiles) {
          const path = join(job.outputPath, track.name);
          const trackInfo = await lstat(path);
          if (trackInfo.isSymbolicLink()) throw new Error(`Recovered audio track is a symbolic link: ${track.name}`);
          if (trackInfo.size < 1024) throw new Error(`Recovered audio track is too small: ${track.name}`);
          await mediaDuration(path);
          outputBytes += trackInfo.size;
        }
        if (!repositories.recovery.recoverPublished(job.id, outputBytes)) continue;
      } else {
        if (!info.isFile() || info.size < 1024) throw new Error("Recorded media output is missing or too small");
        await mediaDuration(job.outputPath);
        if (!repositories.recovery.recoverPublished(job.id, info.size)) continue;
      }
      recoveredJobs += 1;
    } catch (error) {
      const reason = `Interrupted job recovery failed: ${error instanceof Error ? error.message : "unknown output validation error"}`;
      if (repositories.recovery.failInterrupted(job.id, reason)) failedJobs += 1;
      log("warn", "recovery", "Interrupted job was marked failed because output could not be reconciled", {
        jobId: job.id,
        error: error instanceof Error ? error.message : "unknown validation error"
      });
    }
  }
  const jobStates = new Map(repositories.recovery.jobStates().map((job) => [job.id, job.status]));
  const workEntries = await readdir(settings.workDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of workEntries) {
    if (entry.isDirectory() && uuidDirectory.test(entry.name) && cleanableJob(jobStates.get(entry.name))) {
      await rm(join(settings.workDir, entry.name), { recursive: true, force: true });
      removedWorkdirs += 1;
    }
  }
  const profileSettings = settings.outputDestinations.profiles.map((profile) => ({
    ...settings,
    outputDestinations: { ...settings.outputDestinations, activeProfileId: profile.id }
  }));
  const movieRoots = [...new Set([settings.moviesDir, ...profileSettings.map((profile) => outputPath(profile, "movies"))]
    .map((path) => resolve(path)))];
  const musicRoots = [...new Set([
    settings.musicDir,
    settings.lidarrImportDir,
    ...profileSettings.map((profile) => outputPath(profile, "music"))
  ].filter(Boolean).map((path) => resolve(path)))];
  for (const movieRoot of movieRoots) {
    const outputEntries = await readdir(movieRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of outputEntries) {
      const partialFile = entry.isFile() ? partialOutput.exec(entry.name) : null;
      if (partialFile?.[1] && cleanableJob(jobStates.get(partialFile[1]))) {
        await rm(join(movieRoot, entry.name), { force: true });
        removedOutputs += 1;
      } else if (entry.isDirectory()) {
        const movieDirectory = join(movieRoot, entry.name);
        const children = await readdir(movieDirectory, { withFileTypes: true });
        let removedPartial = false;
        for (const child of children) {
          const partialChild = child.isFile() ? partialOutput.exec(child.name) : null;
          if (partialChild?.[1] && cleanableJob(jobStates.get(partialChild[1]))) {
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
  }
  for (const musicRoot of musicRoots) {
    const musicEntries = await readdir(musicRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of musicEntries) {
      const partialAlbum = entry.isDirectory() ? partialAlbumDirectory.exec(entry.name) : null;
      if (partialAlbum?.[1] && cleanableJob(jobStates.get(partialAlbum[1]))) {
        await rm(join(musicRoot, entry.name), { recursive: true, force: true });
        removedOutputs += 1;
      }
    }
  }
  log("info", "recovery", "Startup filesystem and interrupted-job reconciliation completed", {
    orphanWorkDirectoriesRemoved: removedWorkdirs,
    partialOutputsRemoved: removedOutputs,
    publishedJobsRecovered: recoveredJobs,
    interruptedJobsFailed: failedJobs
  });
}
