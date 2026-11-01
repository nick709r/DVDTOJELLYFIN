import type { ReviewJob, ReviewJobRepository } from "../domain/review-jobs.js";
import {
  tvMatchingProgress,
  type TvMatchingAssignment,
  type TvMatchingContinuationSource,
  type TvMatchingTask,
  type TvMatchingTaskRepository
} from "../domain/tv-matching.js";
import type { TvProcessingPlan, TvProcessingPlanRepository } from "../domain/television.js";
import type { DiscRecovery, DiscRecoveryRepository, MetadataProviderId } from "../domain/disc-recovery.js";
import {
  MediaReviewError,
  type MediaReviewCompletion,
  type MediaReviewCompletionResult,
  type MediaReviewContinuation,
  type MediaReviewItem,
  type MediaReviewItemAdapter,
  type MediaReviewStatus,
  type MediaReviewTvDetails,
  type ReviewCandidate
} from "../domain/media-review.js";
import { isGeneratedUnknownTitle } from "../media.js";
import { log } from "../logger.js";

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function clampConfidence(value: unknown): number {
  return Math.max(0, Math.min(1, finiteNumber(value) ?? 0));
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/**
 * Converts stored movie candidates, including shapes written by earlier versions (bare strings, missing ids,
 * string confidences, `name` instead of `title`), into the shared candidate model.
 */
export function convertStoredCandidates(value: unknown): { candidates: ReviewCandidate[]; repaired: boolean } {
  if (!Array.isArray(value)) return { candidates: [], repaired: value !== undefined && value !== null };
  let repaired = false;
  const candidates: ReviewCandidate[] = [];
  for (const entry of value) {
    const record = typeof entry === "string" ? { title: entry } : recordOf(entry);
    const title = text(record?.title) ?? text(record?.name);
    if (!record || !title) {
      repaired = true;
      continue;
    }
    const id = text(record.id) ?? (typeof record.id === "number" ? String(record.id) : undefined);
    const provider = text(record.providerId) ?? text(record.provider);
    const year = finiteNumber(record.year);
    const poster = text(record.poster) ?? text(record.posterUrl);
    const overview = text(record.overview);
    if (typeof entry === "string" || id === undefined || typeof record.confidence !== "number" ||
      record.title === undefined) repaired = true;
    candidates.push({
      id: id ?? title,
      title,
      confidence: clampConfidence(record.confidence),
      ...(provider ? { provider } : {}),
      ...(year === undefined ? {} : { year }),
      ...(poster ? { poster } : {}),
      ...(overview ? { overview } : {})
    });
  }
  return { candidates: candidates.sort((left, right) => right.confidence - left.confidence), repaired };
}

const reviewJobStatuses: Record<ReviewJob["status"], MediaReviewStatus> = {
  pending: "pending",
  processing: "processing",
  retrying: "processing",
  completed: "completed",
  dismissed: "dismissed"
};

export interface ReviewJobItemActions {
  updateMetadata(id: string, patch: Readonly<Record<string, unknown>>): Promise<unknown>;
  /** Validates that processing can resume and starts it; throws MediaReviewError when it cannot. */
  resume(jobId: string): Promise<void> | void;
}

/** Review workspaces (preserved media awaiting a decision). Covers movie identification and processing reviews. */
export class ReviewJobItemAdapter implements MediaReviewItemAdapter {
  readonly sourceKind = "review-job" as const;

  constructor(
    private readonly jobs: Pick<ReviewJobRepository, "get" | "list">,
    private readonly actions: () => ReviewJobItemActions | undefined
  ) {}

  list(): MediaReviewItem[] {
    return this.jobs.list().filter((job) => job.notificationActive).map((job) => this.toItem(job));
  }

  get(sourceId: string): MediaReviewItem | undefined {
    const job = this.jobs.get(sourceId);
    return job ? this.toItem(job) : undefined;
  }

  async complete(sourceId: string, input: MediaReviewCompletion): Promise<MediaReviewCompletionResult> {
    const job = this.jobs.get(sourceId);
    if (!job) throw new MediaReviewError("not-found", "Review item not found");
    if (job.status !== "pending") throw new MediaReviewError("conflict", `Cannot complete a ${job.status} review`);
    const item = this.toItem(job);
    const candidateId = text(input.candidateId);
    const chosen = candidateId ? item.candidates.find((candidate) => candidate.id === candidateId) : undefined;
    if (candidateId && !chosen) {
      log("warn", "review-queue", "Rejected completion with a candidate that is not part of the review", {
        id: item.id, candidateId
      });
      throw new MediaReviewError("invalid", "The selected candidate is not part of this review");
    }
    const title = text(input.title) ?? chosen?.title ?? "";
    const actions = this.actions();
    const storedTitle = item.metadata?.title;
    if (!title && (job.metadata.movieIdentificationConfirmed === true ||
      (item.kind === "processing" && storedTitle !== undefined))) {
      // Nothing left to decide: continue with the title that is already confirmed or stored.
      if (!actions) throw new MediaReviewError("unavailable", "Review workspace service is unavailable");
      await actions.resume(job.id);
      return { item: this.get(sourceId) ?? item, continuation: "started" };
    }
    if (!title && item.kind === "identification") {
      throw new MediaReviewError("conflict", "Confirm the movie title before publishing");
    }
    if (!title || title.length > 200) {
      throw new MediaReviewError("invalid", "A title of 1 to 200 characters is required");
    }
    if (isGeneratedUnknownTitle(title)) {
      throw new MediaReviewError("invalid", "Movie title must not normalize to an automatic unknown-title fallback");
    }
    if (!actions) throw new MediaReviewError("unavailable", "Review workspace service is unavailable");
    try {
      await actions.updateMetadata(job.id, {
        title,
        movieIdentificationConfirmed: true,
        namingSource: "User review"
      });
    } catch (error) {
      if (error instanceof MediaReviewError) throw error;
      throw new MediaReviewError("invalid", error instanceof Error ? error.message : "Could not update review metadata");
    }
    await actions.resume(job.id);
    return { item: this.get(sourceId) ?? item, continuation: "started" };
  }

  private toItem(job: ReviewJob): MediaReviewItem {
    const metadata = job.metadata;
    const stored = convertStoredCandidates(metadata.movieCandidates);
    const mediaType = text(metadata.mediaType) ?? (job.discType === "audio_cd" ? "music" : "movie");
    const generatedUnknown = typeof metadata.title === "string" && isGeneratedUnknownTitle(metadata.title);
    const selectedTitle = text(metadata.title) && !generatedUnknown ? text(metadata.title) : undefined;
    const namingSource = text(metadata.namingSource);
    const needsConfirmation = metadata.movieIdentificationRequiresConfirmation === true || generatedUnknown ||
      (text(metadata.title) !== undefined && namingSource !== undefined && namingSource !== "Metadata match" &&
        metadata.movieIdentificationConfirmed !== true);
    const evidence = recordOf(metadata.movieIdentificationEvidence);
    const confidence = finiteNumber(evidence?.confidence) ?? stored.candidates[0]?.confidence;
    const originalTitle = text(metadata.filesystemVolumeName) ?? text(metadata.sourceLabel) ??
      text(job.discLabel) ?? text(metadata.selectedTitle);
    const reference = stored.candidates.find((candidate) => candidate.title === selectedTitle) ??
      stored.candidates[0];
    const year = finiteNumber(metadata.year) ?? reference?.year;
    const matchedProvider = text(metadata.providerId) ?? reference?.provider;
    const overview = text(metadata.overview) ?? reference?.overview;
    const itemMetadata: NonNullable<MediaReviewItem["metadata"]> = {
      ...(matchedProvider ? { provider: matchedProvider } : {}),
      ...(reference?.id ? { providerId: reference.id } : {}),
      ...(selectedTitle ? { title: selectedTitle } : {}),
      ...(year === undefined ? {} : { year }),
      ...(reference?.poster ? { poster: reference.poster } : {}),
      ...(overview ? { overview } : {})
    };
    // Jobs predating movie review gating have a title/suggestion but none of the structured evidence fields.
    const legacy = stored.repaired ||
      (mediaType === "movie" && metadata.movieIdentificationRequiresConfirmation === undefined &&
        (generatedUnknown || text(metadata.suggestedTitle) !== undefined));
    const reason = text(job.failureReason);
    const shownTitle = selectedTitle ?? text(metadata.suggestedTitle);
    return {
      id: `${this.sourceKind}:${job.id}`,
      mediaType,
      status: reviewJobStatuses[job.status] ?? "pending",
      kind: needsConfirmation ? "identification" : "processing",
      ...(reason ? { reviewReason: reason } : {}),
      ...(confidence === undefined ? {} : { confidence }),
      ...(originalTitle ? { originalTitle } : {}),
      ...(shownTitle ? { selectedTitle: shownTitle } : {}),
      ...(namingSource ? { namingSource } : {}),
      candidates: stored.candidates,
      ...(Object.keys(itemMetadata).length ? { metadata: itemMetadata } : {}),
      source: { kind: this.sourceKind, id: job.id },
      legacy,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt
    };
  }
}

export interface TvIdentification {
  seriesName: string;
  provider: MetadataProviderId;
  providerId: string | null;
  seasonNumber: number;
  discNumber: number | null;
  discName: string | null;
  year?: number;
  overview?: string;
  posterUrl?: string;
}

export interface TvAssignmentSelection {
  trackId: string;
  episodeNumbers: number[];
  episodeTitles?: string[];
  title?: string;
}

const invalid = (message: string) => new MediaReviewError("invalid", message);

/** Validates a raw TV identification. Shared by every endpoint that identifies a TV disc. */
export function parseTvIdentification(raw: unknown, isAllowedPoster: (url: string) => boolean): TvIdentification {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw invalid("Identification must be an object");
  const body = raw as Record<string, unknown>;
  const allowed = ["seriesName", "provider", "providerId", "seasonNumber", "discNumber", "discName", "year", "posterUrl", "overview"];
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw invalid("Identification contains unsupported fields");
  const providerMap: Record<string, MetadataProviderId> = { tvdb: "tvdb", tmdb: "tmdb", "tmdb-tv": "tmdb", imdb: "imdb", manual: "manual" };
  const provider = typeof body.provider === "string" ? providerMap[body.provider] : undefined;
  if (typeof body.seriesName !== "string" || !body.seriesName.trim() || body.seriesName.length > 200) {
    throw invalid("Series name is required (1 to 200 characters)");
  }
  if (!provider) throw invalid("Provider must be tvdb, tmdb, imdb, or manual");
  if (body.providerId !== undefined && body.providerId !== null &&
    (typeof body.providerId !== "string" || !body.providerId.trim() || body.providerId.length > 200)) {
    throw invalid("Provider ID must contain 1 to 200 characters");
  }
  if (!Number.isInteger(body.seasonNumber) || Number(body.seasonNumber) < 0 || Number(body.seasonNumber) > 100) {
    throw invalid("Season number must be an integer from 0 to 100");
  }
  if (body.discNumber !== undefined && body.discNumber !== null &&
    (!Number.isInteger(body.discNumber) || Number(body.discNumber) < 1 || Number(body.discNumber) > 100)) {
    throw invalid("Disc number must be an integer from 1 to 100 when provided");
  }
  if (body.discName !== undefined && body.discName !== null &&
    (typeof body.discName !== "string" || body.discName.length > 200)) {
    throw invalid("Disc name must not exceed 200 characters");
  }
  if (body.year !== undefined && body.year !== null &&
    (!Number.isInteger(body.year) || Number(body.year) < 1900 || Number(body.year) > 2200)) {
    throw invalid("Year is invalid");
  }
  if (body.overview !== undefined && body.overview !== null &&
    (typeof body.overview !== "string" || body.overview.length > 4000)) {
    throw invalid("Overview is too long");
  }
  if (typeof body.posterUrl === "string" && body.posterUrl && !isAllowedPoster(body.posterUrl)) {
    throw invalid("Poster URL is not an allowed artwork source");
  }
  return {
    seriesName: body.seriesName.trim(),
    provider,
    providerId: (body.providerId as string | null | undefined) ?? null,
    seasonNumber: Number(body.seasonNumber),
    discNumber: body.discNumber === undefined || body.discNumber === null ? null : Number(body.discNumber),
    discName: typeof body.discName === "string" && body.discName.trim() ? body.discName.trim() : null,
    ...(typeof body.year === "number" ? { year: body.year } : {}),
    ...(typeof body.overview === "string" ? { overview: body.overview } : {}),
    ...(typeof body.posterUrl === "string" && body.posterUrl ? { posterUrl: body.posterUrl } : {})
  };
}

/** Validates raw episode assignments (episode ranges per track) against the tracks staged for the disc. */
export function parseTvAssignments(raw: unknown, knownTrackIds: ReadonlySet<string>): TvAssignmentSelection[] {
  if (!Array.isArray(raw)) throw invalid("Episode assignments must be an array");
  const requested = new Map<string, TvAssignmentSelection>();
  for (const value of raw) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw invalid("Each episode assignment must be an object");
    }
    const assignment = value as Record<string, unknown>;
    if (typeof assignment.trackId !== "string" || !knownTrackIds.has(assignment.trackId) ||
      requested.has(assignment.trackId)) {
      throw invalid("Episode assignment references an unknown or duplicate track");
    }
    const episodeNumbers = Array.isArray(assignment.episodeNumbers)
      ? assignment.episodeNumbers : [assignment.episodeNumber];
    if (episodeNumbers.length > 3 ||
      episodeNumbers.some((number) => !Number.isInteger(number) || Number(number) < 0 || Number(number) > 1000)) {
      throw invalid("Provide up to three episode numbers from 0 to 1000");
    }
    if (new Set(episodeNumbers).size !== episodeNumbers.length) {
      throw invalid("A track cannot be matched to the same episode more than once");
    }
    if (assignment.episodeTitles !== undefined &&
      (!Array.isArray(assignment.episodeTitles) || assignment.episodeTitles.length !== episodeNumbers.length ||
        assignment.episodeTitles.some((title) => typeof title !== "string" || title.length > 200))) {
      throw invalid("Episode titles must match the selected episodes and be at most 200 characters");
    }
    if (assignment.title !== undefined &&
      (typeof assignment.title !== "string" || assignment.title.length > 200)) {
      throw invalid("Episode title must not exceed 200 characters");
    }
    requested.set(assignment.trackId, {
      trackId: assignment.trackId,
      episodeNumbers: episodeNumbers.map(Number),
      ...(Array.isArray(assignment.episodeTitles) ? { episodeTitles: assignment.episodeTitles as string[] } : {}),
      ...(typeof assignment.title === "string" && assignment.title.trim() ? { title: assignment.title.trim() } : {})
    });
  }
  return [...requested.values()];
}

/** Applies validated selections to the staged tracks; an empty episode list un-matches the track. */
export function applyTvAssignments(
  assignments: readonly TvMatchingAssignment[],
  selections: readonly TvAssignmentSelection[],
  recovery: Pick<DiscRecovery, "providerId" | "seriesName" | "seasonNumber">
): TvMatchingAssignment[] {
  const requested = new Map(selections.map((selection) => [selection.trackId, selection]));
  const seriesId = recovery.providerId || recovery.seriesName || "";
  return assignments.map((item) => {
    const selected = requested.get(item.trackId);
    if (!selected) return item;
    if (selected.episodeNumbers.length === 0) {
      const { selectedEpisodes: _selectedEpisodes, ...unmatched } = item;
      return { ...unmatched, confirmed: false };
    }
    return {
      ...item,
      confirmed: true,
      selectedEpisodes: selected.episodeNumbers.map((episodeNumber, index) => ({
        seriesId,
        seasonNumber: recovery.seasonNumber ?? 0,
        episodeNumber,
        ...(selected.episodeTitles?.[index] ? { title: selected.episodeTitles[index] } :
          selected.title ? { title: selected.title } : {})
      }))
    };
  });
}

/** Persistence and runtime hooks the TV adapter needs; implemented by the composition root. */
export interface TvTaskEnvironment {
  saveIdentification(task: TvMatchingTask, identification: TvIdentification): { recovery: DiscRecovery; task: TvMatchingTask };
  saveAssignments(task: TvMatchingTask, assignments: TvMatchingAssignment[]): TvMatchingTask;
  hasActiveJob(): boolean;
  /** Starts publishing in the background; throws MediaReviewError("unavailable") when the service is missing. */
  continueTask(jobId: string, source: TvMatchingContinuationSource): void;
  isAllowedPoster(url: string): boolean;
}

/** TV discs staged on disk awaiting series identification or episode assignment. */
export class TvMatchingTaskItemAdapter implements MediaReviewItemAdapter {
  readonly sourceKind = "tv-matching-task" as const;

  constructor(
    private readonly tasks: Pick<TvMatchingTaskRepository, "get" | "list">,
    private readonly recoveries: Pick<DiscRecoveryRepository, "get">,
    private readonly environment?: TvTaskEnvironment
  ) {}

  list(): MediaReviewItem[] {
    return this.tasks.list().map((task) => this.toItem(task));
  }

  get(sourceId: string): MediaReviewItem | undefined {
    const task = this.tasks.get(sourceId);
    return task ? this.toItem(task) : undefined;
  }

  async complete(sourceId: string, input: MediaReviewCompletion): Promise<MediaReviewCompletionResult> {
    const env = this.environment;
    if (!env) throw new MediaReviewError("unavailable", "TV review service is unavailable");
    let task = this.tasks.get(sourceId);
    if (!task) throw new MediaReviewError("not-found", "TV matching task was not found");
    if (task.status === "processing") throw new MediaReviewError("conflict", "TV matching task is already processing");
    if (task.status === "completed") throw new MediaReviewError("conflict", "TV matching task is already completed");
    // Validate everything before persisting anything so a bad assignment cannot leave a half-applied completion.
    const identification = input.identification === undefined ? undefined
      : parseTvIdentification(input.identification, (url) => env.isAllowedPoster(url));
    const selections = input.assignments === undefined ? undefined
      : parseTvAssignments(input.assignments, new Set(task.assignments.map((item) => item.trackId)));
    const details: Record<string, unknown> = {};
    if (identification) {
      const saved = env.saveIdentification(task, identification);
      details.recovery = saved.recovery;
      task = saved.task;
    }
    if (selections) {
      const recovery = this.recoveries.get(task.fingerprint);
      if (!recovery?.seriesName || recovery.seasonNumber === null) {
        throw new MediaReviewError("conflict", "Identify the series and season before assigning episodes");
      }
      task = env.saveAssignments(task, applyTvAssignments(task.assignments, selections, recovery));
    }
    const continuation = this.publish(task, input.publish ?? "when-ready", env);
    task = this.tasks.get(sourceId) ?? task;
    const item = this.toItem(task);
    const progress = tvMatchingProgress(task.assignments);
    return { item, continuation, details: { ...details, task, progress } };
  }

  private publish(task: TvMatchingTask, mode: "never" | "when-ready" | "required", env: TvTaskEnvironment): MediaReviewContinuation {
    if (mode === "never") return "not-ready";
    const required = mode === "required";
    if (required) {
      if (task.status === "partially-matched") {
        throw new MediaReviewError("conflict",
          "Save matches for every remaining track before publishing; unmatched tracks are still safely staged");
      }
    } else if (!tvMatchingProgress(task.assignments).fullyMatched) {
      return "not-ready";
    }
    const recovery = this.recoveries.get(task.fingerprint);
    if (recovery?.mediaTypeOverridden && recovery.finalMediaType !== "tv_series") {
      if (!required) return "blocked";
      throw new MediaReviewError("conflict",
        "The manual media classification is not TV Series; this staged TV workflow cannot be published");
    }
    if (env.hasActiveJob()) {
      if (!required) return "queued";
      throw new MediaReviewError("conflict", "Wait until the active disc job finishes before continuing this TV task");
    }
    env.continueTask(task.jobId, required ? "continue-action" : "assignment-save");
    return "started";
  }

  private tvDetails(task: TvMatchingTask, recovery: DiscRecovery | undefined): MediaReviewTvDetails {
    const progress = tvMatchingProgress(task.assignments);
    const requires: MediaReviewTvDetails["requires"] = [];
    if (!recovery?.seriesName || recovery.seasonNumber === null) requires.push("identification");
    if (progress.totalCount > 0 && !progress.fullyMatched) requires.push("assignments");
    const providerId = text(recovery?.providerId);
    const discName = text(recovery?.discName);
    return {
      ...(recovery?.seriesName ? { seriesName: recovery.seriesName } : {}),
      ...(recovery?.metadataProvider ? { provider: recovery.metadataProvider } : {}),
      ...(providerId ? { providerId } : {}),
      ...(typeof recovery?.seasonNumber === "number" ? { seasonNumber: recovery.seasonNumber } : {}),
      ...(typeof recovery?.discNumber === "number" ? { discNumber: recovery.discNumber } : {}),
      ...(discName ? { discName } : {}),
      tracks: task.assignments.map((assignment) => ({
        trackId: assignment.trackId,
        title: assignment.title,
        durationSeconds: assignment.durationSeconds,
        episodeNumbers: (assignment.selectedEpisodes ?? []).map((episode) => episode.episodeNumber),
        confirmed: assignment.confirmed === true
      })),
      progress: { matched: progress.matchedCount, total: progress.totalCount },
      requires
    };
  }

  private toItem(task: TvMatchingTask): MediaReviewItem {
    const recovery = this.recoveries.get(task.fingerprint);
    const seriesName = text(recovery?.seriesName);
    const status: MediaReviewStatus = task.status === "completed" ? "completed"
      : task.status === "processing" ? "processing"
        : task.status === "ready-to-publish" ? "ready" : "pending";
    const reason = text(task.failure) ?? ({
      "awaiting-identification": "Series identification is required",
      "awaiting-mapping": "Episode assignment is required",
      "partially-matched": "Some tracks still need episode assignment"
    } as Record<string, string>)[task.status];
    const originalTitle = text(task.source.label);
    const providerId = text(recovery?.providerId);
    const provider = text(recovery?.metadataProvider);
    return {
      id: `${this.sourceKind}:${task.jobId}`,
      mediaType: "tv",
      status,
      kind: task.status === "awaiting-identification" ? "identification" : "assignment",
      ...(reason ? { reviewReason: reason } : {}),
      ...(originalTitle ? { originalTitle } : {}),
      ...(seriesName ? { selectedTitle: seriesName, namingSource: "User review" } : {}),
      candidates: [],
      ...(seriesName ? { metadata: {
        title: seriesName,
        ...(provider ? { provider } : {}),
        ...(providerId ? { providerId } : {})
      } } : {}),
      tv: this.tvDetails(task, recovery),
      source: { kind: this.sourceKind, id: task.jobId },
      legacy: false,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt
    };
  }
}

const planStatuses: Record<TvProcessingPlan["state"], MediaReviewStatus> = {
  "awaiting-review": "pending",
  ready: "ready",
  approved: "completed",
  rejected: "dismissed"
};

/** Analysed TV processing plans that may require approval. */
export class TvPlanItemAdapter implements MediaReviewItemAdapter {
  readonly sourceKind = "tv-plan" as const;

  constructor(
    private readonly plans: Pick<TvProcessingPlanRepository, "get" | "list">,
    private readonly approve?: (planId: string, reviewer?: string) => void
  ) {}

  list(): MediaReviewItem[] {
    return this.plans.list(1000).map((plan) => this.toItem(plan));
  }

  get(sourceId: string): MediaReviewItem | undefined {
    const plan = this.plans.get(sourceId);
    return plan ? this.toItem(plan) : undefined;
  }

  /** Confirming a plan approves it. Rejecting or deferring remain separate plan decisions. */
  async complete(sourceId: string, input: MediaReviewCompletion): Promise<MediaReviewCompletionResult> {
    const plan = this.plans.get(sourceId);
    if (!plan) throw new MediaReviewError("not-found", "TV plan was not found");
    if (!this.approve) throw new MediaReviewError("unavailable", "TV plan review is unavailable");
    if (plan.state !== "awaiting-review") {
      throw new MediaReviewError("conflict", `Cannot complete a ${plan.state} plan`);
    }
    this.approve(sourceId, input.reviewer);
    const item = this.get(sourceId);
    if (!item) throw new MediaReviewError("not-found", "TV plan was not found");
    return { item, continuation: "started" };
  }

  private toItem(plan: TvProcessingPlan): MediaReviewItem {
    const series = plan.series;
    const reason = plan.reviewReasons.length ? plan.reviewReasons.join("; ") : undefined;
    const candidates: ReviewCandidate[] = series ? [{
      id: series.id ?? series.title,
      title: series.title,
      confidence: Math.max(0, Math.min(1, plan.seriesConfidence)),
      ...(series.year === undefined ? {} : { year: series.year })
    }] : [];
    return {
      id: `${this.sourceKind}:${plan.id}`,
      mediaType: "tv",
      status: planStatuses[plan.state] ?? "pending",
      kind: "plan-review",
      ...(reason ? { reviewReason: reason } : {}),
      confidence: plan.confidence,
      ...(series ? { originalTitle: series.title, selectedTitle: series.title } : {}),
      candidates,
      ...(series ? { metadata: {
        title: series.title,
        ...(series.id ? { providerId: series.id } : {}),
        ...(series.year === undefined ? {} : { year: series.year })
      } } : {}),
      source: { kind: this.sourceKind, id: plan.id },
      legacy: false,
      createdAt: plan.createdAt,
      updatedAt: plan.reviewedAt ?? plan.createdAt
    };
  }
}
