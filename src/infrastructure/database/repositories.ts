import type Database from "better-sqlite3";
import type { AppSettings } from "../../model.js";
import type { AutoDiscRepositories } from "../../contracts/repositories.js";
import { SqliteEventRepository } from "./event-repository.js";
import { SqliteHistoryRepository } from "./history-repository.js";
import { SqliteJobRepository } from "./job-repository.js";
import { SqliteRecoveryRepository } from "./recovery-repository.js";
import { SqliteSettingsRepository } from "./settings-repository.js";
import { SqliteTvEpisodeFeedbackRepository } from "./tv-episode-feedback-repository.js";
import { SqliteTvProcessingPlanRepository } from "./tv-processing-plan-repository.js";
import { SqliteTvValidationEvidenceRepository } from "./tv-validation-evidence-repository.js";
import { SqliteReviewItemRepository } from "./review-item-repository.js";
import { SqliteReviewJobRepository } from "./review-job-repository.js";
import { SqliteClassificationAuditRepository } from "./classification-audit-repository.js";
import { SqliteSetupRepository } from "./setup-repository.js";
import { SqliteDiscRecoveryRepository } from "./disc-recovery-repository.js";
import { SqliteTvMatchingTaskRepository } from "./tv-matching-task-repository.js";
import { SqliteForgetDiscService } from "./forget-disc-service.js";

export function createSqliteRepositories(db: Database.Database, defaults: AppSettings): AutoDiscRepositories {
  const events = new SqliteEventRepository(db);
  const classificationAudit = new SqliteClassificationAuditRepository(db);
  return {
    setup: new SqliteSetupRepository(db),
    settings: new SqliteSettingsRepository(db, defaults),
    jobs: new SqliteJobRepository(db, events, classificationAudit),
    history: new SqliteHistoryRepository(db),
    events,
    recovery: new SqliteRecoveryRepository(db, events, classificationAudit),
    tvEpisodeFeedback: new SqliteTvEpisodeFeedbackRepository(db),
    tvProcessingPlans: new SqliteTvProcessingPlanRepository(db),
    tvValidationEvidence: new SqliteTvValidationEvidenceRepository(db),
    reviewItems: new SqliteReviewItemRepository(db),
    reviewJobs: new SqliteReviewJobRepository(db),
    classificationAudit,
    discRecovery: new SqliteDiscRecoveryRepository(db),
    tvMatchingTasks: new SqliteTvMatchingTaskRepository(db),
    forgetDisc: new SqliteForgetDiscService(db),
    close: () => db.close()
  };
}
