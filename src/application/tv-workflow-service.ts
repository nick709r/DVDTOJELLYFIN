import type { MetadataResolver } from "./metadata-resolver.js";
import { TvAnalysisEngine } from "./tv-analysis-engine.js";
import { TvEpisodeMatchingEngine } from "./tv-episode-matching-engine.js";
import { tvItemSignature } from "./tv-analysis-engine.js";
import type { MetadataCandidate, MetadataResult } from "../domain/metadata.js";
import type { MediaManifestItem } from "../domain/media.js";
import type { TvValidationService } from "./tv-validation-service.js";
import { normalizeDiscName, parseDiscStructureHints, searchVariants } from "./tv-name-normalization.js";
import type {
  TvIdentificationDiagnostics,
  TvIdentificationNameSource,
  TvIdentificationQuery,
  TvIdentificationStep,
  TvIdentificationStepId,
  TvSavedIdentification,
  TvSeasonEpisodeCountFunction,
  TvSeriesSearchFunction
} from "../domain/tv-identification.js";
import type {
  TvAnalysisRecommendation,
  CompletedTvDiscHistory,
  HistoricalEpisodeEvidence,
  TvDiscAnalysisReport,
  TvEpisodeMatchReport,
  TvEpisodeMetadataCandidate,
  TvProcessingPlan,
  HistoricalDiscAnalysis,
  TvProcessingPlanInput,
  TvReviewRequirement,
  TvConfidenceBand,
  TvEpisodeFeedbackRepository,
  TvProcessingPlanRepository,
  TvSeasonMetadataCandidate,
  TvSeriesMetadataCandidate,
  TvProviderDiscEpisode
} from "../domain/television.js";

const seriesLabelPattern = /\b(?:season|series|episodes?)\b|\bseason[\s._-]*\d+|\bs\d{1,2}(?:[\s._-]*d\d{1,2})?\b/i;
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
  metadataLookups: readonly {
    entityType: string;
    durationMs: number;
    candidates: readonly MetadataCandidate[];
    failures: readonly { providerId: string; message: string }[];
  }[];
  identification: TvIdentificationDiagnostics;
}

interface TimedMetadataResult {
  result: MetadataResult;
  durationMs: number;
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

function providerDiscEpisode(candidate: MetadataCandidate): TvProviderDiscEpisode | undefined {
  if (candidate.entityType !== "episode-disc") return undefined;
  const seriesId = stringValue(candidate.metadata.seriesId);
  const seasonNumber = numberValue(candidate.metadata.seasonNumber);
  const episodeNumber = numberValue(candidate.metadata.episodeNumber);
  const discNumber = numberValue(candidate.metadata.discNumber);
  const discOrder = numberValue(candidate.metadata.discOrder);
  if (!seriesId || seasonNumber === undefined || episodeNumber === undefined ||
    discNumber === undefined || discOrder === undefined) return undefined;
  const title = stringValue(candidate.metadata.title);
  return {
    episode: {
      seriesId,
      seasonNumber,
      episodeNumber,
      ...(title === undefined ? {} : { title })
    },
    providerId: candidate.providerId,
    discNumber,
    discOrder,
    confidence: candidate.confidence,
    evidence: [`DVD episode order supplied by ${candidate.providerId}`]
  };
}

function parseDiscStructure(label: string): { seasonNumber?: number; discNumber?: number; discCount?: number } {
  return parseDiscStructureHints(label);
}

function episodeLengthTitleCount(source: TvWorkflowSource): number {
  return source.manifest.items.filter((item) =>
    item.kind === "title" && item.durationSeconds !== undefined &&
    item.durationSeconds >= tvWorkflowPolicy.episodeMinimumSeconds &&
    item.durationSeconds <= tvWorkflowPolicy.episodeMaximumSeconds &&
    !nonEpisodeTitlePattern.test(item.title ?? "")
  ).length;
}

export interface TvWorkflowDependencies {
  /** Searches every configured metadata provider independently for a series title. */
  seriesSearch?: TvSeriesSearchFunction;
  /** Returns episode counts per season for a known series. */
  seasonEpisodeCounts?: TvSeasonEpisodeCountFunction;
  completedDiscHistory?: {
    listForSeason(seasonNumber: number, limit?: number): CompletedTvDiscHistory[];
  };
}

interface ProviderSearchOutcome {
  providerId: string;
  candidates: MetadataCandidate[];
  durationMs: number;
  failure?: string;
}

export interface TvPrefilterCriterion {
  id: string;
  passed: boolean;
  explanation: string;
}

export interface TvPrefilterAssessment {
  classification: "tv" | "review" | "movie";
  confidence: number;
  criteria: readonly TvPrefilterCriterion[];
  reasons: readonly string[];
}

export function assessTvDisc(source: TvWorkflowSource): TvPrefilterAssessment {
  const titleItems = source.manifest.items.filter((item) =>
    item.kind === "title" && item.durationSeconds !== undefined &&
    item.durationSeconds >= tvWorkflowPolicy.episodeMinimumSeconds &&
    item.durationSeconds <= tvWorkflowPolicy.episodeMaximumSeconds &&
    !nonEpisodeTitlePattern.test(item.title ?? "")
  ).sort((left, right) => (left.durationSeconds ?? 0) - (right.durationSeconds ?? 0));
  const hasSeasonOrSeriesLabel = seriesLabelPattern.test(source.label);
  const shortestEpisodeRuntime = titleItems[0]?.durationSeconds ?? 0;
  const longestEpisodeRuntime = titleItems.at(-1)?.durationSeconds ?? 0;
  const hasTwoEpisodeTitles = titleItems.length >= 2;
  const hasThreeEpisodeTitles = titleItems.length >= tvWorkflowPolicy.structuralTitleCount;
  const runtimesAreConsistent = hasTwoEpisodeTitles &&
    longestEpisodeRuntime / Math.max(1, shortestEpisodeRuntime) <= tvWorkflowPolicy.runtimeRatioMaximum;
  const hasFeatureLengthTitle = source.manifest.items.some((item) => item.kind === "title" &&
    item.durationSeconds !== undefined && item.durationSeconds > tvWorkflowPolicy.episodeMaximumSeconds);
  const noFeatureLengthTitle = !hasFeatureLengthTitle;
  const criteria: TvPrefilterCriterion[] = [
    {
      id: "explicit-series-label",
      passed: hasSeasonOrSeriesLabel,
      explanation: hasSeasonOrSeriesLabel
        ? "Disc label contains a season, series, or episode marker"
        : `Disc label "${source.label || "(empty)"}" contains no season, series, or episode marker`
    },
    {
      id: "two-episode-length-titles",
      passed: hasTwoEpisodeTitles,
      explanation: `${titleItems.length} title${titleItems.length === 1 ? "" : "s"} fall within the configured episode runtime range`
    },
    {
      id: "three-episode-length-titles",
      passed: hasThreeEpisodeTitles,
      explanation: hasThreeEpisodeTitles
        ? `At least ${tvWorkflowPolicy.structuralTitleCount} episode-length titles were found`
        : `Fewer than ${tvWorkflowPolicy.structuralTitleCount} episode-length titles were found`
    },
    {
      id: "consistent-episode-runtimes",
      passed: runtimesAreConsistent,
      explanation: runtimesAreConsistent
        ? `Episode-length title runtime ratio is within ${tvWorkflowPolicy.runtimeRatioMaximum}`
        : hasTwoEpisodeTitles
          ? `Episode-length title runtime ratio exceeds ${tvWorkflowPolicy.runtimeRatioMaximum}`
          : "Not enough episode-length titles to compare runtimes"
    },
    {
      id: "no-feature-length-title",
      passed: noFeatureLengthTitle,
      explanation: noFeatureLengthTitle
        ? "No title exceeds the configured maximum episode runtime"
        : "At least one title exceeds the configured maximum episode runtime"
    }
  ];

  const weights = [0.55, 0.2, 0.1, 0.1, 0.05];
  const confidence = Number(criteria.reduce(
    (score, criterion, index) => score + (criterion.passed ? weights[index] ?? 0 : 0),
    0
  ).toFixed(2));
  const confirmedTv = hasSeasonOrSeriesLabel ||
    (hasThreeEpisodeTitles && runtimesAreConsistent && noFeatureLengthTitle);
  const uncertainTv = !confirmedTv && hasTwoEpisodeTitles;
  const classification = confirmedTv ? "tv" : uncertainTv ? "review" : "movie";
  const reasons = criteria.filter((criterion) => !criterion.passed).map((criterion) => criterion.explanation);
  return { classification, confidence, criteria, reasons };
}

export function tvPrefilterRejectionReasons(source: TvWorkflowSource): string[] {
  return assessTvDisc(source).reasons.slice();
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
      ...(item.assignmentMethod === undefined ? {} : { assignmentMethod: item.assignmentMethod }),
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
  const confidence = Math.max(
    relevantConfidence.length ? Math.min(...relevantConfidence) : 0,
    ...assignments.filter((assignment) => assignment.assignmentMethod === "provider-disc-mapping")
      .map((assignment) => assignment.confidence)
  );
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
  const executionBlocker = "Automatic execution is disabled for unverified TV matches; explicit manual recovery mappings can be published.";
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
    private readonly matchingEngine = new TvEpisodeMatchingEngine(),
    private readonly identification: TvWorkflowDependencies = {}
  ) {}

  private async searchProviders(
    query: string,
    source: TvWorkflowSource,
    signal?: AbortSignal
  ): Promise<ProviderSearchOutcome[]> {
    if (this.identification.seriesSearch) {
      const results = await this.identification.seriesSearch(query, signal);
      const outcomes = results.map((entry) => ({
        providerId: entry.providerId,
        durationMs: entry.durationMs,
        ...(entry.failure ? { failure: entry.failure } : {}),
        candidates: entry.candidates.map((item): MetadataCandidate => ({
          id: item.seriesId,
          providerId: item.provider,
          entityType: "series",
          title: item.title,
          confidence: item.confidence,
          metadata: {
            seriesId: item.seriesId,
            title: item.title,
            year: item.year ?? null,
            overview: item.overview ?? null,
            numberOfSeasons: item.seasonCount ?? null,
            artwork: item.posterUrl ? [{ kind: "poster", url: item.posterUrl }] : []
          },
          identifiers: item.identifiers
        }))
      }));
      return outcomes.length ? outcomes : [{ providerId: "configured", durationMs: 0, candidates: [] }];
    }
    const startedAt = Date.now();
    const resolved = await this.metadata.resolve({
      entityType: "series",
      query,
      attributes: { mediaKind: source.mediaKind, sourceId: source.sourceId }
    }, signal);
    const durationMs = Date.now() - startedAt;
    const outcomes = new Map<string, ProviderSearchOutcome>();
    for (const candidate of resolved.candidates) {
      const entry = outcomes.get(candidate.providerId) ?? { providerId: candidate.providerId, candidates: [], durationMs };
      entry.candidates.push(candidate);
      outcomes.set(candidate.providerId, entry);
    }
    for (const failure of resolved.providerFailures) {
      const entry = outcomes.get(failure.providerId) ?? { providerId: failure.providerId, candidates: [], durationMs };
      entry.failure = failure.message;
      outcomes.set(failure.providerId, entry);
    }
    if (outcomes.size === 0) outcomes.set("configured", { providerId: "configured", candidates: [], durationMs });
    return [...outcomes.values()];
  }

  async prepare(
    source: TvWorkflowSource,
    fingerprint: string,
    signal?: AbortSignal,
    saved?: TvSavedIdentification
  ): Promise<TvWorkflowResult | undefined> {
    if (assessTvDisc(source).classification === "movie") return undefined;

    const attributes = source.manifest.attributes ?? {};
    const attribute = (key: string): string | null => {
      const value = attributes[key];
      return typeof value === "string" && value.trim() ? value.trim() : null;
    };
    const filesystemVolumeName = attribute("filesystemVolumeName");
    const makemkvDiscName = attribute("makemkvDiscName");
    const dvdMetadataName = attribute("dvdVolumeName") ?? attribute("dvdTitle");
    const rawNames: Array<{ stepId: TvIdentificationStepId; name: string; raw: string | null }> = [
      { stepId: "volume-label", name: "Optical disc volume label", raw: source.label.trim() || null },
      { stepId: "filesystem-volume-name", name: "Filesystem volume name", raw: filesystemVolumeName },
      { stepId: "makemkv-disc-name", name: "MakeMKV disc name", raw: makemkvDiscName },
      { stepId: "dvd-metadata", name: "DVD metadata", raw: dvdMetadataName }
    ];
    const nameSources: TvIdentificationNameSource[] = rawNames.map((entry) => ({
      stepId: entry.stepId,
      name: entry.name,
      raw: entry.raw,
      normalized: normalizeDiscName(entry.raw),
      variants: searchVariants(entry.raw),
      structure: parseDiscStructure(entry.raw ?? "")
    }));
    const discStructureHints = nameSources.flatMap((entry) => {
      const { seasonNumber, discNumber, discCount } = entry.structure;
      if (seasonNumber === undefined && discNumber === undefined) return [];
      const confidence = entry.stepId === "volume-label" ? 0.98
        : entry.stepId === "filesystem-volume-name" ? 0.92
          : entry.stepId === "makemkv-disc-name" ? 0.9 : 0.85;
      return [{
        source: entry.name,
        confidence,
        ...(seasonNumber === undefined ? {} : { seasonNumber }),
        ...(discNumber === undefined ? {} : { discNumber }),
        ...(discCount === undefined ? {} : { discCount })
      }];
    });

    // Season, disc and disc-count hints come from the saved identification first, then any disc name.
    const hints = nameSources.map((entry) => entry.structure);
    const firstHint = <K extends "seasonNumber" | "discNumber" | "discCount">(key: K): number | undefined =>
      hints.map((hint) => hint[key]).find((value) => value !== undefined);
    const seasonStructure: { seasonNumber?: number; discNumber?: number; discCount?: number } = {
      ...(saved?.seasonNumber != null ? { seasonNumber: saved.seasonNumber }
        : firstHint("seasonNumber") === undefined ? {} : { seasonNumber: firstHint("seasonNumber")! }),
      ...(saved?.discNumber != null ? { discNumber: saved.discNumber }
        : firstHint("discNumber") === undefined ? {} : { discNumber: firstHint("discNumber")! }),
      ...(firstHint("discCount") === undefined ? {} : { discCount: firstHint("discCount")! })
    };

    const queries: TvIdentificationQuery[] = [];
    const failures: Array<{ providerId: string; query: string; message: string }> = [];
    const providerMatches: Record<string, number> = {};
    const providersQueried = new Set<string>();
    let seriesDurationMs = 0;
    let seriesCandidatesRaw: MetadataCandidate[] = [];
    const seriesFailures: Array<{ providerId: string; message: string }> = [];
    let winningStep: TvIdentificationStepId | undefined;
    const triedQueries = new Set<string>();

    if (!saved) {
      search: for (const nameSource of nameSources) {
        for (const variant of nameSource.variants) {
          const key = variant.toLocaleLowerCase();
          if (triedQueries.has(key)) continue;
          triedQueries.add(key);
          signal?.throwIfAborted();
          let outcomes: ProviderSearchOutcome[];
          try {
            outcomes = await this.searchProviders(variant, source, signal);
          } catch (error) {
            if (signal?.aborted) throw error;
            const message = error instanceof Error ? error.message : "Metadata search failed";
            outcomes = [{ providerId: "configured", candidates: [], durationMs: 0, failure: message }];
          }
          const found: MetadataCandidate[] = [];
          for (const outcome of outcomes) {
            providersQueried.add(outcome.providerId);
            seriesDurationMs += outcome.durationMs;
            providerMatches[outcome.providerId] = (providerMatches[outcome.providerId] ?? 0) + outcome.candidates.length;
            queries.push({
              query: variant,
              nameSource: nameSource.name,
              providerId: outcome.providerId,
              matches: outcome.candidates.length,
              durationMs: outcome.durationMs,
              ...(outcome.failure ? { failure: outcome.failure } : {})
            });
            if (outcome.failure) {
              failures.push({ providerId: outcome.providerId, query: variant, message: outcome.failure });
              seriesFailures.push({ providerId: outcome.providerId, message: outcome.failure });
            }
            found.push(...outcome.candidates);
          }
          if (found.length > 0) {
            seriesCandidatesRaw = found;
            winningStep = nameSource.stepId;
            break search;
          }
        }
      }
    }

    const savedCandidate: MetadataCandidate | undefined = saved ? {
      id: saved.seriesId ?? `saved:${saved.seriesName.toLocaleLowerCase()}`,
      providerId: saved.provider,
      entityType: "series",
      title: saved.seriesName,
      confidence: 1,
      metadata: {
        seriesId: saved.seriesId ?? `saved:${saved.seriesName.toLocaleLowerCase()}`,
        title: saved.seriesName,
        year: saved.year ?? null
      },
      identifiers: { [saved.provider]: saved.seriesId ?? saved.seriesName }
    } : undefined;
    if (savedCandidate) seriesCandidatesRaw = [savedCandidate];

    const bestRaw = [...seriesCandidatesRaw].sort((left, right) => right.confidence - left.confidence)[0];
    const selectedName = saved?.seriesName ?? bestRaw?.title ??
      nameSources.find((entry) => entry.normalized)?.normalized ?? source.label.trim();
    const completedDiscHistory = seasonStructure.seasonNumber !== undefined &&
      Number.isInteger(seasonStructure.seasonNumber) &&
      seasonStructure.seasonNumber >= 0 && seasonStructure.seasonNumber <= 100
      ? this.identification.completedDiscHistory?.listForSeason(seasonStructure.seasonNumber) ?? []
      : [];
    const timedResolve = async (
      entityType: string,
      input: Parameters<MetadataResolver["resolve"]>[0]
    ): Promise<TimedMetadataResult> => {
      const startedAt = Date.now();
      const result = await this.metadata.resolve(input, signal);
      return { result, durationMs: Date.now() - startedAt };
    };
    const [seasonLookup, episodeLookup, discEpisodeLookup] = await Promise.all([
      seasonStructure.seasonNumber === undefined ? Promise.resolve(undefined) : timedResolve("season", {
        entityType: "season",
        query: `${selectedName} season ${seasonStructure.seasonNumber}`,
        attributes: {
          mediaKind: source.mediaKind,
          seasonNumber: seasonStructure.seasonNumber,
          sourceId: source.sourceId
        }
      }),
      timedResolve("episode", {
        entityType: "episode",
        ...(selectedName ? { query: selectedName } : {}),
        attributes: {
          mediaKind: source.mediaKind,
          sourceId: source.sourceId,
          fingerprint,
          ...(seasonStructure.seasonNumber === undefined ? {} : { seasonNumber: seasonStructure.seasonNumber }),
          items: source.manifest.items
        }
      }),
      seasonStructure.seasonNumber === undefined || seasonStructure.discNumber === undefined
        ? Promise.resolve(undefined)
        : timedResolve("episode-disc", {
          entityType: "episode-disc",
          query: selectedName,
          attributes: {
            mediaKind: source.mediaKind,
            sourceId: source.sourceId,
            seasonNumber: seasonStructure.seasonNumber,
            discNumber: seasonStructure.discNumber
          }
        })
    ]);
    const seriesResult: MetadataResult = {
      candidates: seriesCandidatesRaw,
      providerFailures: seriesFailures
    };
    const seriesLookup: TimedMetadataResult = { result: seriesResult, durationMs: seriesDurationMs };
    const seasonResult = seasonLookup?.result;
    const episodeResult = episodeLookup.result;
    const seriesCandidates = seriesResult.candidates
      .map(seriesCandidate).filter((candidate): candidate is TvSeriesMetadataCandidate => candidate !== undefined);
    const seasonCandidates = (seasonResult?.candidates ?? [])
      .map(seasonCandidate).filter((candidate): candidate is TvSeasonMetadataCandidate => candidate !== undefined);
    const episodeCandidates = episodeResult.candidates
      .map(episodeCandidate).filter((candidate): candidate is TvEpisodeMetadataCandidate => candidate !== undefined);
    const providerDiscEpisodes = (discEpisodeLookup?.result.candidates ?? [])
      .map(providerDiscEpisode).filter((candidate): candidate is TvProviderDiscEpisode => candidate !== undefined);

    // Episode-count matching is weak evidence, so it only runs when no season was otherwise found.
    const episodeTitleCount = episodeLengthTitleCount(source);
    let episodeCountDetail = "Skipped: season already known or no series candidate";
    const topSeries = seriesCandidates.slice().sort((left, right) => right.confidence - left.confidence)[0];
    if (seasonStructure.seasonNumber === undefined && seasonCandidates.length === 0 && topSeries &&
      this.identification.seasonEpisodeCounts && episodeTitleCount > 0) {
      try {
        const counts = await this.identification.seasonEpisodeCounts(
          { providerId: topSeries.providerId, seriesId: topSeries.series.id ?? topSeries.series.title }, signal);
        const matching = [...counts.entries()].filter(([, count]) => count === episodeTitleCount).map(([season]) => season);
        episodeCountDetail = matching.length
          ? `${episodeTitleCount} episode-length titles equals the episode count of season ${matching.join(", ")}`
          : `No season of ${topSeries.series.title} has exactly ${episodeTitleCount} episodes`;
        for (const season of matching) {
          seasonCandidates.push({
            seriesId: topSeries.series.id ?? topSeries.series.title,
            season: { seriesId: topSeries.series.id ?? topSeries.series.title, number: season },
            providerId: "episode-count-match",
            confidence: matching.length === 1 ? 0.6 : 0.45,
            evidence: [`Season ${season} has ${episodeTitleCount} episodes, matching the episode-length titles on this disc`]
          });
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        episodeCountDetail = `Episode-count lookup failed: ${error instanceof Error ? error.message : "unknown error"}`;
      }
    }

    const currentItems = new Map(source.manifest.items.map((item) => [item.id, item]));
    const history: HistoricalDiscAnalysis[] = [
      ...(saved ? [{
        fingerprint,
        series: {
          id: saved.seriesId ?? `saved:${saved.seriesName.toLocaleLowerCase()}`,
          title: saved.seriesName,
          ...(saved.year === undefined ? {} : { year: saved.year })
        },
        ...(seasonStructure.seasonNumber === undefined ? {} : { seasonNumber: seasonStructure.seasonNumber }),
        ...(seasonStructure.discNumber === undefined ? {} : { discNumber: seasonStructure.discNumber }),
        ...(seasonStructure.discCount === undefined ? {} : { discCount: seasonStructure.discCount }),
        episodeMatches: []
      }] : []),
      ...completedDiscHistory.filter((record) => record.fingerprint === fingerprint).map((record) => ({
        fingerprint: record.fingerprint,
        series: {
          id: record.providerId ?? `saved:${record.seriesName.toLocaleLowerCase()}`,
          title: record.seriesName
        },
        seasonNumber: record.seasonNumber,
        ...(record.discNumber === null ? {} : { discNumber: record.discNumber }),
        episodeMatches: record.mappings.flatMap((mapping): HistoricalEpisodeEvidence[] => {
          const item = currentItems.get(mapping.trackId);
          if (!item) return [];
          return mapping.episodes.map((episode) => ({
            itemSignature: tvItemSignature(item),
            episode,
            confidence: 1
          }));
        })
      }))
    ];
    const analysis = this.analysisEngine.analyze({
      sourceId: source.sourceId,
      manifestId: source.manifest.identifiers?.manifestId ?? fingerprint,
      manifest: source.manifest,
      discLabel: source.label || nameSources.find((entry) => entry.normalized)?.raw || "",
      fingerprint,
      disc: seasonStructure,
      discStructureHints,
      discNumberUserConfirmed: saved?.origin === "user",
      history,
      providerDiscEpisodes,
      completedDiscHistory,
      metadata: { seriesCandidates, seasonCandidates, episodeCandidates }
    });
    const feedback = analysis.items.flatMap((item) =>
      this.feedbackRepository.findForItemSignature(item.itemSignature)
    );
    const matches = this.matchingEngine.match({
      analysis,
      episodeMetadata: episodeCandidates,
      providerDiscEpisodes,
      feedback
    });
    const plan = this.planRepository.save(planInput(analysis, matches));
    const metadataLookups = [
      {
        entityType: "series",
        durationMs: seriesLookup.durationMs,
        candidates: seriesResult.candidates,
        failures: seriesResult.providerFailures
      },
      ...(seasonLookup ? [{
        entityType: "season",
        durationMs: seasonLookup.durationMs,
        candidates: seasonResult?.candidates ?? [],
        failures: seasonResult?.providerFailures ?? []
      }] : []),
      {
        entityType: "episode",
        durationMs: episodeLookup.durationMs,
        candidates: episodeResult.candidates,
        failures: episodeResult.providerFailures
      },
      ...(discEpisodeLookup ? [{
        entityType: "episode-disc",
        durationMs: discEpisodeLookup.durationMs,
        candidates: discEpisodeLookup.result.candidates,
        failures: discEpisodeLookup.result.providerFailures
      }] : [])
    ];
    const topDetected = analysis.detectedSeries;
    const detectedProvider = topDetected
      ? seriesCandidates.find((candidate) => candidate.series.id === topDetected.series.id)?.providerId
      : undefined;
    const selectedOrigin = saved ? saved.origin === "user" ? "user-specified" : "fingerprint-mapping"
      : winningStep ?? "none";
    const stepStatus = (id: TvIdentificationStepId): TvIdentificationStep["status"] => {
      const nameSource = nameSources.find((entry) => entry.stepId === id);
      if (saved) return "skipped";
      if (!nameSource || !nameSource.normalized) return "skipped";
      if (winningStep === id) return "matched";
      return queries.some((query) => query.nameSource === nameSource.name) ? "no-match" : "skipped";
    };
    const nameDetail = (id: TvIdentificationStepId): string => {
      const nameSource = nameSources.find((entry) => entry.stepId === id);
      if (!nameSource?.raw) return "Not available for this disc";
      if (!nameSource.normalized) return `"${nameSource.raw}" is a generic name and was ignored`;
      return `"${nameSource.raw}" normalized to "${nameSource.normalized}"`;
    };
    const providerStep = (providerPattern: RegExp): TvIdentificationStep["status"] => {
      const relevant = queries.filter((query) => providerPattern.test(query.providerId));
      if (relevant.length === 0) return "skipped";
      if (relevant.some((query) => query.matches > 0)) return "matched";
      return relevant.every((query) => query.failure) ? "failed" : "no-match";
    };
    const providerDetail = (providerPattern: RegExp): string => {
      const relevant = queries.filter((query) => providerPattern.test(query.providerId));
      if (relevant.length === 0) return "Not queried (no usable name, provider disabled, or identification was supplied)";
      return `${relevant.length} quer${relevant.length === 1 ? "y" : "ies"}, ${relevant.reduce((sum, query) => sum + query.matches, 0)} matches`;
    };
    const assessment = assessTvDisc(source);
    const volumeLabelStructure = nameSources.find((entry) => entry.stepId === "volume-label")?.structure;
    const discLabelSuggestion = volumeLabelStructure?.discNumber === undefined
      ? undefined
      : {
        ...(normalizeDiscName(source.label) ? { seriesName: normalizeDiscName(source.label) } : {}),
        ...(volumeLabelStructure.seasonNumber === undefined
          ? {} : { seasonNumber: volumeLabelStructure.seasonNumber }),
        discNumber: volumeLabelStructure.discNumber
      };
    const steps: TvIdentificationStep[] = [
      { order: 1, id: "user-specified", name: "User-specified identification",
        status: saved?.origin === "user" ? "matched" : "skipped",
        detail: saved?.origin === "user" ? `${saved.seriesName}${saved.seasonNumber == null ? "" : ` season ${saved.seasonNumber}`}` : "No identification was entered manually" },
      { order: 2, id: "fingerprint-mapping", name: "Saved fingerprint mapping",
        status: saved?.origin === "fingerprint" ? "matched" : "skipped",
        detail: saved?.origin === "fingerprint" ? `Fingerprint maps to ${saved.seriesName}` : "No saved mapping exists for this fingerprint" },
      { order: 3, id: "volume-label", name: "Optical disc volume label", status: stepStatus("volume-label"), detail: nameDetail("volume-label") },
      { order: 4, id: "filesystem-volume-name", name: "Filesystem volume name", status: stepStatus("filesystem-volume-name"), detail: nameDetail("filesystem-volume-name") },
      { order: 5, id: "makemkv-disc-name", name: "MakeMKV disc name", status: stepStatus("makemkv-disc-name"), detail: nameDetail("makemkv-disc-name") },
      { order: 6, id: "dvd-metadata", name: "DVD metadata", status: stepStatus("dvd-metadata"), detail: nameDetail("dvd-metadata") },
      { order: 7, id: "tvdb-search", name: "TVDB search", status: providerStep(/tvdb/i), detail: providerDetail(/tvdb/i) },
      { order: 8, id: "tmdb-search", name: "TMDB search", status: providerStep(/tmdb/i), detail: providerDetail(/tmdb/i) },
      { order: 9, id: "runtime-structure", name: "Runtime and disc structure analysis", status: "informational",
        detail: `${assessment.classification} (${assessment.confidence.toFixed(2)}); ${episodeTitleCount} episode-length titles` },
      { order: 10, id: "episode-count", name: "Episode-count matching",
        status: seasonCandidates.some((candidate) => candidate.providerId === "episode-count-match") ? "matched" : "skipped",
        detail: episodeCountDetail }
    ];
    const identification: TvIdentificationDiagnostics = {
      fingerprint,
      volumeLabel: source.label.trim() || null,
      filesystemVolumeName,
      makemkvDiscName,
      dvdMetadataName,
      steps,
      nameSources,
      queries,
      providersQueried: [...providersQueried],
      providerMatches,
      failures,
      seriesCandidates: seriesCandidates.map((candidate) => ({
        title: candidate.series.title,
        ...(candidate.series.year === undefined ? {} : { year: candidate.series.year }),
        providerId: candidate.providerId,
        seriesId: candidate.series.id ?? candidate.series.title,
        confidence: candidate.confidence
      })),
      seasonCandidates: seasonCandidates.map((candidate) => ({
        seasonNumber: candidate.season.number,
        providerId: candidate.providerId,
        confidence: candidate.confidence
      })),
      ...(discLabelSuggestion ? { discLabelSuggestion } : {}),
      selected: topDetected ? {
        title: topDetected.series.title,
        ...(topDetected.series.year === undefined ? {} : { year: topDetected.series.year }),
        seriesId: topDetected.series.id ?? topDetected.series.title,
        providerId: detectedProvider ?? saved?.provider ?? "unknown",
        origin: selectedOrigin,
        ...(analysis.detectedSeason ? { seasonNumber: analysis.detectedSeason.season.number } : {}),
        ...(analysis.discPositionCandidates[0] ? { discNumber: analysis.discPositionCandidates[0].discNumber } : {})
      } : null,
      episodeTitleCount,
      recordedAt: new Date().toISOString()
    };
    const result = { analysis, matches, plan, metadataLookups, identification };
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
  return assessTvDisc(source).classification !== "movie";
}

export function summarizeTvPlan(plan: TvProcessingPlan): string {
  const series = plan.series?.title ?? "unknown series";
  const season = plan.season ? `season ${plan.season.number}` : "unknown season";
  const suggestions = plan.assignments.filter((item) => item.episodes.length > 0).length;
  const processingDecision = plan.automaticProcessingSafe
    ? "episode mapping is high-confidence"
    : "manual review is required";
  return `TV analysis plan ${plan.id}: ${series}, ${season}; confidence ${plan.confidenceBand}; ${suggestions} suggested track assignments; ${processingDecision}; automatic execution disabled`;
}

export function tvPlanRecommendations(
  analysis: TvDiscAnalysisReport,
  matches: TvEpisodeMatchReport
): readonly TvAnalysisRecommendation[] {
  return [...analysis.recommendations, ...matches.recommendations];
}
