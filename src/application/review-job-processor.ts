import { rm, stat } from "node:fs/promises";
import type { JobCoordinator } from "./job-coordinator.js";
import type { ReviewJobRepository } from "../domain/review-jobs.js";
import type { ReviewWorkspaceService } from "./review-workspace-service.js";
import type { AppSettings } from "../model.js";
import type { MetadataResolver } from "./metadata-resolver.js";
import { convert } from "../encoding.js";
import { createMovieOutput } from "../movie-output.js";
import { safeTitle } from "../media.js";
import { events, notifyStatus } from "../events.js";
import { setRuntimeStatus } from "../runtime-status.js";

export class ReviewJobProcessor {
  constructor(
    private readonly reviewJobs: ReviewJobRepository,
    private readonly workspaces: ReviewWorkspaceService,
    private readonly jobs: JobCoordinator,
    private readonly getSettings: () => AppSettings,
    private readonly metadata: MetadataResolver
  ) {}

  async continue(id: string): Promise<void> {
    const review = this.reviewJobs.get(id);
    if (!review || (review.status !== "pending" && review.status !== "retrying")) {
      throw new Error("Review job is not available to continue");
    }
    if (this.jobs.activeJob()) throw new Error("Another media job is already active");
    const mediaFiles = await this.workspaces.mediaFiles(id);
    const mediaPath = mediaFiles[0];
    if (!mediaPath) throw new Error("Review workspace contains no extracted media");
    const mediaInfo = await stat(mediaPath);
    if (!mediaInfo.isFile() || mediaInfo.size < 1024) throw new Error("Preserved media failed file validation");

    const controller = new AbortController();
    this.jobs.beginOperation(controller);
    const context = this.jobs.resume(review.originalJobId, review.discType, null, review.discLabel, controller.signal);
    this.reviewJobs.update(id, { status: "retrying" });
    setRuntimeStatus("inspecting");
    notifyStatus();
    let outputDirectory: string | undefined;
    let outputPath: string | undefined;
    const settings = this.getSettings();
    let failureStage = review.failureStage;
    let resumeStage = review.resumeStage;
    let title = safeTitle(review.discLabel || "Unknown Title");
    try {
      let titleValue = review.metadata.title;
      if (review.resumeStage === "metadata" && !(typeof titleValue === "string" && titleValue.trim())) {
        failureStage = "metadata";
        resumeStage = "metadata";
        const result = await this.metadata.resolve({
          entityType: "movie",
          query: review.discLabel || ""
        }, controller.signal);
        if (settings.metadataEnabled && !result.selected && result.providerFailures.length > 0) {
          throw new Error(`Metadata lookup failed: ${result.providerFailures.map((item) => item.message).join("; ")}`);
        }
        titleValue = result.selected?.title ?? review.discLabel ?? "Unknown Title";
      }
      title = safeTitle(typeof titleValue === "string" && titleValue.trim()
        ? titleValue
        : review.discLabel || "Unknown Title");
      failureStage = "naming";
      resumeStage = "naming";
      const output = await createMovieOutput(settings.moviesDir, title, settings.format);
      outputDirectory = output.directory;
      outputPath = output.path;
      const start = Date.now();
      const result = await convert(mediaPath, output.path, title, settings, (encoder) => {
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
      await this.workspaces.remove(id);
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
        metadata: { ...review.metadata, title }
      });
      setRuntimeStatus("idle");
      throw error;
    } finally {
      this.jobs.endOperation(controller);
      notifyStatus();
    }
  }
}
