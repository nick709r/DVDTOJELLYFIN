import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { defaultSettings } from "../dist/infrastructure/database/default-settings.js";
import { outputDestinationsPayloadIsValid, outputPath, outputTarget } from "../dist/output-destinations.js";

test("destination routing resolves inherited Jellyfin roots and per-category overrides", () => {
  const settings = structuredClone(defaultSettings);
  const profile = settings.outputDestinations.profiles[0];
  profile.jellyfin.root = "/media/library";
  profile.jellyfin.paths = { tv: "", movies: "/archive/Films", music: "" };

  assert.equal(outputPath(settings, "tv"), join("/media/library", "TV Shows"));
  assert.equal(outputPath(settings, "movies"), "/archive/Films");
  assert.equal(outputPath(settings, "music"), join("/media/library", "Music"));
  assert.equal(outputTarget(settings, "tv"), "jellyfin");
});

test("destination routing resolves selected Sonarr, Radarr, Lidarr, and generic folders", () => {
  const settings = structuredClone(defaultSettings);
  const profile = settings.outputDestinations.profiles[0];
  profile.routes = { tv: "sonarr", movies: "radarr", music: "lidarr" };
  profile.sonarr.seriesRoot = "/media/sonarr";
  profile.radarr.movieRoot = "/media/radarr";
  profile.lidarr.artistRoot = "/media/lidarr";

  assert.equal(outputPath(settings, "tv"), "/media/sonarr");
  assert.equal(outputPath(settings, "movies"), "/media/radarr");
  assert.equal(outputPath(settings, "music"), "/media/lidarr");

  profile.routes = { tv: "folder", movies: "folder", music: "folder" };
  profile.folder = { tv: "/archive/tv", movies: "/archive/movies", music: "/archive/music" };
  assert.deepEqual(
    ["tv", "movies", "music"].map((media) => outputPath(settings, media)),
    ["/archive/tv", "/archive/movies", "/archive/music"]
  );
});

test("destination profile validation rejects unsafe paths, invalid media routes, and duplicate IDs", () => {
  const settings = structuredClone(defaultSettings.outputDestinations);
  assert.equal(outputDestinationsPayloadIsValid(settings), true);

  const unsafe = structuredClone(settings);
  unsafe.profiles[0].folder.tv = "/media/../outside";
  assert.equal(outputDestinationsPayloadIsValid(unsafe), false);

  const invalidRoute = structuredClone(settings);
  invalidRoute.profiles[0].routes.movies = "sonarr";
  assert.equal(outputDestinationsPayloadIsValid(invalidRoute), false);

  const duplicate = structuredClone(settings);
  duplicate.profiles.push(structuredClone(duplicate.profiles[0]));
  assert.equal(outputDestinationsPayloadIsValid(duplicate), false);
});
