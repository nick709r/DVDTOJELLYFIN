import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyRateLimit from "@fastify/rate-limit";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { access, mkdir, open, readdir, stat, statfs, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { activeJob, dailyJobStats, deleteJob, getSettings, jobDetails, jobStats, listJobs, saveSettings } from "./db.js";
import { events } from "./events.js";
import { getLiveDiscDiagnostics } from "./diagnostics.js";
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
import { checkForUpdate, clearUpdatePending, getInstalledVersion, getReleaseNotes, getUpdateStatus, isUpdatePending, queueUpdate, type UpdateCheck } from "./updater.js";
import type { AppSettings, EncoderChoice, OutputFormat } from "./model.js";
import { tvMetadataProviderRegistry } from "./bootstrap/tv-metadata-providers.js";
import { tvMetadataLookupService } from "./bootstrap/tv-metadata-runtime.js";
import { tvEpisodeMatchingPolicy } from "./application/tv-episode-matching-engine.js";
import { tvWorkflowPolicy } from "./application/tv-workflow-service.js";
import { repositories } from "./db.js";
import { TvReviewService } from "./application/tv-review-service.js";
import { TvValidationService } from "./application/tv-validation-service.js";
import type { Episode, TvProcessingPlan } from "./domain/television.js";
import type { ReviewCategory, ReviewSeverity, ReviewStatus } from "./domain/reviews.js";
import type { ReviewJob } from "./domain/review-jobs.js";

export const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? getSettings().logLevel } });
interface ReviewJobActions {
  continue(id: string): Promise<void>;
  updateMetadata(id: string, patch: Readonly<Record<string, unknown>>): Promise<ReviewJob>;
  remove(id: string): Promise<void>;
}
let reviewJobActions: ReviewJobActions | undefined;

export function setReviewJobActions(actions: ReviewJobActions): void {
  reviewJobActions = actions;
}
const tvValidation = new TvValidationService(
  repositories.tvValidationEvidence,
  repositories.tvEpisodeFeedback,
  repositories.tvProcessingPlans,
  () => getSettings().tvValidationLoggingEnabled
);
const tvReview = new TvReviewService(repositories.tvEpisodeFeedback, repositories.tvProcessingPlans);
const sessions = new Map<string, number>();
const staticRoot = join(dirname(fileURLToPath(import.meta.url)), "../web");

function passwordConfigured(): boolean {
  return Boolean(getSettings().adminPasswordHash);
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

app.addHook("preHandler", async (request, reply) => {
  if (!request.url.startsWith("/api/") || request.url === "/api/health" || request.url === "/api/v1/login") return;
  if (passwordConfigured() && !isAuthenticated(request)) {
    return reply.code(401).send({ error: "Authentication required" });
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

app.register(fastifyStatic, { root: staticRoot, prefix: "/" });
app.register(fastifyRateLimit, { global: false });

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
    adminPasswordConfigured: Boolean(adminPasswordHash)
  };
}

function setSessionCookie(reply: FastifyReply, token: string, maxAge: number): void {
  reply.header(
    "Set-Cookie",
    `autodisc_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`
  );
}

app.post<{ Body: { username?: string; password?: string } }>("/api/v1/login", async (request, reply) => {
  const settings = getSettings();
  if (!settings.adminPasswordHash) return reply.send({ ok: true, passwordRequired: false });
  const password = request.body?.password;
  if (request.body?.username !== "admin" || typeof password !== "string") {
    return reply.code(401).send({ error: "Invalid username or password" });
  }
  const candidate = scryptSync(password, Buffer.from(settings.adminPasswordSalt, "hex"), 64);
  const expected = Buffer.from(settings.adminPasswordHash, "hex");
  if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
    return reply.code(401).send({ error: "Invalid username or password" });
  }
  const token = randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + 12 * 60 * 60 * 1000);
  setSessionCookie(reply, token, 12 * 60 * 60);
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

app.get("/api/v1/status", async () => {
  const active = activeJob();
  return {
    state: active?.status ?? getRuntimeStatus(),
    job: active,
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
    recent: listJobs(10),
    active,
    manualMusicMetadata: active ? getManualMusicMetadataPrompt(active.id) : null,
    state: active?.status ?? getRuntimeStatus()
  };
});

app.get<{ Querystring: { limit?: string } }>("/api/v1/history", async (request) => {
  const limit = Math.max(1, Math.min(250, Number(request.query.limit ?? 100) || 100));
  return { jobs: listJobs(limit) };
});

app.delete<{ Params: { id: string } }>("/api/v1/history/:id", async (request, reply) => {
  if (activeJob()?.id === request.params.id) {
    return reply.code(409).send({ error: "An active job cannot be removed from history" });
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
  return details;
});

app.get<{ Querystring: { jobId?: string; live?: string } }>("/api/v1/diagnostics", async (request, reply) => {
  const active = activeJob();
  const liveOnly = request.query.live === "1";
  const jobId = liveOnly ? undefined : request.query.jobId || active?.id || listJobs(1)[0]?.id;
  if (!jobId) {
    return {
      live: getLiveDiscDiagnostics(),
      job: null,
      timeline: [],
      jobs: listJobs(50),
      liveOnly,
      configuredDevice: getSettings().opticalDevice
    };
  }
  const details = jobDetails(jobId);
  if (!details) return reply.code(404).send({ error: "Diagnostic job not found" });
  return {
    live: getLiveDiscDiagnostics(),
    job: details.job,
    timeline: details.timeline,
    jobs: listJobs(50),
    liveOnly: false,
    configuredDevice: getSettings().opticalDevice,
    active: active?.id === jobId
  };
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

app.post<{ Params: { id: string } }>("/api/v1/reviews/:id/resolve", async (request, reply) => {
  const item = repositories.reviewItems.get(request.params.id);
  if (!item) return reply.code(404).send({ error: "Review item not found" });
  if (item.status === "resolved" || item.status === "dismissed") {
    return reply.code(409).send({ error: `Review item is already ${item.status}` });
  }
  const resolved = repositories.reviewItems.updateStatus(item.id, "resolved", "Marked resolved by administrator");
  return { item: resolved };
});

app.post<{ Params: { id: string } }>("/api/v1/reviews/:id/dismiss", async (request, reply) => {
  const item = repositories.reviewItems.get(request.params.id);
  if (!item) return reply.code(404).send({ error: "Review item not found" });
  if (item.status === "resolved" || item.status === "dismissed") {
    return reply.code(409).send({ error: `Review item is already ${item.status}` });
  }
  return { item: repositories.reviewItems.updateStatus(item.id, "dismissed", "Dismissed by administrator") };
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
  return { item: retrying, message: "Retry requested. Keep the related disc in the configured drive." };
});

app.get("/api/v1/review-jobs", {
  config: { rateLimit: { max: 120, timeWindow: "1 minute" } }
}, async () => ({ reviewJobs: repositories.reviewJobs.list() }));

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
  void reviewJobActions.continue(reviewJob.id).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Review processing failed";
    repositories.reviewJobs.update(reviewJob.id, { status: "pending", failureReason: message });
    app.log.error({ err: error, reviewJobId: reviewJob.id }, "Review processing could not be continued");
    events.emit("status");
  });
  return reply.code(202).send({ reviewJob: repositories.reviewJobs.get(reviewJob.id), message: "Processing resumed from preserved media; no disc is required." });
});

async function discardReviewJob(id: string, reply: FastifyReply) {
  const reviewJob = repositories.reviewJobs.get(id);
  if (!reviewJob) return reply.code(404).send({ error: "Review job not found" });
  if (reviewJob.status === "retrying" || reviewJob.status === "processing") {
    return reply.code(409).send({ error: "A review job cannot be cleared while processing" });
  }
  if (!reviewJobActions) return reply.code(503).send({ error: "Review workspace service is unavailable" });
  await reviewJobActions.remove(reviewJob.id);
  for (const status of ["active", "retrying"] as const) {
    for (const item of repositories.reviewItems.list({ status, limit: 1000 })) {
      if (item.relatedJobId === reviewJob.originalJobId) {
        repositories.reviewItems.updateStatus(item.id, "dismissed", "Review notification cleared by administrator");
      }
    }
  }
  events.emit("status");
  return { ok: true };
}

app.post<{ Params: { id: string } }>("/api/v1/review-jobs/:id/clear-notification", {
  config: { rateLimit: { max: 120, timeWindow: "1 minute" } }
}, async (request, reply) =>
  discardReviewJob(request.params.id, reply));
app.delete<{ Params: { id: string } }>("/api/v1/review-jobs/:id", {
  config: { rateLimit: { max: 120, timeWindow: "1 minute" } }
}, async (request, reply) =>
  discardReviewJob(request.params.id, reply));

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
    return { plan: tvReview.applyApproval(action) };
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

app.post<{ Body: unknown }>("/api/v1/paths/check", async (request, reply) => {
  if (typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) {
    return reply.code(400).send({ error: "Path check request must be a JSON object" });
  }
  const body = request.body as Record<string, unknown>;
  if (typeof body.moviesDir !== "string" || typeof body.musicDir !== "string" ||
    typeof body.tvRootDir !== "string" ||
    typeof body.workDir !== "string" || typeof body.opticalDevice !== "string" ||
    typeof body.lidarrImportDir !== "string" || typeof body.lidarrEnabled !== "boolean") {
    return reply.code(400).send({ error: "Path check requires Movies, Music, TV root, work, optical drive, and Lidarr settings" });
  }

  const checks = await Promise.all([
    checkDirectoryPermissions("Movies folder", body.moviesDir, true),
    checkDirectoryPermissions("Music folder", body.musicDir, !body.lidarrEnabled),
    checkTvRootDirectory(body.tvRootDir),
    checkDirectoryPermissions("Temporary work folder", body.workDir, true),
    ...(body.lidarrEnabled ? [checkDirectoryPermissions("Lidarr downloads/import folder", body.lidarrImportDir, true)] : []),
    checkOpticalDevice(body.opticalDevice)
  ]);
  const tvCheck = checks.find((check) => check.name === "TV root folder");
  if (tvCheck && !tvCheck.ok) createTvPathReview(tvCheck.path, tvCheck.message);
  return { ok: checks.every((check) => check.ok), checks };
});

function pathsOverlap(first: string, second: string): boolean {
  const firstToSecond = relative(resolve(first), resolve(second));
  const secondToFirst = relative(resolve(second), resolve(first));
  const isWithin = (path: string): boolean =>
    path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
  return isWithin(firstToSecond) || isWithin(secondToFirst);
}

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
      reviewPolicy: "High confidence is at least 0.90; medium is at least 0.72; lower confidence requires review. Medium-confidence matches recommend review, and ambiguous or flagged matches require review at any confidence. TV media execution remains disabled.",
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

app.get("/api/v1/updates/status", async () => ({
  currentVersion: await getInstalledVersion(),
  state: await getUpdateStatus()
}));

app.get("/api/v1/updates/check", async (_request, reply) => {
  try {
    const check = await checkForUpdate();
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
  if ("moviesDir" in body) {
    if (!validAbsolutePath(body.moviesDir)) return reply.code(400).send({ error: "Movies path must be an absolute Linux path" });
    try {
      await validateDirectory(body.moviesDir);
    } catch {
      return reply.code(400).send({ error: "Movies path must exist and be readable and writable by AutoDisc" });
    }
    patch.moviesDir = body.moviesDir;
  }
  if ("musicDir" in body) {
    if (!validAbsolutePath(body.musicDir)) return reply.code(400).send({ error: "Music path must be an absolute Linux path" });
    try {
      const currentLidarrEnabled = getSettings().lidarrEnabled;
      const lidarrWillManageLibrary = typeof body.lidarrEnabled === "boolean" ? body.lidarrEnabled : currentLidarrEnabled;
      if (lidarrWillManageLibrary) await validateReadableDirectory(body.musicDir);
      else await validateDirectory(body.musicDir);
    } catch {
      return reply.code(400).send({ error: "Music path must exist and be readable by AutoDisc, and writable when Lidarr integration is disabled" });
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
  if ("opticalDevice" in body) {
    if (typeof body.opticalDevice !== "string" ||
      !/^\/dev\/[a-zA-Z0-9._/-]+$/.test(body.opticalDevice) ||
      body.opticalDevice.split("/").some((segment) => segment === "." || segment === "..")) {
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
  if ("tvDetectionEnabled" in body) {
    if (typeof body.tvDetectionEnabled !== "boolean") return reply.code(400).send({ error: "tvDetectionEnabled must be a boolean" });
    patch.tvDetectionEnabled = body.tvDetectionEnabled;
  }
  if ("tvValidationLoggingEnabled" in body) {
    if (typeof body.tvValidationLoggingEnabled !== "boolean") return reply.code(400).send({ error: "tvValidationLoggingEnabled must be a boolean" });
    patch.tvValidationLoggingEnabled = body.tvValidationLoggingEnabled;
  }
  const currentSettings = getSettings();
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
    if (typeof body.adminPassword !== "string" || body.adminPassword.length < 12 || body.adminPassword.length > 256) {
      return reply.code(400).send({ error: "Password must be 12 to 256 characters" });
    }
    const salt = randomBytes(16);
    patch.adminPasswordSalt = salt.toString("hex");
    patch.adminPasswordHash = scryptSync(body.adminPassword, salt, 64).toString("hex");
  }
  if ("logLevel" in body) {
    if (!["debug", "info", "warn", "error"].includes(String(body.logLevel))) {
      return reply.code(400).send({ error: "Invalid log level" });
    }
    patch.logLevel = body.logLevel as AppSettings["logLevel"];
  }

  const effectiveSettings = { ...getSettings(), ...patch };
  if (effectiveSettings.lidarrEnabled) {
    if (!effectiveSettings.lidarrApiKey) return reply.code(400).send({ error: "A Lidarr API key is required when Lidarr integration is enabled" });
    if (!effectiveSettings.musicMetadataEnabled) return reply.code(400).send({ error: "Enable MusicBrainz lookup so Lidarr can match the named album and tracks" });
    if (pathsOverlap(effectiveSettings.musicDir, effectiveSettings.lidarrImportDir)) {
      return reply.code(400).send({ error: "Lidarr incoming folder must be outside the Jellyfin Music library folder" });
    }
    try {
      await validateReadableDirectory(effectiveSettings.musicDir);
      await validateDirectory(effectiveSettings.lidarrImportDir);
    } catch {
      return reply.code(400).send({ error: "Lidarr Music library and import folders must exist; AutoDisc must read the library and write the import folder" });
    }
  }
  const saved = saveSettings(patch);
  if (patch.adminPasswordHash !== undefined) sessions.clear();
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
