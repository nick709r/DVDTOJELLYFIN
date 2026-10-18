import assert from "node:assert/strict";
import test from "node:test";
import { parseMusicBrainzRelease, resolveMusicMetadata } from "../dist/music-metadata.js";

test("music metadata stays offline unless explicitly enabled", async () => {
  const disc = {
    discId: "01234567",
    fingerprint: "test-fingerprint",
    trackNumbers: [1, 2]
  };
  const metadata = await resolveMusicMetadata(disc, false);

  assert.equal(metadata.source, "offline");
  assert.equal(metadata.artist, "Unknown Artist");
  assert.deepEqual(metadata.tracks, [
    { number: 1, title: "Track 01" },
    { number: 2, title: "Track 02" }
  ]);
});

test("MusicBrainz lookup identifies AutoDisc and includes the optional contact email", async () => {
  const disc = {
    discId: "01234567",
    fingerprint: "test-fingerprint",
    trackNumbers: [1]
  };
  const originalFetch = globalThis.fetch;
  let userAgent = "";
  globalThis.fetch = async (_input, init) => {
    userAgent = new Headers(init?.headers).get("User-Agent") ?? "";
    return new Response(JSON.stringify({ releases: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  try {
    const metadata = await resolveMusicMetadata(disc, true, undefined, "music-admin@example.com");
    assert.equal(metadata.source, "offline");
    assert.match(userAgent, /^AutoDisc\/1\.5\.2 /);
    assert.match(userAgent, /contact: music-admin@example\.com/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MusicBrainz release parsing selects the medium for the matching disc ID", () => {
  const disc = {
    discId: "01234567",
    fingerprint: "test-fingerprint",
    trackNumbers: [1, 2]
  };
  const metadata = parseMusicBrainzRelease({
    releases: [
      {
        title: "Wrong pressing",
        "artist-credit": [{ name: "Artist" }],
        media: [{ tracks: [{ title: "Wrong 1" }, { title: "Wrong 2" }] }]
      },
      {
        title: "Right album",
        date: "2004-05-06",
        "artist-credit": [{ name: "Artist", joinphrase: " & " }, { artist: { name: "Guest" } }],
        media: [
          { tracks: [{ title: "Wrong medium 1" }, { title: "Wrong medium 2" }] },
          {
            discs: [{ id: "01234567" }],
            tracks: [{ recording: { title: "Opening" } }, { recording: { title: "Finale" } }]
          }
        ]
      }
    ]
  }, disc);

  assert.equal(metadata.source, "musicbrainz");
  assert.equal(metadata.artist, "Artist & Guest");
  assert.equal(metadata.album, "Right album");
  assert.equal(metadata.year, "2004");
  assert.deepEqual(metadata.tracks, [
    { number: 1, title: "Opening" },
    { number: 2, title: "Finale" }
  ]);
});
