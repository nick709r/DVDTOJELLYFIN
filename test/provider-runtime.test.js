import assert from "node:assert/strict";
import test from "node:test";
import { createProviderRuntime } from "../dist/bootstrap/providers.js";

test("production provider runtime registers DVD and audio CD source adapters", async () => {
  const runtime = await createProviderRuntime();
  try {
    assert.equal(runtime.registry.state, "initialized");
    assert.deepEqual(runtime.registry.list().map((provider) => provider.id), [
      "source.audio-cd.cdparanoia",
      "source.video-dvd.makemkv"
    ]);
  } finally {
    await runtime.registry.disposeAll();
  }
  assert.equal(runtime.registry.state, "disposed");
});
