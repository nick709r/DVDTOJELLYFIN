import type { MetadataResolver } from "./metadata-resolver.js";
import { TvAnalysisEngine } from "./tv-analysis-engine.js";
import { TvEpisodeMatchingEngine } from "./tv-episode-matching-engine.js";
import { tvItemSignature } from "./tv-analysis-engine.js";
import type { MetadataCandidate } from "../domain/metadata.js";
import type { MediaManifestItem } from "../domain/media.js";
import type { TvValidationService } from "./tv-validation-service.js";
import type {
  TvAnalysisRecommendation,
  TvDiscAnalysisReport,
  TvEpisodeMatchReport,
  TvEpisodeMetadataCandidate,
  TvProcessingPlan,
  TvProcessingPlanInput,
  TvReviewRequirement,
  TvConfidenceBand,
  TvEpisodeFeedbackRepository,
  TvProcessingPlanRepository,
  TvSeasonMetadataCandidate,
  TvSeriesMetadataCandidate
} from "../domain/television.js";

const seriesLabelPattern = /\b(?:season|series|episodes?)\b|\bs\d{1,2}(?:[\s._-]*d\d{1,2})?\b/i;
const nonEpisodeTitlePattern = /\b(?:bonus|extra|featurette|behind the scenes|trailer|deleted scene|interview|making of|gallery|commentary)\b/i;

export const tvWorkflowPolicy = {
  highConfidence: 0.9,
  mediumConfidence: 0.72,
  episodeMinimumSeconds: 10 * 60,
  episodeMaximumSeconds: 100 * 60,
  structuralTitleCount: 3,
  runtimeRatioMaximum: 1.6,
  explicitLabelPattern: seriesLabelPattern.source,
  explicitLabelFlags: seriesLabelPattern.flags,
  excludedTrackTitlePattern: nonEpisodeTitlePattern.source,
  excludedTrackTitleFlags: nonEpisodeTitlePattern.flags
} as const;

function cleanSeriesQuery(label: string): string {
  return label.replace(/\b(?:season|series|disc|disk|volume|vol|episodes?|television|tv)\b/gi, " ")
    .replace(/\bs\d{1,2}(?:[\s._-]*d\d{1,2})?\b/gi, " ")
    .replace(/\bd\d{1,2}\b/gi, " ")
    .replace(/\b\d+\b/g, " ")
    .replace(/\s+/g, " ").trim();
}

export interface TvWorkflowSource {
  sourceId: string;
  providerId: string;
  mediaKind: string;
  label: string;
  manifest: {
    mediaKind: string;
    items: readonly MediaManifestItem[];
    identifiers?: Readonly<Record<string, string>>;
    attributes?: Readonly<Record<string, string | number | boolean | null>>;
  };
}

export interface TvWorkflowResult {
  analysis: TvDiscAnalysisReport;
  matches: TvEpisodeMatchReport;
  plan: TvProcessingPlan;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function seriesCandidate(candidate: MetadataCandidate): TvSeriesMetadataCandidate | undefined {
  if (candidate.entityType !== "series") return undefined;
  const id = stringValue(candidate.metadata.seriesId) ?? candidate.id;
  const year = numberValue(candidate.metadata.year);
  return {
    series: {
      id,
      title: stringValue(candidate.metadata.title) ?? candidate.title,
      ...(year === undefined ? {} : { year }),
      ...(candidate.identifiers === undefined ? {} : { identifiers: candidate.identifiers })
    },
    providerId: candidate.providerId,
    confidence: candidate.confidence,
    evidence: [`Series metadata returned by ${candidate.providerId}`]
  };
}

function seasonCandidate(candidate: MetadataCandidate): TvSeasonMetadataCandidate | undefined {
  if (candidate.entityType !== "season") return undefined;
  const number = numberValue(candidate.metadata.seasonNumber);
  const seriesId = stringValue(candidate.metadata.seriesId);
  const title = stringValue(candidate.metadata.title);
  if (number === undefined || seriesId === undefined || !Number.isInteger(number) || number < 0) return undefined;
  return {
    seriesId,
    season: {
      seriesId,
      number,
      ...(title === undefined ? {} : { title }),
      ...(candidate.metadata.isSpecials === true ? { isSpecials: true } : {})
    },
    providerId: candidate.providerId,
    confidence: candidate.confidence,
    evidence: [`Season metadata returned by ${candidate.providerId}`]
  };
}

function episodeCandidate(candidate: MetadataCandidate): TvEpisodeMetadataCandidate | undefined {
  if (candidate.entityType !== "episode") return undefined;
  const itemId = stringValue(candidate.metadata.itemId);
  const seriesId = stringValue(candidate.metadata.seriesId);
  const seasonNumber = numberValue(candidate.metadata.seasonNumber);
  const episodeNumber = numberValue(candidate.metadata.episodeNumber);
  if (!itemId || !seriesId || seasonNumber === undefined || episodeNumber === undefined ||
    !Number.isInteger(seasonNumber) || seasonNumber < 0 ||
    !Number.isInteger(episodeNumber) || episodeNumber < 0) return undefined;
  const runtimeSeconds = numberValue(candidate.metadata.runtimeSeconds);
  const partNumber = numberValue(candidate.metadata.partNumber);
  const partCount = numberValue(candidate.metadata.partCount);
  const title = stringValue(candidate.metadata.title);
  const releaseId = stringValue(candidate.metadata.releaseId);
  const multiPartGroupId = stringValue(candidate.metadata.multiPartGroupId);
  return {
    itemId,
    episode: {
      seriesId,
      seasonNumber,
      episodeNumber,
      ...(title === undefined ? {} : { title })
    },
    providerId: candidate.providerId,
    confidence: candidate.confidence,
    ...(runtimeSeconds === undefined ? {} : { runtimeSeconds }),
    ...(releaseId === undefined ? {} : { releaseId }),
    ...(multiPartGroupId === undefined ? {} : { multiPartGroupId }),
    ...(partNumber === undefined ? {} : { partNumber }),
    ...(partCount === undefined ? {} : { partCount }),
    evidence: [`Episode metadata returned by ${candidate.providerId}`]
  };
}

function parseDiscStructure(label: string): { seasonNumber?: number; discNumber?: number; discCount?: number } {
  const season = label.match(/\bseason[\s._-]*(\d+)\b/i) ?? label.match(/\bs(\d{1,2})(?:[\s._-]*d\d{1,2})?\b/i);
  const disc = label.match(/\bdisc[\s._-]*(\d+)\b/i) ?? label.match(/\bd(\d{1,2})\b/i);
  const count = label.match(/\b(?:of|\/)\s*(\d+)\s*discs?\b/i);
  return {
    ...(season?.[1] === undefined ? {} : { seasonNumber: Number(season[1]) }),
    ...(disc?.[1] === undefined ? {} : { discNumber: Number(disc[1]) }),
    ...(count?.[1] === undefined ? {} : { discCount: Number(count[1]) })
  };
}

function tvShapeIsPlausible(source: TvWorkflowSource): boolean {
  const titleItems = source.manifest.items.filter((item) =>
    item.kind === "title" && item.durationSeconds !== undefined &&
    item.durationSeconds >= tvWorkflowPolicy.episodeMinimumSeconds &&
    item.durationSeconds <= tvWorkflowPolicy.episodeMaximumSeconds &&
    !nonEpisodeTitlePattern.test(item.title ?? "")
  ).sort((left, right) => (left.durationSeconds ?? 0) - (right.durationSeconds ?? 0));
  const hasSeasonOrSeriesLabel = seriesLabelPattern.test(source.label);
  const shortestEpisodeRuntime = titleItems[0]?.durationSeconds ?? 0;
  const longestEpisodeRuntime = titleItems.at(-1)?.durationSeconds ?? 0;
  const hasEpisodeStructure = titleItems.length >= tvWorkflowPolicy.structuralTitleCount &&
    longestEpisodeRuntime / Math.max(1, shortestEpisodeRuntime) <= tvWorkflowPolicy.runtimeRatioMaximum &&
    !source.manifest.items.some((item) => item.kind === "title" &&
      item.durationSeconds !== undefined && item.durationSeconds > tvWorkflowPolicy.episodeMaximumSeconds);
  return hasSeasonOrSeriesLabel || hasEpisodeStructure;
}

function bandFor(confidence: number): TvConfidenceBand {
  if (confidence >= tvWorkflowPolicy.highConfidence) return "high";
  if (confidence >= tvWorkflowPolicy.mediumConfidence) return "medium";
  return "low";
}

function reviewFor(confidence: number, required: boolean): TvReviewRequirement {
  if (required || confidence < tvWorkflowPolicy.mediumConfidence) return "required";
  if (confidence < tvWorkflowPolicy.highConfidence) return "recommended";
  return "none";
}

function planInput(analysis: TvDiscAnalysisReport, matches: TvEpisodeMatchReport): TvProcessingPlanInput {
  const assignments = matches.items.map((item) => {
    const confidenceBand = bandFor(item.confidence);
    const classifiedNonEpisode = ["bonus", "commentary"].includes(item.decision);
    const analysisItem = analysis.items.find((candidate) => candidate.itemId === item.itemId);
    if (!analysisItem) throw new Error(`TV match report references unknown analysis item ${item.itemId}`);
    return {
      itemId: item.itemId,
      itemSignature: analysisItem.itemSignature,
      ...(item.itemTitle === undefined ? {} : { itemTitle: item.itemTitle }),
      decision: item.decision,
      episodes: item.suggestedEpisodes,
      confidence: item.confidence,
      confidenceBand,
      explanation: item.evidence,
      alternatives: item.alternatives,
      reviewRequirement: classifiedNonEpisode
        ? "none" as const
        : reviewFor(item.confidence, item.manualReviewRequired)
    };
  });
  const series = analysis.detectedSeries;
  const season = analysis.detectedSeason;
  const discPosition = analysis.discPositionCandidates[0];
  const relevantConfidence = [
    series?.confidence ?? 0,
    season?.confidence ?? 0,
    discPosition?.confidence ?? 0,
    ...assignments.filter((assignment) => !["bonus", "commentary"].includes(assignment.decision))
      .map((assignment) => assignment.confidence)
  ];
  const confidence = relevantConfidence.length ? Math.min(...relevantConfidence) : 0;
  const confidenceBand = bandFor(confidence);
  const reviewReasons = [
    ...(!series ? ["Series identity is unknown"] : series.confidence < tvWorkflowPolicy.highConfidence
      ? ["Series identity is below high confidence"] : []),
    ...(!season ? ["Season identity is unknown"] : season.confidence < tvWorkflowPolicy.highConfidence
      ? ["Season identity is below high confidence"] : []),
    ...(!discPosition ? ["Disc position is unknown"] : discPosition.confidence < tvWorkflowPolicy.highConfidence
      ? ["Disc position is below high confidence"] : []),
    ...matches.items.filter((item) => item.manualReviewRequired)
      .map((item) => `Track ${item.itemId} requires manual review`),
    ...assignments.filter((assignment) => assignment.reviewRequirement === "recommended")
      .map((assignment) => `Track ${assignment.itemId} has medium-confidence candidates`)
  ];
  const automaticProcessingSafe = reviewReasons.length === 0 &&
    assignments.every((assignment) =>
      ["suggested", "accepted", "manual-assignment", "bonus", "commentary"].includes(assignment.decision) &&
      assignment.confidenceBand === "high"
    ) &&
    analysis.probableDuplicates.length === 0 &&
    analysis.probableAlternates.length === 0;
  const reviewRequirement = reviewFor(confidence,
    reviewReasons.length > 0 || matches.items.some((item) => item.manualReviewRequired));
  const executionBlocker = "TV episode output processing is not implemented; no files will be ripped, converted, renamed, moved, or published.";
  return {
    sourceId: analysis.sourceId,
    manifestId: analysis.manifestId,
    fingerprint: analysis.fingerprint ?? analysis.manifestId,
    ...(series ? { series: series.series } : {}),
    seriesConfidence: series?.confidence ?? 0,
    ...(season ? { season: season.season } : {}),
    seasonConfidence: season?.confidence ?? 0,
    ...(discPosition ? { discPosition } : {}),
    assignments,
    confidence,
    confidenceBand,
    automaticProcessingSafe,
    reviewRequirement: automaticProcessingSafe ? "none" : reviewRequirement,
    reviewReasons,
    duplicateTracks: analysis.probableDuplicates,
    alternateTracks: analysis.probableAlternates,
    commentaryTracks: matches.items.filter((item) => item.decision === "commentary")
      .map((item) => analysis.items.find((sourceItem) => sourceItem.itemId === item.itemId))
      .filter((item): item is NonNullable<typeof item> => item !== undefined),
    bonusFeatures: matches.items.filter((item) => item.decision === "bonus")
      .map((item) => analysis.items.find((sourceItem) => sourceItem.itemId === item.itemId))
      .filter((item): item is NonNullable<typeof item> => item !== undefined),
    specialFeatures: matches.items.filter((item) => item.decision === "special-feature")
      .map((item) => analysis.items.find((sourceItem) => sourceItem.itemId === item.itemId))
      .filter((item): item is NonNullable<typeof item> => item !== undefined),
    approvalRequired: !automaticProcessingSafe,
    executionEnabled: false,
    executionBlocker
  };
}

export class TvWorkflowService {
  constructor(
    private readonly metadata: MetadataResolver,
    private readonly feedbackRepository: TvEpisodeFeedbackRepository,
    private readonly planRepository: TvProcessingPlanRepository,
    private readonly validationService?: TvValidationService,
    private readonly analysisEngine = new TvAnalysisEngine(),
    private readonly matchingEngine = new TvEpisodeMatchingEngine()
  ) {}

  async prepare(
    source: TvWorkflowSource,
    fingerprint: string,
    signal?: AbortSignal
  ): Promise<TvWorkflowResult | undefined> {
    if (!tvShapeIsPlausible(source)) return undefined;

    const seasonStructure = parseDiscStructure(source.label);
    const [seriesResult, seasonResult, episodeResult] = await Promise.all([
      this.metadata.resolve({
        entityType: "series",
        ...(cleanSeriesQuery(source.label) ? { query: cleanSeriesQuery(source.label) } : {}),
        attributes: { mediaKind: source.mediaKind, sourceId: source.sourceId }
      }, signal),
      seasonStructure.seasonNumber === undefined ? Promise.resolve(undefined) : this.metadata.resolve({
        entityType: "season",
        query: `${source.label} season ${seasonStructure.seasonNumber}`,
        attributes: {
          mediaKind: source.mediaKind,
          seasonNumber: seasonStructure.seasonNumber,
          sourceId: source.sourceId
        }
      }, signal),
      this.metadata.resolve({
        entityType: "episode",
        ...(source.label ? { query: source.label } : {}),
        attributes: {
          mediaKind: source.mediaKind,
          sourceId: source.sourceId,
          fingerprint,
          items: source.manifest.items
        }
      }, signal)
    ]);
    const seriesCandidates = seriesResult.candidates
      .map(seriesCandidate).filter((candidate): candidate is TvSeriesMetadataCandidate => candidate !== undefined);
    const seasonCandidates = (seasonResult?.candidates ?? [])
      .map(seasonCandidate).filter((candidate): candidate is TvSeasonMetadataCandidate => candidate !== undefined);
    const episodeCandidates = episodeResult.candidates
      .map(episodeCandidate).filter((candidate): candidate is TvEpisodeMetadataCandidate => candidate !== undefined);

    const analysis = this.analysisEngine.analyze({
      sourceId: source.sourceId,
      manifestId: source.manifest.identifiers?.manifestId ?? fingerprint,
      manifest: source.manifest,
      discLabel: source.label,
      fingerprint,
      disc: seasonStructure,
      metadata: { seriesCandidates, seasonCandidates, episodeCandidates }
    });
    const feedback = analysis.items.flatMap((item) =>
      this.feedbackRepository.findForItemSignature(item.itemSignature)
    );
    const matches = this.matchingEngine.match({
      analysis,
      episodeMetadata: episodeCandidates,
      feedback
    });
    const plan = this.planRepository.save(planInput(analysis, matches));
    const result = { analysis, matches, plan };
    this.validationService?.capture({
      sourceId: source.sourceId,
      providerId: source.providerId,
      mediaKind: source.mediaKind,
      label: source.label,
      manifest: source.manifest
    }, fingerprint, {
      rawCandidates: [
        ...seriesResult.candidates,
        ...(seasonResult?.candidates ?? []),
        ...episodeResult.candidates
      ],
      providersWithFailures: [
        ...seriesResult.providerFailures,
        ...(seasonResult?.providerFailures ?? []),
        ...episodeResult.providerFailures
      ].map((failure) => failure.providerId),
      seriesCandidates,
      seasonCandidates,
      episodeCandidates
    }, result);
    return result;
  }
}

export function isPotentialTvDisc(source: TvWorkflowSource): boolean {
  return tvShapeIsPlausible(source);
}

export function summarizeTvPlan(plan: TvProcessingPlan): string {
  const series = plan.series?.title ?? "unknown series";
  const season = plan.season ? `season ${plan.season.number}` : "unknown season";
  const suggestions = plan.assignments.filter((item) => item.episodes.length > 0).length;
  const processingDecision = plan.automaticProcessingSafe
    ? "episode mapping is high-confidence"
    : "manual review is required";
  return `TV analysis plan ${plan.id}: ${series}, ${season}; confidence ${plan.confidenceBand}; ${suggestions} suggested track assignments; ${processingDecision}; execution disabled`;
}

export function tvPlanRecommendations(
  analysis: TvDiscAnalysisReport,
  matches: TvEpisodeMatchReport
): readonly TvAnalysisRecommendation[] {
  return [...analysis.recommendations, ...matches.recommendations];
}
