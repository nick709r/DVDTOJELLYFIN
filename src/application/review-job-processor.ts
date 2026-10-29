import { rm, stat } from "node:fs/promises";
import type { JobCoordinator } from "./job-coordinator.js";
import type { ReviewJobRepository } from "../domain/review-jobs.js";
import type { ReviewWorkspaceService } from "./review-workspace-service.js";
import type { AppSettings } from "../model.js";
import type { MetadataResolver } from "./metadata-resolver.js";
import type { JobContext } from "./job-coordinator.js";
import { convert } from "../encoding.js";
import { createMovieOutput } from "../movie-output.js";
import { applyPublishedPermissions } from "../published-media-permissions.js";
import { isGeneratedUnknownTitle, normalizeVolumeTitle, safeTitle } from "../media.js";
import { events, notifyStatus } from "../events.js";
import { setRuntimeStatus } from "../runtime-status.js";

export class ReviewJobProcessor {
  constructor(
    private readonly reviewJobs: ReviewJobRepository,
    private readonly workspaces: ReviewWorkspaceService,
    private readonly jobs: JobCoordinator,
    private readonly getSettings: () => AppSettings,
    private readonly metadata: MetadataResolver,
    private readonly converter = convert
  ) {}

  async continue(id: string): Promise<void> {
    const review = this.reviewJobs.get(id);
    if (!review || (review.status !== "pending" && review.status !== "retrying")) {
      throw new Error("Review job is not available to continue");
    }
    const storedTitle = typeof review.metadata.title === "string" ? review.metadata.title.trim() : "";
    const generatedUnknownTitle = storedTitle.length > 0 && isGeneratedUnknownTitle(storedTitle);
    const explicitlyNamedUnknownTitle = /^Unknown Title \d{4}-\d{2}-\d{2}$/i.test(storedTitle);
    if (generatedUnknownTitle && !explicitlyNamedUnknownTitle) {
      throw new Error("Movie title normalizes to the generated unknown-title fallback; enter a usable title or explicitly confirm that fallback");
    }
    const needsMovieConfirmation = review.metadata.movieIdentificationRequiresConfirmation === true ||
      generatedUnknownTitle ||
      (storedTitle.length > 0 && review.metadata.namingSource !== "Metadata match" &&
        review.metadata.movieIdentificationConfirmed !== true);
    if (needsMovieConfirmation &&
      review.metadata.movieIdentificationConfirmed !== true) {
      throw new Error("A movie title must be explicitly confirmed before publishing");
    }
    if (this.jobs.activeJob()) throw new Error("Another media job is already active");
    const mediaFiles = await this.workspaces.mediaFiles(id);
    const mediaPath = mediaFiles[0];
    if (!mediaPath) throw new Error("Review workspace contains no extracted media");
    const mediaInfo = await stat(mediaPath);
    if (!mediaInfo.isFile() || mediaInfo.size < 1024) throw new Error("Preserved media failed file validation");

    const controller = new AbortController();
    this.jobs.beginOperation(controller);
    let context: JobContext;
    try {
      context = this.jobs.resume(review.originalJobId, review.discType, null, review.discLabel, controller.signal);
    } catch (error) {
      this.jobs.endOperation(controller);
      throw error;
    }
    this.reviewJobs.update(id, { status: "retrying" });
    setRuntimeStatus("inspecting");
    notifyStatus();
    let outputDirectory: string | undefined;
    let outputPath: string | undefined;
    const settings = this.getSettings();
    let failureStage = review.failureStage;
    let resumeStage = review.resumeStage;
    let titleValue = storedTitle
      ? storedTitle
      : undefined;
    let title = safeTitle(titleValue || review.discLabel || "Unknown Title");
    let namingSource = review.metadata.movieIdentificationConfirmed === true
      ? "User review"
      : typeof review.metadata.namingSource === "string" ? review.metadata.namingSource : "Fallback";
    try {
      if (review.resumeStage === "metadata" && !titleValue) {
        failureStage = "metadata";
        resumeStage = "metadata";
        const volumeName = typeof review.metadata.filesystemVolumeName === "string"
          ? review.metadata.filesystemVolumeName
          : "";
        const result = await this.metadata.resolve({
          entityType: "movie",
          query: normalizeVolumeTitle(volumeName || review.discLabel || "")
        }, controller.signal);
        const selected = result.selected && result.selected.title.trim() &&
          !isGeneratedUnknownTitle(result.selected.title) ? result.selected : undefined;
        if (!selected || selected.confidence < settings.movieIdentificationMinimumConfidence) {
          const reason = selected
            ? `Movie candidate confidence ${selected.confidence.toFixed(2)} is below the configured ${settings.movieIdentificationMinimumConfidence.toFixed(2)} threshold`
            : "No movie metadata candidate met the configured confidence threshold";
          const providerFailures = result.providerFailures.map((item) => item.message).join("; ");
          throw new Error(providerFailures ? `${reason}; ${providerFailures}` : `${reason}; manual title confirmation is required`);
        }
        titleValue = selected.title;
        namingSource = "Metadata match";
      }
      if (!titleValue) {
        throw new Error("A movie title must be explicitly confirmed before publishing");
      }
      title = safeTitle(titleValue);
      this.jobs.record(context, "movie-identification", "info", JSON.stringify({ namingSource, title }));
      failureStage = "naming";
      resumeStage = "naming";
      const output = await createMovieOutput(settings.moviesDir, title, settings.format);
      outputDirectory = output.directory;
      outputPath = output.path;
      const start = Date.now();
      const result = await this.converter(mediaPath, output.path, title, settings, (encoder) => {
        this.jobs.step(context, {
          id: "publish-media",
          status: "publishing",
          message: "Validating and publishing the reviewed movie"
        });
        this.jobs.update(context, { outputPath: output.path, encoder: encoder.name });
      }, (progress) => {
        this.jobs.update(context, { progress: Math.min(99, Math.round(progress * 100)) });
        events.emit("status");
      }, controller.signal);
      context.throwIfCancelled();
      const outputInfo = await stat(output.path);
      if (outputInfo.size < 1024) throw new Error("Published movie failed size validation");
      await applyPublishedPermissions(output.directory, settings.moviesDir);
      this.jobs.update(context, {
        title,
        outputPath: output.path,
        encoder: result.encoder.name,
        outputBytes: result.outputBytes,
        conversionSeconds: (Date.now() - start) / 1000,
        progress: 100
      });
      this.jobs.complete(context);
      this.jobs.resolveJobReviews(context.id, "Preserved media was processed successfully");
      this.reviewJobs.update(id, { status: "completed", notificationActive: false });
      await this.workspaces.remove(id).catch(() => undefined);
      setRuntimeStatus("completed");
    } catch (error) {
      if (outputPath) await rm(outputPath, { force: true }).catch(() => undefined);
      if (outputDirectory) {
        await rm(outputDirectory, { recursive: false, force: true }).catch(() => undefined);
      }
      const message = error instanceof Error ? error.message : "Review processing failed";
      this.jobs.record(context, "review-processing", "warn", message);
      this.jobs.finishForReview(context, message);
      await this.workspaces.markPending(id, {
        reason: message,
        stage: failureStage,
        resumeStage,
        metadata: {
          ...review.metadata,
          ...(titleValue ? { title: titleValue, namingSource } : {})
        }
      });
      setRuntimeStatus("idle");
      throw error;
    } finally {
      this.jobs.endOperation(controller);
      notifyStatus();
    }
  }
}
