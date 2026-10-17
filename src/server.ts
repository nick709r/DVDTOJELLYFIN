import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { access, stat, statfs } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { db, activeJob, getSettings, jobStats, listJobs, saveSettings } from "./db.js";
import { events } from "./events.js";
import { availableEncoders } from "./encoding.js";
import { runProcess } from "./process.js";
import { DashboardMetricSampler } from "./metrics-sampler.js";
import { getRuntimeStatus } from "./runtime-status.js";
import { configureLogLevel } from "./logger.js";
import { testLidarrConnection, validateLidarrUrl } from "./lidarr.js";
import type { AppSettings, EncoderChoice, OutputFormat } from "./model.js";

export const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? getSettings().logLevel } });
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

function publicSettings(settings: AppSettings): Omit<AppSettings, "metadataApiKey" | "lidarrApiKey" | "adminPasswordSalt" | "adminPasswordHash"> & {
  metadataApiKeyConfigured: boolean;
  lidarrApiKeyConfigured: boolean;
  adminPasswordConfigured: boolean;
} {
  const { metadataApiKey, lidarrApiKey, adminPasswordSalt, adminPasswordHash, ...safe } = settings;
  return {
    ...safe,
    metadataApiKeyConfigured: Boolean(metadataApiKey),
    lidarrApiKeyConfigured: Boolean(lidarrApiKey),
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
    ["makemkv", process.env.MAKEMKV_COMMAND ?? "makemkvcon", "--version"],
    ["udevadm", "udevadm", "--version"],
    ["cdparanoia", process.env.CDPARANOIA_COMMAND ?? "cdparanoia", "-V"],
    ["cd-discid", process.env.CD_DISCID_COMMAND ?? "cd-discid", "-V"]
  ] as const) {
    try {
      await runProcess(command, [versionArg], { timeoutMs: 3000 });
      checks[name] = true;
    } catch {
      checks[name] = false;
    }
  }
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
    passwordConfigured: passwordConfigured(),
    encoderPreference: getSettings().encoder
  };
});

app.get("/api/v1/dashboard", async () => {
  const active = activeJob();
  return {
    stats: jobStats(),
    recent: listJobs(10),
    active,
    state: active?.status ?? getRuntimeStatus()
  };
});

app.get<{ Querystring: { limit?: string } }>("/api/v1/history", async (request) => {
  const limit = Math.max(1, Math.min(250, Number(request.query.limit ?? 100) || 100));
  return { jobs: listJobs(limit) };
});

app.get<{ Params: { id: string } }>("/api/v1/history/:id", async (request, reply) => {
  const job = db.prepare(`
    SELECT id, status, media_type AS mediaType, disc_label AS discLabel, title, output_path AS outputPath,
      encoder, output_bytes AS outputBytes, started_at AS startedAt,
      finished_at AS finishedAt, duration_seconds AS durationSeconds,
      conversion_seconds AS conversionSeconds,
      progress, error FROM jobs WHERE id = ?
  `).get(request.params.id);
  if (!job) return reply.code(404).send({ error: "Job not found" });
  const timeline = db.prepare("SELECT at, stage, level, message FROM job_events WHERE job_id = ? ORDER BY id")
    .all(request.params.id);
  return { job, timeline };
});

app.get<{ Querystring: { range?: string } }>("/api/v1/stats", async (request) => {
  const days = request.query.range === "30d" ? 30 : 7;
  const series = db.prepare(`
    SELECT date(started_at) AS day,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS successful,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures,
      AVG(CASE WHEN status = 'completed' THEN conversion_seconds END) AS averageSeconds
    FROM jobs
    WHERE started_at >= datetime('now', ?)
    GROUP BY date(started_at) ORDER BY day
  `).all(`-${days} days`);
  return { range: `${days}d`, series };
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

function pathsOverlap(first: string, second: string): boolean {
  const firstToSecond = relative(resolve(first), resolve(second));
  const secondToFirst = relative(resolve(second), resolve(first));
  const isWithin = (path: string): boolean =>
    path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
  return isWithin(firstToSecond) || isWithin(secondToFirst);
}

app.get("/api/v1/settings", async () => ({ settings: publicSettings(getSettings()) }));

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
    if (!reply.raw.destroyed && !reply.raw.write(`event: status\ndata: ${JSON.stringify({ active, state })}\n\n`)) {
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
  for (const [name, path] of [["work", settings.workDir], ["movies", settings.moviesDir], ["music", settings.musicDir]] as const) {
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
  const host = process.env.HOST ?? "127.0.0.1";
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
