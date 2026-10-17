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
