import assert from "node:assert/strict";
import test from "node:test";
import { safeTitle } from "../dist/media.js";

test("safeTitle removes unsafe path characters without damaging a dotted movie title", () => {
  assert.equal(safeTitle("../The.Matrix.1999.mkv"), "The.Matrix.1999");
  assert.equal(safeTitle("A/B: C?"), "B C");
  assert.match(safeTitle("  "), /^Unknown Title \d{4}-\d{2}-\d{2}$/);
});
