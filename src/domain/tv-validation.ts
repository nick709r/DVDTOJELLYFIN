import type { MetadataCandidate } from "./metadata.js";
import type { MediaManifest } from "./media.js";
import type {
  TvDiscAnalysisReport,
  TvEpisodeFeedback,
  TvEpisodeMatchReport,
  TvProcessingPlan,
  TvSeasonMetadataCandidate,
  TvSeriesMetadataCandidate,
  TvEpisodeMetadataCandidate
} from "./television.js";

export const tvValidationFormat = "autodisc-tv-validation";
export const tvValidationSchemaVersion = 1;

export interface TvValidationEvidence {
  format: typeof tvValidationFormat;
  schemaVersion: typeof tvValidationSchemaVersion;
  id: string;
  capturedAt: string;
  origin: "captured" | "imported";
  buildId: string;
  policy: {
    policyVersion: number;
    highConfidence: number;
    mediumConfidence: number;
    minimumEpisodeRuntimeSeconds: number;
    maximumEpisodeRuntimeSeconds: number;
    structuralTitleCount: number;
    runtimeRatioMaximum: number;
    explicitLabelPattern: string;
    explicitLabelFlags: string;
    excludedTrackTitlePattern: string;
    excludedTrackTitleFlags: string;
    matcherMinimumConfidence: number;
    matcherMinimumMargin: number;
    multipartMetadataWeight: number;
    multipartRuntimeWeight: number;
    planAggregation: "minimum-required-evidence";
    scoringWeights: {
      series: Readonly<Record<string, number>>;
      season: Readonly<Record<string, number>>;
      discPosition: Readonly<Record<string, number>>;
      episode: Readonly<Record<string, number>>;
    };
  };
  source: {
    sourceId: string;
    providerId: string;
    mediaKind: string;
    label: string;
    fingerprint: string;
    fingerprintMethod: "label-manifest-sha256-v1";
    manifest: MediaManifest;
  };
  metadata: {
    rawCandidates: readonly MetadataCandidate[];
    seriesCandidates: readonly TvSeriesMetadataCandidate[];
    seasonCandidates: readonly TvSeasonMetadataCandidate[];
    episodeCandidates: readonly TvEpisodeMetadataCandidate[];
    providersWithFailures: readonly string[];
  };
  analysis: TvDiscAnalysisReport;
  matches: TvEpisodeMatchReport;
  plan: TvProcessingPlan;
  feedback: readonly TvEpisodeFeedback[];
}

export interface TvValidationDataset {
  format: typeof tvValidationFormat;
  schemaVersion: typeof tvValidationSchemaVersion;
  exportedAt: string;
  cases: readonly TvValidationEvidence[];
}

export interface TvValidationEvidenceRepository {
  save(evidence: TvValidationEvidence): void;
  saveMany(evidence: readonly TvValidationEvidence[]): void;
  get(id: string): TvValidationEvidence | undefined;
  list(limit?: number, offset?: number): TvValidationEvidence[];
}
