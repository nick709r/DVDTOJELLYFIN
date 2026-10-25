import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseAudioTrackNumbers, parseRippedAudioTrackNumber } from "../dist/audio-cd.js";
import { ensureAudioAlbumFolders, publishAudioAlbum } from "../dist/music-pipeline.js";

test("audio extraction ignores cdparanoia pregap track 00", () => {
  assert.equal(parseRippedAudioTrackNumber("track00.cdda.wav"), null);
  assert.equal(parseRippedAudioTrackNumber("track01.cdda.wav"), 1);
  assert.equal(parseRippedAudioTrackNumber("track14.cdda.wav"), 14);
  assert.equal(parseRippedAudioTrackNumber("other-file.wav"), null);
});

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

test("audio destination folders are created recursively for missing artist and album paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autodisc-audio-destination-"));
  const output = path.join(root, "Music", "Library");
  const staging = path.join(root, "album-stage");
  const reviews = [];
  const jobs = { createReview: (review) => reviews.push(review) };
  const context = { id: "audio-job" };
  const disc = { fingerprint: "audio-fingerprint", discId: "release-disc", trackNumbers: [1] };
  try {
    const artistDirectory = await ensureAudioAlbumFolders(jobs, context, output, "The: Artist?", disc, "/dev/sr0");
    assert.equal(artistDirectory, path.join(output, "The Artist"));
    await mkdir(staging);
    await writeFile(path.join(staging, "01 - Track.flac"), "audio");

    const albumDirectory = await publishAudioAlbum(
      jobs, context, staging, artistDirectory, "An Album", disc, "/dev/sr0"
    );
    assert.equal(albumDirectory, path.join(artistDirectory, "An Album"));
    assert.equal(await readFile(path.join(albumDirectory, "01 - Track.flac"), "utf8"), "audio");
    const libraryInfo = await stat(output);
    const albumInfo = await stat(albumDirectory);
    const trackInfo = await stat(path.join(albumDirectory, "01 - Track.flac"));
    if (process.platform !== "win32") {
      assert.equal(albumInfo.gid, libraryInfo.gid);
      assert.equal(trackInfo.gid, libraryInfo.gid);
      assert.equal(albumInfo.mode & 0o777, 0o775);
      assert.equal(trackInfo.mode & 0o777, 0o664);
      assert.equal(albumInfo.mode & 0o002, 0);
      assert.equal(trackInfo.mode & 0o002, 0);
    }
    assert.deepEqual(reviews, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("audio CD folder creation is idempotent and preserves existing albums with a unique destination", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autodisc-audio-existing-"));
  const output = path.join(root, "Music");
  const artist = path.join(output, "Artist");
  const existingAlbum = path.join(artist, "Album");
  const staging = path.join(root, "staging");
  const jobs = { createReview: () => assert.fail("No review should be created") };
  const context = { id: "audio-job" };
  const disc = { fingerprint: "audio-fingerprint", discId: null, trackNumbers: [1] };
  try {
    await mkdir(existingAlbum, { recursive: true });
    await writeFile(path.join(existingAlbum, "keep.txt"), "existing");
    const firstArtist = await ensureAudioAlbumFolders(jobs, context, output, "Artist", disc, "/dev/sr0");
    const secondArtist = await ensureAudioAlbumFolders(jobs, context, output, "Artist", disc, "/dev/sr0");
    assert.equal(firstArtist, artist);
    assert.equal(secondArtist, artist);

    await mkdir(staging);
    await writeFile(path.join(staging, "01 - Track.flac"), "new audio");
    const published = await publishAudioAlbum(jobs, context, staging, artist, "Album", disc, "/dev/sr0");
    assert.equal(published, path.join(artist, "Album (2)"));
    assert.equal(await readFile(path.join(existingAlbum, "keep.txt"), "utf8"), "existing");
    assert.equal(await readFile(path.join(published, "01 - Track.flac"), "utf8"), "new audio");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("destination permission failures create a detailed folder-creation review", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autodisc-audio-denied-"));
  const output = path.join(root, "Music");
  const reviews = [];
  const jobs = { createReview: (review) => reviews.push(review) };
  const context = { id: "permission-job" };
  const disc = { fingerprint: "permission-fingerprint", discId: "disc-id", trackNumbers: [1] };
  const denied = Object.assign(new Error("permission denied"), { code: "EACCES", syscall: "mkdir" });
  try {
    await assert.rejects(
      ensureAudioAlbumFolders(jobs, context, output, "Artist", disc, "/dev/sr0", async (directory) => {
        if (directory === path.join(output, "Artist")) throw denied;
        await mkdir(directory, { recursive: true });
      }),
      { code: "folder_creation_failed" }
    );
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].category, "folder_creation_failure");
    assert.equal(reviews[0].relatedJobId, "permission-job");
    assert.equal(reviews[0].relatedDisc, "disc-id");
    assert.equal(reviews[0].relatedDrive, "/dev/sr0");
    assert.equal(reviews[0].requestedPath, path.join(output, "Artist"));
    assert.equal(reviews[0].errorDetails.errorCode, "EACCES");
    assert.ok(reviews[0].errorDetails.parentPermissions);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("album publish permission failures create a retryable folder review", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autodisc-audio-publish-denied-"));
  const artist = path.join(root, "Music", "Artist");
  const staging = path.join(root, "staging");
  const reviews = [];
  const jobs = { createReview: (review) => reviews.push(review) };
  const context = { id: "publish-job" };
  const disc = { fingerprint: "publish-fingerprint", discId: null, trackNumbers: [1] };
  const denied = Object.assign(new Error("permission denied"), { code: "EACCES", syscall: "rename" });
  try {
    await mkdir(artist, { recursive: true });
    await mkdir(staging);
    await assert.rejects(
      publishAudioAlbum(jobs, context, staging, artist, "Album", disc, "/dev/sr0", async () => { throw denied; }),
      { code: "folder_creation_failed" }
    );
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].category, "folder_creation_failure");
    assert.equal(reviews[0].requestedPath, path.join(artist, "Album"));
    assert.equal(reviews[0].errorDetails.errorCode, "EACCES");
    assert.equal(reviews[0].suggestedActions.some((action) => action.type === "retry"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
