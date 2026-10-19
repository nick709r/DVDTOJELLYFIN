import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("movie output uses a title-named folder and matching movie filename", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autodisc-movie-output-"));
  try {
    const { createMovieOutput } = await import("../dist/movie-output.js");
    const output = await createMovieOutput(root, "Karate Kid", "mkv");

    assert.equal(output.directory, path.join(root, "Karate Kid"));
    assert.equal(output.path, path.join(root, "Karate Kid", "Karate Kid.mkv"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("movie output chooses a suffixed folder when that movie folder already exists", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autodisc-movie-output-"));
  try {
    await mkdir(path.join(root, "Karate Kid"));
    const { createMovieOutput } = await import("../dist/movie-output.js");
    const output = await createMovieOutput(root, "Karate Kid", "mp4");

    assert.equal(output.directory, path.join(root, "Karate Kid (2)"));
    assert.equal(output.path, path.join(root, "Karate Kid (2)", "Karate Kid (2).mp4"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
