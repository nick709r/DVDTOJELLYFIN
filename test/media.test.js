import assert from "node:assert/strict";
import test from "node:test";
import { safeTitle, selectMainFeature } from "../dist/media.js";

test("safeTitle removes unsafe path characters without damaging a dotted movie title", () => {
  assert.equal(safeTitle("../The.Matrix.1999.mkv"), "The.Matrix.1999");
  assert.equal(safeTitle("A/B: C?"), "B C");
  assert.match(safeTitle("  "), /^Unknown Title \d{4}-\d{2}-\d{2}$/);
});

test("empty MakeMKV title lists remain retryable even when a disc label is present", () => {
  assert.equal(selectMainFeature([]), undefined);
  const titles = [
    { id: 1, name: "Extras", durationSeconds: 600 },
    { id: 2, name: "Feature", durationSeconds: 7200 }
  ];
  assert.deepEqual(selectMainFeature(titles), titles[1]);
  assert.equal(titles[0].id, 1);
});
