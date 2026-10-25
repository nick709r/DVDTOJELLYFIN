import { access, mkdir, readdir, rename, rm, stat, statfs } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { JobContext, JobCoordinator } from "./application/job-coordinator.js";
import type { AudioDisc } from "./audio-cd.js";
import type { AudioTrackFile } from "./audio-cd.js";
import type { DiscRecovery } from "./domain/disc-recovery.js";
import type { MusicAlbumMetadata } from "./music-metadata.js";
import { events } from "./events.js";
import { log } from "./logger.js";
import { outputTarget } from "./output-destinations.js";
import { getLiveDiscDiagnostics, updateDiscDiagnostics } from "./diagnostics.js";
import type { MetadataResolver } from "./application/metadata-resolver.js";
import { isMusicAlbumMetadata } from "./providers/metadata/musicbrainz.js";
import { waitForManualMusicMetadata } from "./manual-music-metadata.js";
import { importAlbumToLidarr } from "./lidarr.js";
import { runProcess } from "./process.js";
import { ejectDisc, safeTitle } from "./media.js";
import { setRuntimeStatus } from "./runtime-status.js";
import { libraryTemplate, metadataDocument, renderLibraryTemplate, writeMetadataBundle } from "./library-metadata.js";

const minimumWorkBytes = 2 * 1024 ** 3;
const minimumMusicBytes = 256 * 1024 ** 2;
const ffmpeg = process.env.FFMPEG_COMMAND ?? "ffmpeg";

interface AudioDestinationFailure {
  message: string;
  details: Readonly<Record<string, unknown>>;
}

async function createDestinationDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o755 });
  await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
  const info = await stat(path);
  if (!info.isDirectory()) throw new Error(`${path} exists but is not a directory`);
}

async function audioDestinationFailure(path: string, error: unknown): Promise<AudioDestinationFailure> {
  const fsError = error as NodeJS.ErrnoException;
  let parent: { mode: number; uid: number; gid: number } | undefined;
  try {
    const info = await stat(dirname(path));
    parent = { mode: info.mode & 0o777, uid: info.uid, gid: info.gid };
  } catch {
    parent = undefined;
  }
  const reason = error instanceof Error ? error.message : "Unknown destination directory error";
  const message = `Could not create or access destination folder ${path}: ${reason}`;
  return {
    message,
    details: {
      requestedPath: path,
      reason,
      errorCode: fsError.code,
      syscall: fsError.syscall,
      errorPath: fsError.path,
      parentDirectory: dirname(path),
      parentPermissions: parent ? {
        mode: `0${parent.mode.toString(8)}`,
        ownerUid: parent.uid,
        ownerGid: parent.gid
      } : "parent directory is missing or inaccessible",
      processUid: typeof process.getuid === "function" ? process.getuid() : null,
      processGid: typeof process.getgid === "function" ? process.getgid() : null
    }
  };
}

async function recordFolderCreationReview(
  jobs: JobCoordinator,
  context: JobContext,
  path: string,
  disc: AudioDisc,
  device: string,
  error: unknown,
  stage: "create" | "publish" = "create"
): Promise<AudioDestinationFailure> {
  const destinationFailure = await audioDestinationFailure(path, error);
  const failure = { ...destinationFailure, details: { ...destinationFailure.details, stage } };
  jobs.createReview({
    category: "folder_creation_failure",
    severity: "high",
    title: "Could not create the Music destination folder",
    description: failure.message,
    relatedJobId: context.id,
    relatedDisc: disc.discId ?? `Audio CD ${disc.fingerprint.slice(0, 12)}`,
    discFingerprint: disc.fingerprint,
    relatedDrive: device,
    requestedPath: path,
    errorDetails: failure.details,
    suggestedActions: [
      { type: "retry", label: "Retry folder creation and disc processing" },
      { type: "open-settings", label: "Open storage settings" },
      { type: "view-job", label: "View job logs" },
      { type: "resolve", label: "Mark resolved" }
    ]
  });
  return failure;
}

export async function ensureAudioAlbumFolders(
  jobs: JobCoordinator,
  context: JobContext,
  outputDir: string,
  artist: string,
  disc: AudioDisc,
  device: string,
  createDirectory = createDestinationDirectory
): Promise<string> {
  const artistDirectory = join(outputDir, safeTitle(artist));
  for (const path of [outputDir, artistDirectory]) {
    try {
      await createDirectory(path);
    } catch (error) {
      const failure = await recordFolderCreationReview(jobs, context, path, disc, device, error);
      throw Object.assign(new Error(failure.message), {
        code: "folder_creation_failed",
        reviewDetails: failure.details
      });
    }
  }
  return artistDirectory;
}

async function assertWritableDirectory(path: string, reserveBytes: number): Promise<void> {
  await mkdir(path, { recursive: true });
  await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
  const space = await statfs(path);
  const available = Number(space.bavail) * Number(space.bsize);
  if (!Number.isFinite(available) || available < reserveBytes) {
    throw new Error(`Insufficient free space at ${path}; at least ${Math.ceil(reserveBytes / 1024 ** 2)} MiB is required`);
  }
}

async function assertAvailableSpace(path: string, reserveBytes: number): Promise<void> {
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

export async function publishAudioAlbum(
  jobs: JobCoordinator,
  context: JobContext,
  stagingDir: string,
  artistDirectory: string,
  albumFolder: string,
  disc: AudioDisc,
  device: string,
  publish: typeof rename = rename
): Promise<string> {
  let finalPath = join(artistDirectory, albumFolder);
  try {
    finalPath = await uniqueAlbumPath(artistDirectory, albumFolder);
    await publish(stagingDir, finalPath);
  } catch (error) {
    const destinationFailure = await recordFolderCreationReview(jobs, context, finalPath, disc, device, error, "publish");
    throw Object.assign(new Error(destinationFailure.message), {
      code: "folder_creation_failed",
      reviewDetails: destinationFailure.details
    });
  }
  return finalPath;
}

export async function processAudioCd(
  device: string,
  disc: AudioDisc,
  acquireTracks: (workspacePath: string, signal?: AbortSignal) => Promise<AudioTrackFile[]>,
  signal: AbortSignal | undefined,
  metadataResolver: MetadataResolver | undefined,
  jobs: JobCoordinator,
  sourceProviderId = "source.audio-cd.cdparanoia",
  providersAttempted: readonly string[] = [sourceProviderId]
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
  const routeToLidarr = outputTarget(settings, "music") === "lidarr" && settings.lidarrEnabled;
  const outputDir = routeToLidarr ? settings.lidarrImportDir : settings.musicDir;
  const stagingDir = join(outputDir, `.autodisc-${id}`);
  let successful = false;
  let failure: string | null = null;
  let finalPath: string | null = null;
  let conversionStartedAt: number | undefined;
  let failureCode: string | undefined;
  let failureDetails: Readonly<Record<string, unknown>> | undefined;
  const context = jobs.begin(id, disc.discId ? `Audio CD ${disc.discId}` : "Audio CD", "audio_cd", disc.fingerprint, signal, device);
  let recovery: DiscRecovery;
  updateDiscDiagnostics({ status: "Audio CD identified", classification: "Audio", mediaType: "audio_cd" });
  jobs.record(context, "disc-detected", "info", JSON.stringify({
    driveId: device,
    devicePath: device,
    detectionMethod: getLiveDiscDiagnostics()?.detectionMethod ?? "udev event or optical-media presence monitor",
    detectedAt: getLiveDiscDiagnostics()?.detectedAt ?? new Date().toISOString(),
    discType: "audio_cd",
    label: disc.discId ? `Audio CD ${disc.discId}` : "Audio CD",
    fingerprint: disc.fingerprint,
    sourceProvider: sourceProviderId,
    providersAttempted,
    discId: disc.discId,
    trackCount: disc.trackNumbers.length,
    tracks: disc.trackNumbers.map((number) => ({ number, durationSeconds: null }))
  }));

  try {
    recovery = jobs.recordDiscDetection(disc.fingerprint, "cd", "music_album");
    const effectiveMediaType = recovery.mediaTypeOverridden ? recovery.finalMediaType : "music_album";
    if (effectiveMediaType !== "music_album") {
      const message = `The manual ${effectiveMediaType.replaceAll("_", " ")} classification does not match the audio CD workflow; publishing is held for review.`;
      jobs.record(context, "media-classification", "warn", JSON.stringify({
        detectedMediaType: recovery.detectedMediaType,
        finalMediaType: effectiveMediaType,
        mediaTypeOverridden: recovery.mediaTypeOverridden
      }));
      jobs.holdForReview(context, message, {
        detectedMediaType: recovery.detectedMediaType,
        finalMediaType: effectiveMediaType,
        mediaTypeOverridden: recovery.mediaTypeOverridden
      });
      setRuntimeStatus("idle");
      events.emit("status");
      return true;
    }
    events.emit("status");
    await assertWritableDirectory(settings.workDir, minimumWorkBytes);
    try {
      await createDestinationDirectory(outputDir);
    } catch (error) {
      const destinationFailure = await recordFolderCreationReview(jobs, context, outputDir, disc, device, error);
      failureCode = "folder_creation_failed";
      failureDetails = destinationFailure.details;
      throw Object.assign(new Error(destinationFailure.message), { code: failureCode });
    }
    await assertAvailableSpace(outputDir, minimumMusicBytes);
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

    const recoveredMetadata = isMusicAlbumMetadata(recovery.importedMetadata)
      ? recovery.importedMetadata
      : undefined;
    const metadataResult = !recoveredMetadata && metadataResolver
      ? await metadataResolver.resolve({
        entityType: "album",
        identifiers: {
          ...(disc.discId ? { musicBrainzDiscId: disc.discId } : {}),
          fingerprint: disc.fingerprint
        },
        attributes: { trackNumbers: disc.trackNumbers }
      }, signal)
      : undefined;
    if (metadataResult) jobs.record(context, "metadata-results", metadataResult.providerFailures.length ? "warn" : "info",
      JSON.stringify({
        entityType: "album",
        selected: metadataResult.selected ?? null,
        candidates: metadataResult.candidates,
        failures: metadataResult.providerFailures,
        durationMs: null,
        cacheUsage: "Not reported by the metadata provider interface"
      }));
    let metadata: MusicAlbumMetadata = recoveredMetadata ??
      (metadataResult?.selected && isMusicAlbumMetadata(metadataResult.selected.metadata)
      ? metadataResult.selected.metadata
      : {
        artist: "Unknown Artist",
        album: `Audio CD ${new Date().toISOString().slice(0, 10)}`,
        year: null,
        tracks: disc.trackNumbers.map((number) => ({ number, title: `Track ${String(number).padStart(2, "0")}` })),
        source: "offline" as const
      });
    if (recoveredMetadata) jobs.record(context, "metadata", "info", "Restored album metadata saved for this disc fingerprint");
    if (signal?.aborted) throw new Error("Audio CD processing cancelled");
    if (settings.musicMetadataEnabled && metadata.source === "offline") {
      jobs.step(context, { id: "resolve-metadata", status: "ripping", message: "Waiting for manual metadata in the dashboard" });
      events.emit("status");
      jobs.record(context, "metadata", "warn", "Automatic metadata matching failed; waiting for manual album and track metadata");
      jobs.createReview({
        category: "metadata_issue",
        severity: "medium",
        title: "Audio CD metadata needs attention",
        description: "MusicBrainz did not provide an unambiguous album and track match. Enter metadata in the dashboard to continue.",
        relatedJobId: id,
        relatedDisc: disc.discId ?? `Audio CD ${disc.fingerprint.slice(0, 12)}`,
        discFingerprint: disc.fingerprint,
        relatedDrive: device,
        errorDetails: { source: "musicbrainz", discId: disc.discId, trackNumbers: disc.trackNumbers },
        suggestedActions: [
          { type: "enter-metadata", label: "Enter album and track metadata" },
          { type: "view-job", label: "View job" },
          { type: "dismiss", label: "Dismiss" }
        ]
      });
      metadata = await waitForManualMusicMetadata(id, disc, signal);
      jobs.record(context, "metadata", "info", `Music details supplied ${metadata.source === "musicbrainz" ? "from a metadata provider" : "manually"}`);
    }
    if (metadata.source !== "offline") {
      const artworkReferences = metadata.releaseId ? [{
        kind: "album",
        url: `https://coverartarchive.org/release/${encodeURIComponent(metadata.releaseId)}/front-500`
      }] : [];
      jobs.updateDiscRecovery(disc.fingerprint, {
        metadataProvider: metadata.source === "musicbrainz" ? "musicbrainz" : "manual",
        providerId: metadata.releaseId ?? null,
        importedMetadata: {
          entityType: "album",
          artist: metadata.artist,
          album: metadata.album,
          year: metadata.year,
          tracks: metadata.tracks,
          source: metadata.source,
          ...(metadata.releaseId ? { releaseId: metadata.releaseId } : {})
        },
        artworkReferences
      });
    }
    const artistFolder = renderLibraryTemplate(libraryTemplate(settings.libraryMetadata, "artistFolderTemplate"), {
      Artist: metadata.artist
    });
    const albumFolder = renderLibraryTemplate(libraryTemplate(settings.libraryMetadata, "albumFolderTemplate"), {
      Album: metadata.album,
      Year: metadata.year
    });
    const artistDirectory = await ensureAudioAlbumFolders(
      jobs, context, outputDir, artistFolder, disc, device
    );
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

    jobs.step(context, { id: "publish-media", status: "publishing", message: routeToLidarr
      ? "Preparing named tracks for Lidarr library import"
      : "Publishing the complete album to Jellyfin Music" });
    events.emit("status");
    if (signal?.aborted) throw new Error("Audio CD processing cancelled");
    jobs.update(context, { outputBytes, encoder: "FLAC lossless", progress: routeToLidarr ? 99 : 100 });
    try {
      finalPath = await publishAudioAlbum(jobs, context, stagingDir, artistDirectory, albumFolder, disc, device);
      jobs.update(context, { outputPath: finalPath });
    } catch (error) {
      failureCode = "folder_creation_failed";
      if (error && typeof error === "object" && "reviewDetails" in error &&
        typeof error.reviewDetails === "object" && error.reviewDetails !== null) {
        failureDetails = error.reviewDetails as Readonly<Record<string, unknown>>;
      }
      throw error;
    }
    const writeMusicMetadata = async (albumDirectory: string, artistOutputDirectory: string): Promise<void> => {
      if (!settings.libraryMetadata.downloadMusicMetadata && !settings.libraryMetadata.generateNfo) return;
      const importedMetadata = settings.libraryMetadata.downloadMusicMetadata ? {
        artist: metadata.artist,
        album: metadata.album,
        year: metadata.year,
        tracks: metadata.tracks
      } : {};
      const document = metadataDocument(metadata.album, metadata.source, metadata.releaseId, importedMetadata);
      const assets = settings.libraryMetadata.automaticImport && settings.libraryMetadata.downloadMusicMetadata && metadata.releaseId
        ? [{ kind: "album" as const, url: `https://coverartarchive.org/release/${encodeURIComponent(metadata.releaseId)}/front-500` }]
        : [];
      await writeMetadataBundle(albumDirectory, "album", document, assets, settings.libraryMetadata, {
        nfoFileName: "album.nfo"
      });
      if (settings.libraryMetadata.downloadMusicMetadata || settings.libraryMetadata.generateNfo) {
        await writeMetadataBundle(artistOutputDirectory, "artist", {
          title: metadata.artist,
          artist: metadata.artist,
          provider: metadata.source
        }, [], settings.libraryMetadata, { nfoFileName: "artist.nfo" });
      }
    };
    if (routeToLidarr) {
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
      if (result.albumPath) {
        try {
          await writeMusicMetadata(result.albumPath, dirname(result.albumPath));
        } catch (error) {
          log("warn", "metadata", "Music album metadata or artwork could not be fully written after Lidarr import", {
            jobId: id,
            outputPath: result.albumPath,
            error: error instanceof Error ? error.message : "unknown metadata write failure"
          });
        }
      }
      jobs.record(context, "library-import", "info", `Library provider imported and categorized ${result.imported} named FLAC tracks`);
    } else {
      try {
        await writeMusicMetadata(finalPath, artistDirectory);
      } catch (error) {
        log("warn", "metadata", "Music album metadata or artwork could not be fully written", {
          jobId: id,
          outputPath: finalPath,
          error: error instanceof Error ? error.message : "unknown metadata write failure"
        });
      }
    }
    successful = true;
  } catch (error) {
    failure = error instanceof Error ? error.message : "Unknown audio CD processing failure";
    if (error && typeof error === "object" && "code" in error && error.code === "folder_creation_failed") {
      failureCode = "folder_creation_failed";
      if ("reviewDetails" in error && typeof error.reviewDetails === "object" && error.reviewDetails !== null) {
        failureDetails = error.reviewDetails as Readonly<Record<string, unknown>>;
      }
    }
    if (routeToLidarr && finalPath) {
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
    if (settings.autoEject || settings.automationMode === "full_auto") {
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
      code: cancelled ? "cancelled" : interrupted ? "interrupted" : failureCode ?? "audio_processing_failed",
      message: cancelled ? `Cancelled by user${failure ? `; ${failure}` : ""}` : failure ?? "Audio CD processing failed",
      recoverable: interrupted,
      ...(failureCode ? { reviewCategory: "folder_creation_failure" as const } : {}),
      ...(failureDetails ? { reviewDetails: failureDetails } : {})
    });
    setRuntimeStatus(cancelled || interrupted ? "idle" : "failed");
  }
  events.emit("status");
  return true;
}
