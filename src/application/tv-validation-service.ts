import { randomUUID } from "node:crypto";
import type { MetadataCandidate } from "../domain/metadata.js";
import type {
  TvValidationDataset,
  TvValidationEvidence,
  TvValidationEvidenceRepository
} from "../domain/tv-validation.js";
import { tvValidationFormat, tvValidationSchemaVersion } from "../domain/tv-validation.js";
import { tvEpisodeMatchingPolicy } from "./tv-episode-matching-engine.js";
import { tvAnalysisWeights } from "./tv-analysis-engine.js";
import { tvWorkflowPolicy } from "./tv-workflow-service.js";
import type {
  TvEpisodeFeedbackRepository,
  TvEpisodeMetadataCandidate,
  TvProcessingPlanRepository,
  TvSeasonMetadataCandidate,
  TvSeriesMetadataCandidate
} from "../domain/television.js";
import type { TvWorkflowSource, TvWorkflowResult } from "./tv-workflow-service.js";

export interface TvMetadataLookupSnapshot {
  rawCandidates: readonly MetadataCandidate[];
  providersWithFailures: readonly string[];
  seriesCandidates: readonly TvSeriesMetadataCandidate[];
  seasonCandidates: readonly TvSeasonMetadataCandidate[];
  episodeCandidates: readonly TvEpisodeMetadataCandidate[];
}

export interface TvValidationSummary {
  cases: number;
  capturedCases: number;
  importedCases: number;
  tracks: number;
  unresolvedTracks: number;
  heldOutLabeledTracks: number;
  exactMatches: number;
  incorrectMatches: number;
  abstentions: number;
  rejectedCandidatesNotSelected: number;
  rejectedCandidatesSelected: number;
  meanPlanConfidence: number | null;
  planStates: Record<string, number>;
  matchDecisions: Record<string, number>;
  correctionOutcomes: Record<string, number>;
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function numericField(value: Record<string, unknown>, field: string): number {
  const number = value[field];
  if (typeof number !== "number" || !Number.isFinite(number)) {
    throw new Error(`TV validation policy field ${field} must be a finite number`);
  }
  return number;
}

function validateEvidence(value: unknown): TvValidationEvidence {
  assertObject(value, "TV validation case");
  if (value.format !== tvValidationFormat || value.schemaVersion !== tvValidationSchemaVersion) {
    throw new Error("TV validation case has an unsupported format or schema version");
  }
  if (typeof value.id !== "string" || !value.id.trim() ||
    typeof value.capturedAt !== "string" ||
    typeof value.buildId !== "string" ||
    (value.origin !== "captured" && value.origin !== "imported")) {
    throw new Error("TV validation case has invalid identity or provenance");
  }
  assertObject(value.source, "TV validation source");
  assertObject(value.source.manifest, "TV validation manifest");
  assertObject(value.metadata, "TV validation metadata");
  assertObject(value.analysis, "TV analysis report");
  assertObject(value.matches, "TV match report");
  assertObject(value.plan, "TV processing plan");
  if (typeof value.source.fingerprint !== "string" || !value.source.fingerprint.trim() ||
    typeof value.source.sourceId !== "string" || typeof value.source.providerId !== "string" ||
    typeof value.source.mediaKind !== "string" || typeof value.source.label !== "string" ||
    typeof value.plan.id !== "string" || typeof value.plan.fingerprint !== "string" ||
    typeof value.plan.confidence !== "number" || !Number.isFinite(value.plan.confidence) ||
    value.plan.executionEnabled !== false ||
    !Array.isArray(value.source.manifest.items) ||
    !Array.isArray(value.metadata.rawCandidates) ||
    !Array.isArray(value.metadata.seriesCandidates) ||
    !Array.isArray(value.metadata.seasonCandidates) ||
    !Array.isArray(value.metadata.episodeCandidates) ||
    !Array.isArray(value.metadata.providersWithFailures) ||
    !Array.isArray(value.analysis.items) ||
    !Array.isArray(value.matches.items) ||
    !Array.isArray(value.plan.assignments) ||
    !Array.isArray(value.feedback)) {
    throw new Error("TV validation case is missing required disc, metadata, report, or feedback data");
  }
  for (const item of value.source.manifest.items) {
    assertObject(item, "TV manifest item");
    if (typeof item.id !== "string" || typeof item.kind !== "string" ||
      (item.durationSeconds !== undefined &&
        (typeof item.durationSeconds !== "number" || !Number.isFinite(item.durationSeconds)))) {
      throw new Error("TV validation manifest contains an invalid item");
    }
  }
  for (const candidate of value.metadata.rawCandidates) {
    assertObject(candidate, "Metadata candidate");
    assertObject(candidate.metadata, "Metadata candidate payload");
    if (typeof candidate.id !== "string" || typeof candidate.providerId !== "string" ||
      typeof candidate.entityType !== "string" || typeof candidate.title !== "string" ||
      typeof candidate.confidence !== "number" || !Number.isFinite(candidate.confidence) ||
      candidate.confidence < 0 || candidate.confidence > 1) {
      throw new Error("TV validation metadata contains an invalid candidate");
    }
  }
  for (const item of value.matches.items) {
    assertObject(item, "Episode match item");
    if (typeof item.itemId !== "string" || typeof item.decision !== "string" ||
      typeof item.confidence !== "number" || !Number.isFinite(item.confidence) ||
      item.confidence < 0 || item.confidence > 1 ||
      typeof item.manualReviewRequired !== "boolean" ||
      !Array.isArray(item.suggestedEpisodes) || !Array.isArray(item.alternatives) ||
      !Array.isArray(item.evidence)) {
      throw new Error("TV validation match report contains an invalid item");
    }
    for (const option of item.alternatives) {
      assertObject(option, "Episode match alternative");
      if (typeof option.confidence !== "number" || !Number.isFinite(option.confidence) ||
        option.confidence < 0 || option.confidence > 1 || !Array.isArray(option.episodes)) {
        throw new Error("TV validation match report contains an invalid alternative");
      }
      assertObject(option.scoreComponents, "Episode match score components");
    }
  }
  for (const feedback of value.feedback) {
    assertObject(feedback, "TV episode correction");
    if (typeof feedback.id !== "string" || typeof feedback.itemSignature !== "string" ||
      typeof feedback.fingerprint !== "string" || typeof feedback.outcome !== "string" ||
      !Array.isArray(feedback.episodes) || typeof feedback.createdAt !== "string") {
      throw new Error("TV validation evidence contains an invalid correction record");
    }
  }
  const policy = value.policy;
  assertObject(policy, "TV validation policy");
  for (const field of [
    "highConfidence", "mediumConfidence", "minimumEpisodeRuntimeSeconds",
    "maximumEpisodeRuntimeSeconds", "structuralTitleCount", "runtimeRatioMaximum",
    "matcherMinimumConfidence", "matcherMinimumMargin"
  ]) {
    if (typeof policy[field] !== "number" || !Number.isFinite(policy[field])) {
      throw new Error(`TV validation policy field ${field} must be a finite number`);
    }
  }
  if (typeof policy.policyVersion !== "number" || !Number.isInteger(policy.policyVersion) ||
    typeof policy.explicitLabelPattern !== "string" || typeof policy.explicitLabelFlags !== "string" ||
    typeof policy.excludedTrackTitlePattern !== "string" || typeof policy.excludedTrackTitleFlags !== "string") {
    throw new Error("TV validation policy version or prefilter patterns are invalid");
  }
  assertObject(policy.scoringWeights, "TV validation scoring weights");
  for (const weightSet of ["series", "season", "discPosition", "episode"]) {
    assertObject(policy.scoringWeights[weightSet], `TV ${weightSet} scoring weights`);
    const weights = Object.values(policy.scoringWeights[weightSet]);
    const totalWeight = weights.reduce<number>((total, weight) => {
      if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0) {
        throw new Error(`TV ${weightSet} scoring weights must be finite and non-negative`);
      }
      return total + weight;
    }, 0);
    if (Math.abs(totalWeight - 1) > 0.0001) {
      throw new Error(`TV ${weightSet} scoring weights must be finite, non-negative, and sum to 1`);
    }
  }
  if (policy.planAggregation !== "minimum-required-evidence") {
    throw new Error("TV validation plan aggregation rule is unsupported");
  }
  const matcherMinimumConfidence = numericField(policy, "matcherMinimumConfidence");
  const matcherMinimumMargin = numericField(policy, "matcherMinimumMargin");
  const highConfidence = numericField(policy, "highConfidence");
  const mediumConfidence = numericField(policy, "mediumConfidence");
  const multipartMetadataWeight = numericField(policy, "multipartMetadataWeight");
  const multipartRuntimeWeight = numericField(policy, "multipartRuntimeWeight");
  if (value.plan.confidence < 0 || value.plan.confidence > 1 ||
    matcherMinimumConfidence < 0 || matcherMinimumConfidence > 1 ||
    matcherMinimumMargin < 0 || matcherMinimumMargin > 1 ||
    highConfidence < 0 || highConfidence > 1 ||
    mediumConfidence < 0 || mediumConfidence > 1 ||
    multipartMetadataWeight < 0 || multipartMetadataWeight > 1 ||
    multipartRuntimeWeight < 0 || multipartRuntimeWeight > 1 ||
    Math.abs(multipartMetadataWeight + multipartRuntimeWeight - 1) > 0.0001) {
    throw new Error("TV validation confidence values must be between 0 and 1");
  }
  return value as unknown as TvValidationEvidence;
}

function episodeIdentity(episode: { seriesId: string; seasonNumber: number; episodeNumber: number }): string {
  return `${episode.seriesId}:${episode.seasonNumber}:${episode.episodeNumber}`;
}

function heldOutFeedback(evidence: TvValidationEvidence): TvValidationEvidence["feedback"] {
  const latestBySignature = new Map<string, TvValidationEvidence["feedback"][number]>();
  for (const feedback of evidence.feedback) {
    if (feedback.createdAt <= evidence.capturedAt) continue;
    const current = latestBySignature.get(feedback.itemSignature);
    if (!current || feedback.createdAt >= current.createdAt) latestBySignature.set(feedback.itemSignature, feedback);
  }
  return [...latestBySignature.values()];
}

function compareWithHeldOutFeedback(evidence: TvValidationEvidence): {
  labeled: number;
  exact: number;
  incorrect: number;
  abstained: number;
  rejectedNotSelected: number;
  rejectedSelected: number;
  details: string[];
} {
  let labeled = 0;
  let exact = 0;
  let incorrect = 0;
  let abstained = 0;
  let rejectedNotSelected = 0;
  let rejectedSelected = 0;
  const details: string[] = [];
  for (const feedback of heldOutFeedback(evidence)) {
    const analysisItem = evidence.analysis.items.find((item) => item.itemSignature === feedback.itemSignature);
    const match = analysisItem && evidence.matches.items.find((item) => item.itemId === analysisItem.itemId);
    if (!match) continue;
    const expected = feedback.episodes.map(episodeIdentity);
    const predicted = match.suggestedEpisodes.map(episodeIdentity);
    if (feedback.outcome === "accepted" || feedback.outcome === "manual-assignment") {
      labeled += 1;
      if (match.decision === "unknown" || predicted.length === 0) {
        abstained += 1;
        details.push(`${analysisItem.itemId}: abstained; later human label is ${expected.join(", ")}`);
      } else if (expected.length === predicted.length && expected.every((episode, index) => episode === predicted[index])) {
        exact += 1;
        details.push(`${analysisItem.itemId}: exact match to later human label`);
      } else {
        incorrect += 1;
        details.push(`${analysisItem.itemId}: suggested ${predicted.join(", ")}, later human label is ${expected.join(", ")}`);
      }
    } else if (feedback.outcome === "rejected") {
      if (predicted.length === 1 && predicted[0] === expected[0]) {
        rejectedSelected += 1;
        details.push(`${analysisItem.itemId}: selected an episode later rejected by a reviewer`);
      } else {
        rejectedNotSelected += 1;
        details.push(`${analysisItem.itemId}: avoided an episode later rejected by a reviewer`);
      }
    }
  }
  return { labeled, exact, incorrect, abstained, rejectedNotSelected, rejectedSelected, details };
}

export function createTvDecisionReport(evidence: TvValidationEvidence): string {
  const currentPlan = evidence.plan;
  const matching = evidence.matches;
  const lines = [
    `# TV Validation Case ${evidence.id}`,
    "",
    `- Captured: ${evidence.capturedAt}`,
    `- Origin: ${evidence.origin}`,
    `- Build: ${evidence.buildId}`,
    `- Source: ${evidence.source.providerId} (${evidence.source.mediaKind})`,
    `- Disc label: ${evidence.source.label || "(none)"}`,
    `- Fingerprint: ${evidence.source.fingerprint} (${evidence.source.fingerprintMethod})`,
    `- Plan state: ${currentPlan.state}`,
    `- Review: ${currentPlan.reviewedBy ? `${currentPlan.state} by ${currentPlan.reviewedBy} at ${currentPlan.reviewedAt}` : "not recorded"}`,
    `- Review reason: ${currentPlan.reviewReason || "(none)"}`,
    ...((currentPlan.reviewHistory ?? []).length ? ["", "## Review history", ""] : []),
    ...(currentPlan.reviewHistory ?? []).map((review) =>
      `- ${review.decision} by ${review.reviewer} at ${review.at}${review.reason ? ` — ${review.reason}` : ""}`),
    "",
    "## Disc structure",
    "",
    `- Manifest items: ${evidence.source.manifest.items.length}`,
    `- Analysis items: ${evidence.analysis.items.length}`,
    `- Detected series: ${currentPlan.series?.title ?? "unknown"} (confidence ${currentPlan.seriesConfidence.toFixed(3)})`,
    `- Detected season: ${currentPlan.season?.number ?? "unknown"} (confidence ${currentPlan.seasonConfidence.toFixed(3)})`,
    `- Disc position: ${currentPlan.discPosition?.discNumber ?? "unknown"}${currentPlan.discPosition?.discCount ? ` of ${currentPlan.discPosition.discCount}` : ""} (confidence ${currentPlan.discPosition?.confidence.toFixed(3) ?? "0.000"})`,
    "",
    "## Confidence policy",
    "",
    `- Plan confidence ${currentPlan.confidence.toFixed(3)} (${currentPlan.confidenceBand}); currently calculated from the minimum of series, season, disc-position, and episode evidence.`,
    `- Episode candidate threshold: ${evidence.policy.matcherMinimumConfidence.toFixed(2)} by default.`,
    `- Ambiguity margin: ${evidence.policy.matcherMinimumMargin.toFixed(2)}; the top candidate must exceed the runner-up by at least this amount.`,
    "- Multipart assignments require complete, consecutive provider-declared grouping; combined runtime is used when available.",
    `- TV prefilter: explicit label regex /${evidence.policy.explicitLabelPattern}/${evidence.policy.explicitLabelFlags}, or at least ${evidence.policy.structuralTitleCount} titles between ${evidence.policy.minimumEpisodeRuntimeSeconds} and ${evidence.policy.maximumEpisodeRuntimeSeconds} seconds, runtime ratio at most ${evidence.policy.runtimeRatioMaximum}; excluded-title regex /${evidence.policy.excludedTrackTitlePattern}/${evidence.policy.excludedTrackTitleFlags}.`,
    `- Plan confidence bands: high >= ${evidence.policy.highConfidence.toFixed(2)}, medium >= ${evidence.policy.mediumConfidence.toFixed(2)}.`,
    `- Series score weights: ${JSON.stringify(evidence.policy.scoringWeights.series)}; season: ${JSON.stringify(evidence.policy.scoringWeights.season)}; disc position: ${JSON.stringify(evidence.policy.scoringWeights.discPosition)}; episode: ${JSON.stringify(evidence.policy.scoringWeights.episode)}.`,
    `- Multipart score is ${evidence.policy.multipartMetadataWeight.toFixed(2)} metadata plus ${evidence.policy.multipartRuntimeWeight.toFixed(2)} runtime when both are available.`,
    "- Title similarity uses token-set Jaccard overlap; runtime similarity is one minus absolute runtime difference divided by the larger runtime. Weighted component scores are normalized over the components present.",
    "- Historical matches contribute 1.00 for exact fingerprint history and 0.65 for related historical evidence. A user-entered correction is surfaced at 1.00 confidence as a human override, not a calibrated probability.",
    `- Plan aggregation: ${evidence.policy.planAggregation}.`,
    `- Recorded policy version: ${evidence.policy.policyVersion}.`,
    "- These thresholds and heuristics are unvalidated against a broad physical-disc dataset; scores are evidence rankings, not calibrated probabilities.",
    "",
    "## Identity and position evidence",
    "",
    `- Series candidates: ${evidence.analysis.seriesCandidates.map((candidate) =>
      `${candidate.series.title} ${candidate.confidence.toFixed(3)} ${JSON.stringify(candidate.scoreComponents)} [${candidate.evidence.join("; ")}]`
    ).join(" | ") || "none"}`,
    `- Season candidates: ${evidence.analysis.seasonCandidates.map((candidate) =>
      `S${candidate.season.number} ${candidate.confidence.toFixed(3)} ${JSON.stringify(candidate.scoreComponents)} [${candidate.evidence.join("; ")}]`
    ).join(" | ") || "none"}`,
    `- Disc-position evidence: ${evidence.analysis.discPositionCandidates.map((candidate) =>
      `disc ${candidate.discNumber}${candidate.discCount ? `/${candidate.discCount}` : ""} ${candidate.confidence.toFixed(3)} ${JSON.stringify(candidate.scoreComponents)} [${candidate.evidence.join("; ")}]`
    ).join(" | ") || "none"}`,
    "",
    "## Episode decisions",
    ""
  ];
  for (const item of matching.items) {
    const analysisItem = evidence.analysis.items.find((candidate) => candidate.itemId === item.itemId);
    lines.push(`### ${item.itemId}: ${item.itemTitle ?? analysisItem?.title ?? "(untitled)"} — ${item.decision}`);
    lines.push("");
    lines.push(`- Runtime: ${analysisItem?.durationSeconds === undefined ? "unknown" : `${analysisItem.durationSeconds} seconds`}`);
    lines.push(`- Confidence: ${item.confidence.toFixed(3)}; manual review: ${item.manualReviewRequired ? "required" : "not required"}`);
    lines.push(`- Suggested: ${item.suggestedEpisodes.length ? item.suggestedEpisodes.map(formatEpisode).join(", ") : "none"}`);
    const rules = rulesForDecision(item.decision, item.evidence);
    lines.push(`- Rules: ${rules.length ? rules.join("; ") : "episode candidate ranking; no explicit special-case rule"}`);
    lines.push("- Evidence:");
    for (const reason of item.evidence) lines.push(`  - ${reason}`);
    lines.push("- Ranked alternatives:");
    if (item.alternatives.length === 0) lines.push("  - none");
    for (const option of item.alternatives) {
      lines.push(`  - ${option.episodes.map(formatEpisode).join(" + ")}: ${option.confidence.toFixed(3)} (${JSON.stringify(option.scoreComponents)})`);
    }
    lines.push("");
  }
  const unresolved = matching.items.filter((item) =>
    item.decision === "unknown" || item.manualReviewRequired || item.decision === "alternate-review" ||
    item.decision === "special-feature"
  );
  lines.push("## Unresolved tracks", "");
  if (unresolved.length === 0) lines.push("None recorded by the matcher.");
  for (const item of unresolved) lines.push(`- ${item.itemId}: ${item.decision} — ${item.evidence.join("; ") || "no explanation recorded"}`);
  lines.push("", "## User evidence", "");
  lines.push(`- Review disposition: ${currentPlan.state}${currentPlan.reviewedBy ? ` by ${currentPlan.reviewedBy}` : ""}`);
  lines.push(`- Episode correction records: ${evidence.feedback.length}`);
  for (const correction of evidence.feedback) {
    const timing = correction.createdAt > evidence.capturedAt ? " (recorded after this analysis)" : "";
    lines.push(`- ${correction.outcome} for ${correction.itemSignature}: ${correction.episodes.map(formatEpisode).join(", ")}${correction.reason ? ` — ${correction.reason}` : ""}${timing}`);
  }
  const heldOut = compareWithHeldOutFeedback(evidence);
  lines.push("", "## Held-out feedback checks", "");
  lines.push(`- Human-labeled tracks recorded after the analysis: ${heldOut.labeled}`);
  lines.push(`- Exact suggestions: ${heldOut.exact}; incorrect suggestions: ${heldOut.incorrect}; abstentions: ${heldOut.abstained}.`);
  lines.push(`- Rejected candidates not selected: ${heldOut.rejectedNotSelected}; rejected candidates selected: ${heldOut.rejectedSelected}.`);
  for (const detail of heldOut.details) lines.push(`- ${detail}`);
  if (heldOut.details.length === 0) lines.push("- No post-capture correction labels are available yet.");
  lines.push("", "## Recommendations", "");
  const recommendations = [...evidence.analysis.recommendations, ...matching.recommendations];
  if (recommendations.length === 0) lines.push("No recommendations recorded.");
  for (const recommendation of recommendations) {
    lines.push(`- ${recommendation.action}: ${recommendation.message}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatEpisode(episode: { seriesId: string; seasonNumber: number; episodeNumber: number; title?: string }): string {
  return `${episode.seriesId} S${episode.seasonNumber}E${episode.episodeNumber}${episode.title ? ` "${episode.title}"` : ""}`;
}

function rulesForDecision(decision: string, evidence: readonly string[]): string[] {
  const rules: string[] = [];
  const normalizedEvidence = evidence.map((reason) => reason.toLocaleLowerCase());
  if (normalizedEvidence.some((reason) => reason.includes("explicitly groups"))) {
    rules.push("match.explicit-multipart-group");
  }
  if (normalizedEvidence.some((reason) => reason.includes("multipart metadata group"))) {
    rules.push("match.multipart-metadata-validation");
  }
  if (normalizedEvidence.some((reason) => reason.includes("previously rejected episode match"))) {
    rules.push("match.rejected-feedback");
  }
  if (decision === "unknown" && normalizedEvidence.some((reason) => reason.includes("below the") && reason.includes("threshold"))) {
    rules.push("match.minimum-confidence");
  }
  if (decision === "unknown" && normalizedEvidence.some((reason) => reason.includes("required margin"))) {
    rules.push("match.minimum-margin");
  }
  if (decision === "unknown" && normalizedEvidence.some((reason) => reason.includes("multiple tracks"))) {
    rules.push("match.cross-track-conflict");
  }
  if (decision === "accepted") rules.push("match.user-accepted");
  if (decision === "manual-assignment") rules.push("match.manual-assignment");
  if (decision === "suggested" && rules.length === 0) rules.push("match.minimum-confidence-and-margin-passed");
  if (decision === "duplicate") rules.push("analysis.duplicate-classification");
  if (decision === "alternate-review") rules.push("analysis.alternate-review");
  if (decision === "commentary" || decision === "bonus" || decision === "special-feature") {
    rules.push(`analysis.${decision}-classification`);
  }
  if (decision === "unknown" && rules.length === 0) rules.push("match.no-supported-candidate");
  return rules;
}

export class TvValidationService {
  constructor(
    private readonly evidenceRepository: TvValidationEvidenceRepository,
    private readonly feedbackRepository: TvEpisodeFeedbackRepository,
    private readonly planRepository: TvProcessingPlanRepository
  ) {}

  capture(
    source: TvWorkflowSource,
    fingerprint: string,
    lookups: TvMetadataLookupSnapshot,
    result: TvWorkflowResult
  ): TvValidationEvidence {
    const evidence: TvValidationEvidence = {
      format: tvValidationFormat,
      schemaVersion: tvValidationSchemaVersion,
      id: randomUUID(),
      capturedAt: new Date().toISOString(),
      origin: "captured",
      buildId: process.env.AUTODISC_BUILD_ID ?? "unknown",
      policy: {
        policyVersion: 1,
        highConfidence: tvWorkflowPolicy.highConfidence,
        mediumConfidence: tvWorkflowPolicy.mediumConfidence,
        minimumEpisodeRuntimeSeconds: tvWorkflowPolicy.episodeMinimumSeconds,
        maximumEpisodeRuntimeSeconds: tvWorkflowPolicy.episodeMaximumSeconds,
        structuralTitleCount: tvWorkflowPolicy.structuralTitleCount,
        runtimeRatioMaximum: tvWorkflowPolicy.runtimeRatioMaximum,
        explicitLabelPattern: tvWorkflowPolicy.explicitLabelPattern,
        explicitLabelFlags: tvWorkflowPolicy.explicitLabelFlags,
        excludedTrackTitlePattern: tvWorkflowPolicy.excludedTrackTitlePattern,
        excludedTrackTitleFlags: tvWorkflowPolicy.excludedTrackTitleFlags,
        matcherMinimumConfidence: tvEpisodeMatchingPolicy.minimumConfidence,
        matcherMinimumMargin: tvEpisodeMatchingPolicy.minimumMargin,
        multipartMetadataWeight: tvEpisodeMatchingPolicy.multipartMetadataWeight,
        multipartRuntimeWeight: tvEpisodeMatchingPolicy.multipartRuntimeWeight,
        planAggregation: "minimum-required-evidence",
        scoringWeights: tvAnalysisWeights
      },
      source: {
        sourceId: source.sourceId,
        providerId: source.providerId,
        mediaKind: source.mediaKind,
        label: source.label,
        fingerprint,
        fingerprintMethod: "label-manifest-sha256-v1",
        manifest: source.manifest
      },
      metadata: {
        rawCandidates: lookups.rawCandidates,
        seriesCandidates: lookups.seriesCandidates,
        seasonCandidates: lookups.seasonCandidates,
        episodeCandidates: lookups.episodeCandidates,
        providersWithFailures: lookups.providersWithFailures
      },
      analysis: result.analysis,
      matches: result.matches,
      plan: result.plan,
      feedback: this.feedbackRepository.listForFingerprint(fingerprint)
    };
    this.evidenceRepository.save(evidence);
    return evidence;
  }

  get(id: string): TvValidationEvidence | undefined {
    const evidence = this.evidenceRepository.get(id);
    return evidence ? this.withLatestReview(evidence) : undefined;
  }

  list(limit = 1000, offset = 0): TvValidationEvidence[] {
    return this.evidenceRepository.list(limit, offset).map((evidence) => this.withLatestReview(evidence));
  }

  exportDataset(offset = 0, limit = 1000): TvValidationDataset {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 10000) {
      throw new Error("TV validation export requires a non-negative offset and a limit between 1 and 10000");
    }
    const dataset: TvValidationDataset = {
      format: tvValidationFormat,
      schemaVersion: tvValidationSchemaVersion,
      exportedAt: new Date().toISOString(),
      cases: this.list(limit, offset)
    };
    if (Buffer.byteLength(JSON.stringify(dataset), "utf8") > 50 * 1024 * 1024) {
      throw new Error("TV validation export exceeds 50 MiB; export a smaller chunk using offset and limit");
    }
    return dataset;
  }

  summary(): TvValidationSummary {
    const cases = this.list(10000);
    const planStates: Record<string, number> = {};
    const matchDecisions: Record<string, number> = {};
    const correctionOutcomes: Record<string, number> = {};
    const countedFeedback = new Set<string>();
    let tracks = 0;
    let unresolvedTracks = 0;
    let confidenceTotal = 0;
    let heldOutLabeledTracks = 0;
    let exactMatches = 0;
    let incorrectMatches = 0;
    let abstentions = 0;
    let rejectedCandidatesNotSelected = 0;
    let rejectedCandidatesSelected = 0;
    for (const evidence of cases) {
      planStates[evidence.plan.state] = (planStates[evidence.plan.state] ?? 0) + 1;
      confidenceTotal += evidence.plan.confidence;
      for (const item of evidence.matches.items) {
        tracks += 1;
        matchDecisions[item.decision] = (matchDecisions[item.decision] ?? 0) + 1;
        if (item.decision === "unknown" || item.manualReviewRequired) unresolvedTracks += 1;
      }
      for (const record of evidence.feedback) {
        if (countedFeedback.has(record.id)) continue;
        countedFeedback.add(record.id);
        correctionOutcomes[record.outcome] = (correctionOutcomes[record.outcome] ?? 0) + 1;
      }
      const comparison = compareWithHeldOutFeedback(evidence);
      heldOutLabeledTracks += comparison.labeled;
      exactMatches += comparison.exact;
      incorrectMatches += comparison.incorrect;
      abstentions += comparison.abstained;
      rejectedCandidatesNotSelected += comparison.rejectedNotSelected;
      rejectedCandidatesSelected += comparison.rejectedSelected;
    }
    return {
      cases: cases.length,
      capturedCases: cases.filter((evidence) => evidence.origin === "captured").length,
      importedCases: cases.filter((evidence) => evidence.origin === "imported").length,
      tracks,
      unresolvedTracks,
      heldOutLabeledTracks,
      exactMatches,
      incorrectMatches,
      abstentions,
      rejectedCandidatesNotSelected,
      rejectedCandidatesSelected,
      meanPlanConfidence: cases.length ? confidenceTotal / cases.length : null,
      planStates,
      matchDecisions,
      correctionOutcomes
    };
  }

  importDataset(serialized: string): { imported: number; caseIds: string[] } {
    if (Buffer.byteLength(serialized, "utf8") > 50 * 1024 * 1024) {
      throw new Error("TV validation dataset exceeds the 50 MiB import limit");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch (error) {
      throw new Error(`TV validation dataset is not valid JSON: ${error instanceof Error ? error.message : "parse error"}`);
    }
    assertObject(parsed, "TV validation dataset");
    if (parsed.format !== tvValidationFormat || parsed.schemaVersion !== tvValidationSchemaVersion ||
      !Array.isArray(parsed.cases)) {
      throw new Error("TV validation dataset has an unsupported format, schema version, or case list");
    }
    if (parsed.cases.length > 10000) throw new Error("TV validation dataset exceeds the 10000-case limit");
    const cases = parsed.cases.map(validateEvidence);
    const ids = new Set<string>();
    for (const evidence of cases) {
      if (ids.has(evidence.id) || this.evidenceRepository.get(evidence.id)) {
        throw new Error(`TV validation case ID already exists: ${evidence.id}`);
      }
      ids.add(evidence.id);
    }
    const importedCases = cases.map((evidence) => ({ ...evidence, origin: "imported" as const }));
    this.evidenceRepository.saveMany(importedCases);
    return { imported: importedCases.length, caseIds: importedCases.map((evidence) => evidence.id) };
  }

  report(id: string): string {
    const evidence = this.get(id);
    if (!evidence) throw new Error(`TV validation case ${id} was not found`);
    return createTvDecisionReport(evidence);
  }

  private withLatestReview(evidence: TvValidationEvidence): TvValidationEvidence {
    if (evidence.origin === "imported") return evidence;
    const plan = this.planRepository.get(evidence.plan.id) ?? evidence.plan;
    return {
      ...evidence,
      plan,
      feedback: this.feedbackRepository.listForFingerprint(evidence.source.fingerprint)
    };
  }
}
