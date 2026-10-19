import { db, getSettings } from "./db.js";
import { configureLogLevel, log } from "./logger.js";
import { startDiscMonitor } from "./disc-monitor.js";
import { startServer, stopServer } from "./server.js";
import { recoverTemporaryFiles } from "./recovery.js";
import { createProviderRuntime } from "./bootstrap/providers.js";

let providerRuntime: Awaited<ReturnType<typeof createProviderRuntime>> | undefined;

async function main(): Promise<void> {
  providerRuntime = await createProviderRuntime();
  configureLogLevel(getSettings().logLevel);
  await recoverTemporaryFiles();
  await startServer();
  const shutdownController = new AbortController();
  const stopMonitor = startDiscMonitor(shutdownController.signal, providerRuntime.sources);
  let shuttingDown: Promise<void> | undefined;

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    log("info", "service", `Received ${signal}; stopping cleanly`);
    shutdownController.abort();
    shuttingDown = (async () => {
      await stopMonitor();
      await stopServer();
      await providerRuntime?.registry.disposeAll();
      db.close();
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
      db.close();
      process.exitCode = 1;
    }
  })();
});
