import assert from "node:assert/strict";
import test from "node:test";
import { runProcess, waitForManagedProcesses } from "../dist/process.js";

test("managed child processes are awaited before drive ejection", async () => {
  const child = runProcess(process.execPath, ["-e", "setTimeout(() => {}, 300)"], { timeoutMs: 2000 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(await waitForManagedProcesses(20), false);
  await child;
  assert.equal(await waitForManagedProcesses(100), true);
});
