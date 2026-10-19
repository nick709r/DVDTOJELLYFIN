import type { MediaSourceCoordinator } from "./application/media-source-coordinator.js";
import type { MediaWorkflowRegistry } from "./application/media-workflow-registry.js";
import type { JobCoordinator } from "./application/job-coordinator.js";
import type { MetadataResolver } from "./application/metadata-resolver.js";
import { isUpdatePending } from "./updater.js";
import { log } from "./logger.js";
import { updateCandidateDiagnostics, updateDiscDiagnostics } from "./diagnostics.js";

export async function processInsertedDisc(
  sources: MediaSourceCoordinator,
  workflows: MediaWorkflowRegistry,
  jobs: JobCoordinator,
  metadata: MetadataResolver,
  signal?: AbortSignal
): Promise<boolean> {
  if (isUpdatePending()) {
    log("info", "disc", "Disc inspection deferred because an application update is pending");
    return false;
  }
  if (jobs.activeJob()) return true;
  const controller = new AbortController();
  jobs.beginOperation(controller);
  const jobSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    return await processInsertedDiscCore(sources, workflows, jobs, metadata, jobSignal);
  } finally {
    jobs.endOperation(controller);
  }
}

async function processInsertedDiscCore(
  sources: MediaSourceCoordinator,
  workflows: MediaWorkflowRegistry,
  jobs: JobCoordinator,
  metadata: MetadataResolver,
  signal: AbortSignal
): Promise<boolean> {
  if (isUpdatePending()) return false;
  if (jobs.activeJob()) return true;
  const devicePath = jobs.getSettings().opticalDevice;
  let inspectedSource;
  try {
    inspectedSource = await sources.inspect(devicePath, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    const inspection = sources.inspectionDiagnostics();
    updateDiscDiagnostics({
      status: "Source inspection failed",
      mediaType: "unknown",
      classification: "Unknown",
      providersAttempted: inspection?.attemptedProviders ?? [],
      reason: error instanceof Error ? error.message : "Source inspection failed"
    });
    jobs.createReview({
      category: "disc_read_error",
      severity: "high",
      title: "Optical disc could not be read",
      description: error instanceof Error ? error.message : "Source inspection failed",
      relatedDrive: devicePath,
      errorDetails: {
        message: error instanceof Error ? error.message : "Source inspection failed",
        sourceProvidersAttempted: inspection?.attemptedProviders ?? []
      },
      suggestedActions: [
        { type: "retry", label: "Retry disc detection" },
        { type: "open-settings", label: "Check optical drive settings" },
        { type: "dismiss", label: "Dismiss" }
      ]
    });
    log("info", "disc", "No readable media source detected", {
      error: error instanceof Error ? error.message : "Source inspection failed"
    });
    return false;
  }
  if (isUpdatePending()) {
    log("info", "disc", "Inspected media was not routed because an application update became pending", {
      devicePath
    });
    return false;
  }
  if (!inspectedSource) {
    const inspection = sources.inspectionDiagnostics();
    updateDiscDiagnostics({
      status: "Unknown media",
      mediaType: "unknown",
      classification: "Unknown",
      providersAttempted: inspection?.attemptedProviders ?? [],
      reason: `No registered source provider recognized the inserted media. Attempted: ${inspection?.attemptedProviders.join(", ") || "none"}.`
    });
    log("warn", "disc", "No processing job was created because no source provider recognized the inserted media", {
      devicePath
    });
    return false;
  }
  updateCandidateDiagnostics(inspectedSource.candidate, sources.inspectionDiagnostics()?.attemptedProviders ?? []);
  const processed = await workflows.process(inspectedSource, {
    sources,
    jobs,
    metadata,
    signal,
    devicePath
  });
  if (!processed) {
    updateDiscDiagnostics({
      status: "Workflow declined the disc",
      reason: `The ${inspectedSource.candidate.mediaKind} workflow did not start a job.`
    });
    log("warn", "disc", "The selected media workflow declined processing; no job was created", {
      devicePath,
      sourceId: inspectedSource.candidate.sourceId,
      providerId: inspectedSource.candidate.providerId,
      mediaKind: inspectedSource.candidate.mediaKind,
      discLabel: inspectedSource.candidate.label
    });
  }
  return processed;
}
