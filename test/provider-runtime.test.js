import assert from "node:assert/strict";
import test from "node:test";
import { createProviderRuntime } from "../dist/bootstrap/providers.js";

test("production provider runtime registers source and metadata providers", async () => {
  const runtime = await createProviderRuntime(() => ({}), {}, {
    tvEpisodeFeedback: { findForItemSignature: () => [] },
    tvProcessingPlans: { save: (plan) => plan, get: () => undefined, recordReview: () => undefined },
    tvValidationEvidence: { save: () => {}, saveMany: () => {}, get: () => undefined, list: () => [] }
  });
  try {
    assert.equal(runtime.registry.state, "initialized");
    assert.deepEqual(runtime.registry.list().map((provider) => provider.id), [
      "source.audio-cd.cdparanoia",
      "source.video-dvd.makemkv",
      "metadata.tmdb.movie",
      "metadata.musicbrainz.release",
      "metadata.tv.configured"
    ]);
    assert.deepEqual(runtime.metadataProviders.list().map((provider) => provider.describe().id), [
      "metadata.tmdb.movie",
      "metadata.musicbrainz.release",
      "metadata.tv.configured"
    ]);
    assert.deepEqual(runtime.workflows.list(), ["audio_cd", "dvd"]);
  } finally {
    await runtime.registry.disposeAll();
  }
  assert.equal(runtime.registry.state, "disposed");
});
