import assert from "node:assert/strict";
import test from "node:test";
import { JobCoordinator } from "../dist/application/job-coordinator.js";

test("job coordinator centralizes start, step, progress event, terminal result and cancellation context", () => {
  const calls = [];
  const repositories = {
    settings: { get: () => ({}) },
    jobs: {
      add: (...args) => calls.push(["add", ...args]),
      active: () => null,
      setStatus: (...args) => calls.push(["status", ...args]),
      update: (...args) => calls.push(["update", ...args]),
      finish: (...args) => calls.push(["finish", ...args]),
      addWarning: (...args) => calls.push(["warning", ...args])
    },
    recovery: { lastDiscFingerprint: () => null },
    events: { add: (...args) => calls.push(["event", ...args]) }
  };
  const published = [];
  const coordinator = new JobCoordinator(repositories, {
    publish: (...args) => published.push(args)
  }, {
    begin: () => {},
    register: () => {},
    cancel: () => false,
    wasCancelled: () => false,
    end: () => {}
  });
  const controller = new AbortController();
  const context = coordinator.begin("job-1", "Test", "future_media", null, controller.signal);
  coordinator.step(context, { id: "acquire", status: "ripping", message: "Acquiring" });
  coordinator.update(context, { progress: 35 });
  coordinator.record(context, "metadata", "info", "Resolved");
  assert.deepEqual(coordinator.complete(context), { jobId: "job-1", status: "completed" });
  assert.deepEqual(calls[0], ["add", "job-1", "Test", null, "future_media"]);
  assert.deepEqual(calls.at(-1), ["finish", "job-1", "completed", null, undefined]);
  assert.deepEqual(published.map((event) => event[1]), ["inspecting", "ripping", undefined, "completed"]);

  const cancelled = coordinator.begin("job-2", "Test", "future_media", null, controller.signal);
  controller.abort(new Error("cancelled"));
  assert.throws(() => cancelled.throwIfCancelled(), /cancelled/);
});
