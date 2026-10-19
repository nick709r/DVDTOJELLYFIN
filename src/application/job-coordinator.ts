import type { AutoDiscRepositories } from "../contracts/repositories.js";
import type { JobCancellationControl } from "../contracts/job-control.js";
import type { Job, JobStatus } from "../model.js";
import type { ReviewItemInput, ReviewItem } from "../domain/reviews.js";

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

  activeJob(): Job | null {
    return this.repositories.jobs.active();
  }

  lastDiscFingerprint(): string | null {
    return this.repositories.recovery.lastDiscFingerprint();
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
    this.cancellation.register(id);
    this.publisher.publish(id, "inspecting");
    return {
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
    this.repositories.jobs.finish(context.id, "completed", null, fingerprint);
    if (fingerprint) this.repositories.reviewItems.resolveForDisc(fingerprint, "Related disc processing completed successfully");
    this.publisher.publish(context.id, "completed");
    return { jobId: context.id, status: "completed" };
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

  createReview(input: ReviewItemInput): ReviewItem {
    return this.repositories.reviewItems.create(input);
  }

  resolveJobReviews(jobId: string, resolutionDetails: string): void {
    for (const review of this.repositories.reviewItems.list({ status: "active", limit: 1000 })) {
      if (review.relatedJobId === jobId) {
        this.repositories.reviewItems.updateStatus(review.id, "resolved", resolutionDetails);
      }
    }
  }
}
