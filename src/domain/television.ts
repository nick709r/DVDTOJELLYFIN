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

export interface DiscItemAnalysis {
  itemId: string;
  kind: "episode-candidate" | "bonus" | "commentary" | "unknown";
  durationSeconds?: number;
  trackLanguage?: string;
  releaseId?: string;
  attributes?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface EpisodeCandidate {
  episode: Episode;
  confidence: number;
  evidence: readonly string[];
  releaseId?: string;
  matchedItemId?: string;
  duplicateOf?: string;
  matchKind?: "standard" | "special" | "bonus" | "commentary" | "alternative-release";
}

export interface EpisodeMatch {
  itemId: string;
  candidates: readonly EpisodeCandidate[];
  selected?: Episode;
  manuallyCorrected?: boolean;
  correctionReason?: string;
}

export type ConfidenceScore = number;
