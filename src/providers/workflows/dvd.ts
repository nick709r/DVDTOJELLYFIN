import { access, mkdir, rm, rmdir, stat, statfs, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { MediaWorkflow, MediaWorkflowContext } from "../../application/media-workflow-registry.js";
import type { DiscTitle } from "../../model.js";
import { events, notifyStatus } from "../../events.js";
import { getLiveDiscDiagnostics, updateDiscDiagnostics } from "../../diagnostics.js";
import { convert } from "../../encoding.js";
import { ejectDisc, safeTitle, selectMainFeature } from "../../media.js";
import { setRuntimeStatus } from "../../runtime-status.js";
import { log } from "../../logger.js";
import { createMovieOutput } from "../../movie-output.js";
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
import type { JobContext } from "../../application/job-coordinator.js";
import type { DiscRecovery, EpisodeMapping } from "../../domain/disc-recovery.js";

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
    workflow: MediaWorkflowContext,
    job: JobContext,
    fingerprint: string,
    recovery: DiscRecovery,
    converter: typeof convert,
    ensureWritable: typeof assertWritableDirectory
  ): Promise<void> {
    const { source, sources, jobs, signal, devicePath } = workflow;
    const settings = jobs.getSettings();
    const info = source.candidate;
    const mappingByTrack = new Map(recovery.mappings.map((mapping) => [mapping.trackId, mapping]));
    const titleItems = info.manifest.items.filter((item) => item.kind === "title" && item.durationSeconds !== undefined);
    const unknownTrack = recovery.mappings.find((mapping) =>
      !titleItems.some((item) => item.id === mapping.trackId));
    if (unknownTrack) throw new Error(`Episode mapping references missing disc track ${unknownTrack.trackId}`);
    const missingEpisodes = titleItems.filter((item) =>
      (item.durationSeconds ?? 0) >= 600 &&
      !/\b(?:bonus|extra|featurette|trailer|commentary|interview)\b/i.test(item.title ?? "") &&
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
    const seriesDir = join(settings.tvRootDir, seriesFolder);
    const createdOutputs: string[] = [];
    const metadataTasks: Array<() => Promise<void>> = [];
    let totalOutputBytes = 0;
    let failureMessage: string | undefined;
    try {
      await ensureWritable(settings.workDir, minimumWorkBytes);
      await ensureWritable(settings.tvRootDir, minimumOutputBytes);
      await mkdir(workDir, { recursive: true, mode: 0o750 });
      await mkdir(seriesDir, { recursive: true, mode: 0o750 });
      if (metadataSettings.downloadSeriesMetadata || metadataSettings.generateNfo) {
        metadataTasks.push(async () => {
          try {
          const seriesMetadata = metadataDocument(seriesName, recovery.metadataProvider,
            recovery.providerId ?? undefined, metadataSettings.downloadSeriesMetadata ? importedMetadata : {});
          const artwork = artworkAssets(recovery.artworkReferences).filter((asset) =>
            asset.kind !== "season-poster" && asset.kind !== "episode-image");
          await writeMetadataBundle(seriesDir, "series", seriesMetadata,
            metadataSettings.automaticImport && metadataSettings.downloadSeriesMetadata ? artwork : [],
            metadataSettings, { nfoFileName: "tvshow.nfo" });
          } catch (error) {
            log("warn", "metadata", "TV series metadata or artwork could not be fully written", {
              jobId: job.id,
              error: error instanceof Error ? error.message : "unknown metadata write failure"
            });
          }
        });
      }
      for (const [index, { item, mapping }] of selected.entries()) {
        job.throwIfCancelled();
        const baseName = episodeOutputName(seriesName, mapping,
          libraryTemplate(metadataSettings, "episodeFileTemplate"));
        const seasonNumber = mapping.episodes[0]?.seasonNumber;
        if (seasonNumber === undefined) throw new Error(`Track ${item.id} has no season assignment`);
        const seasonName = renderLibraryTemplate(libraryTemplate(metadataSettings, "seasonFolderTemplate"), {
          "Season Number": seasonNumber,
          Season: seasonNumber
        });
        const seasonDir = join(seriesDir, seasonName);
        await mkdir(seasonDir, { recursive: true, mode: 0o750 });
        if (metadataSettings.automaticImport && metadataSettings.downloadSeriesMetadata) {
          metadataTasks.push(async () => {
            try {
            const seasonArtwork = artworkAssets(recovery.artworkReferences).filter((asset) => asset.kind === "season-poster");
            await downloadArtwork(seasonDir, seasonArtwork, metadataSettings);
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
            await writeNfo(seasonDir, "season.nfo", "season", {
              title: seasonName,
              season: seasonNumber,
              provider: recovery.metadataProvider,
              providerId: recovery.providerId
            }, metadataSettings);
            } catch (error) {
              log("warn", "metadata", "TV season NFO could not be written", {
                jobId: job.id, seasonNumber, error: error instanceof Error ? error.message : "unknown write failure"
              });
            }
          });
        }
        const targetPath = join(seasonDir, `${baseName}.${settings.format}`);
        const collision = await access(targetPath).then(() => true, (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        });
        if (collision) throw new Error(`Episode output already exists and was not overwritten: ${targetPath}`);

        jobs.step(job, {
          id: `acquire-tv-${item.id}`,
          status: "ripping",
          message: `Ripping TV disc track ${item.id} (${index + 1} of ${selected.length})`
        });
        const trackWorkDir = join(workDir, `track-${safeTitle(item.id)}`);
        await mkdir(trackWorkDir, { recursive: true, mode: 0o750 });
        const acquired = await sources.acquire(source, trackWorkDir, {
          selection: { manifestItemId: item.id }
        }, signal);
        const input = acquired.artifacts.find((artifact) => artifact.kind === "video")?.path;
        if (!input) throw new Error(`Source provider ${info.providerId} returned no video artifact for track ${item.id}`);
        const conversionStart = Date.now();
        const encoded = await converter(input, targetPath, baseName, settings, (encoder) => {
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
            await writeNfo(seasonDir, `${baseName}.nfo`, "episode", {
              ...episodeMetadata,
              ...(firstEpisode ? {
                season: firstEpisode.seasonNumber,
                episode: firstEpisode.episodeNumber,
                ...(firstEpisode.airDate ? { airDate: firstEpisode.airDate } : {}),
                ...(firstEpisode.notes ? { overview: firstEpisode.notes } : {})
              } : {})
            }, metadataSettings);
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
    if (settings.autoEject || settings.automationMode === "full_auto") {
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
    private readonly ensureWritable: typeof assertWritableDirectory = assertWritableDirectory
  ) {}

  async process({ source, sources, jobs, metadata, signal, devicePath }: MediaWorkflowContext): Promise<boolean> {
    const info = source.candidate;
    const settings = jobs.getSettings();
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
    const fingerprint = createHash("sha256").update(JSON.stringify({
      label: info.label.trim().normalize("NFKC").toLocaleLowerCase(),
      titles: titles.map((title) => [title.id, title.durationSeconds, title.name.trim().normalize("NFKC")])
    })).digest("hex");
    if (jobs.lastDiscFingerprint() === fingerprint) {
      log("info", "disc", "Already-processed disc is still inserted; ignoring duplicate detection event");
      setRuntimeStatus("completed");
      return true;
    }
    const id = randomUUID();
    const context = jobs.begin(id, info.label || null, info.mediaKind, fingerprint, signal, devicePath);
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
    const tvAssessment = assessTvDisc({
      sourceId: info.sourceId,
      providerId: info.providerId,
      mediaKind: info.mediaKind,
      label: info.label,
      manifest: info.manifest
    });
    const detectedMediaType = tvAssessment.classification === "movie" ? "movie" :
      tvAssessment.classification === "tv" ? "tv_series" : "mixed_content";
    const recovery = jobs.recordDiscDetection(fingerprint, "dvd", detectedMediaType, tvAssessment.confidence);
    const finalMediaType = recovery.mediaTypeOverridden ? recovery.finalMediaType : detectedMediaType;
    const isTvWorkflow = finalMediaType === "tv_series" ||
      (!recovery.mediaTypeOverridden && tvAssessment.classification !== "movie");
    const unsupportedOverride = (recovery.mediaTypeOverridden &&
      !["movie", "tv_series"].includes(recovery.finalMediaType)) ||
      (recovery.discTypeOverridden && recovery.finalDiscType !== "dvd");
    const tvAnalysisUnavailable = isTvWorkflow && !this.tvWorkflow &&
      !(recovery.seriesName && recovery.mappings.length > 0);
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
      tvConfidence: tvAssessment.confidence,
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
      criteria: tvAssessment.criteria.map((criterion, index) => ({
        ...criterion,
        weight: scoreWeights[index] ?? 0,
        contribution: criterion.passed ? scoreWeights[index] ?? 0 : 0
      })),
      reasons: tvAssessment.reasons,
      tvDetectionEnabled: tvEnabled
    }));

    if (unsupportedOverride || (isTvWorkflow && !tvEnabled) || tvAnalysisUnavailable) {
      const message = unsupportedOverride
        ? `The manually selected ${recovery.discTypeOverridden && recovery.finalDiscType !== "dvd"
          ? `disc type ${recovery.finalDiscType}` : `media type ${finalMediaType}`} is not supported by the DVD processing workflow; held for review.`
        : !tvEnabled
          ? `Disc matched ${tvAssessment.classification === "tv" ? "TV-series" : "possible TV-series"} criteria (heuristic confidence ${tvAssessment.confidence.toFixed(2)}), but TV detection is disabled; held for review instead of movie processing.`
          : `Disc matched ${tvAssessment.classification === "tv" ? "TV-series" : "possible TV-series"} criteria (heuristic confidence ${tvAssessment.confidence.toFixed(2)}), but TV analysis is unavailable; held for review instead of movie processing.`;
      jobs.holdForReview(context, message, {
        classification: tvAssessment.classification,
        finalMediaType,
        mediaTypeOverridden: recovery.mediaTypeOverridden,
        confidence: tvAssessment.confidence,
        criteria: tvAssessment.criteria,
        reasons: tvAssessment.reasons,
        tvDetectionEnabled: tvEnabled
      });
      setRuntimeStatus("idle");
      notifyStatus();
      return true;
    }

    if (isTvWorkflow && recovery.seriesName && recovery.mappings.length > 0) {
      try {
        await processMappedTvEpisodes({
          source, sources, jobs, metadata, signal, devicePath
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
        const tvResult = await this.tvWorkflow.prepare({
          sourceId: info.sourceId,
          providerId: info.providerId,
          mediaKind: info.mediaKind,
          label: info.label,
          manifest: info.manifest
        }, fingerprint, signal);
        if (tvResult) {
          const message = `TV ${tvAssessment.classification} candidate (heuristic confidence ${tvAssessment.confidence.toFixed(2)}). ${summarizeTvPlan(tvResult.plan)}`;
          jobs.update(context, { title: tvResult.plan.series?.title ?? info.label ?? null });
          jobs.record(context, "tv-processing-plan", "info", message);
          jobs.record(context, "tv-review", "warn", tvResult.plan.executionBlocker);
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
          jobs.holdForReview(context, message, classificationDetails);
          setRuntimeStatus("idle");
          notifyStatus();
          return true;
        }
        const classificationDetails = {
          classification: tvAssessment.classification,
          finalMediaType,
          mediaTypeOverridden: recovery.mediaTypeOverridden,
          confidence: tvAssessment.confidence,
          criteria: tvAssessment.criteria,
          reasons: tvAssessment.reasons,
          analysisUnavailable: true
        };
        jobs.record(context, "tv-classification", "warn",
          `TV ${tvAssessment.classification} classification (heuristic confidence ${tvAssessment.confidence.toFixed(2)}) was not analyzed; reasons: ${tvAssessment.reasons.join("; ") || "none"}.`);
        jobs.holdForReview(context, "Disc matched TV-series criteria, but TV analysis did not create a report. Held for review instead of movie processing.", classificationDetails);
        setRuntimeStatus("idle");
        notifyStatus();
        return true;
      } catch (error) {
        const cancelled = jobs.wasJobCancelled(context);
        const interrupted = Boolean(signal.aborted && !cancelled);
        jobs.fail(context, cancelled ? "cancelled" : interrupted ? "interrupted" : "failed", {
          code: cancelled ? "cancelled" : interrupted ? "interrupted" : "tv_analysis_failed",
          message: error instanceof Error ? error.message : "TV analysis failed",
          recoverable: interrupted,
          reviewCategory: "tv_review"
        });
        setRuntimeStatus(cancelled || interrupted ? "idle" : "failed");
        notifyStatus();
        return true;
      }
    }
    const workDir = join(settings.workDir, id);
    let finalPath: string | null = null;
    let movieDirectory: string | null = null;
    let successful = false;
    let failure: string | null = null;
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
          discLabel: info.label || null,
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
        title = await metadata.resolve({ entityType: "movie", query: info.label || selectedTitle.name }, signal);
      }
      for (const providerFailure of title.providerFailures) {
        log("warn", "metadata", providerFailure.message, { providerId: providerFailure.providerId });
      }
      if (settings.metadataEnabled && !title.selected && title.providerFailures.length > 0) {
        throw new Error(`Metadata lookup failed: ${title.providerFailures.map((item) => item.message).join("; ")}`);
      }
      let selectedMetadata = title.selected;
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
      const movieTitle = typeof metadataValues.title === "string" ? metadataValues.title : selectedMetadata?.title ??
        (info.label.trim() || selectedTitle.name || `Unknown Title ${new Date().toISOString().slice(0, 10)}`);
      const movieYear = typeof metadataValues.year === "string" || typeof metadataValues.year === "number"
        ? metadataValues.year
        : undefined;
      const resolvedTitle = selectedMetadata?.title ??
        (info.label.trim() || selectedTitle.name || `Unknown Title ${new Date().toISOString().slice(0, 10)}`);
      const cleanTitle = safeTitle(resolvedTitle);
      if (reviewWorkspace) await this.reviewWorkspaces?.updateMetadata(id, { title: cleanTitle });
      jobs.update(context, { title: cleanTitle });
      jobs.record(context, "title", "info", `Title selected from ${title.selected?.providerId ?? "disc-label"}`);

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
        jobs.holdForProcessingReview(context, message, failureStage, { resumeStage });
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
