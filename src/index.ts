import { getSettings, repositories } from "./db.js";
import { configureLogLevel, log } from "./logger.js";
import { startDiscMonitor } from "./disc-monitor.js";
import { setReviewJobActions, startServer, stopServer } from "./server.js";
import { recoverTemporaryFiles } from "./recovery.js";
import { createProviderRuntime } from "./bootstrap/providers.js";
import { JobCoordinator } from "./application/job-coordinator.js";
import { events } from "./events.js";
import { jobControl } from "./job-control.js";
import { ReviewJobProcessor } from "./application/review-job-processor.js";

let providerRuntime: Awaited<ReturnType<typeof createProviderRuntime>> | undefined;

async function main(): Promise<void> {
  const jobs = new JobCoordinator(repositories, {
    publish() {
      events.emit("status");
    }
  }, jobControl);
  providerRuntime = await createProviderRuntime(getSettings, jobs, repositories);
  const reviewProcessor = new ReviewJobProcessor(
    repositories.reviewJobs,
    providerRuntime.reviewWorkspaces,
    jobs,
    getSettings,
    providerRuntime.metadata
  );
  setReviewJobActions({
    continue: (id) => reviewProcessor.continue(id),
    updateMetadata: (id, patch) => providerRuntime!.reviewWorkspaces.updateMetadata(id, patch),
    remove: (id) => providerRuntime!.reviewWorkspaces.remove(id)
  });
  configureLogLevel(getSettings().logLevel);
  await recoverTemporaryFiles(repositories);
  await providerRuntime.reviewWorkspaces.recoverProcessing();
  await startServer();
  const shutdownController = new AbortController();
  const stopMonitor = startDiscMonitor(
    shutdownController.signal,
    providerRuntime.sources,
    providerRuntime.workflows,
    providerRuntime.metadata,
    providerRuntime.jobs
  );
  let shuttingDown: Promise<void> | undefined;

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    log("info", "service", `Received ${signal}; stopping cleanly`);
    shutdownController.abort();
    shuttingDown = (async () => {
      await stopMonitor();
      await stopServer();
      await providerRuntime?.registry.disposeAll();
      repositories.close();
    })();
    void shuttingDown.catch((error: unknown) => {
      log("error", "service", "Shutdown failed", {
        error: error instanceof Error ? error.message : "unknown error"
      });
      process.exitCode = 1;
    });
  };

  const onUncaught = (error: Error): void => {
    log("error", "service", "Uncaught exception", { error: error.message });
    process.exitCode = 1;
    shutdown("uncaughtException");
  };
  process.once("uncaughtException", onUncaught);
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  log("error", "service", "AutoDisc failed to start", {
    error: error instanceof Error ? error.message : "unknown error"
  });
  void (async () => {
    try {
      await providerRuntime?.registry.disposeAll();
    } catch (disposeError) {
      log("error", "service", "Provider cleanup after startup failure failed", {
        error: disposeError instanceof Error ? disposeError.message : "unknown error"
      });
    } finally {
      repositories.close();
      process.exitCode = 1;
    }
  })();
});
