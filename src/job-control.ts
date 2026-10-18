interface DiscOperation {
  controller: AbortController;
  jobId: string | null;
  cancellationRequested: boolean;
}

let currentOperation: DiscOperation | undefined;

export function beginDiscOperation(controller: AbortController): void {
  if (currentOperation) throw new Error("A disc operation is already active");
  currentOperation = { controller, jobId: null, cancellationRequested: false };
}

export function registerActiveJob(jobId: string): void {
  if (!currentOperation) return;
  currentOperation.jobId = jobId;
}

export function cancelActiveJob(jobId: string): boolean {
  if (!currentOperation || currentOperation.jobId !== jobId || currentOperation.controller.signal.aborted) return false;
  currentOperation.cancellationRequested = true;
  currentOperation.controller.abort(new Error("Cancelled by user"));
  return true;
}

export function wasJobCancelled(jobId: string): boolean {
  return currentOperation?.jobId === jobId && currentOperation.cancellationRequested;
}

export function endDiscOperation(controller: AbortController): void {
  if (currentOperation?.controller === controller) currentOperation = undefined;
}
