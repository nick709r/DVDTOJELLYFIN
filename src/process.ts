import { spawn, type ChildProcess } from "node:child_process";
import { log } from "./logger.js";

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

interface ProcessOptions {
  /** Absolute limit from process start. With `inactivityTimeoutMs` set, this is a hard cap that output cannot extend. */
  timeoutMs?: number;
  /** Terminates the process after this long without any stdout/stderr output; output resets the timer. */
  inactivityTimeoutMs?: number;
  /** When set, the start, completion and timeout of the process are logged under this component. */
  logging?: { component: string; fields?: Record<string, unknown> };
  signal?: AbortSignal;
  cwd?: string;
  onStdoutLine?: (line: string) => void;
}

export class ProcessFailure extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly exitCode: number | null,
    readonly stderr: string
  ) {
    super(message);
    this.name = "ProcessFailure";
  }
}

const managedProcesses = new Set<ChildProcess>();

export async function waitForManagedProcesses(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (managedProcesses.size > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  return managedProcesses.size === 0;
}

export function runProcess(
  command: string,
  args: string[],
  options: ProcessOptions = {}
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("Process cancelled"));
      return;
    }

    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      ...(options.cwd ? { cwd: options.cwd } : {})
    });
    managedProcesses.add(child);
    let stdout = "";
    let stderr = "";
    let pendingLine = "";
    let timedOut = false;
    let settled = false;
    const startedAt = Date.now();
    let lastOutputAt = startedAt;
    const idleMode = options.inactivityTimeoutMs !== undefined;
    const idleLimitMs = options.inactivityTimeoutMs;
    // With an inactivity timeout, timeoutMs is a hard cap that output cannot extend.
    const absoluteLimitMs = idleMode ? options.timeoutMs : (options.timeoutMs ?? 60_000);
    const logging = options.logging;
    const trace = (level: "info" | "warn", message: string, fields: Record<string, unknown>): void => {
      if (logging) log(level, logging.component, message, { ...logging.fields, ...fields });
    };
    trace("info", "Command started", {
      command,
      timeoutMs: idleLimitMs ?? absoluteLimitMs,
      ...(idleLimitMs === undefined ? {} : { inactivityTimeoutMs: idleLimitMs }),
      ...(absoluteLimitMs === undefined ? {} : { absoluteTimeoutMs: absoluteLimitMs })
    });

    const terminate = (kind: "inactivity" | "absolute"): void => {
      if (timedOut || settled) return;
      timedOut = true;
      clearTimeout(timeout);
      clearTimeout(absoluteTimeout);
      trace("warn", `Command killed due to ${kind} timeout`, {
        command,
        timeoutKind: kind,
        elapsedMs: Date.now() - startedAt,
        timeoutMs: kind === "inactivity" ? idleLimitMs : absoluteLimitMs,
        lastOutputAgeMs: Date.now() - lastOutputAt
      });
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    };
    const idleOrAbsolute = idleMode ? "inactivity" : "absolute";
    let timeout = setTimeout(() => terminate(idleOrAbsolute), idleLimitMs ?? absoluteLimitMs);
    timeout.unref();
    const absoluteTimeout = idleMode && absoluteLimitMs !== undefined
      ? setTimeout(() => terminate("absolute"), absoluteLimitMs) : undefined;
    absoluteTimeout?.unref();
    const noteOutput = (): void => {
      lastOutputAt = Date.now();
      if (!idleMode || settled || timedOut) return;
      clearTimeout(timeout);
      timeout = setTimeout(() => terminate("inactivity"), idleLimitMs);
      timeout.unref();
    };

    const onAbort = (): void => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      noteOutput();
      stdout = (stdout + chunk).slice(-256_000);
      if (options.onStdoutLine) {
        pendingLine += chunk;
        const lines = pendingLine.split(/\r?\n/);
        pendingLine = lines.pop() ?? "";
        for (const line of lines) options.onStdoutLine(line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      noteOutput();
      stderr = (stderr + chunk).slice(-256_000);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      managedProcesses.delete(child);
      clearTimeout(timeout);
      clearTimeout(absoluteTimeout);
      options.signal?.removeEventListener("abort", onAbort);
      reject(new ProcessFailure(error.message, command, null, stderr));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      managedProcesses.delete(child);
      clearTimeout(timeout);
      clearTimeout(absoluteTimeout);
      options.signal?.removeEventListener("abort", onAbort);
      if (pendingLine && options.onStdoutLine) options.onStdoutLine(pendingLine);
      trace("info", "Command completed", { command, elapsedMs: Date.now() - startedAt, exitCode: code });
      if (options.signal?.aborted) {
        reject(new ProcessFailure("Process cancelled", command, code, stderr));
      } else if (timedOut) {
        const detail = stderr.trim().slice(-1500);
        reject(new ProcessFailure(`Process timed out: ${command}${detail ? `: ${detail}` : ""}`, command, code, stderr));
      } else if (code !== 0) {
        const detail = stderr.trim().slice(-1500);
        reject(new ProcessFailure(`${command} exited with code ${String(code)}${detail ? `: ${detail}` : ""}`, command, code, stderr));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}
