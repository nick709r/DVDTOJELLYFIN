import { access, copyFile, lstat, mkdir, readdir, realpath, rename, rm, rmdir, stat, statfs, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { MediaWorkflow, MediaWorkflowContext } from "../../application/media-workflow-registry.js";
import type { InspectedMediaSource } from "../../application/media-source-coordinator.js";
import type { MediaCandidate } from "../../domain/media.js";
import { fingerprintDisc } from "../../domain/disc-fingerprint.js";
import type { MediaSourceCoordinator } from "../../application/media-source-coordinator.js";
import type { DiscTitle } from "../../model.js";
import { events, notifyStatus } from "../../events.js";
import { getLiveDiscDiagnostics, updateDiscDiagnostics } from "../../diagnostics.js";
import { convert, inspectVideo } from "../../encoding.js";
import { ejectDisc, isGeneratedUnknownTitle, normalizeVolumeTitle, safeTitle, selectMainFeature } from "../../media.js";
import { setRuntimeStatus } from "../../runtime-status.js";
import { log } from "../../logger.js";
import { createMovieOutput } from "../../movie-output.js";
import { applyPublishedPermissions } from "../../published-media-permissions.js";
import { artworkAssets, artworkFromMetadata, downloadArtwork, libraryTemplate, metadataDocument, renderLibraryTemplate, writeMetadataBundle, writeNfo } from "../../library-metadata.js";
import {
  assessTvDisc,
  summarizeTvPlan,
  TvWorkflowService
} from "../../application/tv-workflow-service.js";
import type { ReviewJob } from "../../domain/review-jobs.js";
import type { ReviewResumeStage } from "../../domain/review-jobs.js";
import type { MetadataCandidate, MetadataResult } from "../../domain/metadata.js";
import type { ReviewWorkspaceService } from "../../application/review-workspace-service.js";
import type { JobContext, JobCoordinator } from "../../application/job-coordinator.js";
import type { DiscRecovery, EpisodeMapping } from "../../domain/disc-recovery.js";
import type { TvSavedIdentification } from "../../domain/tv-identification.js";
import { tvMatchingReviewStatus, type TvMatchingAssignment, type TvMatchingContinuationSource, type TvMatchingTask } from "../../domain/tv-matching.js";
import { outputPath } from "../../output-destinations.js";
import { pathsOverlap, tvStagingConflictMessage, tvStagingConflicts, tvStagingDirectory } from "../../storage-paths.js";
import { normalizeDiscName } from "../../application/tv-name-normalization.js";

const minimumWorkBytes = 8 * 1024 ** 3;
const minimumOutputBytes = 1024 ** 3;

type MovieNamingSource = "Metadata match" | "User review" | "Filesystem volume name" | "Fallback";

function movieCandidatesForReview(candidates: readonly MetadataCandidate[]): Record<string, unknown>[] {
  return candidates
    .filter((candidate) => typeof candidate.title === "string" && candidate.title.trim().length > 0)
    .map((candidate) => ({
      id: candidate.id,
      providerId: candidate.providerId,
      title: candidate.title,
      confidence: candidate.confidence,
      ...(typeof candidate.metadata.title === "string" ? { metadataTitle: candidate.metadata.title } : {}),
      ...(typeof candidate.metadata.year === "string" || typeof candidate.metadata.year === "number"
        ? { year: candidate.metadata.year }
        : {})
    }));
}

function pathIsWithin(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function evidenceNames(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function withNameEvidence(
  metadata: Readonly<Record<string, unknown>> | null | undefined,
  label: string,
  volumeName: string
): Record<string, unknown> {
  const knownLabels = new Set(evidenceNames(metadata?.knownLabels));
  const knownVolumeNames = new Set(evidenceNames(metadata?.knownVolumeNames));
  if (label.trim()) knownLabels.add(label.trim());
  if (volumeName.trim()) knownVolumeNames.add(volumeName.trim());
  return {
    ...(metadata ?? {}),
    knownLabels: [...knownLabels],
    knownVolumeNames: [...knownVolumeNames]
  };
}

function nameMatchesEvidence(value: string, evidence: unknown): boolean {
  const normalized = normalizeDiscName(value);
  return Boolean(normalized && evidenceNames(evidence).some((candidate) =>
    normalizeDiscName(candidate) === normalized));
}

async function moveFile(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    await unlink(source);
  }
}

function matchingAssignments(result: Awaited<ReturnType<TvWorkflowService["prepare"]>>): TvMatchingAssignment[] {
  if (!result) return [];
  const matches = new Map(result.matches.items.map((item) => [item.itemId, item]));
  return result.analysis.items.filter((item) => item.kind === "episode-candidate").map((item) => {
    const match = matches.get(item.itemId);
    const candidates: TvMatchingAssignment["episodeCandidates"][number][] = [
      ...(match?.alternatives.map((candidate) => ({
        episodes: candidate.episodes,
        confidence: candidate.confidence,
        assignmentMethod: "runtime-matching" as const,
        evidence: candidate.evidence
      })) ?? []),
      ...(match?.suggestedEpisodes.length ? [{
        episodes: match.suggestedEpisodes,
        confidence: match.confidence,
        ...(match.assignmentMethod === undefined ? {} : { assignmentMethod: match.assignmentMethod }),
        evidence: match.evidence
      }] : [])
    ];
    const byKey = new Map<string, TvMatchingAssignment["episodeCandidates"][number]>();
    for (const candidate of candidates) {
      const key = candidate.episodes.map((episode) =>
        `${episode.seriesId}:${episode.seasonNumber}:${episode.episodeNumber}`).join("|");
      if (key) byKey.set(key, candidate);
    }
    return {
      trackId: item.itemId,
      title: item.title ?? item.itemId,
      durationSeconds: item.durationSeconds ?? 0,
      episodeCandidates: [...byKey.values()].sort((left, right) => right.confidence - left.confidence)
    };
  });
}

function logTvContinuationState(
  jobs: JobCoordinator,
  jobId: string,
  requestedState: "ripping" | "converting" | "publishing",
  source: TvMatchingContinuationSource | undefined
): void {
  if (!source) return;
  log("info", "tv-matching", "TV Match Continue", {
    jobId,
    currentState: jobs.getJob(jobId)?.status ?? "missing",
    requestedState,
    source
  });
}

async function assertWritableDirectory(path: string, reserveBytes: number): Promise<void> {
  await mkdir(path, { recursive: true });
  await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
  const space = await statfs(path);
  const available = Number(space.bavail) * Number(space.bsize);
  if (!Number.isFinite(available) || available < reserveBytes) {
    throw new Error(`Insufficient free space at ${path}; at least ${Math.ceil(reserveBytes / 1024 ** 3)} GiB is required`);
  }
}

function episodeOutputName(
  seriesName: string,
  mapping: EpisodeMapping,
  template: string
  ): string {
    const episodes = [...mapping.episodes].sort((left, right) =>
      left.seasonNumber - right.seasonNumber || left.episodeNumber - right.episodeNumber);
    const first = episodes[0];
    if (!first || episodes.some((episode) => episode.seasonNumber !== first.seasonNumber)) {
      throw new Error(`Track ${mapping.trackId} must map to episodes from one season`);
    }
    const episodeNumbers = episodes.map((episode) => String(episode.episodeNumber).padStart(2, "0"));
    const title = episodes.map((episode) => episode.title?.trim()).find(Boolean);
    return renderLibraryTemplate(template, {
      "Series Name": seriesName,
      Season: first.seasonNumber,
      Episode: episodeNumbers.length === 1 ? first.episodeNumber : episodeNumbers.join("-"),
      "Episode Title": title ?? ""
    });
  }

async function processMappedTvEpisodes(
    workflow: Pick<MediaWorkflowContext, "jobs" | "signal" | "devicePath"> & {
        source: MediaCandidate;
        sourceProvider?: InspectedMediaSource;
        sources?: MediaSourceCoordinator;
    },
    job: JobContext,
    fingerprint: string,
    recovery: DiscRecovery,
    converter: typeof convert,
    ensureWritable: typeof assertWritableDirectory,
    stagedFiles?: Readonly<Record<string, string>>,
    beforeComplete?: () => Promise<void>,
    continuationSource?: TvMatchingContinuationSource
  ): Promise<void> {
    const { source, sources, jobs, signal, devicePath } = workflow;
    const settings = jobs.getSettings();
    const info = source;
    const mappingByTrack = new Map(recovery.mappings.map((mapping) => [mapping.trackId, mapping]));
    const titleItems = info.manifest.items.filter((item) =>
      item.kind === "title" && item.durationSeconds !== undefined &&
      (!stagedFiles || Object.hasOwn(stagedFiles, item.id)));
    const unknownTrack = recovery.mappings.find((mapping) =>
      !titleItems.some((item) => item.id === mapping.trackId));
    if (unknownTrack) throw new Error(`Episode mapping references missing disc track ${unknownTrack.trackId}`);
    const missingEpisodes = titleItems.filter((item) =>
      (item.durationSeconds ?? 0) >= 600 && (item.durationSeconds ?? 0) <= 6000 &&
      !/\b(?:bonus|extra|featurette|trailer|commentary|interview|making of|gallery)\b/i.test(item.title ?? "") &&
      !mappingByTrack.has(item.id));
    if (missingEpisodes.length) {
      throw new Error(`Episode mappings are missing for disc tracks: ${missingEpisodes.map((item) => item.id).join(", ")}`);
    }
    const selected = recovery.mappings.flatMap((mapping) => {
      const item = titleItems.find((candidate) => candidate.id === mapping.trackId);
      return item ? [{ item, mapping }] : [];
    });
    if (!selected.length) throw new Error("No valid episode mappings are available for this disc");
    const seriesName = recovery.seriesName?.trim();
    if (!seriesName) throw new Error("TV series name is required before episode processing");

    const workDir = join(settings.workDir, job.id);
    const metadataSettings = settings.libraryMetadata;
    const importedMetadata = recovery.importedMetadata ?? {};
    const importedYear = importedMetadata.year;
    const seriesFolder = renderLibraryTemplate(libraryTemplate(metadataSettings, "seriesFolderTemplate"), {
      "Series Name": seriesName,
      Year: typeof importedYear === "string" || typeof importedYear === "number" ? importedYear : undefined
    });
    const tvLibraryRoot = outputPath(settings, "tv");
    const seriesDir = join(tvLibraryRoot, seriesFolder);
    const createdOutputs: string[] = [];
    const publishedDirectories = new Set<string>();
    const publishedSidecars = new Set<string>();
    const metadataTasks: Array<() => Promise<void>> = [];
    let totalOutputBytes = 0;
    let failureMessage: string | undefined;
    try {
      await ensureWritable(settings.workDir, minimumWorkBytes);
      await ensureWritable(settings.tvRootDir, minimumOutputBytes);
      await mkdir(workDir, { recursive: true, mode: 0o750 });
      await mkdir(seriesDir, { recursive: true, mode: 0o2775 });
      publishedDirectories.add(seriesDir);
      if (metadataSettings.downloadSeriesMetadata || metadataSettings.generateNfo) {
        metadataTasks.push(async () => {
          try {
          const seriesMetadata = metadataDocument(seriesName, recovery.metadataProvider,
            recovery.providerId ?? undefined, metadataSettings.downloadSeriesMetadata ? importedMetadata : {});
          const artwork = artworkAssets(recovery.artworkReferences).filter((asset) =>
            asset.kind !== "season-poster" && asset.kind !== "episode-image");
          const written = await writeMetadataBundle(seriesDir, "series", seriesMetadata,
            metadataSettings.automaticImport && metadataSettings.downloadSeriesMetadata ? artwork : [],
            metadataSettings, { nfoFileName: "tvshow.nfo" });
          if (written.nfoPath) publishedSidecars.add(written.nfoPath);
          for (const path of written.artworkPaths) publishedSidecars.add(path);
          } catch (error) {
            log("warn", "metadata", "TV series metadata or artwork could not be fully written", {
              jobId: job.id,
              error: error instanceof Error ? error.message : "unknown metadata write failure"
            });
          }
        });
      }
      const prepared = selected.map(({ item, mapping }) => {
        const baseName = episodeOutputName(seriesName, mapping,
          libraryTemplate(metadataSettings, "episodeFileTemplate"));
        const seasonNumber = mapping.episodes[0]?.seasonNumber;
        if (seasonNumber === undefined) throw new Error(`Track ${item.id} has no season assignment`);
        const seasonName = renderLibraryTemplate(libraryTemplate(metadataSettings, "seasonFolderTemplate"), {
          "Season Number": seasonNumber,
          Season: seasonNumber
        });
        const seasonDir = join(seriesDir, seasonName);
        return {
          item,
          mapping,
          baseName,
          seasonNumber,
          seasonName,
          seasonDir,
          targetPath: join(seasonDir, `${baseName}.${settings.format}`)
        };
      });
      for (const { item, targetPath } of prepared) {
        const collision = await access(targetPath).then(() => true, (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        });
        if (collision) throw new Error(`Episode output already exists and was not overwritten: ${targetPath}`);
      }
      const inputs = new Map<string, string>();
      for (const [index, { item }] of prepared.entries()) {
        job.throwIfCancelled();
        let input = stagedFiles?.[item.id];
        if (stagedFiles && !input) {
          throw new Error(`Staged video for TV disc track ${item.id} is unavailable`);
        }
        if (!input) {
          if (!sources || !workflow.sourceProvider) {
            throw new Error(`Staged video for TV disc track ${item.id} is unavailable`);
          }
          logTvContinuationState(jobs, job.id, "ripping", continuationSource);
          jobs.step(job, {
            id: `acquire-tv-${item.id}`,
            status: "ripping",
            message: `Ripping TV disc track ${item.id} (${index + 1} of ${prepared.length})`
          });
          const trackWorkDir = join(workDir, `track-${safeTitle(item.id)}`);
          await mkdir(trackWorkDir, { recursive: true, mode: 0o750 });
          const acquired = await sources.acquire(workflow.sourceProvider, trackWorkDir, {
            selection: { manifestItemId: item.id }
          }, signal);
          input = acquired.artifacts.find((artifact) => artifact.kind === "video")?.path;
        }
        if (!input) throw new Error(`Source provider ${info.providerId} returned no video artifact for track ${item.id}`);
        inputs.set(item.id, input);
      }
      logTvContinuationState(jobs, job.id, "converting", continuationSource);
      jobs.step(job, {
        id: "convert-tv-episodes",
        status: "converting",
        message: "Converting mapped TV episodes"
      });
      for (const [index, { item, mapping, baseName, seasonNumber, seasonName, seasonDir, targetPath }] of prepared.entries()) {
        job.throwIfCancelled();
        await mkdir(seasonDir, { recursive: true, mode: 0o2775 });
        publishedDirectories.add(seasonDir);
        if (metadataSettings.automaticImport && metadataSettings.downloadSeriesMetadata) {
          metadataTasks.push(async () => {
            try {
            const seasonArtwork = artworkAssets(recovery.artworkReferences).filter((asset) => asset.kind === "season-poster");
            const artworkPaths = await downloadArtwork(seasonDir, seasonArtwork, metadataSettings);
            for (const path of artworkPaths) publishedSidecars.add(path);
            } catch (error) {
              log("warn", "metadata", "TV season artwork could not be fully written", {
                jobId: job.id, seasonNumber, error: error instanceof Error ? error.message : "unknown artwork failure"
              });
            }
          });
        }
        if (metadataSettings.generateNfo) {
          metadataTasks.push(async () => {
            try {
            const nfoPath = await writeNfo(seasonDir, "season.nfo", "season", {
              title: seasonName,
              season: seasonNumber,
              provider: recovery.metadataProvider,
              providerId: recovery.providerId
            }, metadataSettings);
            if (nfoPath) publishedSidecars.add(nfoPath);
            } catch (error) {
              log("warn", "metadata", "TV season NFO could not be written", {
                jobId: job.id, seasonNumber, error: error instanceof Error ? error.message : "unknown write failure"
              });
            }
          });
        }
        const collision = await access(targetPath).then(() => true, (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        });
        if (collision) throw new Error(`Episode output already exists and was not overwritten: ${targetPath}`);

        const input = inputs.get(item.id);
        if (!input) throw new Error(`Source provider ${info.providerId} returned no video artifact for track ${item.id}`);
        const conversionStart = Date.now();
        const encoded = await converter(input, targetPath, baseName, settings, (encoder) => {
          logTvContinuationState(jobs, job.id, "publishing", continuationSource);
          jobs.step(job, {
            id: `publish-tv-${item.id}`,
            status: "publishing",
            message: `Validating and publishing episode track ${item.id}`
          });
          jobs.update(job, { outputPath: targetPath, encoder: encoder.name,
            conversionSeconds: (Date.now() - conversionStart) / 1000 });
        }, (progress) => {
          const overallProgress = ((index + Math.min(progress, 0.99)) / selected.length) * 100;
          jobs.update(job, { progress: Math.min(99, Math.round(overallProgress)) });
          events.emit("status");
        }, signal);
        createdOutputs.push(targetPath);
        const output = await stat(targetPath);
        if (output.size < 1024) throw new Error(`Published TV episode failed size validation: ${targetPath}`);
        if (metadataSettings.downloadEpisodeMetadata || metadataSettings.generateNfo) {
          metadataTasks.push(async () => {
            try {
            const firstEpisode = [...mapping.episodes].sort((left, right) =>
              left.seasonNumber - right.seasonNumber || left.episodeNumber - right.episodeNumber)[0];
            const episodeMetadata = metadataDocument(firstEpisode?.title ?? baseName,
              recovery.metadataProvider, recovery.providerId ?? undefined, importedMetadata);
            const nfoPath = await writeNfo(seasonDir, `${baseName}.nfo`, "episode", {
              ...episodeMetadata,
              ...(firstEpisode ? {
                season: firstEpisode.seasonNumber,
                episode: firstEpisode.episodeNumber,
                ...(firstEpisode.airDate ? { airDate: firstEpisode.airDate } : {}),
                ...(firstEpisode.notes ? { overview: firstEpisode.notes } : {})
              } : {})
            }, metadataSettings);
            if (nfoPath) publishedSidecars.add(nfoPath);
            } catch (error) {
              log("warn", "metadata", "TV episode NFO could not be written", {
                jobId: job.id, trackId: item.id, error: error instanceof Error ? error.message : "unknown write failure"
              });
            }
          });
        }
        totalOutputBytes += encoded.outputBytes;
        jobs.update(job, {
          title: seriesName,
          outputPath: targetPath,
          outputBytes: totalOutputBytes,
          encoder: encoded.encoder.name,
          conversionSeconds: (Date.now() - conversionStart) / 1000,
          progress: Math.round(((index + 1) / selected.length) * 100)
        });
        jobs.record(job, "tv-episode-published", "info",
          `Published ${baseName}.${settings.format} for disc track ${item.id}`);
      }
      for (const writeMetadata of metadataTasks) await writeMetadata();
      for (const directory of publishedDirectories) {
        await applyPublishedPermissions(directory, tvLibraryRoot, false);
      }
      for (const path of [...createdOutputs, ...publishedSidecars]) {
        await applyPublishedPermissions(path, tvLibraryRoot, false);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "TV episode processing failed";
      const cleanupFailures: string[] = [];
      for (const path of createdOutputs) {
        try {
          await unlink(path);
        } catch (cleanupError) {
          cleanupFailures.push(`${path}: ${cleanupError instanceof Error ? cleanupError.message : "cleanup failed"}`);
        }
      }
      const message = cleanupFailures.length
        ? `${reason}; could not roll back published episodes: ${cleanupFailures.join("; ")}`
        : reason;
      failureMessage = message;
    } finally {
      try {
        await rm(workDir, { recursive: true, force: true });
      } catch (error) {
        const cleanupMessage = `TV temporary-file cleanup failed: ${error instanceof Error ? error.message : "unknown error"}`;
        if (failureMessage) failureMessage += `; ${cleanupMessage}`;
        else jobs.warn(job, cleanupMessage);
      }
    }
    if (failureMessage) throw new Error(failureMessage);
    jobs.complete(job, fingerprint);
    if (beforeComplete) {
      try {
        await beforeComplete();
      } catch (error) {
        const message = `TV episodes were published, but staged-file cleanup failed: ${error instanceof Error ? error.message : "unknown cleanup failure"}`;
        jobs.warn(job, message);
        log("error", "tv-staging", message, { jobId: job.id });
      }
    }
    if (devicePath && (settings.autoEject || settings.automationMode === "full_auto")) {
      try {
        await ejectDisc(devicePath);
        jobs.record(job, "eject", "info", "Disc ejected");
      } catch (error) {
        const message = `Eject failed: ${error instanceof Error ? error.message : "unknown error"}`;
        jobs.warn(job, message);
        log("warn", "eject", message, { jobId: job.id });
      }
    }
  }

  export class DvdWorkflow implements MediaWorkflow {
  readonly mediaKind = "dvd";

  constructor(
    private readonly tvWorkflow?: TvWorkflowService,
    private readonly reviewWorkspaces?: ReviewWorkspaceService,
    private readonly converter: typeof convert = convert,
    private readonly ensureWritable: typeof assertWritableDirectory = assertWritableDirectory,
    private readonly matchingJobs?: JobCoordinator
  ) {}

  private async stageTvDisc(
    workflow: MediaWorkflowContext,
    job: JobContext,
    fingerprint: string,
    result: NonNullable<Awaited<ReturnType<TvWorkflowService["prepare"]>>> | null,
    analysisFailure?: string
  ): Promise<"staged" | "completed"> {
    const { source, sources, jobs, signal, devicePath } = workflow;
    const settings = jobs.getSettings();
    const filesystemVolumeName = source.candidate.manifest.attributes?.filesystemVolumeName;
    const volumeName = typeof filesystemVolumeName === "string" ? filesystemVolumeName : "";
    const stagingRoot = tvStagingDirectory(settings);
    const conflict = tvStagingConflicts(settings)[0];
    if (conflict) throw new Error(tvStagingConflictMessage(stagingRoot, conflict));
    await this.ensureWritable(stagingRoot, 0);
    const info = await lstat(stagingRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("TV staging directory must not be a symbolic link");
    }
    const realStagingRoot = await realpath(stagingRoot);
    if (!pathIsWithin(stagingRoot, realStagingRoot)) {
      throw new Error("TV staging directory resolves outside its configured location");
    }
    const stagingPath = resolve(stagingRoot, job.id);
    if (!pathIsWithin(stagingRoot, stagingPath) || basename(stagingPath) !== job.id) {
      throw new Error("TV staging task path failed validation");
    }
    const titleIds = new Set((result?.analysis.items ?? [])
      .filter((item) => item.kind === "episode-candidate")
      .map((item) => item.itemId));
    const episodeTitles = source.candidate.manifest.items.filter((item) =>
      item.kind === "title" && item.durationSeconds !== undefined &&
      item.durationSeconds >= 600 && item.durationSeconds <= 6000 &&
      !/\b(?:bonus|extra|featurette|trailer|commentary|interview|making of|gallery)\b/i.test(item.title ?? "") &&
      (titleIds.size === 0 || titleIds.has(item.id))
    );
    if (!episodeTitles.length) throw new Error("TV staging found no episode-length titles to rip");

    const tempPath = resolve(stagingPath, ".working");
    const files: Record<string, string> = {};
    const videoDetails = new Map<string, Awaited<ReturnType<typeof inspectVideo>>>();
    let task: TvMatchingTask | undefined;
    await mkdir(stagingPath, { recursive: false, mode: 0o750 });
    try {
      await mkdir(tempPath, { recursive: true, mode: 0o750 });
      for (const [index, item] of episodeTitles.entries()) {
        job.throwIfCancelled();
        if (!/^\d+$/.test(item.id)) throw new Error(`TV disc track ID ${item.id} is invalid for staging`);
        const trackWorkDir = join(tempPath, `track-${item.id}`);
        await mkdir(trackWorkDir, { recursive: true, mode: 0o750 });
        jobs.step(job, {
          id: `stage-tv-${item.id}`,
          status: "ripping",
          message: `Ripping TV episode title ${index + 1} of ${episodeTitles.length} to staging`
        });
        const acquired = await sources.acquire(source, trackWorkDir, {
          selection: { manifestItemId: item.id }
        }, signal);
        const input = acquired.artifacts.find((artifact) => artifact.kind === "video")?.path;
        if (!input) throw new Error(`Source provider ${source.candidate.providerId} returned no video for title ${item.id}`);
        const sourceStat = await lstat(input);
        if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size < 1024) {
          throw new Error(`Ripped TV title ${item.id} failed staging validation`);
        }
        const fileName = `episode${String(index + 1).padStart(2, "0")}.mkv`;
        const stagedFile = join(stagingPath, fileName);
        await moveFile(input, stagedFile);
        files[item.id] = fileName;
        try {
          videoDetails.set(item.id, await inspectVideo(stagedFile, signal));
        } catch (error) {
          if (signal.aborted) throw error;
          const message = error instanceof Error ? error.message : "Video details could not be read";
          log("warn", "tv-staging", "Staged track preview metadata could not be read", {
            jobId: job.id,
            trackId: item.id,
            error: message
          });
        }
        jobs.update(job, { progress: Math.round(((index + 1) / episodeTitles.length) * 100) });
        events.emit("status");
      }
      const suggestedAssignments = result ? matchingAssignments(result) : [];
      const byTrack = new Map(suggestedAssignments.map((assignment) => [assignment.trackId, assignment]));
      const assignments: TvMatchingAssignment[] = episodeTitles.map((item) => {
        const assignment = byTrack.get(item.id) ?? {
          trackId: item.id,
          title: item.title ?? `Track ${item.id}`,
          durationSeconds: item.durationSeconds ?? 0,
          episodeCandidates: []
        };
        const details = videoDetails.get(item.id);
        return {
          ...assignment,
          ...(details?.durationSeconds ? { durationSeconds: details.durationSeconds } : {}),
          ...(details?.resolution ? { resolution: details.resolution } : {})
        };
      });
      const diagnostics = result
        ? result.identification as unknown as Record<string, unknown>
        : { status: "analysis-unavailable", failure: analysisFailure ?? "TV analysis did not produce a result" };
      await writeFile(join(stagingPath, "metadata.json"), `${JSON.stringify({
        jobId: job.id,
        fingerprint,
        sourceLabel: source.candidate.label || null,
        series: result?.plan.series ?? null,
        season: result?.plan.season ?? null,
        discNumber: result?.plan.discPosition?.discNumber ?? null,
        episodeCount: episodeTitles.length,
        runtimeSeconds: episodeTitles.reduce((sum, item) => sum + (item.durationSeconds ?? 0), 0),
        files
      }, null, 2)}\n`, { encoding: "utf8", mode: 0o640, flag: "wx" });
      await writeFile(join(stagingPath, "diagnostics.json"), `${JSON.stringify(diagnostics, null, 2)}\n`,
        { encoding: "utf8", mode: 0o640, flag: "wx" });
      task = jobs.createTvMatchingTask({
        jobId: job.id,
        fingerprint,
        status: result?.plan.series && result.plan.season
          ? "awaiting-mapping" : "awaiting-identification",
        stagingPath,
        source: source.candidate,
        diagnostics,
        files,
        assignments
      });
      jobs.update(job, { title: result?.plan.series?.title ?? (source.candidate.label || "Unidentified TV disc") });
      jobs.record(job, "tv-staged", "info",
        `${episodeTitles.length} episode titles staged in ${stagingPath}`);
      if (result?.plan.series && !jobs.getDiscRecovery(fingerprint)?.seriesName) {
        const selected = result.identification.selected;
        const seriesMetadata = result.metadataLookups.find((lookup) => lookup.entityType === "series")
          ?.candidates.find((candidate) => candidate.title === result.plan.series?.title)?.metadata ?? {};
        jobs.updateDiscRecovery(fingerprint, {
          finalMediaType: "tv_series",
          metadataProvider: selected?.providerId.includes("tvdb") ? "tvdb" :
            selected?.providerId.includes("tmdb") ? "tmdb" : "manual",
          providerId: result.plan.series.id ?? selected?.seriesId ?? null,
          seriesName: result.plan.series.title,
          seasonNumber: result.plan.season?.number ?? null,
          discNumber: result.plan.discPosition?.discNumber ?? null,
          identifiedBy: null,
          importedMetadata: withNameEvidence({
            ...seriesMetadata,
            entityType: "series",
            title: result.plan.series.title,
            ...(result.plan.series.year === undefined ? {} : { year: result.plan.series.year })
          }, source.candidate.label, volumeName),
          artworkReferences: artworkFromMetadata(seriesMetadata)
        });
      }
      const learnedRecovery = jobs.getDiscRecovery(fingerprint);
      if (learnedRecovery?.seriesName) {
        jobs.updateDiscRecovery(fingerprint, {
          importedMetadata: withNameEvidence(learnedRecovery.importedMetadata,
            source.candidate.label, volumeName)
        });
      }
      const runtimeMinutes = Math.round(episodeTitles.reduce((sum, item) => sum + (item.durationSeconds ?? 0), 0) /
        episodeTitles.length / 60);
      const message = `TV disc staged for review: ${episodeTitles.length} episode titles, approximately ${runtimeMinutes} minutes of content.`;
      jobs.finishForReview(job, message);
      if (settings.autoEject || settings.automationMode === "full_auto") {
        try {
          await ejectDisc(devicePath);
          jobs.record(job, "eject", "info", "Disc ejected after TV episodes were staged");
        } catch (error) {
          jobs.warn(job, `Eject failed after TV staging: ${error instanceof Error ? error.message : "unknown error"}`);
        }
      }
      jobs.clearInsertedDisc();
      setRuntimeStatus("idle");
      return "staged";
    } catch (error) {
      if (task) {
        const identified = jobs.getDiscRecovery(fingerprint);
        jobs.updateTvMatchingTask(job.id, {
          status: identified?.seriesName && identified.seasonNumber !== null
            ? tvMatchingReviewStatus(task.assignments) : "awaiting-identification",
          failure: error instanceof Error ? error.message : "TV staging continuation failed"
        });
      } else {
        try {
          await rm(stagingPath, { recursive: true, force: true });
        } catch (cleanupError) {
          log("error", "tv-staging", "Could not remove partially created TV staging directory", {
            jobId: job.id,
            error: cleanupError instanceof Error ? cleanupError.message : "unknown cleanup failure"
          });
        }
      }
      throw error;
    } finally {
      await rm(tempPath, { recursive: true, force: true });
    }
  }

  private async removeStagingDirectory(task: TvMatchingTask, settings: ReturnType<JobCoordinator["getSettings"]>): Promise<void> {
    const stagingRoot = tvStagingDirectory(settings);
    const expectedPath = resolve(stagingRoot, task.jobId);
    const samePath = (left: string, right: string): boolean =>
      process.platform === "win32"
        ? resolve(left).toLocaleLowerCase() === resolve(right).toLocaleLowerCase()
        : resolve(left) === resolve(right);
    if (!samePath(task.stagingPath, expectedPath) || basename(task.stagingPath) !== task.jobId) {
      throw new Error("TV staging path failed validation");
    }
    const outputRoots = [outputPath(settings, "tv"), outputPath(settings, "movies"), outputPath(settings, "music")];
    const conflict = tvStagingConflicts(settings)[0];
    if (conflict) {
      throw new Error(`${tvStagingConflictMessage(stagingRoot, conflict)} Staged data was left untouched.`);
    }
    let rootInfo: Awaited<ReturnType<typeof lstat>>;
    try {
      rootInfo = await lstat(stagingRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error("TV staging root is not a regular directory");
    }
    const realStagingRoot = await realpath(stagingRoot);
    if (!pathIsWithin(stagingRoot, realStagingRoot) || !samePath(realStagingRoot, stagingRoot)) {
      throw new Error("TV staging root does not resolve to its configured location");
    }
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(expectedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("TV staging task is not a regular staging directory");
    }
    const realTaskPath = await realpath(expectedPath);
    if (!samePath(realTaskPath, expectedPath) || !pathIsWithin(realStagingRoot, realTaskPath)) {
      throw new Error("TV staging task path resolves outside its protected staging root");
    }
    await rm(expectedPath, { recursive: true, force: false });
  }

  async removeTvMatchingTask(jobId: string): Promise<void> {
    const jobs = this.matchingJobs;
    if (!jobs) throw new Error("TV matching service is unavailable");
    const task = jobs.getTvMatchingTask(jobId);
    if (!task) throw new Error("TV matching task was not found");
    if (task.status === "processing") throw new Error("A TV matching task cannot be deleted while processing");
    await this.removeStagingDirectory(task, jobs.getSettings());
    if (!jobs.deleteTvMatchingRecords(task.jobId, task.fingerprint)) {
      throw new Error("TV matching task references could not be removed");
    }
    events.emit("status");
  }

  async pruneExpiredTvMatchingTasks(): Promise<void> {
    const jobs = this.matchingJobs;
    if (!jobs) return;
    for (const task of jobs.listTvMatchingTasks()) {
      if (task.status === "processing" && jobs.getJob(task.jobId)?.status === "completed") {
        await this.removeStagingDirectory(task, jobs.getSettings());
        jobs.updateTvMatchingTask(task.jobId, { status: "completed", failure: null });
      }
    }
  }

  async recoverOrphanedTvStagingDirectories(): Promise<void> {
    const jobs = this.matchingJobs;
    if (!jobs) return;
    const settings = jobs.getSettings();
    const stagingRoot = tvStagingDirectory(settings);
    const conflict = tvStagingConflicts(settings)[0];
    if (conflict) {
      throw new Error(`${tvStagingConflictMessage(stagingRoot, conflict)} Orphaned data was left untouched.`);
    }
    let rootInfo;
    try {
      rootInfo = await lstat(stagingRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error("TV staging root is not a regular directory");
    }
    const realStagingRoot = await realpath(stagingRoot);
    if (!pathIsWithin(stagingRoot, realStagingRoot)) {
      throw new Error("TV staging root resolves outside its configured location");
    }
    for (const entry of await readdir(stagingRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entry.name) ||
        jobs.getTvMatchingTask(entry.name)) continue;
      const path = resolve(stagingRoot, entry.name);
      if (!pathIsWithin(stagingRoot, path) || basename(path) !== entry.name) {
        throw new Error("Orphaned TV staging directory failed path validation");
      }
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error("Orphaned TV staging path is not a regular directory");
      }
      const realPath = await realpath(path);
      if (!pathIsWithin(realStagingRoot, realPath)) {
        throw new Error("Orphaned TV staging directory resolves outside its staging root");
      }
      log("warn", "tv-staging", "Untracked staged TV files were retained for manual recovery", {
        stagingPath: path,
        jobId: entry.name
      });
    }
  }

  recoverInterruptedTvMatchingTasks(): void {
    const jobs = this.matchingJobs;
    if (!jobs) return;
    for (const task of jobs.listTvMatchingTasks()) {
      const job = jobs.getJob(task.jobId);
      const recovery = jobs.getDiscRecovery(task.fingerprint);
      const activeJob = job && ["inspecting", "ripping", "converting", "publishing"].includes(job.status);
      if (task.status === "processing" && job?.status === "completed") continue;
      if (task.status !== "processing" && !activeJob) continue;
      const message = "TV matching was interrupted; staged media is available to continue.";
      jobs.updateTvMatchingTask(task.jobId, {
        status: recovery?.seriesName && recovery.seasonNumber !== null
          ? tvMatchingReviewStatus(task.assignments) : "awaiting-identification",
        failure: message
      });
      if (job && ["inspecting", "ripping", "converting", "publishing"].includes(job.status)) {
        jobs.interruptTvMatching(task.jobId, message);
      }
      if (job) {
        jobs.createReview({
          category: "tv_review",
          severity: "medium",
          title: "TV disc matching needs to continue",
          description: message,
          relatedJobId: job.id,
          ...(job.discLabel ? { relatedDisc: job.discLabel } : {}),
          discFingerprint: task.fingerprint,
          suggestedActions: [{ type: "view-job", label: "Open TV Matching" }]
        });
      }
    }
  }

  async continueTvMatching(
    jobId: string,
    continuationSource: TvMatchingContinuationSource = "continue-action"
  ): Promise<void> {
    const jobs = this.matchingJobs;
    if (!jobs || !this.tvWorkflow) throw new Error("TV matching service is unavailable");
    logTvContinuationState(jobs, jobId, "converting", continuationSource);
    const task = jobs.getTvMatchingTask(jobId);
    if (!task) throw new Error("TV matching task was not found");
    if (task.status === "processing" || task.status === "completed") {
      throw new Error(`TV matching task is ${task.status}`);
    }
    const controller = new AbortController();
    const context = jobs.resume(task.jobId, "dvd", task.fingerprint, task.source.label, controller.signal);
    jobs.updateTvMatchingTask(task.jobId, { status: "processing", failure: null });
    try {
      const recovery = jobs.getDiscRecovery(task.fingerprint);
      if (!recovery?.seriesName || recovery.seasonNumber === null) {
        throw new Error("Identify the series and season before continuing");
      }
      const savedIdentification: TvSavedIdentification = {
        seriesName: recovery.seriesName,
        seriesId: recovery.providerId,
        provider: recovery.metadataProvider === "manual" ? "manual" : recovery.metadataProvider,
        seasonNumber: recovery.seasonNumber,
        discNumber: recovery.discNumber ?? 1,
        discName: recovery.discName,
        origin: recovery.identifiedBy === "user" ? "user" : "fingerprint",
        ...(typeof recovery.importedMetadata?.year === "number" ? { year: recovery.importedMetadata.year } : {})
      };
      const source = {
        sourceId: task.source.sourceId,
        providerId: task.source.providerId,
        mediaKind: task.source.mediaKind,
        label: task.source.label,
        manifest: task.source.manifest
      };
      const result = await this.tvWorkflow.prepare(source, task.fingerprint, controller.signal, savedIdentification);
      if (!result) throw new Error("TV analysis could not be resumed from staged media");
      const seriesMetadata = result.metadataLookups.find((lookup) => lookup.entityType === "series")
        ?.candidates.find((candidate) => candidate.title?.toLocaleLowerCase() === recovery.seriesName?.toLocaleLowerCase())
        ?.metadata ?? {};
      const volumeValue = task.source.manifest.attributes?.filesystemVolumeName;
      const volumeName = typeof volumeValue === "string" ? volumeValue : "";
      const enrichedRecovery = jobs.updateDiscRecovery(task.fingerprint, {
        importedMetadata: withNameEvidence({
          ...seriesMetadata,
          ...(recovery.importedMetadata ?? {}),
          entityType: "series",
          title: recovery.seriesName
        }, task.source.label, volumeName),
        artworkReferences: [
          ...recovery.artworkReferences,
          ...artworkFromMetadata(seriesMetadata)
        ].filter((reference, index, references) =>
          references.findIndex((candidate) => candidate.kind === reference.kind && candidate.url === reference.url) === index)
      });
      if (!enrichedRecovery) throw new Error("TV metadata could not be saved during staged continuation");
      const suggested = matchingAssignments(result);
      const suggestedByTrack = new Map(suggested.map((assignment) => [assignment.trackId, assignment]));
      const prior = new Map<string, TvMatchingAssignment>(
        task.assignments.map((assignment) => [assignment.trackId, assignment])
      );
      const manifestItems = new Map(task.source.manifest.items.map((item) => [item.id, item]));
      const assignments: TvMatchingAssignment[] = Object.keys(task.files).map((trackId) => {
        const candidate = suggestedByTrack.get(trackId);
        const previous = prior.get(trackId);
        const item = manifestItems.get(trackId);
        const current = candidate ?? previous ?? {
          trackId,
          title: item?.title ?? `Track ${trackId}`,
          durationSeconds: item?.durationSeconds ?? 0,
          episodeCandidates: []
        };
        return {
          ...current,
          ...(previous?.confirmed && previous.selectedEpisodes?.length
            ? { selectedEpisodes: previous.selectedEpisodes, confirmed: true }
            : {})
        };
      });
      jobs.updateTvMatchingTask(task.jobId, {
        assignments,
        diagnostics: result.identification as unknown as Record<string, unknown>
      });
      const unresolved = assignments.filter((assignment) =>
        assignment.confirmed !== true || !assignment.selectedEpisodes?.length);
      if (unresolved.length) {
        jobs.updateTvMatchingTask(task.jobId, {
          status: tvMatchingReviewStatus(assignments),
          failure: null
        });
        jobs.finishForReview(context, `${unresolved.length} staged title${unresolved.length === 1 ? "" : "s"} need episode review before publishing.`);
        jobs.record(context, "tv-matching", "warn", "TV identification saved; staged content remains unpublished for episode review.");
        return;
      }
      const mappings: EpisodeMapping[] = assignments.flatMap((assignment) => assignment.selectedEpisodes?.length
        ? [{ trackId: assignment.trackId, episodes: [...assignment.selectedEpisodes] }]
        : []);
      const updatedRecovery = jobs.updateDiscRecovery(task.fingerprint, { mappings });
      if (!updatedRecovery) throw new Error("TV episode mappings could not be saved");
      const stagedFiles = await this.resolveStagedFiles(task);
      await processMappedTvEpisodes({
        source: task.source,
        jobs,
        signal: controller.signal,
        devicePath: ""
      }, context, task.fingerprint, updatedRecovery, this.converter, this.ensureWritable, stagedFiles,
      async () => {
        await this.removeStagingDirectory(task, jobs.getSettings());
        if (!jobs.updateTvMatchingTask(task.jobId, { status: "completed", failure: null })) {
          throw new Error("TV matching task could not be marked completed");
        }
      }, continuationSource);
      setRuntimeStatus("completed");
    } catch (error) {
      const message = error instanceof Error ? error.message : "TV matching continuation failed";
      const current = jobs.getTvMatchingTask(task.jobId);
      if (current?.status === "processing") jobs.updateTvMatchingTask(task.jobId, {
        status: tvMatchingReviewStatus(current.assignments) === "ready-to-publish"
          ? "awaiting-mapping" : tvMatchingReviewStatus(current.assignments),
        failure: message
      });
      jobs.fail(context, "failed", {
        code: "tv_matching_continue_failed",
        message,
        recoverable: true,
        reviewCategory: "tv_review"
      });
      throw error;
    } finally {
      events.emit("status");
      notifyStatus();
    }
  }

  private async resolveStagedFiles(task: TvMatchingTask): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    for (const assignment of task.assignments) {
      const name = task.files[assignment.trackId];
      if (!name || basename(name) !== name || name.includes("..")) {
        throw new Error(`Staged media reference for track ${assignment.trackId} is invalid`);
      }
      const path = resolve(task.stagingPath, name);
      if (!pathIsWithin(task.stagingPath, path)) throw new Error("Staged media path escaped its task directory");
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size < 1024) {
        throw new Error(`Staged media for track ${assignment.trackId} failed validation`);
      }
      files[assignment.trackId] = path;
    }
    return files;
  }

  async process({ source, sources, jobs, metadata, signal, devicePath }: MediaWorkflowContext): Promise<boolean> {
    const info = source.candidate;
    const settings = jobs.getSettings();
    const rawFilesystemVolumeName = info.manifest.attributes?.filesystemVolumeName;
    const filesystemVolumeName = typeof rawFilesystemVolumeName === "string" ? rawFilesystemVolumeName.trim() : "";
    const titles: DiscTitle[] = info.manifest.items
      .filter((item) => item.kind === "title" && item.durationSeconds !== undefined)
      .map((item) => ({ id: Number(item.id), name: item.title ?? "", durationSeconds: item.durationSeconds ?? 0 }));
    const selectedTitle = selectMainFeature(titles);
    if (!selectedTitle) {
      log("warn", "disc", "Disc inspection produced no usable video titles; no job was created and detection will retry", {
        sourceId: info.sourceId,
        providerId: info.providerId,
        discLabel: info.label || undefined,
        manifestItemCount: info.manifest.items.length,
        titleItemCount: info.manifest.items.filter((item) => item.kind === "title").length
      });
      return false;
    }
    const fingerprint = fingerprintDisc(info);
    if (jobs.lastDiscFingerprint() === fingerprint) {
      log("info", "disc", "Already-processed disc is still inserted; ignoring duplicate detection event");
      setRuntimeStatus("completed");
      return true;
    }
    const id = randomUUID();
    const discLabel = info.label.trim() || filesystemVolumeName || null;
    const context = jobs.begin(id, discLabel, info.mediaKind, fingerprint, signal, devicePath);
    jobs.record(context, "disc-detected", "info", JSON.stringify({
      driveId: devicePath,
      devicePath,
      detectionMethod: getLiveDiscDiagnostics()?.detectionMethod ?? "udev event or optical-media presence monitor",
      detectedAt: getLiveDiscDiagnostics()?.detectedAt ?? new Date().toISOString(),
      discType: info.mediaKind,
      label: info.label || null,
      fingerprint,
      sourceProvider: info.providerId,
      providersAttempted: sources.inspectionDiagnostics?.()?.attemptedProviders ?? [],
      sourceId: info.sourceId,
      manifest: info.manifest,
      titleCount: titles.length,
      mainTitleCandidate: selectedTitle.id,
      tvCandidateTitles: titles.filter((title) => title.durationSeconds >= 600 && title.durationSeconds <= 6000),
      bonusContentCandidates: titles.filter((title) => /\b(?:bonus|extra|featurette|trailer|commentary|interview)\b/i.test(title.name))
    }));
    const tvSource = {
      sourceId: info.sourceId,
      providerId: info.providerId,
      mediaKind: info.mediaKind,
      label: info.label,
      manifest: info.manifest
    };
    const tvAssessment = assessTvDisc(tvSource, {
      hasCompletedTvHistory: this.tvWorkflow?.hasCompletedTvHistory(tvSource) ?? false
    });
    const detectedMediaType = tvAssessment.classification === "movie" ? "movie" :
      tvAssessment.classification === "tv" ? "tv_series" : "mixed_content";
    let recovery = jobs.recordDiscDetection(fingerprint, "dvd", detectedMediaType, tvAssessment.confidence);
    if (!recovery.seriesName) {
      const volumeName = filesystemVolumeName;
      const learned = jobs.listDiscRecoveries(1000).find((candidate) =>
        candidate.fingerprint !== fingerprint && candidate.seriesName &&
        (nameMatchesEvidence(info.label, candidate.importedMetadata?.knownLabels) ||
          nameMatchesEvidence(volumeName, candidate.importedMetadata?.knownVolumeNames)));
      if (learned?.seriesName) {
        const matched = jobs.updateDiscRecovery(fingerprint, {
          finalMediaType: "tv_series",
          metadataProvider: learned.metadataProvider,
          providerId: learned.providerId,
          seriesName: learned.seriesName,
          seasonNumber: learned.seasonNumber,
          discNumber: learned.discNumber,
          discName: learned.discName,
          importedMetadata: learned.importedMetadata,
          artworkReferences: learned.artworkReferences
        });
        if (!matched) throw new Error("Learned TV series evidence could not be applied to this disc");
        recovery = matched;
        jobs.record(context, "tv-learned-evidence", "info", JSON.stringify({
          matchedFingerprint: learned.fingerprint,
          matchedSeries: learned.seriesName,
          discLabel: info.label || null,
          filesystemVolumeName: volumeName || null
        }));
      }
    }
    const hasKnownTvRecovery = Boolean(recovery.seriesName &&
      (recovery.finalMediaType === "tv_series" || recovery.mappings.length > 0));
    const finalMediaType = recovery.mediaTypeOverridden ? recovery.finalMediaType :
      hasKnownTvRecovery ? "tv_series" : detectedMediaType;
    const isTvWorkflow = finalMediaType === "tv_series" ||
      (!recovery.mediaTypeOverridden && tvAssessment.classification === "tv");
    const classificationReviewRequired = !recovery.mediaTypeOverridden &&
      !isTvWorkflow && tvAssessment.classification === "review";
    const unsupportedOverride = (recovery.mediaTypeOverridden &&
      !["movie", "tv_series"].includes(recovery.finalMediaType)) ||
      (recovery.discTypeOverridden && recovery.finalDiscType !== "dvd");
    const tvEnabled = settings.tvDetectionEnabled !== false || recovery.mediaTypeOverridden ||
      Boolean(recovery.seriesName && recovery.mappings.length);
    updateDiscDiagnostics({
      status: "Classification complete",
      classification: recovery.mediaTypeOverridden
        ? `${finalMediaType.replaceAll("_", " ")} (manual override)`
        : tvAssessment.classification === "movie" ? "Movie" : tvAssessment.classification === "tv" ? "TV" : "Review required"
    });
    log("info", "disc", `Disc classified as ${recovery.mediaTypeOverridden ? finalMediaType : detectedMediaType}`, {
      jobId: id,
      sourceId: info.sourceId,
      providerId: info.providerId,
      discLabel: info.label || undefined,
      classification: tvAssessment.classification,
      finalMediaType,
      mediaTypeOverridden: recovery.mediaTypeOverridden,
      classificationConfidence: tvAssessment.confidence,
      movieConfidence: tvAssessment.movieConfidence,
      tvConfidence: tvAssessment.tvConfidence,
      classificationEvidence: tvAssessment.classificationEvidence,
      criteria: tvAssessment.criteria,
      reasons: tvAssessment.reasons,
      tvDetectionEnabled: tvEnabled
    });
    const scoreWeights = [0.55, 0.2, 0.1, 0.1, 0.05];
    jobs.record(context, "tv-classification", "info", JSON.stringify({
      decision: tvAssessment.classification,
      finalMediaType,
      mediaTypeOverridden: recovery.mediaTypeOverridden,
      confidence: tvAssessment.confidence,
      movieConfidence: tvAssessment.movieConfidence,
      tvConfidence: tvAssessment.tvConfidence,
      classificationEvidence: tvAssessment.classificationEvidence,
      criteria: tvAssessment.criteria.map((criterion, index) => ({
        ...criterion,
        weight: scoreWeights[index] ?? 0,
        contribution: criterion.passed ? scoreWeights[index] ?? 0 : 0
      })),
      reasons: tvAssessment.reasons,
      tvDetectionEnabled: tvEnabled
    }));

    if (unsupportedOverride || classificationReviewRequired || (isTvWorkflow && !tvEnabled)) {
      const message = unsupportedOverride
        ? `The manually selected ${recovery.discTypeOverridden && recovery.finalDiscType !== "dvd"
          ? `disc type ${recovery.finalDiscType}` : `media type ${finalMediaType}`} is not supported by the DVD processing workflow; held for review.`
        : classificationReviewRequired
          ? "Disc lacks sufficient movie or TV structure evidence; held for review before TV metadata lookup."
        : `Disc matched ${tvAssessment.classification === "tv" ? "TV-series" : "possible TV-series"} criteria (heuristic confidence ${tvAssessment.confidence.toFixed(2)}), but TV detection is disabled; held for review instead of movie processing.`;
      jobs.holdForReview(context, message, {
        classification: tvAssessment.classification,
        finalMediaType,
        mediaTypeOverridden: recovery.mediaTypeOverridden,
        confidence: tvAssessment.confidence,
        movieConfidence: tvAssessment.movieConfidence,
        tvConfidence: tvAssessment.tvConfidence,
        classificationEvidence: tvAssessment.classificationEvidence,
        criteria: tvAssessment.criteria,
        reasons: tvAssessment.reasons,
        tvDetectionEnabled: tvEnabled
      });
      setRuntimeStatus("idle");
      notifyStatus();
      return true;
    }

    const existingStagedTask = isTvWorkflow
      ? jobs.listTvMatchingTasks().find((task) => task.fingerprint === fingerprint)
      : undefined;
    if (existingStagedTask) {
      jobs.holdForReview(context,
        `This disc already has staged TV content awaiting review at ${existingStagedTask.stagingPath}. The existing staged files were left untouched.`,
        { classification: "tv", stagedTaskId: existingStagedTask.jobId });
      setRuntimeStatus("idle");
      notifyStatus();
      return true;
    }

    if (isTvWorkflow && tvEnabled && !this.tvWorkflow &&
      !(recovery.seriesName && recovery.mappings.length > 0)) {
      try {
        await this.stageTvDisc({
          source, sources, jobs, metadata, signal, devicePath
        }, context, fingerprint, null, "TV analysis service is unavailable");
        setRuntimeStatus("idle");
      } catch (error) {
        const message = error instanceof Error ? error.message : "TV staging failed";
        jobs.fail(context, "failed", {
          code: "tv_staging_failed",
          message,
          recoverable: true,
          reviewCategory: "tv_review"
        });
        setRuntimeStatus("failed");
      }
      notifyStatus();
      return true;
    }

    if (isTvWorkflow && recovery.seriesName && recovery.mappings.length > 0) {
      try {
        await processMappedTvEpisodes({
          source: source.candidate,
          sourceProvider: source, sources, jobs, signal, devicePath
        }, context, fingerprint, recovery, this.converter, this.ensureWritable);
        setRuntimeStatus("completed");
      } catch (error) {
        const cancelled = jobs.wasJobCancelled(context);
        const interrupted = Boolean(signal.aborted && !cancelled);
        jobs.fail(context, cancelled ? "cancelled" : interrupted ? "interrupted" : "failed", {
          code: cancelled ? "cancelled" : interrupted ? "interrupted" : "tv_processing_failed",
          message: error instanceof Error ? error.message : "TV episode processing failed",
          recoverable: interrupted,
          reviewCategory: "tv_review"
        });
        setRuntimeStatus(cancelled || interrupted ? "idle" : "failed");
      }
      notifyStatus();
      return true;
    }

    if (isTvWorkflow && this.tvWorkflow && tvEnabled) {
      try {
        const savedIdentification: TvSavedIdentification | undefined = recovery.seriesName ? {
          seriesName: recovery.seriesName,
          seriesId: recovery.providerId,
          provider: recovery.metadataProvider === "manual" ? "manual" : recovery.metadataProvider,
          seasonNumber: recovery.seasonNumber,
          discNumber: recovery.discNumber,
          discName: recovery.discName,
          origin: recovery.identifiedBy === "user" ? "user" : "fingerprint",
          ...(typeof recovery.importedMetadata?.year === "number" ? { year: recovery.importedMetadata.year } : {})
        } : undefined;
        const tvResult = await this.tvWorkflow.prepare({
          sourceId: info.sourceId,
          providerId: info.providerId,
          mediaKind: info.mediaKind,
          label: info.label,
          manifest: info.manifest
        }, fingerprint, signal, savedIdentification);
        if (tvResult) {
          const message = `TV ${tvAssessment.classification} candidate (heuristic confidence ${tvAssessment.confidence.toFixed(2)}). ${summarizeTvPlan(tvResult.plan)}`;
          jobs.update(context, { title: tvResult.plan.series?.title ?? info.label ?? null });
          jobs.record(context, "tv-processing-plan", "info", message);
          jobs.record(context, "tv-review", "warn", tvResult.plan.executionBlocker);
          jobs.record(context, "tv-identification", tvResult.identification.selected ? "info" : "warn",
            JSON.stringify(tvResult.identification));
          try {
            jobs.updateDiscRecovery(fingerprint, {
              identificationDiagnostics: tvResult.identification as unknown as Record<string, unknown>
            });
          } catch {
            // Diagnostics persistence is best-effort and must not block review.
          }
          jobs.record(context, "metadata-lookups", tvResult.metadataLookups.some((lookup) => lookup.failures.length) ? "warn" : "info",
            JSON.stringify({
              lookups: tvResult.metadataLookups
            }));
          jobs.record(context, "tv-analysis", "info", JSON.stringify({
            analysis: tvResult.analysis,
            matching: tvResult.matches,
            plan: tvResult.plan
          }));
          const classificationDetails = {
            classification: tvAssessment.classification,
            finalMediaType,
            mediaTypeOverridden: recovery.mediaTypeOverridden,
            confidence: tvAssessment.confidence,
            criteria: tvAssessment.criteria,
            reasons: tvAssessment.reasons
          };
          jobs.record(context, "tv-classification", "info", JSON.stringify(classificationDetails));
          const staged = await this.stageTvDisc({
            source, sources, jobs, metadata, signal, devicePath
          }, context, fingerprint, tvResult);
          setRuntimeStatus(staged === "completed" ? "completed" : "idle");
          notifyStatus();
          return true;
        }
        const message = `TV ${tvAssessment.classification} analysis did not produce a report; staging the disc for manual identification.`;
        jobs.record(context, "tv-classification", "warn", message);
        const staged = await this.stageTvDisc({
          source, sources, jobs, metadata, signal, devicePath
        }, context, fingerprint, null, message);
        setRuntimeStatus(staged === "completed" ? "completed" : "idle");
        notifyStatus();
        return true;
      } catch (error) {
        const cancelled = jobs.wasJobCancelled(context);
        const interrupted = Boolean(signal.aborted && !cancelled);
        const message = error instanceof Error ? error.message : "TV analysis failed";
        if (cancelled || interrupted) {
          jobs.fail(context, cancelled ? "cancelled" : "interrupted", {
            code: cancelled ? "cancelled" : "interrupted",
            message,
            recoverable: true,
            reviewCategory: "tv_review"
          });
          setRuntimeStatus("idle");
        } else {
          if (jobs.getTvMatchingTask(context.id)) {
            jobs.fail(context, "failed", {
              code: "tv_staging_failed",
              message,
              recoverable: true,
              reviewCategory: "tv_review"
            });
            setRuntimeStatus("failed");
          } else {
            try {
              await this.stageTvDisc({
                source, sources, jobs, metadata, signal, devicePath
              }, context, fingerprint, null, message);
              setRuntimeStatus("idle");
            } catch (stagingError) {
              const stagingMessage = stagingError instanceof Error ? stagingError.message : "TV staging failed";
              jobs.fail(context, "failed", {
                code: "tv_staging_failed",
                message: `TV analysis failed (${message}); staging also failed (${stagingMessage})`,
                recoverable: true,
                reviewCategory: "tv_review",
                reviewDetails: { analysisFailure: message, stagingFailure: stagingMessage }
              });
              setRuntimeStatus("failed");
            }
          }
        }
        notifyStatus();
        return true;
      }
    }
    const workDir = join(settings.workDir, id);
    let finalPath: string | null = null;
    let movieDirectory: string | null = null;
    let successful = false;
    let failure: string | null = null;
    let movieIdentificationReviewRequired = false;
    let movieReviewEvidence: Record<string, unknown> | undefined;
    let conversionStartedAt: number | undefined;
    let reviewWorkspace: { job: ReviewJob; mediaPath: string } | undefined;
    let failureStage = "metadata";
    let resumeStage: ReviewResumeStage = "metadata";

    try {
      notifyStatus();
      await this.ensureWritable(settings.workDir, minimumWorkBytes);
      await this.ensureWritable(settings.moviesDir, minimumOutputBytes);
      await mkdir(workDir, { recursive: true, mode: 0o750 });

      jobs.step(context, {
        id: "acquire-source",
        status: "ripping",
        message: "Ripping the selected video title with the registered source provider"
      });
      notifyStatus();
      const acquired = await sources.acquire(source, workDir, {
        selection: { manifestItemId: String(selectedTitle.id) }
      }, signal);
      let input = acquired.artifacts.find((artifact) => artifact.kind === "video")?.path;
      if (!input) throw new Error(`Source provider ${info.providerId} returned no video artifact`);
      context.throwIfCancelled();
      if (this.reviewWorkspaces) {
        reviewWorkspace = await this.reviewWorkspaces.create({
          id,
          originalJobId: id,
          discType: info.mediaKind,
          discLabel,
          metadata: { title: null, selectedTitle: selectedTitle.name, providerId: info.providerId },
          workDir: settings.workDir,
          mediaSource: input
        });
        input = reviewWorkspace.mediaPath;
      }

      let title: MetadataResult;
      let restoredMovieMetadata = false;
      if (recovery.metadataProvider === "tmdb" && recovery.providerId &&
        recovery.importedMetadata?.entityType === "movie" &&
        typeof recovery.importedMetadata.title === "string") {
        const recoveredCandidate: MetadataCandidate = {
          id: recovery.providerId,
          providerId: "metadata.tmdb.movie",
          entityType: "movie",
          title: recovery.importedMetadata.title,
          confidence: 1,
          metadata: recovery.importedMetadata,
          identifiers: { tmdbMovieId: recovery.providerId }
        };
        title = { selected: recoveredCandidate, candidates: [recoveredCandidate], providerFailures: [] };
        restoredMovieMetadata = true;
      } else {
        const movieQuery = normalizeVolumeTitle(filesystemVolumeName || info.label.trim() || selectedTitle.name);
        title = await metadata.resolve({ entityType: "movie", query: movieQuery }, signal);
      }
      for (const providerFailure of title.providerFailures) {
        log("warn", "metadata", providerFailure.message, { providerId: providerFailure.providerId });
      }
      const selectedCandidate = title.selected && title.selected.title.trim() &&
        !isGeneratedUnknownTitle(title.selected.title)
        ? title.selected
        : undefined;
      const confidenceThreshold = settings.movieIdentificationMinimumConfidence;
      const confidentMatch = selectedCandidate !== undefined &&
        selectedCandidate.confidence >= confidenceThreshold;
      if (!confidentMatch) {
        const candidates = movieCandidatesForReview(title.candidates);
        const fallbackTitle = normalizeVolumeTitle(
          filesystemVolumeName || info.label.trim() || selectedTitle.name
        ) || `Unknown Title ${new Date().toISOString().slice(0, 10)}`;
        const namingSource: MovieNamingSource = filesystemVolumeName
          ? "Filesystem volume name"
          : "Fallback";
        const message = selectedCandidate
          ? `Movie candidate confidence ${selectedCandidate.confidence.toFixed(2)} is below the configured ${confidenceThreshold.toFixed(2)} threshold. Manual confirmation is required.`
          : `No movie metadata candidate met the configured ${confidenceThreshold.toFixed(2)} confidence threshold. Manual confirmation is required.`;
        movieIdentificationReviewRequired = true;
        movieReviewEvidence = {
          namingSource,
          sourceLabel: info.label.trim() || null,
          filesystemVolumeName: filesystemVolumeName || null,
          metadataQuery: normalizeVolumeTitle(filesystemVolumeName || info.label.trim() || selectedTitle.name) || null,
          confidence: selectedCandidate?.confidence ?? null,
          minimumConfidence: confidenceThreshold,
          candidates,
          evidence: [
            {
              type: "positive",
              message: `Disc volume name: ${filesystemVolumeName || "Unavailable"}`
            },
            ...(selectedCandidate ? [{
              type: "neutral",
              message: `Metadata candidate: ${selectedCandidate.title}`
            }] : []),
            {
              type: "negative",
              message: selectedCandidate
                ? `Confidence ${selectedCandidate.confidence.toFixed(2)} is below threshold ${confidenceThreshold.toFixed(2)}`
                : "No metadata candidate met the confidence threshold"
            },
            { type: "neutral", message: "Action: Manual confirmation required" }
          ],
          providerFailures: title.providerFailures
        };
        if (reviewWorkspace) {
          await this.reviewWorkspaces?.updateMetadata(id, {
            title: null,
            suggestedTitle: fallbackTitle,
            namingSource,
            filesystemVolumeName: filesystemVolumeName || null,
            sourceLabel: info.label.trim() || null,
            movieCandidates: candidates,
            movieIdentificationRequiresConfirmation: true,
            movieIdentificationConfirmed: false,
            movieIdentificationEvidence: movieReviewEvidence
          });
        }
        jobs.record(context, "movie-identification", "warn", JSON.stringify({
          ...movieReviewEvidence,
          action: "Manual confirmation required"
        }));
        throw new Error(message);
      }
      let selectedMetadata = selectedCandidate;
      if (selectedMetadata && !restoredMovieMetadata && settings.libraryMetadata.automaticImport &&
        settings.libraryMetadata.downloadMovieMetadata) {
        try {
          selectedMetadata = await metadata.enrich(selectedMetadata, signal);
        } catch (error) {
          log("warn", "metadata", "Could not import complete movie metadata; continuing with available identification data", {
            providerId: selectedMetadata.providerId,
            error: error instanceof Error ? error.message : "unknown metadata import failure"
          });
        }
      }
      if (selectedMetadata && !restoredMovieMetadata) {
        const providerId = selectedMetadata.identifiers?.tmdbMovieId ?? selectedMetadata.id;
        const importedMetadata = { ...selectedMetadata.metadata, entityType: "movie" };
        jobs.updateDiscRecovery(fingerprint, {
          metadataProvider: "tmdb",
          providerId,
          importedMetadata,
          artworkReferences: artworkFromMetadata(importedMetadata)
        });
      }
      const metadataValues = selectedMetadata?.metadata ?? {};
      const fallbackTitle = normalizeVolumeTitle(
        filesystemVolumeName || info.label.trim() || selectedTitle.name
      ) || `Unknown Title ${new Date().toISOString().slice(0, 10)}`;
      const namingSource: MovieNamingSource = selectedMetadata
        ? "Metadata match"
        : filesystemVolumeName ? "Filesystem volume name" : "Fallback";
      const metadataTitle = typeof metadataValues.title === "string" && metadataValues.title.trim() &&
        !isGeneratedUnknownTitle(metadataValues.title)
        ? metadataValues.title
        : selectedMetadata?.title;
      const movieTitle = metadataTitle ?? fallbackTitle;
      const movieYear = typeof metadataValues.year === "string" || typeof metadataValues.year === "number"
        ? metadataValues.year
        : undefined;
      const resolvedTitle = selectedMetadata?.title ?? fallbackTitle;
      const cleanTitle = safeTitle(resolvedTitle);
      if (reviewWorkspace) await this.reviewWorkspaces?.updateMetadata(id, { title: cleanTitle, namingSource });
      jobs.update(context, { title: cleanTitle });
      jobs.record(context, "movie-identification", "info", JSON.stringify({
        namingSource,
        sourceLabel: info.label.trim() || null,
        filesystemVolumeName: filesystemVolumeName || null,
        confidence: selectedMetadata?.confidence ?? null,
        minimumConfidence: confidenceThreshold,
        title: cleanTitle
      }));
      jobs.record(context, "title", "info", `Title selected from ${namingSource}`);

      failureStage = "naming";
      resumeStage = "naming";
      jobs.step(context, { id: "convert-media", status: "converting", message: "Converting with FFmpeg" });
      notifyStatus();
      const folderName = renderLibraryTemplate(libraryTemplate(settings.libraryMetadata, "movieFolderTemplate"), {
        "Movie Title": movieTitle,
        Year: movieYear
      });
      const fileName = renderLibraryTemplate(libraryTemplate(settings.libraryMetadata, "movieFileTemplate"), {
        "Movie Title": movieTitle,
        Year: movieYear
      });
      const movieOutput = await createMovieOutput(settings.moviesDir, folderName, settings.format, fileName);
      movieDirectory = movieOutput.directory;
      const targetPath = movieOutput.path;
      finalPath = targetPath;
      conversionStartedAt = Date.now();
      failureStage = "conversion";
      const conversionStart = conversionStartedAt;
      const encoded = await this.converter(input, targetPath, cleanTitle, settings, (encoder) => {
        jobs.step(context, {
          id: "publish-media",
          status: "publishing",
          message: "Validating and atomically publishing the completed movie"
        });
        jobs.update(context, {
          outputPath: targetPath,
          encoder: encoder.name,
          conversionSeconds: (Date.now() - conversionStart) / 1000
        });
        notifyStatus();
      }, (progress) => {
        jobs.update(context, { progress: Math.min(99, Math.round(progress * 100)) });
        events.emit("status");
      }, signal);

      context.throwIfCancelled();
      jobs.update(context, { conversionSeconds: (Date.now() - conversionStartedAt) / 1000 });
      const outputStat = await stat(targetPath);
      if (outputStat.size < 1024) throw new Error("Published movie failed size validation");
      try {
        const document = metadataDocument(movieTitle, selectedMetadata?.providerId,
          selectedMetadata?.id, settings.libraryMetadata.downloadMovieMetadata ? metadataValues : {});
        const assets = settings.libraryMetadata.downloadMovieMetadata && settings.libraryMetadata.automaticImport
          ? artworkFromMetadata(metadataValues) : [];
        await writeMetadataBundle(movieDirectory, "movie", document, assets, settings.libraryMetadata, {
          nfoFileName: "movie.nfo"
        });
      } catch (error) {
        log("warn", "metadata", "Movie metadata or artwork could not be fully written", {
          jobId: id,
          outputPath: movieDirectory,
          error: error instanceof Error ? error.message : "unknown metadata write failure"
        });
      }
      await applyPublishedPermissions(movieOutput.directory, settings.moviesDir);
      jobs.update(context, {
        outputPath: targetPath,
        outputBytes: encoded.outputBytes,
        encoder: encoded.encoder.name,
        progress: 100
      });
      successful = true;
    } catch (error) {
      failure = error instanceof Error ? error.message : "Unknown processing failure";
      if (conversionStartedAt !== undefined) {
        jobs.update(context, { conversionSeconds: (Date.now() - conversionStartedAt) / 1000 });
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
              }
            }
          } else {
            failure = `${failure ? `${failure}; ` : ""}Could not verify failed movie output before cleanup: ${error instanceof Error ? error.message : "unknown error"}`;
          }
        }
      }
      try {
        await rm(workDir, { recursive: true, force: true });
      } catch (error) {
        failure = `${failure ? `${failure}; ` : ""}Temporary-file cleanup failed: ${error instanceof Error ? error.message : "unknown error"}`;
        successful = false;
      }
    }

    if (successful) {
      jobs.complete(context, fingerprint);
      if (reviewWorkspace) {
        jobs.resolveJobReviews(id, "Processing completed successfully");
        await this.reviewWorkspaces?.remove(id);
      }
      setRuntimeStatus("completed");
      if (settings.autoEject || settings.automationMode === "full_auto") {
        try {
          await ejectDisc(devicePath);
          jobs.record(context, "eject", "info", "Disc ejected");
        } catch (error) {
          const message = `Eject failed: ${error instanceof Error ? error.message : "unknown error"}`;
          jobs.warn(context, message);
          log("warn", "eject", message, { jobId: id });
        }
      }
    } else {
      const cancelled = jobs.wasJobCancelled(context);
      const interrupted = Boolean(signal.aborted && !cancelled);
      const message = cancelled ? `Cancelled by user${failure ? `; ${failure}` : ""}` : failure ?? "Processing failed";
      if (reviewWorkspace && !cancelled && !interrupted) {
        await this.reviewWorkspaces?.markPending(id, { reason: message, stage: failureStage, resumeStage });
        if (movieIdentificationReviewRequired) {
          jobs.holdForMovieIdentificationReview(context, message, movieReviewEvidence ?? {});
        } else {
          jobs.holdForProcessingReview(context, message, failureStage, { resumeStage });
        }
      } else if (movieIdentificationReviewRequired && !cancelled && !interrupted) {
        jobs.holdForMovieIdentificationReview(context, message, movieReviewEvidence ?? {});
      } else {
        if (reviewWorkspace) await this.reviewWorkspaces?.remove(id);
        jobs.fail(context, cancelled ? "cancelled" : interrupted ? "interrupted" : "failed", {
          code: cancelled ? "cancelled" : interrupted ? "interrupted" : "processing_failed",
          message,
          recoverable: interrupted
        });
      }
      setRuntimeStatus(cancelled || interrupted ? "idle" : "failed");
    }
    notifyStatus();
    return true;
  }
}
