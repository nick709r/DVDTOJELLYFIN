export type MetricSubscriber<T> = (snapshot: T) => boolean;

export class DashboardMetricSampler<T> {
  private readonly subscribers = new Set<MetricSubscriber<T>>();
  private timer: NodeJS.Timeout | undefined;
  private abortController: AbortController | undefined;
  private sampling = false;

  constructor(
    private readonly collect: (signal: AbortSignal) => Promise<T>,
    private readonly intervalMs: number,
    private readonly onError: (error: unknown) => void
  ) {}

  subscribe(subscriber: MetricSubscriber<T>): () => void {
    this.subscribers.add(subscriber);
    if (!this.timer) this.start();
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.subscribers.delete(subscriber);
      if (this.subscribers.size === 0) this.stop();
    };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.abortController?.abort();
    this.abortController = undefined;
  }

  private start(): void {
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    void this.tick(signal);
    this.timer = setInterval(() => void this.tick(signal), this.intervalMs);
  }

  private async tick(signal: AbortSignal): Promise<void> {
    if (this.sampling || signal.aborted || this.subscribers.size === 0) return;
    this.sampling = true;
    try {
      const snapshot = await this.collect(signal);
      if (signal.aborted) return;
      for (const subscriber of this.subscribers) {
        if (!subscriber(snapshot)) this.subscribers.delete(subscriber);
      }
      if (this.subscribers.size === 0) this.stop();
    } catch (error) {
      if (!signal.aborted) this.onError(error);
    } finally {
      this.sampling = false;
    }
  }
}
