import type { AutoDiscRepositories } from "../contracts/repositories.js";
import type { JobCancellationControl } from "../contracts/job-control.js";
import type { Job, JobStatus } from "../model.js";

export interface JobStep {
  id: string;
  status: Extract<JobStatus, "ripping" | "converting" | "publishing">;
  message: string;
}

export interface JobFailure {
  code: string;
  message: string;
  recoverable: boolean;
}

export interface JobResult {
  jobId: string;
  status: "completed" | "failed" | "cancelled" | "interrupted";
  error?: JobFailure;
}

export interface JobContext {
  readonly id: string;
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
    signal?: AbortSignal
  ): JobContext {
    this.repositories.jobs.add(id, label, fingerprint, mediaKind);
    this.cancellation.register(id);
    this.publisher.publish(id, "inspecting");
    return {
      id,
      ...(signal ? { signal } : {}),
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
  }

  warn(context: JobContext, message: string): void {
    this.repositories.jobs.addWarning(context.id, message);
    this.publisher.publish(context.id);
  }

  complete(context: JobContext, fingerprint?: string): JobResult {
    this.repositories.jobs.finish(context.id, "completed", null, fingerprint);
    this.publisher.publish(context.id, "completed");
    return { jobId: context.id, status: "completed" };
  }

  fail(context: JobContext, status: "failed" | "cancelled" | "interrupted", failure: JobFailure): JobResult {
    this.repositories.jobs.finish(context.id, status, failure.message);
    this.publisher.publish(context.id, status);
    return { jobId: context.id, status, error: failure };
  }
}
