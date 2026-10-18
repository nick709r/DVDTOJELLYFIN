import { access, mkdir, readdir, rename, rm, stat, statfs } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { activeJob, addEvent, addJob, addJobWarning, finishJob, getSettings, lastDiscFingerprint, setJobStatus, updateJob } from "./db.js";
import type { AudioDisc } from "./audio-cd.js";
import { ripAudioTracks } from "./audio-cd.js";
import { events } from "./events.js";
import { log } from "./logger.js";
import { resolveMusicMetadata } from "./music-metadata.js";
import { importAlbumToLidarr } from "./lidarr.js";
import { runProcess } from "./process.js";
import { ejectDisc, safeTitle } from "./media.js";
import { setRuntimeStatus } from "./runtime-status.js";
import { registerActiveJob, wasJobCancelled } from "./job-control.js";

const minimumWorkBytes = 2 * 1024 ** 3;
const minimumMusicBytes = 256 * 1024 ** 2;
const ffmpeg = process.env.FFMPEG_COMMAND ?? "ffmpeg";

async function assertWritableDirectory(path: string, reserveBytes: number): Promise<void> {
  await mkdir(path, { recursive: true });
  await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
  const space = await statfs(path);
  const available = Number(space.bavail) * Number(space.bsize);
  if (!Number.isFinite(available) || available < reserveBytes) {
    throw new Error(`Insufficient free space at ${path}; at least ${Math.ceil(reserveBytes / 1024 ** 2)} MiB is required`);
  }
}

async function uniqueAlbumPath(directory: string, name: string): Promise<string> {
  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const candidate = join(directory, suffix === 0 ? name : `${name} (${suffix + 1})`);
    try {
      await access(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return candidate;
      throw error;
    }
  }
  throw new Error("Could not generate a unique Music album folder");
}

export async function processAudioCd(
  device: string,
  disc: AudioDisc,
  signal?: AbortSignal
): Promise<boolean> {
  if (activeJob()) return true;
  if (lastDiscFingerprint() === disc.fingerprint) {
    log("info", "audio-cd", "Already-processed audio CD is still inserted; ignoring duplicate detection event");
    setRuntimeStatus("completed");
    return true;
  }

  const settings = getSettings();
  const id = randomUUID();
  const workDir = join(settings.workDir, id);
  const outputDir = settings.lidarrEnabled ? settings.lidarrImportDir : settings.musicDir;
  const stagingDir = join(outputDir, `.autodisc-${id}`);
  let successful = false;
  let failure: string | null = null;
  let finalPath: string | null = null;
  let conversionStartedAt: number | undefined;

  try {
    addJob(id, disc.discId ? `Audio CD ${disc.discId}` : "Audio CD", disc.fingerprint, "audio_cd");
    registerActiveJob(id);
    events.emit("status");
    await assertWritableDirectory(settings.workDir, minimumWorkBytes);
    await assertWritableDirectory(outputDir, minimumMusicBytes);
    await mkdir(workDir, { recursive: true, mode: 0o750 });
    await mkdir(stagingDir, { mode: 0o750 });

    setJobStatus(id, "ripping", "Extracting audio CD tracks with cdparanoia");
    events.emit("status");
    const audioTracks = await ripAudioTracks(device, workDir, signal);
    const detected = disc.trackNumbers.join(",");
    const ripped = audioTracks.map((track) => track.number).join(",");
    if (detected !== ripped) {
      throw new Error(`Audio extraction returned tracks [${ripped}], expected [${detected}]`);
    }

    const metadata = await resolveMusicMetadata(disc, settings.musicMetadataEnabled, signal);
    if (signal?.aborted) throw new Error("Audio CD processing cancelled");
    const albumFolder = safeTitle(`${metadata.artist} - ${metadata.album}${metadata.year ? ` (${metadata.year})` : ""}`);
    const albumTitle = metadata.album;
    updateJob(id, { title: albumTitle });
    addEvent(id, "metadata", "info", `Music details from ${metadata.source}`);

    setJobStatus(id, "converting", `Encoding ${audioTracks.length} tracks as FLAC`);
    events.emit("status");
    conversionStartedAt = Date.now();
    let outputBytes = 0;
    const outputTrackNames: string[] = [];
    for (let index = 0; index < audioTracks.length; index += 1) {
      if (signal?.aborted) throw new Error("Audio CD processing cancelled");
      const track = audioTracks[index];
      if (!track) continue;
      const trackMetadata = metadata.tracks.find((item) => item.number === track.number);
      const title = safeTitle(trackMetadata?.title ?? `Track ${String(track.number).padStart(2, "0")}`);
      const numberedTrack = String(track.number).padStart(2, "0");
      const fileName = `${numberedTrack} - ${title}.flac`;
      const partialPath = join(stagingDir, `.${numberedTrack}-${randomUUID()}.flac`);
      const outputPath = join(stagingDir, fileName);
      outputTrackNames.push(fileName);
      await runProcess(ffmpeg, [
        "-hide_banner", "-nostdin", "-v", "error", "-n",
        "-i", track.path, "-map", "0:a:0", "-vn",
        "-c:a", "flac", "-compression_level", "5",
        "-metadata", `title=${trackMetadata?.title ?? `Track ${numberedTrack}`}`,
        "-metadata", `artist=${metadata.artist}`,
        "-metadata", `album=${metadata.album}`,
        "-metadata", `album_artist=${metadata.artist}`,
        "-metadata", `track=${track.number}/${audioTracks.length}`,
        ...(metadata.year ? ["-metadata", `date=${metadata.year}`] : []),
        partialPath
      ], { timeoutMs: 60 * 60 * 1000, ...(signal ? { signal } : {}) });
      const outputStat = await stat(partialPath);
      if (outputStat.size < 1024) throw new Error(`Encoded audio track ${numberedTrack} failed size validation`);
      await rename(partialPath, outputPath);
      outputBytes += outputStat.size;
      updateJob(id, { progress: Math.min(99, Math.round(((index + 1) / audioTracks.length) * 99)) });
      events.emit("status");
    }
    updateJob(id, { conversionSeconds: (Date.now() - conversionStartedAt) / 1000 });
    await rm(workDir, { recursive: true, force: true });

    setJobStatus(id, "publishing", settings.lidarrEnabled
      ? "Preparing named tracks for Lidarr library import"
      : "Publishing the complete album to Jellyfin Music");
    events.emit("status");
    if (signal?.aborted) throw new Error("Audio CD processing cancelled");
    finalPath = await uniqueAlbumPath(outputDir, albumFolder);
    updateJob(id, { outputPath: finalPath, outputBytes, encoder: "FLAC lossless", progress: settings.lidarrEnabled ? 99 : 100 });
    await rename(stagingDir, finalPath);
    if (settings.lidarrEnabled) {
      setJobStatus(id, "publishing", "Sending named and tagged tracks to Lidarr for categorization");
      events.emit("status");
      const importPath = finalPath;
      const namedTrackPaths = outputTrackNames.map((name) => join(importPath, name));
      const result = await importAlbumToLidarr(
        { url: settings.lidarrUrl, apiKey: settings.lidarrApiKey },
        importPath,
        namedTrackPaths,
        signal
      );
      const remaining = await readdir(importPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      if (remaining.length > 0) {
        throw new Error(`Lidarr reported a successful import but left files in ${importPath}; they were retained for safety`);
      }
      await rm(importPath, { recursive: true, force: true });
      if (result.albumPath) updateJob(id, { outputPath: result.albumPath });
      addEvent(id, "lidarr", "info", `Lidarr imported and categorized ${result.imported} named FLAC tracks`);
    }
    successful = true;
  } catch (error) {
    failure = error instanceof Error ? error.message : "Unknown audio CD processing failure";
    if (settings.lidarrEnabled && finalPath) {
      failure += `; check Lidarr and the staged album at ${finalPath} before retrying to avoid a duplicate import`;
    }
    if (conversionStartedAt !== undefined) {
      updateJob(id, { conversionSeconds: (Date.now() - conversionStartedAt) / 1000 });
    }
  } finally {
    for (const path of [workDir, stagingDir]) {
      try {
        await rm(path, { recursive: true, force: true });
      } catch (error) {
        failure = `${failure ? `${failure}; ` : ""}Temporary-file cleanup failed: ${error instanceof Error ? error.message : "unknown error"}`;
        successful = false;
      }
    }
  }

  if (successful) {
    finishJob(id, "completed", null, disc.fingerprint);
    setRuntimeStatus("completed");
    if (settings.autoEject) {
      try {
        await ejectDisc(device);
        addEvent(id, "eject", "info", "Audio CD ejected");
      } catch (error) {
        const message = `Eject failed: ${error instanceof Error ? error.message : "unknown error"}`;
        addJobWarning(id, message);
        log("warn", "eject", message, { jobId: id });
      }
    }
  } else {
    const cancelled = wasJobCancelled(id);
    const interrupted = signal?.aborted && !cancelled;
    finishJob(
      id,
      cancelled ? "cancelled" : interrupted ? "interrupted" : "failed",
      cancelled ? `Cancelled by user${failure ? `; ${failure}` : ""}` : failure ?? "Audio CD processing failed"
    );
    setRuntimeStatus(cancelled || interrupted ? "idle" : "failed");
  }
  events.emit("status");
  return true;
}
