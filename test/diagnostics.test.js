import assert from "node:assert/strict";
import test from "node:test";
import {
  beginDiscDiagnostics,
  clearDiscDiagnostics,
  getLiveDiscDiagnostics,
  updateCandidateDiagnostics,
  updateDiscDiagnostics
} from "../dist/diagnostics.js";

test("live disc diagnostics track detection, source identification, classification, and removal", () => {
  clearDiscDiagnostics();
  beginDiscDiagnostics("/dev/sr0");
  assert.equal(getLiveDiscDiagnostics().status, "Inspection started");
  assert.equal(getLiveDiscDiagnostics().devicePath, "/dev/sr0");

  updateCandidateDiagnostics({
    providerId: "source.video-dvd.test",
    sourceId: "/dev/sr0",
    mediaKind: "dvd",
    label: "Example disc",
    fingerprint: "fingerprint",
    manifest: { mediaKind: "dvd", items: [{ id: "1", kind: "title", durationSeconds: 1800 }] }
  }, ["source.audio-cd.test", "source.video-dvd.test"]);
  updateDiscDiagnostics({ status: "Classification complete", classification: "Movie" });

  const current = getLiveDiscDiagnostics();
  assert.equal(current.discLabel, "Example disc");
  assert.equal(current.sourceProvider, "source.video-dvd.test");
  assert.deepEqual(current.providersAttempted, ["source.audio-cd.test", "source.video-dvd.test"]);
  assert.equal(current.classification, "Movie");

  clearDiscDiagnostics();
  assert.equal(getLiveDiscDiagnostics(), null);
});
