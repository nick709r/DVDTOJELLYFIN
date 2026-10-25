import { dirname, join, posix, relative, resolve, sep, isAbsolute } from "node:path";
import type { AppSettings, OutputProfile } from "./model.js";
import { activeOutputProfile, outputPath, outputTarget } from "./output-destinations.js";

export type StorageMedia = "tv" | "movies" | "music";

export interface PublishingDirectory {
  media: StorageMedia;
  target: string;
  path: string;
}

export function tvStagingDirectory(settings: AppSettings): string {
  const configured = settings.tvStagingDir?.trim();
  const directory = configured || (settings.workDir.startsWith("/")
    ? posix.join(settings.workDir, "tv-staging", "unidentified")
    : join(settings.workDir, "tv-staging", "unidentified"));
  return directory.startsWith("/") ? posix.resolve(directory) : resolve(directory);
}

export function tvStagingPathSource(settings: AppSettings): "configured" | "work-directory" {
  return settings.tvStagingDir?.trim() ? "configured" : "work-directory";
}

export function pathsOverlap(first: string, second: string): boolean {
  const firstToSecond = relative(resolve(first), resolve(second));
  const secondToFirst = relative(resolve(second), resolve(first));
  const isWithin = (path: string): boolean =>
    path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
  return isWithin(firstToSecond) || isWithin(secondToFirst);
}

export function activePublishingDirectories(settings: AppSettings): PublishingDirectory[] {
  return (["tv", "movies", "music"] as const).map((media) => ({
    media,
    target: outputTarget(settings, media),
    path: outputPath(settings, media)
  }));
}

export function tvStagingConflicts(settings: AppSettings): PublishingDirectory[] {
  const staging = tvStagingDirectory(settings);
  return activePublishingDirectories(settings).filter(({ path }) => pathsOverlap(staging, path));
}

export function tvStagingConflictMessage(stagingPath: string, directory: PublishingDirectory): string {
  const staging = resolve(stagingPath);
  const library = resolve(directory.path);
  const explanation = tvStagingConflictExplanation(staging, directory);
  return `TV processing cannot continue because the TV staging folder:\n${staging}\noverlaps with the configured media library:\n${library}\n${explanation}\nOpen Settings > Storage & Output to resolve the conflict.`;
}

export function tvStagingConflictExplanation(stagingPath: string, directory: PublishingDirectory): string {
  const staging = resolve(stagingPath);
  const library = resolve(directory.path);
  const relation = staging === library
    ? "resolves to the same location as"
    : pathsOverlap(staging, library) && pathIsWithin(library, staging)
      ? "is contained within"
      : "contains";
  const targetName = directory.target === "folder"
    ? "Custom"
    : directory.target.slice(0, 1).toUpperCase() + directory.target.slice(1);
  const mediaName = directory.media === "tv" ? "TV" : directory.media === "movies" ? "movie" : "music";
  return `The TV staging folder ${relation} the ${targetName} ${mediaName} output folder.`;
}

export function recommendedTvStagingDirectory(settings: AppSettings): string | null {
  const roots = activePublishingDirectories(settings).map(({ path }) => path);
  const linuxPaths = settings.workDir.startsWith("/");
  let anchor = linuxPaths
    ? posix.dirname(posix.resolve(settings.workDir))
    : dirname(resolve(settings.workDir));
  for (let level = 0; level < 100; level += 1) {
    const candidate = linuxPaths
      ? posix.resolve(anchor, "autodisc", "staging", "tv")
      : resolve(anchor, "autodisc", "staging", "tv");
    if (roots.every((root) => !pathsOverlap(candidate, root))) return candidate;
    const parent = dirname(anchor);
    if (parent === anchor) break;
    anchor = parent;
  }
  return null;
}

export function resolvedStoragePaths(settings: AppSettings, databasePath: string): {
  work: string;
  review: string;
  tvStaging: string;
  cache: string;
  jellyfinOutput: string;
  sonarrOutput: string;
  radarrOutput: string;
  customOutput: string;
} {
  const profile = activeOutputProfile(settings);
  const jellyfin = profile ? mediaPaths(profile, settings) : [];
  return {
    work: resolve(settings.workDir),
    review: resolve(settings.workDir, "reviews"),
    tvStaging: tvStagingDirectory(settings),
    cache: dirname(resolve(databasePath)),
    jellyfinOutput: formatPaths(jellyfin),
    sonarrOutput: profile?.sonarr.seriesRoot.trim() || settings.tvRootDir,
    radarrOutput: profile?.radarr.movieRoot.trim() || settings.moviesDir,
    customOutput: formatPaths([
      profile?.folder.tv,
      profile?.folder.movies,
      profile?.folder.music
    ].filter((path): path is string => Boolean(path?.trim())))
  };
}

function mediaPaths(profile: OutputProfile, settings: AppSettings): string[] {
  const defaults: Record<StorageMedia, string> = {
    tv: "TV Shows",
    movies: "Movies",
    music: "Music"
  };
  const legacy: Record<StorageMedia, string> = {
    tv: settings.tvRootDir,
    movies: settings.moviesDir,
    music: settings.musicDir
  };
  return (["tv", "movies", "music"] as const).map((media) => {
    const override = profile.jellyfin.paths[media].trim();
    if (override) return override;
    const root = profile.jellyfin.root.trim();
    return root ? join(root, defaults[media]) : legacy[media];
  });
}

function formatPaths(paths: string[]): string {
  return [...new Set(paths.map((path) => path.trim()).filter(Boolean))]
    .map((path) => resolve(path))
    .join("\n");
}

function pathIsWithin(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
