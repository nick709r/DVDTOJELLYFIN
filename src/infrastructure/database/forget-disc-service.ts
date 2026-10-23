import type Database from "better-sqlite3";
import { lstatSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep, join } from "node:path";
import type { ForgetDiscResult, ForgetDiscService, SettingsRepository } from "../../contracts/repositories.js";
import { outputPath } from "../../output-destinations.js";
import { log } from "../../logger.js";

const ACTIVE = ["inspecting", "ripping", "converting", "publishing"];

export class SqliteForgetDiscService implements ForgetDiscService {
  constructor(private readonly db: Database.Database, private readonly settings: SettingsRepository) {}

  forgetDisc(discId: string): ForgetDiscResult {
    const tx = this.db.transaction(() => {
      const job = this.db.prepare("SELECT id, status, disc_fingerprint AS fingerprint FROM jobs WHERE id = ?")
        .get(discId) as { id: string; status: string; fingerprint: string | null } | undefined;
      const fingerprint = job?.fingerprint || (job ? null : discId);
      const jobs = (fingerprint
        ? this.db.prepare("SELECT id, status FROM jobs WHERE id = ? OR disc_fingerprint = ?").all(discId, fingerprint)
        : job ? [{ id: job.id, status: job.status }] : []) as Array<{ id: string; status: string }>;
      const represented = job || (fingerprint && this.db.prepare(`
        SELECT 1 FROM jobs WHERE disc_fingerprint = ?
        UNION ALL SELECT 1 FROM review_items WHERE disc_fingerprint = ?
        UNION ALL SELECT 1 FROM disc_recovery WHERE fingerprint = ?
        UNION ALL SELECT 1 FROM tv_matching_tasks WHERE fingerprint = ?
        UNION ALL SELECT 1 FROM tv_episode_feedback WHERE fingerprint = ?
        UNION ALL SELECT 1 FROM tv_processing_plans WHERE fingerprint = ?
        UNION ALL SELECT 1 FROM tv_validation_evidence WHERE fingerprint = ?
        UNION ALL SELECT 1 FROM drive_state WHERE last_fingerprint = ?
        LIMIT 1
      `).get(fingerprint, fingerprint, fingerprint, fingerprint, fingerprint, fingerprint, fingerprint, fingerprint));
      if (!represented) throw new Error("Disc not found");
      if (jobs.some((row) => ACTIVE.includes(row.status))) throw new Error("An active disc job cannot be forgotten");

      const ids = jobs.map((row) => row.id);
      const counts: Record<string, number> = {};
      const cleanupCandidates: Array<{ path: string; kind: "review" | "tv" | "work"; id: string }> = [];
      for (const id of ids) {
        cleanupCandidates.push({ path: join(this.settings.get().workDir, id), kind: "work", id });
        cleanupCandidates.push({ path: join(this.settings.get().workDir, "reviews", id), kind: "review", id });
        cleanupCandidates.push({
          path: join(this.settings.get().workDir, "tv-staging", "unidentified", id),
          kind: "tv",
          id
        });
        const reviewPaths = this.db.prepare("SELECT id, storage_path AS path FROM review_jobs WHERE original_job_id = ?")
          .all(id) as Array<{ id: string; path: string }>;
        cleanupCandidates.push(...reviewPaths.map((row) => ({ path: row.path, kind: "review" as const, id: row.id })));
      }
      const taskQuery = fingerprint
        ? this.db.prepare("SELECT job_id AS id, staging_path AS path FROM tv_matching_tasks WHERE job_id IN (SELECT id FROM jobs WHERE id = ? OR disc_fingerprint = ?) OR fingerprint = ?")
          .all(discId, fingerprint, fingerprint)
        : this.db.prepare("SELECT job_id AS id, staging_path AS path FROM tv_matching_tasks WHERE job_id = ?").all(discId);
      cleanupCandidates.push(...(taskQuery as Array<{ id: string; path: string }>).map((row) => ({
        path: row.path,
        kind: "tv" as const,
        id: row.id
      })));
      const run = (name: string, sql: string, ...params: unknown[]) => {
        counts[name] = (counts[name] ?? 0) + this.db.prepare(sql).run(...params).changes;
      };
      for (const id of ids) {
        run("reviewItems", "DELETE FROM review_items WHERE related_job_id = ?", id);
        run("reviewJobs", "DELETE FROM review_jobs WHERE original_job_id = ?", id);
        run("tvMatchingTasks", "DELETE FROM tv_matching_tasks WHERE job_id = ?", id);
        run("classificationAudit", "DELETE FROM disk_classification_audit WHERE job_id = ?", id);
        run("processingLogs", "DELETE FROM job_events WHERE job_id = ?", id);
      }
      if (fingerprint) {
        run("reviewItems", "DELETE FROM review_items WHERE disc_fingerprint = ?", fingerprint);
        run("tvMatchingTasks", "DELETE FROM tv_matching_tasks WHERE fingerprint = ?", fingerprint);
        run("tvEpisodeFeedback", "DELETE FROM tv_episode_feedback WHERE fingerprint = ?", fingerprint);
        run("tvProcessingPlans", "DELETE FROM tv_processing_plans WHERE fingerprint = ?", fingerprint);
        run("tvValidationEvidence", "DELETE FROM tv_validation_evidence WHERE fingerprint = ?", fingerprint);
      }
      for (const id of ids) run("jobs", "DELETE FROM jobs WHERE id = ?", id);
      if (fingerprint) {
        run("discRecovery", "DELETE FROM disc_recovery WHERE fingerprint = ?", fingerprint);
        run("driveState", "UPDATE drive_state SET last_fingerprint = NULL, processed_at = NULL WHERE last_fingerprint = ?", fingerprint);
      }
      return { discId, fingerprint: fingerprint || null, removed: counts, cleanupCandidates };
    });
    const result = tx();
    result.removed.filesystemArtifacts = this.removeFilesystemArtifacts(result.cleanupCandidates, result.discId);
    delete (result as Partial<typeof result>).cleanupCandidates;
    log("info", "forget-disc", "Disc records were removed", {
      discId: result.discId,
      fingerprint: result.fingerprint,
      removed: result.removed
    });
    return result;
  }

  private removeFilesystemArtifacts(
    candidates: Array<{ path: string; kind: "review" | "tv" | "work"; id: string }>,
    discId: string
  ): number {
    const settings = this.settings.get();
    const workRoot = resolve(settings.workDir);
    const outputRoots = this.outputRoots(settings);
    const unique = new Map<string, { kind: "review" | "tv" | "work"; id: string }>();
    for (const candidate of candidates) unique.set(resolve(candidate.path), candidate);
    let removed = 0;
    for (const [path, candidate] of unique) {
      if (!/^[a-f0-9-]{36}$/i.test(candidate.id) || basename(path) !== candidate.id) continue;
      const expectedParent = candidate.kind === "review"
        ? dirname(path)
        : candidate.kind === "tv" ? resolve(workRoot, "tv-staging", "unidentified") : workRoot;
      if (candidate.kind === "review" && basename(expectedParent) !== "reviews") continue;
      if (candidate.kind !== "review" && resolve(dirname(path)) !== expectedParent) continue;
      if (outputRoots.some((output) => this.pathsOverlap(path, output))) {
        log("warn", "forget-disc", "Skipped filesystem cleanup because the path overlaps a published output", {
          discId, path
        });
        continue;
      }
      if (this.removeDirectory(path, expectedParent, discId)) removed += 1;
    }
    return removed;
  }

  private removeDirectory(path: string, parent: string, discId: string): boolean {
    try {
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink()) return false;
      const realParent = realpathSync(parent);
      const realPath = realpathSync(path);
      const settings = this.settings.get();
      const outputRoots = this.outputRoots(settings).map((output) => {
        try {
          return realpathSync(output);
        } catch {
          return resolve(output);
        }
      });
      if (outputRoots.some((output) => this.pathsOverlap(realPath, output))) {
        log("warn", "forget-disc", "Skipped filesystem cleanup because the resolved path overlaps published output", {
          discId, path
        });
        return false;
      }
      const relativePath = relative(realParent, realPath);
      if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) ||
        isAbsolute(relativePath) || relativePath.includes(sep)) {
        log("warn", "forget-disc", "Skipped filesystem cleanup after path ownership validation failed", {
          discId, path
        });
        return false;
      }
      rmSync(path, { recursive: true, force: false });
      log("info", "forget-disc", "Removed disc-owned workspace artifacts", { discId, path });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      log("warn", "forget-disc", "Could not remove disc-owned workspace artifacts", {
        discId,
        path,
        error: error instanceof Error ? error.message : "unknown filesystem cleanup error"
      });
      return false;
    }
  }

  private outputRoots(settings: ReturnType<SettingsRepository["get"]>): string[] {
    const profileSettings = settings.outputDestinations.profiles.map((profile) => ({
      ...settings,
      outputDestinations: { ...settings.outputDestinations, activeProfileId: profile.id }
    }));
    return [...new Set([
      settings.moviesDir,
      settings.tvRootDir,
      settings.musicDir,
      settings.lidarrImportDir,
      ...profileSettings.flatMap((profile) => [
        outputPath(profile, "tv"),
        outputPath(profile, "movies"),
        outputPath(profile, "music")
      ])
    ].filter(Boolean).map((path) => resolve(path)))];
  }

  private pathsOverlap(first: string, second: string): boolean {
    const relativePath = relative(resolve(first), resolve(second));
    const reversePath = relative(resolve(second), resolve(first));
    return relativePath === "" || reversePath === "" ||
      (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath)) ||
      (!reversePath.startsWith(`..${sep}`) && reversePath !== ".." && !isAbsolute(reversePath));
  }
}
