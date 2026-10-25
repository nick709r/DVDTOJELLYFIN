import { spawn, type ChildProcess } from "node:child_process";

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

interface ProcessOptions {
  timeoutMs?: number;
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
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, options.timeoutMs ?? 60_000);
    timeout.unref();

    const onAbort = (): void => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
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
      stderr = (stderr + chunk).slice(-256_000);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      managedProcesses.delete(child);
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      reject(new ProcessFailure(error.message, command, null, stderr));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      managedProcesses.delete(child);
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      if (pendingLine && options.onStdoutLine) options.onStdoutLine(pendingLine);
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
