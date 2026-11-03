import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDiscName, parseDiscName, parseDiscStructureHints } from "../dist/application/tv-name-normalization.js";

test("volume names yield title, season and disc together", () => {
  for (const name of [
    "FRESH_OFF_THE_BOAT_S6_D1",
    "FRESH_OFF_THE_BOAT_S06_D01",
    "Fresh-Off-The-Boat-Season-6-Disc-1",
    "Fresh.Off.The.Boat.S06.D01"
  ]) {
    assert.deepEqual(parseDiscName(name), { seriesName: "Fresh Off The Boat", seasonNumber: 6, discNumber: 1 }, name);
  }
  for (const suffix of ["SEASON_6_DISC_1", "SEASON6_DISC1", "S6_D1", "S06_D01"]) {
    assert.deepEqual(parseDiscName(`Show_${suffix}`), { seriesName: "Show", seasonNumber: 6, discNumber: 1 }, suffix);
  }
  assert.deepEqual(parseDiscName("Show_SEASON-6"), { seriesName: "Show", seasonNumber: 6 });
  assert.deepEqual(parseDiscName("Show_DISC-1"), { seriesName: "Show", discNumber: 1 });
});

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

test("discNameKey treats SHREK_2, SHREK2 and SHREK_2_DISC1 as the same movie", async () => {
  const { discNameKey } = await import("../dist/application/tv-name-normalization.js");
  const keys = ["SHREK_2", "SHREK2", "SHREK_2_DISC1", "Shrek 2"].map(discNameKey);
  assert.deepEqual([...new Set(keys)], ["shrek2"]);
  assert.notEqual(discNameKey("SHREK"), discNameKey("SHREK_2"));
});
