import { access, mkdir, rm, rmdir, stat, statfs } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { activeJob, addEvent, addJob, addJobWarning, finishJob, getSettings, lastDiscFingerprint, setJobStatus, updateJob } from "./db.js";
import { events, notifyStatus } from "./events.js";
import { convert } from "./encoding.js";
import { ejectDisc, inspectDisc, ripTitle, safeTitle } from "./media.js";
import { resolveTitle } from "./title.js";
import { setRuntimeStatus } from "./runtime-status.js";
import { log } from "./logger.js";
import { inspectAudioCd } from "./audio-cd.js";
import { processAudioCd } from "./music-pipeline.js";
import { createMovieOutput } from "./movie-output.js";

const minimumWorkBytes = 8 * 1024 ** 3;
const minimumOutputBytes = 1024 ** 3;

async function assertWritableDirectory(path: string, reserveBytes: number): Promise<void> {
  await mkdir(path, { recursive: true });
  await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
  const space = await statfs(path);
  const available = Number(space.bavail) * Number(space.bsize);
  if (!Number.isFinite(available) || available < reserveBytes) {
    throw new Error(`Insufficient free space at ${path}; at least ${Math.ceil(reserveBytes / 1024 ** 3)} GiB is required`);
  }
}

export async function processInsertedDisc(signal?: AbortSignal): Promise<boolean> {
  if (activeJob()) return true;
  const settings = getSettings();
  const devicePath = settings.opticalDevice;
  const audioDisc = await inspectAudioCd(devicePath, signal);
  if (audioDisc) return processAudioCd(devicePath, audioDisc, signal);
  const makemkvDevice = `dev:${devicePath}`;
  let info;
  try {
    info = await inspectDisc(makemkvDevice, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    log("info", "disc", "No readable video disc detected", {
      error: error instanceof Error ? error.message : "MakeMKV inspection failed"
    });
    return false;
  }
  const selectedTitle = info.titles.sort((left, right) => right.durationSeconds - left.durationSeconds)[0];
  if (!selectedTitle) {
    log("info", "disc", "Ignoring media with no video titles");
    return true;
  }
  const fingerprint = createHash("sha256").update(JSON.stringify({
    label: info.label.trim().normalize("NFKC").toLocaleLowerCase(),
    titles: info.titles.map((title) => [title.id, title.durationSeconds, title.name.trim().normalize("NFKC")])
  })).digest("hex");
  if (lastDiscFingerprint() === fingerprint) {
    log("info", "disc", "Already-processed disc is still inserted; ignoring duplicate detection event");
    setRuntimeStatus("completed");
    return true;
  }

  const id = randomUUID();
  const workDir = join(settings.workDir, id);
  let finalPath: string | null = null;
  let movieDirectory: string | null = null;
  let successful = false;
  let failure: string | null = null;
  let conversionStartedAt: number | undefined;
  try {
    addJob(id, info.label || null, fingerprint);
    notifyStatus();
    await assertWritableDirectory(settings.workDir, minimumWorkBytes);
    await assertWritableDirectory(settings.moviesDir, minimumOutputBytes);
    await mkdir(workDir, { recursive: true, mode: 0o750 });

    setJobStatus(id, "ripping", "Ripping the longest detected video title with MakeMKV");
    notifyStatus();
    const input = await ripTitle(makemkvDevice, selectedTitle.id, workDir, signal);

    const title = await resolveTitle(info.label || selectedTitle.name, settings, signal);
    const cleanTitle = safeTitle(title.title);
    updateJob(id, { title: cleanTitle });
    addEvent(id, "title", "info", `Title selected from ${title.source}`);

    setJobStatus(id, "converting", "Converting with FFmpeg");
    notifyStatus();
    const movieOutput = await createMovieOutput(settings.moviesDir, cleanTitle, settings.format);
    movieDirectory = movieOutput.directory;
    const targetPath = movieOutput.path;
    finalPath = targetPath;
    conversionStartedAt = Date.now();
    const conversionStart = conversionStartedAt;
    const encoded = await convert(input, targetPath, cleanTitle, settings, (encoder) => {
      setJobStatus(id, "publishing", "Validating and atomically publishing the completed movie");
      updateJob(id, {
        outputPath: targetPath,
        encoder: encoder.name,
        conversionSeconds: (Date.now() - conversionStart) / 1000
      });
      notifyStatus();
    }, (progress) => {
      updateJob(id, { progress: Math.min(99, Math.round(progress * 100)) });
      events.emit("status");
    }, signal);

    updateJob(id, { conversionSeconds: (Date.now() - conversionStartedAt) / 1000 });
    const outputStat = await stat(targetPath);
    if (outputStat.size < 1024) throw new Error("Published movie failed size validation");
    updateJob(id, {
      outputPath: targetPath,
      outputBytes: encoded.outputBytes,
      encoder: encoded.encoder.name,
      progress: 100
    });
    successful = true;
  } catch (error) {
    failure = error instanceof Error ? error.message : "Unknown processing failure";
    if (conversionStartedAt !== undefined) {
      updateJob(id, { conversionSeconds: (Date.now() - conversionStartedAt) / 1000 });
    }
  } finally {
    if (!successful && finalPath && movieDirectory) {
      try {
        await stat(finalPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          try {
            await rmdir(movieDirectory);
          } catch (cleanupError) {
            const code = (cleanupError as NodeJS.ErrnoException).code;
            if (code !== "ENOENT" && code !== "ENOTEMPTY") {
              failure = `${failure ? `${failure}; ` : ""}Empty movie-folder cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : "unknown error"}`;
              successful = false;
            }
          }
        } else {
          failure = `${failure ? `${failure}; ` : ""}Could not verify failed movie output before cleanup: ${error instanceof Error ? error.message : "unknown error"}`;
          successful = false;
        }
      }
    }
    if (workDir) {
      try {
        await rm(workDir, { recursive: true, force: true });
      } catch (error) {
        const cleanupFailure = `Temporary-file cleanup failed: ${error instanceof Error ? error.message : "unknown error"}`;
        failure = failure ? `${failure}; ${cleanupFailure}` : cleanupFailure;
        successful = false;
      }
    }
  }

  if (successful) {
    finishJob(id, "completed", null, fingerprint);
    setRuntimeStatus("completed");
    if (settings.autoEject) {
      try {
        await ejectDisc(devicePath);
        addEvent(id, "eject", "info", "Disc ejected");
      } catch (error) {
        const message = `Eject failed: ${error instanceof Error ? error.message : "unknown error"}`;
        addJobWarning(id, message);
        log("warn", "eject", message, { jobId: id });
      }
    }
  } else {
    finishJob(id, signal?.aborted ? "interrupted" : "failed", failure ?? "Processing failed");
    if (!signal?.aborted) setRuntimeStatus("failed");
  }
  notifyStatus();
  return true;
}
