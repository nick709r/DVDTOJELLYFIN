import { access, mkdir, readdir, rename, rm, stat, statfs } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { JobCoordinator } from "./application/job-coordinator.js";
import type { AudioDisc } from "./audio-cd.js";
import type { AudioTrackFile } from "./audio-cd.js";
import type { MusicAlbumMetadata } from "./music-metadata.js";
import { events } from "./events.js";
import { log } from "./logger.js";
import type { MetadataResolver } from "./application/metadata-resolver.js";
import { isMusicAlbumMetadata } from "./providers/metadata/musicbrainz.js";
import { waitForManualMusicMetadata } from "./manual-music-metadata.js";
import { importAlbumToLidarr } from "./lidarr.js";
import { runProcess } from "./process.js";
import { ejectDisc, safeTitle } from "./media.js";
import { setRuntimeStatus } from "./runtime-status.js";

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
  acquireTracks: (workspacePath: string, signal?: AbortSignal) => Promise<AudioTrackFile[]>,
  signal: AbortSignal | undefined,
  metadataResolver: MetadataResolver | undefined,
  jobs: JobCoordinator
): Promise<boolean> {
  if (jobs.activeJob()) return true;
  if (jobs.lastDiscFingerprint() === disc.fingerprint) {
    log("info", "audio-cd", "Already-processed audio CD is still inserted; ignoring duplicate detection event");
    setRuntimeStatus("completed");
    return true;
  }

  const settings = jobs.getSettings();
  const id = randomUUID();
  const workDir = join(settings.workDir, id);
  const outputDir = settings.lidarrEnabled ? settings.lidarrImportDir : settings.musicDir;
  const stagingDir = join(outputDir, `.autodisc-${id}`);
  let successful = false;
  let failure: string | null = null;
  let finalPath: string | null = null;
  let conversionStartedAt: number | undefined;
  const context = jobs.begin(id, disc.discId ? `Audio CD ${disc.discId}` : "Audio CD", "audio_cd", disc.fingerprint, signal);

  try {
    events.emit("status");
    await assertWritableDirectory(settings.workDir, minimumWorkBytes);
    await assertWritableDirectory(outputDir, minimumMusicBytes);
    await mkdir(workDir, { recursive: true, mode: 0o750 });
    await mkdir(stagingDir, { mode: 0o750 });

    jobs.step(context, { id: "acquire-source", status: "ripping", message: "Extracting audio tracks with the registered source provider" });
    events.emit("status");
    const audioTracks = await acquireTracks(workDir, signal);
    const detected = disc.trackNumbers.join(",");
    const ripped = audioTracks.map((track) => track.number).join(",");
    if (detected !== ripped) {
      throw new Error(`Audio extraction returned tracks [${ripped}], expected [${detected}]`);
    }

    const metadataResult = metadataResolver
      ? await metadataResolver.resolve({
        entityType: "album",
        identifiers: {
          ...(disc.discId ? { musicBrainzDiscId: disc.discId } : {}),
          fingerprint: disc.fingerprint
        },
        attributes: { trackNumbers: disc.trackNumbers }
      }, signal)
      : undefined;
    let metadata: MusicAlbumMetadata = metadataResult?.selected && isMusicAlbumMetadata(metadataResult.selected.metadata)
      ? metadataResult.selected.metadata
      : {
        artist: "Unknown Artist",
        album: `Audio CD ${new Date().toISOString().slice(0, 10)}`,
        year: null,
        tracks: disc.trackNumbers.map((number) => ({ number, title: `Track ${String(number).padStart(2, "0")}` })),
        source: "offline" as const
      };
    if (signal?.aborted) throw new Error("Audio CD processing cancelled");
    if (settings.musicMetadataEnabled && metadata.source === "offline") {
      jobs.step(context, { id: "resolve-metadata", status: "ripping", message: "Waiting for manual metadata in the dashboard" });
      events.emit("status");
      jobs.record(context, "metadata", "warn", "Automatic metadata matching failed; waiting for manual album and track metadata");
      metadata = await waitForManualMusicMetadata(id, disc, signal);
      jobs.record(context, "metadata", "info", `Music details supplied ${metadata.source === "musicbrainz" ? "from a metadata provider" : "manually"}`);
    }
    const albumFolder = safeTitle(`${metadata.artist} - ${metadata.album}${metadata.year ? ` (${metadata.year})` : ""}`);
    const albumTitle = metadata.album;
    jobs.update(context, { title: albumTitle });
    jobs.record(context, "metadata", "info", `Music details from ${metadata.source}`);

    jobs.step(context, { id: "convert-media", status: "converting", message: `Encoding ${audioTracks.length} tracks as FLAC` });
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
      jobs.update(context, { progress: Math.min(99, Math.round(((index + 1) / audioTracks.length) * 99)) });
      events.emit("status");
    }
    jobs.update(context, { conversionSeconds: (Date.now() - conversionStartedAt) / 1000 });
    await rm(workDir, { recursive: true, force: true });

    jobs.step(context, { id: "publish-media", status: "publishing", message: settings.lidarrEnabled
      ? "Preparing named tracks for Lidarr library import"
      : "Publishing the complete album to Jellyfin Music" });
    events.emit("status");
    if (signal?.aborted) throw new Error("Audio CD processing cancelled");
    finalPath = await uniqueAlbumPath(outputDir, albumFolder);
    jobs.update(context, { outputPath: finalPath, outputBytes, encoder: "FLAC lossless", progress: settings.lidarrEnabled ? 99 : 100 });
    await rename(stagingDir, finalPath);
    if (settings.lidarrEnabled) {
      jobs.step(context, { id: "library-import", status: "publishing", message: "Sending named and tagged tracks to Lidarr for categorization" });
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
      if (result.albumPath) jobs.update(context, { outputPath: result.albumPath });
      jobs.record(context, "library-import", "info", `Library provider imported and categorized ${result.imported} named FLAC tracks`);
    }
    successful = true;
  } catch (error) {
    failure = error instanceof Error ? error.message : "Unknown audio CD processing failure";
    if (settings.lidarrEnabled && finalPath) {
      failure += `; check Lidarr and the staged album at ${finalPath} before retrying to avoid a duplicate import`;
    }
    if (conversionStartedAt !== undefined) {
      jobs.update(context, { conversionSeconds: (Date.now() - conversionStartedAt) / 1000 });
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
    jobs.complete(context, disc.fingerprint);
    setRuntimeStatus("completed");
    if (settings.autoEject) {
      try {
        await ejectDisc(device);
        jobs.record(context, "eject", "info", "Disc ejected");
      } catch (error) {
        const message = `Eject failed: ${error instanceof Error ? error.message : "unknown error"}`;
        jobs.warn(context, message);
        log("warn", "eject", message, { jobId: id });
      }
    }
  } else {
    const cancelled = jobs.wasJobCancelled(context);
    const interrupted = Boolean(signal?.aborted && !cancelled);
    jobs.fail(context, cancelled ? "cancelled" : interrupted ? "interrupted" : "failed", {
      code: cancelled ? "cancelled" : interrupted ? "interrupted" : "audio_processing_failed",
      message: cancelled ? `Cancelled by user${failure ? `; ${failure}` : ""}` : failure ?? "Audio CD processing failed",
      recoverable: interrupted
    });
    setRuntimeStatus(cancelled || interrupted ? "idle" : "failed");
  }
  events.emit("status");
  return true;
}
