/**
 * Disk classification review and audit domain.
 * Media-kind agnostic: detected and final types are free-form identifiers
 * (e.g. "dvd", "bluray", "audio_cd", "cdrom", "mixed_mode", "unknown"), so
 * future disk types need no schema or code change.
 */
export const KNOWN_DISK_TYPES = ["dvd", "bluray", "audio_cd", "cdrom", "mixed_mode", "unknown"] as const;

export const CLASSIFICATION_REVIEW_STATUSES = [
  "auto_accepted", "reviewed_no_change", "manually_corrected", "review_required"
] as const;
export type ClassificationReviewStatus = typeof CLASSIFICATION_REVIEW_STATUSES[number];

export const OVERRIDE_REASONS = [
  "filesystem_detection_incorrect", "disc_identified_from_title", "disc_identified_from_barcode",
  "damaged_disc", "mixed_media", "unknown_detection_issue", "custom"
] as const;
export type OverrideReason = typeof OVERRIDE_REASONS[number];

/** Detections below this confidence are flagged review_required. */
export const LOW_CONFIDENCE_THRESHOLD = 0.7;

export interface ClassificationAuditRecord {
  id: string;
  jobId: string | null;
  timestamp: string;
  diskName: string;
  detectedType: string;
  finalType: string;
  confidence: number | null;
  reviewStatus: ClassificationReviewStatus;
  processingStatus: string;
  overrideReason: OverrideReason | null;
  notes: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

export interface ClassificationDetectionInput {
  jobId: string | null;
  diskName: string;
  detectedType: string;
  confidence?: number | null;
}

export interface ClassificationReviewInput {
  finalType: string;
  overrideReason?: string | undefined;
  notes?: string | undefined;
  reviewedBy?: string | undefined;
}

export interface ClassificationMetrics {
  totalProcessed: number;
  autoAccepted: number;
  reviewed: number;
  manualCorrections: number;
  reviewRequired: number;
  corrections: Array<{ from: string; to: string; count: number }>;
}

export interface ClassificationAuditRepository {
  recordDetection(input: ClassificationDetectionInput): ClassificationAuditRecord;
  setProcessingStatus(jobId: string, status: string): void;
  review(id: string, input: ClassificationReviewInput): ClassificationAuditRecord;
  get(id: string): ClassificationAuditRecord | undefined;
  getByJob(jobId: string): ClassificationAuditRecord | undefined;
  /** Chronological (oldest first) unless newestFirst is set. */
  list(options?: { limit?: number; offset?: number; newestFirst?: boolean }): ClassificationAuditRecord[];
  metrics(): ClassificationMetrics;
}
