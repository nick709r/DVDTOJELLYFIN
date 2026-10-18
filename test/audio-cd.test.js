import assert from "node:assert/strict";
import test from "node:test";
import { parseAudioTrackNumbers } from "../dist/audio-cd.js";

test("audio CD TOC parsing returns unique, ordered audio tracks", () => {
  const output = [
    "Table of contents (audio tracks only):",
    "track 03: 123 [0:16.48] etc",
    "track 01: 0 [0:02.00] etc",
    "track 03: 123 [0:16.48] duplicate",
    "track 00: invalid",
    "track 02: 90 [0:12.00] etc"
  ].join("\n");

  assert.deepEqual(parseAudioTrackNumbers(output), [1, 2, 3]);
  assert.deepEqual(parseAudioTrackNumbers("No audio tracks"), []);
});

test("audio CD TOC parsing recognizes cdparanoia query table rows", () => {
  const output = [
    "Table of contents (audio tracks only):",
    "  1.     0 [00:02.00]     0 [00:02.00] no no 2",
    "  2. 12345 [02:44.45] 12345 [02:44.45] no no 2",
    "  3.   875 [00:11.50] 24790 [05:30.40] no no 2"
  ].join("\n");

  assert.deepEqual(parseAudioTrackNumbers(output), [1, 2, 3]);
});

test("audio CD track parsing excludes table headings and invalid track zero rows", () => {
  const output = [
    "Table of contents (audio tracks only):",
    "track 00: invalid",
    "  0.     0 [00:00.00]     0 [00:00.00] no no 2",
    "  1. 12345 [02:44.45] 12345 [02:44.45] no no 2"
  ].join("\n");

  assert.deepEqual(parseAudioTrackNumbers(output), [1]);
});
