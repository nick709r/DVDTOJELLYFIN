import type Database from "better-sqlite3";
import { lstat, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep, isAbsolute, join } from "node:path";
import type { AppSettings } from "../model.js";
import { outputPath } from "../output-destinations.js";
import { pathsOverlap, tvStagingDirectory } from "../storage-paths.js";
import { log } from "../logger.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const activeJobStatuses = new Set(["inspecting", "ripping", "converting", "publishing"]);

interface ReviewRow {
  id: string;
  related_job_id: string | null;
  disc_fingerprint: string | null;
  status: string;
}

interface JobRow {
  id: string;
  status: string;
  disc_fingerprint: string | null;
}

interface ReviewJobRow {
  id: string;
  original_job_id: string;
  status: string;
  storage_path: string;
}

interface OwnedPath {
  path: string;
  root: string;
  ownerId: string;
  kind: "job" | "tv-staging" | "review-workspace";
}

interface CleanupPlan {
  reviewId: string | null;
  jobId: string | null;
  fingerprint: string | null;
  fingerprintExclusive: boolean;
  paths: OwnedPath[];
  reviewJobIds: string[];
}

interface PathRemovalResult {
  filesDeleted: number;
  bytesRecovered: number;
  errors: string[];
}

interface FileEntry {
  path: string;
  size: number;
  inode: string;
  links: number;
}

export interface ReviewQueueOwnership {
  valid: boolean;
  reviewId: string;
  jobId: string | null;
  paths: string[];
  errors: string[];
}

export interface ReviewDeletionRecordCounts {
  reviewItems: number;
  jobs: number;
  jobEvents: number;
  reviewJobs: number;
  tvMatchingTasks: number;
  mediaTypeOverrideAudit: number;
  discRecovery: number;
  tvEpisodeFeedback: number;
  tvProcessingPlans: number;
  tvValidationEvidence: number;
}

export interface ReviewDeletionImpact {
  reviewId: string;
  jobId: string | null;
  files: number;
  filePaths: string[];
  directoryPaths: string[];
  bytes: number;
  records: number;
  recordCounts: ReviewDeletionRecordCounts;
  resources: string[];
  ownedPaths: string[];
  errors: string[];
}

export interface ReviewDeletionResult {
  reviewId: string;
  jobId: string | null;
  filesDeleted: number;
  bytesRecovered: number;
  recordsDeleted: number;
  success: boolean;
  errors: string[];
}

export interface OrphanedDataReport {
  files: number;
  bytes: number;
  items: Array<{ id: string; kind: OwnedPath["kind"]; path: string; files: number; bytes: number }>;
  errors: string[];
}

export interface OrphanCleanupResult extends OrphanedDataReport {
  filesDeleted: number;
  bytesRecovered: number;
  recordsDeleted: number;
  success: boolean;
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function protectedOutputRoots(settings: AppSettings): string[] {
  const media = ["tv", "movies", "music"] as const;
  const configured = settings.outputDestinations.profiles.flatMap((profile) => {
    const profileSettings = {
      ...settings,
      outputDestinations: { ...settings.outputDestinations, activeProfileId: profile.id }
    };
    return media.map((type) => outputPath(profileSettings, type));
  });
  return [...new Set([
    settings.moviesDir,
    settings.musicDir,
    settings.tvRootDir,
    settings.lidarrImportDir,
    ...configured
  ].filter(Boolean).map((path) => resolve(path)))];
}

export class ReviewQueueCleanupService {
  constructor(
    private readonly db: Database.Database,
    private readonly getSettings: () => AppSettings
  ) {}

  async validateOwnership(reviewId: string): Promise<ReviewQueueOwnership> {
    const errors: string[] = [];
    const row = this.db.prepare(`
      SELECT id, related_job_id, disc_fingerprint, status
      FROM review_items WHERE id = ?
    `).get(reviewId) as ReviewRow | undefined;
    if (!row) return { valid: false, reviewId, jobId: null, paths: [], errors: ["Review item was not found"] };
    if (row.status === "retrying") {
      return { valid: false, reviewId, jobId: row.related_job_id, paths: [], errors: ["Review item is currently retrying"] };
    }

    let plan: CleanupPlan;
    try {
      plan = await this.createPlan(row);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Resource ownership could not be validated");
      return { valid: false, reviewId, jobId: row.related_job_id, paths: [], errors };
    }
    for (const resource of plan.paths) {
      try {
        await this.validateOwnedPath(resource);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `Ownership validation failed for ${resource.path}`);
      }
    }
    return {
      valid: errors.length === 0,
      reviewId,
      jobId: plan.jobId,
      paths: plan.paths.map(({ path }) => path),
      errors
    };
  }

  async getDeletionImpact(reviewId: string): Promise<ReviewDeletionImpact> {
    const plan = await this.planForReview(reviewId);
    const inventory = await this.inventory(plan.paths);
    if (inventory.errors.length) throw new Error(inventory.errors.join("; "));
    const recordCounts = this.countOwnedRecordCounts(plan);
    const records = Object.values(recordCounts).reduce((total, count) => total + count, 0);
    return {
      reviewId,
      jobId: plan.jobId,
      files: inventory.files.length,
      filePaths: inventory.files.map(({ path }) => path).sort((a, b) => a.localeCompare(b)),
      directoryPaths: inventory.directories.sort((a, b) => a.localeCompare(b)),
      bytes: inventory.bytes,
      records,
      recordCounts,
      resources: [...plan.paths.map(({ path }) => path), `${records} database records`],
      ownedPaths: plan.paths.map(({ path }) => path),
      errors: inventory.errors
    };
  }

  async calculateRecoverableSpace(reviewId: string): Promise<number> {
    return (await this.getDeletionImpact(reviewId)).bytes;
  }

  async deleteReviewItem(reviewId: string): Promise<ReviewDeletionResult> {
    try {
      return await this.deletePlan(await this.planForReview(reviewId));
    } catch (error) {
      log("error", "review-cleanup", "Review item deletion was rejected before cleanup", {
        reviewId,
        jobId: null,
        filesDeleted: 0,
        bytesRecovered: 0,
        recordsDeleted: 0,
        success: false,
        errors: [error instanceof Error ? error.message : "Review item ownership could not be validated"]
      });
      throw error;
    }
  }

  async getReviewJobDeletionImpact(reviewJobId: string): Promise<ReviewDeletionImpact> {
    const plan = await this.planForReviewJob(reviewJobId);
    const inventory = await this.inventory(plan.paths);
    if (inventory.errors.length) throw new Error(inventory.errors.join("; "));
    const recordCounts = this.countOwnedRecordCounts(plan);
    const records = Object.values(recordCounts).reduce((total, count) => total + count, 0);
    return {
      reviewId: reviewJobId,
      jobId: plan.jobId,
      files: inventory.files.length,
      filePaths: inventory.files.map(({ path }) => path).sort((a, b) => a.localeCompare(b)),
      directoryPaths: inventory.directories.sort((a, b) => a.localeCompare(b)),
      bytes: inventory.bytes,
      records,
      recordCounts,
      resources: [...plan.paths.map(({ path }) => path), `${records} database records`],
      ownedPaths: plan.paths.map(({ path }) => path),
      errors: inventory.errors
    };
  }

  async deleteReviewJob(reviewJobId: string): Promise<ReviewDeletionResult> {
    try {
      return await this.deletePlan(await this.planForReviewJob(reviewJobId));
    } catch (error) {
      log("error", "review-cleanup", "Review job deletion was rejected before cleanup", {
        reviewId: reviewJobId,
        jobId: null,
        filesDeleted: 0,
        bytesRecovered: 0,
        recordsDeleted: 0,
        success: false,
        errors: [error instanceof Error ? error.message : "Review job ownership could not be validated"]
      });
      throw error;
    }
  }

  async scanOrphanedData(): Promise<OrphanedDataReport> {
    const settings = this.getSettings();
    const items: OrphanedDataReport["items"] = [];
    const errors: string[] = [];
    const jobs = this.db.prepare("SELECT id, status FROM jobs").all() as Array<{ id: string; status: string }>;
    const jobIds = new Set(jobs.map(({ id }) => id));
    const reviewJobIds = new Set((this.db.prepare("SELECT id FROM review_jobs").all() as Array<{ id: string }>).map(({ id }) => id));
    const taskIds = new Set((this.db.prepare("SELECT job_id AS id FROM tv_matching_tasks").all() as Array<{ id: string }>).map(({ id }) => id));
    for (const job of jobs) if (activeJobStatuses.has(job.status)) taskIds.add(job.id);
    const roots: Array<{ path: string; kind: OwnedPath["kind"]; tracked: Set<string> }> = [
      { path: resolve(settings.workDir), kind: "job", tracked: jobIds },
      { path: resolve(settings.workDir, "reviews"), kind: "review-workspace", tracked: reviewJobIds },
      { path: resolve(tvStagingDirectory(settings)), kind: "tv-staging", tracked: taskIds }
    ];
    for (const root of roots) {
      try {
        const rootInfo = await lstat(root.path);
        if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
          errors.push(`Orphan scan skipped unsafe root: ${root.path}`);
          continue;
        }
        const rootRealPath = await realpath(root.path);
        if (!isWithin(root.path, rootRealPath)) {
          errors.push(`Orphan scan skipped root outside its configured path: ${root.path}`);
          continue;
        }
        for (const entry of await readdir(root.path, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.isSymbolicLink() || !uuidPattern.test(entry.name) ||
            root.tracked.has(entry.name)) continue;
          if (root.kind === "job" && (entry.name === basename(resolve(settings.workDir, "reviews")) ||
              entry.name === basename(resolve(tvStagingDirectory(settings))))) continue;
          const path = resolve(root.path, entry.name);
          if (dirname(path) !== resolve(root.path) || basename(path) !== entry.name) {
            errors.push(`Orphan path failed validation: ${path}`);
            continue;
          }
          const inventory = await this.inventory([{ path, root: rootRealPath, ownerId: entry.name, kind: root.kind }]);
          errors.push(...inventory.errors);
          items.push({ id: entry.name, kind: root.kind, path, files: inventory.files.length, bytes: inventory.bytes });
        }
      } catch (error) {
        if (!missing(error)) errors.push(error instanceof Error ? error.message : `Orphan scan failed for ${root.path}`);
      }
    }
    const report = {
      files: items.reduce((total, item) => total + item.files, 0),
      bytes: items.reduce((total, item) => total + item.bytes, 0),
      items,
      errors
    };
    log("info", "review-cleanup", "Orphaned temporary data scan completed", {
      orphanCount: items.length,
      files: report.files,
      bytes: report.bytes,
      errors
    });
    return report;
  }

  async deleteOrphanedData(): Promise<OrphanCleanupResult> {
    const report = await this.scanOrphanedData();
    const errors = [...report.errors];
    let filesDeleted = 0;
    let bytesRecovered = 0;
    for (const item of report.items) {
      try {
        const path = resolve(item.path);
        const settings = this.getSettings();
        const root = item.kind === "job" ? resolve(settings.workDir)
          : item.kind === "review-workspace" ? resolve(settings.workDir, "reviews")
            : resolve(tvStagingDirectory(settings));
        if (dirname(path) !== root || basename(path) !== item.id) throw new Error(`Orphan ownership changed for ${path}`);
        const tracked = item.kind === "job"
          ? this.db.prepare("SELECT 1 FROM jobs WHERE id = ?").get(item.id)
          : item.kind === "review-workspace"
            ? this.db.prepare("SELECT 1 FROM review_jobs WHERE id = ?").get(item.id)
            : this.db.prepare("SELECT 1 FROM tv_matching_tasks WHERE job_id = ?").get(item.id);
        if (tracked) throw new Error(`Orphan data became owned before cleanup: ${path}`);
        const result = await this.removeOwnedPath({ path, root, ownerId: item.id, kind: item.kind }, this.protectedPaths(settings));
        filesDeleted += result.filesDeleted;
        bytesRecovered += result.bytesRecovered;
        errors.push(...result.errors);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `Could not clean orphan ${item.path}`);
      }
    }
    const success = errors.length === 0;
    const result = { ...report, filesDeleted, bytesRecovered, recordsDeleted: 0, success, errors };
    log(success ? "info" : "error", "review-cleanup", "Orphaned data cleanup completed", {
      reviewId: null,
      jobId: null,
      filesDeleted,
      bytesRecovered,
      recordsDeleted: 0,
      success,
      errors
    });
    return result;
  }

  private async planForReview(reviewId: string): Promise<CleanupPlan> {
    const row = this.db.prepare(`
      SELECT id, related_job_id, disc_fingerprint, status
      FROM review_items WHERE id = ?
    `).get(reviewId) as ReviewRow | undefined;
    if (!row) throw new Error("Review item was not found");
    return this.createPlan(row);
  }

  private async planForReviewJob(reviewJobId: string): Promise<CleanupPlan> {
    const reviewJob = this.db.prepare(`
      SELECT id, original_job_id, status, storage_path
      FROM review_jobs WHERE id = ?
    `).get(reviewJobId) as ReviewJobRow | undefined;
    if (!reviewJob) throw new Error("Review job was not found");
    if (["processing", "retrying"].includes(reviewJob.status)) {
      throw new Error("A review item cannot be deleted while processing");
    }
    const item = this.db.prepare(`
      SELECT id, related_job_id, disc_fingerprint, status
      FROM review_items WHERE related_job_id = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(reviewJob.original_job_id) as ReviewRow | undefined;
    const plan = item
      ? await this.createPlan(item)
      : await this.createPlan({
        id: reviewJob.id,
        related_job_id: reviewJob.original_job_id,
        disc_fingerprint: null,
        status: "active"
      }, false);
    const settings = this.getSettings();
    const expected = resolve(settings.workDir, "reviews", reviewJob.id);
    if (resolve(reviewJob.storage_path) !== expected) throw new Error("Review workspace path does not match its recorded owner");
    if (!plan.paths.some(({ path }) => resolve(path) === expected)) {
      plan.paths.push({ path: expected, root: resolve(settings.workDir, "reviews"), ownerId: reviewJob.id, kind: "review-workspace" });
    }
    if (!plan.reviewJobIds.includes(reviewJob.id)) plan.reviewJobIds.push(reviewJob.id);
    return plan;
  }

  private async createPlan(row: ReviewRow, includeReviewItem = true): Promise<CleanupPlan> {
    const settings = this.getSettings();
    const jobId = row.related_job_id;
    if (jobId && !uuidPattern.test(jobId)) throw new Error(`Job ID is not a valid owner identifier: ${jobId}`);
    if (row.status === "retrying") throw new Error("Review item is currently retrying");
    const job = jobId
      ? this.db.prepare("SELECT id, status, disc_fingerprint FROM jobs WHERE id = ?").get(jobId) as JobRow | undefined
      : undefined;
    const errors: string[] = [];
    if (jobId && job && activeJobStatuses.has(job.status)) errors.push(`Job ${jobId} is still processing`);
    if (jobId) {
      const retryingReviews = this.db.prepare(`
        SELECT COUNT(*) AS count FROM review_items WHERE related_job_id = ? AND status = 'retrying'
      `).get(jobId) as { count: number };
      if (retryingReviews.count) errors.push(`A review item for job ${jobId} is currently retrying`);
      const task = this.db.prepare("SELECT status, staging_path, fingerprint FROM tv_matching_tasks WHERE job_id = ?")
        .get(jobId) as { status: string; staging_path: string; fingerprint: string } | undefined;
      if (task?.status === "processing") errors.push(`TV matching task ${jobId} is still processing`);
      if (task && ((job?.disc_fingerprint && task.fingerprint !== job.disc_fingerprint) ||
          (row.disc_fingerprint && task.fingerprint !== row.disc_fingerprint))) {
        errors.push("TV matching task fingerprint does not match its owning job or review item");
      }
      if (job && row.disc_fingerprint && job.disc_fingerprint &&
        row.disc_fingerprint !== job.disc_fingerprint) errors.push("Review item and job fingerprints do not match");
    }
    if (errors.length) throw new Error(errors.join("; "));

    const taskFingerprint = jobId
      ? (this.db.prepare("SELECT fingerprint FROM tv_matching_tasks WHERE job_id = ?").get(jobId) as { fingerprint: string } | undefined)?.fingerprint
      : undefined;
    const fingerprint = job?.disc_fingerprint ?? row.disc_fingerprint ?? taskFingerprint ?? null;
    const fingerprintExclusive = fingerprint ? this.isFingerprintExclusive(fingerprint, jobId, row.id) : false;
    const paths: OwnedPath[] = [];
    const reviewJobIds: string[] = [];
    if (jobId && uuidPattern.test(jobId)) {
      paths.push({ path: resolve(settings.workDir, jobId), root: resolve(settings.workDir), ownerId: jobId, kind: "job" });
      const task = this.db.prepare("SELECT status, staging_path FROM tv_matching_tasks WHERE job_id = ?")
        .get(jobId) as { status: string; staging_path: string } | undefined;
      if (task) {
        const expectedStagingPath = resolve(tvStagingDirectory(settings), jobId);
        if (resolve(task.staging_path) !== expectedStagingPath) throw new Error("TV staging path does not match its recorded job owner");
        paths.push({ path: expectedStagingPath, root: resolve(tvStagingDirectory(settings)), ownerId: jobId, kind: "tv-staging" });
      }
      const reviewJobs = this.db.prepare(`
        SELECT id, status, storage_path FROM review_jobs WHERE original_job_id = ?
      `).all(jobId) as Array<Pick<ReviewJobRow, "id" | "status" | "storage_path">>;
      for (const reviewJob of reviewJobs) {
        if (["processing", "retrying"].includes(reviewJob.status)) throw new Error(`Review job ${reviewJob.id} is still processing`);
        if (!uuidPattern.test(reviewJob.id) ||
          resolve(reviewJob.storage_path) !== resolve(settings.workDir, "reviews", reviewJob.id)) {
          throw new Error(`Review workspace path does not match its recorded owner: ${reviewJob.id}`);
        }
        paths.push({
          path: resolve(settings.workDir, "reviews", reviewJob.id),
          root: resolve(settings.workDir, "reviews"),
          ownerId: reviewJob.id,
          kind: "review-workspace"
        });
        reviewJobIds.push(reviewJob.id);
      }
    }
    const plan: CleanupPlan = {
      reviewId: includeReviewItem ? row.id : null,
      jobId,
      fingerprint,
      fingerprintExclusive,
      paths: [...new Map<string, OwnedPath>(
        paths.map((path): [string, OwnedPath] => [resolve(path.path), path])
      ).values()],
      reviewJobIds
    };
    for (const resource of plan.paths) await this.validateOwnedPath(resource);
    return plan;
  }

  private async validateOwnedPath(resource: OwnedPath): Promise<void> {
    const path = resolve(resource.path);
    const root = resolve(resource.root);
    if (!uuidPattern.test(resource.ownerId) || dirname(path) !== root || basename(path) !== resource.ownerId) {
      throw new Error(`Resource path does not match its recorded owner: ${path}`);
    }
    if (this.protectedPaths(this.getSettings()).some((output) => pathsOverlap(path, output))) {
      throw new Error(`Resource path overlaps a protected media output: ${path}`);
    }
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }

    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Owned resource is not a regular directory: ${path}`);
    const realRoot = await realpath(root);
    const realPath = await realpath(path);
    if (!isWithin(realRoot, realPath) || dirname(realPath) !== realRoot || basename(realPath) !== resource.ownerId) {
      throw new Error(`Owned resource resolves outside its expected directory: ${path}`);
    }
  }

  private protectedPaths(settings: AppSettings): string[] {
    const recordedOutputs = this.db.prepare("SELECT output_path FROM jobs WHERE output_path IS NOT NULL")
      .all() as Array<{ output_path: string }>;
    return [...new Set([
      ...protectedOutputRoots(settings),
      ...recordedOutputs.map(({ output_path }) => resolve(output_path))
    ])];
  }

  private isFingerprintExclusive(fingerprint: string, jobId: string | null, reviewId: string): boolean {
    const otherJobs = this.db.prepare(`
      SELECT COUNT(*) AS count FROM jobs WHERE disc_fingerprint = ? AND id != ?
    `).get(fingerprint, jobId ?? "") as { count: number };
    const otherReviews = this.db.prepare(`
      SELECT COUNT(*) AS count FROM review_items
      WHERE disc_fingerprint = ? AND id != ? AND (related_job_id IS NULL OR related_job_id != ?)
    `).get(fingerprint, reviewId, jobId ?? "") as { count: number };
    const otherTasks = this.db.prepare(`
      SELECT COUNT(*) AS count FROM tv_matching_tasks WHERE fingerprint = ? AND job_id != ?
    `).get(fingerprint, jobId ?? "") as { count: number };
    return otherJobs.count === 0 && otherReviews.count === 0 && otherTasks.count === 0;
  }

  private countOwnedRecordCounts(plan: CleanupPlan): ReviewDeletionRecordCounts {
    const count = (query: string, ...params: string[]): number =>
      (this.db.prepare(query).get(...params) as { count: number }).count;
    const reviewItems = plan.reviewId
      ? plan.jobId
        ? count("SELECT COUNT(*) AS count FROM review_items WHERE related_job_id = ? OR id = ?", plan.jobId, plan.reviewId)
        : count("SELECT COUNT(*) AS count FROM review_items WHERE id = ?", plan.reviewId)
      : 0;
    const jobs = plan.jobId ? count("SELECT COUNT(*) AS count FROM jobs WHERE id = ?", plan.jobId) : 0;
    const jobEvents = plan.jobId ? count("SELECT COUNT(*) AS count FROM job_events WHERE job_id = ?", plan.jobId) : 0;
    const reviewJobs = plan.jobId ? count("SELECT COUNT(*) AS count FROM review_jobs WHERE original_job_id = ?", plan.jobId) : 0;
    const tvMatchingTasks = plan.jobId ? count("SELECT COUNT(*) AS count FROM tv_matching_tasks WHERE job_id = ?", plan.jobId) : 0;
    const jobOverrides = plan.jobId
      ? count("SELECT COUNT(*) AS count FROM media_type_override_audit WHERE job_id = ?", plan.jobId)
      : 0;
    const fingerprintOverrides = plan.fingerprintExclusive && plan.fingerprint
      ? count("SELECT COUNT(*) AS count FROM media_type_override_audit WHERE fingerprint = ?", plan.fingerprint)
        - (plan.jobId
          ? count("SELECT COUNT(*) AS count FROM media_type_override_audit WHERE fingerprint = ? AND job_id = ?", plan.fingerprint, plan.jobId)
          : 0)
      : 0;
    const fingerprint = plan.fingerprintExclusive ? plan.fingerprint : null;
    return {
      reviewItems,
      jobs,
      jobEvents,
      reviewJobs,
      tvMatchingTasks,
      mediaTypeOverrideAudit: jobOverrides + fingerprintOverrides,
      discRecovery: fingerprint ? count("SELECT COUNT(*) AS count FROM disc_recovery WHERE fingerprint = ?", fingerprint) : 0,
      tvEpisodeFeedback: fingerprint ? count("SELECT COUNT(*) AS count FROM tv_episode_feedback WHERE fingerprint = ?", fingerprint) : 0,
      tvProcessingPlans: fingerprint ? count("SELECT COUNT(*) AS count FROM tv_processing_plans WHERE fingerprint = ?", fingerprint) : 0,
      tvValidationEvidence: fingerprint ? count("SELECT COUNT(*) AS count FROM tv_validation_evidence WHERE fingerprint = ?", fingerprint) : 0
    };
  }

  private assertPlanStillEligible(plan: CleanupPlan): void {
    if (plan.reviewId) {
      const review = this.db.prepare("SELECT status FROM review_items WHERE id = ?")
        .get(plan.reviewId) as { status: string } | undefined;
      if (!review) throw new Error(`Review item ${plan.reviewId} no longer exists`);
      if (review.status === "retrying") throw new Error(`Review item ${plan.reviewId} is currently retrying`);
    }
    if (plan.jobId) {
      const job = this.db.prepare("SELECT status FROM jobs WHERE id = ?").get(plan.jobId) as { status: string } | undefined;
      if (!job) throw new Error(`Job ${plan.jobId} no longer exists`);
      if (activeJobStatuses.has(job.status)) throw new Error(`Job ${plan.jobId} is still processing`);
      const task = this.db.prepare("SELECT status FROM tv_matching_tasks WHERE job_id = ?")
        .get(plan.jobId) as { status: string } | undefined;
      if (task?.status === "processing") throw new Error(`TV matching task ${plan.jobId} is still processing`);
      const retryingReview = this.db.prepare(`
        SELECT 1 FROM review_items WHERE related_job_id = ? AND status = 'retrying' LIMIT 1
      `).get(plan.jobId);
      if (retryingReview) throw new Error(`A review item for job ${plan.jobId} is currently retrying`);
    }
    for (const reviewJobId of plan.reviewJobIds) {
      const reviewJob = this.db.prepare("SELECT status FROM review_jobs WHERE id = ?")
        .get(reviewJobId) as { status: string } | undefined;
      if (!reviewJob) throw new Error(`Review job ${reviewJobId} no longer exists`);
      if (["processing", "retrying"].includes(reviewJob.status)) {
        throw new Error(`Review job ${reviewJobId} is still processing`);
      }
    }
  }

  private async inventory(paths: OwnedPath[]): Promise<{ files: FileEntry[]; directories: string[]; bytes: number; errors: string[] }> {
    const files: FileEntry[] = [];
    const directories: string[] = [];
    const errors: string[] = [];
    for (const resource of paths) {
      try {
        await this.validateOwnedPath(resource);
        const rootInfo = await lstat(resource.path).catch((error: unknown) => {
          if (missing(error)) return undefined;
          throw error;
        });
        if (!rootInfo) continue;
        const walk = async (path: string): Promise<void> => {
          const info = await lstat(path);
          if (info.isSymbolicLink()) throw new Error(`Symbolic link found in owned data; cleanup was stopped: ${path}`);
          if (info.isDirectory()) {
            directories.push(path);
            for (const entry of await readdir(path, { withFileTypes: true })) {
              const child = resolve(path, entry.name);
              if (dirname(child) !== resolve(path)) throw new Error(`File path failed validation: ${child}`);
              await walk(child);
            }
          } else if (info.isFile()) {
            files.push({ path, size: info.size, inode: `${info.dev}:${info.ino}`, links: info.nlink });
          } else {
            throw new Error(`Unsupported filesystem entry in owned data: ${path}`);
          }
        };
        await walk(resource.path);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `Could not inspect ${resource.path}`);
      }
    }
    const seen = new Set<string>();
    const bytes = files.reduce((total, file) => {
      if (file.links !== 1 || seen.has(file.inode)) return total;
      seen.add(file.inode);
      return total + file.size;
    }, 0);
    return { files, directories, bytes, errors };
  }

  private async removeOwnedPath(resource: OwnedPath, outputRoots: string[]): Promise<PathRemovalResult> {
    const errors: string[] = [];
    try {
      await this.validateOwnedPath(resource);
      if (outputRoots.some((output) =>
        isWithin(resource.path, output) || isWithin(output, resource.path))) {
        throw new Error(`Refusing to delete data that overlaps published media: ${resource.path}`);
      }
    } catch (error) {
      return {
        filesDeleted: 0,
        bytesRecovered: 0,
        errors: [error instanceof Error ? error.message : `Ownership validation failed for ${resource.path}`]
      };
    }
    const inventory = await this.inventory([resource]);
    if (inventory.errors.length) return { filesDeleted: 0, bytesRecovered: 0, errors: inventory.errors };
    let filesDeleted = 0;
    let bytesRecovered = 0;
    const seenInodes = new Set<string>();
    for (const file of inventory.files) {
      let info;
      try {
        await this.validateOwnedPath(resource);
        info = await lstat(file.path);
        if (!info.isFile() || info.isSymbolicLink() || !isWithin(resource.path, file.path)) {
          throw new Error(`Owned file changed during cleanup: ${file.path}`);
        }
        await unlink(file.path);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `Could not remove ${file.path}`);
        continue;
      }
      filesDeleted += 1;
      if (info.nlink === 1 && !seenInodes.has(file.inode)) {
        seenInodes.add(file.inode);
        bytesRecovered += info.size;
      }
    }
    for (const directory of inventory.directories.sort((a, b) => b.length - a.length)) {
      try {
        await rmdir(directory);
      } catch (error) {
        errors.push(error instanceof Error ? `${directory}: ${error.message}` : `Could not remove ${directory}`);
      }
    }
    return { filesDeleted, bytesRecovered, errors };
  }

  private async deletePlan(plan: CleanupPlan): Promise<ReviewDeletionResult> {
    const errors: string[] = [];
    let filesDeleted = 0;
    let bytesRecovered = 0;
    try {
      this.assertPlanStillEligible(plan);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Review item became ineligible for deletion");
    }
    for (const resource of plan.paths) {
      if (errors.length) break;
      try {
        this.assertPlanStillEligible(plan);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : "Review item became ineligible for deletion");
        break;
      }
      try {
        const result = await this.removeOwnedPath(resource, this.protectedPaths(this.getSettings()));
        filesDeleted += result.filesDeleted;
        bytesRecovered += result.bytesRecovered;
        errors.push(...result.errors);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `Could not remove ${resource.path}`);
      }
    }
    let recordsDeleted = 0;
    if (errors.length === 0) {
      try {
        recordsDeleted = this.db.transaction(() => {
          this.assertPlanStillEligible(plan);
          let deleted = 0;
          if (plan.reviewId) {
            const reviewResult = plan.jobId
              ? this.db.prepare("DELETE FROM review_items WHERE related_job_id = ? OR id = ?").run(plan.jobId, plan.reviewId)
              : this.db.prepare("DELETE FROM review_items WHERE id = ?").run(plan.reviewId);
            deleted += reviewResult.changes;
          }
          if (plan.jobId) {
            deleted += this.db.prepare("DELETE FROM job_events WHERE job_id = ?").run(plan.jobId).changes;
            deleted += this.db.prepare("DELETE FROM review_jobs WHERE original_job_id = ?").run(plan.jobId).changes;
            deleted += this.db.prepare("DELETE FROM tv_matching_tasks WHERE job_id = ?").run(plan.jobId).changes;
            deleted += this.db.prepare("DELETE FROM media_type_override_audit WHERE job_id = ?").run(plan.jobId).changes;
            deleted += this.db.prepare("DELETE FROM jobs WHERE id = ?").run(plan.jobId).changes;
          }
          if (plan.fingerprint && this.isFingerprintExclusive(plan.fingerprint, plan.jobId, plan.reviewId ?? "")) {
            for (const table of ["disc_recovery", "tv_episode_feedback", "tv_processing_plans", "tv_validation_evidence", "media_type_override_audit"]) {
              deleted += this.db.prepare(`DELETE FROM ${table} WHERE fingerprint = ?`).run(plan.fingerprint).changes;
            }
          }
          return deleted;
        })();
      } catch (error) {
        errors.push(error instanceof Error ? error.message : "Database cleanup failed");
      }
    }
    const success = errors.length === 0;
    const result: ReviewDeletionResult = {
      reviewId: plan.reviewId ?? plan.reviewJobIds[0] ?? "",
      jobId: plan.jobId,
      filesDeleted,
      bytesRecovered,
      recordsDeleted,
      success,
      errors
    };
    log(success ? "info" : "error", "review-cleanup", "Review item cleanup completed", { ...result });
    return result;
  }
}
