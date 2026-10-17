import { readdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getSettings, interruptedOutputs, recoverPublishedJob } from "./db.js";
import { mediaDuration } from "./encoding.js";
import { log } from "./logger.js";

const uuidDirectory = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const partialOutput = /^\.autodisc-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(mp4|mkv)$/i;

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
  let recoveredJobs = 0;
  for (const job of interruptedOutputs()) {
    if (dirname(resolve(job.outputPath)) !== resolve(settings.moviesDir)) continue;
    try {
      const info = await stat(job.outputPath);
      if (info.size < 1024) continue;
      await mediaDuration(job.outputPath);
      recoverPublishedJob(job.id, info.size);
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
