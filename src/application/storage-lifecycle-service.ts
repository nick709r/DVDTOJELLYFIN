import type Database from "better-sqlite3";
import { lstat, readdir, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve, sep, isAbsolute } from "node:path";
import type { AppSettings } from "../model.js";
import { outputPath } from "../output-destinations.js";
import { pathsOverlap, tvStagingDirectory } from "../storage-paths.js";
import { log } from "../logger.js";
import {
  ReviewQueueCleanupService,
  type OrphanedDataReport,
  type ReviewDeletionImpact
} from "./review-queue-cleanup-service.js";

export type StorageCategoryId =
  | "review-queue-data"
  | "unmatched-tv-content"
  | "temporary-conversion-files"
  | "artwork-cache"
  | "metadata-cache"
  | "orphaned-data"
  | "staged-rips"
  | "failed-processing-jobs"
  | "temporary-logs";

export interface StorageFile {
  path: string;
  size: number;
  modifiedAt: string;
  identity: string;
  links: number;
}

export interface StorageResource {
  id: string;
  category: StorageCategoryId;
  name: string;
  path: string | null;
  jobId: string | null;
  itemCount: number;
  bytes: number;
  reclaimableBytes: number;
  lastModifiedAt: string | null;
  reclaimable: boolean;
  files: StorageFile[];
  error?: string;
}

export interface StorageCategory {
  id: StorageCategoryId;
  name: string;
  itemCount: number;
  bytes: number;
  reclaimableBytes: number;
  lastModifiedAt: string | null;
  resources: StorageResource[];
}

export interface StorageSummary {
  totalApplicationBytes: number;
  recoverableBytes: number;
  activeProcessingBytes: number;
  reviewQueueBytes: number;
  reviewQueueWarningThresholdGb: AppSettings["storageWarningThresholdGb"];
  autoWarnLargeReviewQueues: boolean;
  reviewQueueWarningActive: boolean;
  largestReviewConsumers: StorageResource[];
  publishedMediaExcluded: true;
  categories: StorageCategory[];
  errors: string[];
}

export interface StorageCleanupImpact {
  category: StorageCategoryId | "everything-safe";
  files: number;
  bytes: number;
  items: number;
  summary: string;
  errors: string[];
}

export interface StorageCleanupResult extends StorageCleanupImpact {
  filesDeleted: number;
  bytesRecovered: number;
  recordsDeleted: number;
  durationMs: number;
  success: boolean;
}

export interface StorageOrphan extends OrphanedDataReport["items"][number] {
  size: number;
  ageDays: number | null;
  originalJobId: string | null;
  modifiedAt: string | null;
}

export interface StorageOrphanReport {
  items: StorageOrphan[];
  errors: string[];
}

interface JobRow {
  id: string;
  status: string;
  output_path: string | null;
  finished_at: string | null;
  title: string | null;
}

interface ReviewJobRow {
  id: string;
  original_job_id: string;
  status: string;
  storage_path: string;
  updated_at: string;
}

interface TvTaskRow {
  job_id: string;
  status: string;
  staging_path: string;
  updated_at: string;
}

interface CacheRow {
  cache_key: string;
  cached_at: string;
  bytes: number;
}

const activeJobStatuses = new Set(["inspecting", "ripping", "converting", "publishing"]);
const removableReviewStatuses = new Set(["pending", "dismissed", "completed"]);
const categoryNames: Record<StorageCategoryId, string> = {
  "review-queue-data": "Review Queue Data",
  "unmatched-tv-content": "Unmatched TV Content",
  "temporary-conversion-files": "Temporary Conversion Files",
  "artwork-cache": "Artwork Cache",
  "metadata-cache": "Metadata Cache",
  "orphaned-data": "Orphaned Data",
  "staged-rips": "Staged Rips",
  "failed-processing-jobs": "Failed Processing Jobs",
  "temporary-logs": "Temporary Logs"
};

const allCategories = Object.keys(categoryNames) as StorageCategoryId[];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const outputTempPattern = /^\.autodisc-([0-9a-f-]{36})-[0-9a-f-]{36}\.(mp4|mkv)$/i;

function within(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isLogFile(path: string): boolean {
  return /\.(log|log\.\d+)$/i.test(path) || /(^|[\\/])logs?([\\/]|$)/i.test(path);
}

function uniqueBytes(files: readonly StorageFile[]): number {
  const identities = new Set<string>();
  let total = 0;
  for (const file of files) {
    if (identities.has(file.identity)) continue;
    identities.add(file.identity);
    total += file.size;
  }
  return total;
}

function reclaimableBytes(files: readonly StorageFile[]): number {
  const filesByIdentity = new Map<string, StorageFile[]>();
  for (const file of files) {
    filesByIdentity.set(file.identity, [...(filesByIdentity.get(file.identity) ?? []), file]);
  }
  let total = 0;
  for (const group of filesByIdentity.values()) {
    const first = group[0];
    if (first && group.length >= first.links) total += first.size;
  }
  return total;
}

export function shouldWarnForReviewStorage(
  bytes: number,
  thresholdGb: AppSettings["storageWarningThresholdGb"],
  enabled: boolean
): boolean {
  return enabled && thresholdGb !== null && bytes >= thresholdGb * 1024 ** 3;
}

export class StorageLifecycleService {
  constructor(
    private readonly db: Database.Database,
    private readonly getSettings: () => AppSettings,
    private readonly reviewCleanup: ReviewQueueCleanupService
  ) {}

  async getStorageSummary(): Promise<StorageSummary> {
    const categories = await this.getCategoryBreakdown();
    const activeProcessingBytes = await this.getActiveProcessingBytes();
    const reviewOwned = await this.getReviewOwnedFiles();
    const safeResources = categories.flatMap(({ resources }) =>
      resources.filter((resource) => resource.reclaimable)
    );
    const reviewResources = categories.flatMap(({ resources }) =>
      resources.filter((resource) => resource.id.startsWith("review:"))
    );
    const reviewConsumers = new Map<string, StorageFile[]>();
    const reviewLabels = new Map((this.db.prepare("SELECT id, disc_label FROM review_jobs")
      .all() as Array<{ id: string; disc_label: string | null }>)
      .map((review) => [review.id, review.disc_label || review.id]));
    for (const resource of reviewResources) {
      const [, reviewId] = resource.id.split(":");
      if (!reviewId) continue;
      reviewConsumers.set(reviewId, [...(reviewConsumers.get(reviewId) ?? []), ...resource.files]);
    }
    const largestReviewConsumers = [...reviewConsumers].map(([reviewId, files]) => ({
      id: `review-total:${reviewId}`,
      category: "review-queue-data" as const,
      name: reviewLabels.get(reviewId) ?? reviewId,
      path: resolve(this.getSettings().workDir, "reviews", reviewId),
      jobId: reviewId,
      itemCount: files.length,
      bytes: uniqueBytes(files),
      reclaimableBytes: reclaimableBytes(files),
      lastModifiedAt: files.map(({ modifiedAt }) => modifiedAt).sort().at(-1) ?? null,
      reclaimable: true,
      files
    })).sort((first, second) => second.bytes - first.bytes).slice(0, 3);
    const settings = this.getSettings();
    const summaryFiles = new Map<string, StorageFile>();
    for (const file of [...safeResources.flatMap(({ files }) => files), ...reviewOwned.files]) {
      summaryFiles.set(file.path.toLowerCase(), file);
    }
    const reviewFiles = new Map<string, StorageFile>();
    for (const file of [...reviewResources.flatMap(({ files }) => files), ...reviewOwned.files]) {
      reviewFiles.set(file.path.toLowerCase(), file);
    }
    const reviewQueueBytes = uniqueBytes([...reviewFiles.values()]);
    const errors = categories.flatMap((category) =>
      category.resources.flatMap((resource) => resource.error ? [resource.error] : [])
    ).concat(reviewOwned.errors);
    const metadataCacheBytes = categories.find(({ id }) => id === "metadata-cache")?.reclaimableBytes ?? 0;
    return {
      totalApplicationBytes: categories.reduce((sum, category) => sum + category.bytes, 0) + activeProcessingBytes,
      recoverableBytes: reclaimableBytes([...summaryFiles.values()]) + metadataCacheBytes,
      activeProcessingBytes,
      reviewQueueBytes,
      reviewQueueWarningThresholdGb: settings.storageWarningThresholdGb,
      autoWarnLargeReviewQueues: settings.autoWarnLargeReviewQueues,
      reviewQueueWarningActive: shouldWarnForReviewStorage(
        reviewQueueBytes, settings.storageWarningThresholdGb, settings.autoWarnLargeReviewQueues
      ),
      largestReviewConsumers,
      publishedMediaExcluded: true,
      categories,
      errors
    };
  }

  async getCategoryBreakdown(): Promise<StorageCategory[]> {
    const resources = await this.inventoryResources();
    const usedPhysicalFiles = new Set<string>();
    const categories = allCategories.map((id) => {
      const categoryResources = resources.filter((resource) => resource.category === id);
      let bytes = 0;
      const categoryFiles = categoryResources.filter((resource) => resource.reclaimable)
        .flatMap(({ files: resourceFiles }) => resourceFiles);
      const reclaimableTotal = reclaimableBytes(categoryFiles);
      for (const resource of categoryResources) {
        if (id === "metadata-cache") {
          bytes += resource.bytes;
        }
        for (const file of resource.files) {
          if (!usedPhysicalFiles.has(file.identity)) {
            usedPhysicalFiles.add(file.identity);
            bytes += file.size;
          }
        }
      }
      const times = categoryResources.flatMap(({ lastModifiedAt }) => lastModifiedAt ? [lastModifiedAt] : []);
      return {
        id,
        name: categoryNames[id],
        itemCount: categoryResources.length,
        bytes,
        reclaimableBytes: reclaimableTotal,
        lastModifiedAt: times.sort().at(-1) ?? null,
        resources: categoryResources
      };
    });
    return categories;
  }

  async getLargestConsumers(limit = 10): Promise<StorageResource[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Largest-consumer limit must be between 1 and 100");
    }
    const resources = await this.inventoryResources();
    return resources
      .filter(({ bytes }) => bytes > 0)
      .sort((first, second) => second.bytes - first.bytes)
      .slice(0, limit);
  }

  async getReviewStorageBreakdown(): Promise<Array<{
    reviewId: string;
    stagedBytes: number;
    artworkBytes: number;
    metadataBytes: number;
    totalBytes: number;
  }>> {
    const settings = this.getSettings();
    const reviews = this.db.prepare("SELECT id, storage_path FROM review_jobs")
      .all() as Array<{ id: string; storage_path: string }>;
    const result: Array<{
    reviewId: string;
    stagedBytes: number;
    artworkBytes: number;
    metadataBytes: number;
    totalBytes: number;
    }> = [];
    for (const review of reviews) {
      const workspace = resolve(settings.workDir, "reviews", review.id);
      if (resolve(review.storage_path) !== workspace) continue;
      const files = await this.inventoryTree(workspace);
      const media: StorageFile[] = [];
      const artwork: StorageFile[] = [];
      const metadata: StorageFile[] = [];
      for (const file of files) {
        const top = relative(workspace, file.path).split(/[\\/]/, 1)[0]?.toLowerCase();
        if (top === "media") media.push(file);
        else if (top === "artwork") artwork.push(file);
        else if (!isLogFile(file.path)) metadata.push(file);
      }
      result.push({
        reviewId: review.id,
        stagedBytes: uniqueBytes(media),
        artworkBytes: uniqueBytes(artwork),
        metadataBytes: uniqueBytes(metadata),
        totalBytes: uniqueBytes(files)
      });
    }
    return result;
  }

  async getOrphanedResources(): Promise<StorageOrphanReport> {
    const report = await this.reviewCleanup.scanOrphanedData();
    const result: StorageOrphan[] = [];
    for (const item of report.items) {
      const files = await this.inventoryTree(item.path);
      const latest = files.map(({ modifiedAt }) => modifiedAt).sort().at(-1) ?? null;
      const oldest = files.map(({ modifiedAt }) => modifiedAt).sort()[0];
      const ageDays = oldest
        ? Math.max(0, Math.floor((Date.now() - Date.parse(oldest)) / 86_400_000))
        : null;
      result.push({
        ...item,
        size: uniqueBytes(files),
        ageDays,
        originalJobId: this.findOriginalJobId(item.id, item.kind),
        modifiedAt: latest
      });
    }
    return { items: result, errors: report.errors };
  }

  async calculateRecoverableSpace(category?: StorageCategoryId | "everything-safe"): Promise<number> {
    const impact = await this.getCleanupImpact(category ?? "everything-safe");
    return impact.bytes;
  }

  async getCleanupImpact(category: StorageCategoryId | "everything-safe"): Promise<StorageCleanupImpact> {
    if (category === "everything-safe") {
      const resources = await this.inventoryResources();
      const cleanable = new Set<StorageCategoryId>([
        "review-queue-data", "temporary-conversion-files", "artwork-cache",
        "metadata-cache", "orphaned-data", "failed-processing-jobs", "temporary-logs"
      ]);
      const files = resources.filter((resource) => cleanable.has(resource.category) && resource.reclaimable)
        .flatMap(({ files: resourceFiles }) => resourceFiles);
      const reviewOwned = await this.getReviewOwnedFiles();
      const filesByPath = new Map(files.map((file) => [file.path.toLowerCase(), file]));
      for (const file of reviewOwned.files) filesByPath.set(file.path.toLowerCase(), file);
      const allFiles = [...filesByPath.values()];
      const cache = this.metadataCacheRows();
      return {
        category,
        files: allFiles.length,
        bytes: reclaimableBytes(allFiles) + cache.reduce((sum, row) => sum + row.bytes, 0),
        items: resources.filter((resource) => cleanable.has(resource.category) &&
          resource.reclaimable && !resource.id.startsWith("review:")).length + cache.length + reviewOwned.items,
        summary: "Removes owned review data, generated caches, failed-job work files, and validated orphaned workspaces. Unrelated unmatched TV content, staged rips, active work, published media, and job history are preserved.",
        errors: [
          ...resources.filter((resource) => resource.error && cleanable.has(resource.category))
            .map((resource) => resource.error!),
          ...reviewOwned.errors
        ]
      };
    }
    const resources = await this.inventoryResources();
    const selected = resources.filter((resource) => resource.category === category && resource.reclaimable);
    const errors = resources
      .filter((resource) => resource.category === category && resource.error)
      .map((resource) => resource.error!);
    if (category === "review-queue-data") {
      const rows = this.db.prepare("SELECT id, related_job_id, status FROM review_items")
        .all() as Array<{ id: string; related_job_id: string | null; status: string }>;
      const seenJobs = new Set<string>();
      let files = 0;
      let bytes = 0;
      for (const row of rows) {
        if (row.status === "retrying" || (row.related_job_id && seenJobs.has(row.related_job_id))) continue;
        if (row.related_job_id) seenJobs.add(row.related_job_id);
        try {
          const impact = await this.reviewCleanup.getDeletionImpact(row.id);
          files += impact.files;
          bytes += impact.bytes;
          if (impact.jobId) seenJobs.add(impact.jobId);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : `Review item ${row.id} could not be inspected`);
        }
      }
      const reviewJobs = this.db.prepare(`
        SELECT id, original_job_id, status FROM review_jobs
      `).all() as Array<{ id: string; original_job_id: string; status: string }>;
      let unassociatedReviewJobCount = 0;
      for (const review of reviewJobs) {
        if (seenJobs.has(review.original_job_id) || !removableReviewStatuses.has(review.status)) continue;
        seenJobs.add(review.original_job_id);
        unassociatedReviewJobCount += 1;
        try {
          const impact = await this.reviewCleanup.getReviewJobDeletionImpact(review.id);
          files += impact.files;
          bytes += impact.bytes;
        } catch (error) {
          errors.push(error instanceof Error ? error.message : `Review job ${review.id} could not be inspected`);
        }
      }
      return {
        category,
        files,
        bytes,
        items: rows.filter((row) => row.status !== "retrying").length + unassociatedReviewJobCount,
        summary: this.cleanupDescription(category),
        errors
      };
    }
    if (category === "metadata-cache") {
      const cache = this.metadataCacheRows();
      return {
        category,
        files: 0,
        bytes: cache.reduce((sum, row) => sum + row.bytes, 0),
        items: cache.length,
        summary: "Deletes cached metadata rows. SQLite may reuse the freed pages; the database file itself is retained.",
        errors
      };
    }
    return {
      category,
      files: selected.reduce((sum, resource) => sum + resource.files.length, 0),
      bytes: selected.reduce((sum, resource) => sum + resource.reclaimableBytes, 0),
      items: selected.length,
      summary: this.cleanupDescription(category),
      errors
    };
  }

  async cleanupCategory(category: StorageCategoryId): Promise<StorageCleanupResult> {
    const startedAt = Date.now();
    const impact = await this.getCleanupImpact(category);
    const errors = [...impact.errors];
    let filesDeleted = 0;
    let bytesRecovered = 0;
    let recordsDeleted = 0;
    try {
      if (category === "metadata-cache") {
        const deleted = this.db.prepare("DELETE FROM tv_metadata_cache").run();
        recordsDeleted += deleted.changes;
      } else if (category === "orphaned-data") {
        const cleanup = await this.reviewCleanup.deleteOrphanedData();
        filesDeleted += cleanup.filesDeleted;
        bytesRecovered += cleanup.bytesRecovered;
        recordsDeleted += cleanup.recordsDeleted;
        errors.push(...cleanup.errors);
      } else if (category === "review-queue-data" || category === "artwork-cache") {
        const result = category === "artwork-cache"
          ? await this.cleanupReviewArtwork()
          : await this.cleanupReviewResources();
        filesDeleted += result.filesDeleted;
        bytesRecovered += result.bytesRecovered;
        recordsDeleted += result.recordsDeleted;
        errors.push(...result.errors);
      } else {
        const resources = (await this.inventoryResources())
          .filter((resource) => resource.category === category && resource.reclaimable);
        for (const resource of resources) {
          try {
            const reclaimed = resource.id.startsWith("review:")
              ? await this.deleteReviewWorkspaceFiles(resource)
              : await this.deleteResource(resource);
            filesDeleted += reclaimed.filesDeleted;
            bytesRecovered += reclaimed.bytesRecovered;
            recordsDeleted += reclaimed.recordsDeleted;
          } catch (error) {
            errors.push(error instanceof Error ? error.message : `Could not clean ${resource.name}`);
          }
        }
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `Could not clean ${categoryNames[category]}`);
    }
    const durationMs = Date.now() - startedAt;
    const success = errors.length === 0;
    const result: StorageCleanupResult = {
      ...impact,
      filesDeleted,
      bytesRecovered,
      recordsDeleted,
      durationMs,
      success,
      errors
    };
    log(success ? "info" : "error", "storage-lifecycle", "Storage cleanup completed", {
      category,
      filesDeleted,
      bytesRecovered,
      durationMs,
      errors,
      success
    });
    return result;
  }

  async cleanupEverythingSafe(): Promise<StorageCleanupResult> {
    const startedAt = Date.now();
    const impact = await this.getCleanupImpact("everything-safe");
    const categories: StorageCategoryId[] = [
      "review-queue-data", "temporary-conversion-files", "artwork-cache",
      "metadata-cache", "orphaned-data", "failed-processing-jobs", "temporary-logs"
    ];
    let filesDeleted = 0;
    let bytesRecovered = 0;
    let recordsDeleted = 0;
    const errors = [...impact.errors];
    for (const category of categories) {
      const result = await this.cleanupCategory(category);
      filesDeleted += result.filesDeleted;
      bytesRecovered += result.bytesRecovered;
      recordsDeleted += result.recordsDeleted;
      errors.push(...result.errors);
    }
    const durationMs = Date.now() - startedAt;
    const success = errors.length === 0;
    const result = {
      ...impact,
      filesDeleted,
      bytesRecovered,
      recordsDeleted,
      durationMs,
      success,
      errors
    };
    log(success ? "info" : "error", "storage-lifecycle", "Safe storage cleanup completed", {
      category: "everything-safe",
      filesDeleted,
      bytesRecovered,
      durationMs,
      errors,
      success
    });
    return result;
  }

  async runScheduledMaintenance(now = Date.now()): Promise<StorageCleanupResult[]> {
    const settings = this.getSettings();
    const completed: StorageCleanupResult[] = [];
    const logAge = settings.autoCleanTempLogsAfterDays;
    const conversionAge = settings.autoCleanFailedConversionsAfterDays;
    if (logAge !== null && logAge > 0) {
      completed.push(await this.cleanupOldFiles("temporary-logs", logAge, now));
    }
    if (conversionAge !== null && conversionAge > 0) {
      completed.push(await this.cleanupOldFailedConversions(conversionAge, now));
    }
    return completed;
  }

  private async cleanupOldFailedConversions(ageDays: number, now: number): Promise<StorageCleanupResult> {
    const startedAt = Date.now();
    const resources = (await this.inventoryResources()).filter((resource) => {
      if (resource.category !== "temporary-conversion-files" || !resource.id.startsWith("output-temp:")) return false;
      const job = resource.jobId
        ? this.db.prepare("SELECT status FROM jobs WHERE id = ?").get(resource.jobId) as { status: string } | undefined
        : undefined;
      return job?.status === "failed";
    });
    let filesDeleted = 0;
    let bytesRecovered = 0;
    const errors: string[] = [];
    const cutoff = now - ageDays * 86_400_000;
    for (const resource of resources) {
      const oldFiles = resource.files.filter((file) => Date.parse(file.modifiedAt) <= cutoff);
      if (oldFiles.length === 0) continue;
      try {
        const owner = resource.jobId!;
        const job = this.db.prepare("SELECT status, output_path FROM jobs WHERE id = ?")
          .get(owner) as { status: string; output_path: string | null } | undefined;
        if (!job || job.status !== "failed" || !job.output_path) {
          throw new Error(`Failed conversion ownership changed for ${resource.name}`);
        }
        for (const file of oldFiles) {
          const match = outputTempPattern.exec(basename(file.path));
          if (match?.[1]?.toLowerCase() !== owner.toLowerCase() ||
            dirname(file.path) !== dirname(resolve(job.output_path))) {
            throw new Error(`Failed conversion output ownership changed for ${file.path}`);
          }
        }
        const result = await this.deleteOwnedFiles(resource, oldFiles);
        filesDeleted += result.filesDeleted;
        bytesRecovered += result.bytesRecovered;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `Could not remove failed conversion ${resource.name}`);
      }
    }
    const durationMs = Date.now() - startedAt;
    const success = errors.length === 0;
    const result: StorageCleanupResult = {
      category: "temporary-conversion-files",
      files: filesDeleted,
      bytes: bytesRecovered,
      items: resources.length,
      summary: `Automatically removed only failed-job conversion temporary files older than ${ageDays} days.`,
      filesDeleted,
      bytesRecovered,
      recordsDeleted: 0,
      durationMs,
      success,
      errors
    };
    log(success ? "info" : "error", "storage-lifecycle", "Scheduled failed-conversion cleanup completed", {
      category: "temporary-conversion-files",
      filesDeleted,
      bytesRecovered,
      durationMs,
      errors,
      success
    });
    return result;
  }

  private async cleanupOldFiles(category: StorageCategoryId, ageDays: number, now: number): Promise<StorageCleanupResult> {
    const startedAt = Date.now();
    const resources = (await this.inventoryResources()).filter((resource) =>
      resource.category === category && resource.reclaimable
    );
    let filesDeleted = 0;
    let bytesRecovered = 0;
    const errors: string[] = [];
    const cutoff = now - ageDays * 86_400_000;
    for (const resource of resources) {
      const oldFiles = resource.files.filter((file) => Date.parse(file.modifiedAt) <= cutoff);
      if (oldFiles.length === 0) continue;
      try {
        const result = await this.deleteOwnedFiles(resource, oldFiles);
        filesDeleted += result.filesDeleted;
        bytesRecovered += result.bytesRecovered;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `Could not remove old files for ${resource.name}`);
      }
    }
    const durationMs = Date.now() - startedAt;
    const success = errors.length === 0;
    const result: StorageCleanupResult = {
      category,
      files: filesDeleted,
      bytes: bytesRecovered,
      items: resources.length,
      summary: `Automatically removed generated files older than ${ageDays} days; user media and review items are never automatically deleted.`,
      filesDeleted,
      bytesRecovered,
      recordsDeleted: 0,
      durationMs,
      success,
      errors
    };
    log(success ? "info" : "error", "storage-lifecycle", "Scheduled storage maintenance completed", {
      category,
      filesDeleted,
      bytesRecovered,
      durationMs,
      errors,
      success
    });
    return result;
  }

  private async inventoryResources(): Promise<StorageResource[]> {
    const settings = this.getSettings();
    const result: StorageResource[] = [];
    const jobs = this.db.prepare("SELECT id, status, output_path, finished_at, title FROM jobs")
      .all() as JobRow[];
    const jobsById = new Map(jobs.map((job) => [job.id, job]));
    const reviewJobs = this.db.prepare(`
      SELECT id, original_job_id, status, storage_path, updated_at FROM review_jobs
    `).all() as ReviewJobRow[];
    const reviewJobIds = new Set(reviewJobs.map(({ original_job_id }) => original_job_id));
    const tasks = this.db.prepare("SELECT job_id, status, staging_path, updated_at FROM tv_matching_tasks")
      .all() as TvTaskRow[];

    for (const review of reviewJobs) {
      if (["processing", "retrying"].includes(review.status)) continue;
      const expected = resolve(settings.workDir, "reviews", review.id);
      if (resolve(review.storage_path) !== expected || !within(resolve(settings.workDir, "reviews"), expected)) {
        result.push(this.resource(`review:${review.id}:unsafe`, "review-queue-data", review.id, expected, review.original_job_id, [], false,
          `Review workspace path does not match the owned workspace for ${review.id}`));
        continue;
      }
      const files = await this.inventoryTree(expected);
      const groups = new Map<StorageCategoryId, StorageFile[]>();
      for (const file of files) {
        const relativePath = relative(expected, file.path);
        const top = relativePath.split(/[\\/]/, 1)[0] ?? "";
        const category = top.toLowerCase() === "artwork" ? "artwork-cache"
          : isLogFile(relativePath) ? "temporary-logs" : "review-queue-data";
        const group = groups.get(category) ?? [];
        group.push(file);
        groups.set(category, group);
      }
      const statusAllowed = removableReviewStatuses.has(review.status);
      for (const [category, groupedFiles] of groups) {
        const rootName = category === "artwork-cache" ? "artwork"
          : category === "temporary-logs" ? "logs" : null;
        const resourcePath = rootName ? resolve(expected, rootName) : expected;
        result.push(this.createResource(
          `review:${review.id}:${category}`, category, review.id, resourcePath,
          review.original_job_id, groupedFiles, statusAllowed
        ));
      }
      if (groups.size === 0) {
        result.push(this.createResource(`review:${review.id}:empty`, "review-queue-data", review.id,
          expected, review.original_job_id, [], statusAllowed));
      }
    }

    for (const task of tasks) {
      if (["processing", "completed"].includes(task.status)) continue;
      const expected = resolve(tvStagingDirectory(settings), task.job_id);
      if (resolve(task.staging_path) !== expected || !within(tvStagingDirectory(settings), expected)) {
        result.push(this.resource(`staging:${task.job_id}:unsafe`, "unmatched-tv-content", task.job_id,
          expected, task.job_id, [], false, `TV staging path is not owned by job ${task.job_id}`));
        continue;
      }
      result.push(this.createResource(`staging:${task.job_id}`, "unmatched-tv-content",
        task.job_id, expected, task.job_id, await this.inventoryTree(expected), false));
    }

    for (const job of jobs) {
      const workPath = resolve(settings.workDir, job.id);
      const files = await this.inventoryTree(workPath);
      if (files.length === 0) continue;
      const active = activeJobStatuses.has(job.status);
      if (active) continue;
      const groups = new Map<string, StorageFile[]>();
      for (const file of files) {
        const firstSegment = relative(workPath, file.path).split(/[\\/]/, 1)[0] ?? "";
        const key = firstSegment.startsWith("rip-") ? `rip:${firstSegment}`
          : job.status === "failed" && !reviewJobIds.has(job.id) ? "failed"
          : isLogFile(file.path) ? "logs" : "conversion";
        const group = groups.get(key) ?? [];
        group.push(file);
        groups.set(key, group);
      }
      for (const [key, groupedFiles] of groups) {
        if (key.startsWith("rip:")) {
          const folder = key.slice(4);
          result.push(this.createResource(`rip:${job.id}:${folder}`, "staged-rips",
            basename(folder), resolve(workPath, folder), job.id, groupedFiles, false));
        } else if (key === "failed") {
          result.push(this.createResource(`failed:${job.id}`, "failed-processing-jobs",
            job.title ?? job.id, workPath, job.id, groupedFiles, true));
        } else if (key === "logs") {
          result.push(this.createResource(`job-log:${job.id}`, "temporary-logs",
            job.title ?? job.id, workPath, job.id, groupedFiles, true));
        } else {
          result.push(this.createResource(`conversion:${job.id}`, "temporary-conversion-files",
            job.title ?? job.id, workPath, job.id, groupedFiles, true));
        }
      }
    }

    const orphanReport = await this.reviewCleanup.scanOrphanedData();
    for (const orphan of orphanReport.items) {
      const files = await this.inventoryTree(orphan.path);
      result.push(this.createResource(`orphan:${orphan.kind}:${orphan.id}`, "orphaned-data",
        orphan.id, orphan.path, orphan.id, files, true));
    }

    for (const file of await this.findOwnedOutputTemps(jobs)) {
      result.push(this.createResource(`output-temp:${file.jobId}:${file.file.path}`,
        "temporary-conversion-files", basename(file.file.path), file.directory,
        file.jobId, [file.file], true));
    }

    const cacheRows = this.metadataCacheRows();
    if (cacheRows.length > 0) {
      result.push({
        id: "metadata-cache",
        category: "metadata-cache",
        name: "TV metadata cache",
        path: null,
        jobId: null,
        itemCount: cacheRows.length,
        bytes: cacheRows.reduce((sum, row) => sum + row.bytes, 0),
        reclaimableBytes: cacheRows.reduce((sum, row) => sum + row.bytes, 0),
        lastModifiedAt: cacheRows.map(({ cached_at }) => cached_at).sort().at(-1) ?? null,
        reclaimable: true,
        files: []
      });
    }
    return result;
  }

  private async findOwnedOutputTemps(jobs: JobRow[]): Promise<Array<{ file: StorageFile; directory: string; jobId: string }>> {
    const settings = this.getSettings();
    const outputRoots = this.protectedOutputRoots(settings);
    const jobsById = new Map(jobs.map((job) => [job.id, job]));
    const result: Array<{ file: StorageFile; directory: string; jobId: string }> = [];
    const seen = new Set<string>();
    for (const job of jobs) {
      if (!job.output_path || activeJobStatuses.has(job.status)) continue;
      const directory = dirname(resolve(job.output_path));
      if (seen.has(directory)) continue;
      seen.add(directory);
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink()) continue;
        const match = outputTempPattern.exec(entry.name);
        if (!match) continue;
        const ownerId = match[1] ?? "";
        if (!uuidPattern.test(ownerId)) continue;
        const owner = jobsById.get(ownerId);
        if (!owner || activeJobStatuses.has(owner.status) || !owner.output_path) continue;
        const path = resolve(directory, entry.name);
        if (dirname(path) !== directory || outputRoots.some((root) => pathsOverlap(path, root) && !within(root, path))) continue;
        if (dirname(resolve(owner.output_path)) !== directory || extname(owner.output_path).slice(1).toLowerCase() !== (match[2] ?? "").toLowerCase()) continue;
        const file = await this.fileEntry(path);
        result.push({ file, directory, jobId: ownerId });
      }
    }
    return result;
  }

  private async getActiveProcessingBytes(): Promise<number> {
    const settings = this.getSettings();
    const files = new Map<string, StorageFile>();
    const activeJobs = this.db.prepare("SELECT id FROM jobs WHERE status IN ('inspecting', 'ripping', 'converting', 'publishing')")
      .all() as Array<{ id: string }>;
    for (const { id } of activeJobs) {
      for (const file of await this.inventoryTree(resolve(settings.workDir, id))) files.set(file.identity, file);
    }
    const activeTasks = this.db.prepare("SELECT job_id, staging_path FROM tv_matching_tasks WHERE status = 'processing'")
      .all() as Array<{ job_id: string; staging_path: string }>;
    for (const task of activeTasks) {
      const expected = resolve(tvStagingDirectory(settings), task.job_id);
      if (resolve(task.staging_path) !== expected) continue;
      for (const file of await this.inventoryTree(expected)) files.set(file.identity, file);
    }
    const activeReviews = this.db.prepare("SELECT id, storage_path FROM review_jobs WHERE status IN ('processing', 'retrying')")
      .all() as Array<{ id: string; storage_path: string }>;
    for (const review of activeReviews) {
      const expected = resolve(settings.workDir, "reviews", review.id);
      if (resolve(review.storage_path) !== expected) continue;
      for (const file of await this.inventoryTree(expected)) files.set(file.identity, file);
    }
    return [...files.values()].reduce((sum, file) => sum + file.size, 0);
  }

  private metadataCacheRows(): CacheRow[] {
    const rows = this.db.prepare(`
      SELECT cache_key, cached_at, length(CAST(result_json AS BLOB)) + length(CAST(input_json AS BLOB)) AS bytes
      FROM tv_metadata_cache
    `).all() as CacheRow[];
    return rows.map((row) => ({ ...row, bytes: Math.max(0, Number(row.bytes) || 0) }));
  }

  private async getReviewOwnedFiles(): Promise<{ files: StorageFile[]; items: number; errors: string[] }> {
    const rows = this.db.prepare("SELECT id, related_job_id, status FROM review_items")
      .all() as Array<{ id: string; related_job_id: string | null; status: string }>;
    const seenJobs = new Set<string>();
    const paths = new Set<string>();
    const files: StorageFile[] = [];
    const errors: string[] = [];
    let items = 0;
    const collect = async (impact: ReviewDeletionImpact): Promise<void> => {
      items += 1;
      if (impact.jobId) seenJobs.add(impact.jobId);
      for (const path of impact.ownedPaths) {
        const normalized = resolve(path).toLowerCase();
        if (paths.has(normalized)) continue;
        paths.add(normalized);
        files.push(...await this.inventoryTree(path));
      }
      errors.push(...impact.errors);
    };
    for (const row of rows) {
      if (row.status === "retrying" || (row.related_job_id && seenJobs.has(row.related_job_id))) continue;
      if (row.related_job_id) seenJobs.add(row.related_job_id);
      try {
        await collect(await this.reviewCleanup.getDeletionImpact(row.id));
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `Review item ${row.id} could not be inspected`);
      }
    }
    const reviewJobs = this.db.prepare("SELECT id, original_job_id, status FROM review_jobs")
      .all() as Array<{ id: string; original_job_id: string; status: string }>;
    for (const review of reviewJobs) {
      if (seenJobs.has(review.original_job_id) || !removableReviewStatuses.has(review.status)) continue;
      seenJobs.add(review.original_job_id);
      try {
        await collect(await this.reviewCleanup.getReviewJobDeletionImpact(review.id));
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `Review job ${review.id} could not be inspected`);
      }
    }
    return { files, items, errors };
  }

  private async inventoryTree(root: string): Promise<StorageFile[]> {
    let rootInfo;
    try {
      rootInfo = await lstat(root);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    if (rootInfo.isSymbolicLink()) throw new Error(`Storage inventory refuses symbolic link: ${root}`);
    if (rootInfo.isFile()) return [this.toStorageFile(root, rootInfo)];
    if (!rootInfo.isDirectory()) throw new Error(`Unsupported storage entry: ${root}`);
    const files: StorageFile[] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = resolve(root, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`Storage inventory refuses symbolic link: ${path}`);
      if (info.isDirectory()) files.push(...await this.inventoryTree(path));
      else if (info.isFile()) files.push(this.toStorageFile(path, info));
      else throw new Error(`Unsupported storage entry: ${path}`);
    }
    return files;
  }

  private async fileEntry(path: string): Promise<StorageFile> {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Expected a regular owned file: ${path}`);
    return this.toStorageFile(path, info);
  }

  private toStorageFile(path: string, info: Awaited<ReturnType<typeof lstat>>): StorageFile {
    const identity = info.ino ? `${info.dev}:${info.ino}` : resolve(path).toLowerCase();
    return {
      path: resolve(path),
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
      identity,
      links: info.nlink
    };
  }

  private createResource(
    id: string,
    category: StorageCategoryId,
    name: string,
    path: string,
    jobId: string | null,
    files: StorageFile[],
    reclaimable: boolean
  ): StorageResource {
    const timestamps = files.map(({ modifiedAt }) => modifiedAt).sort();
    const bytes = uniqueBytes(files);
    return {
      id,
      category,
      name,
      path: resolve(path),
      jobId,
      itemCount: files.length,
      bytes,
      reclaimableBytes: reclaimable ? reclaimableBytes(files) : 0,
      lastModifiedAt: timestamps.at(-1) ?? null,
      reclaimable,
      files
    };
  }

  private resource(
    id: string,
    category: StorageCategoryId,
    name: string,
    path: string,
    jobId: string | null,
    files: StorageFile[],
    reclaimable: boolean,
    error: string
  ): StorageResource {
    return { ...this.createResource(id, category, name, path, jobId, files, reclaimable), error };
  }

  private async cleanupReviewResources(): Promise<{
    filesDeleted: number;
    bytesRecovered: number;
    recordsDeleted: number;
    errors: string[];
  }> {
    const reviews = this.db.prepare("SELECT id FROM review_items").all() as Array<{ id: string }>;
    let filesDeleted = 0;
    let bytesRecovered = 0;
    let recordsDeleted = 0;
    const errors: string[] = [];

    for (const review of reviews) {
      const current = this.db.prepare("SELECT status FROM review_items WHERE id = ?")
        .get(review.id) as { status: string } | undefined;
      if (!current || current.status === "retrying") continue;
      try {
        const impact: ReviewDeletionImpact = await this.reviewCleanup.getDeletionImpact(review.id);
        const deletion = await this.reviewCleanup.deleteReviewItem(review.id);
        filesDeleted += deletion.filesDeleted;
        bytesRecovered += deletion.bytesRecovered;
        recordsDeleted += deletion.recordsDeleted;
        if (!deletion.success) errors.push(...deletion.errors);
        if (impact.errors.length > 0) errors.push(...impact.errors);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `Could not delete review item ${review.id}`);
      }
    }

    const reviewJobs = this.db.prepare("SELECT id, status FROM review_jobs").all() as Array<{ id: string; status: string }>;
    for (const review of reviewJobs) {
      if (!removableReviewStatuses.has(review.status)) continue;
      try {
        const impact = await this.reviewCleanup.getReviewJobDeletionImpact(review.id);
        const deletion = await this.reviewCleanup.deleteReviewJob(review.id);
        filesDeleted += deletion.filesDeleted;
        bytesRecovered += deletion.bytesRecovered;
        recordsDeleted += deletion.recordsDeleted;
        if (!deletion.success) errors.push(...deletion.errors);
        if (impact.errors.length > 0) errors.push(...impact.errors);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `Could not delete review job ${review.id}`);
      }
    }
    return { filesDeleted, bytesRecovered, recordsDeleted, errors };
  }

  private async cleanupReviewArtwork(): Promise<{
    filesDeleted: number;
    bytesRecovered: number;
    recordsDeleted: number;
    errors: string[];
  }> {
    const resources = (await this.inventoryResources()).filter((resource) =>
      resource.category === "artwork-cache" && resource.reclaimable
    );
    let filesDeleted = 0;
    let bytesRecovered = 0;
    const errors: string[] = [];
    for (const resource of resources) {
      try {
        const result = await this.deleteReviewWorkspaceFiles(resource);
        filesDeleted += result.filesDeleted;
        bytesRecovered += result.bytesRecovered;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `Could not clear artwork for ${resource.name}`);
      }
    }
    return { filesDeleted, bytesRecovered, recordsDeleted: 0, errors };
  }

  private async deleteReviewWorkspaceFiles(resource: StorageResource): Promise<{
    filesDeleted: number;
    bytesRecovered: number;
    recordsDeleted: number;
  }> {
    const [, reviewJobId, category] = resource.id.split(":");
    if (!reviewJobId || !uuidPattern.test(reviewJobId) || !resource.path) {
      throw new Error(`Review workspace resource is missing a valid owner: ${resource.id}`);
    }
    const review = this.db.prepare("SELECT status, storage_path FROM review_jobs WHERE id = ?")
      .get(reviewJobId) as { status: string; storage_path: string } | undefined;
    const workspace = resolve(this.getSettings().workDir, "reviews", reviewJobId);
    if (!review || !removableReviewStatuses.has(review.status) || resolve(review.storage_path) !== workspace) {
      throw new Error(`Review workspace ownership changed for ${reviewJobId}`);
    }
    const expected = category === "artwork-cache" ? resolve(workspace, "artwork")
      : category === "temporary-logs" ? resolve(workspace, "logs") : null;
    if (!expected || resolve(resource.path) !== expected) {
      throw new Error(`Review workspace subdirectory is not eligible for cleanup: ${resource.path}`);
    }
    return this.removeFiles(resource.files, workspace, false);
  }

  private async deleteResource(resource: StorageResource): Promise<{
    filesDeleted: number;
    bytesRecovered: number;
    recordsDeleted: number;
  }> {
    if (!resource.path || !resource.reclaimable || resource.error) {
      throw new Error(`Resource ${resource.id} is not eligible for cleanup`);
    }
    const settings = this.getSettings();
    if (resource.id.startsWith("review:")) {
      throw new Error("Review workspace data must be removed through the ownership-checked review cleanup service");
    }
    if (resource.id.startsWith("staging:") || resource.category === "unmatched-tv-content") {
      throw new Error("Unmatched TV content is user data and cannot be removed by Storage Manager cleanup");
    }
    if (resource.id.startsWith("orphan:")) {
      throw new Error("Orphans must be removed through the ownership-checked orphan cleanup service");
    }
    if (resource.id.startsWith("output-temp:")) {
      const owner = resource.jobId;
      if (!owner || !uuidPattern.test(owner)) throw new Error("Temporary output is missing a valid job owner");
      const job = this.db.prepare("SELECT status, output_path FROM jobs WHERE id = ?")
        .get(owner) as { status: string; output_path: string | null } | undefined;
      const tempPath = resource.files[0]?.path;
      const match = tempPath ? outputTempPattern.exec(basename(tempPath)) : null;
      if (!job || activeJobStatuses.has(job.status) || !job.output_path ||
        match?.[1]?.toLowerCase() !== owner.toLowerCase() ||
        dirname(resolve(job.output_path)) !== dirname(tempPath ?? "") ||
        extname(job.output_path).slice(1).toLowerCase() !== match?.[2]?.toLowerCase() ||
        dirname(tempPath ?? "") !== resolve(resource.path)) {
        throw new Error(`Temporary output ownership changed for ${resource.name}`);
      }
      if (this.protectedOutputRoots(settings).some((root) => pathsOverlap(tempPath!, root) && !within(root, tempPath!))) {
        throw new Error(`Temporary output overlaps a protected media root: ${tempPath}`);
      }
      return this.deleteOwnedFiles(resource, resource.files);
    }
    if (resource.jobId) {
      const job = this.db.prepare("SELECT status FROM jobs WHERE id = ?").get(resource.jobId) as { status: string } | undefined;
      if (!job || activeJobStatuses.has(job.status)) throw new Error(`Job ${resource.jobId} is active or no longer exists`);
      const jobRoot = resolve(settings.workDir, resource.jobId);
      if (!within(jobRoot, resource.path)) throw new Error(`Job-owned path escaped its workspace: ${resource.path}`);
      if (this.protectedOutputRoots(settings).some((root) => pathsOverlap(resource.path!, root))) {
        throw new Error(`Job-owned path overlaps published media: ${resource.path}`);
      }
    } else {
      throw new Error(`Resource ${resource.id} has no verifiable owner`);
    }
    if (resource.category === "failed-processing-jobs") {
      const job = this.db.prepare("SELECT status FROM jobs WHERE id = ?")
        .get(resource.jobId) as { status: string } | undefined;
      if (job?.status !== "failed") throw new Error(`Job ${resource.jobId} is no longer a failed processing job`);
      const reviewOwner = this.db.prepare("SELECT 1 FROM review_jobs WHERE original_job_id = ? LIMIT 1")
        .get(resource.jobId);
      if (reviewOwner) throw new Error(`Failed job ${resource.jobId} has preserved review data`);
      const expected = resolve(settings.workDir, resource.jobId);
      if (resource.path !== expected) throw new Error(`Failed job path changed: ${resource.path}`);
      if (resource.files.some((file) => relative(expected, file.path).split(/[\\/]/, 1)[0]?.startsWith("rip-"))) {
        throw new Error(`Failed job ${resource.jobId} contains staged rip media that must be preserved`);
      }
      return this.deleteOwnedFiles(resource, resource.files);
    }
    return this.deleteOwnedFiles(resource, resource.files);
  }

  private async deleteOwnedFiles(resource: StorageResource, files: StorageFile[]): Promise<{
    filesDeleted: number;
    bytesRecovered: number;
    recordsDeleted: number;
  }> {
    if (!resource.path) throw new Error(`Resource ${resource.id} has no owned path`);
    const ownerRoot = resource.id.startsWith("output-temp:")
      ? resource.path
      : resource.jobId
        ? resolve(this.getSettings().workDir, resource.jobId)
        : resource.path;
    return this.removeFiles(files, ownerRoot, false);
  }

  private async removeFiles(files: StorageFile[], ownerRoot: string, removeDirectories: boolean): Promise<{
    filesDeleted: number;
    bytesRecovered: number;
    recordsDeleted: number;
  }> {
    let filesDeleted = 0;
    let bytesRecovered = 0;
    for (const file of files) {
      if (!within(ownerRoot, file.path)) throw new Error(`Owned file escaped its allowed directory: ${file.path}`);
      const info = await lstat(file.path);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Owned file changed before deletion: ${file.path}`);
      const identity = info.ino ? `${info.dev}:${info.ino}` : resolve(file.path).toLowerCase();
      if (identity !== file.identity) {
        throw new Error(`Owned file identity changed before deletion: ${file.path}`);
      }
      await unlink(file.path);
      filesDeleted += 1;
      if (info.nlink === 1) bytesRecovered += info.size;
    }
    if (removeDirectories) {
      const directories = new Set<string>();
      for (const file of files) {
        let current = dirname(file.path);
        while (within(ownerRoot, current) && current !== resolve(ownerRoot)) {
          directories.add(current);
          current = dirname(current);
        }
      }
      for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
        try {
          await rmdir(directory);
        } catch (error) {
          if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        }
      }
    }
    return { filesDeleted, bytesRecovered, recordsDeleted: 0 };
  }

  private protectedOutputRoots(settings: AppSettings): string[] {
    return [
      settings.moviesDir,
      settings.musicDir,
      settings.tvRootDir,
      settings.lidarrImportDir,
      ...settings.outputDestinations.profiles.flatMap((profile) => {
        const profileSettings = {
          ...settings,
          outputDestinations: { ...settings.outputDestinations, activeProfileId: profile.id }
        };
        return (["tv", "movies", "music"] as const).map((type) => outputPath(profileSettings, type));
      })
    ].filter(Boolean).map((path) => resolve(path));
  }

  private findOriginalJobId(id: string, kind: string): string | null {
    if (kind === "job") return null;
    if (kind === "tv-staging") {
      const row = this.db.prepare("SELECT id FROM jobs WHERE id = ?").get(id) as { id: string } | undefined;
      return row?.id ?? null;
    }
    const row = this.db.prepare("SELECT original_job_id FROM review_jobs WHERE id = ?")
      .get(id) as { original_job_id: string } | undefined;
    return row?.original_job_id ?? null;
  }

  private cleanupDescription(category: StorageCategoryId): string {
    switch (category) {
      case "review-queue-data": return "Deletes selected review records and their exclusively owned temporary workspaces; published media is protected.";
      case "unmatched-tv-content": return "Unmatched TV content is preserved and cannot be bulk-deleted here.";
      case "temporary-conversion-files": return "Removes inactive job conversion work files and generated temporary output files with a verified job owner.";
      case "artwork-cache": return "Removes artwork owned exclusively by review workspaces.";
      case "metadata-cache": return "Deletes cached metadata rows while preserving the application database.";
      case "orphaned-data": return "Removes only validated untracked workspaces outside all published media roots.";
      case "staged-rips": return "Staged rips are user media and are excluded from bulk cleanup.";
      case "failed-processing-jobs": return "Removes failed-job temporary files but keeps job history and audit records.";
      case "temporary-logs": return "Removes inactive AutoDisc work and review logs; active processing logs are protected.";
    }
  }
}
