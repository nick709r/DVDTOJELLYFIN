import type { Job, JobStatus } from "./model.js";
import type { AutoDiscRepositories } from "./contracts/repositories.js";
import { openSqliteDatabase } from "./infrastructure/database/connection.js";
import { defaultSettings } from "./infrastructure/database/default-settings.js";
import { migrateDatabase } from "./infrastructure/database/migrations.js";
import { createSqliteRepositories } from "./infrastructure/database/repositories.js";

export const dbPath = process.env.DATABASE_PATH ?? "./data/autodisc.sqlite";
export const db = openSqliteDatabase(dbPath);
migrateDatabase(db, defaultSettings);

export const repositories: AutoDiscRepositories = createSqliteRepositories(db, defaultSettings);

export const getSettings = (): ReturnType<AutoDiscRepositories["settings"]["get"]> =>
  repositories.settings.get();

export const saveSettings: AutoDiscRepositories["settings"]["save"] = (patch) =>
  repositories.settings.save(patch);

export const addJob: AutoDiscRepositories["jobs"]["add"] = (id, label, fingerprint, mediaKind) =>
  repositories.jobs.add(id, label, fingerprint, mediaKind);

export const setJobStatus: AutoDiscRepositories["jobs"]["setStatus"] = (id, status, message) =>
  repositories.jobs.setStatus(id, status, message);

export const updateJob: AutoDiscRepositories["jobs"]["update"] = (id, patch) =>
  repositories.jobs.update(id, patch);

export const finishJob: AutoDiscRepositories["jobs"]["finish"] = (id, status, error, fingerprint) =>
  repositories.jobs.finish(id, status, error, fingerprint);

export const interruptedOutputs: AutoDiscRepositories["recovery"]["interruptedOutputs"] = () =>
  repositories.recovery.interruptedOutputs();

export const recoverPublishedJob: AutoDiscRepositories["recovery"]["recoverPublished"] = (id, bytes) =>
  repositories.recovery.recoverPublished(id, bytes);

export const lastDiscFingerprint: AutoDiscRepositories["recovery"]["lastDiscFingerprint"] = () =>
  repositories.recovery.lastDiscFingerprint();

export const clearInsertedDisc: AutoDiscRepositories["recovery"]["clearInsertedDisc"] = () =>
  repositories.recovery.clearInsertedDisc();

export const addEvent: AutoDiscRepositories["events"]["add"] = (jobId, stage, level, message) =>
  repositories.events.add(jobId, stage, level, message);

export const addJobWarning: AutoDiscRepositories["jobs"]["addWarning"] = (id, message) =>
  repositories.jobs.addWarning(id, message);

export const activeJob: AutoDiscRepositories["jobs"]["active"] = () =>
  repositories.jobs.active();

export const listJobs: AutoDiscRepositories["history"]["list"] = (limit) =>
  repositories.history.list(limit);

export const deleteJob: AutoDiscRepositories["history"]["delete"] = (id) =>
  repositories.history.delete(id);

export const jobStats: AutoDiscRepositories["history"]["stats"] = () =>
  repositories.history.stats();

export function jobDetails(id: string): { job: Job; timeline: unknown[] } | undefined {
  const job = repositories.history.get(id);
  return job ? { job, timeline: repositories.history.timeline(id) } : undefined;
}

export function dailyJobStats(days: number): unknown[] {
  return repositories.history.dailyStats(days);
}

export type { JobStatus };
