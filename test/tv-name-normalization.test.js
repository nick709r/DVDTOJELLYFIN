import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDiscName, parseDiscStructureHints } from "../dist/application/tv-name-normalization.js";

test("disc labels recognize compact and explicit season and disc numbering", () => {
  const cases = [
    ["D1", { discNumber: 1 }],
    ["D2", { discNumber: 2 }],
    ["DISC1", { discNumber: 1 }],
    ["DISC2", { discNumber: 2 }],
    ["DISK1", { discNumber: 1 }],
    ["DISK2", { discNumber: 2 }],
    ["S3D2", { seasonNumber: 3, discNumber: 2 }],
    ["S03D02", { seasonNumber: 3, discNumber: 2 }],
    ["Season3Disc2", { seasonNumber: 3, discNumber: 2 }]
  ];

  for (const [label, expected] of cases) {
    assert.deepEqual(parseDiscStructureHints(label), expected, label);
  }
});

test("disc-label normalization extracts the series name without structure markers", () => {
  assert.equal(normalizeDiscName("fresh-off-the-boat-s3-d2"), "Fresh Off The Boat");
  assert.equal(normalizeDiscName("FreshOffTheBoatSeason3Disc2"), "Fresh Off The Boat");
});

test("ambiguous labels do not invent a disc number", () => {
  assert.deepEqual(parseDiscStructureHints("Fresh Off the Boat Season 3"), { seasonNumber: 3 });
  assert.deepEqual(parseDiscStructureHints("Fresh Off the Boat 2021"), {});
});
