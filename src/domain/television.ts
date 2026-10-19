import type { MediaManifest } from "./media.js";

export interface Series {
  id?: string;
  title: string;
  year?: number;
  identifiers?: Readonly<Record<string, string>>;
}

export interface Season {
  seriesId: string;
  number: number;
  title?: string;
  isSpecials?: boolean;
}

export interface Episode {
  seriesId: string;
  seasonNumber: number;
  episodeNumber: number;
  title?: string;
  identifiers?: Readonly<Record<string, string>>;
}

export interface DiscAnalysis {
  sourceId: string;
  manifestId: string;
  items: readonly DiscItemAnalysis[];
  seasonNumber?: number;
  discNumber?: number;
  discCount?: number;
  releaseId?: string;
}

export interface DiscAnalysisStructure {
  seasonNumber?: number;
  discNumber?: number;
  discCount?: number;
  releaseId?: string;
}

export interface DiscItemAnalysis {
  itemId: string;
  kind: "episode-candidate" | "bonus" | "commentary" | "unknown";
  durationSeconds?: number;
  title?: string;
  trackLanguage?: string;
  releaseId?: string;
  attributes?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface TvSeriesMetadataCandidate {
  series: Series;
  providerId: string;
  confidence: ConfidenceScore;
  evidence?: readonly string[];
}

export interface TvSeasonMetadataCandidate {
  seriesId: string;
  season: Season;
  providerId: string;
  confidence: ConfidenceScore;
  evidence?: readonly string[];
}

export interface TvEpisodeMetadataCandidate {
  itemId: string;
  episode: Episode;
  providerId: string;
  confidence: ConfidenceScore;
  runtimeSeconds?: number;
  releaseId?: string;
  evidence?: readonly string[];
}

export interface TvMetadataEvidence {
  seriesCandidates: readonly TvSeriesMetadataCandidate[];
  seasonCandidates: readonly TvSeasonMetadataCandidate[];
  episodeCandidates: readonly TvEpisodeMetadataCandidate[];
}

export interface HistoricalEpisodeEvidence {
  itemSignature: string;
  episode: Episode;
  confidence: ConfidenceScore;
}

export interface HistoricalDiscAnalysis {
  fingerprint: string;
  series: Series;
  seasonNumber?: number;
  discNumber?: number;
  discCount?: number;
  episodeMatches: readonly HistoricalEpisodeEvidence[];
}

export interface EpisodeCorrection {
  fingerprint: string;
  itemSignature: string;
  episode: Episode;
  reason?: string;
}

export interface TvAnalysisInput {
  sourceId: string;
  manifestId: string;
  manifest: MediaManifest;
  discLabel?: string;
  fingerprint?: string;
  disc?: DiscAnalysisStructure;
  metadata: TvMetadataEvidence;
  history?: readonly HistoricalDiscAnalysis[];
  corrections?: readonly EpisodeCorrection[];
}

export interface ConfidenceComponents {
  metadata?: number;
  titleSimilarity?: number;
  runtimeSimilarity?: number;
  historicalMatch?: number;
  userCorrection?: number;
  discStructure?: number;
}

export interface EpisodeCandidate {
  episode: Episode;
  confidence: number;
  evidence: readonly string[];
  scoreComponents?: ConfidenceComponents;
  releaseId?: string;
  matchedItemId?: string;
  duplicateOf?: string;
  matchKind?: "standard" | "special" | "bonus" | "commentary" | "alternative-release" | "duplicate";
}

export interface EpisodeMatch {
  itemId: string;
  candidates: readonly EpisodeCandidate[];
  selected?: Episode;
  manuallyCorrected?: boolean;
  correctionReason?: string;
}

export type ConfidenceScore = number;

export interface TvSeriesMatchCandidate {
  series: Series;
  confidence: ConfidenceScore;
  evidence: readonly string[];
  scoreComponents: ConfidenceComponents;
}

export interface TvSeasonMatchCandidate {
  seriesId: string;
  season: Season;
  confidence: ConfidenceScore;
  evidence: readonly string[];
  scoreComponents: ConfidenceComponents;
}

export interface TvDiscPositionCandidate {
  discNumber: number;
  discCount?: number;
  confidence: ConfidenceScore;
  evidence: readonly string[];
  scoreComponents: ConfidenceComponents;
}

export type TvDiscItemKind =
  | "episode-candidate"
  | "duplicate"
  | "alternate"
  | "bonus"
  | "commentary"
  | "special-feature"
  | "unknown";

export interface TvDiscItemResult {
  itemId: string;
  title?: string;
  kind: TvDiscItemKind;
  confidence: ConfidenceScore;
  evidence: readonly string[];
  candidates: readonly EpisodeCandidate[];
  relatedItemId?: string;
}

export interface TvDiscRelationship {
  itemId: string;
  relatedItemId: string;
  confidence: ConfidenceScore;
  evidence: readonly string[];
}

export type TvRecommendedAction =
  | "confirm-series"
  | "confirm-season"
  | "confirm-disc-position"
  | "review-episode-candidates"
  | "review-duplicates"
  | "review-alternates"
  | "review-bonus-content"
  | "review-special-features";

export interface TvAnalysisRecommendation {
  action: TvRecommendedAction;
  message: string;
  relatedItemIds?: readonly string[];
}

export interface TvDiscAnalysisReport {
  sourceId: string;
  manifestId: string;
  fingerprint?: string;
  detectedSeries?: TvSeriesMatchCandidate;
  seriesCandidates: readonly TvSeriesMatchCandidate[];
  detectedSeason?: TvSeasonMatchCandidate;
  seasonCandidates: readonly TvSeasonMatchCandidate[];
  disc: DiscAnalysisStructure;
  discPositionCandidates: readonly TvDiscPositionCandidate[];
  items: readonly TvDiscItemResult[];
  probableEpisodes: readonly EpisodeCandidate[];
  probableDuplicates: readonly TvDiscRelationship[];
  probableAlternates: readonly TvDiscRelationship[];
  probableBonusContent: readonly TvDiscItemResult[];
  commentaryTracks: readonly TvDiscItemResult[];
  specialFeatures: readonly TvDiscItemResult[];
  recommendations: readonly TvAnalysisRecommendation[];
}
