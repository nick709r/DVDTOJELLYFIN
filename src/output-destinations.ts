import { join } from "node:path";
import type { AppSettings, OutputProfile, OutputTarget } from "./model.js";

export type OutputMedia = "tv" | "movies" | "music";

const defaultLibraryFolders: Record<OutputMedia, string> = {
  tv: "TV Shows",
  movies: "Movies",
  music: "Music"
};

export function activeOutputProfile(settings: AppSettings): OutputProfile | undefined {
  const profiles = settings.outputDestinations?.profiles;
  return profiles?.find((profile) => profile.id === settings.outputDestinations.activeProfileId) ?? profiles?.[0];
}

export function outputTarget(settings: AppSettings, media: OutputMedia): OutputTarget {
  return activeOutputProfile(settings)?.routes[media] ?? "jellyfin";
}

export function outputPath(settings: AppSettings, media: OutputMedia): string {
  const profile = activeOutputProfile(settings);
  const target = profile?.routes[media] ?? "jellyfin";
  if (!profile) return legacyPath(settings, media);

  if (target === "jellyfin") {
    const override = profile.jellyfin.paths[media].trim();
    if (override) return override;
    const root = profile.jellyfin.root.trim();
    return root ? join(root, defaultLibraryFolders[media]) : legacyPath(settings, media);
  }
  if (target === "sonarr" && media === "tv") return profile.sonarr.seriesRoot.trim() || settings.tvRootDir;
  if (target === "radarr" && media === "movies") return profile.radarr.movieRoot.trim() || settings.moviesDir;
  if (target === "lidarr" && media === "music") return profile.lidarr.artistRoot.trim() || settings.musicDir;
  if (target === "folder") return profile.folder[media].trim() || legacyPath(settings, media);
  return legacyPath(settings, media);
}

export function outputDestinationsPayloadIsValid(input: unknown): input is AppSettings["outputDestinations"] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  if (typeof value.activeProfileId !== "string" || !Array.isArray(value.profiles) ||
    value.profiles.length < 1 || value.profiles.length > 20) return false;
  const ids = new Set<string>();
  for (const raw of value.profiles) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
    const profile = raw as Record<string, unknown>;
    if (typeof profile.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(profile.id) || ids.has(profile.id) ||
      typeof profile.name !== "string" || !profile.name.trim() || profile.name.trim().length > 80) return false;
    ids.add(profile.id);
    const routes = profile.routes;
    const jellyfin = profile.jellyfin;
    const sonarr = profile.sonarr;
    const radarr = profile.radarr;
    const lidarr = profile.lidarr;
    const folder = profile.folder;
    if (!isObject(routes) || !isObject(jellyfin) || !isObject(jellyfin.paths) ||
      !isObject(sonarr) || !isObject(radarr) || !isObject(lidarr) || !isObject(folder)) return false;
    if (!["jellyfin", "sonarr", "folder"].includes(String(routes.tv)) ||
      !["jellyfin", "radarr", "folder"].includes(String(routes.movies)) ||
      !["jellyfin", "lidarr", "folder"].includes(String(routes.music))) return false;
    if (!isPath(jellyfin.root) || !isPath(jellyfin.paths.tv) || !isPath(jellyfin.paths.movies) ||
      !isPath(jellyfin.paths.music) || !isPath(sonarr.seriesRoot) || !isPath(radarr.movieRoot) ||
      !isPath(lidarr.artistRoot) || !isPath(folder.tv) || !isPath(folder.movies) || !isPath(folder.music)) return false;
  }
  return ids.has(value.activeProfileId);
}

function legacyPath(settings: AppSettings, media: OutputMedia): string {
  return media === "tv" ? settings.tvRootDir : media === "movies" ? settings.moviesDir : settings.musicDir;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPath(value: unknown): boolean {
  return typeof value === "string" && value.length <= 4096 &&
    (value === "" || (value.startsWith("/") && !value.split("/").some((part) => part === "." || part === "..")));
}
