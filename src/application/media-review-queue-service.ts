import {
  MediaReviewError,
  type MediaReviewCompletion,
  type MediaReviewCompletionResult,
  type MediaReviewFilter,
  type MediaReviewItem,
  type MediaReviewItemAdapter
} from "../domain/media-review.js";
import { log } from "../logger.js";

/** The single review queue. Storage and media specifics live behind adapters. */
export class MediaReviewQueueService {
  private readonly adapters = new Map<string, MediaReviewItemAdapter>();
  private readonly inFlight = new Set<string>();

  register(adapter: MediaReviewItemAdapter): void {
    if (this.adapters.has(adapter.sourceKind)) {
      throw new Error(`A review adapter for ${adapter.sourceKind} is already registered`);
    }
    this.adapters.set(adapter.sourceKind, adapter);
  }

  list(filter: MediaReviewFilter = {}): MediaReviewItem[] {
    const items: MediaReviewItem[] = [];
    for (const adapter of this.adapters.values()) {
      if (filter.sourceKind && adapter.sourceKind !== filter.sourceKind) continue;
      try {
        items.push(...adapter.list());
      } catch (error) {
        // One unreadable store must not hide the other review items.
        log("error", "review-queue", "Review adapter failed to list items", {
          sourceKind: adapter.sourceKind,
          error: error instanceof Error ? error.message : "unknown"
        });
      }
    }
    return items
      .filter((item) => (!filter.mediaType || item.mediaType === filter.mediaType) &&
        (!filter.status || item.status === filter.status))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
  }

  get(id: string): MediaReviewItem | undefined {
    const { adapter, sourceId } = this.resolve(id);
    return adapter?.get(sourceId);
  }

  summary(): { total: number; pending: number; byMediaType: Record<string, number> } {
    const items = this.list().filter((item) => item.status === "pending");
    const byMediaType: Record<string, number> = {};
    for (const item of items) byMediaType[item.mediaType] = (byMediaType[item.mediaType] ?? 0) + 1;
    return { total: items.length, pending: items.length, byMediaType };
  }

  async complete(id: string, input: MediaReviewCompletion): Promise<MediaReviewCompletionResult> {
    const { adapter, sourceId } = this.resolve(id);
    if (!adapter) throw new MediaReviewError("not-found", "Review item not found");
    if (!adapter.get(sourceId)) throw new MediaReviewError("not-found", "Review item not found");
    if (!adapter.complete) {
      throw new MediaReviewError("unsupported", "This kind of review cannot be completed");
    }
    const key = `${adapter.sourceKind}:${sourceId}`;
    if (this.inFlight.has(key)) {
      throw new MediaReviewError("conflict", "This review item is already being completed");
    }
    this.inFlight.add(key);
    let result: MediaReviewCompletionResult;
    try {
      result = await adapter.complete(sourceId, input);
    } finally {
      this.inFlight.delete(key);
    }
    log("info", "review-queue", "Review item completed", {
      id, mediaType: result.item.mediaType, selectedTitle: result.item.selectedTitle ?? null,
      continuation: result.continuation
    });
    return result;
  }

  private resolve(id: string): { adapter?: MediaReviewItemAdapter; sourceId: string } {
    const separator = id.indexOf(":");
    if (separator < 1) return { sourceId: id };
    const adapter = this.adapters.get(id.slice(0, separator));
    return { ...(adapter ? { adapter } : {}), sourceId: id.slice(separator + 1) };
  }
}
