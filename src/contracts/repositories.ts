import type { AppSettings, Job, JobStatus } from "../model.js";
import type {
  TvEpisodeFeedbackRepository,
  TvProcessingPlanRepository
} from "../domain/television.js";
import type { TvValidationEvidenceRepository } from "../domain/tv-validation.js";
import type { ReviewItemRepository } from "../domain/reviews.js";
import type { ClassificationAuditRepository } from "../domain/classification.js";
import type { ReviewJobRepository } from "../domain/review-jobs.js";
import type { DiscRecovery, DiscRecoveryRepository } from "../domain/disc-recovery.js";

export interface SetupState {
  setupComplete: boolean;
  adminUsername: string | null;
  setupCompletedAt: string | null;
}

export interface SetupRepository {
  get(): SetupState;
  complete(username: string, salt: string, passwordHash: string): SetupState;
  updatePassword(salt: string, passwordHash: string): void;
  authenticate(username: string, password: string): boolean;
}

export interface SettingsRepository {
  get(): AppSettings;
  save(patch: Partial<AppSettings>): AppSettings;
}

export interface JobRepository {
  add(id: string, label: string | null, fingerprint?: string | null, mediaKind?: string): void;
  setStatus(id: string, status: JobStatus, message: string): void;
  update(id: string, patch: Partial<Pick<Job, "title" | "outputPath" | "encoder" | "outputBytes" | "progress" | "conversionSeconds">>): void;
  finish(id: string, status: "review" | "completed" | "failed" | "cancelled" | "interrupted", error: string | null, fingerprint?: string): void;
  active(): Job | null;
  addWarning(id: string, message: string): void;
}

export interface HistoryRepository {
  list(limit?: number): Job[];
  delete(id: string): boolean;
  stats(): { total: number; successful: number; failures: number; averageSeconds: number | null };
  statsByMediaType(): Array<{ mediaType: string; total: number; successful: number; failures: number; averageSeconds: number | null }>;
  get(id: string): Job | undefined;
  timeline(id: string): Array<{ at: string; stage: string; level: string; message: string }>;
  dailyStats(days: number): unknown[];
}

export interface EventRepository {
  add(jobId: string, stage: string, level: string, message: string): void;
  list(jobId: string): unknown[];
}

export interface RecoveryRepository {
  interruptedOutputs(): Array<{ id: string; outputPath: string; mediaType: string }>;
  recoverPublished(id: string, outputBytes: number): void;
  lastDiscFingerprint(): string | null;
  clearInsertedDisc(): void;
}

export interface AutoDiscRepositories {
  setup: SetupRepository;
  settings: SettingsRepository;
  jobs: JobRepository;
  history: HistoryRepository;
  events: EventRepository;
  recovery: RecoveryRepository;
  tvEpisodeFeedback: TvEpisodeFeedbackRepository;
  tvProcessingPlans: TvProcessingPlanRepository;
  tvValidationEvidence: TvValidationEvidenceRepository;
  reviewItems: ReviewItemRepository;
  reviewJobs: ReviewJobRepository;
  classificationAudit: ClassificationAuditRepository;
  discRecovery: DiscRecoveryRepository;
  close(): void;
}
