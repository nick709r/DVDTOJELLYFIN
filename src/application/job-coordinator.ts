import type { AutoDiscRepositories } from "../contracts/repositories.js";
import type { JobCancellationControl } from "../contracts/job-control.js";
import type { Job, JobStatus } from "../model.js";
import type { ReviewItemInput, ReviewItem } from "../domain/reviews.js";
import type { DiscRecovery, DiscRecoveryUpdate, DiscType, MediaType } from "../domain/disc-recovery.js";
import type { TvMatchingTask, TvMatchingTaskInput } from "../domain/tv-matching.js";

export interface JobStep {
  id: string;
  status: Extract<JobStatus, "ripping" | "converting" | "publishing">;
  message: string;
}

export interface JobFailure {
  code: string;
  message: string;
  recoverable: boolean;
  reviewCategory?: ReviewItem["category"];
  reviewDetails?: Readonly<Record<string, unknown>>;
}

export interface JobResult {
  jobId: string;
  status: "review" | "completed" | "failed" | "cancelled" | "interrupted";
  error?: JobFailure;
}

export interface JobContext {
  readonly id: string;
  readonly mediaKind: string;
  readonly fingerprint: string | null;
  readonly discLabel: string | null;
  readonly drivePath?: string;
  readonly signal?: AbortSignal;
  throwIfCancelled(): void;
}

export interface JobEventPublisher {
  publish(jobId: string, status?: JobStatus): void;
}

export class JobCoordinator {
  constructor(
    private readonly repositories: AutoDiscRepositories,
    private readonly publisher: JobEventPublisher,
    private readonly cancellation: JobCancellationControl
  ) {}

  beginOperation(controller: AbortController): void {
    this.cancellation.begin(controller);
  }

  endOperation(controller: AbortController): void {
    this.cancellation.end(controller);
  }

  cancelActiveJob(jobId: string): boolean {
    return this.cancellation.cancel(jobId);
  }

  wasJobCancelled(context: JobContext): boolean {
    return this.cancellation.wasCancelled(context.id);
  }

  getSettings() {
    return this.repositories.settings.get();
  }

  setupComplete(): boolean {
    return this.repositories.setup.get().setupComplete;
  }

  activeJob(): Job | null {
    return this.repositories.jobs.active();
  }

  latestJob(): Job | undefined {
    return this.repositories.history.list(1)[0];
  }

  getJob(id: string): Job | undefined {
    return this.repositories.history.get(id);
  }

  hasActiveDiscApproval(signature: string): boolean {
    return this.repositories.reviewItems.list({ category: "configuration_issue", status: "active", limit: 250 })
      .some((item) => item.errorDetails?.detectionSignature === signature);
  }

  lastDiscFingerprint(): string | null {
    return this.repositories.recovery.lastDiscFingerprint();
  }

  getDiscRecovery(fingerprint: string): DiscRecovery | undefined {
    return this.repositories.discRecovery.get(fingerprint);
  }

  recordDiscDetection(fingerprint: string, discType: DiscType, mediaType: MediaType, confidence?: number): DiscRecovery {
    return this.repositories.discRecovery.recordDetection(fingerprint, discType, mediaType, confidence);
  }

  updateDiscRecovery(fingerprint: string, patch: DiscRecoveryUpdate): DiscRecovery | undefined {
    return this.repositories.discRecovery.update(fingerprint, patch);
  }

  createTvMatchingTask(input: TvMatchingTaskInput): TvMatchingTask {
    return this.repositories.tvMatchingTasks.create(input);
  }

  getTvMatchingTask(jobId: string): TvMatchingTask | undefined {
    return this.repositories.tvMatchingTasks.get(jobId);
  }

  listTvMatchingTasks(): TvMatchingTask[] {
    return this.repositories.tvMatchingTasks.list();
  }

  updateTvMatchingTask(jobId: string, patch: Partial<Pick<TvMatchingTask,
    "status" | "stagingPath" | "diagnostics" | "files" | "assignments">> & { failure?: string | null }): TvMatchingTask | undefined {
    return this.repositories.tvMatchingTasks.update(jobId, patch);
  }

  deleteTvMatchingTask(jobId: string): boolean {
    return this.repositories.tvMatchingTasks.delete(jobId);
  }

  deleteTvMatchingRecords(jobId: string, fingerprint: string): boolean {
    return this.repositories.tvMatchingTasks.deleteTemporaryRecords(jobId, fingerprint);
  }

  listDiscRecoveries(limit = 100): DiscRecovery[] {
    return this.repositories.discRecovery.list(limit);
  }

  clearInsertedDisc(): void {
    this.repositories.recovery.clearInsertedDisc();
  }

  begin(
    id: string,
    label: string | null,
    mediaKind: string,
    fingerprint: string | null,
    signal?: AbortSignal,
    drivePath?: string
  ): JobContext {
    this.repositories.jobs.add(id, label, fingerprint, mediaKind);
    const context: JobContext = {
      id,
      mediaKind,
      fingerprint,
      discLabel: label,
      ...(signal ? { signal } : {}),
      ...(drivePath ? { drivePath } : {}),
      throwIfCancelled() {
        if (signal?.aborted) throw signal.reason ?? new Error("Job cancelled");
      }
    };
    try {
      this.cancellation.register(id);
      this.publisher.publish(id, "inspecting");
      return context;
    } catch (error) {
      try {
        this.fail(context, "failed", {
          code: "job_initialization_failed",
          message: error instanceof Error ? error.message : "Job initialization failed",
          recoverable: true
        });
      } catch {
        // The startup recovery path will interrupt the job if persistence is unavailable here.
      }
      throw error;
    }
  }

  resume(
    id: string,
    mediaKind: string,
    fingerprint: string | null,
    discLabel: string | null,
    signal: AbortSignal
  ): JobContext {
    const job = this.repositories.history.get(id);
    if (!job || (job.status !== "review" && job.status !== "awaiting-identification" &&
      job.status !== "failed" && job.status !== "interrupted")) {
      throw new Error(`Job ${id} is not available to resume`);
    }
    this.cancellation.register(id);
    this.repositories.jobs.setStatus(id, "converting", "Resuming from preserved extracted media");
    this.publisher.publish(id, "converting");
    return {
      id,
      mediaKind,
      fingerprint: fingerprint ?? job.discFingerprint,
      discLabel,
      signal,
      throwIfCancelled() {
        if (signal.aborted) throw signal.reason ?? new Error("Job cancelled");
      }
    };
  }

  step(context: JobContext, step: JobStep): void {
    context.throwIfCancelled();
    this.repositories.jobs.setStatus(context.id, step.status, step.message);
    this.publisher.publish(context.id, step.status);
  }

  update(context: JobContext, patch: Parameters<AutoDiscRepositories["jobs"]["update"]>[1]): void {
    this.repositories.jobs.update(context.id, patch);
  }

  record(context: JobContext, stage: string, level: string, message: string): void {
    this.repositories.events.add(context.id, stage, level, message);
    this.publisher.publish(context.id);
  }

  warn(context: JobContext, message: string): void {
    this.repositories.jobs.addWarning(context.id, message);
    this.createReview({
      category: "system_warning",
      severity: "medium",
      title: "Disc processing warning",
      description: message,
      relatedJobId: context.id,
      ...(context.discLabel ? { relatedDisc: context.discLabel } : {}),
      ...(context.drivePath ? { relatedDrive: context.drivePath } : {}),
      suggestedActions: [
        { type: "view-job", label: "View job details" },
        { type: "resolve", label: "Mark resolved" },
        { type: "dismiss", label: "Dismiss" }
      ],
      ...(context.fingerprint ? { discFingerprint: context.fingerprint } : {})
    });
    this.publisher.publish(context.id);
  }

  complete(context: JobContext, fingerprint?: string): JobResult {
    const completedFingerprint = fingerprint ?? context.fingerprint;
    this.repositories.jobs.finish(context.id, "completed", null, completedFingerprint ?? undefined);
    this.resolveJobReviews(context.id, "Related disc processing completed successfully");
    if (completedFingerprint) {
      this.repositories.reviewItems.resolveForDisc(completedFingerprint, "Related disc processing completed successfully");
    }
    this.publisher.publish(context.id, "completed");
    return { jobId: context.id, status: "completed" };
  }

  finishForReview(context: JobContext, message: string): void {
    this.repositories.jobs.finish(context.id, "review", message);
    this.publisher.publish(context.id, "review");
  }

  finishForIdentification(context: JobContext, message: string): void {
    this.repositories.jobs.finish(context.id, "awaiting-identification", message);
    this.createReview({
      category: "tv_review",
      severity: "medium",
      title: "TV disc awaiting identification",
      description: message,
      relatedJobId: context.id,
      ...(context.discLabel ? { relatedDisc: context.discLabel } : {}),
      ...(context.fingerprint ? { discFingerprint: context.fingerprint } : {}),
      suggestedActions: [{ type: "view-job", label: "Open TV Matching" }]
    });
    this.publisher.publish(context.id, "awaiting-identification");
  }

  interruptTvMatching(jobId: string, message: string): void {
    this.repositories.jobs.finish(jobId, "interrupted", message);
    this.publisher.publish(jobId, "interrupted");
  }

  holdForReview(
    context: JobContext,
    message: string,
    errorDetails?: Readonly<Record<string, unknown>>
  ): JobResult {
    this.repositories.jobs.finish(context.id, "review", message);
    const job = this.repositories.history.get(context.id);
    this.createReview({
      category: job?.mediaType === "audio_cd" ? "cd_review" : "tv_review",
      severity: "medium",
      title: job?.mediaType === "audio_cd" ? "Audio CD needs review" : "TV disc needs review",
      description: message,
      relatedJobId: context.id,
      ...(job?.discLabel ? { relatedDisc: job.discLabel } : {}),
      ...(errorDetails ? { errorDetails } : {}),
      suggestedActions: [
        { type: "view-job", label: "View job" },
        { type: "resolve", label: "Mark resolved" },
        { type: "dismiss", label: "Dismiss" }
      ],
      ...(context.fingerprint ? { discFingerprint: context.fingerprint } : {})
    });
    this.publisher.publish(context.id, "review");
    return {
      jobId: context.id,
      status: "review",
      error: { code: "review_required", message, recoverable: false }
    };
  }

  holdForProcessingReview(
    context: JobContext,
    message: string,
    failureStage: string,
    errorDetails?: Readonly<Record<string, unknown>>
  ): JobResult {
    this.repositories.jobs.finish(context.id, "review", message);
    this.createReview({
      category: "processing_failure",
      severity: "high",
      title: "Extracted media needs review",
      description: message,
      relatedJobId: context.id,
      ...(context.discLabel ? { relatedDisc: context.discLabel } : {}),
      errorDetails: { failureStage, ...(errorDetails ?? {}) },
      suggestedActions: [
        { type: "view-job", label: "View job details" },
        { type: "open-review", label: "Open review queue" }
      ],
      ...(context.fingerprint ? { discFingerprint: context.fingerprint } : {})
    });
    this.publisher.publish(context.id, "review");
    return {
      jobId: context.id,
      status: "review",
      error: { code: "review_required", message, recoverable: true }
    };
  }

  holdForMovieIdentificationReview(
    context: JobContext,
    message: string,
    errorDetails: Readonly<Record<string, unknown>>
  ): JobResult {
    this.repositories.jobs.finish(context.id, "review", message);
    const job = this.repositories.history.get(context.id);
    this.createReview({
      category: "metadata_issue",
      severity: "high",
      title: "Movie identification needs confirmation",
      description: message,
      relatedJobId: context.id,
      ...(job?.discLabel ? { relatedDisc: job.discLabel } : {}),
      ...(context.fingerprint ? { discFingerprint: context.fingerprint } : {}),
      ...(context.drivePath ? { relatedDrive: context.drivePath } : {}),
      errorDetails,
      suggestedActions: [
        { type: "open-review", label: "Review movie title" },
        { type: "view-job", label: "View job details" }
      ]
    });
    this.publisher.publish(context.id, "review");
    return {
      jobId: context.id,
      status: "review",
      error: { code: "movie_identification_review_required", message, recoverable: true }
    };
  }

  fail(context: JobContext, status: "failed" | "cancelled" | "interrupted", failure: JobFailure): JobResult {
    this.repositories.jobs.finish(context.id, status, failure.message);
    if (status === "failed" && failure.code !== "folder_creation_failed") {
      const job = this.repositories.history.get(context.id);
      const category = failure.reviewCategory ?? (job?.mediaType === "audio_cd" ? "cd_review" : "processing_failure");
      this.createReview({
        category,
        severity: "high",
        title: job?.mediaType === "audio_cd" ? "Audio CD processing failed" : "Processing failed",
        description: failure.message,
        relatedJobId: context.id,
        ...(job?.discLabel ? { relatedDisc: job.discLabel } : {}),
        errorDetails: {
          code: failure.code,
          recoverable: failure.recoverable,
          ...(failure.reviewDetails ?? {})
        },
        suggestedActions: [
          { type: "retry", label: "Retry with the disc inserted" },
          { type: "retry-after-correction", label: "Retry after correcting settings" },
          { type: "view-job", label: "View job details" },
          { type: "dismiss", label: "Dismiss" }
        ],
        ...(context.fingerprint ? { discFingerprint: context.fingerprint } : {}),
        ...(context.drivePath ? { relatedDrive: context.drivePath } : {})
      });
    }
    this.publisher.publish(context.id, status);
    return { jobId: context.id, status, error: failure };
  }

  failUnexpected(error: unknown, status: "failed" | "interrupted" = "failed"): JobResult | undefined {
    const job = this.activeJob();
    if (!job) return undefined;
    const message = error instanceof Error ? error.message : "Unexpected processing error";
    return this.fail({
      id: job.id,
      mediaKind: job.mediaType,
      fingerprint: job.discFingerprint,
      discLabel: job.discLabel,
      throwIfCancelled() {}
    }, status, {
      code: "unexpected_processing_exception",
      message,
      recoverable: true
    });
  }

  createReview(input: ReviewItemInput): ReviewItem {
    return this.repositories.reviewItems.create(input);
  }

  resolveJobReviews(jobId: string, resolutionDetails: string): void {
    if (!this.repositories.reviewItems?.list || !this.repositories.reviewItems?.updateStatus) return;
    for (const review of this.repositories.reviewItems.list({ status: "active", limit: 1000 })) {
      if (review.relatedJobId === jobId) {
        this.repositories.reviewItems.updateStatus(review.id, "resolved", resolutionDetails);
      }
    }
  }
}
