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

export function createSqliteRepositories(db: Database.Database, defaults: AppSettings): AutoDiscRepositories {
  const events = new SqliteEventRepository(db);
  return {
    settings: new SqliteSettingsRepository(db, defaults),
    jobs: new SqliteJobRepository(db, events),
    history: new SqliteHistoryRepository(db),
    events,
    recovery: new SqliteRecoveryRepository(db, events),
    tvEpisodeFeedback: new SqliteTvEpisodeFeedbackRepository(db),
    tvProcessingPlans: new SqliteTvProcessingPlanRepository(db),
    close: () => db.close()
  };
}
