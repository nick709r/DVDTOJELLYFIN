/**
 * Media-agnostic review model. Every review that needs a human decision (movie, TV, and future media
 * types) is exposed through this shape regardless of how the underlying record is stored.
 *
 * Named MediaReviewItem because `ReviewItem` in ./reviews.ts is the established review-centre
 * issue record (processing failures, disc read errors, ...) used throughout the application.
 */
export type MediaReviewStatus = "pending" | "processing" | "ready" | "completed" | "dismissed";

export type MediaReviewSourceKind = "review-job" | "tv-matching-task" | "tv-plan";

/** What the reviewer is being asked to do. */
export type MediaReviewKind = "identification" | "assignment" | "processing" | "plan-review";

export interface ReviewCandidate {
  id: string;
  title: string;
  confidence: number;
  provider?: string;
  year?: number;
  poster?: string;
  overview?: string;
}

export interface MediaReviewItem {
  /** Globally unique: `${source.kind}:${source.id}`. */
  id: string;
  mediaType: string;
  status: MediaReviewStatus;
  kind: MediaReviewKind;
  reviewReason?: string;
  confidence?: number;

  originalTitle?: string;
  selectedTitle?: string;
  /** Where the selected title came from, e.g. "Metadata match", "User review". */
  namingSource?: string;

  candidates: ReviewCandidate[];

  metadata?: {
    provider?: string;
    providerId?: string;
    title?: string;
    year?: number;
    poster?: string;
    overview?: string;
  };

  /** Media-specific details a client needs to complete the review; present only for media that require them. */
  tv?: MediaReviewTvDetails;

  /** Backing record, used by adapters and by clients that need storage-specific actions. */
  source: { kind: MediaReviewSourceKind; id: string };
  /** True when the item was converted from a record written before candidates were stored in the current format. */
  legacy: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MediaReviewTvTrack {
  trackId: string;
  title: string;
  durationSeconds: number;
  episodeNumbers: number[];
  confirmed: boolean;
}

export interface MediaReviewTvDetails {
  seriesName?: string;
  provider?: string;
  providerId?: string;
  seasonNumber?: number;
  discNumber?: number;
  discName?: string;
  tracks: MediaReviewTvTrack[];
  progress: { matched: number; total: number };
  /** What is still missing before processing can continue. */
  requires: Array<"identification" | "assignments">;
}

/** Whether completing an item should also resume processing. */
export type MediaReviewPublishMode = "never" | "when-ready" | "required";

export type MediaReviewContinuation = "not-ready" | "queued" | "started" | "blocked";

export interface MediaReviewCompletionResult {
  item: MediaReviewItem;
  continuation: MediaReviewContinuation;
  /** Storage-specific records produced by completion, used by legacy endpoints to keep their response shapes. */
  details?: Record<string, unknown>;
}

export interface MediaReviewCompletion {
  /** Raw TV identification (series, provider, season, disc); validated by the TV adapter. */
  identification?: unknown;
  /** Raw TV episode assignments; validated by the TV adapter. */
  assignments?: unknown;
  /** Defaults to "when-ready". Media without a separate publish step ignore it. */
  publish?: MediaReviewPublishMode;
  /** Reviewer recorded on plan approvals; defaults to the administrator. */
  reviewer?: string;
  /** Candidate chosen from the item's candidate list or from a fresh search. */
  candidateId?: string;
  /** Title for the selected candidate or a manual fallback entry. */
  title?: string;
}

export interface MediaReviewFilter {
  mediaType?: string;
  status?: MediaReviewStatus;
  sourceKind?: MediaReviewSourceKind;
}

export type MediaReviewErrorCode = "not-found" | "conflict" | "invalid" | "unsupported" | "unavailable";

export class MediaReviewError extends Error {
  constructor(readonly code: MediaReviewErrorCode, message: string) {
    super(message);
    this.name = "MediaReviewError";
  }
}

/** Media/storage-specific behaviour behind the shared review queue. */
export interface MediaReviewItemAdapter {
  readonly sourceKind: MediaReviewSourceKind;
  list(): MediaReviewItem[];
  get(sourceId: string): MediaReviewItem | undefined;
  /** Omitted when completing this kind of review needs richer input than a title selection. */
  complete?(sourceId: string, input: MediaReviewCompletion): Promise<MediaReviewCompletionResult>;
}
