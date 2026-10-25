import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyPublishedPermissions } from "../dist/published-media-permissions.js";

test("published content is accessible to the library group without world-write access", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autodisc-published-permissions-"));
  const library = path.join(root, "library");
  const series = path.join(library, "Example Series");
  const season = path.join(series, "Season 1");
  const episode = path.join(season, "Example Series - S01E01.mkv");
  try {
    await mkdir(library);
    if (process.platform !== "win32") await chmod(library, 0o2775);
    await mkdir(season, { recursive: true });
    await writeFile(episode, Buffer.alloc(128));

    await applyPublishedPermissions(series, library);

    const libraryInfo = await stat(library);
    const seriesInfo = await stat(series);
    const seasonInfo = await stat(season);
    const episodeInfo = await stat(episode);
    await access(series, constants.R_OK | constants.W_OK | constants.X_OK);
    await access(season, constants.R_OK | constants.W_OK | constants.X_OK);
    await access(episode, constants.R_OK | constants.W_OK);
    if (process.platform !== "win32") {
      for (const directoryInfo of [seriesInfo, seasonInfo]) {
        assert.equal(directoryInfo.gid, libraryInfo.gid);
        assert.equal(directoryInfo.mode & 0o777, 0o775);
        assert.equal(directoryInfo.mode & 0o070, 0o070);
        assert.equal(directoryInfo.mode & 0o002, 0);
      }
      assert.equal(episodeInfo.gid, libraryInfo.gid);
      assert.equal(episodeInfo.mode & 0o777, 0o664);
      assert.equal(episodeInfo.mode & 0o060, 0o060);
      assert.equal(episodeInfo.mode & 0o002, 0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("published permissions cannot be applied outside the destination library", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autodisc-published-boundary-"));
  const library = path.join(root, "library");
  const outside = path.join(root, "outside");
  try {
    await mkdir(library);
    await mkdir(outside);
    await assert.rejects(
      applyPublishedPermissions(outside, library),
      /inside its destination library/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
