import type { MediaManifestItem } from "../domain/media.js";
import type {
  ConfidenceComponents,
  CompletedTvDiscHistory,
  EpisodeCandidate,
  EpisodeCorrection,
  HistoricalDiscAnalysis,
  Series,
  TvAnalysisInput,
  TvDiscAnalysisReport,
  TvDiscItemKind,
  TvDiscItemResult,
  TvDiscPositionCandidate,
  TvDiscRelationship,
  TvEpisodeMetadataCandidate,
  TvSeasonMatchCandidate,
  TvSeriesMatchCandidate,
  TvProviderDiscEpisode
} from "../domain/television.js";

const bonusTerms = /\b(bonus|extra|featurette|behind the scenes|trailer|deleted scene|interview|making of|gallery|easter egg)\b/i;
const commentaryTerms = /\b(commentary|audio commentary|director.?s? track|cast track)\b/i;
const alternateTerms = /\b(alternate|alternative|extended|uncut|director.?s? cut|version)\b/i;

export const tvAnalysisWeights = {
  series: { metadata: 0.6, historicalMatch: 0.3, titleSimilarity: 0.1 },
  season: { metadata: 0.55, historicalMatch: 0.3, discStructure: 0.15 },
  discPosition: { discStructure: 0.6, historicalMatch: 0.4 },
  episode: { metadata: 0.5, runtimeSimilarity: 0.2, titleSimilarity: 0.1, historicalMatch: 0.2 }
} as const;

function normalizedText(value: string): string {
  return value.normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function words(value: string): Set<string> {
  return new Set(normalizedText(value).split(/\s+/).filter(Boolean));
}

function titleSimilarity(left: string, right: string): number {
  const leftWords = words(left);
  const rightWords = words(right);
  if (leftWords.size === 0 || rightWords.size === 0) return 0;
  const overlap = [...leftWords].filter((word) => rightWords.has(word)).length;
  return overlap / new Set([...leftWords, ...rightWords]).size;
}

function cleanSeriesLabel(value: string): string {
  return value.replace(/\b(?:season|series|disc|disk|volume|vol|episodes?|television|tv)\b/gi, " ")
    .replace(/\bs\d{1,2}(?:[\s._-]*d\d{1,2})?\b/gi, " ")
    .replace(/\bd\d{1,2}\b/gi, " ")
    .replace(/\b\d+\b/g, " ")
    .replace(/\s+/g, " ").trim();
}

function checkedConfidence(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} confidence must be a finite number`);
  return Math.max(0, Math.min(1, value));
}

function checkedDuration(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} duration must be a positive finite number`);
  return value;
}

function seriesKey(series: Series): string {
  return series.id ?? normalizedText(series.title);
}

function weightedScore(components: ConfidenceComponents, weights: Readonly<Record<keyof ConfidenceComponents, number>>): number {
  let totalWeight = 0;
  let total = 0;
  for (const [key, value] of Object.entries(components) as Array<[keyof ConfidenceComponents, number | undefined]>) {
    if (value === undefined) continue;
    const weight = weights[key];
    totalWeight += weight;
    total += checkedConfidence(value, key) * weight;
  }
  return totalWeight === 0 ? 0 : total / totalWeight;
}

function itemText(item: MediaManifestItem): string {
  const values = Object.entries(item.attributes ?? {})
    .filter(([, value]) => typeof value === "string")
    .map(([key, value]) => `${key} ${value}`);
  return [item.title ?? "", ...values].join(" ");
}

export function tvItemSignature(item: MediaManifestItem): string {
  const contentFingerprint = item.attributes?.contentFingerprint;
  if (typeof contentFingerprint === "string" && contentFingerprint.trim()) {
    return `content:${normalizedText(contentFingerprint)}`;
  }
  const title = normalizedText(item.title ?? "");
  const duration = checkedDuration(item.durationSeconds, `Item ${item.id}`);
  const roundedDuration = duration === undefined ? "" : Math.round(duration / 30) * 30;
  const track = item.trackNumber === undefined ? "" : `track:${item.trackNumber}`;
  return `title:${title}|duration:${roundedDuration}|${track}`;
}

function historyRelevance(
  input: TvAnalysisInput,
  history: HistoricalDiscAnalysis[],
  itemSignatures: ReadonlySet<string>
): HistoricalDiscAnalysis[] {
  return history.filter((record) =>
    (input.fingerprint !== undefined && record.fingerprint === input.fingerprint) ||
    record.episodeMatches.some((match) => itemSignatures.has(match.itemSignature))
  );
}

function rankSeries(
  input: TvAnalysisInput,
  history: readonly HistoricalDiscAnalysis[]
): TvSeriesMatchCandidate[] {
  const byKey = new Map<string, { series: Series; metadata: number[]; historical: number[]; evidence: Set<string> }>();
  for (const candidate of input.metadata.seriesCandidates) {
    if (!candidate.series.title.trim() || !candidate.providerId.trim()) {
      throw new Error("TV metadata series candidates require a title and provider ID");
    }
    const key = seriesKey(candidate.series);
    const entry = byKey.get(key) ?? {
      series: candidate.series,
      metadata: [],
      historical: [],
      evidence: new Set<string>()
    };
    entry.metadata.push(checkedConfidence(candidate.confidence, "Series metadata"));
    entry.evidence.add(`Metadata candidate from ${candidate.providerId}`);
    for (const evidence of candidate.evidence ?? []) entry.evidence.add(evidence);
    byKey.set(key, entry);
  }
  for (const record of history) {
    const key = seriesKey(record.series);
    const entry = byKey.get(key) ?? {
      series: record.series,
      metadata: [],
      historical: [],
      evidence: new Set<string>()
    };
    const exactDisc = input.fingerprint !== undefined && record.fingerprint === input.fingerprint;
    entry.historical.push(exactDisc ? 1 : 0.65);
    entry.evidence.add(exactDisc ? "Series was confirmed for this disc fingerprint" : "Series appears in matching historical item analysis");
    byKey.set(key, entry);
  }
  const labels = [
    ...(input.discLabel ? [{ source: "Disc label", text: cleanSeriesLabel(input.discLabel) }] : []),
    ...input.manifest.items.flatMap((item) =>
      item.title ? [{ source: `Track ${item.id} title`, text: cleanSeriesLabel(item.title) }] : []
    )
  ];
  const results = [...byKey.values()].map(({ series, metadata, historical, evidence }) => {
    const titleMatches = labels.map(({ source, text }) => ({
      source,
      score: titleSimilarity(text, series.title)
    }));
    titleMatches.sort((left, right) => right.score - left.score || left.source.localeCompare(right.source));
    const bestTitleMatch = titleMatches[0];
    const labelScore = bestTitleMatch?.score;
    const components: ConfidenceComponents = {
      ...(metadata.length ? { metadata: Math.max(...metadata) } : {}),
      ...(historical.length ? { historicalMatch: Math.max(...historical) } : {}),
      ...(labelScore !== undefined ? { titleSimilarity: labelScore } : {})
    };
    if (bestTitleMatch && labelScore !== undefined && labelScore > 0) {
      evidence.add(`${bestTitleMatch.source} overlaps the series title (${labelScore.toFixed(2)})`);
    }
    return {
      series,
      confidence: weightedScore(components, {
        ...tvAnalysisWeights.series, runtimeSimilarity: 0, userCorrection: 0, discStructure: 0
      }),
      evidence: [...evidence].sort(),
      scoreComponents: components
    };
  });
  return results.sort((left, right) =>
    right.confidence - left.confidence || left.series.title.localeCompare(right.series.title)
  );
}

function rankSeasons(
  input: TvAnalysisInput,
  history: readonly HistoricalDiscAnalysis[],
  selectedSeries?: TvSeriesMatchCandidate
): TvSeasonMatchCandidate[] {
  const byNumber = new Map<number, { season: TvSeasonMatchCandidate["season"]; metadata: number[]; historical: number[]; evidence: Set<string> }>();
  for (const candidate of input.metadata.seasonCandidates) {
    if (selectedSeries && candidate.seriesId !== seriesKey(selectedSeries.series) && candidate.seriesId !== selectedSeries.series.id) continue;
    const confidence = checkedConfidence(candidate.confidence, "Season metadata");
    const entry = byNumber.get(candidate.season.number) ?? {
      season: candidate.season, metadata: [], historical: [], evidence: new Set<string>()
    };
    entry.metadata.push(confidence);
    entry.evidence.add(`Season candidate from ${candidate.providerId}`);
    for (const evidence of candidate.evidence ?? []) entry.evidence.add(evidence);
    byNumber.set(candidate.season.number, entry);
  }
  for (const record of history) {
    if (selectedSeries && seriesKey(record.series) !== seriesKey(selectedSeries.series)) continue;
    if (record.seasonNumber === undefined) continue;
    const entry = byNumber.get(record.seasonNumber) ?? {
      season: { seriesId: seriesKey(record.series), number: record.seasonNumber },
      metadata: [], historical: [], evidence: new Set<string>()
    };
    const exactDisc = input.fingerprint !== undefined && record.fingerprint === input.fingerprint;
    entry.historical.push(exactDisc ? 1 : 0.65);
    entry.evidence.add(exactDisc ? "Season was confirmed for this disc fingerprint" : "Season appears in matching historical analysis");
    byNumber.set(record.seasonNumber, entry);
  }
  if (input.disc?.seasonNumber !== undefined) {
    const number = input.disc.seasonNumber;
    const entry = byNumber.get(number) ?? {
      season: { seriesId: selectedSeries ? seriesKey(selectedSeries.series) : "", number },
      metadata: [], historical: [], evidence: new Set<string>()
    };
    entry.evidence.add("Season number supplied by disc structure");
    byNumber.set(number, entry);
  }
  for (const hint of input.discStructureHints ?? []) {
    if (hint.seasonNumber === undefined) continue;
    const entry = byNumber.get(hint.seasonNumber) ?? {
      season: {
        seriesId: selectedSeries ? seriesKey(selectedSeries.series) : "",
        number: hint.seasonNumber
      },
      metadata: [],
      historical: [],
      evidence: new Set<string>()
    };
    entry.metadata.push(checkedConfidence(hint.confidence, "Disc-label season"));
    entry.evidence.add(`Season ${hint.seasonNumber} suggested by ${hint.source}`);
    byNumber.set(hint.seasonNumber, entry);
  }
  const results = [...byNumber.entries()].map(([number, entry]) => {
    const structure = input.disc?.seasonNumber === number ? 1 : undefined;
    const components: ConfidenceComponents = {
      ...(entry.metadata.length ? { metadata: Math.max(...entry.metadata) } : {}),
      ...(entry.historical.length ? { historicalMatch: Math.max(...entry.historical) } : {}),
      ...(structure === undefined ? {} : { discStructure: structure })
    };
    return {
      seriesId: entry.season.seriesId || (selectedSeries ? seriesKey(selectedSeries.series) : ""),
      season: entry.season,
      confidence: weightedScore(components, {
        ...tvAnalysisWeights.season, titleSimilarity: 0, runtimeSimilarity: 0, userCorrection: 0
      }),
      evidence: [...entry.evidence].sort(),
      scoreComponents: components
    };
  });
  return results.sort((left, right) =>
    right.confidence - left.confidence || left.season.number - right.season.number
  );
}

function rankDiscPositions(
  input: TvAnalysisInput,
  history: readonly HistoricalDiscAnalysis[],
  selectedSeries?: TvSeriesMatchCandidate,
  selectedSeason?: TvSeasonMatchCandidate
): TvDiscPositionCandidate[] {
  const candidates = new Map<number, {
    discCount?: number;
    structure: number[];
    historical: number[];
    metadata: number[];
    evidence: Set<string>;
    completed: CompletedTvDiscHistory[];
  }>();
  const candidateFor = (discNumber: number) => {
    const entry = candidates.get(discNumber) ?? {
      structure: [],
      historical: [],
      metadata: [],
      evidence: new Set<string>(),
      completed: []
    };
    candidates.set(discNumber, entry);
    return entry;
  };
  if (input.disc?.discNumber !== undefined) {
    const entry = candidateFor(input.disc.discNumber);
    entry.structure.push(1);
    entry.evidence.add("Disc number supplied by disc structure");
    if (input.disc.discCount !== undefined) entry.discCount = input.disc.discCount;
  }
  const discHints = (input.discStructureHints ?? []).filter((hint) => hint.discNumber !== undefined);
  for (const hint of discHints) {
    const discNumber = hint.discNumber;
    if (discNumber === undefined) continue;
    const entry = candidateFor(discNumber);
    entry.metadata.push(checkedConfidence(hint.confidence, "Disc-label position"));
    entry.evidence.add(`Disc ${discNumber} suggested by ${hint.source}`);
    if (hint.discCount !== undefined) entry.discCount = hint.discCount;
  }
  const seriesIdentity = selectedSeries?.series;
  const seasonNumber = selectedSeason?.season.number;
  const completedHistory = (input.completedDiscHistory ?? []).filter((record) => {
    if (!seriesIdentity || seasonNumber === undefined || record.seasonNumber !== seasonNumber) return false;
    const normalizedSeries = normalizedText(seriesIdentity.title);
    const normalizedHistory = normalizedText(record.seriesName);
    const providerIdentityMatches = input.metadata.seriesCandidates.some((candidate) =>
      seriesKey(candidate.series) === seriesKey(seriesIdentity) &&
      candidate.providerId === record.metadataProvider &&
      candidate.series.id !== undefined && candidate.series.id === record.providerId
    );
    return providerIdentityMatches || normalizedSeries === normalizedHistory;
  });
  const relevantHistory = completedHistory.filter((record) => record.discNumber !== null);
  for (const mapping of input.providerDiscEpisodes ?? []) {
    if (selectedSeason && (mapping.episode.seriesId !== selectedSeason.seriesId ||
      mapping.episode.seasonNumber !== selectedSeason.season.number)) continue;
    const entry = candidateFor(mapping.discNumber);
    entry.metadata.push(checkedConfidence(mapping.confidence, "Provider disc position"));
    entry.evidence.add(`Disc ${mapping.discNumber} has DVD ordering metadata from ${mapping.providerId}`);
  }
  for (const record of history) {
    if (record.discNumber === undefined) continue;
    const entry = candidateFor(record.discNumber);
    const exactDisc = input.fingerprint !== undefined && record.fingerprint === input.fingerprint;
    entry.historical.push(exactDisc ? 1 : 0.65);
    entry.evidence.add(exactDisc
      ? "Disc position was confirmed for this disc fingerprint"
      : "Disc position appears in matching historical item analysis");
    if (record.discCount !== undefined) entry.discCount = record.discCount;
  }
  for (const record of relevantHistory) {
    if (record.discNumber === null) continue;
    const entry = candidateFor(record.discNumber);
    entry.completed.push(record);
    const exactFingerprint = input.fingerprint === record.fingerprint;
    entry.historical.push(exactFingerprint ? 1 : 0.65);
    entry.evidence.add(exactFingerprint
      ? `Disc ${record.discNumber} was already completed for this fingerprint`
      : `Disc ${record.discNumber} was previously completed on ${record.completedAt}`);
  }
  const hasLabelDiscNumber = discHints.length > 0;
  const currentDiscWasCompleted = input.disc?.discNumber !== undefined &&
    relevantHistory.some((record) => record.discNumber === input.disc?.discNumber &&
      record.fingerprint !== input.fingerprint);
  if (!hasLabelDiscNumber && currentDiscWasCompleted && relevantHistory.length > 0) {
    const completedNumbers = new Set(relevantHistory.flatMap((record) =>
      record.discNumber === null ? [] : [record.discNumber]
    ));
    let nextDiscNumber = 1;
    while (completedNumbers.has(nextDiscNumber)) nextDiscNumber += 1;
    const next = candidateFor(nextDiscNumber);
    next.historical.push(0.85);
    next.evidence.add(`Disc ${nextDiscNumber} is the next unprocessed position in completed-disc history`);
  }
  const strongestDiscHint = discHints.slice().sort((left, right) =>
    right.confidence - left.confidence || left.source.localeCompare(right.source)
  )[0];
  const strongestDiscHints = strongestDiscHint
    ? discHints.filter((hint) => strongestDiscHint.confidence - hint.confidence <= 0.05)
    : [];
  const hasConflictingStrongHints = new Set(strongestDiscHints.map((hint) => hint.discNumber)).size > 1;
  return [...candidates.entries()].map(([discNumber, entry]) => {
    const components: ConfidenceComponents = {
      ...(entry.structure.length ? { discStructure: Math.max(...entry.structure) } : {}),
      ...(entry.historical.length ? { historicalMatch: Math.max(...entry.historical) } : {}),
      ...(entry.metadata.length ? { metadata: Math.max(...entry.metadata) } : {})
    };
    let confidence = weightedScore(components, {
      ...tvAnalysisWeights.discPosition,
      metadata: 0.4,
      discStructure: 0.35,
      historicalMatch: 0.25,
      titleSimilarity: 0,
      runtimeSimilarity: 0,
      userCorrection: 0
    });
    const exactFingerprintHistory = entry.completed.some((record) => record.fingerprint === input.fingerprint);
    const mappedEpisodes = new Set((input.providerDiscEpisodes ?? [])
      .filter((mapping) => mapping.discNumber === discNumber &&
        (!selectedSeason || (mapping.episode.seriesId === selectedSeason.seriesId &&
          mapping.episode.seasonNumber === selectedSeason.season.number)))
      .map((mapping) => `${mapping.episode.seriesId}:${mapping.episode.seasonNumber}:${mapping.episode.episodeNumber}`));
    const importedEpisodes = new Set(completedHistory.flatMap((record) =>
      record.episodes.map((episode) =>
        `${episode.seriesId}:${episode.seasonNumber}:${episode.episodeNumber}`
      )
    ));
    const overlap = mappedEpisodes.size === 0 ? 0 :
      [...mappedEpisodes].filter((episode) => importedEpisodes.has(episode)).length / mappedEpisodes.size;
    const missingCoverage = mappedEpisodes.size === 0 ? 0 :
      [...mappedEpisodes].filter((episode) => !importedEpisodes.has(episode)).length / mappedEpisodes.size;
    if (!exactFingerprintHistory) {
      const historyPenalty = (entry.completed.length > 0 ? 0.45 : 0) + overlap * 0.45;
      if (historyPenalty > 0) {
        confidence *= Math.max(0.05, 1 - historyPenalty);
        entry.evidence.add("Previously completed disc positions and episode sets reduce confidence");
      }
      if (importedEpisodes.size > 0 && missingCoverage > 0) {
        confidence = Math.min(1, confidence + missingCoverage * 0.1);
        entry.evidence.add("Unimported episodes increase confidence for this disc position");
      }
    }
    const conflictsWithLabel = strongestDiscHint !== undefined &&
      !hasConflictingStrongHints && strongestDiscHint.discNumber !== discNumber;
    if (!input.discNumberUserConfirmed && !exactFingerprintHistory && conflictsWithLabel) {
      confidence *= 0.25;
      entry.evidence.add(`Disc ${discNumber} conflicts with the strongest parsed disc label`);
    }
    if (mappedEpisodes.size > 0 && missingCoverage > 0) {
      entry.evidence.add("Provider disc mapping includes episodes not found in completed-disc history");
    }
    return {
      discNumber,
      ...(entry.discCount === undefined ? {} : { discCount: entry.discCount }),
      confidence: checkedConfidence(confidence, "Disc position"),
      evidence: [...entry.evidence].sort(),
      scoreComponents: components
    };
  }).sort((left, right) =>
    right.confidence - left.confidence || left.discNumber - right.discNumber
  );
}

function classifyItem(item: MediaManifestItem, candidateCount: number): { kind: TvDiscItemKind; evidence: string[] } {
  const text = itemText(item);
  if (commentaryTerms.test(text)) return { kind: "commentary", evidence: ["Title or attributes identify a commentary track"] };
  if (bonusTerms.test(text)) return { kind: "bonus", evidence: ["Title or attributes identify bonus material"] };
  if (item.kind.toLowerCase().includes("bonus") || item.kind.toLowerCase().includes("extra")) {
    return { kind: "bonus", evidence: ["Manifest classifies this item as an extra"] };
  }
  if (item.kind.toLowerCase().includes("special") || item.durationSeconds !== undefined && item.durationSeconds < 300) {
    return { kind: "special-feature", evidence: ["Manifest kind or short runtime suggests a special feature"] };
  }
  if (candidateCount > 0 || (item.durationSeconds !== undefined && item.durationSeconds >= 600)) {
    return { kind: "episode-candidate", evidence: [candidateCount > 0 ? "Episode metadata candidates are available" : "Runtime is within a plausible episode range"] };
  }
  return { kind: "unknown", evidence: ["No metadata or structural evidence identifies this item"] };
}

function runtimeSimilarity(actual: number, expected: number): number {
  const relativeDifference = Math.abs(actual - expected) / Math.max(actual, expected);
  return Math.max(0, 1 - relativeDifference);
}

const duplicateStructureKeys = {
  chapters: ["chapterStructure", "chapterDurations", "chapterCount", "chapters"],
  streams: ["streamLayout", "streamCount", "audioStreamCount", "subtitleStreamCount", "videoStreamCount"],
  video: ["videoProperties", "videoCodec", "width", "height", "frameRate", "videoBitrate"],
  playback: ["playbackStructure", "playlistStructure", "contentFingerprint"]
} as const;

function matchingStructure(
  left: MediaManifestItem,
  right: MediaManifestItem,
  keys: readonly string[]
): boolean {
  const leftAttributes = left.attributes ?? {};
  const rightAttributes = right.attributes ?? {};
  const shared = keys.filter((key) => leftAttributes[key] !== undefined && rightAttributes[key] !== undefined);
  return shared.length > 0 && shared.every((key) =>
    JSON.stringify(leftAttributes[key]) === JSON.stringify(rightAttributes[key])
  );
}

function duplicateStructureMatches(left: MediaManifestItem, right: MediaManifestItem): boolean {
  return Object.values(duplicateStructureKeys).every((keys) => matchingStructure(left, right, keys));
}

function primaryEpisodeItems(items: readonly MediaManifestItem[]): MediaManifestItem[] {
  const primary: MediaManifestItem[] = [];
  for (const item of items) {
    const kind = classifyItem(item, 0).kind;
    if ((kind !== "episode-candidate" && kind !== "unknown") ||
      (item.durationSeconds !== undefined && item.durationSeconds < 600)) continue;
    const duplicate = primary.some((existing) =>
      existing.durationSeconds !== undefined && item.durationSeconds !== undefined &&
      runtimeSimilarity(existing.durationSeconds, item.durationSeconds) >= 0.97 &&
      duplicateStructureMatches(existing, item) &&
      !alternateTerms.test(`${existing.title ?? ""} ${item.title ?? ""}`)
    );
    if (!duplicate) primary.push(item);
  }
  return primary;
}

function hasCompleteProviderDiscMapping(
  input: TvAnalysisInput,
  series: TvSeriesMatchCandidate | undefined,
  season: TvSeasonMatchCandidate | undefined,
  discNumber: number | undefined
): boolean {
  if (!series || series.confidence < 0.9 || !season || season.confidence < 0.9 ||
    !discNumber || primaryEpisodeItems(input.manifest.items).length === 0) return false;
  const primaryCount = primaryEpisodeItems(input.manifest.items).length;
  const providers = new Map<string, TvProviderDiscEpisode[]>();
  for (const mapping of input.providerDiscEpisodes ?? []) {
    if (mapping.discNumber !== discNumber ||
      mapping.episode.seriesId !== season.seriesId ||
      mapping.episode.seasonNumber !== season.season.number) continue;
    const entries = providers.get(mapping.providerId) ?? [];
    entries.push(mapping);
    providers.set(mapping.providerId, entries);
  }
  return [...providers.values()].some((entries) => {
    const ordered = entries.slice().sort((left, right) => left.discOrder - right.discOrder);
    return ordered.length === primaryCount &&
      ordered.every((entry, index) => entry.discOrder === index + 1) &&
      new Set(ordered.map((entry) =>
        `${entry.episode.seriesId}:${entry.episode.seasonNumber}:${entry.episode.episodeNumber}`
      )).size === ordered.length;
  });
}

function rankEpisodes(
  item: MediaManifestItem,
  input: TvAnalysisInput,
  history: readonly HistoricalDiscAnalysis[],
  correction: EpisodeCorrection | undefined,
  selectedSeries?: TvSeriesMatchCandidate,
  skipMetadataRanking = false
): EpisodeCandidate[] {
  const signature = tvItemSignature(item);
  const historicalMatches = history.flatMap((record) => record.episodeMatches
    .filter((match) => match.itemSignature === signature)
    .map((match) => ({
      ...match,
      series: record.series,
      seasonNumber: record.seasonNumber,
      fingerprint: record.fingerprint
    })));
  const byEpisode = new Map<string, {
    episode: TvEpisodeMetadataCandidate["episode"];
    metadata: number[];
    runtime: number[];
    title: number[];
    historical: number[];
    corrected: boolean;
    evidence: Set<string>;
    releaseId?: string;
    multiPartGroupId?: string;
    partNumber?: number;
    partCount?: number;
  }>();
  const metadataCandidates = input.metadata.episodeCandidates.filter((candidate) => candidate.itemId === item.id);
  for (const candidate of skipMetadataRanking ? [] : metadataCandidates) {
    if (selectedSeries && candidate.episode.seriesId !== seriesKey(selectedSeries.series) &&
      candidate.episode.seriesId !== selectedSeries.series.id) continue;
    const key = `${candidate.episode.seriesId}:${candidate.episode.seasonNumber}:${candidate.episode.episodeNumber}`;
    const entry = byEpisode.get(key) ?? {
      episode: candidate.episode,
      metadata: [],
      runtime: [],
      title: [],
      historical: [],
      corrected: false,
      evidence: new Set<string>()
    };
    entry.metadata.push(checkedConfidence(candidate.confidence, "Episode metadata"));
    const expectedRuntime = checkedDuration(candidate.runtimeSeconds, "Episode metadata");
    const actualRuntime = checkedDuration(item.durationSeconds, `Item ${item.id}`);
    if (expectedRuntime !== undefined && actualRuntime !== undefined) {
      entry.runtime.push(runtimeSimilarity(actualRuntime, expectedRuntime));
      entry.evidence.add(`Runtime differs from metadata by ${Math.round(Math.abs(actualRuntime - expectedRuntime))} seconds`);
    }
    if (item.title && candidate.episode.title) {
      const similarity = titleSimilarity(item.title, candidate.episode.title);
      entry.title.push(similarity);
      entry.evidence.add(`Track title similarity is ${similarity.toFixed(2)}`);
    }
    entry.evidence.add(`Episode candidate from ${candidate.providerId}`);
    for (const evidence of candidate.evidence ?? []) entry.evidence.add(evidence);
    if (candidate.releaseId !== undefined) entry.releaseId = candidate.releaseId;
    if (candidate.multiPartGroupId !== undefined) entry.multiPartGroupId = candidate.multiPartGroupId;
    if (candidate.partNumber !== undefined) entry.partNumber = candidate.partNumber;
    if (candidate.partCount !== undefined) entry.partCount = candidate.partCount;
    byEpisode.set(key, entry);
  }
  for (const match of historicalMatches) {
    if (selectedSeries && seriesKey(match.series) !== seriesKey(selectedSeries.series)) continue;
    const key = `${match.episode.seriesId}:${match.episode.seasonNumber}:${match.episode.episodeNumber}`;
    const entry = byEpisode.get(key) ?? {
      episode: match.episode,
      metadata: [], runtime: [], title: [], historical: [], corrected: false, evidence: new Set<string>()
    };
    entry.historical.push(checkedConfidence(match.confidence, "Historical episode"));
    entry.evidence.add(match.fingerprint === input.fingerprint
      ? "Episode match is recorded for this exact disc fingerprint and item signature"
      : "Episode match appears in prior analysis of this item signature");
    byEpisode.set(key, entry);
  }
  if (correction) {
    const key = `${correction.episode.seriesId}:${correction.episode.seasonNumber}:${correction.episode.episodeNumber}`;
    const entry = byEpisode.get(key) ?? {
      episode: correction.episode, metadata: [], runtime: [], title: [], historical: [], corrected: false, evidence: new Set<string>()
    };
    entry.corrected = true;
    entry.evidence.add(correction.reason?.trim()
      ? `Previously corrected by the user: ${correction.reason.trim()}`
      : "Previously corrected by the user for this disc fingerprint and item signature");
    byEpisode.set(key, entry);
  }
  return [...byEpisode.values()].map((entry) => {
    const components: ConfidenceComponents = {
      ...(entry.metadata.length ? { metadata: Math.max(...entry.metadata) } : {}),
      ...(entry.runtime.length ? { runtimeSimilarity: Math.max(...entry.runtime) } : {}),
      ...(entry.title.length ? { titleSimilarity: Math.max(...entry.title) } : {}),
      ...(entry.historical.length ? { historicalMatch: Math.max(...entry.historical) } : {}),
      ...(entry.corrected ? { userCorrection: 1 } : {})
    };
    const confidence = entry.corrected ? 1 : weightedScore(components, {
      ...tvAnalysisWeights.episode, userCorrection: 0, discStructure: 0
    });
    return {
      episode: entry.episode,
      confidence,
      evidence: [...entry.evidence].sort(),
      scoreComponents: components,
      matchedItemId: item.id,
      ...(entry.releaseId === undefined ? {} : { releaseId: entry.releaseId }),
      ...(entry.multiPartGroupId === undefined ? {} : { multiPartGroupId: entry.multiPartGroupId }),
      ...(entry.partNumber === undefined ? {} : { partNumber: entry.partNumber }),
      ...(entry.partCount === undefined ? {} : { partCount: entry.partCount }),
      ...(entry.corrected ? { matchKind: "standard" as const } :
        entry.episode.seasonNumber === 0 ? { matchKind: "special" as const } : {})
    };
  }).sort((left, right) =>
    right.confidence - left.confidence ||
    left.episode.seasonNumber - right.episode.seasonNumber ||
    left.episode.episodeNumber - right.episode.episodeNumber
  );
}

function detectRelationships(items: readonly TvDiscItemResult[], manifestItems: readonly MediaManifestItem[]): {
  duplicates: TvDiscRelationship[];
  alternates: TvDiscRelationship[];
} {
  const duplicates: TvDiscRelationship[] = [];
  const alternates: TvDiscRelationship[] = [];
  for (let leftIndex = 0; leftIndex < items.length; leftIndex += 1) {
    const left = items[leftIndex];
    const leftManifest = manifestItems[leftIndex];
    if (!left || !leftManifest) continue;
    if (["bonus", "commentary", "special-feature"].includes(left.kind)) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < items.length; rightIndex += 1) {
      const right = items[rightIndex];
      const rightManifest = manifestItems[rightIndex];
      if (!right || !rightManifest) continue;
      if (["bonus", "commentary", "special-feature"].includes(right.kind)) continue;
      const leftTop = left.candidates[0];
      const rightTop = right.candidates[0];
      const sameEpisode = leftTop && rightTop &&
        leftTop.episode.seriesId === rightTop.episode.seriesId &&
        leftTop.episode.seasonNumber === rightTop.episode.seasonNumber &&
        leftTop.episode.episodeNumber === rightTop.episode.episodeNumber;
      const leftDuration = leftManifest.durationSeconds;
      const rightDuration = rightManifest.durationSeconds;
      const durationSimilarity = leftDuration !== undefined && rightDuration !== undefined
        ? runtimeSimilarity(leftDuration, rightDuration)
        : 0;
      const titleSimilarityScore = titleSimilarity(left.title ?? "", right.title ?? "");
      const structureMatches = duplicateStructureMatches(leftManifest, rightManifest);
      if (durationSimilarity >= 0.97 && structureMatches &&
        !alternateTerms.test(`${left.title ?? ""} ${right.title ?? ""}`)) {
        const evidence = [
          "Runtime differs by no more than 3%",
          "Chapter structure, stream layout, video properties, and playback structure match",
          ...(titleSimilarityScore >= 0.85 ? [`Track titles are highly similar (${titleSimilarityScore.toFixed(2)})`] : []),
        ];
        duplicates.push({
          itemId: right.itemId,
          relatedItemId: left.itemId,
          confidence: 0.99,
          evidence: evidence.sort()
        });
      } else if ((sameEpisode || titleSimilarityScore >= 0.7) &&
        (durationSimilarity < 0.97 || alternateTerms.test(`${left.title ?? ""} ${right.title ?? ""}`))) {
        alternates.push({
          itemId: right.itemId,
          relatedItemId: left.itemId,
          confidence: sameEpisode ? 0.85 : Math.max(0.6, titleSimilarityScore),
          evidence: [
            ...(sameEpisode ? ["Both items rank the same episode highest"] : [`Track titles are related (${titleSimilarityScore.toFixed(2)})`]),
            ...(durationSimilarity < 0.97 && leftDuration !== undefined && rightDuration !== undefined
              ? ["Runtime difference suggests an alternate cut or edit"] : []),
            ...(alternateTerms.test(`${left.title ?? ""} ${right.title ?? ""}`)
              ? ["Title contains alternate-version wording"] : [])
          ]
        });
      }
    }
  }
  return { duplicates, alternates };
}

function recommendations(
  series: TvSeriesMatchCandidate[],
  seasons: TvSeasonMatchCandidate[],
  disc: TvAnalysisInput["disc"],
  items: readonly TvDiscItemResult[],
  duplicates: readonly TvDiscRelationship[],
  alternates: readonly TvDiscRelationship[]
): TvDiscAnalysisReport["recommendations"] {
  const output: TvDiscAnalysisReport["recommendations"][number][] = [];
  if (!series[0] || series[0].confidence < 0.75) {
    output.push({ action: "confirm-series", message: "Confirm the series identity; the available evidence is inconclusive." });
  }
  if (!seasons[0] || seasons[0].confidence < 0.7) {
    output.push({ action: "confirm-season", message: "Confirm the season; no season candidate has strong support." });
  }
  if (disc?.discNumber === undefined) {
    output.push({ action: "confirm-disc-position", message: "Record the disc position in the season if known." });
  }
  const uncertainEpisodes = items.filter((item) =>
    item.kind === "episode-candidate" && (!item.candidates[0] || item.candidates[0].confidence < 0.7)
  );
  if (uncertainEpisodes.length > 0) {
    output.push({
      action: "review-episode-candidates",
      message: `${uncertainEpisodes.length} episode track(s) need review; no episode assignment has been made.`,
      relatedItemIds: uncertainEpisodes.map((item) => item.itemId)
    });
  }
  if (duplicates.length > 0) {
    output.push({
      action: "review-duplicates",
      message: `${duplicates.length} probable duplicate relationship(s) need confirmation.`,
      relatedItemIds: [...new Set(duplicates.flatMap((item) => [item.itemId, item.relatedItemId]))]
    });
  }
  if (alternates.length > 0) {
    output.push({
      action: "review-alternates",
      message: `${alternates.length} probable alternate-version relationship(s) need confirmation.`,
      relatedItemIds: [...new Set(alternates.flatMap((item) => [item.itemId, item.relatedItemId]))]
    });
  }
  const bonus = items.filter((item) => item.kind === "bonus" || item.kind === "commentary");
  if (bonus.length > 0) {
    output.push({
      action: "review-bonus-content",
      message: `${bonus.length} item(s) appear to be bonus content or commentary.`,
      relatedItemIds: bonus.map((item) => item.itemId)
    });
  }
  const specialFeatures = items.filter((item) => item.kind === "special-feature");
  if (specialFeatures.length > 0) {
    output.push({
      action: "review-special-features",
      message: `${specialFeatures.length} short or explicitly special item(s) need classification.`,
      relatedItemIds: specialFeatures.map((item) => item.itemId)
    });
  }
  return output;
}

export class TvAnalysisEngine {
  analyze(input: TvAnalysisInput): TvDiscAnalysisReport {
    if (!input.sourceId.trim() || !input.manifestId.trim()) {
      throw new Error("TV analysis requires source and manifest IDs");
    }
    if (!input.manifest.mediaKind.trim()) throw new Error("TV analysis requires a media kind");
    if (input.disc?.discNumber !== undefined && (!Number.isInteger(input.disc.discNumber) || input.disc.discNumber < 1)) {
      throw new Error("Disc number must be a positive integer");
    }
    if (input.disc?.discCount !== undefined && (!Number.isInteger(input.disc.discCount) || input.disc.discCount < 1)) {
      throw new Error("Disc count must be a positive integer");
    }
    const seenIds = new Set<string>();
    for (const item of input.manifest.items) {
      if (!item.id.trim()) throw new Error("TV analysis manifest items require IDs");
      if (seenIds.has(item.id)) throw new Error(`TV analysis manifest contains duplicate item ID ${item.id}`);
      seenIds.add(item.id);
      checkedDuration(item.durationSeconds, `Item ${item.id}`);
    }

    const signatures = new Set(input.manifest.items.map(tvItemSignature));
    const history = historyRelevance(input, [...(input.history ?? [])], signatures);
    const corrections = (input.corrections ?? []).filter((correction) =>
      input.fingerprint !== undefined &&
      correction.fingerprint === input.fingerprint &&
      signatures.has(correction.itemSignature)
    );
    const seriesCandidates = rankSeries(input, history);
    const detectedSeries = seriesCandidates[0];
    const seasonCandidates = rankSeasons(input, history, detectedSeries);
    const detectedSeason = seasonCandidates[0];
    const discPositionCandidates = rankDiscPositions(input, history, detectedSeries, detectedSeason);
    const discPosition = discPositionCandidates[0];
    const disc = {
      ...input.disc,
      ...(discPosition ? { discNumber: discPosition.discNumber } : {}),
      ...(input.disc?.discCount === undefined && discPosition?.discCount !== undefined
        ? { discCount: discPosition.discCount }
        : {})
    };
    const skipRuntimeRanking = hasCompleteProviderDiscMapping(
        input, detectedSeries, detectedSeason, disc.discNumber
    );
    const items: TvDiscItemResult[] = input.manifest.items.map((item) => {
        const correction = corrections.find((candidate) => candidate.itemSignature === tvItemSignature(item));
        const candidates = rankEpisodes(item, input, history, correction, detectedSeries, skipRuntimeRanking);
      const classification = classifyItem(item, candidates.length);
      return {
        itemId: item.id,
        itemSignature: tvItemSignature(item),
        ...(item.durationSeconds === undefined ? {} : { durationSeconds: item.durationSeconds }),
        ...(item.title === undefined ? {} : { title: item.title }),
        kind: classification.kind,
        ...(item.trackNumber === undefined ? {} : { trackNumber: item.trackNumber }),
        ...(item.attributes === undefined ? {} : { attributes: item.attributes }),
        confidence: candidates[0]?.confidence ?? (classification.kind === "bonus" || classification.kind === "commentary" ? 0.8 : 0.45),
        evidence: [...new Set([...classification.evidence, ...(candidates[0]?.evidence ?? [])])],
        candidates
      };
    });
    const relationships = detectRelationships(items, input.manifest.items);
    const duplicateByItem = new Map(relationships.duplicates.map((relationship) => [relationship.itemId, relationship]));
    const alternateByItem = new Map(relationships.alternates.map((relationship) => [relationship.itemId, relationship]));
    const classifiedItems = items.map((item): TvDiscItemResult => {
      const duplicate = duplicateByItem.get(item.itemId);
      if (duplicate) return { ...item, kind: "duplicate", relatedItemId: duplicate.relatedItemId, evidence: [...item.evidence, ...duplicate.evidence] };
      const alternate = alternateByItem.get(item.itemId);
      if (alternate) return { ...item, kind: "alternate", relatedItemId: alternate.relatedItemId, evidence: [...item.evidence, ...alternate.evidence] };
      return item;
    });
    const probableEpisodes = classifiedItems.flatMap((item) =>
      item.kind === "episode-candidate" ? item.candidates : []
    ).sort((left, right) =>
      right.confidence - left.confidence || (left.matchedItemId ?? "").localeCompare(right.matchedItemId ?? "")
    );
    const finalRecommendations = recommendations(
      seriesCandidates,
      seasonCandidates,
      disc,
      classifiedItems,
      relationships.duplicates,
      relationships.alternates
    );
    return {
      sourceId: input.sourceId,
      manifestId: input.manifestId,
      ...(input.fingerprint === undefined ? {} : { fingerprint: input.fingerprint }),
      ...(detectedSeries === undefined ? {} : { detectedSeries }),
      seriesCandidates,
      ...(detectedSeason === undefined ? {} : { detectedSeason }),
      seasonCandidates,
      disc,
      discPositionCandidates,
      items: classifiedItems,
      probableEpisodes,
      probableDuplicates: relationships.duplicates,
      probableAlternates: relationships.alternates,
      probableBonusContent: classifiedItems.filter((item) => item.kind === "bonus"),
      commentaryTracks: classifiedItems.filter((item) => item.kind === "commentary"),
      specialFeatures: classifiedItems.filter((item) => item.kind === "special-feature"),
      recommendations: finalRecommendations
    };
  }
}
