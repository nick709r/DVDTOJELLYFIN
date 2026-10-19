export interface JobCancellationControl {
  begin(controller: AbortController): void;
  register(jobId: string): void;
  cancel(jobId: string): boolean;
  wasCancelled(jobId: string): boolean;
  end(controller: AbortController): void;
}
