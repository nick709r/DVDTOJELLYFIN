import assert from "node:assert/strict";
import test from "node:test";
import {
  getManualMusicMetadataPrompt,
  submitManualMusicMetadata,
  waitForManualMusicMetadata
} from "../dist/manual-music-metadata.js";

test("manual metadata prompt resolves submitted album and track details", async () => {
  const disc = { discId: "01234567", fingerprint: "test", trackNumbers: [1, 3] };
  const metadataPromise = waitForManualMusicMetadata("manual-job", disc);
  assert.deepEqual(getManualMusicMetadataPrompt("manual-job"), {
    jobId: "manual-job",
    discId: "01234567",
    tracks: [
      { number: 1, title: "Track 01" },
      { number: 3, title: "Track 03" }
    ]
  });

  const metadata = {
    artist: "Artist",
    album: "Album",
    year: "2001",
    tracks: [{ number: 1, title: "Opening" }, { number: 3, title: "Closing" }],
    source: "manual"
  };
  assert.equal(submitManualMusicMetadata("manual-job", metadata), true);
  assert.deepEqual(await metadataPromise, metadata);
  assert.equal(getManualMusicMetadataPrompt("manual-job"), null);
});

test("cancelling a manual metadata wait clears its prompt", async () => {
  const controller = new AbortController();
  const metadataPromise = waitForManualMusicMetadata(
    "cancelled-manual-job",
    { discId: null, fingerprint: "test", trackNumbers: [1] },
    controller.signal
  );
  controller.abort();
  await assert.rejects(metadataPromise, /cancelled/);
  assert.equal(getManualMusicMetadataPrompt("cancelled-manual-job"), null);
  assert.equal(submitManualMusicMetadata("cancelled-manual-job", {
    artist: "Artist",
    album: "Album",
    year: null,
    tracks: [{ number: 1, title: "Opening" }],
    source: "manual"
  }), false);
});
