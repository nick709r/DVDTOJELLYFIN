import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { activeJob, clearInsertedDisc, getSettings } from "./db.js";
import { events } from "./events.js";
import { processInsertedDisc } from "./pipeline.js";
import { discRemoved, getRuntimeStatus, setRuntimeStatus } from "./runtime-status.js";
import { log as writeLog } from "./logger.js";

let stopping = false;
let seenInsertedDisc = false;
let checking = false;
let scanRequested = false;
let mediaWasPresent: boolean | undefined;
let retryDelayMs = 2000;
let debounceTimer: NodeJS.Timeout | undefined;
let presenceTimer: NodeJS.Timeout | undefined;
let monitorChild: ChildProcess | undefined;
let pendingJob: Promise<boolean> | undefined;
let lastMediaStateWarningAt = 0;

function log(level: "info" | "warn" | "error", message: string): void {
  writeLog(level, "disc-monitor", message);
}

async function handleInsert(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  if (checking) {
    scanRequested = true;
    return;
  }
  if (seenInsertedDisc || activeJob()) return;
  checking = true;
  setRuntimeStatus("inspecting");
  let mediaConfirmedPresent = false;
  try {
    const device = getSettings().opticalDevice;
    const present = await mediaPresent(device);
    if (present) {
      mediaConfirmedPresent = true;
      pendingJob = processInsertedDisc(signal);
      seenInsertedDisc = await pendingJob;
      if (seenInsertedDisc) retryDelayMs = 2000;
      else if (!signal.aborted) {
        log("warn", `Disc is present but could not be recognized; retrying in ${Math.round(retryDelayMs / 1000)} seconds`);
        scheduleInsert(signal, retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
      }
    } else if (present === false) {
      clearInsertedDisc();
      retryDelayMs = 2000;
    }
  } catch (error) {
    if (!signal.aborted) {
      log("error", `Disc processing could not start: ${error instanceof Error ? error.message : "unknown error"}`);
      if (mediaConfirmedPresent) {
        scheduleInsert(signal, retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
      }
    }
  } finally {
    if (getRuntimeStatus() === "inspecting") setRuntimeStatus("idle");
    pendingJob = undefined;
    checking = false;
    if (scanRequested && !signal.aborted) {
      scanRequested = false;
      scheduleInsert(signal);
    }
  }
}

function scheduleInsert(signal: AbortSignal, delayMs = 450): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void handleInsert(signal), delayMs);
}

async function mediaPresent(device: string): Promise<boolean | null> {
  try {
    const sectors = Number((await readFile(`/sys/class/block/${basename(device)}/size`, "utf8")).trim());
    return Number.isFinite(sectors) && sectors > 0;
  } catch (error) {
    const now = Date.now();
    if (now - lastMediaStateWarningAt >= 60_000) {
      lastMediaStateWarningAt = now;
      log("warn", `Cannot verify optical media state: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    return null;
  }
}

async function reconcileMediaPresence(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const device = getSettings().opticalDevice;
  const present = await mediaPresent(device);
  if (present === null) return;
  if (!present) {
    if (mediaWasPresent !== false || seenInsertedDisc) {
      clearInsertedDisc();
    }
    if (seenInsertedDisc && !activeJob()) {
      seenInsertedDisc = false;
      discRemoved();
    }
    mediaWasPresent = false;
    retryDelayMs = 2000;
    return;
  }
  const newlyPresent = mediaWasPresent !== true;
  mediaWasPresent = true;
  if (newlyPresent && !seenInsertedDisc && !activeJob()) {
    retryDelayMs = 2000;
    scheduleInsert(signal);
  }
}

async function monitor(signal: AbortSignal): Promise<void> {
  while (!stopping && !signal.aborted) {
    try {
      const device = getSettings().opticalDevice;
      const child = spawn("udevadm", ["monitor", "--udev", "--subsystem-match=block", "--property"], {
        stdio: ["ignore", "pipe", "pipe"]
      });
      if (!child.stdout || !child.stderr) throw new Error("udevadm monitor streams could not be opened");
      monitorChild = child;
      child.stdout.setEncoding("utf8");
      let eventText = "";
      child.stdout.on("data", (chunk: string) => {
        eventText += chunk;
        let boundary = eventText.indexOf("\n\n");
        while (boundary >= 0) {
          const block = eventText.slice(0, boundary);
          eventText = eventText.slice(boundary + 2);
          const action = block.match(/^ACTION=(\w+)/m)?.[1];
          const path = block.match(/^DEVNAME=(.+)$/m)?.[1]?.trim();
          const configuredDevice = getSettings().opticalDevice;
          if (path === configuredDevice) writeLog("debug", "disc-monitor", "udev event", { action, path });
          if (path === configuredDevice && action === "remove") {
            seenInsertedDisc = false;
            mediaWasPresent = false;
            retryDelayMs = 2000;
            clearInsertedDisc();
            discRemoved();
          }
          if ((path === configuredDevice || path === `${configuredDevice}1`) &&
            (action === "add" || action === "change")) scheduleInsert(signal);
          boundary = eventText.indexOf("\n\n");
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => log("warn", chunk.trim().slice(0, 500)));
      const onSettings = (changed: { opticalDevice?: string }): void => {
        if (!changed.opticalDevice) return;
        seenInsertedDisc = false;
        mediaWasPresent = undefined;
        retryDelayMs = 2000;
        clearInsertedDisc();
        scheduleInsert(signal);
      };
      events.on("settings", onSettings);
      child.once("close", () => events.off("settings", onSettings));
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => {
          log("info", `Watching udev events for ${device}`);
          resolve();
        });
        child.once("error", reject);
        child.once("close", (code) => {
          if (!stopping && !signal.aborted) reject(new Error(`udevadm monitor exited with code ${String(code)}`));
          else resolve();
        });
      });
      if (!seenInsertedDisc) scheduleInsert(signal);
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
      if (monitorChild === child) monitorChild = undefined;
    } catch (error) {
      if (!stopping && !signal.aborted) {
        log("error", `udev monitor unavailable: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
    if (!stopping && !signal.aborted) await delay(5000);
  }
}

export function startDiscMonitor(signal: AbortSignal): () => Promise<void> {
  stopping = false;
  scanRequested = false;
  mediaWasPresent = undefined;
  retryDelayMs = 2000;
  const onAbort = (): void => {
    stopping = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    if (presenceTimer) clearInterval(presenceTimer);
    presenceTimer = undefined;
    monitorChild?.kill("SIGTERM");
  };
  signal.addEventListener("abort", onAbort, { once: true });
  void reconcileMediaPresence(signal).catch((error: unknown) => {
    log("error", `Initial optical media state check failed: ${error instanceof Error ? error.message : "unknown error"}`);
  });
  presenceTimer = setInterval(() => {
    void reconcileMediaPresence(signal).catch((error: unknown) => {
      log("error", `Optical media state reconciliation failed: ${error instanceof Error ? error.message : "unknown error"}`);
    });
  }, 2000);
  presenceTimer.unref();
  const running = monitor(signal);
  return async () => {
    onAbort();
    await running;
    await pendingJob?.catch(() => undefined);
    signal.removeEventListener("abort", onAbort);
  };
}
