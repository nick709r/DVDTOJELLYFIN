import { access, mkdir, rm, rmdir, stat, statfs } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { MediaWorkflow, MediaWorkflowContext } from "../../application/media-workflow-registry.js";
import type { DiscTitle } from "../../model.js";
import { events, notifyStatus } from "../../events.js";
import { convert } from "../../encoding.js";
import { ejectDisc, safeTitle, selectMainFeature } from "../../media.js";
import { setRuntimeStatus } from "../../runtime-status.js";
import { log } from "../../logger.js";
import { createMovieOutput } from "../../movie-output.js";
import { summarizeTvPlan, TvWorkflowService } from "../../application/tv-workflow-service.js";

const minimumWorkBytes = 8 * 1024 ** 3;
const minimumOutputBytes = 1024 ** 3;

async function assertWritableDirectory(path: string, reserveBytes: number): Promise<void> {
  await mkdir(path, { recursive: true });
  await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
  const space = await statfs(path);
  const available = Number(space.bavail) * Number(space.bsize);
  if (!Number.isFinite(available) || available < reserveBytes) {
    throw new Error(`Insufficient free space at ${path}; at least ${Math.ceil(reserveBytes / 1024 ** 3)} GiB is required`);
  }
}

export class DvdWorkflow implements MediaWorkflow {
  readonly mediaKind = "dvd";

  constructor(private readonly tvWorkflow?: TvWorkflowService) {}

  async process({ source, sources, jobs, metadata, signal, devicePath }: MediaWorkflowContext): Promise<boolean> {
    const info = source.candidate;
    const settings = jobs.getSettings();
    const titles: DiscTitle[] = info.manifest.items
      .filter((item) => item.kind === "title" && item.durationSeconds !== undefined)
      .map((item) => ({ id: Number(item.id), name: item.title ?? "", durationSeconds: item.durationSeconds ?? 0 }));
    const selectedTitle = selectMainFeature(titles);
    if (!selectedTitle) {
      log("info", "disc", "No video titles recognized; the inserted disc will be retried", {
        discLabel: info.label || undefined
      });
      return false;
    }
    const fingerprint = createHash("sha256").update(JSON.stringify({
      label: info.label.trim().normalize("NFKC").toLocaleLowerCase(),
      titles: titles.map((title) => [title.id, title.durationSeconds, title.name.trim().normalize("NFKC")])
    })).digest("hex");
    if (jobs.lastDiscFingerprint() === fingerprint) {
      log("info", "disc", "Already-processed disc is still inserted; ignoring duplicate detection event");
      setRuntimeStatus("completed");
      return true;
    }

    const id = randomUUID();
    const context = jobs.begin(id, info.label || null, info.mediaKind, fingerprint, signal);
    if (this.tvWorkflow && settings.tvDetectionEnabled !== false) {
      try {
        const tvResult = await this.tvWorkflow.prepare({
          sourceId: info.sourceId,
          providerId: info.providerId,
          mediaKind: info.mediaKind,
          label: info.label,
          manifest: info.manifest
        }, fingerprint, signal);
        if (tvResult) {
          const message = summarizeTvPlan(tvResult.plan);
          jobs.update(context, { title: tvResult.plan.series?.title ?? info.label ?? null });
          jobs.record(context, "tv-processing-plan", "info", message);
          jobs.record(context, "tv-review", "warn", tvResult.plan.executionBlocker);
          jobs.holdForReview(context, message);
          setRuntimeStatus("idle");
          notifyStatus();
          return true;
        }
      } catch (error) {
        const cancelled = jobs.wasJobCancelled(context);
        const interrupted = Boolean(signal.aborted && !cancelled);
        jobs.fail(context, cancelled ? "cancelled" : interrupted ? "interrupted" : "failed", {
          code: cancelled ? "cancelled" : interrupted ? "interrupted" : "tv_analysis_failed",
          message: error instanceof Error ? error.message : "TV analysis failed",
          recoverable: interrupted
        });
        setRuntimeStatus(cancelled || interrupted ? "idle" : "failed");
        notifyStatus();
        return true;
      }
    }
    const workDir = join(settings.workDir, id);
    let finalPath: string | null = null;
    let movieDirectory: string | null = null;
    let successful = false;
    let failure: string | null = null;
    let conversionStartedAt: number | undefined;

    try {
      notifyStatus();
      await assertWritableDirectory(settings.workDir, minimumWorkBytes);
      await assertWritableDirectory(settings.moviesDir, minimumOutputBytes);
      await mkdir(workDir, { recursive: true, mode: 0o750 });

      jobs.step(context, {
        id: "acquire-source",
        status: "ripping",
        message: "Ripping the selected video title with the registered source provider"
      });
      notifyStatus();
      const acquired = await sources.acquire(source, workDir, {
        selection: { manifestItemId: String(selectedTitle.id) }
      }, signal);
      const input = acquired.artifacts.find((artifact) => artifact.kind === "video")?.path;
      if (!input) throw new Error(`Source provider ${info.providerId} returned no video artifact`);
      context.throwIfCancelled();

      const title = await metadata.resolve({ entityType: "movie", query: info.label || selectedTitle.name }, signal);
      for (const providerFailure of title.providerFailures) {
        log("warn", "metadata", providerFailure.message, { providerId: providerFailure.providerId });
      }
      const resolvedTitle = title.selected?.title ??
        (info.label.trim() || selectedTitle.name || `Unknown Title ${new Date().toISOString().slice(0, 10)}`);
      const cleanTitle = safeTitle(resolvedTitle);
      jobs.update(context, { title: cleanTitle });
      jobs.record(context, "title", "info", `Title selected from ${title.selected?.providerId ?? "disc-label"}`);

      jobs.step(context, { id: "convert-media", status: "converting", message: "Converting with FFmpeg" });
      notifyStatus();
      const movieOutput = await createMovieOutput(settings.moviesDir, cleanTitle, settings.format);
      movieDirectory = movieOutput.directory;
      const targetPath = movieOutput.path;
      finalPath = targetPath;
      conversionStartedAt = Date.now();
      const conversionStart = conversionStartedAt;
      const encoded = await convert(input, targetPath, cleanTitle, settings, (encoder) => {
        jobs.step(context, {
          id: "publish-media",
          status: "publishing",
          message: "Validating and atomically publishing the completed movie"
        });
        jobs.update(context, {
          outputPath: targetPath,
          encoder: encoder.name,
          conversionSeconds: (Date.now() - conversionStart) / 1000
        });
        notifyStatus();
      }, (progress) => {
        jobs.update(context, { progress: Math.min(99, Math.round(progress * 100)) });
        events.emit("status");
      }, signal);

      context.throwIfCancelled();
      jobs.update(context, { conversionSeconds: (Date.now() - conversionStartedAt) / 1000 });
      const outputStat = await stat(targetPath);
      if (outputStat.size < 1024) throw new Error("Published movie failed size validation");
      jobs.update(context, {
        outputPath: targetPath,
        outputBytes: encoded.outputBytes,
        encoder: encoded.encoder.name,
        progress: 100
      });
      successful = true;
    } catch (error) {
      failure = error instanceof Error ? error.message : "Unknown processing failure";
      if (conversionStartedAt !== undefined) {
        jobs.update(context, { conversionSeconds: (Date.now() - conversionStartedAt) / 1000 });
      }
    } finally {
      if (!successful && finalPath && movieDirectory) {
        try {
          await stat(finalPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            try {
              await rmdir(movieDirectory);
            } catch (cleanupError) {
              const code = (cleanupError as NodeJS.ErrnoException).code;
              if (code !== "ENOENT" && code !== "ENOTEMPTY") {
                failure = `${failure ? `${failure}; ` : ""}Empty movie-folder cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : "unknown error"}`;
              }
            }
          } else {
            failure = `${failure ? `${failure}; ` : ""}Could not verify failed movie output before cleanup: ${error instanceof Error ? error.message : "unknown error"}`;
          }
        }
      }
      try {
        await rm(workDir, { recursive: true, force: true });
      } catch (error) {
        failure = `${failure ? `${failure}; ` : ""}Temporary-file cleanup failed: ${error instanceof Error ? error.message : "unknown error"}`;
        successful = false;
      }
    }

    if (successful) {
      jobs.complete(context, fingerprint);
      setRuntimeStatus("completed");
      if (settings.autoEject) {
        try {
          await ejectDisc(devicePath);
          jobs.record(context, "eject", "info", "Disc ejected");
        } catch (error) {
          const message = `Eject failed: ${error instanceof Error ? error.message : "unknown error"}`;
          jobs.warn(context, message);
          log("warn", "eject", message, { jobId: id });
        }
      }
    } else {
      const cancelled = jobs.wasJobCancelled(context);
      const interrupted = Boolean(signal.aborted && !cancelled);
      jobs.fail(context, cancelled ? "cancelled" : interrupted ? "interrupted" : "failed", {
        code: cancelled ? "cancelled" : interrupted ? "interrupted" : "processing_failed",
        message: cancelled ? `Cancelled by user${failure ? `; ${failure}` : ""}` : failure ?? "Processing failed",
        recoverable: interrupted
      });
      setRuntimeStatus(cancelled || interrupted ? "idle" : "failed");
    }
    notifyStatus();
    return true;
  }
}
