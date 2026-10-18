import assert from "node:assert/strict";
import test from "node:test";
import { isRecognizedNonVideoDisc, safeTitle } from "../dist/media.js";

test("safeTitle removes unsafe path characters without damaging a dotted movie title", () => {
  assert.equal(safeTitle("../The.Matrix.1999.mkv"), "The.Matrix.1999");
  assert.equal(safeTitle("A/B: C?"), "B C");
  assert.match(safeTitle("  "), /^Unknown Title \d{4}-\d{2}-\d{2}$/);
});

test("unlabeled empty MakeMKV responses are retryable but named non-video media is ignored", () => {
  assert.equal(isRecognizedNonVideoDisc({ label: "", titles: [] }), false);
  assert.equal(isRecognizedNonVideoDisc({ label: "DATA_DISC", titles: [] }), true);
  assert.equal(isRecognizedNonVideoDisc({
    label: "MOVIE_DISC",
    titles: [{ id: 1, name: "Feature", durationSeconds: 7200 }]
  }), false);
});
