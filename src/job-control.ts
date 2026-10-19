import type { JobCancellationControl } from "./contracts/job-control.js";

interface DiscOperation {
  controller: AbortController;
  jobId: string | null;
  cancellationRequested: boolean;
}

class InProcessJobControl implements JobCancellationControl {
  private currentOperation: DiscOperation | undefined;

  begin(controller: AbortController): void {
    if (this.currentOperation) throw new Error("A disc operation is already active");
    this.currentOperation = { controller, jobId: null, cancellationRequested: false };
  }

  register(jobId: string): void {
    if (!this.currentOperation) return;
    this.currentOperation.jobId = jobId;
  }

  cancel(jobId: string): boolean {
    const operation = this.currentOperation;
    if (!operation || operation.jobId !== jobId || operation.controller.signal.aborted) return false;
    operation.cancellationRequested = true;
    operation.controller.abort(new Error("Cancelled by user"));
    return true;
  }

  wasCancelled(jobId: string): boolean {
    return this.currentOperation?.jobId === jobId && this.currentOperation.cancellationRequested;
  }

  end(controller: AbortController): void {
    if (this.currentOperation?.controller === controller) this.currentOperation = undefined;
  }
}

export const jobControl: JobCancellationControl = new InProcessJobControl();

export const beginDiscOperation = (controller: AbortController): void => jobControl.begin(controller);
export const registerActiveJob = (jobId: string): void => jobControl.register(jobId);
export const cancelActiveJob = (jobId: string): boolean => jobControl.cancel(jobId);
export const wasJobCancelled = (jobId: string): boolean => jobControl.wasCancelled(jobId);
export const endDiscOperation = (controller: AbortController): void => jobControl.end(controller);
