import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { defaultSettings } from "../dist/infrastructure/database/default-settings.js";
import {
  activePublishingDirectories,
  pathsOverlap,
  recommendedTvStagingDirectory,
  resolvedStoragePaths,
  tvStagingConflictMessage,
  tvStagingConflictExplanation,
  tvStagingConflicts,
  tvStagingDirectory,
  tvStagingPathSource
} from "../dist/storage-paths.js";

function settingsWithFolderOutputs(overrides = {}) {
  const settings = structuredClone(defaultSettings);
  const profile = settings.outputDestinations.profiles[0];
  profile.routes = { tv: "folder", movies: "folder", music: "folder" };
  profile.folder = {
    tv: "/media/TV",
    movies: "/media/Movies",
    music: "/media/Music"
  };
  return { ...settings, workDir: "/autodisc/work", ...overrides };
}

test("TV staging defaults under Work Directory and accepts an explicit path", () => {
  const settings = settingsWithFolderOutputs();
  assert.equal(tvStagingDirectory(settings), path.posix.resolve("/autodisc/work/tv-staging/unidentified"));
  assert.equal(tvStagingPathSource(settings), "work-directory");

  const configured = { ...settings, tvStagingDir: "/autodisc/staging/tv" };
  assert.equal(tvStagingDirectory(configured), path.posix.resolve("/autodisc/staging/tv"));
  assert.equal(tvStagingPathSource(configured), "configured");
});

test("storage diagnostics identify nested publishing conflicts and resolved destinations", () => {
  const settings = settingsWithFolderOutputs({
    tvStagingDir: "/media/TV/staging",
    workDir: "/autodisc/work"
  });
  const conflicts = tvStagingConflicts(settings);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].target, "folder");
  assert.match(tvStagingConflictExplanation(settings.tvStagingDir, conflicts[0]), /contained within.*Custom TV output/i);
  const message = tvStagingConflictMessage(settings.tvStagingDir, conflicts[0]);
  assert.match(message, /TV processing cannot continue/);
  assert.match(message, /overlaps with the configured media library/);
  assert.ok(message.includes(path.resolve("/media/TV/staging")));
  assert.ok(message.includes(path.resolve("/media/TV")));
  assert.match(message, /Settings > Storage & Output/);
  assert.equal(pathsOverlap("/media/TV", "/media/TV/staging"), true);
  assert.equal(pathsOverlap("/media/TV", "/media/Movies"), false);

  const active = activePublishingDirectories(settings);
  assert.deepEqual(active.map(({ media }) => media), ["tv", "movies", "music"]);
  const resolved = resolvedStoragePaths(settings, "/var/lib/autodisc/autodisc.sqlite");
  assert.equal(resolved.review, path.resolve("/autodisc/work/reviews"));
  assert.equal(resolved.cache, path.resolve("/var/lib/autodisc"));
  assert.equal(resolved.tvStaging, path.posix.resolve("/media/TV/staging"));
  assert.ok(resolved.customOutput.includes(path.resolve("/media/TV")));
});

test("recommended TV staging path avoids every active publishing directory", () => {
  const settings = settingsWithFolderOutputs({
    workDir: "/srv/autodisc/work"
  });
  settings.outputDestinations.profiles[0].folder.tv = "/srv/autodisc/autodisc/staging/tv";
  const recommended = recommendedTvStagingDirectory(settings);
  assert.ok(recommended);
  assert.equal(activePublishingDirectories(settings).some(({ path: output }) => pathsOverlap(recommended, output)), false);
});
