export type ReviewCategory =
  | "tv_review"
  | "cd_review"
  | "metadata_issue"
  | "processing_failure"
  | "folder_creation_failure"
  | "disc_read_error"
  | "validation_warning"
  | "configuration_issue"
  | "system_warning";

export type ReviewSeverity = "critical" | "high" | "medium" | "low";
export type ReviewStatus = "active" | "retrying" | "resolved" | "dismissed";
export type ReviewActionType =
  | "retry"
  | "retry-after-correction"
  | "approve-process"
  | "open-settings"
  | "enter-metadata"
  | "view-job"
  | "open-review"
  | "resolve"
  | "dismiss";

export interface ReviewAction {
  type: ReviewActionType;
  label: string;
}

export interface ReviewItem {
  id: string;
  category: ReviewCategory;
  severity: ReviewSeverity;
  status: ReviewStatus;
  title: string;
  description: string;
  createdAt: string;
  resolvedAt?: string;
  relatedJobId?: string;
  relatedDisc?: string;
  discFingerprint?: string;
  relatedDrive?: string;
  errorDetails?: Readonly<Record<string, unknown>>;
  requestedPath?: string;
  suggestedActions: readonly ReviewAction[];
  resolutionDetails?: string;
  retryCount: number;
}

export type ReviewItemInput = Omit<ReviewItem, "id" | "status" | "createdAt" | "resolvedAt" | "resolutionDetails" | "retryCount">;

export interface ReviewSummary {
  active: number;
  critical: number;
  tv: number;
  cd: number;
  processingFailures: number;
  resolvedToday: number;
}

export interface ReviewItemRepository {
  create(input: ReviewItemInput): ReviewItem;
  get(id: string): ReviewItem | undefined;
  list(options?: {
    category?: ReviewCategory;
    severity?: ReviewSeverity;
    status?: ReviewStatus;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }): ReviewItem[];
  updateStatus(id: string, status: ReviewStatus, resolutionDetails?: string): ReviewItem | undefined;
  resolveForDisc(fingerprint: string, resolutionDetails: string): number;
  summary(): ReviewSummary;
}
