import assert from "node:assert/strict";
import test from "node:test";
import { isGeneratedUnknownTitle, normalizeVolumeTitle, safeTitle, selectMainFeature } from "../dist/media.js";

test("safeTitle removes unsafe path characters without damaging a dotted movie title", () => {
  assert.equal(safeTitle("../The.Matrix.1999.mkv"), "The.Matrix.1999");
  assert.equal(safeTitle("A/B: C?"), "B C");
  assert.match(safeTitle("  "), /^Unknown Title \d{4}-\d{2}-\d{2}$/);
});

test("normalizeVolumeTitle converts filesystem volume separators and casing to a readable title", () => {
  assert.equal(normalizeVolumeTitle("THE_BREAK_UP"), "The Break Up");
});

test("generated unknown titles are detectable before automatic publishing", () => {
  assert.equal(isGeneratedUnknownTitle("///"), true);
  assert.equal(isGeneratedUnknownTitle("Unknown Title 2026-10-28"), true);
  assert.equal(isGeneratedUnknownTitle("The Break-Up (2006)"), false);
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
