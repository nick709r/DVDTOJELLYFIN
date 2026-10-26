import type {
  ConfidenceComponents,
  Episode,
  EpisodeCandidate,
  TvAnalysisRecommendation,
  TvDiscAnalysisReport,
  TvDiscItemResult,
  TvEpisodeFeedback,
  TvEpisodeMatchItemReport,
  TvEpisodeMatchOption,
  TvEpisodeMatchReport,
  TvEpisodeMatchingInput,
  TvEpisodeMetadataCandidate,
  TvProviderDiscEpisode
} from "../domain/television.js";

export const tvEpisodeMatchingPolicy = {
  minimumConfidence: 0.72,
  minimumMargin: 0.12,
  multipartMetadataWeight: 0.7,
  multipartRuntimeWeight: 0.3
} as const;

function episodeKey(episode: Episode): string {
  return `${episode.seriesId}:${episode.seasonNumber}:${episode.episodeNumber}`;
}

function compareEpisode(left: Episode, right: Episode): number {
  return left.seasonNumber - right.seasonNumber || left.episodeNumber - right.episodeNumber ||
    left.seriesId.localeCompare(right.seriesId);
}

function uniqueEpisodes(episodes: readonly Episode[]): Episode[] {
  const byKey = new Map<string, Episode>();
  for (const episode of episodes) byKey.set(episodeKey(episode), episode);
  return [...byKey.values()].sort(compareEpisode);
}

function finiteConfidence(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`${name} confidence must be finite`);
  return Math.max(0, Math.min(1, value));
}

function sameEpisodeList(left: readonly Episode[], right: readonly Episode[]): boolean {
  const leftKeys = left.map(episodeKey);
  const rightKeys = right.map(episodeKey);
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index]);
}

function runtimeSimilarity(actual: number, expected: number): number {
  return Math.max(0, 1 - Math.abs(actual - expected) / Math.max(actual, expected));
}

function candidateComponents(candidate: EpisodeCandidate): ConfidenceComponents {
  return candidate.scoreComponents ?? { metadata: candidate.confidence };
}

function candidateForEpisode(
  item: TvDiscItemResult,
  episode: Episode,
  metadata: readonly TvEpisodeMetadataCandidate[]
): EpisodeCandidate | undefined {
  const existing = item.candidates.find((candidate) => episodeKey(candidate.episode) === episodeKey(episode));
  const supplemental = metadata.filter((candidate) =>
    candidate.itemId === item.itemId && episodeKey(candidate.episode) === episodeKey(episode)
  );
  if (!existing && supplemental.length === 0) return undefined;
  const confidence = existing
    ? finiteConfidence(existing.confidence, "Analysis candidate")
    : Math.max(...supplemental.map((candidate) => finiteConfidence(candidate.confidence, "Metadata")));
  const evidence = new Set(existing?.evidence ?? []);
  for (const candidate of supplemental) {
    evidence.add(`Supplemental episode metadata from ${candidate.providerId}`);
    for (const reason of candidate.evidence ?? []) evidence.add(reason);
  }
  const preferredMetadata = supplemental.find((candidate) => candidate.multiPartGroupId) ?? supplemental[0];
  const releaseId = existing?.releaseId ?? preferredMetadata?.releaseId;
  return {
    episode,
    confidence,
    evidence: [...evidence].sort(),
    scoreComponents: existing?.scoreComponents ?? { metadata: confidence },
    ...(releaseId === undefined ? {} : { releaseId }),
    matchedItemId: item.itemId,
    ...(preferredMetadata?.multiPartGroupId ? { multiPartGroupId: preferredMetadata.multiPartGroupId } : {}),
    ...(preferredMetadata?.partNumber === undefined ? {} : { partNumber: preferredMetadata.partNumber }),
    ...(preferredMetadata?.partCount === undefined ? {} : { partCount: preferredMetadata.partCount })
  };
}

function validateMultipartCandidates(
  item: TvDiscItemResult,
  candidates: readonly TvEpisodeMetadataCandidate[]
): string[] {
  const issues: string[] = [];
  const groups = new Map<string, TvEpisodeMetadataCandidate[]>();
  for (const candidate of candidates) {
    if (!candidate.multiPartGroupId || candidate.itemId !== item.itemId) continue;
    const group = groups.get(candidate.multiPartGroupId) ?? [];
    group.push(candidate);
    groups.set(candidate.multiPartGroupId, group);
  }
  for (const [groupId, group] of groups) {
    const partCounts = new Set(group.map((candidate) => candidate.partCount));
    const partNumbers = group.map((candidate) => candidate.partNumber);
    const expectedCount = group[0]?.partCount;
    const valid = group.length >= 2 &&
      expectedCount !== undefined && Number.isInteger(expectedCount) && expectedCount >= 2 &&
      partCounts.size === 1 && group.length === expectedCount &&
      partNumbers.every((number) => number !== undefined && Number.isInteger(number) && number >= 1 && number <= expectedCount) &&
      new Set(partNumbers).size === expectedCount &&
      group.every((candidate) => candidate.episode.seriesId === group[0]?.episode.seriesId &&
        candidate.episode.seasonNumber === group[0]?.episode.seasonNumber) &&
      [...group].sort((left, right) => (left.partNumber ?? 0) - (right.partNumber ?? 0))
        .every((candidate, index, sorted) => index === 0 ||
          candidate.episode.episodeNumber === (sorted[index - 1]?.episode.episodeNumber ?? -2) + 1);
    if (!valid) issues.push(`Multipart metadata group ${groupId} is incomplete or inconsistent; no group match was suggested`);
  }
  return issues;
}

function multipartOptions(
  item: TvDiscItemResult,
  input: TvEpisodeMatchingInput,
  rejected: readonly TvEpisodeFeedback[]
): TvEpisodeMatchOption[] {
  const metadata = (input.episodeMetadata ?? []).filter((candidate) =>
    candidate.itemId === item.itemId && candidate.multiPartGroupId !== undefined
  );
  const groups = new Map<string, TvEpisodeMetadataCandidate[]>();
  for (const candidate of metadata) {
    const groupId = candidate.multiPartGroupId;
    if (!groupId) continue;
    const group = groups.get(groupId) ?? [];
    group.push(candidate);
    groups.set(groupId, group);
  }
  const options: TvEpisodeMatchOption[] = [];
  for (const [groupId, group] of groups) {
    const partCount = group[0]?.partCount;
    const ordered = [...group].sort((left, right) => (left.partNumber ?? 0) - (right.partNumber ?? 0));
    if (partCount === undefined || ordered.length < 2 || ordered.length !== partCount ||
      ordered.some((candidate, index) => candidate.partNumber !== index + 1)) continue;
    const episodes = ordered.map((candidate) => candidate.episode);
    if (episodes.length !== partCount || episodes.some((episode, index) =>
      index > 0 && (episode.seriesId !== episodes[0]?.seriesId ||
        episode.seasonNumber !== episodes[0]?.seasonNumber ||
        episode.episodeNumber !== (episodes[index - 1]?.episodeNumber ?? -2) + 1)
    )) continue;
    const wasRejected = rejected.some((feedback) => sameEpisodeList(feedback.episodes, episodes));
    if (wasRejected) continue;
    const matchingCandidates = episodes.map((episode) =>
      candidateForEpisode(item, episode, input.episodeMetadata ?? [])
    );
    if (matchingCandidates.some((candidate) => candidate === undefined)) continue;
    const validCandidates = matchingCandidates.filter((candidate): candidate is EpisodeCandidate => candidate !== undefined);
    const baseConfidence = validCandidates.reduce((sum, candidate) => sum + candidate.confidence, 0) / validCandidates.length;
    const expectedRuntime = ordered.reduce((sum, candidate) => sum + (candidate.runtimeSeconds ?? 0), 0);
    const actualRuntime = item.durationSeconds;
    const components: ConfidenceComponents = {
      metadata: baseConfidence,
      ...(expectedRuntime > 0 && actualRuntime !== undefined
        ? { runtimeSimilarity: runtimeSimilarity(actualRuntime, expectedRuntime) }
        : {})
    };
    const confidence = components.runtimeSimilarity === undefined
      ? baseConfidence
      : baseConfidence * tvEpisodeMatchingPolicy.multipartMetadataWeight +
        components.runtimeSimilarity * tvEpisodeMatchingPolicy.multipartRuntimeWeight;
    options.push({
      episodes,
      confidence,
      evidence: [
        `Metadata explicitly groups ${episodes.length} consecutive episodes as parts of one title`,
        ...(expectedRuntime > 0 && actualRuntime !== undefined
          ? [`Combined episode runtime is ${Math.round(expectedRuntime)} seconds; disc title runtime is ${Math.round(actualRuntime)} seconds`]
          : ["No combined expected runtime is available"]),
        ...validCandidates.flatMap((candidate) => candidate.evidence)
      ],
      scoreComponents: components,
      kind: "multi-part",
      multiPartGroupId: groupId
    });
  }
  return options;
}

function makeOptions(
  item: TvDiscItemResult,
  input: TvEpisodeMatchingInput,
  rejected: readonly TvEpisodeFeedback[]
): TvEpisodeMatchOption[] {
  const options = new Map<string, TvEpisodeMatchOption>();
  const multipartEpisodeKeys = new Set((input.episodeMetadata ?? [])
    .filter((candidate) => candidate.itemId === item.itemId && candidate.multiPartGroupId !== undefined)
    .map((candidate) => episodeKey(candidate.episode)));
  for (const candidate of item.candidates) {
    const episode = candidate.episode;
    if (multipartEpisodeKeys.has(episodeKey(episode))) continue;
    if (rejected.some((feedback) => feedback.episodes.length === 1 &&
      episodeKey(feedback.episodes[0]!) === episodeKey(episode))) continue;
    const enriched = candidateForEpisode(item, episode, input.episodeMetadata ?? []) ?? candidate;
    options.set(episodeKey(episode), {
      episodes: [episode],
      confidence: finiteConfidence(enriched.confidence, "Episode candidate"),
      evidence: [...new Set(enriched.evidence)].sort(),
      scoreComponents: candidateComponents(enriched),
      kind: "single"
    });
  }
  for (const candidate of input.episodeMetadata ?? []) {
    if (candidate.itemId !== item.itemId || candidate.multiPartGroupId ||
      multipartEpisodeKeys.has(episodeKey(candidate.episode))) continue;
    const confidence = finiteConfidence(candidate.confidence, "Metadata");
    const key = episodeKey(candidate.episode);
    if (rejected.some((feedback) => feedback.episodes.length === 1 &&
      episodeKey(feedback.episodes[0]!) === key)) continue;
    const existing = options.get(key);
    if (!existing || confidence > existing.confidence) {
      options.set(key, {
        episodes: [candidate.episode],
        confidence,
        evidence: [
          `Supplemental episode metadata from ${candidate.providerId}`,
          ...(candidate.evidence ?? [])
        ].sort(),
        scoreComponents: { metadata: confidence },
        kind: "single"
      });
    }
    for (const entry of input.providerDiscEpisodes ?? []) {
      if (!entry.providerId.trim() || !entry.episode.seriesId.trim() ||
        !Number.isInteger(entry.episode.seasonNumber) || entry.episode.seasonNumber < 0 ||
        !Number.isInteger(entry.episode.episodeNumber) || entry.episode.episodeNumber < 0 ||
        !Number.isInteger(entry.discNumber) || entry.discNumber < 1 ||
        !Number.isInteger(entry.discOrder) || entry.discOrder < 1) {
        throw new Error("Provider disc episode mapping is invalid");
      }
      finiteConfidence(entry.confidence, "Provider disc mapping");
    }
  }
  const multipart = multipartOptions(item, input, rejected);
  for (const option of multipart) options.set(`group:${option.multiPartGroupId}`, option);
  return [...options.values()].sort((left, right) =>
    right.confidence - left.confidence ||
    left.episodes.map(episodeKey).join("|").localeCompare(right.episodes.map(episodeKey).join("|"))
  );
}

function matchingFeedback(
  item: TvDiscItemResult,
  report: TvDiscAnalysisReport,
  feedback: readonly TvEpisodeFeedback[]
): TvEpisodeFeedback[] {
  if (!report.fingerprint) return [];
  return feedback.filter((record) =>
    record.fingerprint === report.fingerprint && record.itemSignature === item.itemSignature
  ).sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt) ||
    feedback.indexOf(right) - feedback.indexOf(left)
  );
}

function validateInput(input: TvEpisodeMatchingInput): void {
  const analysis = input.analysis;
  if (!analysis.sourceId.trim() || !analysis.manifestId.trim()) {
    throw new Error("Episode matching requires source and manifest IDs");
  }
  const itemIds = new Set<string>();
  for (const item of analysis.items) {
    if (!item.itemId.trim() || !item.itemSignature.trim()) {
      throw new Error("Episode matching items require IDs and signatures");
    }
    if (itemIds.has(item.itemId)) throw new Error(`Episode matching report contains duplicate item ID ${item.itemId}`);
    itemIds.add(item.itemId);
  }
  for (const candidate of input.episodeMetadata ?? []) {
    if (!itemIds.has(candidate.itemId)) {
      throw new Error(`Episode metadata references unknown item ${candidate.itemId}`);
    }
    if (!candidate.providerId.trim() || !candidate.episode.seriesId.trim() ||
      !Number.isInteger(candidate.episode.seasonNumber) || candidate.episode.seasonNumber < 0 ||
      !Number.isInteger(candidate.episode.episodeNumber) || candidate.episode.episodeNumber < 0) {
      throw new Error("Episode metadata contains an invalid provider or episode identity");
    }
    finiteConfidence(candidate.confidence, "Metadata");
    if (candidate.runtimeSeconds !== undefined &&
      (!Number.isFinite(candidate.runtimeSeconds) || candidate.runtimeSeconds <= 0)) {
      throw new Error("Episode metadata runtime must be a positive finite number");
    }
    if (candidate.partNumber !== undefined &&
      (!Number.isInteger(candidate.partNumber) || candidate.partNumber < 1)) {
      throw new Error("Multipart episode part number must be a positive integer");
    }
    if (candidate.partCount !== undefined &&
      (!Number.isInteger(candidate.partCount) || candidate.partCount < 2)) {
      throw new Error("Multipart episode part count must be an integer of at least 2");
    }
  }
  for (const feedback of input.feedback ?? []) {
    if (!feedback.id.trim() || !feedback.fingerprint.trim() || !feedback.itemSignature.trim() ||
      !["accepted", "rejected", "manual-assignment"].includes(feedback.outcome) ||
      feedback.episodes.length === 0) {
      throw new Error("Episode feedback record is invalid");
    }
  }
}

function episodeItemResult(
  item: TvDiscItemResult,
  analysis: TvDiscAnalysisReport,
  input: TvEpisodeMatchingInput,
  minimumConfidence: number,
  minimumMargin: number,
  strategyAssignment?: {
    episode: Episode;
    method: NonNullable<TvEpisodeMatchItemReport["assignmentMethod"]>;
    confidence: number;
    evidence: readonly string[];
  }
): TvEpisodeMatchItemReport {
  const feedback = matchingFeedback(item, analysis, input.feedback ?? []);
  const latest = feedback[0];
  const manual = latest?.outcome === "manual-assignment" ? latest : undefined;
  if (manual) {
    return {
      itemId: item.itemId,
      ...(item.title === undefined ? {} : { itemTitle: item.title }),
      decision: "manual-assignment",
      suggestedEpisodes: [...manual.episodes],
      confidence: 1,
      assignmentMethod: "user-correction",
      alternatives: [],
      evidence: [
        "Episode assignment was explicitly entered by a user",
        ...(manual.reason ? [`User correction: ${manual.reason}`] : [])
      ],
      manualReviewRequired: false
    };
  }
  const accepted = latest?.outcome === "accepted" ? latest : undefined;
  if (accepted) {
    return {
      itemId: item.itemId,
      ...(item.title === undefined ? {} : { itemTitle: item.title }),
      decision: "accepted",
      suggestedEpisodes: [...accepted.episodes],
      confidence: 1,
      assignmentMethod: "user-correction",
      alternatives: [],
      evidence: [
        "This match was explicitly accepted by a user",
        ...(accepted.reason ? [`User confirmation: ${accepted.reason}`] : [])
      ],
      manualReviewRequired: false
    };
  }

  const rejected = latest?.outcome === "rejected" ? [latest] : [];
  if (strategyAssignment) {
    const rejectedEpisode = rejected.some((record) =>
      record.episodes.some((episode) => episodeKey(episode) === episodeKey(strategyAssignment.episode))
    );
    if (!rejectedEpisode) {
      return {
        itemId: item.itemId,
        ...(item.title === undefined ? {} : { itemTitle: item.title }),
        decision: "suggested",
        suggestedEpisodes: [strategyAssignment.episode],
        confidence: strategyAssignment.confidence,
        assignmentMethod: strategyAssignment.method,
        alternatives: [],
        evidence: [...new Set([...item.evidence, ...strategyAssignment.evidence])],
        manualReviewRequired: false
      };
    }
  }
  const exactHistory = item.candidates.find((candidate) =>
    candidate.evidence.some((evidence) =>
      evidence === "Episode match is recorded for this exact disc fingerprint and item signature"
    ) && !rejected.some((record) =>
      record.episodes.some((episode) => episodeKey(episode) === episodeKey(candidate.episode))
    )
  );
  if (exactHistory) {
    return {
      itemId: item.itemId,
      ...(item.title === undefined ? {} : { itemTitle: item.title }),
      decision: "suggested",
      suggestedEpisodes: [exactHistory.episode],
      confidence: 1,
      assignmentMethod: "exact-fingerprint-history",
      alternatives: [],
      evidence: [...new Set([...item.evidence, ...exactHistory.evidence,
        "Episode assigned from exact fingerprint history."])],
      manualReviewRequired: false
    };
  }
  const options = makeOptions(item, input, rejected);
  const rejectedEvidence = rejected.map((record) =>
    `Previously rejected episode match: ${record.episodes.map((episode) => `S${episode.seasonNumber}E${episode.episodeNumber}`).join(", ")}${record.reason ? ` (${record.reason})` : ""}`
  );
  if (item.kind === "duplicate") {
    return {
      itemId: item.itemId,
      ...(item.title === undefined ? {} : { itemTitle: item.title }),
      decision: "duplicate",
      suggestedEpisodes: [],
      confidence: 0,
      alternatives: options,
      evidence: [...item.evidence, "Duplicate tracks are not independently assigned"],
      ...(item.relatedItemId ? { relatedItemId: item.relatedItemId } : {}),
      manualReviewRequired: true
    };
  }
  if (item.kind === "alternate") {
    return {
      itemId: item.itemId,
      ...(item.title === undefined ? {} : { itemTitle: item.title }),
      decision: "alternate-review",
      suggestedEpisodes: [],
      confidence: 0,
      alternatives: options,
      evidence: [...item.evidence, "Alternate versions are not automatically distinguished"],
      ...(item.relatedItemId ? { relatedItemId: item.relatedItemId } : {}),
      manualReviewRequired: true
    };
  }
  if (item.kind === "commentary") {
    return {
      itemId: item.itemId,
      ...(item.title === undefined ? {} : { itemTitle: item.title }),
      decision: "commentary",
      suggestedEpisodes: [],
      confidence: item.confidence,
      alternatives: options,
      evidence: [...item.evidence, "Commentary tracks are excluded from episode assignment"],
      manualReviewRequired: false
    };
  }
  if (item.kind === "bonus") {
    return {
      itemId: item.itemId,
      ...(item.title === undefined ? {} : { itemTitle: item.title }),
      decision: "bonus",
      suggestedEpisodes: [],
      confidence: item.confidence,
      alternatives: options,
      evidence: [...item.evidence, "Bonus material is excluded from episode assignment"],
      manualReviewRequired: false
    };
  }
  if (item.kind === "special-feature") {
    return {
      itemId: item.itemId,
      ...(item.title === undefined ? {} : { itemTitle: item.title }),
      decision: "special-feature",
      suggestedEpisodes: [],
      confidence: item.confidence,
      alternatives: options,
      evidence: [...item.evidence, "Special features are excluded from episode assignment"],
      manualReviewRequired: true
    };
  }
  const multipartIssues = validateMultipartCandidates(item, input.episodeMetadata ?? []);
  const top = options[0];
  const runnerUp = options[1];
  const margin = top ? top.confidence - (runnerUp?.confidence ?? 0) : 0;
  const insufficientConfidence = !top || top.confidence < minimumConfidence;
  const ambiguous = Boolean(top && runnerUp && margin < minimumMargin);
  if (insufficientConfidence || ambiguous) {
    return {
      itemId: item.itemId,
      ...(item.title === undefined ? {} : { itemTitle: item.title }),
      decision: "unknown",
      suggestedEpisodes: [],
      confidence: top?.confidence ?? 0,
      alternatives: options,
      evidence: [
        ...item.evidence,
        ...rejectedEvidence,
        ...multipartIssues,
        ...(insufficientConfidence
          ? [`Best candidate confidence is below the ${minimumConfidence.toFixed(2)} acceptance threshold`]
          : []),
        ...(ambiguous
          ? [`Top candidates are separated by ${margin.toFixed(2)}, below the ${minimumMargin.toFixed(2)} required margin`]
          : []),
        ...(!top ? ["No supported episode candidate is available"] : [])
      ],
      manualReviewRequired: true
    };
  }
  const selected = top;
  if (!selected) throw new Error("Episode matching selection invariant failed");
  return {
    itemId: item.itemId,
    ...(item.title === undefined ? {} : { itemTitle: item.title }),
    decision: "suggested",
    suggestedEpisodes: [...selected.episodes],
    confidence: selected.confidence,
    ...(selected.scoreComponents.runtimeSimilarity === undefined
      ? {}
      : { assignmentMethod: "runtime-matching" as const }),
    alternatives: options,
    evidence: [...new Set([...item.evidence, ...selected.evidence, ...rejectedEvidence])],
    manualReviewRequired: false
  };
}

type StrategyAssignment = NonNullable<Parameters<typeof episodeItemResult>[5]>;

function isPrimaryEpisodeTrack(item: TvDiscItemResult): boolean {
  return (item.kind === "episode-candidate" || item.kind === "unknown") &&
    (item.durationSeconds === undefined || item.durationSeconds >= 600);
}

function orderedPrimaryTracks(analysis: TvDiscAnalysisReport): TvDiscItemResult[] {
  return analysis.items.map((item, index) => ({ item, index }))
    .filter(({ item }) => isPrimaryEpisodeTrack(item))
    .sort((left, right) =>
      (left.item.trackNumber ?? left.index + 1) - (right.item.trackNumber ?? right.index + 1) ||
      left.index - right.index
    )
    .map(({ item }) => item);
}

function strategyAssignments(input: TvEpisodeMatchingInput): Map<string, StrategyAssignment> {
  const { analysis } = input;
  const primaryTracks = orderedPrimaryTracks(analysis);
  const assignments = new Map<string, StrategyAssignment>();
  const feedbackFor = (item: TvDiscItemResult): TvEpisodeFeedback | undefined =>
    matchingFeedback(item, analysis, input.feedback ?? [])[0];

  for (const item of primaryTracks) {
    const feedback = feedbackFor(item);
    if (feedback?.outcome === "accepted" || feedback?.outcome === "manual-assignment") continue;
    const exact = item.candidates.find((candidate) =>
      candidate.evidence.some((evidence) =>
        evidence === "Episode match is recorded for this exact disc fingerprint and item signature"
      ) && !feedback?.episodes.some((episode) => episodeKey(episode) === episodeKey(candidate.episode))
    );
    if (exact) {
      assignments.set(item.itemId, {
        episode: exact.episode,
        method: "exact-fingerprint-history",
        confidence: 1,
        evidence: [...exact.evidence, "Episode assigned from exact fingerprint history."]
      });
    }
  }

  const detectedSeason = analysis.detectedSeason;
  const detectedDisc = analysis.discPositionCandidates?.[0];
  const confidentlyLocated = Boolean(analysis.detectedSeries &&
    analysis.detectedSeries.confidence >= 0.9 &&
    detectedSeason && detectedSeason.confidence >= 0.9 &&
    detectedDisc && detectedDisc.confidence >= 0.9);
  if (!confidentlyLocated || !detectedSeason || !detectedDisc || primaryTracks.length === 0) {
    return assignments;
  }

  const providerGroups = new Map<string, TvProviderDiscEpisode[]>();
  for (const entry of input.providerDiscEpisodes ?? []) {
    if (entry.discNumber !== detectedDisc.discNumber ||
      entry.episode.seriesId !== detectedSeason.seriesId ||
      entry.episode.seasonNumber !== detectedSeason.season.number) continue;
    const group = providerGroups.get(entry.providerId) ?? [];
    group.push(entry);
    providerGroups.set(entry.providerId, group);
  }
  const providerMapping = [...providerGroups.values()].map((entries) =>
    entries.slice().sort((left, right) => left.discOrder - right.discOrder)
  ).find((entries) => entries.length === primaryTracks.length &&
    entries.every((entry, index) => entry.discOrder === index + 1) &&
    new Set(entries.map((entry) => episodeKey(entry.episode))).size === entries.length);

  if (providerMapping) {
    primaryTracks.forEach((item, index) => {
      if (assignments.has(item.itemId)) return;
      const entry = providerMapping[index];
      if (!entry) return;
      assignments.set(item.itemId, {
        episode: entry.episode,
        method: "provider-disc-mapping",
        confidence: 1,
        evidence: [
          `Provider disc mapping from ${entry.providerId} identifies this episode.`,
          ...(entry.evidence ?? []),
          "Episode assigned from provider disc mapping."
        ]
      });
    });
    return assignments;
  }

  const seasonEpisodes = new Map<string, Episode>();
  for (const candidate of [
    ...analysis.items.flatMap((item) => item.candidates.map((entry) => entry.episode)),
    ...(input.episodeMetadata ?? []).map((entry) => entry.episode)
  ]) {
    if (candidate.seriesId === detectedSeason.seriesId &&
      candidate.seasonNumber === detectedSeason.season.number) {
      seasonEpisodes.set(episodeKey(candidate), candidate);
    }
  }
  const orderedEpisodes = [...seasonEpisodes.values()].sort(compareEpisode);
  const continuity = detectedDisc.confidenceBreakdown.continuity;
  const range = continuity
    ? orderedEpisodes.filter((episode) =>
      !continuity.importedEpisodeRanges.some((episodeRange) =>
        episode.episodeNumber >= episodeRange.start && episode.episodeNumber <= episodeRange.end
      )
    ).slice(0, primaryTracks.length)
    : orderedEpisodes.slice(
      (detectedDisc.discNumber - 1) * primaryTracks.length,
      detectedDisc.discNumber * primaryTracks.length
    );
  if (range.length !== primaryTracks.length) return assignments;
  primaryTracks.forEach((item, index) => {
    if (assignments.has(item.itemId)) return;
    const episode = range[index];
    if (!episode) return;
    assignments.set(item.itemId, {
      episode,
      method: "sequential-disc-assignment",
      confidence: 0.9,
      evidence: ["Episode assigned using sequential disc ordering."]
    });
  });
  return assignments;
}

function reconcileConflicts(items: TvEpisodeMatchItemReport[]): TvEpisodeMatchItemReport[] {
  const claims = new Map<string, TvEpisodeMatchItemReport[]>();
  for (const item of items) {
    if (item.decision !== "suggested") continue;
    for (const episode of item.suggestedEpisodes) {
      const key = episodeKey(episode);
      const claimants = claims.get(key) ?? [];
      claimants.push(item);
      claims.set(key, claimants);
    }
  }
  const conflictedIds = new Set<string>();
  const reasons = new Map<string, string[]>();
  for (const [key, claimants] of claims) {
    if (claimants.length < 2) continue;
    for (const claimant of claimants) {
      conflictedIds.add(claimant.itemId);
      const values = reasons.get(claimant.itemId) ?? [];
      values.push(`Episode ${key} is suggested for multiple tracks; no track was selected`);
      reasons.set(claimant.itemId, values);
    }
  }
  return items.map((item) => conflictedIds.has(item.itemId) ? {
    ...item,
    decision: "unknown",
    suggestedEpisodes: [],
    evidence: [...item.evidence, ...(reasons.get(item.itemId) ?? [])],
    manualReviewRequired: true
  } : item);
}

function makeRecommendations(items: readonly TvEpisodeMatchItemReport[]): TvAnalysisRecommendation[] {
  const unknown = items.filter((item) => item.decision === "unknown");
  const duplicates = items.filter((item) => item.decision === "duplicate");
  const alternates = items.filter((item) => item.decision === "alternate-review");
  const specialFeatures = items.filter((item) => item.decision === "special-feature");
  const output: TvAnalysisRecommendation[] = [];
  if (unknown.length) {
    output.push({
      action: "review-episode-candidates",
      message: `${unknown.length} track(s) have unknown or ambiguous episode matches; review rather than force a match.`,
      relatedItemIds: unknown.map((item) => item.itemId)
    });
  }
  if (duplicates.length) {
    output.push({
      action: "review-duplicates",
      message: `${duplicates.length} duplicate track(s) require review.`,
      relatedItemIds: duplicates.map((item) => item.itemId)
    });
  }
  if (alternates.length) {
    output.push({
      action: "review-alternates",
      message: `${alternates.length} alternate version(s) require review.`,
      relatedItemIds: alternates.map((item) => item.itemId)
    });
  }
  if (items.some((item) => item.decision === "bonus" || item.decision === "commentary")) {
    const nonEpisodes = items.filter((item) => item.decision === "bonus" || item.decision === "commentary");
    output.push({
      action: "review-bonus-content",
      message: `${nonEpisodes.length} bonus or commentary track(s) were excluded from episode assignment.`,
      relatedItemIds: nonEpisodes.map((item) => item.itemId)
    });
  }
  if (specialFeatures.length) {
    output.push({
      action: "review-special-features",
      message: `${specialFeatures.length} special feature(s) require classification.`,
      relatedItemIds: specialFeatures.map((item) => item.itemId)
    });
  }
  return output;
}

export class TvEpisodeMatchingEngine {
  match(input: TvEpisodeMatchingInput): TvEpisodeMatchReport {
    validateInput(input);
    if (input.minimumConfidence !== undefined &&
      (input.minimumConfidence < 0 || input.minimumConfidence > 1)) {
      throw new Error("Minimum confidence must be between 0 and 1");
    }
    if (input.minimumMargin !== undefined &&
      (input.minimumMargin < 0 || input.minimumMargin > 1)) {
      throw new Error("Minimum margin must be between 0 and 1");
    }
    const minimumConfidence = finiteConfidence(input.minimumConfidence ?? tvEpisodeMatchingPolicy.minimumConfidence, "Minimum");
    const minimumMargin = finiteConfidence(input.minimumMargin ?? tvEpisodeMatchingPolicy.minimumMargin, "Minimum margin");
    const assignments = strategyAssignments(input);
    const items = input.analysis.items.map((item) =>
      episodeItemResult(item, input.analysis, input, minimumConfidence, minimumMargin, assignments.get(item.itemId))
    );
    const reconciled = reconcileConflicts(items);
    return {
      sourceId: input.analysis.sourceId,
      manifestId: input.analysis.manifestId,
      ...(input.analysis.fingerprint === undefined ? {} : { fingerprint: input.analysis.fingerprint }),
      items: reconciled,
      recommendations: makeRecommendations(reconciled)
    };
  }
}
