import { join } from "node:path";
import type { DiscRecovery, EpisodeMapping } from "../domain/disc-recovery.js";
import type { AppSettings } from "../model.js";
import { libraryTemplate, renderLibraryTemplate } from "../library-metadata.js";
import { outputPath } from "../output-destinations.js";

export function tvEpisodeOutput(
  settings: AppSettings,
  recovery: Pick<DiscRecovery, "seriesName" | "importedMetadata">,
  mapping: EpisodeMapping
) {
  const seriesName = recovery.seriesName?.trim();
  if (!seriesName) throw new Error("TV series name is required before episode processing");
  const episodes = [...mapping.episodes].sort((left, right) =>
    left.seasonNumber - right.seasonNumber || left.episodeNumber - right.episodeNumber);
  const first = episodes[0];
  if (!first || episodes.some((episode) => episode.seasonNumber !== first.seasonNumber)) {
    throw new Error(`Track ${mapping.trackId} must map to episodes from one season`);
  }
  const metadataSettings = settings.libraryMetadata;
  const year = recovery.importedMetadata?.year;
  const seriesFolder = renderLibraryTemplate(libraryTemplate(metadataSettings, "seriesFolderTemplate"), {
    "Series Name": seriesName,
    Year: typeof year === "string" || typeof year === "number" ? year : undefined
  });
  const seasonName = renderLibraryTemplate(libraryTemplate(metadataSettings, "seasonFolderTemplate"), {
    "Season Number": first.seasonNumber,
    Season: first.seasonNumber
  });
  const episodeNumbers = episodes.map((episode) => String(episode.episodeNumber).padStart(2, "0"));
  const title = episodes.map((episode) => episode.title?.trim()).find(Boolean);
  const baseName = renderLibraryTemplate(libraryTemplate(metadataSettings, "episodeFileTemplate"), {
    "Series Name": seriesName,
    Season: first.seasonNumber,
    Episode: episodeNumbers.length === 1 ? first.episodeNumber : episodeNumbers.join("-"),
    "Episode Title": title ?? ""
  });
  const seriesDir = join(outputPath(settings, "tv"), seriesFolder);
  const seasonDir = join(seriesDir, seasonName);
  return {
    baseName,
    seasonNumber: first.seasonNumber,
    seasonName,
    seasonDir,
    seriesDir,
    targetPath: join(seasonDir, `${baseName}.${settings.format}`)
  };
}
