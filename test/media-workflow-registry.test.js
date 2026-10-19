import assert from "node:assert/strict";
import test from "node:test";
import { MediaWorkflowRegistry } from "../dist/application/media-workflow-registry.js";

test("workflow registry dispatches an unrecognized media kind to its registered handler", async () => {
  const registry = new MediaWorkflowRegistry();
  const calls = [];
  registry.register({
    mediaKind: "watch_folder_video",
    process: async (context) => {
      calls.push(context.source.candidate.mediaKind);
      return true;
    }
  });
  const source = {
    provider: {},
    candidate: {
      providerId: "source.watch-folder",
      sourceId: "folder-1",
      mediaKind: "watch_folder_video",
      label: "Imported video",
      manifest: { mediaKind: "watch_folder_video", items: [] }
    }
  };

  assert.equal(await registry.process(source, {}), true);
  assert.deepEqual(calls, ["watch_folder_video"]);
  assert.throws(() => registry.register({
    mediaKind: "watch_folder_video",
    process: async () => true
  }), /already registered/);
});

test("workflow registry reports missing workflow registrations explicitly", async () => {
  const registry = new MediaWorkflowRegistry();
  await assert.rejects(registry.process({
    provider: {},
    candidate: {
      providerId: "source.future",
      sourceId: "future-1",
      mediaKind: "future_type",
      label: "Future",
      manifest: { mediaKind: "future_type", items: [] }
    }
  }, {}), /No workflow is registered for media kind future_type/);
});
