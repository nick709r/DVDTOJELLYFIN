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
let debounceTimer: NodeJS.Timeout | undefined;
let monitorChild: ChildProcess | undefined;
let pendingJob: Promise<boolean> | undefined;

function log(level: "info" | "warn" | "error", message: string): void {
  writeLog(level, "disc-monitor", message);
}

async function handleInsert(signal: AbortSignal): Promise<void> {
  if (checking || seenInsertedDisc || activeJob() || signal.aborted) return;
  checking = true;
  setRuntimeStatus("inspecting");
  try {
    const device = getSettings().opticalDevice;
    if (await mediaPresent(device)) {
      pendingJob = processInsertedDisc(signal);
      seenInsertedDisc = await pendingJob;
    } else {
      clearInsertedDisc();
    }
  } catch (error) {
    if (!signal.aborted) log("error", `Disc processing could not start: ${error instanceof Error ? error.message : "unknown error"}`);
  } finally {
    if (getRuntimeStatus() === "inspecting") setRuntimeStatus("idle");
    pendingJob = undefined;
    checking = false;
  }
}

function scheduleInsert(signal: AbortSignal): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void handleInsert(signal), 1800);
}

async function mediaPresent(device: string): Promise<boolean> {
  try {
    const sectors = Number((await readFile(`/sys/class/block/${basename(device)}/size`, "utf8")).trim());
    return Number.isFinite(sectors) && sectors > 0;
  } catch (error) {
    log("error", `Cannot verify optical media state: ${error instanceof Error ? error.message : "unknown error"}`);
    return false;
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
            clearInsertedDisc();
            discRemoved();
          }
          if (path === configuredDevice && (action === "add" || action === "change")) scheduleInsert(signal);
          boundary = eventText.indexOf("\n\n");
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => log("warn", chunk.trim().slice(0, 500)));
      const onSettings = (changed: { opticalDevice?: string }): void => {
        if (!changed.opticalDevice) return;
        seenInsertedDisc = false;
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
  const onAbort = (): void => {
    stopping = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    monitorChild?.kill("SIGTERM");
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const running = monitor(signal);
  return async () => {
    onAbort();
    await running;
    await pendingJob?.catch(() => undefined);
    signal.removeEventListener("abort", onAbort);
  };
}
