import { lstat, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { DiscRecovery, EpisodeMapping } from "../domain/disc-recovery.js";
import type { TvEpisodePublication, TvEpisodePublicationRepository } from "../domain/tv-publication.js";
import type { CompletedTvDiscHistory } from "../domain/television.js";
import { normalizeDiscName } from "./tv-name-normalization.js";

export interface TvEpisodeConflict {
  trackId: string;
  seasonNumber: number;
  episodeNumber: number;
  existing: TvEpisodePublication;
  provenanceStatus: "verified" | "legacy" | "unknown";
}

export interface TvEpisodeConflictOptions {
  targetPath(mapping: EpisodeMapping): string;
  legacyHistory(seasonNumber: number): readonly CompletedTvDiscHistory[];
  jobOutputPath(jobId: string): string | null;
}

function filenameHasEpisode(filename: string, season: number, episode: number): boolean {
  const expression = /(?:^|[^a-z0-9])s0*(\d{1,3})e0*(\d{1,4})((?:(?:e|-e?)(?:0*\d{1,4}))*)(?!\d)/gi;
  for (const match of filename.matchAll(expression)) {
    if (Number(match[1]) !== season) continue;
    const episodes = [Number(match[2])];
    for (const part of (match[3] ?? "").matchAll(/(?:e|-e?)(\d{1,4})/gi)) episodes.push(Number(part[1]));
    if (episodes.includes(episode)) return true;
  }
  return false;
}

export async function findTvEpisodeConflicts(
  publications: Pick<TvEpisodePublicationRepository, "listForSeason">,
  recovery: Pick<DiscRecovery, "seriesName" | "metadataProvider" | "providerId">,
  mappings: readonly EpisodeMapping[],
  options?: TvEpisodeConflictOptions
): Promise<TvEpisodeConflict[]> {
  const seriesName = normalizeDiscName(recovery.seriesName ?? "").toLocaleLowerCase();
  if (!seriesName) return [];
  const seasons = new Map<number, TvEpisodePublication[]>();
  const exists = new Map<string, boolean>();
  const conflicts: TvEpisodeConflict[] = [];
  for (const mapping of mappings) {
    for (const episode of mapping.episodes) {
      if (!seasons.has(episode.seasonNumber)) {
        seasons.set(episode.seasonNumber, publications.listForSeason(episode.seasonNumber));
      }
      for (const existing of seasons.get(episode.seasonNumber) ?? []) {
        const comparableIds = Boolean(recovery.providerId && existing.providerId &&
          existing.metadataProvider === recovery.metadataProvider);
        const sameSeries = comparableIds
          ? existing.providerId === recovery.providerId
          : normalizeDiscName(existing.seriesName).toLocaleLowerCase() === seriesName;
        if (!sameSeries || existing.episodeNumber !== episode.episodeNumber) continue;
        if (!exists.has(existing.outputPath)) {
          try {
            const info = await lstat(existing.outputPath);
            if (!info.isFile() || info.isSymbolicLink()) {
              throw new Error(`Recorded episode output is not a regular file: ${existing.outputPath}`);
            }
            exists.set(existing.outputPath, true);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            exists.set(existing.outputPath, false);
          }
        }
        if (exists.get(existing.outputPath)) {
          conflicts.push({ trackId: mapping.trackId, seasonNumber: episode.seasonNumber,
            episodeNumber: episode.episodeNumber, existing, provenanceStatus: "verified" });
        }
      }
    }
  }
  if (options) {
    const directories = new Map<string, string[]>();
    const historyBySeason = new Map<number, readonly CompletedTvDiscHistory[]>();
    for (const mapping of mappings) {
      const target = options.targetPath(mapping);
      const directory = dirname(target);
      if (!directories.has(directory)) {
        const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        });
        directories.set(directory, entries.filter((entry) =>
          (entry.isFile() || entry.isSymbolicLink()) && /\.(?:mkv|mp4)$/i.test(entry.name))
          .map((entry) => join(directory, entry.name)));
      }
      for (const episode of mapping.episodes) {
        const paths = new Set([target, ...(directories.get(directory) ?? []).filter((path) =>
          filenameHasEpisode(basename(path), episode.seasonNumber, episode.episodeNumber))]);
        for (const outputPath of paths) {
          if (!exists.has(outputPath)) {
            try {
              const info = await lstat(outputPath);
              if (!info.isFile() || info.isSymbolicLink()) {
                throw new Error(`Episode output is not a regular file: ${outputPath}`);
              }
              exists.set(outputPath, true);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
              exists.set(outputPath, false);
            }
          }
          if (!exists.get(outputPath)) continue;
          if (conflicts.some((conflict) => conflict.trackId === mapping.trackId &&
            conflict.episodeNumber === episode.episodeNumber && conflict.seasonNumber === episode.seasonNumber &&
            conflict.existing.outputPath === outputPath)) continue;
          if (!historyBySeason.has(episode.seasonNumber)) {
            historyBySeason.set(episode.seasonNumber, options.legacyHistory(episode.seasonNumber));
          }
          const history = (historyBySeason.get(episode.seasonNumber) ?? []).filter((entry) => {
            const comparableIds = Boolean(recovery.providerId && entry.providerId &&
              recovery.metadataProvider === entry.metadataProvider);
            const sameSeries = comparableIds ? recovery.providerId === entry.providerId :
              normalizeDiscName(entry.seriesName).toLocaleLowerCase() === seriesName;
            return sameSeries && entry.mappings.length === 1 && entry.mappings[0]?.episodes.length === 1 &&
              entry.mappings[0]?.episodes[0]?.episodeNumber === episode.episodeNumber &&
              options.jobOutputPath(entry.jobId) === outputPath;
          });
          const legacy = history.length === 1 ? history[0] : undefined;
          conflicts.push({
            trackId: mapping.trackId, seasonNumber: episode.seasonNumber, episodeNumber: episode.episodeNumber,
            provenanceStatus: legacy ? "legacy" : "unknown",
            existing: {
              outputPath,
              fingerprint: legacy?.fingerprint ?? "",
              discLabel: "",
              discNumber: legacy?.discNumber ?? null,
              trackId: legacy?.mappings[0]?.trackId ?? "",
              trackTitle: "",
              seriesName: legacy?.seriesName ?? recovery.seriesName ?? "",
              metadataProvider: legacy?.metadataProvider ?? recovery.metadataProvider,
              providerId: legacy?.providerId ?? null,
              seasonNumber: episode.seasonNumber,
              episodeNumber: episode.episodeNumber,
              confirmedAt: null,
              publishedAt: legacy?.completedAt ?? ""
            }
          });
        }
      }
    }
  }
  return conflicts;
}
