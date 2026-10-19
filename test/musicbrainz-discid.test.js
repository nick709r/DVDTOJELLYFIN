import assert from "node:assert/strict";
import test from "node:test";
import { musicBrainzDiscIdFromToc } from "../dist/musicbrainz-discid.js";

test("MusicBrainz disc ID matches the published audio-CD TOC example", () => {
  const toc = "6 150 15363 32314 46592 63414 80489 95462";
  assert.equal(musicBrainzDiscIdFromToc(toc, 6), "49HHV7Eb8UKF3aQiNmu1GR8vKTY-");
});

test("MusicBrainz disc ID rejects incomplete or mismatched TOCs", () => {
  assert.equal(musicBrainzDiscIdFromToc("3 150 200 250", 3), null);
  assert.equal(musicBrainzDiscIdFromToc("3 150 200 250 500", 2), null);
  assert.equal(musicBrainzDiscIdFromToc("1 150 4294967296", 1), null);
});
