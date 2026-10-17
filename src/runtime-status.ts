import { events } from "./events.js";

export type RuntimeStatus = "idle" | "inspecting" | "completed" | "failed";

let status: RuntimeStatus = "idle";
let returnToIdle: NodeJS.Timeout | undefined;

export function getRuntimeStatus(): RuntimeStatus {
  return status;
}

export function setRuntimeStatus(next: RuntimeStatus): void {
  if (returnToIdle) clearTimeout(returnToIdle);
  returnToIdle = undefined;
  if (status === next) return;
  status = next;
  events.emit("status");
}

export function discRemoved(): void {
  if (status !== "completed") {
    setRuntimeStatus("idle");
    return;
  }
  if (returnToIdle) clearTimeout(returnToIdle);
  returnToIdle = setTimeout(() => setRuntimeStatus("idle"), 10_000);
  returnToIdle.unref();
}
