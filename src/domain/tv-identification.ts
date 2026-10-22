export type TvIdentificationStepId =
  | "user-specified"
  | "fingerprint-mapping"
  | "volume-label"
  | "filesystem-volume-name"
  | "makemkv-disc-name"
  | "dvd-metadata"
  | "tvdb-search"
  | "tmdb-search"
  | "runtime-structure"
  | "episode-count";

export type TvIdentificationStepStatus = "matched" | "no-match" | "skipped" | "failed" | "informational";

export interface TvIdentificationStep {
  order: number;
  id: TvIdentificationStepId;
  name: string;
  status: TvIdentificationStepStatus;
  detail: string;
}

export interface TvIdentificationNameSource {
  stepId: TvIdentificationStepId;
  name: string;
  raw: string | null;
  normalized: string;
  variants: readonly string[];
}

export interface TvIdentificationQuery {
  query: string;
  nameSource: string;
  providerId: string;
  matches: number;
  durationMs: number;
  failure?: string;
}

export interface TvIdentificationSelection {
  title: string;
  year?: number;
  seriesId: string;
  providerId: string;
  origin: string;
  seasonNumber?: number;
  discNumber?: number;
}

export interface TvIdentificationDiagnostics {
  fingerprint: string;
  volumeLabel: string | null;
  filesystemVolumeName: string | null;
  makemkvDiscName: string | null;
  dvdMetadataName: string | null;
  steps: readonly TvIdentificationStep[];
  nameSources: readonly TvIdentificationNameSource[];
  queries: readonly TvIdentificationQuery[];
  providersQueried: readonly string[];
  providerMatches: Readonly<Record<string, number>>;
  failures: readonly { providerId: string; query: string; message: string }[];
  seriesCandidates: readonly { title: string; year?: number; providerId: string; seriesId: string; confidence: number }[];
  seasonCandidates: readonly { seasonNumber: number; providerId: string; confidence: number }[];
  selected: TvIdentificationSelection | null;
  episodeTitleCount: number;
  recordedAt: string;
}

export interface TvSavedIdentification {
  seriesName: string;
  seriesId: string | null;
  provider: string;
  seasonNumber: number | null;
  discNumber: number | null;
  discName: string | null;
  origin: "user" | "fingerprint";
  year?: number;
}

export interface TvSeriesSearchProviderResult {
  providerId: string;
  query: string;
  durationMs: number;
  candidates: readonly TvSeriesSearchCandidate[];
  failure?: string;
}

export interface TvSeriesSearchCandidate {
  provider: string;
  providerName: string;
  seriesId: string;
  title: string;
  year?: number;
  overview?: string;
  posterUrl?: string;
  seasonCount?: number;
  confidence: number;
  identifiers: Readonly<Record<string, string>>;
}

export type TvSeriesSearchFunction = (
  query: string,
  signal?: AbortSignal
) => Promise<readonly TvSeriesSearchProviderResult[]>;

export type TvSeasonEpisodeCountFunction = (
  series: { providerId: string; seriesId: string },
  signal?: AbortSignal
) => Promise<ReadonlyMap<number, number>>;
