import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyRateLimit from "@fastify/rate-limit";
import { randomBytes, scryptSync } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, lstat, mkdir, open, readdir, realpath, rename, stat, statfs, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { activeJob, dailyJobStats, db, dbPath, deleteJob, getSettings, jobDetails, jobStats, listJobs, saveSettings } from "./db.js";
import { events } from "./events.js";
import { clearDiscDiagnostics, getLiveDiscDiagnostics } from "./diagnostics.js";
import { CapabilityService } from "./capability-service.js";
import { cancelActiveJob } from "./job-control.js";
import { availableEncoders } from "./encoding.js";
import { executableAvailable } from "./executable.js";
import { runProcess } from "./process.js";
import { DashboardMetricSampler } from "./metrics-sampler.js";
import { getRuntimeStatus } from "./runtime-status.js";
import { configureLogLevel } from "./logger.js";
import { testLidarrConnection, validateLidarrUrl } from "./lidarr.js";
import { getManualMusicMetadataPrompt, submitManualMusicMetadata } from "./manual-music-metadata.js";
import { resolveMusicBrainzRelease, type MusicAlbumMetadata } from "./music-metadata.js";
import { checkForUpdate, clearUpdatePending, getInstalledVersion, getReleaseNotes, getUpdateDiagnostics, getUpdateStatus, isUpdatePending, queueUpdate, verifyRunningVersion, type UpdateCheck } from "./updater.js";
import type { AppSettings, EncoderChoice, Job, LibraryMetadataSettings, OutputFormat } from "./model.js";
import { tvMetadataProviderRegistry } from "./bootstrap/tv-metadata-providers.js";
import { tvMetadataLookupService } from "./bootstrap/tv-metadata-runtime.js";
import { tvEpisodeMatchingPolicy } from "./application/tv-episode-matching-engine.js";
import { tvWorkflowPolicy } from "./application/tv-workflow-service.js";
import { normalizeDiscName, searchVariants } from "./application/tv-name-normalization.js";
import { repositories } from "./db.js";
import { KNOWN_DISK_TYPES, OVERRIDE_REASONS, CLASSIFICATION_REVIEW_STATUSES } from "./domain/classification.js";
import { exportClassificationJson, exportClassificationText } from "./application/classification-export.js";
import { TvReviewService } from "./application/tv-review-service.js";
import { TvValidationService } from "./application/tv-validation-service.js";
import type { Episode, TvProcessingPlan } from "./domain/television.js";
import {
  discTypes,
  isValidAirDate,
  mediaTypes,
  metadataProviderIds,
  type DiscRecovery,
  type DiscRecoveryUpdate,
  type DiscType,
  type EpisodeMapping,
  type MediaType,
  type MetadataProviderId
} from "./domain/disc-recovery.js";
import type { ReviewCategory, ReviewItem, ReviewSeverity, ReviewStatus } from "./domain/reviews.js";
import type { ReviewJob } from "./domain/review-jobs.js";
import { outputDestinationsPayloadIsValid, outputPath, outputTarget, type OutputMedia } from "./output-destinations.js";
import {
  activePublishingDirectories,
  pathsOverlap,
  recommendedTvStagingDirectory,
  resolvedStoragePaths,
  tvStagingConflictExplanation,
  tvStagingConflicts,
  tvStagingDirectory,
  tvStagingPathSource
} from "./storage-paths.js";
import { tvMatchingProgress, tvMatchingReviewStatus, type TvMatchingContinuationSource, type TvMatchingTask } from "./domain/tv-matching.js";
import { ReviewQueueCleanupService } from "./application/review-queue-cleanup-service.js";
import {
  StorageLifecycleService,
  type StorageCategoryId,
  type StorageCleanupResult
} from "./application/storage-lifecycle-service.js";

export const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? getSettings().logLevel } });
const capabilityService = new CapabilityService(getSettings);
const reviewQueueCleanup = new ReviewQueueCleanupService(db, getSettings);
const storageLifecycle = new StorageLifecycleService(db, getSettings, reviewQueueCleanup);
const storageCategoryIds = new Set<StorageCategoryId>([
  "review-queue-data", "unmatched-tv-content", "temporary-conversion-files", "artwork-cache",
  "metadata-cache", "orphaned-data", "staged-rips", "failed-processing-jobs", "temporary-logs"
]);

function isStorageCategoryId(value: string): value is StorageCategoryId {
  return storageCategoryIds.has(value as StorageCategoryId);
}

export async function runStorageMaintenance(): Promise<void> {
  await storageLifecycle.runScheduledMaintenance();
}

export async function scanReviewQueueOrphans(): Promise<void> {
  await reviewQueueCleanup.scanOrphanedData();
}
interface ReviewJobActions {
  continue(id: string): Promise<void>;
  updateMetadata(id: string, patch: Readonly<Record<string, unknown>>): Promise<ReviewJob>;
}
interface TvMatchingActions {
  continue(jobId: string, source?: TvMatchingContinuationSource): Promise<void>;
  remove(jobId: string): Promise<void>;
}
let reviewJobActions: ReviewJobActions | undefined;
let discApprovalAction: ((item: ReviewItem) => Promise<void>) | undefined;
let tvMatchingActions: TvMatchingActions | undefined;

export function setReviewJobActions(actions: ReviewJobActions): void {
  reviewJobActions = actions;
}

export function setDiscApprovalAction(action: (item: ReviewItem) => Promise<void>): void {
  discApprovalAction = action;
}
export function setTvMatchingActions(actions: TvMatchingActions): void {
  tvMatchingActions = actions;
}
const tvValidation = new TvValidationService(
  repositories.tvValidationEvidence,
  repositories.tvEpisodeFeedback,
  repositories.tvProcessingPlans,
  () => getSettings().tvValidationLoggingEnabled
);
const tvReview = new TvReviewService(repositories.tvEpisodeFeedback, repositories.tvProcessingPlans);
const sessions = new Map<string, number>();
const setupAttempts = new Map<string, { count: number; resetAt: number }>();
const staticRoot = join(dirname(fileURLToPath(import.meta.url)), "../web");

function passwordConfigured(): boolean {
  return repositories.setup.get().setupComplete;
}

function sessionToken(request: FastifyRequest): string | undefined {
  const cookie = request.headers.cookie;
  const match = cookie?.match(/(?:^|;\s*)autodisc_session=([a-f0-9]+)/);
  return match?.[1];
}

function isAuthenticated(request: FastifyRequest): boolean {
  const token = sessionToken(request);
  if (!token) return false;
  const expiry = sessions.get(token);
  if (!expiry || expiry < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

app.addHook("onRequest", async (request, reply) => {
  const setupComplete = repositories.setup.get().setupComplete;
  if (!setupComplete) {
    if (request.url === "/" || request.url === "/setup" ||
      request.url === "/api/v1/setup/status" || request.url === "/api/v1/setup") return;
    if (request.url.startsWith("/api/")) {
      return reply.code(503).send({ error: "Initial administrator setup is required", setupRequired: true });
    }
    return reply.redirect("/setup");
  }
  if (request.url === "/setup") return reply.redirect("/");
});

app.addHook("preHandler", async (request, reply) => {
  if (!request.url.startsWith("/api/") || request.url === "/api/health" || request.url === "/api/v1/login") return;
  if (passwordConfigured() && !isAuthenticated(request)) {
    return reply.code(401).send({ error: "Authentication required" });
  }
  if (repositories.setup.get().passwordChangeRequired && !passwordChangeAllowedPaths.has(request.url.split("?")[0] ?? "")) {
    return reply.code(403).send({ error: "You must set a new password before continuing", passwordChangeRequired: true });
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && request.headers.origin) {
    try {
      const origin = new URL(request.headers.origin);
      if (origin.host !== request.headers.host) return reply.code(403).send({ error: "Cross-origin request rejected" });
    } catch {
      return reply.code(403).send({ error: "Invalid request origin" });
    }
  }
});

app.get("/", async (_request, reply) => repositories.setup.get().setupComplete
  ? reply.sendFile("index.html")
  : reply.redirect("/setup"));
app.get("/setup", async (_request, reply) => reply.sendFile("setup.html"));
app.register(fastifyStatic, { root: staticRoot, prefix: "/", index: false });
app.register(fastifyRateLimit, { global: false });

function validAdministratorPassword(password: string): boolean {
  return password.length >= 4 && password.length <= 256;
}

const passwordRuleMessage = "Password must be at least 4 characters";

const passwordChangeAllowedPaths = new Set(["/api/v1/account/password", "/api/v1/logout", "/api/v1/setup/status"]);

app.get("/api/v1/setup/status", async () => ({
  setupComplete: repositories.setup.get().setupComplete
}));

app.post<{ Body: unknown }>("/api/v1/setup", async (request, reply) => {
  if (repositories.setup.get().setupComplete) {
    return reply.code(409).send({ error: "Initial setup has already been completed" });
  }
  const now = Date.now();
  const attempt = setupAttempts.get(request.ip);
  if (attempt && attempt.resetAt > now && attempt.count >= 10) {
    reply.header("Retry-After", String(Math.ceil((attempt.resetAt - now) / 1000)));
    return reply.code(429).send({ error: "Too many setup attempts. Wait before trying again." });
  }
  setupAttempts.set(request.ip, {
    count: attempt && attempt.resetAt > now ? attempt.count + 1 : 1,
    resetAt: attempt && attempt.resetAt > now ? attempt.resetAt : now + 15 * 60 * 1000
  });
  if (typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) {
    return reply.code(400).send({ error: "Setup request must be a JSON object" });
  }
  const body = request.body as Record<string, unknown>;
  if (typeof body.username !== "string" || !/^[A-Za-z0-9._-]{3,32}$/.test(body.username)) {
    return reply.code(400).send({ error: "Username must be 3 to 32 letters, numbers, periods, underscores, or hyphens" });
  }
  if (typeof body.password !== "string" || !validAdministratorPassword(body.password)) {
    return reply.code(400).send({ error: passwordRuleMessage });
  }
  if (body.confirmPassword !== body.password) {
    return reply.code(400).send({ error: "Password confirmation does not match" });
  }
  const salt = randomBytes(16);
  try {
    repositories.setup.complete(body.username, salt.toString("hex"), scryptSync(body.password, salt, 64).toString("hex"));
  } catch (error) {
    if (error instanceof Error && error.message === "Initial setup has already been completed") {
      return reply.code(409).send({ error: error.message });
    }
    app.log.error({ err: error }, "Initial administrator setup could not be completed");
    return reply.code(500).send({ error: "Initial setup could not be completed" });
  }
  sessions.clear();
  setupAttempts.clear();
  events.emit("status");
  events.emit("settings", { opticalDevice: getSettings().opticalDevice });
  return reply.code(201).send({ ok: true, setupComplete: true });
});

function publicSettings(settings: AppSettings): Omit<AppSettings,
  "metadataApiKey" | "lidarrApiKey" | "adminPasswordSalt" | "adminPasswordHash" | "tvMetadataProviderApiKeys"> & {
  metadataApiKeyConfigured: boolean;
  lidarrApiKeyConfigured: boolean;
  tvMetadataProviderApiKeysConfigured: Record<string, boolean>;
  adminPasswordConfigured: boolean;
} {
  const {
    metadataApiKey,
    lidarrApiKey,
    adminPasswordSalt,
    adminPasswordHash,
    tvMetadataProviderApiKeys,
    ...safe
  } = settings;
  return {
    ...safe,
    metadataApiKeyConfigured: Boolean(metadataApiKey),
    lidarrApiKeyConfigured: Boolean(lidarrApiKey),
    tvMetadataProviderApiKeysConfigured: Object.fromEntries(
      tvMetadataProviderRegistry.list(settings).map((provider) =>
        [provider.id, Boolean(tvMetadataProviderApiKeys[provider.id])])
    ),
    adminPasswordConfigured: passwordConfigured()
  };
}

function setSessionCookie(reply: FastifyReply, token: string, maxAge: number): void {
  reply.header(
    "Set-Cookie",
    `autodisc_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`
  );
}

app.post<{ Body: { username?: string; password?: string } }>("/api/v1/login", async (request, reply) => {
  if (!passwordConfigured()) return reply.code(409).send({ error: "Initial administrator setup is required", setupRequired: true });
  const password = request.body?.password;
  if (typeof request.body?.username !== "string" || typeof password !== "string" ||
    !repositories.setup.authenticate(request.body.username, password)) {
    return reply.code(401).send({ error: "Invalid username or password" });
  }
  const token = randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + 12 * 60 * 60 * 1000);
  setSessionCookie(reply, token, 12 * 60 * 60);
  return reply.send({ ok: true, passwordChangeRequired: repositories.setup.get().passwordChangeRequired });
});

app.post<{ Body: { password?: unknown; confirmPassword?: unknown } }>("/api/v1/account/password", async (request, reply) => {
  const state = repositories.setup.get();
  const { password, confirmPassword } = request.body ?? {};
  if (typeof password !== "string" || !validAdministratorPassword(password)) {
    return reply.code(400).send({ error: passwordRuleMessage });
  }
  if (confirmPassword !== password) {
    return reply.code(400).send({ error: "Password confirmation does not match" });
  }
  if (state.adminUsername && repositories.setup.authenticate(state.adminUsername, password)) {
    return reply.code(400).send({ error: "Choose a password different from the current one" });
  }
  const salt = randomBytes(16);
  repositories.setup.updatePassword(salt.toString("hex"), scryptSync(password, salt, 64).toString("hex"));
  const current = sessionToken(request);
  for (const token of [...sessions.keys()]) if (token !== current) sessions.delete(token);
  app.log.info("Administrator password changed");
  return reply.send({ ok: true });
});

app.post("/api/v1/logout", async (request, reply) => {
  const token = sessionToken(request);
  if (token) sessions.delete(token);
  reply.header("Set-Cookie", "autodisc_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
  return reply.send({ ok: true });
});

app.get("/api/health", async () => {
  const checks: Record<string, boolean> = {};
  for (const [name, command, versionArg] of [
    ["ffmpeg", process.env.FFMPEG_COMMAND ?? "ffmpeg", "-version"],
    ["ffprobe", process.env.FFPROBE_COMMAND ?? "ffprobe", "-version"],
    ["udevadm", "udevadm", "--version"],
    ["cdparanoia", process.env.CDPARANOIA_COMMAND ?? "cdparanoia", "-V"],
    ["cd-discid", process.env.CD_DISCID_COMMAND ?? "cd-discid", "--version"]
  ] as const) {
    try {
      await runProcess(command, [versionArg], { timeoutMs: 3000 });
      checks[name] = true;
    } catch {
      checks[name] = false;
    }
  }
  checks.makemkv = await executableAvailable(process.env.MAKEMKV_COMMAND ?? "makemkvcon");
  const requiredChecks = Object.entries(checks).filter(([name]) => name !== "makemkv");
  return {
    status: "ok",
    checks,
    ready: requiredChecks.every(([, ready]) => ready),
    dvdReady: checks.makemkv ?? false
  };
});

function jobWithClassification(job: Job): Job {
  const recovery = job.discFingerprint ? repositories.discRecovery.get(job.discFingerprint) : undefined;
  return {
    ...job,
    classification: recovery ? {
      detectedMediaType: recovery.detectedMediaType,
      finalMediaType: recovery.finalMediaType,
      mediaTypeOverridden: recovery.mediaTypeOverridden,
      audit: repositories.discRecovery.mediaTypeOverrideAudit(recovery.fingerprint)
    } : null
  };
}

function isDiscRecoveryActive(fingerprint: string): boolean {
  return repositories.jobs.active()?.discFingerprint === fingerprint;
}

app.get("/api/v1/status", async () => {
  const active = activeJob();
  return {
    state: active?.status ?? getRuntimeStatus(),
    job: active ? jobWithClassification(active) : active,
    manualMusicMetadata: active ? getManualMusicMetadataPrompt(active.id) : null,
    passwordConfigured: passwordConfigured(),
    encoderPreference: getSettings().encoder
  };
});

app.get("/api/v1/dashboard", async () => {
  const active = activeJob();
  return {
    stats: jobStats(),
    mediaStats: repositories.history.statsByMediaType(),
    libraries: await libraryHealth(),
    recent: listJobs(10).map(jobWithClassification),
    active: active ? jobWithClassification(active) : active,
    manualMusicMetadata: active ? getManualMusicMetadataPrompt(active.id) : null,
    state: active?.status ?? getRuntimeStatus()
  };
});

app.get<{ Querystring: { limit?: string } }>("/api/v1/history", async (request) => {
  const limit = Math.max(1, Math.min(250, Number(request.query.limit ?? 100) || 100));
  return { jobs: listJobs(limit).map(jobWithClassification) };
});

function forgetDisc(discId: string): ReturnType<typeof repositories.forgetDisc.forgetDisc> {
  const result = repositories.forgetDisc.forgetDisc(discId);
  if (result.fingerprint && getLiveDiscDiagnostics()?.fingerprint === result.fingerprint) {
    clearDiscDiagnostics();
  }
  return result;
}

function forgetDiscError(error: unknown, discId: string, request: FastifyRequest, reply: FastifyReply) {
  const message = error instanceof Error ? error.message : "Disc could not be forgotten";
  request.log.error({ err: error, discId }, "Forget disc failed");
  return reply.code(message === "Disc not found" ? 404 : 409).send({ error: message });
}

app.post<{ Params: { id: string } }>("/api/v1/history/:id/forget", async (request, reply) => {
  try {
    return { ok: true, ...forgetDisc(request.params.id) };
  } catch (error) {
    return forgetDiscError(error, request.params.id, request, reply);
  }
});

app.post<{ Params: { fingerprint: string } }>("/api/v1/discs/:fingerprint/forget", async (request, reply) => {
  if (!/^[0-9a-f]{16,128}$/i.test(request.params.fingerprint)) {
    return reply.code(400).send({ error: "Disc fingerprint is invalid" });
  }
  try {
    return { ok: true, ...forgetDisc(request.params.fingerprint) };
  } catch (error) {
    return forgetDiscError(error, request.params.fingerprint, request, reply);
  }
});

app.delete<{ Params: { id: string }; Body: unknown }>("/api/v1/history/:id", async (request, reply) => {
  if (activeJob()?.id === request.params.id) {
    return reply.code(409).send({ error: "An active job cannot be removed from history" });
  }
  const matchingTask = repositories.tvMatchingTasks.get(request.params.id);
  if (matchingTask) {
    const body = request.body as Record<string, unknown> | null;
    if (body?.confirmed !== true) {
      return reply.code(400).send({ error: "Confirm deletion of the unmatched TV disc before removing it" });
    }
    if (!tvMatchingActions) return reply.code(503).send({ error: "TV matching service is unavailable" });
    try {
      await tvMatchingActions.remove(request.params.id);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "TV matching task could not be deleted" });
    }
    return { ok: true };
  }
  if (!deleteJob(request.params.id)) return reply.code(404).send({ error: "Job not found" });
  return { ok: true };
});

app.post<{ Params: { id: string } }>("/api/v1/jobs/:id/cancel", async (request, reply) => {
  const job = activeJob();
  if (job?.id !== request.params.id || !["ripping", "converting"].includes(job.status)) {
    return reply.code(409).send({ error: "This job is not currently in a cancellable stage" });
  }
  if (!cancelActiveJob(request.params.id)) {
    return reply.code(409).send({ error: "This job can no longer be cancelled" });
  }
  events.emit("status");
  return { ok: true };
});

app.post<{ Body: unknown }>("/api/v1/musicbrainz/release", async (request, reply) => {
  if (typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) {
    return reply.code(400).send({ error: "MusicBrainz lookup request must be a JSON object" });
  }
  const body = request.body as Record<string, unknown>;
  if (typeof body.jobId !== "string" || typeof body.releaseId !== "string") {
    return reply.code(400).send({ error: "A job ID and MusicBrainz release ID are required" });
  }
  const prompt = getManualMusicMetadataPrompt(body.jobId);
  if (!prompt) return reply.code(409).send({ error: "This job is not waiting for manual music metadata" });
  try {
    const metadata = await resolveMusicBrainzRelease(
      body.releaseId,
      { discId: prompt.discId, fingerprint: "", trackNumbers: prompt.tracks.map((track) => track.number) },
      getSettings().musicBrainzContactEmail
    );
    if (!metadata) {
      return reply.code(422).send({
        error: "That release has no medium with matching tracks. You can still enter the album and each track manually."
      });
    }
    return { metadata };
  } catch (error) {
    if (error instanceof Error && error.message === "Enter a valid MusicBrainz release ID") {
      return reply.code(400).send({ error: error.message });
    }
    app.log.warn({ err: error }, "Manual MusicBrainz release lookup failed");
    return reply.code(502).send({ error: error instanceof Error ? error.message : "MusicBrainz lookup failed" });
  }
});

app.post<{ Params: { id: string }; Body: unknown }>("/api/v1/jobs/:id/music-metadata", async (request, reply) => {
  if (typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) {
    return reply.code(400).send({ error: "Music metadata must be a JSON object" });
  }
  const body = request.body as Record<string, unknown>;
  const prompt = getManualMusicMetadataPrompt(request.params.id);
  if (!prompt) return reply.code(409).send({ error: "This job is not waiting for manual music metadata" });

  if (typeof body.artist !== "string" || !body.artist.trim() || body.artist.trim().length > 200 ||
    typeof body.album !== "string" || !body.album.trim() || body.album.trim().length > 200) {
    return reply.code(400).send({ error: "Artist and album are required and must be 200 characters or fewer" });
  }
  if (body.year !== undefined && body.year !== "" &&
    (typeof body.year !== "string" || !/^\d{4}$/.test(body.year))) {
    return reply.code(400).send({ error: "Year must be blank or a four-digit year" });
  }
  if (body.source !== undefined && body.source !== "manual" && body.source !== "musicbrainz") {
    return reply.code(400).send({ error: "Metadata source must be manual or musicbrainz" });
  }
  if (!Array.isArray(body.tracks) || body.tracks.length !== prompt.tracks.length) {
    return reply.code(400).send({ error: "Submit a title for every detected track" });
  }
  const tracks: MusicAlbumMetadata["tracks"] = [];
  for (let index = 0; index < prompt.tracks.length; index += 1) {
    const expected = prompt.tracks[index];
    const entry = body.tracks[index];
    if (!expected || typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return reply.code(400).send({ error: "Track metadata is invalid" });
    }
    const track = entry as Record<string, unknown>;
    if (track.number !== expected.number || typeof track.title !== "string" ||
      !track.title.trim() || track.title.trim().length > 200) {
      return reply.code(400).send({ error: `Track ${expected.number} needs a title of 1 to 200 characters` });
    }
    tracks.push({ number: expected.number, title: track.title.trim() });
  }

  const source = body.source === "musicbrainz" ? "musicbrainz" : "manual";
  const metadata: MusicAlbumMetadata = {
    artist: body.artist.trim(),
    album: body.album.trim(),
    year: typeof body.year === "string" && body.year ? body.year : null,
    tracks,
    source
  };
  if (!submitManualMusicMetadata(request.params.id, metadata)) {
    return reply.code(409).send({ error: "This job is no longer waiting for manual music metadata" });
  }
  for (const review of repositories.reviewItems.list({ status: "active", limit: 1000 })) {
    if (review.relatedJobId === request.params.id && review.category === "metadata_issue") {
      repositories.reviewItems.updateStatus(review.id, "resolved", "Manual album and track metadata was supplied");
    }
  }
  events.emit("status");
  return { ok: true };
});

app.get<{ Params: { id: string } }>("/api/v1/history/:id", async (request, reply) => {
  const details = jobDetails(request.params.id);
  if (!details) return reply.code(404).send({ error: "Job not found" });
  return { ...details, job: jobWithClassification(details.job) };
});

app.get<{ Querystring: { jobId?: string; live?: string } }>("/api/v1/diagnostics", async (request, reply) => {
  const active = activeJob();
  const liveOnly = request.query.live === "1";
  const jobId = liveOnly ? undefined : request.query.jobId || active?.id || listJobs(1)[0]?.id;
  if (!jobId) {
    return {
      live: getLiveDiscDiagnostics(),
      job: null,
      tvMatchingTask: null,
      timeline: [],
      jobs: listJobs(50),
      liveOnly,
      configuredDevice: getSettings().opticalDevice
    };
  }
  const details = jobDetails(jobId);
  if (!details) return reply.code(404).send({ error: "Diagnostic job not found" });
  const matchingTask = repositories.tvMatchingTasks.get(jobId);
  return {
    live: getLiveDiscDiagnostics(),
    job: details.job,
    tvMatchingTask: matchingTask ? {
      status: matchingTask.status,
      fingerprint: matchingTask.fingerprint,
      sourceLabel: matchingTask.source.label || null,
      filesystemVolumeName: matchingTask.source.manifest.attributes?.filesystemVolumeName ?? null,
      episodeCount: matchingTask.assignments.length || Object.keys(matchingTask.files).length,
      assignments: matchingTask.assignments,
      diagnostics: matchingTask.diagnostics,
      ...(matchingTask.failure ? { failure: matchingTask.failure } : {})
    } : null,
    classification: repositories.classificationAudit.getByJob(jobId) ?? null,
    timeline: details.timeline,
    jobs: listJobs(50),
    liveOnly: false,
    configuredDevice: getSettings().opticalDevice,
    active: active?.id === jobId
  };
});

app.get("/api/v1/capabilities", async () => capabilityService.getCapabilityReport());

export async function validateStartupCapabilities(): Promise<void> {
  const report = await capabilityService.getCapabilityReport();
  app.log.info({
    platform: report.platform,
    checks: report.checks.map(({ id, ok, status }) => ({ id, ok, status }))
  }, "Startup capability validation completed");
}

const classificationLimit = { rateLimit: { max: 120, timeWindow: "1 minute" } };

app.get<{ Querystring: { limit?: string; offset?: string } }>("/api/v1/classification/audit", { config: classificationLimit }, async (request) => {
  const limit = Math.max(1, Math.min(1000, Number(request.query.limit ?? 100) || 100));
  const offset = Math.max(0, Number(request.query.offset ?? 0) || 0);
  return {
    records: repositories.classificationAudit.list({ limit, offset, newestFirst: true }),
    diskTypes: KNOWN_DISK_TYPES,
    overrideReasons: OVERRIDE_REASONS,
    reviewStatuses: CLASSIFICATION_REVIEW_STATUSES
  };
});

app.get("/api/v1/classification/metrics", { config: classificationLimit }, async () =>
  ({ metrics: repositories.classificationAudit.metrics() }));

app.get("/api/v1/classification/export/text", { config: classificationLimit }, async (_request, reply) =>
  reply.type("text/plain; charset=utf-8")
    .header("Content-Disposition", 'attachment; filename="disk-processing-log.txt"')
    .send(exportClassificationText(repositories.classificationAudit.list({ limit: 100000 }))));

app.get("/api/v1/classification/export/json", { config: classificationLimit }, async (_request, reply) =>
  reply.header("Content-Disposition", 'attachment; filename="disk-classification-audit.json"')
    .send(exportClassificationJson(repositories.classificationAudit.list({ limit: 100000 }))));

app.get<{ Params: { id: string } }>("/api/v1/classification/audit/:id", { config: classificationLimit }, async (request, reply) => {
  const record = repositories.classificationAudit.get(request.params.id) ??
    repositories.classificationAudit.getByJob(request.params.id);
  if (!record) return reply.code(404).send({ error: "Classification audit record not found" });
  return { record };
});

app.post<{ Params: { id: string }; Body: unknown }>("/api/v1/classification/audit/:id/review", { config: classificationLimit }, async (request, reply) => {
  const record = repositories.classificationAudit.get(request.params.id) ??
    repositories.classificationAudit.getByJob(request.params.id);
  if (!record) return reply.code(404).send({ error: "Classification audit record not found" });
  const body = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return reply.code(400).send({ error: "A JSON object is required" });
  const input = body as Record<string, unknown>;
  for (const key of ["overrideReason", "notes"]) {
    if (input[key] !== undefined && typeof input[key] !== "string") return reply.code(400).send({ error: `${key} must be a string` });
  }
  const reviewedBy = repositories.setup.get().adminUsername;
  if (!reviewedBy) return reply.code(503).send({ error: "Administrator identity is unavailable" });
  try {
    return { record: repositories.classificationAudit.review(record.id, {
      finalType: input.finalType as string,
      overrideReason: input.overrideReason as string | undefined,
      notes: input.notes as string | undefined,
      reviewedBy
    }) };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : "Invalid classification review" });
  }
});

app.get<{ Querystring: { range?: string } }>("/api/v1/stats", async (request) => {
  const days = request.query.range === "30d" ? 30 : 7;
  const series = dailyJobStats(days);
  return { range: `${days}d`, series };
});

const reviewCategories: readonly ReviewCategory[] = [
  "tv_review", "cd_review", "metadata_issue", "processing_failure",
  "folder_creation_failure", "disc_read_error", "validation_warning",
  "configuration_issue", "system_warning"
];
const reviewSeverities: readonly ReviewSeverity[] = ["critical", "high", "medium", "low"];
const reviewStatuses: readonly ReviewStatus[] = ["active", "retrying", "resolved", "dismissed"];

app.get<{ Querystring: {
  category?: string; severity?: string; status?: string; from?: string; to?: string;
  limit?: string; offset?: string;
} }>("/api/v1/reviews", async (request, reply) => {
  const query = request.query;
  if (query.category && !reviewCategories.includes(query.category as ReviewCategory)) {
    return reply.code(400).send({ error: "Invalid review category" });
  }
  if (query.severity && !reviewSeverities.includes(query.severity as ReviewSeverity)) {
    return reply.code(400).send({ error: "Invalid review severity" });
  }
  if (query.status && !reviewStatuses.includes(query.status as ReviewStatus)) {
    return reply.code(400).send({ error: "Invalid review status" });
  }
  const limit = query.limit === undefined ? 100 : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 250 ||
    !Number.isInteger(offset) || offset < 0 || offset > 1000000) {
    return reply.code(400).send({ error: "Review pagination is invalid" });
  }
  if ((query.from && !Number.isFinite(Date.parse(query.from))) ||
    (query.to && !Number.isFinite(Date.parse(query.to)))) {
    return reply.code(400).send({ error: "Review date filter is invalid" });
  }
  const filters = {
    ...(query.category ? { category: query.category as ReviewCategory } : {}),
    ...(query.severity ? { severity: query.severity as ReviewSeverity } : {}),
    ...(query.status ? { status: query.status as ReviewStatus } : {}),
    ...(query.from ? { from: query.from } : {}),
    ...(query.to ? { to: query.to } : {}),
    limit,
    offset
  };
  return {
    summary: repositories.reviewItems.summary(),
    items: repositories.reviewItems.list(filters)
  };
});

app.get<{ Params: { id: string } }>("/api/v1/reviews/:id", async (request, reply) => {
  const item = repositories.reviewItems.get(request.params.id);
  if (!item) return reply.code(404).send({ error: "Review item not found" });
  const job = item.relatedJobId ? jobDetails(item.relatedJobId) : undefined;
  return { item, job: job ?? null };
});

app.get<{ Params: { id: string } }>("/api/v1/reviews/:id/deletion-impact", async (request, reply) => {
  try {
    return await reviewQueueCleanup.getDeletionImpact(request.params.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Deletion impact could not be determined";
    return reply.code(message === "Review item was not found" ? 404 : 409).send({ error: message });
  }
});

app.delete<{ Params: { id: string } }>("/api/v1/reviews/:id", async (request, reply) => {
  const ownership = await reviewQueueCleanup.validateOwnership(request.params.id);
  if (!ownership.valid) {
    const missingItem = ownership.errors.includes("Review item was not found");
    app.log.warn({
      reviewId: request.params.id,
      jobId: ownership.jobId,
      filesDeleted: 0,
      bytesRecovered: 0,
      recordsDeleted: 0,
      success: false,
      errors: ownership.errors
    }, "Review item deletion was rejected by ownership validation");
    return reply.code(missingItem ? 404 : 409).send({ error: ownership.errors.join("; ") });
  }
  try {
    const result = await reviewQueueCleanup.deleteReviewItem(request.params.id);
    events.emit("status");
    return result.success
      ? result
      : reply.code(500).send({ error: result.errors.join("; "), ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Review item deletion failed";
    return reply.code(message === "Review item was not found" ? 404 : 409).send({ error: message });
  }
});

app.get("/api/v1/review-cleanup/orphans", async () => reviewQueueCleanup.scanOrphanedData());
app.delete("/api/v1/review-cleanup/orphans", async (_request, reply) => {
  const result = await reviewQueueCleanup.deleteOrphanedData();
  events.emit("status");
  return result.success
    ? result
    : reply.code(500).send({ error: result.errors.join("; "), ...result });
});

app.get("/api/v1/storage/summary", async () => storageLifecycle.getStorageSummary());
app.get("/api/v1/storage/categories", async () => ({
  categories: await storageLifecycle.getCategoryBreakdown()
}));
app.get<{ Querystring: { limit?: string } }>("/api/v1/storage/largest", async (request, reply) => {
  const requested = request.query.limit === undefined ? 10 : Number(request.query.limit);
  if (!Number.isInteger(requested) || requested < 1 || requested > 100) {
    return reply.code(400).send({ error: "limit must be between 1 and 100" });
  }
  return { items: await storageLifecycle.getLargestConsumers(requested) };
});
app.get("/api/v1/storage/orphans", async () => storageLifecycle.getOrphanedResources());
app.get("/api/v1/storage/review-sizes", async () => ({
  items: await storageLifecycle.getReviewStorageBreakdown()
}));
app.get<{ Params: { category: string } }>("/api/v1/storage/impact/:category", async (request, reply) => {
  const category = request.params.category;
  if (category !== "everything-safe" && !isStorageCategoryId(category)) {
    return reply.code(400).send({ error: "Unknown storage category" });
  }
  return storageLifecycle.getCleanupImpact(category);
});
app.post<{ Params: { category: string }; Body: unknown }>("/api/v1/storage/cleanup/:category", async (request, reply) => {
  const category = request.params.category;
  if (typeof request.body !== "object" || request.body === null ||
    Array.isArray(request.body) || (request.body as Record<string, unknown>).confirmed !== true) {
    return reply.code(400).send({ error: "Cleanup requires explicit confirmation" });
  }
  let result: StorageCleanupResult;
  if (category === "everything-safe") {
    result = await storageLifecycle.cleanupEverythingSafe();
  } else if (isStorageCategoryId(category)) {
    const allowed = category;
    if (allowed === "unmatched-tv-content" || allowed === "staged-rips") {
      return reply.code(409).send({ error: "User media is protected from bulk cleanup" });
    }
    result = await storageLifecycle.cleanupCategory(allowed);
  } else {
    return reply.code(400).send({ error: "Unknown storage category" });
  }
  events.emit("status");
  return result.success ? result : reply.code(500).send({ error: result.errors.join("; "), ...result });
});

app.post<{ Params: { id: string } }>("/api/v1/reviews/:id/approve-process", async (request, reply) => {
  const item = repositories.reviewItems.get(request.params.id);
  if (!item) return reply.code(404).send({ error: "Review item not found" });
  if (item.category !== "configuration_issue" || item.errorDetails?.approvalRequired !== true ||
    typeof item.errorDetails.detectionSignature !== "string") {
    return reply.code(409).send({ error: "This review item is not a pending disc approval" });
  }
  if (item.status !== "active") return reply.code(409).send({ error: `Review item is already ${item.status}` });
  if (!discApprovalAction) return reply.code(503).send({ error: "Disc approval processing is not available" });
  try {
    await discApprovalAction(item);
    const resolved = repositories.reviewItems.updateStatus(item.id, "resolved", "Disc approved and processing completed");
    events.emit("status");
    return { item: resolved };
  } catch (error) {
    return reply.code(409).send({ error: error instanceof Error ? error.message : "Disc could not be approved for processing" });
  }
});

app.post<{ Params: { id: string } }>("/api/v1/reviews/:id/resolve", async (request, reply) => {
  const item = repositories.reviewItems.get(request.params.id);
  if (!item) return reply.code(404).send({ error: "Review item not found" });
  if (item.status === "resolved" || item.status === "dismissed") {
    return reply.code(409).send({ error: `Review item is already ${item.status}` });
  }
  const resolved = repositories.reviewItems.updateStatus(item.id, "resolved", "Marked resolved by administrator");
  events.emit("status");
  return { item: resolved };
});

app.post<{ Params: { id: string } }>("/api/v1/reviews/:id/dismiss", async (request, reply) => {
  const item = repositories.reviewItems.get(request.params.id);
  if (!item) return reply.code(404).send({ error: "Review item not found" });
  if (item.status === "resolved" || item.status === "dismissed") {
    return reply.code(409).send({ error: `Review item is already ${item.status}` });
  }
  const dismissed = repositories.reviewItems.updateStatus(item.id, "dismissed", "Dismissed by administrator");
  events.emit("status");
  return { item: dismissed };
});

app.post<{ Params: { id: string } }>("/api/v1/reviews/:id/retry", async (request, reply) => {
  const item = repositories.reviewItems.get(request.params.id);
  if (!item) return reply.code(404).send({ error: "Review item not found" });
  if (item.status !== "active" && item.status !== "retrying") {
    return reply.code(409).send({ error: `Cannot retry a ${item.status} review item` });
  }
  if (!item.suggestedActions.some((action) => action.type === "retry" || action.type === "retry-after-correction")) {
    return reply.code(409).send({ error: "This review item does not support retry" });
  }
  if (item.requestedPath) {
    try {
      const requestedPath = item.category === "folder_creation_failure" && item.errorDetails?.stage === "publish"
        ? dirname(item.requestedPath)
        : item.requestedPath;
      await mkdir(requestedPath, { recursive: true, mode: 0o755 });
      await access(requestedPath, constants.R_OK | constants.W_OK | constants.X_OK);
      const info = await stat(requestedPath);
      if (!info.isDirectory()) throw new Error(`${requestedPath} is not a directory`);
    } catch (error) {
      app.log.error({ err: error, reviewId: item.id, requestedPath: item.requestedPath }, "Review recovery directory creation failed");
      return reply.code(409).send({
        error: `Could not create or access ${item.requestedPath}: ${error instanceof Error ? error.message : "unknown filesystem error"}`
      });
    }
  }
  if (item.relatedDrive && item.relatedDrive !== getSettings().opticalDevice) {
    return reply.code(409).send({ error: "The related disc drive differs from the configured optical drive; update Settings before retrying" });
  }
  const retrying = repositories.reviewItems.updateStatus(item.id, "retrying", "Disc retry requested");
  events.emit("review-retry", retrying);
  events.emit("status");
  return { item: retrying, message: "Retry requested. Keep the related disc in the configured drive." };
});

app.get("/api/v1/review-jobs", {
  config: { rateLimit: { max: 120, timeWindow: "1 minute" } }
}, async () => ({ reviewJobs: repositories.reviewJobs.list().filter((item) => item.notificationActive) }));

app.get<{ Params: { id: string } }>("/api/v1/review-jobs/:id", {
  config: { rateLimit: { max: 120, timeWindow: "1 minute" } }
}, async (request, reply) => {
  const reviewJob = repositories.reviewJobs.get(request.params.id);
  if (!reviewJob) return reply.code(404).send({ error: "Review job not found" });
  return { reviewJob, job: jobDetails(reviewJob.originalJobId) ?? null };
});

app.post<{ Params: { id: string }; Body: unknown }>("/api/v1/review-jobs/:id/metadata", {
  config: { rateLimit: { max: 120, timeWindow: "1 minute" } }
}, async (request, reply) => {
  const reviewJob = repositories.reviewJobs.get(request.params.id);
  if (!reviewJob) return reply.code(404).send({ error: "Review job not found" });
  if (reviewJob.status !== "pending") return reply.code(409).send({ error: "Metadata can only be edited for a pending review job" });
  if (typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) {
    return reply.code(400).send({ error: "Review metadata must be an object" });
  }
  const body = request.body as Record<string, unknown>;
  const allowedFields = ["title", "year", "overview", "originalTitle"];
  if (Object.keys(body).some((key) => !allowedFields.includes(key)) ||
    Object.values(body).some((value) => typeof value !== "string" || value.length > 1000) ||
    (typeof body.title === "string" && !body.title.trim()) ||
    (typeof body.title === "string" && body.title.length > 200)) {
    return reply.code(400).send({ error: "Review metadata contains unsupported or invalid fields" });
  }
  if (!reviewJobActions) return reply.code(503).send({ error: "Review workspace service is unavailable" });
  try {
    return { reviewJob: await reviewJobActions.updateMetadata(reviewJob.id, body) };
  } catch (error) {
    return reply.code(409).send({ error: error instanceof Error ? error.message : "Could not update review metadata" });
  }
});

app.post<{ Params: { id: string } }>("/api/v1/review-jobs/:id/continue", {
  config: { rateLimit: { max: 120, timeWindow: "1 minute" } }
}, async (request, reply) => {
  const reviewJob = repositories.reviewJobs.get(request.params.id);
  if (!reviewJob) return reply.code(404).send({ error: "Review job not found" });
  if (reviewJob.status !== "pending") return reply.code(409).send({ error: `Cannot continue a ${reviewJob.status} review job` });
  if (!reviewJobActions) return reply.code(503).send({ error: "Review processing service is unavailable" });
  if (activeJob()) return reply.code(409).send({ error: "Another media job is already active" });
  repositories.reviewJobs.update(reviewJob.id, { status: "retrying" });
  events.emit("status");
  void reviewJobActions.continue(reviewJob.id).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Review processing failed";
    repositories.reviewJobs.update(reviewJob.id, { status: "pending", failureReason: message });
    app.log.error({ err: error, reviewJobId: reviewJob.id }, "Review processing could not be continued");
    events.emit("status");
  });
  return reply.code(202).send({ reviewJob: repositories.reviewJobs.get(reviewJob.id), message: "Processing resumed from preserved media; no disc is required." });
});

async function clearReviewJobNotification(id: string, reply: FastifyReply) {
  const reviewJob = repositories.reviewJobs.get(id);
  if (!reviewJob) return reply.code(404).send({ error: "Review job not found" });
  if (reviewJob.status === "retrying" || reviewJob.status === "processing") {
    return reply.code(409).send({ error: "A review job cannot be cleared while processing" });
  }
  repositories.reviewJobs.update(reviewJob.id, { notificationActive: false });
  for (const status of ["active", "retrying"] as const) {
    for (const item of repositories.reviewItems.list({ status, limit: 1000 })) {
      if (item.relatedJobId === reviewJob.originalJobId) {
        repositories.reviewItems.updateStatus(item.id, "dismissed", "Review notification cleared by administrator");
      }
    }
  }
  events.emit("status");
  return { ok: true, message: "Review notification cleared. Preserved media and history remain available." };
}

app.post<{ Params: { id: string } }>("/api/v1/review-jobs/:id/clear-notification", {
  config: { rateLimit: { max: 120, timeWindow: "1 minute" } }
}, async (request, reply) =>
  clearReviewJobNotification(request.params.id, reply));
app.get<{ Params: { id: string } }>("/api/v1/review-jobs/:id/deletion-impact", async (request, reply) => {
  try {
    return await reviewQueueCleanup.getReviewJobDeletionImpact(request.params.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Deletion impact could not be determined";
    return reply.code(message === "Review job was not found" ? 404 : 409).send({ error: message });
  }
});
app.delete<{ Params: { id: string } }>("/api/v1/review-jobs/:id", {
  config: { rateLimit: { max: 120, timeWindow: "1 minute" } }
}, async (request, reply) => {
  try {
    const result = await reviewQueueCleanup.deleteReviewJob(request.params.id);
    events.emit("status");
    return result.success
      ? result
      : reply.code(500).send({ error: result.errors.join("; "), ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Review job deletion failed";
    return reply.code(message === "Review job was not found" ? 404 : 409).send({ error: message });
  }
});

app.get<{ Querystring: { confidence?: string; state?: string; limit?: string; offset?: string } }>(
  "/api/v1/tv/analysis", async (request, reply) => {
    const { confidence, state: planState, limit: limitValue, offset: offsetValue } = request.query;
    const allowedStates = ["ready", "awaiting-review", "approved", "rejected"];
    if (planState && !allowedStates.includes(planState)) {
      return reply.code(400).send({ error: "Invalid TV plan state filter" });
    }
    if (confidence && !["high", "medium", "low"].includes(confidence)) {
      return reply.code(400).send({ error: "Confidence must be high, medium, or low" });
    }
    const limit = limitValue === undefined ? 100 : Number(limitValue);
    const offset = offsetValue === undefined ? 0 : Number(offsetValue);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
      !Number.isInteger(offset) || offset < 0 || offset > 1000000) {
      return reply.code(400).send({ error: "TV analysis pagination is invalid" });
    }
    const matchingPlans = repositories.tvProcessingPlans.list(1000, planState as TvProcessingPlan["state"] | undefined)
      .filter((plan) => !confidence || plan.confidenceBand === confidence);
    return { plans: matchingPlans.slice(offset, offset + limit), total: matchingPlans.length, offset, limit };
  }
);

app.get<{ Params: { id: string } }>("/api/v1/tv/analysis/:id", async (request, reply) => {
  const plan = repositories.tvProcessingPlans.get(request.params.id);
  if (!plan) return reply.code(404).send({ error: "TV processing plan not found" });
  const evidence = tvValidation.list(10000).find((item) => item.plan.id === plan.id);
  return { plan, evidence };
});

app.get("/api/v1/tv/summary", async () => {
  const plans = repositories.tvProcessingPlans.list(1000);
  const summary = tvValidation.summary();
  const daily = new Map<string, number>();
  for (const plan of plans) {
    const day = plan.createdAt.slice(0, 10);
    daily.set(day, (daily.get(day) ?? 0) + 1);
  }
  const episodeMatchesSuggested = plans.reduce((count, plan) =>
    count + plan.assignments.filter((item) => item.episodes.length > 0).length, 0);
  const totalEpisodesIdentified = plans.reduce((count, plan) =>
    count + plan.assignments.reduce((assignmentCount, assignment) => assignmentCount + assignment.episodes.length, 0), 0);
  const manualReviewsCompleted = plans.filter((plan) =>
    (plan.reviewHistory ?? []).some((review) => ["approved", "rejected"].includes(review.decision))).length;
  const approvedPlans = plans.filter((plan) => plan.state === "approved").length;
  return {
    totalDiscsAnalyzed: plans.length,
    totalEpisodesIdentified,
    totalEpisodeMatchesSuggested: episodeMatchesSuggested,
    highConfidenceMatches: plans.reduce((count, plan) =>
      count + plan.assignments.filter((item) => item.confidenceBand === "high" && item.episodes.length > 0).length, 0),
    mediumConfidenceMatches: plans.reduce((count, plan) =>
      count + plan.assignments.filter((item) => item.confidenceBand === "medium" && item.episodes.length > 0).length, 0),
    lowConfidenceMatches: plans.reduce((count, plan) =>
      count + plan.assignments.filter((item) => item.confidenceBand === "low").length, 0),
    manualReviewsRequired: plans.filter((plan) => plan.state === "awaiting-review").length,
    manualReviewsCompleted,
    correctionsApplied: repositories.tvEpisodeFeedback.count(),
    duplicateTracksIdentified: plans.reduce((count, plan) => count + plan.duplicateTracks.length, 0),
    bonusFeaturesIdentified: plans.reduce((count, plan) => count + plan.bonusFeatures.length, 0),
    commentaryTracksIdentified: plans.reduce((count, plan) => count + plan.commentaryTracks.length, 0),
    totalSeasonsProcessed: new Set(plans.flatMap((plan) => plan.season
      ? [`${plan.series?.id ?? "unknown"}:${plan.season.number}`] : [])).size,
    totalSeriesProcessed: new Set(plans.flatMap((plan) => plan.series ? [plan.series.id] : [])).size,
    heldOutAccuracy: summary.heldOutLabeledTracks
      ? summary.exactMatches / summary.heldOutLabeledTracks : null,
    meanConfidence: summary.meanPlanConfidence,
    reviewApprovalRate: manualReviewsCompleted ? approvedPlans / manualReviewsCompleted : null,
    daily: [...daily].sort(([left], [right]) => left.localeCompare(right)).slice(-30)
      .map(([day, count]) => ({ day, count })),
    validation: summary
  };
});

app.get<{ Querystring: { state?: string; limit?: string } }>("/api/v1/tv/reviews", async (request, reply) => {
  const allowedStates = ["ready", "awaiting-review", "approved", "rejected"];
  if (request.query.state && !allowedStates.includes(request.query.state)) {
    return reply.code(400).send({ error: "Invalid TV review state filter" });
  }
  const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return reply.code(400).send({ error: "TV review limit must be between 1 and 100" });
  }
  const plans = repositories.tvProcessingPlans.list(1000, request.query.state as TvProcessingPlan["state"] | undefined);
  return { plans: plans.slice(0, limit), total: plans.length };
});

app.get<{ Params: { id: string } }>("/api/v1/tv/plans/:id/recovery", async (request, reply) => {
  const plan = repositories.tvProcessingPlans.get(request.params.id);
  if (!plan) return reply.code(404).send({ error: "TV processing plan not found" });
  return {
    recovery: repositories.discRecovery.get(plan.fingerprint) ?? null,
    mediaTypeAudit: repositories.discRecovery.mediaTypeOverrideAudit(plan.fingerprint)
  };
});

function parseEpisodeMappings(value: unknown): EpisodeMapping[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Episode mappings must contain at most 100 tracks");
  return value.map((entry): EpisodeMapping => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("Episode mapping must be an object");
    }

    const mapping = entry as Record<string, unknown>;
    if (typeof mapping.trackId !== "string" || !mapping.trackId.trim() ||
      !Array.isArray(mapping.episodes) || mapping.episodes.length < 1 || mapping.episodes.length > 3) {
      throw new Error("Each episode mapping requires a track and 1 to 3 episodes");
    }
    const episodes = mapping.episodes.map((entry): Episode => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new Error("Episode metadata must be an object");
      }
      const episode = entry as Record<string, unknown>;
      if (typeof episode.seriesId !== "string" || !episode.seriesId.trim() || episode.seriesId.length > 200 ||
        !Number.isInteger(episode.seasonNumber) || Number(episode.seasonNumber) < 0 || Number(episode.seasonNumber) > 100 ||
        !Number.isInteger(episode.episodeNumber) || Number(episode.episodeNumber) < 0 || Number(episode.episodeNumber) > 1000 ||
        (episode.title !== undefined && (typeof episode.title !== "string" || episode.title.length > 500)) ||
        (episode.airDate !== undefined && (typeof episode.airDate !== "string" || !isValidAirDate(episode.airDate))) ||
        (episode.notes !== undefined && (typeof episode.notes !== "string" || episode.notes.length > 1000))) {
        throw new Error("Episode metadata is invalid");
      }
      return {
        seriesId: episode.seriesId,
        seasonNumber: Number(episode.seasonNumber),
        episodeNumber: Number(episode.episodeNumber),
        ...(typeof episode.title === "string" ? { title: episode.title } : {}),
        ...(typeof episode.airDate === "string" ? { airDate: episode.airDate } : {}),
        ...(typeof episode.notes === "string" ? { notes: episode.notes } : {})
      };
    });
    return { trackId: mapping.trackId, episodes };
  });
}

const recoveryArtworkKinds = new Set([
  "poster", "backdrop", "fanart", "logo", "banner", "season-poster", "episode-image", "disc", "artist", "album"
]);
const recoveryArtworkHosts = new Set(["image.tmdb.org", "artworks.thetvdb.com", "coverartarchive.org", "archive.org"]);

function validImportedMetadata(value: unknown): value is Record<string, unknown> | null {
  if (value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= 64 * 1024;
  } catch {
    return false;
  }
}

function validArtworkReferences(value: unknown): value is Array<{ kind: string; url: string }> {
  if (!Array.isArray(value) || value.length > 20) return false;
  return value.every((asset) => {
    if (typeof asset !== "object" || asset === null || Array.isArray(asset) ||
      typeof asset.kind !== "string" || !recoveryArtworkKinds.has(asset.kind) ||
      typeof asset.url !== "string" || asset.url.length > 2048) return false;
    try {
      const url = new URL(asset.url);
      return url.protocol === "https:" &&
        (recoveryArtworkHosts.has(url.hostname) || url.hostname.endsWith(".archive.org"));
    } catch {
      return false;
    }
  });
}

function isValidLibraryMetadata(value: unknown): value is LibraryMetadataSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const toggles = [
    "automaticImport", "downloadSeriesMetadata", "downloadEpisodeMetadata", "downloadMovieMetadata",
    "downloadMusicMetadata", "downloadCastInformation", "downloadRatings", "downloadArtwork",
    "downloadSeasonArtwork", "downloadEpisodeImages", "downloadFanart", "downloadLogos",
    "downloadBackdrops", "downloadBanners", "generateNfo"
  ];
  if (toggles.some((key) => typeof input[key] !== "boolean")) return false;
  if (!["jellyfin", "kodi", "emby"].includes(String(input.nfoFormat)) ||
    !["jellyfin", "sonarr", "radarr", "lidarr", "kodi", "custom"].includes(String(input.libraryStructure))) return false;
  const templates = [
    "seriesFolderTemplate", "seasonFolderTemplate", "episodeFileTemplate", "movieFolderTemplate",
    "movieFileTemplate", "artistFolderTemplate", "albumFolderTemplate"
  ];
  const allowedTokens = new Set([
    "Series Name", "Year", "Season Number", "Season", "Episode", "Episode Title",
    "Movie Title", "Artist", "Album"
  ]);
  return templates.every((key) => {
    const template = input[key];
    if (typeof template !== "string" || !template.trim() || template.length > 200 ||
      /[\\/]/.test(template) || template.includes("..")) return false;
    const tokens = [...template.matchAll(/\{([^{}]+)\}/g)];
    const stripped = template.replace(/\{[^{}]+\}/g, "");
    return !/[{}]/.test(stripped) && tokens.every((token) => {
      const parts = token[1]?.split(":");
      return Boolean(parts && allowedTokens.has(parts[0] ?? "") &&
        (parts.length === 1 || (parts.length === 2 && parts[1] === "00")));
    });
  });
}

app.put<{ Params: { id: string }; Body: unknown }>("/api/v1/tv/plans/:id/recovery", async (request, reply) => {
  const plan = repositories.tvProcessingPlans.get(request.params.id);
  if (!plan) return reply.code(404).send({ error: "TV processing plan not found" });
  if (isDiscRecoveryActive(plan.fingerprint)) return reply.code(409).send({ error: "Wait until this disc finishes processing before changing recovery data" });
  if (typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) {
    return reply.code(400).send({ error: "Recovery metadata must be an object" });
  }
  const body = request.body as Record<string, unknown>;
  const allowed = ["discType", "mediaType", "mediaTypeReason", "metadataProvider", "providerId", "seriesName", "seasonNumber",
    "mappings", "notes", "importedMetadata", "artworkReferences"];
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    return reply.code(400).send({ error: "Recovery metadata contains unsupported fields" });
  }
  if ((body.discType !== undefined && !discTypes.includes(body.discType as never)) ||
    (body.mediaType !== undefined && !mediaTypes.includes(body.mediaType as never)) ||
    (body.metadataProvider !== undefined && !metadataProviderIds.includes(body.metadataProvider as never)) ||
    (body.providerId !== undefined && body.providerId !== null &&
      (typeof body.providerId !== "string" || body.providerId.trim().length < 1 || body.providerId.length > 200)) ||
    (body.seriesName !== undefined && body.seriesName !== null &&
      (typeof body.seriesName !== "string" || body.seriesName.trim().length < 1 || body.seriesName.length > 200)) ||
    (body.seasonNumber !== undefined && body.seasonNumber !== null &&
      (!Number.isInteger(body.seasonNumber) || Number(body.seasonNumber) < 0 || Number(body.seasonNumber) > 100)) ||
    (body.notes !== undefined && body.notes !== null &&
      (typeof body.notes !== "string" || body.notes.length > 2000)) ||
    (body.mediaTypeReason !== undefined &&
      (typeof body.mediaTypeReason !== "string" || body.mediaTypeReason.length > 500)) ||
    (body.mappings !== undefined && (!Array.isArray(body.mappings) || body.mappings.length > 100)) ||
    (body.importedMetadata !== undefined && !validImportedMetadata(body.importedMetadata)) ||
    (body.artworkReferences !== undefined && !validArtworkReferences(body.artworkReferences))) {
    return reply.code(400).send({ error: "Recovery metadata contains invalid values" });
  }
  let mappings: EpisodeMapping[] | undefined;
  let patch: DiscRecoveryUpdate;
  try {
    mappings = body.mappings === undefined ? undefined : parseEpisodeMappings(body.mappings);
    const username = repositories.setup.get().adminUsername;
    if (body.mediaType !== undefined && !username) {
      return reply.code(503).send({ error: "Administrator identity is unavailable" });
    }
    patch = {
      ...(body.discType === undefined ? {} : { finalDiscType: body.discType as DiscType }),
      ...(body.mediaType === undefined ? {} : { finalMediaType: body.mediaType as MediaType }),
      ...(body.mediaType === undefined ? {} : {
        mediaTypeOverrideAudit: {
          username: username!,
          reason: typeof body.mediaTypeReason === "string" ? body.mediaTypeReason : null
        }
      }),
      ...(body.metadataProvider === undefined ? {} : { metadataProvider: body.metadataProvider as MetadataProviderId }),
      ...(body.providerId === undefined ? {} : { providerId: body.providerId as string | null }),
      ...(body.seriesName === undefined ? {} : { seriesName: body.seriesName as string | null }),
      ...(body.seasonNumber === undefined ? {} : { seasonNumber: body.seasonNumber as number | null }),
      ...(mappings === undefined ? {} : { mappings }),
      ...(body.importedMetadata === undefined ? {} : { importedMetadata: body.importedMetadata as Record<string, unknown> | null }),
      ...(body.artworkReferences === undefined ? {} : { artworkReferences: body.artworkReferences as Array<{ kind: string; url: string }> }),
      ...(body.notes === undefined ? {} : { notes: body.notes as string | null })
    };
    const recovery = repositories.discRecovery.update(plan.fingerprint, patch);
    if (!recovery) return reply.code(409).send({ error: "Recovery data has not been initialized for this disc" });
    repositories.recovery.clearInsertedDisc();
    return { recovery };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : "Recovery metadata could not be saved" });
  }
});

function saveIdentification(
  fingerprint: string,
  rawBody: unknown
): { error: string; status: number } | { recovery: DiscRecovery } {
  if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
    return { status: 400, error: "Identification must be an object" };
  }
  const body = rawBody as Record<string, unknown>;
  const allowed = ["seriesName", "provider", "providerId", "seasonNumber", "discNumber", "discName", "year", "posterUrl", "overview"];
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    return { status: 400, error: "Identification contains unsupported fields" };
  }
  const providerMap: Record<string, MetadataProviderId> = { tvdb: "tvdb", tmdb: "tmdb", "tmdb-tv": "tmdb", imdb: "imdb", manual: "manual" };
  const provider = typeof body.provider === "string" ? providerMap[body.provider] : undefined;
  if (typeof body.seriesName !== "string" || !body.seriesName.trim() || body.seriesName.length > 200) {
    return { status: 400, error: "Series name is required (1 to 200 characters)" };
  }
  if (!provider) return { status: 400, error: "Provider must be tvdb, tmdb, imdb, or manual" };
  if (body.providerId !== undefined && body.providerId !== null &&
    (typeof body.providerId !== "string" || !body.providerId.trim() || body.providerId.length > 200)) {
    return { status: 400, error: "Provider ID must contain 1 to 200 characters" };
  }
  if (!Number.isInteger(body.seasonNumber) || Number(body.seasonNumber) < 0 || Number(body.seasonNumber) > 100) {
    return { status: 400, error: "Season number must be an integer from 0 to 100" };
  }
  if (body.discNumber !== undefined && body.discNumber !== null &&
    (!Number.isInteger(body.discNumber) || Number(body.discNumber) < 1 || Number(body.discNumber) > 100)) {
    return { status: 400, error: "Disc number must be an integer from 1 to 100 when provided" };
  }
  if (body.discName !== undefined && body.discName !== null &&
    (typeof body.discName !== "string" || body.discName.length > 200)) {
    return { status: 400, error: "Disc name must not exceed 200 characters" };
  }
  if (body.year !== undefined && body.year !== null &&
    (!Number.isInteger(body.year) || Number(body.year) < 1900 || Number(body.year) > 2200)) {
    return { status: 400, error: "Year is invalid" };
  }
  if (body.overview !== undefined && body.overview !== null &&
    (typeof body.overview !== "string" || body.overview.length > 4000)) {
    return { status: 400, error: "Overview is too long" };
  }
  const posterReferences = typeof body.posterUrl === "string" && body.posterUrl
    ? [{ kind: "poster", url: body.posterUrl }] : [];
  if (posterReferences.length > 0 && !validArtworkReferences(posterReferences)) {
    return { status: 400, error: "Poster URL is not an allowed artwork source" };
  }
  try {
    repositories.discRecovery.recordDetection(fingerprint, "dvd", "tv_series");
    const username = repositories.setup.get().adminUsername;
    if (!username) return { status: 503, error: "Administrator identity is unavailable" };
    const recovery = repositories.discRecovery.update(fingerprint, {
      finalMediaType: "tv_series",
      mediaTypeOverrideAudit: {
        username,
        reason: "Confirmed guided TV identification"
      },
      metadataProvider: provider,
      providerId: (body.providerId as string | null | undefined) ?? null,
      seriesName: body.seriesName.trim(),
      seasonNumber: Number(body.seasonNumber),
      discNumber: body.discNumber === undefined || body.discNumber === null ? null : Number(body.discNumber),
      discName: typeof body.discName === "string" && body.discName.trim() ? body.discName.trim() : null,
      identifiedBy: "user",
      importedMetadata: {
        entityType: "series",
        title: body.seriesName.trim(),
        ...(typeof body.year === "number" ? { year: body.year } : {}),
        ...(typeof body.overview === "string" ? { overview: body.overview } : {})
      },
      artworkReferences: posterReferences
    });
    if (!recovery) return { status: 404, error: "Disc recovery record not found" };
    repositories.recovery.clearInsertedDisc();
    return { recovery };
  } catch (error) {
    return { status: 400, error: error instanceof Error ? error.message : "Identification could not be saved" };
  }
}

app.post<{ Body: unknown }>("/api/v1/tv/identify/search", async (request, reply) => {
  const body = request.body as Record<string, unknown> | null;
  const query = typeof body?.query === "string" ? body.query.trim() : "";
  if (!query || query.length > 200) return reply.code(400).send({ error: "Search text is required (1 to 200 characters)" });
  const variants = searchVariants(query);
  const searchTerms = /^(?:tvdb|tmdb)\s*[:=#-]?\s*\d+$/i.test(query) || /^tt\d{5,}$/i.test(query)
    ? [query] : [query, ...variants.filter((variant) => variant.toLocaleLowerCase() !== query.toLocaleLowerCase())].slice(0, 3);
  const results = [];
  for (const term of searchTerms) {
    results.push(...await tvMetadataLookupService.searchSeries(term));
    if (results.some((entry) => entry.candidates.length > 0)) break;
  }
  const seen = new Set<string>();
  const candidates = results.flatMap((entry) => entry.candidates)
    .filter((candidate) => {
      const key = `${candidate.provider}:${candidate.seriesId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => right.confidence - left.confidence);
  return {
    query,
    candidates,
    queries: results.map((entry) => ({
      query: entry.query,
      providerId: entry.providerId,
      matches: entry.candidates.length,
      durationMs: entry.durationMs,
      ...(entry.failure ? { failure: entry.failure } : {})
    }))
  };
});

function completedTvDiscHistoryForTask(task: TvMatchingTask) {
  const recovery = repositories.discRecovery.get(task.fingerprint);
  if (!recovery?.seriesName || recovery.seasonNumber === null ||
    !Number.isInteger(recovery.seasonNumber) || recovery.seasonNumber < 0 || recovery.seasonNumber > 100) return [];
  const normalizedSeries = normalizeDiscName(recovery.seriesName).toLocaleLowerCase();
  return repositories.completedTvDiscHistory.listForSeason(recovery.seasonNumber)
    .filter((record) =>
      (recovery.providerId !== null && recovery.providerId === record.providerId &&
        recovery.metadataProvider === record.metadataProvider) ||
      (normalizedSeries !== "" && normalizeDiscName(record.seriesName).toLocaleLowerCase() === normalizedSeries)
    );
}

app.get("/api/v1/tv/matching", async () => ({
  tasks: repositories.tvMatchingTasks.list().map((task) => ({
    task,
    progress: tvMatchingProgress(task.assignments),
    recovery: repositories.discRecovery.get(task.fingerprint) ?? null,
    completedDiscHistory: completedTvDiscHistoryForTask(task),
    mediaTypeAudit: repositories.discRecovery.mediaTypeOverrideAudit(task.fingerprint)
  }))
}));

app.get<{ Params: { id: string } }>("/api/v1/tv/matching/:id", async (request, reply) => {
  const task = repositories.tvMatchingTasks.get(request.params.id);
  if (!task) return reply.code(404).send({ error: "TV matching task was not found" });
  return {
    task,
    progress: tvMatchingProgress(task.assignments),
    recovery: repositories.discRecovery.get(task.fingerprint) ?? null,
    completedDiscHistory: completedTvDiscHistoryForTask(task),
    mediaTypeAudit: repositories.discRecovery.mediaTypeOverrideAudit(task.fingerprint)
  };
});

async function resolveStagedTvTrack(task: TvMatchingTask, trackId: string): Promise<{ path: string; size: number }> {
  const fileName = task.files[trackId];
  if (!fileName || basename(fileName) !== fileName || fileName.includes("..")) {
    throw new Error("Staged track file reference is invalid");
  }
  const rootInfo = await lstat(task.stagingPath);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("TV staging task path is not a regular directory");
  }
  const filePath = resolve(task.stagingPath, fileName);
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1024) {
    throw new Error("Staged track file is missing or invalid");
  }
  const [rootPath, resolvedFile] = await Promise.all([
    realpath(task.stagingPath),
    realpath(filePath)
  ]);
  const relativeFile = relative(rootPath, resolvedFile);
  if (relativeFile === ".." || relativeFile.startsWith(`..${sep}`) || isAbsolute(relativeFile)) {
    throw new Error("Staged track file resolves outside its protected task directory");
  }
  return { path: resolvedFile, size: info.size };
}

async function tvTrackPreviewPath(task: TvMatchingTask, trackId: string, sourcePath: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(trackId)) throw new Error("Track identifier is invalid");
  const previewDirectory = resolve(task.stagingPath, ".previews");
  await mkdir(previewDirectory, { recursive: true, mode: 0o750 });
  const previewInfo = await lstat(previewDirectory);
  if (!previewInfo.isDirectory() || previewInfo.isSymbolicLink()) {
    throw new Error("TV preview directory is not a regular directory");
  }
  const destination = resolve(previewDirectory, `${trackId}.mp4`);
  try {
    const cached = await lstat(destination);
    if (!cached.isFile() || cached.isSymbolicLink() || cached.size < 1024) {
      throw new Error("Cached TV preview is invalid");
    }
    return destination;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (error instanceof Error && error.message === "Cached TV preview is invalid") await unlink(destination);
      else throw error;
    }
  }
  const duration = task.assignments.find((assignment) => assignment.trackId === trackId)?.durationSeconds ?? 0;
  const offset = Math.max(0, Math.floor((duration - 45) * 0.35));
  const temporary = resolve(previewDirectory, `${trackId}.${randomUUID()}.tmp.mp4`);
  try {
    await runProcess(process.env.FFMPEG_COMMAND ?? "ffmpeg", [
      "-hide_banner", "-nostdin", "-y",
      ...(offset ? ["-ss", String(offset)] : []),
      "-i", sourcePath,
      "-t", "45",
      "-map", "0:v:0",
      "-vf", "scale=960:-2:force_original_aspect_ratio=decrease",
      "-an", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30",
      "-movflags", "+faststart",
      temporary
    ], { timeoutMs: 180_000 });
    const generated = await lstat(temporary);
    if (!generated.isFile() || generated.isSymbolicLink() || generated.size < 1024) {
      throw new Error("FFmpeg produced an invalid preview clip");
    }
    const [rootPath, resolvedPreview] = await Promise.all([
      realpath(task.stagingPath),
      realpath(temporary)
    ]);
    const relativePreview = relative(rootPath, resolvedPreview);
    if (relativePreview === ".." || relativePreview.startsWith(`..${sep}`) || isAbsolute(relativePreview)) {
      throw new Error("Generated TV preview resolves outside its protected task directory");
    }
    await rename(temporary, destination);
    return destination;
  } catch (error) {
    try {
      await unlink(temporary);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        app.log.error({ err: cleanupError, path: temporary }, "Failed to clean incomplete TV preview clip");
      }
    }
    throw error;
  }
}

app.get<{ Params: { id: string; trackId: string } }>("/api/v1/tv/matching/:id/preview/:trackId", async (request, reply) => {
  const task = repositories.tvMatchingTasks.get(request.params.id);
  if (!task) return reply.code(404).send({ error: "TV matching task was not found" });
  try {
    const staged = await resolveStagedTvTrack(task, request.params.trackId);
    const previewPath = extname(staged.path).toLowerCase() === ".mp4"
      ? staged.path
      : await tvTrackPreviewPath(task, request.params.trackId, staged.path);
    const preview = await stat(previewPath);
    const range = request.headers.range;
    let start = 0;
    let end = preview.size - 1;
    let statusCode = 200;
    if (typeof range === "string") {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) {
        return reply.code(416).header("Content-Range", `bytes */${preview.size}`).send();
      }
      if (match[1]) {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : end;
      } else {
        const suffixLength = Number(match[2]);
        start = Math.max(0, preview.size - suffixLength);
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        start < 0 || end < start || start >= preview.size) {
        return reply.code(416).header("Content-Range", `bytes */${preview.size}`).send();
      }
      end = Math.min(end, preview.size - 1);
      statusCode = 206;
      reply.header("Content-Range", `bytes ${start}-${end}/${preview.size}`);
    }
    return reply
      .code(statusCode)
      .header("Accept-Ranges", "bytes")
      .header("Content-Length", String(end - start + 1))
      .header("Content-Type", "video/mp4")
      .header("Content-Disposition", "inline")
      .header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff")
      .send(createReadStream(previewPath, { start, end }));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return reply.code(404).send({ error: "Staged track file was not found" });
    request.log.warn({ err: error, taskId: task.jobId, trackId: request.params.trackId },
      "Staged TV preview could not be opened");
    return reply.code(500).send({ error: error instanceof Error ? error.message : "Staged track preview failed" });
  }
});

app.put<{ Params: { id: string }; Body: unknown }>("/api/v1/tv/matching/:id/identification", async (request, reply) => {
  const task = repositories.tvMatchingTasks.get(request.params.id);
  if (!task) return reply.code(404).send({ error: "TV matching task was not found" });
  if (task.status === "processing") return reply.code(409).send({ error: "TV matching task is already processing" });
  const priorRecovery = repositories.discRecovery.get(task.fingerprint);
  const outcome = saveIdentification(task.fingerprint, request.body);
  if ("error" in outcome) return reply.code(outcome.status).send({ error: outcome.error });
  const identityChanged = priorRecovery?.seriesName !== outcome.recovery.seriesName ||
    priorRecovery?.providerId !== outcome.recovery.providerId ||
    priorRecovery?.seasonNumber !== outcome.recovery.seasonNumber;
  const filesystemVolumeName = task.source.manifest.attributes?.filesystemVolumeName;
  const volumeName = typeof filesystemVolumeName === "string" ? filesystemVolumeName.trim() : "";
  const metadata = outcome.recovery.importedMetadata ?? {};
  const knownLabels = new Set(Array.isArray(metadata.knownLabels)
    ? metadata.knownLabels.filter((value): value is string => typeof value === "string") : []);
  const knownVolumeNames = new Set(Array.isArray(metadata.knownVolumeNames)
    ? metadata.knownVolumeNames.filter((value): value is string => typeof value === "string") : []);
  if (task.source.label.trim()) knownLabels.add(task.source.label.trim());
  if (volumeName) knownVolumeNames.add(volumeName);
  const learnedRecovery = repositories.discRecovery.update(task.fingerprint, {
    ...(identityChanged ? { mappings: [] } : {}),
    importedMetadata: { ...metadata, knownLabels: [...knownLabels], knownVolumeNames: [...knownVolumeNames] }
  });
  if (!learnedRecovery) return reply.code(409).send({ error: "Identification was saved but series evidence could not be stored" });
  const assignments = identityChanged
    ? task.assignments.map((assignment) => {
      const { selectedEpisodes: _selectedEpisodes, ...unmatched } = assignment;
      return { ...unmatched, confirmed: false };
    })
    : task.assignments;
  const updatedTask = repositories.tvMatchingTasks.update(task.jobId, {
    assignments,
    status: assignments.length ? "awaiting-mapping" : "awaiting-identification"
  });
  if (!updatedTask) return reply.code(409).send({ error: "Identification was saved but the staged disc could not be updated" });
  events.emit("status");
  return { recovery: learnedRecovery, task: updatedTask };
});

app.put<{ Params: { id: string }; Body: unknown }>("/api/v1/tv/matching/:id/assignments", async (request, reply) => {
  const task = repositories.tvMatchingTasks.get(request.params.id);
  if (!task) return reply.code(404).send({ error: "TV matching task was not found" });
  if (task.status === "processing" || task.status === "completed") {
    return reply.code(409).send({ error: "TV matching task is not available for episode changes" });
  }
  if (typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) {
    return reply.code(400).send({ error: "Episode assignments must be an object" });
  }
  const rawAssignments = (request.body as Record<string, unknown>).assignments;
  if (!Array.isArray(rawAssignments)) return reply.code(400).send({ error: "Episode assignments must be an array" });
  const recovery = repositories.discRecovery.get(task.fingerprint);
  if (!recovery?.seriesName || recovery.seasonNumber === null) {
    return reply.code(409).send({ error: "Identify the series and season before assigning episodes" });
  }
  const requested = new Map<string, { episodeNumbers: number[]; episodeTitles?: string[]; title?: string }>();
  for (const value of rawAssignments) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return reply.code(400).send({ error: "Each episode assignment must be an object" });
    }
    const assignment = value as Record<string, unknown>;
    if (typeof assignment.trackId !== "string" || !task.assignments.some((item) => item.trackId === assignment.trackId) ||
      requested.has(assignment.trackId)) {
      return reply.code(400).send({ error: "Episode assignment references an unknown or duplicate track" });
    }
    const episodeNumbers = Array.isArray(assignment.episodeNumbers)
      ? assignment.episodeNumbers : [assignment.episodeNumber];
    if (episodeNumbers.length > 3 ||
      episodeNumbers.some((number) => !Number.isInteger(number) || Number(number) < 0 || Number(number) > 1000)) {
      return reply.code(400).send({ error: "Provide up to three episode numbers from 0 to 1000" });
    }
    if (new Set(episodeNumbers).size !== episodeNumbers.length) {
      return reply.code(400).send({ error: "A track cannot be matched to the same episode more than once" });
    }
    if (assignment.episodeTitles !== undefined &&
      (!Array.isArray(assignment.episodeTitles) || assignment.episodeTitles.length !== episodeNumbers.length ||
        assignment.episodeTitles.some((title) => typeof title !== "string" || title.length > 200))) {
      return reply.code(400).send({ error: "Episode titles must match the selected episodes and be at most 200 characters" });
    }
    if (assignment.title !== undefined &&
      (typeof assignment.title !== "string" || assignment.title.length > 200)) {
      return reply.code(400).send({ error: "Episode title must not exceed 200 characters" });
    }
    requested.set(assignment.trackId, {
      episodeNumbers: episodeNumbers.map(Number),
      ...(Array.isArray(assignment.episodeTitles)
        ? { episodeTitles: assignment.episodeTitles as string[] } : {}),
      ...(typeof assignment.title === "string" && assignment.title.trim() ? { title: assignment.title.trim() } : {})
    });
  }
  const seriesId = recovery.providerId || recovery.seriesName;
  const assignments = task.assignments.map((item) => {
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
        seasonNumber: recovery.seasonNumber!,
        episodeNumber,
        ...(selected.episodeTitles?.[index] ? { title: selected.episodeTitles[index] } :
          selected.title ? { title: selected.title } : {})
      }))
    };
  });
  const updated = repositories.tvMatchingTasks.update(task.jobId, {
    assignments,
    status: tvMatchingReviewStatus(assignments),
    failure: null
  });
  if (!updated) return reply.code(404).send({ error: "TV matching task could not be updated" });
  const mappings = assignments.flatMap((assignment) =>
    assignment.confirmed && assignment.selectedEpisodes?.length
      ? [{ trackId: assignment.trackId, episodes: assignment.selectedEpisodes }]
      : []);
  const updatedRecovery = repositories.discRecovery.update(task.fingerprint, { mappings });
  if (!updatedRecovery) {
    return reply.code(409).send({ error: "Episode selections were saved, but disc recovery mappings could not be updated" });
  }
  let continuation: "not-ready" | "queued" | "started" | "blocked" = "not-ready";
  const progress = tvMatchingProgress(updated.assignments);
  if (progress.fullyMatched) {
    const currentRecovery = repositories.discRecovery.get(task.fingerprint);
    if (currentRecovery?.mediaTypeOverridden && currentRecovery.finalMediaType !== "tv_series") {
      continuation = "blocked";
    } else if (activeJob()) {
      continuation = "queued";
    } else if (tvMatchingActions) {
      continuation = "started";
      void tvMatchingActions.continue(task.jobId, "assignment-save").catch((error: unknown) => {
        request.log.error({ err: error, jobId: task.jobId }, "Automatic TV publishing continuation failed");
      });
    } else {
      return reply.code(503).send({ error: "TV matching service is unavailable; saved matches remain ready to resume" });
    }
  }
  events.emit("status");
  return { task: updated, progress, continuation };
});

app.post<{ Params: { id: string } }>("/api/v1/tv/matching/:id/continue", async (request, reply) => {
  const task = repositories.tvMatchingTasks.get(request.params.id);
  if (!task) return reply.code(404).send({ error: "TV matching task was not found" });
  if (task.status === "processing") return reply.code(409).send({ error: "TV matching task is already processing" });
  if (task.status === "partially-matched") {
    return reply.code(409).send({ error: "Save matches for every remaining track before publishing; unmatched tracks are still safely staged" });
  }
  const recovery = repositories.discRecovery.get(task.fingerprint);
  if (recovery?.mediaTypeOverridden && recovery.finalMediaType !== "tv_series") {
    return reply.code(409).send({ error: "The manual media classification is not TV Series; this staged TV workflow cannot be published" });
  }
  if (activeJob()) return reply.code(409).send({ error: "Wait until the active disc job finishes before continuing this TV task" });
  if (!tvMatchingActions) return reply.code(503).send({ error: "TV matching service is unavailable" });
  void tvMatchingActions.continue(task.jobId, "continue-action").catch((error: unknown) => {
    request.log.error({ err: error, jobId: task.jobId }, "TV matching continuation failed");
  });
  return reply.code(202).send({ accepted: true, jobId: task.jobId });
});

app.delete<{ Params: { id: string }; Body: unknown }>("/api/v1/tv/matching/:id/unmatched", async (request, reply) => {
  const task = repositories.tvMatchingTasks.get(request.params.id);
  if (!task) return reply.code(404).send({ error: "TV matching task was not found" });
  if (task.status === "processing" || task.status === "completed") {
    return reply.code(409).send({ error: "Unmatched tracks cannot be removed while the TV task is processing or completed" });
  }
  const body = request.body as Record<string, unknown> | null;
  if (body?.confirmed !== true) return reply.code(400).send({ error: "Confirm deletion of unmatched staged tracks" });
  const retained = task.assignments.filter((assignment) =>
    assignment.confirmed === true && Boolean(assignment.selectedEpisodes?.length));
  if (!retained.length) {
    return reply.code(409).send({ error: "Match at least one track first, or remove the entire disc from review" });
  }
  const retainedTrackIds = new Set(retained.map((assignment) => assignment.trackId));
  const removedFiles = Object.entries(task.files).filter(([trackId]) => !retainedTrackIds.has(trackId));
  const files = Object.fromEntries(Object.entries(task.files).filter(([trackId]) => retainedTrackIds.has(trackId)));
  const updated = repositories.tvMatchingTasks.update(task.jobId, {
    assignments: retained,
    files,
    status: "ready-to-publish",
    failure: null
  });
  if (!updated) return reply.code(409).send({ error: "TV matching task could not be updated" });
  const recovery = repositories.discRecovery.update(task.fingerprint, {
    mappings: retained.map((assignment) => ({
      trackId: assignment.trackId,
      episodes: assignment.selectedEpisodes!
    }))
  });
  if (!recovery) {
    return reply.code(409).send({ error: "Unmatched tracks were removed from the task but recovery mappings could not be updated" });
  }
  try {
    for (const [trackId] of removedFiles) {
      const staged = await resolveStagedTvTrack(task, trackId);
      await unlink(staged.path);
    }
  } catch (error) {
    request.log.error({ err: error, taskId: task.jobId }, "Failed to delete one or more unmatched staged TV tracks");
    return reply.code(500).send({
      error: error instanceof Error
        ? `The task was updated, but unmatched staging cleanup failed: ${error.message}`
        : "The task was updated, but unmatched staging cleanup failed"
    });
  }
  let continuation: "queued" | "started" = "queued";
  if (!activeJob() && tvMatchingActions) {
    continuation = "started";
    void tvMatchingActions.continue(task.jobId, "unmatched-removal").catch((error: unknown) => {
      request.log.error({ err: error, jobId: task.jobId }, "Automatic TV publishing continuation failed after track removal");
    });
  }
  events.emit("status");
  return { task: updated, progress: tvMatchingProgress(updated.assignments), continuation };
});

app.delete<{ Params: { id: string }; Body: unknown }>("/api/v1/tv/matching/:id", async (request, reply) => {
  const task = repositories.tvMatchingTasks.get(request.params.id);
  if (!task) return reply.code(404).send({ error: "TV matching task was not found" });
  if (task.status === "processing") return reply.code(409).send({ error: "A TV matching task cannot be deleted while processing" });
  const body = request.body as Record<string, unknown> | null;
  if (body?.confirmed !== true) return reply.code(400).send({ error: "Confirm deletion of the unmatched TV disc" });
  if (!tvMatchingActions) return reply.code(503).send({ error: "TV matching service is unavailable" });
  try {
    await tvMatchingActions.remove(task.jobId);
    return { ok: true };
  } catch (error) {
    return reply.code(409).send({ error: error instanceof Error ? error.message : "TV matching task could not be deleted" });
  }
});

app.get<{ Params: { id: string } }>("/api/v1/tv/plans/:id/identification", async (request, reply) => {
  const plan = repositories.tvProcessingPlans.get(request.params.id);
  if (!plan) return reply.code(404).send({ error: "TV processing plan not found" });
  const recovery = repositories.discRecovery.get(plan.fingerprint) ?? null;
  return {
    fingerprint: plan.fingerprint,
    identification: recovery?.seriesName ? {
      seriesName: recovery.seriesName,
      provider: recovery.metadataProvider,
      providerId: recovery.providerId,
      seasonNumber: recovery.seasonNumber,
      discNumber: recovery.discNumber,
      discName: recovery.discName,
      identifiedBy: recovery.identifiedBy
    } : null,
    diagnostics: recovery?.identificationDiagnostics ?? null
  };
});

app.put<{ Params: { id: string }; Body: unknown }>("/api/v1/tv/plans/:id/identification", async (request, reply) => {
  const plan = repositories.tvProcessingPlans.get(request.params.id);
  if (!plan) return reply.code(404).send({ error: "TV processing plan not found" });
  if (isDiscRecoveryActive(plan.fingerprint)) return reply.code(409).send({ error: "Wait until this disc finishes processing before identifying it" });
  const outcome = saveIdentification(plan.fingerprint, request.body);
  if ("error" in outcome) return reply.code(outcome.status).send({ error: outcome.error });
  return outcome;
});

app.put<{ Params: { fingerprint: string }; Body: unknown }>("/api/v1/discs/:fingerprint/identification", async (request, reply) => {
  if (!/^[0-9a-f]{16,128}$/i.test(request.params.fingerprint)) {
    return reply.code(400).send({ error: "Disc fingerprint is invalid" });
  }
  if (isDiscRecoveryActive(request.params.fingerprint)) return reply.code(409).send({ error: "Wait until this disc finishes processing before identifying it" });
  const outcome = saveIdentification(request.params.fingerprint, request.body);
  if ("error" in outcome) return reply.code(outcome.status).send({ error: outcome.error });
  return outcome;
});

app.get<{ Querystring: { limit?: string } }>("/api/v1/discs/overridden", async (request, reply) => {
  const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    return reply.code(400).send({ error: "Disc recovery limit must be between 1 and 1000" });
  }
  return { discs: repositories.discRecovery.list(limit).filter((entry) =>
    entry.discTypeOverridden || entry.mediaTypeOverridden) };
});

app.get<{ Params: { fingerprint: string } }>("/api/v1/discs/recovery/:fingerprint", async (request) => ({
  recovery: repositories.discRecovery.get(request.params.fingerprint) ?? null,
  mediaTypeAudit: repositories.discRecovery.mediaTypeOverrideAudit(request.params.fingerprint)
}));

app.put<{ Params: { fingerprint: string }; Body: unknown }>("/api/v1/discs/recovery/:fingerprint", async (request, reply) => {
  if (isDiscRecoveryActive(request.params.fingerprint)) return reply.code(409).send({ error: "Wait until this disc finishes processing before changing recovery data" });
  if (typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) {
    return reply.code(400).send({ error: "Recovery update must be an object" });
  }
  const body = request.body as Record<string, unknown>;
  const allowed = ["discType", "mediaType", "mediaTypeReason", "metadataProvider", "providerId", "seriesName", "seasonNumber",
    "mappings", "notes", "importedMetadata", "artworkReferences"];
  if (Object.keys(body).some((key) => !allowed.includes(key)) ||
    (body.discType !== undefined && !discTypes.includes(body.discType as never)) ||
    (body.mediaType !== undefined && !mediaTypes.includes(body.mediaType as never)) ||
    (body.metadataProvider !== undefined && !metadataProviderIds.includes(body.metadataProvider as never)) ||
    (body.providerId !== undefined && body.providerId !== null &&
      (typeof body.providerId !== "string" || body.providerId.trim().length < 1 || body.providerId.length > 200)) ||
    (body.seriesName !== undefined && body.seriesName !== null &&
      (typeof body.seriesName !== "string" || body.seriesName.trim().length < 1 || body.seriesName.length > 200)) ||
    (body.seasonNumber !== undefined && body.seasonNumber !== null &&
      (!Number.isInteger(body.seasonNumber) || Number(body.seasonNumber) < 0 || Number(body.seasonNumber) > 100)) ||
    (body.notes !== undefined && body.notes !== null &&
      (typeof body.notes !== "string" || body.notes.length > 2000)) ||
    (body.mediaTypeReason !== undefined &&
      (typeof body.mediaTypeReason !== "string" || body.mediaTypeReason.length > 500)) ||
    (body.importedMetadata !== undefined && !validImportedMetadata(body.importedMetadata)) ||
    (body.artworkReferences !== undefined && !validArtworkReferences(body.artworkReferences))) {
    return reply.code(400).send({ error: "Recovery update contains invalid values" });
  }
  try {
    const username = repositories.setup.get().adminUsername;
    if (body.mediaType !== undefined && !username) {
      return reply.code(503).send({ error: "Administrator identity is unavailable" });
    }
    const recovery = repositories.discRecovery.update(request.params.fingerprint, {
      ...(body.discType === undefined ? {} : { finalDiscType: body.discType as DiscType }),
      ...(body.mediaType === undefined ? {} : { finalMediaType: body.mediaType as MediaType }),
      ...(body.mediaType === undefined ? {} : {
        mediaTypeOverrideAudit: {
          username: username!,
          reason: typeof body.mediaTypeReason === "string" ? body.mediaTypeReason : null
        }
      }),
      ...(body.metadataProvider === undefined ? {} : { metadataProvider: body.metadataProvider as MetadataProviderId }),
      ...(body.providerId === undefined ? {} : { providerId: body.providerId as string | null }),
      ...(body.seriesName === undefined ? {} : { seriesName: body.seriesName as string | null }),
      ...(body.seasonNumber === undefined ? {} : { seasonNumber: body.seasonNumber as number | null }),
      ...(body.mappings === undefined ? {} : { mappings: parseEpisodeMappings(body.mappings) }),
      ...(body.importedMetadata === undefined ? {} : { importedMetadata: body.importedMetadata as Record<string, unknown> | null }),
      ...(body.artworkReferences === undefined ? {} : { artworkReferences: body.artworkReferences as Array<{ kind: string; url: string }> }),
      ...(body.notes === undefined ? {} : { notes: body.notes as string | null })
    });
    if (!recovery) return reply.code(404).send({ error: "Disc recovery record not found" });
    repositories.recovery.clearInsertedDisc();
    return { recovery };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : "Recovery update could not be saved" });
  }
});

app.post<{ Body: unknown }>("/api/v1/tv/metadata/series/lookup", async (request, reply) => {
  if (typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) {
    return reply.code(400).send({ error: "Series lookup request must be an object" });
  }
  const body = request.body as Record<string, unknown>;
  const manualProvider = body.provider === "manual";
  if (!["tvdb", "tmdb", "imdb", "anidb", "manual"].includes(String(body.provider)) ||
    (!manualProvider && (typeof body.providerId !== "string" || !body.providerId.trim() || body.providerId.length > 200)) ||
    (manualProvider && ((body.providerId !== undefined && typeof body.providerId !== "string") ||
      typeof body.seriesName !== "string" || !body.seriesName.trim() || body.seriesName.length > 200))) {
    return reply.code(400).send({ error: "Series provider and ID are required" });
  }
  const provider = body.provider as string;
  const providerId = body.providerId as string;
  if (provider === "anidb") return reply.code(501).send({ error: "AniDB direct lookup is not supported by this installation" });
  if (provider === "manual") {
    const title = (body.seriesName as string).trim();
    const manualId = typeof body.providerId === "string" && body.providerId.trim()
      ? body.providerId.trim() : `manual:${title}`;
    return { series: {
      id: manualId, entityType: "series", title, confidence: 1,
      metadata: { seriesId: manualId, title }, identifiers: { manual: manualId }
    } };
  }
  const settings = getSettings();
  const configuredProviderId = provider === "imdb" || provider === "tmdb" ? "tmdb-tv" : "tvdb";
  if (!settings.tvMetadataProviderEnabled[configuredProviderId]) {
    return reply.code(400).send({ error: `${configuredProviderId} provider is disabled` });
  }
  const idValid = provider === "tvdb" ? /^\d{1,12}$/.test(providerId) :
    provider === "tmdb" ? /^\d{1,12}$/.test(providerId) : /^tt\d{7,10}$/.test(providerId);
  if (!idValid) return reply.code(400).send({ error: "Provider ID format is invalid" });
  const apiKey = settings.tvMetadataProviderApiKeys[configuredProviderId] ?? "";
  if (!apiKey) return reply.code(400).send({ error: `${configuredProviderId} API key is not configured` });
  try {
    const series = provider === "imdb"
      ? await tvMetadataProviderRegistry.lookupImdbId(providerId.trim(), apiKey)
      : await tvMetadataProviderRegistry.lookupById(configuredProviderId, providerId.trim(), apiKey);
    if (!series) return reply.code(404).send({ error: "No series was found for that provider ID" });
    return { series };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Series lookup failed";
    app.log.warn({ err: error, provider, providerId }, "TV metadata ID lookup failed");
    return reply.code(502).send({ error: message });
  }
});

app.post<{ Body: unknown }>("/api/v1/tv/metadata/episodes/lookup", async (request, reply) => {
  if (typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) {
    return reply.code(400).send({ error: "Episode lookup request must be an object" });
  }
  const body = request.body as Record<string, unknown>;
  if (!["tvdb", "tmdb", "imdb", "anidb"].includes(String(body.provider)) ||
    typeof body.providerId !== "string" || !body.providerId.trim() || body.providerId.length > 200 ||
    !Number.isInteger(body.seasonNumber) || Number(body.seasonNumber) < 0 || Number(body.seasonNumber) > 100) {
    return reply.code(400).send({ error: "Provider ID and valid season number are required" });
  }
  const provider = body.provider as string;
  if (provider === "anidb") return reply.code(501).send({ error: "AniDB episode lookup is not supported by this installation" });
  const configuredProviderId = provider === "tvdb" ? "tvdb" : "tmdb-tv";
  const settings = getSettings();
  if (!settings.tvMetadataProviderEnabled[configuredProviderId]) {
    return reply.code(400).send({ error: `${configuredProviderId} provider is disabled` });
  }
  const idValid = provider === "tvdb" ? /^\d{1,12}$/.test(body.providerId) :
    provider === "tmdb" ? /^\d{1,12}$/.test(body.providerId) : /^tt\d{7,10}$/.test(body.providerId);
  if (!idValid) return reply.code(400).send({ error: "Provider ID format is invalid" });
  const apiKey = settings.tvMetadataProviderApiKeys[configuredProviderId] ?? "";
  if (!apiKey) return reply.code(400).send({ error: `${configuredProviderId} API key is not configured` });
  try {
    let seriesId = body.providerId.trim();
    if (provider === "imdb") {
      const series = await tvMetadataProviderRegistry.lookupImdbId(seriesId, apiKey);
      seriesId = typeof series?.identifiers?.tmdbTvId === "string" ? series.identifiers.tmdbTvId : "";
      if (!seriesId) return reply.code(404).send({ error: "No TV series was found for that IMDb ID" });
    }
    const episodes = await tvMetadataProviderRegistry.lookupEpisodesById(
      configuredProviderId, seriesId, Number(body.seasonNumber), apiKey);
    return { episodes, provider, providerSeriesId: seriesId };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Episode metadata lookup failed";
    app.log.warn({ err: error, provider, providerId: body.providerId, seasonNumber: body.seasonNumber },
      "TV episode ID lookup failed");
    return reply.code(502).send({ error: message });
  }
});

app.post<{ Params: { id: string }; Body: unknown }>("/api/v1/tv/plans/:id/review", async (request, reply) => {
  if (typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) {
    return reply.code(400).send({ error: "TV review request must be an object" });
  }
  const body = request.body as Record<string, unknown>;
  if (!["approve", "reject", "defer"].includes(String(body.action)) ||
    typeof body.reviewer !== "string" || !body.reviewer.trim() || body.reviewer.length > 120 ||
    (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.length > 2000))) {
    return reply.code(400).send({ error: "TV review requires a valid action, reviewer, and optional reason" });
  }
  if (body.action === "reject" && (typeof body.reason !== "string" || !body.reason.trim())) {
    return reply.code(400).send({ error: "Rejecting a TV plan requires a reason" });
  }
  try {
    const action = body.action === "approve"
      ? { type: "approve-plan" as const, planId: request.params.id, reviewer: body.reviewer }
      : body.action === "reject"
        ? { type: "reject-plan" as const, planId: request.params.id, reviewer: body.reviewer, reason: body.reason as string }
        : { type: "defer-plan" as const, planId: request.params.id, reviewer: body.reviewer, ...(typeof body.reason === "string" ? { reason: body.reason } : {}) };
    const plan = tvReview.applyApproval(action);
    events.emit("status");
    return { plan };
  } catch (error) {
    const message = error instanceof Error ? error.message : "TV review action failed";
    return reply.code(message.includes("not found") ? 404 : 409).send({ error: message });
  }
});

app.post<{ Params: { id: string }; Body: unknown }>("/api/v1/tv/plans/:id/corrections", async (request, reply) => {
  if (typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) {
    return reply.code(400).send({ error: "TV correction request must be an object" });
  }
  const body = request.body as Record<string, unknown>;
  const validEpisode = (value: unknown): value is Episode => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const episode = value as Record<string, unknown>;
    return typeof episode.seriesId === "string" && episode.seriesId.trim().length > 0 &&
      episode.seriesId.length <= 200 &&
      Number.isInteger(episode.seasonNumber) && Number(episode.seasonNumber) >= 0 && Number(episode.seasonNumber) <= 100 &&
      Number.isInteger(episode.episodeNumber) && Number(episode.episodeNumber) >= 0 && Number(episode.episodeNumber) <= 1000 &&
      (episode.title === undefined || (typeof episode.title === "string" && episode.title.length <= 500));
  };
  if (typeof body.itemId !== "string" || !body.itemId.trim() ||
    typeof body.reviewer !== "string" || !body.reviewer.trim() || body.reviewer.length > 120 ||
    typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 2000) {
    return reply.code(400).send({ error: "TV correction requires a track, reviewer, and reason" });
  }
  try {
    if (body.action === "mark-unknown") {
      return { plan: tvReview.markUnknown(request.params.id, body.itemId, body.reviewer, body.reason) };
    }
    if (!["accept-match", "reject-match", "assign-episodes"].includes(String(body.action)) ||
      !Array.isArray(body.episodes) || body.episodes.length < 1 || body.episodes.length > 3 ||
      !body.episodes.every(validEpisode)) {
      return reply.code(400).send({ error: "TV correction action or episode list is invalid" });
    }
    const correction = tvReview.applyCorrection({
      type: body.action as "accept-match" | "reject-match" | "assign-episodes",
      planId: request.params.id,
      itemId: body.itemId,
      episodes: body.episodes,
      reason: body.reason
    });
    return { correction };
  } catch (error) {
    const message = error instanceof Error ? error.message : "TV correction failed";
    return reply.code(message.includes("not found") ? 404 : 409).send({ error: message });
  }
});

app.get("/api/v1/tv/validation", async () => ({
  summary: tvValidation.summary(),
  correctionCount: repositories.tvEpisodeFeedback.count(),
  cases: tvValidation.list(1000).reverse()
}));

app.get<{ Params: { id: string } }>("/api/v1/tv/validation/:id", async (request, reply) => {
  const evidence = tvValidation.get(request.params.id);
  if (!evidence) return reply.code(404).send({ error: "TV validation case not found" });
  return { evidence, report: tvValidation.report(request.params.id) };
});

app.get("/api/v1/tv/validation/export", async (_request, reply) => {
  const dataset = tvValidation.exportDataset(0, 10000);
  reply.header("Content-Disposition", 'attachment; filename="autodisc-tv-validation.json"');
  return dataset;
});

function validAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && !value.includes("\0");
}

async function validateDirectory(path: string): Promise<void> {
  const info = await stat(path);
  if (!info.isDirectory()) throw new Error(`${path} is not a directory`);
  await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
}

async function validateReadableDirectory(path: string): Promise<void> {
  const info = await stat(path);
  if (!info.isDirectory()) throw new Error(`${path} is not a directory`);
  await access(path, constants.R_OK | constants.X_OK);
}

interface PathCheck {
  name: string;
  path: string;
  ok: boolean;
  message: string;
  availableBytes?: number;
  spaceError?: string;
}

async function checkDirectoryPermissions(name: string, path: string, writable: boolean): Promise<PathCheck> {
  let space: Pick<PathCheck, "availableBytes" | "spaceError"> = {};
  try {
    if (!validAbsolutePath(path)) throw new Error("Path must be an absolute Linux path");
    const info = await stat(path);
    if (!info.isDirectory()) throw new Error("Path is not a directory");
    try {
      const stats = await statfs(path);
      space = { availableBytes: Number(stats.bavail) * Number(stats.bsize) };
    } catch (error) {
      space = { spaceError: error instanceof Error ? error.message : "Free space could not be determined" };
    }
    await access(path, constants.R_OK | constants.X_OK | (writable ? constants.W_OK : 0));
    await readdir(path);
    if (!writable) return { name, path, ok: true, message: "Readable and searchable", ...space };

    const probePath = join(path, `.autodisc-permission-check-${randomUUID()}`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let probeCreated = false;
    try {
      handle = await open(probePath, "wx", 0o600);
      probeCreated = true;
      await handle.close();
      handle = undefined;
      await unlink(probePath);
      probeCreated = false;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const reason = `${error instanceof Error ? error.message : "unknown filesystem error"}${code ? ` (${code})` : ""}`;
      const cleanupErrors: string[] = [];
      if (handle) {
        try {
          await handle.close();
        } catch (cleanupError) {
          cleanupErrors.push(`closing the probe file failed: ${cleanupError instanceof Error ? cleanupError.message : "unknown error"}`);
        }
      }
      if (probeCreated) {
        try {
          await unlink(probePath);
        } catch (cleanupError) {
          cleanupErrors.push(`removing ${probePath} failed: ${cleanupError instanceof Error ? cleanupError.message : "unknown error"}`);
        }
      }
      throw new Error(`Could not create and remove a temporary test file: ${reason}${cleanupErrors.length ? `; ${cleanupErrors.join("; ")}` : ""}`);
    }
    return { name, path, ok: true, message: "Readable, searchable, and can create and remove files", ...space };
  } catch (error) {
    return {
      name,
      path,
      ok: false,
      message: error instanceof Error ? error.message : "Path check failed",
      ...space
    };
  }
}

async function checkTvRootDirectory(path: string): Promise<PathCheck> {
  try {
    if (!validAbsolutePath(path)) throw new Error("TV root must be an absolute Linux path");
    await mkdir(path, { recursive: true });
    return await checkDirectoryPermissions("TV root folder", path, true);
  } catch (error) {
    return {
      name: "TV root folder",
      path,
      ok: false,
      message: error instanceof Error ? error.message : "TV root folder could not be created"
    };
  }
}

type LibraryType = "movies" | "tv" | "music";

function libraryPaths(settings: AppSettings): Record<LibraryType, string> {
  return { movies: settings.moviesDir, tv: settings.tvRootDir, music: settings.musicDir };
}

async function libraryHealth(settings = getSettings()): Promise<Array<{
  type: LibraryType;
  path: string;
  exists: boolean;
  writable: boolean;
  freeBytes: number | null;
  error?: string;
}>> {
  return Promise.all((Object.entries(libraryPaths(settings)) as Array<[LibraryType, string]>).map(async ([type, path]) => {
    try {
      const info = await stat(path);
      if (!info.isDirectory()) throw new Error("Configured library path is not a directory");
      const writeCheck = await checkDirectoryPermissions(`${type} library`, path, true);
      return {
        type, path, exists: true, writable: writeCheck.ok,
        freeBytes: writeCheck.availableBytes ?? null,
        ...(writeCheck.ok ? {} : { error: writeCheck.message })
      };
    } catch (error) {
      return {
        type, path, exists: false, writable: false, freeBytes: null,
        error: error instanceof Error ? error.message : "Library health check failed"
      };
    }
  }));
}

async function ensureWritableDirectory(path: string): Promise<void> {
  if (!validAbsolutePath(path) || resolve(path) === sep) {
    throw new Error("Library path must be an absolute Linux path other than the filesystem root");
  }
  await mkdir(path, { recursive: true });
  const check = await checkDirectoryPermissions("Library folder", path, true);
  if (!check.ok) throw new Error(check.message);
}

async function checkTvStagingDirectory(path: string): Promise<{ ok: boolean; message: string }> {
  if (!validAbsolutePath(path) || posix.resolve(path) === posix.sep) {
    return { ok: false, message: "TV staging path must be an absolute Linux path other than the filesystem root" };
  }
  let candidate = posix.resolve(path);
  let missing = false;
  while (true) {
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) return { ok: false, message: `TV staging path resolves through a symbolic link: ${candidate}` };
      if (!info.isDirectory()) return { ok: false, message: `TV staging path is not a directory: ${candidate}` };
      const accessCheck = await checkDirectoryPermissions("TV staging directory", candidate, true);
      return accessCheck.ok
        ? {
          ok: true,
          message: missing
            ? `The folder does not exist yet; its nearest existing parent is writable: ${candidate}`
            : "The folder exists and is readable and writable"
        }
        : { ok: false, message: accessCheck.message };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return { ok: false, message: error instanceof Error ? error.message : "TV staging path could not be checked" };
      }
      missing = true;
      const parent = posix.dirname(candidate);
      if (parent === candidate) return { ok: false, message: "No existing parent directory was found for TV staging" };
      candidate = parent;
    }
  }
}

async function storagePathDiagnostics(settings = getSettings()) {
  const path = tvStagingDirectory(settings);
  const conflict = tvStagingConflicts(settings)[0];
  const accessCheck = conflict ? null : await checkTvStagingDirectory(path);
  const pendingTasks = repositories.tvMatchingTasks.list().filter((task) => task.status !== "completed");
  const pathInUse = Boolean(activeJob()) || pendingTasks.length > 0;
  const recommendedPath = recommendedTvStagingDirectory(settings);
  const valid = !conflict && Boolean(accessCheck?.ok);
  const message = conflict
    ? tvStagingConflictExplanation(path, conflict)
    : accessCheck?.message ?? "TV staging path validation could not be completed";
  return {
    resolvedPaths: resolvedStoragePaths(settings, dbPath),
    activePublishingDirectories: activePublishingDirectories(settings),
    tvStaging: {
      path,
      source: tvStagingPathSource(settings),
      valid,
      message,
      conflict: conflict ? { target: conflict.target, media: conflict.media, path: conflict.path } : null,
      recommendedPath,
      canAutoFix: Boolean(conflict && recommendedPath && !pathInUse),
      changeBlockedReason: pathInUse
        ? "Complete or remove active jobs and staged TV tasks before changing the TV staging location."
        : null
    }
  };
}

function createTvPathReview(path: string, failure: string): void {
  repositories.reviewItems.create({
    category: "configuration_issue",
    severity: "high",
    title: "TV output folder validation failed",
    description: `TV root folder validation failed for ${path || "(empty path)"}: ${failure}`,
    ...(path ? { requestedPath: path } : {}),
    errorDetails: {
      path,
      validationFailure: failure,
      suggestedResolution: "Choose a writable Linux directory for the TV library and verify its parent-folder permissions."
    },
    suggestedActions: [
      { type: "open-settings", label: "Open TV output folder settings" },
      { type: "resolve", label: "Mark resolved" },
      { type: "dismiss", label: "Dismiss" }
    ]
  });
  app.log.warn({ path, failure }, "TV root folder validation failed");
}

async function checkOpticalDevice(path: string): Promise<PathCheck> {
  try {
    if (process.platform === "win32") {
      const letter = path.trim().match(/^([a-z]):\\?$/i)?.[1]?.toUpperCase();
      if (!letter) throw new Error("Optical drive must be a Windows drive letter such as D:");
      const powershell = await executableAvailable("powershell.exe") ? "powershell.exe" :
        await executableAvailable("pwsh.exe") ? "pwsh.exe" : null;
      if (!powershell) throw new Error("PowerShell is required to verify Windows optical drives");
      const result = await runProcess(powershell, [
        "-NoProfile", "-NonInteractive", "-Command",
        `$ErrorActionPreference='Stop'; Get-CimInstance -ClassName Win32_CDROMDrive | Where-Object { $_.Drive -eq '${letter}:' } | ForEach-Object { $_.Drive }`
      ], { timeoutMs: 10_000 });
      if (!result.stdout.split(/\r?\n/).some((drive) => drive.trim().toUpperCase() === `${letter}:`)) {
        throw new Error(`Windows did not enumerate optical drive ${letter}:`);
      }
      return { name: "Optical drive", path, ok: true, message: "Windows enumerated the configured optical drive" };
    }
    if (typeof path !== "string" || !/^\/dev\/[a-zA-Z0-9._/-]+$/.test(path) ||
      path.split("/").some((segment) => segment === "." || segment === "..")) {
      throw new Error("Optical drive must be a valid /dev path");
    }
    const info = await stat(path);
    if (!info.isCharacterDevice() && !info.isBlockDevice()) {
      throw new Error("Path is not an optical device file");
    }
    await access(path, constants.R_OK | constants.W_OK);
    return { name: "Optical drive", path, ok: true, message: "Device exists and is readable and writable" };
  } catch (error) {
    return {
      name: "Optical drive",
      path,
      ok: false,
      message: error instanceof Error ? error.message : "Optical drive check failed"
    };
  }
}

app.get("/api/library/health", async () => ({ libraries: await libraryHealth() }));
app.get("/api/v1/library/health", async () => ({ libraries: await libraryHealth() }));

const createLibraryRoute = async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
  if (typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) {
    return reply.code(400).send({ ok: false, error: "Library creation request must be an object" });
  }
  const type = (request.body as Record<string, unknown>).type;
  if (type !== "movies" && type !== "tv" && type !== "music") {
    return reply.code(400).send({ ok: false, error: "Library type must be movies, tv, or music" });
  }
  const path = libraryPaths(getSettings())[type];
  try {
    await ensureWritableDirectory(path);
    const status = (await libraryHealth()).find((library) => library.type === type);
    if (!status?.exists || !status.writable) throw new Error(status?.error ?? "Created library is not writable");
    return { ok: true, type, path, status, message: "Library folder exists and is writable" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Library folder could not be created";
    app.log.warn({ type, path, err: error }, "Library folder creation failed");
    const status = (await libraryHealth()).find((library) => library.type === type);
    return reply.code(400).send({
      ok: false,
      type,
      path,
      exists: status?.exists ?? false,
      writable: status?.writable ?? false,
      freeBytes: status?.freeBytes ?? null,
      error: status?.error ?? message
    });
  }
};

app.post("/api/library/create", createLibraryRoute);
app.post("/api/v1/library/create", createLibraryRoute);

app.post<{ Body: unknown }>("/api/v1/paths/check", async (request, reply) => {
  if (typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) {
    return reply.code(400).send({ error: "Path check request must be a JSON object" });
  }
  const body = request.body as Record<string, unknown>;
  if (typeof body.workDir !== "string" || typeof body.opticalDevice !== "string") {
    return reply.code(400).send({ error: "Path check requires a work folder and optical drive" });
  }
  const checks: Array<Awaited<ReturnType<typeof checkDirectoryPermissions>>> = [];
  const settings = getSettings();
  const lidarrEnabled = typeof body.lidarrEnabled === "boolean" ? body.lidarrEnabled : settings.lidarrEnabled;
  const requestedDestinations = body.outputDestinations;
  if (outputDestinationsPayloadIsValid(requestedDestinations)) {
    const routedSettings = { ...settings, outputDestinations: requestedDestinations };
    const active = requestedDestinations.profiles.find(({ id }) => id === requestedDestinations.activeProfileId)!;
    for (const media of ["tv", "movies", "music"] as const) {
      const target = outputTarget(routedSettings, media);
      const path = target === "sonarr" ? active.sonarr.seriesRoot :
        target === "radarr" ? active.radarr.movieRoot :
          target === "lidarr" ? active.lidarr.artistRoot :
            target === "folder" ? active.folder[media] : outputPath(routedSettings, media);
      checks.push(media === "tv"
        ? await checkTvRootDirectory(path)
        : await checkDirectoryPermissions(`${media} output (${target})`, path, true));
    }
  } else if (typeof body.moviesDir === "string" && typeof body.musicDir === "string" &&
    typeof body.tvRootDir === "string") {
    checks.push(
      await checkDirectoryPermissions("Movies folder", body.moviesDir, true),
      await checkDirectoryPermissions("Music folder", body.musicDir, !lidarrEnabled),
      await checkTvRootDirectory(body.tvRootDir)
    );
  } else {
    return reply.code(400).send({ error: "Path check requires a valid output profile" });
  }
  checks.push(
    await checkDirectoryPermissions("Temporary work folder", body.workDir, true),
    await checkOpticalDevice(body.opticalDevice)
  );
  if (lidarrEnabled && typeof body.lidarrImportDir === "string") {
    checks.push(await checkDirectoryPermissions("Lidarr downloads/import folder", body.lidarrImportDir, true));
  }
  const tvCheck = checks.find((check) => check.name === "TV root folder");
  if (tvCheck && !tvCheck.ok) createTvPathReview(tvCheck.path, tvCheck.message);
  return { ok: checks.every((check) => check.ok), checks };
});

app.get("/api/v1/paths/diagnostics", async () => storagePathDiagnostics());

app.post("/api/v1/paths/tv-staging/auto-fix", async (_request, reply) => {
  const settings = getSettings();
  const conflict = tvStagingConflicts(settings)[0];
  if (!conflict) return reply.code(409).send({ error: "No TV staging overlap needs to be fixed" });
  const recommendedPath = recommendedTvStagingDirectory(settings);
  if (!recommendedPath) {
    return reply.code(409).send({ error: "No safe TV staging location could be found outside active publishing directories" });
  }
  const pendingTasks = repositories.tvMatchingTasks.list().filter((task) => task.status !== "completed");
  if (activeJob() || pendingTasks.length) {
    return reply.code(409).send({
      error: "Complete or remove active jobs and staged TV tasks before changing the TV staging location"
    });
  }
  try {
    await ensureWritableDirectory(recommendedPath);
  } catch (error) {
    return reply.code(400).send({
      error: `Recommended TV staging directory could not be prepared: ${error instanceof Error ? error.message : "path validation failed"}`
    });
  }
  const saved = saveSettings({ tvStagingDir: recommendedPath });
  app.log.info({ path: recommendedPath }, "TV staging directory moved to a recommended location");
  events.emit("settings", { opticalDevice: saved.opticalDevice });
  events.emit("status");
  return { ok: true, settings: publicSettings(saved), ...await storagePathDiagnostics(saved) };
});

app.get<{ Querystring: { path?: string } }>("/api/v1/directories", async (request, reply) => {
  const path = request.query.path ?? "/";
  if (!validAbsolutePath(path) || path.length > 4096) {
    return reply.code(400).send({ error: "Directory path must be an absolute path" });
  }
  try {
    const entries = await readdir(path, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => ({ name: entry.name, path: join(path, entry.name) }))
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, 300);
    return { path, parentPath: path === sep ? null : dirname(resolve(path)), directories };
  } catch (error) {
    return reply.code(400).send({ error: `Cannot browse ${path}: ${error instanceof Error ? error.message : "directory access failed"}` });
  }
});

app.get("/api/v1/settings", async () => ({ settings: publicSettings(getSettings()) }));

app.get("/api/v1/tv/metadata", async () => {
  const settings = getSettings();
  const providers = tvMetadataProviderRegistry.list(settings);
  return {
    providers,
    settings: {
      lookupEnabled: settings.tvMetadataLookupEnabled,
      preferredProviderId: settings.tvMetadataPreferredProviderId,
      fallbackProviderId: settings.tvMetadataFallbackProviderId,
      cacheEnabled: settings.tvMetadataCacheEnabled,
      cacheDurationHours: settings.tvMetadataCacheDurationHours
    },
    matchingPolicy: {
      confidenceThresholds: {
        high: tvWorkflowPolicy.highConfidence,
        medium: tvWorkflowPolicy.mediumConfidence
      },
      matchingThresholds: {
        minimumConfidence: tvEpisodeMatchingPolicy.minimumConfidence,
        minimumMargin: tvEpisodeMatchingPolicy.minimumMargin
      },
      reviewPolicy: "High confidence is at least 0.90; medium is at least 0.72; lower confidence requires review. Medium-confidence matches recommend review, and ambiguous or flagged matches require review at any confidence. Automatic TV execution is disabled; explicitly saved manual recovery mappings can be processed.",
      matchingPolicy: "Conservative evidence ranking; unsupported assignments remain Unknown."
    }
  };
});

app.get("/api/v1/tv/metadata/providers", async () => ({
  providers: tvMetadataProviderRegistry.list(getSettings())
}));

app.get("/api/v1/tv/metadata/metrics", async () => {
  return tvMetadataLookupService.metrics();
});

app.post<{ Params: { id: string } }>("/api/v1/tv/metadata/providers/:id/test", async (request, reply) => {
  const { id } = request.params;
  if (!tvMetadataProviderRegistry.isLookupImplemented(id)) {
    return reply.code(404).send({ error: "TV metadata provider lookup is not implemented" });
  }
  const current = getSettings();
  const apiKey = current.tvMetadataProviderApiKeys[id] ?? "";
  if (!apiKey) return reply.code(400).send({ error: "Save an API key before testing this provider" });

  try {
    await tvMetadataProviderRegistry.validateConnection(id, apiKey);
    const result = {
      status: "success" as const,
      message: "Provider credentials and connection validated.",
      validatedAt: new Date().toISOString()
    };
    saveSettings({
      tvMetadataProviderValidation: { ...current.tvMetadataProviderValidation, [id]: result }
    });
    return { ok: true, providerId: id, validation: result };
  } catch (error) {
    const providerMessage = error instanceof TypeError
      ? "Connection failed. Check network access and the saved API key."
      : error instanceof Error
        ? error.message
        : "Connection failed. Check network access and the saved API key.";
    const result = {
      status: "failure" as const,
      message: providerMessage,
      validatedAt: new Date().toISOString()
    };
    saveSettings({
      tvMetadataProviderValidation: { ...current.tvMetadataProviderValidation, [id]: result }
    });
    return reply.code(502).send({ ok: false, providerId: id, validation: result, error: providerMessage });
  }
});

app.post("/api/v1/tv/metadata/cache/refresh", async () => {
  const result = await tvMetadataLookupService.refreshCache();
  return {
    ok: result.failed === 0,
    ...result,
    message: result.failed
      ? `Refreshed ${result.refreshed} cached metadata entries; ${result.failed} failed.`
      : `Refreshed ${result.refreshed} cached metadata entr${result.refreshed === 1 ? "y" : "ies"}.`
  };
});

app.delete("/api/v1/tv/metadata/cache", async () => ({
  ok: true,
  ...tvMetadataLookupService.clearCache(),
  message: "TV metadata cache cleared."
}));

app.post("/api/v1/tv/metadata/providers/refresh", async () => {
  const providers = await tvMetadataLookupService.refreshProviders();
  const metadata = await tvMetadataLookupService.refreshCache();
  return { ok: providers.every((provider) => provider.status === "healthy" || provider.status === "disabled") && metadata.failed === 0,
    refreshedAt: new Date().toISOString(), providers, metadata };
});

app.get("/api/v1/updates/status", async () => {
  const currentVersion = await getInstalledVersion();
  let state = await getUpdateStatus();
  let diagnostics = await getUpdateDiagnostics();
  if (state === "success" && diagnostics.verificationState === "pending") {
    diagnostics = await verifyRunningVersion(currentVersion);
    const fields = {
      event: diagnostics.verificationState === "succeeded" ? "verificationSucceeded" : "verificationFailed",
      currentVersion,
      targetVersion: diagnostics.targetVersion,
      verificationSucceeded: diagnostics.verificationState === "succeeded"
    };
    if (diagnostics.verificationState === "succeeded") {
      app.log.info(fields, "AutoDisc update version verification succeeded");
    } else {
      app.log.error({ ...fields, error: diagnostics.lastError }, "AutoDisc update version verification failed");
    }
  }
  if (diagnostics.verificationState === "failed") state = "failed";
  return {
    currentVersion,
    state,
    ...diagnostics,
    verificationSucceeded: diagnostics.verificationState === "succeeded"
      ? true
      : diagnostics.verificationState === "failed"
        ? false
        : null
  };
});

app.get("/api/v1/updates/check", async (_request, reply) => {
  try {
    const check = await checkForUpdate();
    app.log.info({
      event: "releaseFound",
      currentVersion: check.currentVersion,
      targetVersion: check.latestVersion,
      releaseFound: true,
      assetSelected: check.assetSelected
    }, "AutoDisc update release discovered");
    return { ...check, ...await getReleaseNotes(check.latestVersion) };
  } catch (error) {
    app.log.error({ err: error }, "AutoDisc update check failed");
    return reply.code(502).send({ error: error instanceof Error ? error.message : "AutoDisc update check failed" });
  }
});

app.post("/api/v1/updates/apply", async (_request, reply) => {
  const updaterState = await getUpdateStatus();
  if (updaterState === "applying") return reply.code(409).send({ error: "An AutoDisc update is already running" });
  if (updaterState === "failed") clearUpdatePending();
  if (activeJob()) return reply.code(409).send({ error: "Wait for the current disc job to finish before updating AutoDisc" });
  if (isUpdatePending()) return reply.code(409).send({ error: "An AutoDisc update is already queued" });

  let update: UpdateCheck;
  try {
    update = await checkForUpdate();
  } catch (error) {
    app.log.error({ err: error }, "AutoDisc update check before apply failed");
    return reply.code(502).send({ error: error instanceof Error ? error.message : "AutoDisc update check failed" });
  }
  if (!update.updateAvailable) return reply.code(409).send({ error: "AutoDisc is already up to date" });
  if (activeJob()) return reply.code(409).send({ error: "A disc job started; wait for it to finish before updating AutoDisc" });

  try {
    await queueUpdate(`v${update.latestVersion.replace(/^v/, "")}`);
  } catch (error) {
    app.log.error({ err: error }, "Could not queue AutoDisc update");
    return reply.code(503).send({ error: error instanceof Error ? error.message : "Could not queue AutoDisc update" });
  }
  app.log.info({
    event: "updateQueued",
    currentVersion: update.currentVersion,
    targetVersion: update.latestVersion,
    releaseFound: true,
    assetSelected: update.assetSelected
  }, "AutoDisc update queued");
  return reply.code(202).send({ queued: true, version: update.latestVersion });
});

app.post<{ Body: { url?: unknown; apiKey?: unknown } }>("/api/v1/lidarr/test", async (request, reply) => {
  const settings = getSettings();
  try {
    const url = typeof request.body?.url === "string" ? validateLidarrUrl(request.body.url) : settings.lidarrUrl;
    const apiKey = typeof request.body?.apiKey === "string" && request.body.apiKey
      ? request.body.apiKey
      : settings.lidarrApiKey;
    const result = await testLidarrConnection({ url, apiKey });
    return { ok: true, ...result };
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "Lidarr connection failed" });
  }
});

app.put<{ Body: unknown }>("/api/v1/settings", async (request, reply) => {
  if (typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) {
    return reply.code(400).send({ error: "Settings request must be a JSON object" });
  }
  const body = request.body as Record<string, unknown>;
  const patch: Partial<AppSettings> = {};
  const currentSettings = getSettings();
  if ("moviesDir" in body) {
    if (!validAbsolutePath(body.moviesDir)) return reply.code(400).send({ error: "Movies path must be an absolute Linux path" });
    try {
      await ensureWritableDirectory(body.moviesDir);
    } catch (error) {
      return reply.code(400).send({ error: `Movies path must be creatable and writable by AutoDisc: ${error instanceof Error ? error.message : "validation failed"}` });
    }
    patch.moviesDir = body.moviesDir;
  }
  if ("musicDir" in body) {
    if (!validAbsolutePath(body.musicDir)) return reply.code(400).send({ error: "Music path must be an absolute Linux path" });
    try {
      await ensureWritableDirectory(body.musicDir);
    } catch (error) {
      return reply.code(400).send({ error: `Music path must be creatable and writable by AutoDisc: ${error instanceof Error ? error.message : "validation failed"}` });
    }
    patch.musicDir = body.musicDir;
  }
  if ("tvRootDir" in body) {
    const tvRootDir = typeof body.tvRootDir === "string" ? body.tvRootDir : "";
    if (!validAbsolutePath(tvRootDir)) {
      const failure = "TV root must be an absolute Linux path";
      createTvPathReview(tvRootDir, failure);
      return reply.code(400).send({ error: failure });
    }
    try {
      await mkdir(tvRootDir, { recursive: true });
      await validateDirectory(tvRootDir);
    } catch (error) {
      const failure = error instanceof Error
        ? error.message
        : "TV root path must exist and be readable and writable by AutoDisc";
      createTvPathReview(tvRootDir, failure);
      return reply.code(400).send({ error: `TV root path must be creatable and readable and writable by AutoDisc: ${failure}` });
    }
    patch.tvRootDir = tvRootDir;
  }
  if ("lidarrImportDir" in body) {
    if (!validAbsolutePath(body.lidarrImportDir)) return reply.code(400).send({ error: "Lidarr import path must be an absolute Linux path" });
    try {
      await validateDirectory(body.lidarrImportDir);
    } catch {
      return reply.code(400).send({ error: "Lidarr import path must exist and be readable and writable by AutoDisc" });
    }
    patch.lidarrImportDir = body.lidarrImportDir;
  }
  if ("workDir" in body) {
    if (!validAbsolutePath(body.workDir)) return reply.code(400).send({ error: "Work path must be an absolute Linux path" });
    try {
      await validateDirectory(body.workDir);
    } catch {
      return reply.code(400).send({ error: "Work path must exist and be readable and writable by AutoDisc" });
    }
    patch.workDir = body.workDir;
  }
  if ("tvStagingDir" in body) {
    if (typeof body.tvStagingDir !== "string") {
      return reply.code(400).send({ error: "TV staging path must be a string" });
    }
    const stagingPath = body.tvStagingDir.trim();
    if (stagingPath && (!validAbsolutePath(stagingPath) || stagingPath.length > 4096 || resolve(stagingPath) === sep)) {
      return reply.code(400).send({ error: "TV staging path must be an absolute Linux path other than the filesystem root" });
    }
    patch.tvStagingDir = stagingPath;
  }
  if ("opticalDevice" in body) {
    if (typeof body.opticalDevice !== "string") return reply.code(400).send({ error: "Invalid optical device path" });
    const validDevice = process.platform === "win32"
      ? /^[a-z]:\\?$/i.test(body.opticalDevice)
      : /^\/dev\/[a-zA-Z0-9._/-]+$/.test(body.opticalDevice) &&
        !body.opticalDevice.split("/").some((segment) => segment === "." || segment === "..");
    if (!validDevice) {
      return reply.code(400).send({ error: "Invalid optical device path" });
    }
    patch.opticalDevice = body.opticalDevice;
  }
  if ("format" in body) {
    if (body.format !== "mp4" && body.format !== "mkv") return reply.code(400).send({ error: "Format must be mp4 or mkv" });
    patch.format = body.format as OutputFormat;
  }
  if ("quality" in body) {
    if (!Number.isInteger(body.quality) || Number(body.quality) < 18 || Number(body.quality) > 30) {
      return reply.code(400).send({ error: "Quality must be an integer from 18 to 30" });
    }
    patch.quality = Number(body.quality);
  }
  if ("preset" in body) {
    if (body.preset !== "ultrafast" && body.preset !== "veryfast" && body.preset !== "medium") {
      return reply.code(400).send({ error: "Preset must be ultrafast, veryfast, or medium" });
    }
    patch.preset = body.preset;
  }
  if ("encoder" in body) {
    if (body.encoder !== "auto" && body.encoder !== "nvidia" && body.encoder !== "software") {
      return reply.code(400).send({ error: "Encoder must be auto, nvidia, or software" });
    }
    patch.encoder = body.encoder as EncoderChoice;
  }
  if ("autoEject" in body) {
    if (typeof body.autoEject !== "boolean") return reply.code(400).send({ error: "autoEject must be a boolean" });
    patch.autoEject = body.autoEject;
  }
  if ("automationMode" in body) {
    if (!["full_auto", "regular_auto", "review_based"].includes(String(body.automationMode))) {
      return reply.code(400).send({ error: "Invalid automation mode" });
    }
    patch.automationMode = body.automationMode as AppSettings["automationMode"];
  }
  if ("tvDetectionEnabled" in body) {
    if (typeof body.tvDetectionEnabled !== "boolean") return reply.code(400).send({ error: "tvDetectionEnabled must be a boolean" });
    patch.tvDetectionEnabled = body.tvDetectionEnabled;
  }
  if ("tvStagingRetentionDays" in body) {
    const value = body.tvStagingRetentionDays;
    if (value !== null && (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 3650)) {
      return reply.code(400).send({ error: "TV staging retention must be Never Delete or an integer from 1 to 3650 days" });
    }
    patch.tvStagingRetentionDays = value === null ? null : Number(value);
  }
  if ("storageWarningThresholdGb" in body) {
    const value = body.storageWarningThresholdGb;
    if (value !== null && value !== 50 && value !== 100 && value !== 250 && value !== 500) {
      return reply.code(400).send({ error: "Storage warning threshold must be disabled, 50, 100, 250, or 500 GB" });
    }
    patch.storageWarningThresholdGb = value;
  }
  if ("autoWarnLargeReviewQueues" in body) {
    if (typeof body.autoWarnLargeReviewQueues !== "boolean") {
      return reply.code(400).send({ error: "autoWarnLargeReviewQueues must be a boolean" });
    }
    patch.autoWarnLargeReviewQueues = body.autoWarnLargeReviewQueues;
  }
  if ("autoCleanTempLogsAfterDays" in body) {
    const value = body.autoCleanTempLogsAfterDays;
    if (value !== null && (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 3650)) {
      return reply.code(400).send({ error: "Temporary log retention must be disabled or between 1 and 3650 days" });
    }
    patch.autoCleanTempLogsAfterDays = value === null ? null : Number(value);
  }
  if ("autoCleanFailedConversionsAfterDays" in body) {
    const value = body.autoCleanFailedConversionsAfterDays;
    if (value !== null && (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 3650)) {
      return reply.code(400).send({ error: "Failed conversion retention must be disabled or between 1 and 3650 days" });
    }
    patch.autoCleanFailedConversionsAfterDays = value === null ? null : Number(value);
  }
  if ("tvValidationLoggingEnabled" in body) {
    if (typeof body.tvValidationLoggingEnabled !== "boolean") return reply.code(400).send({ error: "tvValidationLoggingEnabled must be a boolean" });
    patch.tvValidationLoggingEnabled = body.tvValidationLoggingEnabled;
  }
  if ("tvMetadataLookupEnabled" in body) {
    if (typeof body.tvMetadataLookupEnabled !== "boolean") return reply.code(400).send({ error: "tvMetadataLookupEnabled must be a boolean" });
    patch.tvMetadataLookupEnabled = body.tvMetadataLookupEnabled;
  }
  if ("tvMetadataCacheEnabled" in body) {
    if (typeof body.tvMetadataCacheEnabled !== "boolean") return reply.code(400).send({ error: "tvMetadataCacheEnabled must be a boolean" });
    patch.tvMetadataCacheEnabled = body.tvMetadataCacheEnabled;
  }
  if ("tvMetadataCacheDurationHours" in body) {
    if (!Number.isInteger(body.tvMetadataCacheDurationHours) ||
      Number(body.tvMetadataCacheDurationHours) < 1 || Number(body.tvMetadataCacheDurationHours) > 8760) {
      return reply.code(400).send({ error: "TV metadata cache duration must be an integer from 1 to 8760 hours" });
    }
    patch.tvMetadataCacheDurationHours = Number(body.tvMetadataCacheDurationHours);
  }
  const validateTvProviderId = (value: unknown, allowBlank = false): value is string =>
    typeof value === "string" && ((allowBlank && value === "") || tvMetadataProviderRegistry.isLookupImplemented(value));
  if ("tvMetadataPreferredProviderId" in body) {
    if (!validateTvProviderId(body.tvMetadataPreferredProviderId)) {
      return reply.code(400).send({ error: "Preferred TV metadata provider must be registered" });
    }
    patch.tvMetadataPreferredProviderId = body.tvMetadataPreferredProviderId;
  }
  if ("tvMetadataFallbackProviderId" in body) {
    if (!validateTvProviderId(body.tvMetadataFallbackProviderId, true)) {
      return reply.code(400).send({ error: "Fallback TV metadata provider must be blank or registered" });
    }
    patch.tvMetadataFallbackProviderId = body.tvMetadataFallbackProviderId;
  }
  const effectivePreferredProvider = patch.tvMetadataPreferredProviderId ?? currentSettings.tvMetadataPreferredProviderId;
  const effectiveFallbackProvider = patch.tvMetadataFallbackProviderId ?? currentSettings.tvMetadataFallbackProviderId;
  if (effectiveFallbackProvider && effectiveFallbackProvider === effectivePreferredProvider) {
    return reply.code(400).send({ error: "Preferred and fallback TV metadata providers must be different" });
  }
  if ("tvMetadataProviderEnabled" in body) {
    const value = body.tvMetadataProviderEnabled;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return reply.code(400).send({ error: "TV metadata provider enablement must be an object" });
    }
    const enabled = { ...currentSettings.tvMetadataProviderEnabled };
    for (const [id, isEnabled] of Object.entries(value)) {
      if (!tvMetadataProviderRegistry.isLookupImplemented(id) || typeof isEnabled !== "boolean") {
        return reply.code(400).send({ error: "TV metadata provider enablement contains an invalid provider or value" });
      }
      enabled[id] = isEnabled;
    }
    patch.tvMetadataProviderEnabled = enabled;
  }
  if ("tvMetadataProviderApiKeys" in body) {
    const value = body.tvMetadataProviderApiKeys;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return reply.code(400).send({ error: "TV metadata provider API keys must be an object" });
    }
    const apiKeys = { ...currentSettings.tvMetadataProviderApiKeys };
    for (const [id, apiKey] of Object.entries(value)) {
      if (!tvMetadataProviderRegistry.isLookupImplemented(id) || typeof apiKey !== "string" || apiKey.length > 512) {
        return reply.code(400).send({ error: "TV metadata provider API key is invalid" });
      }
      apiKeys[id] = apiKey.trim();
    }
    patch.tvMetadataProviderApiKeys = apiKeys;
  }
  if ("metadataEnabled" in body) {
    if (typeof body.metadataEnabled !== "boolean") return reply.code(400).send({ error: "metadataEnabled must be a boolean" });
    patch.metadataEnabled = body.metadataEnabled;
  }
  if ("metadataProvider" in body) {
    if (body.metadataProvider !== "tmdb") return reply.code(400).send({ error: "Unsupported metadata provider" });
    patch.metadataProvider = "tmdb";
  }
  if ("metadataApiKey" in body) {
    if (typeof body.metadataApiKey !== "string" || body.metadataApiKey.length > 256) {
      return reply.code(400).send({ error: "Invalid metadata API key" });
    }
    patch.metadataApiKey = body.metadataApiKey;
  }
  if ("musicMetadataEnabled" in body) {
    if (typeof body.musicMetadataEnabled !== "boolean") return reply.code(400).send({ error: "musicMetadataEnabled must be a boolean" });
    patch.musicMetadataEnabled = body.musicMetadataEnabled;
  }
  if ("musicBrainzContactEmail" in body) {
    if (typeof body.musicBrainzContactEmail !== "string" || body.musicBrainzContactEmail.length > 254 ||
      (body.musicBrainzContactEmail !== "" &&
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.musicBrainzContactEmail))) {
      return reply.code(400).send({ error: "MusicBrainz contact email must be a valid email address or blank" });
    }
    patch.musicBrainzContactEmail = body.musicBrainzContactEmail.trim();
  }
  if ("lidarrEnabled" in body) {
    if (typeof body.lidarrEnabled !== "boolean") return reply.code(400).send({ error: "lidarrEnabled must be a boolean" });
    patch.lidarrEnabled = body.lidarrEnabled;
  }
  if ("lidarrUrl" in body) {
    if (typeof body.lidarrUrl !== "string" || body.lidarrUrl.length > 2048) {
      return reply.code(400).send({ error: "Invalid Lidarr URL" });
    }
    try {
      patch.lidarrUrl = validateLidarrUrl(body.lidarrUrl);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Invalid Lidarr URL" });
    }
  }
  if ("lidarrApiKey" in body) {
    if (typeof body.lidarrApiKey !== "string" || body.lidarrApiKey.length > 256) {
      return reply.code(400).send({ error: "Invalid Lidarr API key" });
    }
    patch.lidarrApiKey = body.lidarrApiKey;
  }
  if ("adminPassword" in body) {
    if (typeof body.adminPassword !== "string" || !validAdministratorPassword(body.adminPassword)) {
      return reply.code(400).send({ error: passwordRuleMessage });
    }
  }
  if ("logLevel" in body) {
    if (!["debug", "info", "warn", "error"].includes(String(body.logLevel))) {
      return reply.code(400).send({ error: "Invalid log level" });
    }
    patch.logLevel = body.logLevel as AppSettings["logLevel"];
  }
  if ("libraryMetadata" in body) {
    if (!isValidLibraryMetadata(body.libraryMetadata)) {
      return reply.code(400).send({ error: "Library metadata settings contain invalid options or naming templates" });
    }
    patch.libraryMetadata = body.libraryMetadata;
  }

  let effectiveSettings = { ...getSettings(), ...patch };
  if ("outputDestinations" in body) {
    const requestedDestinations = body.outputDestinations;
    if (!outputDestinationsPayloadIsValid(requestedDestinations)) {
      return reply.code(400).send({ error: "Output profiles contain invalid names, routes, or paths" });
    }
    const routedSettings = { ...effectiveSettings, outputDestinations: requestedDestinations };
    const profile = requestedDestinations.profiles.find(({ id }) => id === requestedDestinations.activeProfileId)!;
    if (outputTarget(routedSettings, "music") === "lidarr" && !effectiveSettings.lidarrEnabled) {
      return reply.code(400).send({ error: "Enable and configure the Lidarr integration before routing Music to Lidarr" });
    }
    for (const media of ["tv", "movies", "music"] as const satisfies readonly OutputMedia[]) {
      const target = outputTarget(routedSettings, media);
      let path: string;
      if (target === "sonarr") path = profile.sonarr.seriesRoot;
      else if (target === "radarr") path = profile.radarr.movieRoot;
      else if (target === "lidarr") path = profile.lidarr.artistRoot;
      else if (target === "folder") path = profile.folder[media];
      else path = outputPath(routedSettings, media);
      if (!validAbsolutePath(path)) {
        return reply.code(400).send({ error: `Configure an absolute output path for ${media} in the active profile` });
      }
      try {
        await ensureWritableDirectory(path);
      } catch (error) {
        return reply.code(400).send({
          error: `${media} output path must be creatable and writable by AutoDisc: ${error instanceof Error ? error.message : "validation failed"}`
        });
      }
    }
    patch.outputDestinations = requestedDestinations;
    patch.tvRootDir = outputPath(routedSettings, "tv");
    patch.moviesDir = outputPath(routedSettings, "movies");
    patch.musicDir = outputPath(routedSettings, "music");
  }
  if (!("outputDestinations" in body) &&
    (typeof body.moviesDir === "string" || typeof body.tvRootDir === "string" || typeof body.musicDir === "string")) {
    const destinations = structuredClone(effectiveSettings.outputDestinations);
    const profile = destinations.profiles.find(({ id }) => id === destinations.activeProfileId);
    if (profile) {
      if (profile.routes.movies === "jellyfin" && typeof body.moviesDir === "string") {
        profile.jellyfin.paths.movies = body.moviesDir;
      }
      if (profile.routes.tv === "jellyfin" && typeof body.tvRootDir === "string") {
        profile.jellyfin.paths.tv = body.tvRootDir;
      }
      if (profile.routes.music === "jellyfin" && typeof body.musicDir === "string") {
        profile.jellyfin.paths.music = body.musicDir;
      }
      patch.outputDestinations = destinations;
    }
  }
  effectiveSettings = { ...getSettings(), ...patch };
  if (tvStagingDirectory(effectiveSettings) !== tvStagingDirectory(currentSettings)) {
    const pendingTasks = repositories.tvMatchingTasks.list().filter((task) => task.status !== "completed");
    if (activeJob() || pendingTasks.length) {
      return reply.code(409).send({
        error: "Complete or remove active jobs and staged TV tasks before changing the TV staging location"
      });
    }
  }
  if (effectiveSettings.lidarrEnabled) {
    if (!effectiveSettings.lidarrApiKey) return reply.code(400).send({ error: "A Lidarr API key is required when Lidarr integration is enabled" });
    if (!effectiveSettings.musicMetadataEnabled) return reply.code(400).send({ error: "Enable MusicBrainz lookup so Lidarr can match the named album and tracks" });
    if (pathsOverlap(effectiveSettings.musicDir, effectiveSettings.lidarrImportDir)) {
      return reply.code(400).send({ error: "Lidarr incoming folder must be outside the configured Music library folder" });
    }
    try {
      await validateReadableDirectory(effectiveSettings.musicDir);
      await validateDirectory(effectiveSettings.lidarrImportDir);
    } catch {
      return reply.code(400).send({ error: "Lidarr Music library and import folders must exist; AutoDisc must read the library and write the import folder" });
    }
  }
  const saved = saveSettings(patch);
  if (typeof body.adminPassword === "string") {
    const salt = randomBytes(16);
    repositories.setup.updatePassword(salt.toString("hex"), scryptSync(body.adminPassword, salt, 64).toString("hex"));
    sessions.clear();
  }
  app.log.level = saved.logLevel;
  configureLogLevel(saved.logLevel);
  events.emit("settings", { opticalDevice: patch.opticalDevice });
  events.emit("status");
  app.log.info({ keys: Object.keys(patch) }, "settings updated");
  return { settings: publicSettings(saved), message: "Settings saved. Active jobs keep their existing settings." };
});

app.get("/api/v1/encoders", async () => ({ encoders: await availableEncoders(), selected: getSettings().encoder }));

app.get("/api/v1/events", async (request, reply) => {
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
  const write = (): void => {
    const active = activeJob();
    const state = active?.status ?? getRuntimeStatus();
    const manualMusicMetadata = active ? getManualMusicMetadataPrompt(active.id) : null;
    if (!reply.raw.destroyed && !reply.raw.write(`event: status\ndata: ${JSON.stringify({
      active, state, manualMusicMetadata, diagnostics: getLiveDiscDiagnostics()
    })}\n\n`)) {
      reply.raw.end();
    }
  };
  const onStatus = (): void => write();
  events.on("status", onStatus);
  write();
  const keepalive = setInterval(() => {
    if (!reply.raw.write(":keepalive\n\n")) reply.raw.end();
  }, 20_000);
  reply.raw.on("close", () => {
    clearInterval(keepalive);
    events.off("status", onStatus);
  });
});

let previousCpu: { idle: number; total: number } | undefined;

async function cpuUsage(): Promise<number | null> {
  let line: string | undefined;
  try {
    line = (await (await import("node:fs/promises")).readFile("/proc/stat", "utf8")).split("\n")[0];
  } catch {
    return null;
  }
  if (!line) return null;
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (values[3] ?? 0) + (values[4] ?? 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  const prior = previousCpu;
  previousCpu = { idle, total };
  if (!prior) return null;
  const elapsed = total - prior.total;
  return elapsed > 0 ? Math.round((1 - (idle - prior.idle) / elapsed) * 100) : null;
}

async function systemSnapshot(signal: AbortSignal): Promise<Record<string, unknown>> {
  const settings = getSettings();
  let memory: { total: number; used: number } | null = null;
  try {
    const meminfo = await (await import("node:fs/promises")).readFile("/proc/meminfo", "utf8");
    const total = Number(meminfo.match(/^MemTotal:\s+(\d+)/m)?.[1]);
    const available = Number(meminfo.match(/^MemAvailable:\s+(\d+)/m)?.[1]);
    if (Number.isFinite(total) && Number.isFinite(available)) memory = { total: total * 1024, used: (total - available) * 1024 };
  } catch {
    memory = null;
  }
  const disks: Record<string, number | null> = {};
  for (const [name, path] of [
    ["work", settings.workDir],
    ["movies", settings.moviesDir],
    ["music", settings.musicDir],
    ["tv", settings.tvRootDir]
  ] as const) {
    try {
      const space = await statfs(path);
      disks[name] = Number(space.bavail) * Number(space.bsize);
    } catch {
      disks[name] = null;
    }
  }
  let gpu: Record<string, number> | null = null;
  try {
    const result = await runProcess("nvidia-smi", [
      "--query-gpu=utilization.gpu,memory.used,memory.total",
      "--format=csv,noheader,nounits"
    ], { timeoutMs: 3000, signal });
    const values = result.stdout.split(",").map(Number);
    const utilization = values[0];
    const used = values[1];
    const total = values[2];
    if (utilization !== undefined && used !== undefined && total !== undefined &&
      [utilization, used, total].every(Number.isFinite)) {
      gpu = { utilization, memoryUsedMiB: used, memoryTotalMiB: total };
    }
  } catch {
    gpu = null;
  }
  return {
    at: new Date().toISOString(),
    cpuPercent: await cpuUsage(),
    memoryBytes: memory,
    freeDiskBytes: disks,
    gpu: gpu ?? { unavailable: true },
    job: activeJob()
  };
}

const metricSampler = new DashboardMetricSampler(systemSnapshot, 5000, (error) => {
  app.log.error({ err: error }, "dashboard resource sampling failed");
});

app.get("/api/v1/system/events", async (request, reply) => {
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
  const unsubscribe = metricSampler.subscribe((snapshot) => {
    if (reply.raw.destroyed) return false;
    if (!reply.raw.write(`event: metrics\ndata: ${JSON.stringify(snapshot)}\n\n`)) {
      reply.raw.end();
      return false;
    }
    return true;
  });
  reply.raw.on("close", unsubscribe);
});

export async function startServer(): Promise<void> {
  const host = process.env.HOST ?? "0.0.0.0";
  const port = Number(process.env.PORT ?? 8787);
  await app.listen({ host, port });
  if (!passwordConfigured()) {
    app.log.warn("Administrator password is not configured; the web interface is unauthenticated");
  }
}

export async function stopServer(): Promise<void> {
  metricSampler.stop();
  await app.close();
}
