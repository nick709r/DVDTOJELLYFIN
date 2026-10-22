import assert from "node:assert/strict";
import test from "node:test";
import { fingerprintDisc } from "../dist/domain/disc-fingerprint.js";

const candidate = {
  providerId: "source.video-dvd.makemkv",
  sourceId: "/dev/sr0",
  mediaKind: "dvd",
  label: " Example Disc ",
  manifest: {
    mediaKind: "dvd",
    attributes: { filesystemVolumeName: "VOLUME", dvdVolumeName: "DISC" },
    items: [
      { id: "1", kind: "title", title: "Episode", durationSeconds: 1800 },
      { id: "2", kind: "title", title: "Bonus", durationSeconds: 600 }
    ]
  }
};

test("disc fingerprints are stable and include the complete manifest identity", () => {
  assert.equal(fingerprintDisc(candidate), fingerprintDisc(structuredClone(candidate)));
  assert.notEqual(fingerprintDisc(candidate), fingerprintDisc({
    ...candidate,
    manifest: { ...candidate.manifest, attributes: { ...candidate.manifest.attributes, dvdVolumeName: "OTHER" } }
  }));
  assert.notEqual(fingerprintDisc(candidate), fingerprintDisc({
    ...candidate,
    manifest: { ...candidate.manifest, items: candidate.manifest.items.slice(0, 1) }
  }));
  assert.notEqual(fingerprintDisc(candidate), fingerprintDisc({
    ...candidate,
    providerId: "source.video-dvd.other"
  }));
});
