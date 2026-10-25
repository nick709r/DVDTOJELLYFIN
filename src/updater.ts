import { open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = "nick709r/DVDTOJELLYFIN";
const updateDirectory = process.env.AUTODISC_UPDATE_DIRECTORY ?? "/var/lib/autodisc/updater";
const updateRequestPath = process.env.AUTODISC_UPDATE_REQUEST_PATH ?? join(updateDirectory, "request");
const updateStatusPath = process.env.AUTODISC_UPDATE_STATUS_PATH ?? join(updateDirectory, "status");
const updateDiagnosticsPath = process.env.AUTODISC_UPDATE_DIAGNOSTICS_PATH ?? join(updateDirectory, "diagnostics.json");
const helperUnitPath = process.env.AUTODISC_UPDATE_UNIT_PATH ?? "/etc/systemd/system/autodisc-update.path";

export type UpdateStatus = "idle" | "applying" | "success" | "failed";
export type UpdatePhaseState = "not_started" | "in_progress" | "completed" | "failed";
export type UpdateVerificationState = "not_started" | "pending" | "succeeded" | "failed";

export interface UpdateCheck {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  assetSelected: string;
}

export interface UpdateDiagnostics {
  targetVersion: string | null;
  releaseFound: boolean | null;
  assetSelected: string | null;
  downloadState: UpdatePhaseState;
  installState: UpdatePhaseState;
  verificationState: UpdateVerificationState;
  lastError: string | null;
}

export interface ReleaseNotes {
  releaseNotes: string | null;
  releaseNotesUrl: string;
  releaseNotesSource: "release" | "readme" | "unavailable";
  releaseNotesMessage?: string;
}

let pending = false;
let installedVersionPromise: Promise<string> | undefined;

const emptyDiagnostics: UpdateDiagnostics = {
  targetVersion: null,
  releaseFound: null,
  assetSelected: null,
  downloadState: "not_started",
  installState: "not_started",
  verificationState: "not_started",
  lastError: null
};

function versionParts(version: string): bigint[] | null {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) return null;
  return [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)];
}

export function compareVersions(left: string, right: string): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  if (!leftParts || !rightParts) throw new Error("Invalid AutoDisc version");
  for (let index = 0; index < leftParts.length; index += 1) {
    const first = leftParts[index]!;
    const second = rightParts[index]!;
    if (first !== second) return first > second ? 1 : -1;
  }
  return 0;
}

async function readInstalledVersion(): Promise<string> {
  const packagePath = join(dirname(fileURLToPath(import.meta.url)), "../package.json");
  const manifest = JSON.parse(await readFile(packagePath, "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "string" || !versionParts(manifest.version)) {
    throw new Error("The installed AutoDisc version is invalid");
  }
  return manifest.version;
}

export function getInstalledVersion(): Promise<string> {
  installedVersionPromise ??= readInstalledVersion();
  return installedVersionPromise;
}

export function getUpdateAssetUrl(version: string): string {
  const tag = version.startsWith("v") ? version : `v${version}`;
  if (!versionParts(tag)) throw new Error("Invalid AutoDisc update version");
  return `https://github.com/${repository}/archive/refs/tags/${encodeURIComponent(tag)}.tar.gz`;
}

export async function checkForUpdate(fetcher: typeof fetch = fetch): Promise<UpdateCheck> {
  const response = await fetcher(`https://api.github.com/repos/${repository}/tags?per_page=100`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "AutoDisc"
    },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`GitHub update check failed (HTTP ${response.status})`);
  const tags: unknown = await response.json();
  if (!Array.isArray(tags)) throw new Error("GitHub returned an invalid tag list");

  const versions = tags.flatMap((tag: unknown) => {
    if (typeof tag !== "object" || tag === null || !("name" in tag) || typeof tag.name !== "string") return [];
    return versionParts(tag.name) ? [tag.name] : [];
  });
  if (versions.length === 0) throw new Error("No versioned AutoDisc tags were found on GitHub");

  const latestVersion = versions.reduce((latest, version) =>
    compareVersions(version, latest) > 0 ? version : latest
  );
  const installedVersion = await getInstalledVersion();
  return {
    currentVersion: installedVersion,
    latestVersion,
    updateAvailable: compareVersions(latestVersion, installedVersion) > 0,
    assetSelected: getUpdateAssetUrl(latestVersion)
  };
}

function releaseNotesFromReadme(readme: string, version: string): string | null {
  const lines = readme.split(/\r?\n/);
  const targetHeading = new RegExp(`^###\\s+Version\\s+v?${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
  const headingIndex = lines.findIndex((line) => targetHeading.test(line));
  if (headingIndex < 0) return null;
  const nextHeading = lines.findIndex((line, index) => index > headingIndex && /^#{1,3}\s/.test(line));
  const notes = lines.slice(headingIndex + 1, nextHeading < 0 ? undefined : nextHeading).join("\n").trim();
  return notes || null;
}

export async function getReleaseNotes(
  version: string,
  fetcher: typeof fetch = fetch
): Promise<ReleaseNotes> {
  if (!versionParts(version)) throw new Error("Invalid AutoDisc release-notes version");
  const tag = version.startsWith("v") ? version : `v${version}`;
  const readmeUrl = `https://github.com/${repository}/blob/${encodeURIComponent(tag)}/README.md`;
  let releaseError: string | null = null;
  try {
    const response = await fetcher(`https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "AutoDisc"
      },
      signal: AbortSignal.timeout(10_000)
    });
    if (response.ok) {
      const release: unknown = await response.json();
      if (typeof release === "object" && release !== null) {
        const body = "body" in release && typeof release.body === "string" ? release.body.trim() : "";
        const url = "html_url" in release && typeof release.html_url === "string" ? release.html_url : readmeUrl;
        if (body) return { releaseNotes: body, releaseNotesUrl: url, releaseNotesSource: "release" };
      }
    } else if (response.status !== 404) {
      releaseError = `GitHub release notes request failed (HTTP ${response.status})`;
    }
  } catch (error) {
    releaseError = error instanceof Error ? error.message : "GitHub release notes request failed";
  }

  const rawReadmeUrl = `https://raw.githubusercontent.com/${repository}/${encodeURIComponent(tag)}/README.md`;
  try {
    const response = await fetcher(rawReadmeUrl, {
      headers: { "User-Agent": "AutoDisc" },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) {
      return {
        releaseNotes: null,
        releaseNotesUrl: readmeUrl,
        releaseNotesSource: "unavailable",
        releaseNotesMessage: `Could not load release notes from GitHub (HTTP ${response.status})`
      };
    }
    const notes = releaseNotesFromReadme(await response.text(), version.replace(/^v/, ""));
    if (notes) return { releaseNotes: notes, releaseNotesUrl: readmeUrl, releaseNotesSource: "readme" };
    return {
      releaseNotes: null,
      releaseNotesUrl: readmeUrl,
      releaseNotesSource: "unavailable",
      releaseNotesMessage: `No release notes were published for AutoDisc ${tag}${releaseError ? `; ${releaseError}` : ""}`
    };
  } catch (error) {
    return {
      releaseNotes: null,
      releaseNotesUrl: readmeUrl,
      releaseNotesSource: "unavailable",
      releaseNotesMessage: `Could not load release notes from GitHub: ${error instanceof Error ? error.message : "network request failed"}`
    };
  }
}

function isUpdateDiagnostics(value: unknown): value is UpdateDiagnostics {
  if (typeof value !== "object" || value === null) return false;
  const diagnostics = value as Record<string, unknown>;
  return (typeof diagnostics.targetVersion === "string" || diagnostics.targetVersion === null) &&
    (typeof diagnostics.releaseFound === "boolean" || diagnostics.releaseFound === null) &&
    (typeof diagnostics.assetSelected === "string" || diagnostics.assetSelected === null) &&
    ["not_started", "in_progress", "completed", "failed"].includes(String(diagnostics.downloadState)) &&
    ["not_started", "in_progress", "completed", "failed"].includes(String(diagnostics.installState)) &&
    ["not_started", "pending", "succeeded", "failed"].includes(String(diagnostics.verificationState)) &&
    (typeof diagnostics.lastError === "string" || diagnostics.lastError === null);
}

export async function getUpdateDiagnostics(): Promise<UpdateDiagnostics> {
  try {
    const diagnostics: unknown = JSON.parse(await readFile(updateDiagnosticsPath, "utf8"));
    if (!isUpdateDiagnostics(diagnostics)) throw new Error("The system updater returned invalid diagnostics");
    return diagnostics;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...emptyDiagnostics };
    throw error;
  }
}

async function writeUpdateDiagnostics(diagnostics: UpdateDiagnostics): Promise<void> {
  const temporaryPath = `${updateDiagnosticsPath}.${randomUUID()}.tmp`;
  const file = await open(temporaryPath, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(diagnostics)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporaryPath, updateDiagnosticsPath);
  } catch (error) {
    await unlink(temporaryPath).catch((cleanupError: NodeJS.ErrnoException) => {
      if (cleanupError.code !== "ENOENT") throw new AggregateError([error, cleanupError], "Could not clean up update diagnostics");
    });
    throw error;
  }
}

export async function verifyRunningVersion(currentVersion: string): Promise<UpdateDiagnostics> {
  const diagnostics = await getUpdateDiagnostics();
  if (!diagnostics.targetVersion || diagnostics.verificationState !== "pending") return diagnostics;

  const targetVersion = diagnostics.targetVersion.replace(/^v/, "");
  const verified = currentVersion === targetVersion;
  const result: UpdateDiagnostics = {
    ...diagnostics,
    verificationState: verified ? "succeeded" : "failed",
    lastError: verified ? null : `Running version ${currentVersion} does not match requested version ${diagnostics.targetVersion}`
  };
  await writeUpdateDiagnostics(result);
  return result;
}

export async function queueUpdate(version: string): Promise<void> {
  if (pending) throw new Error("An AutoDisc update is already queued");
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) {
    throw new Error("Invalid AutoDisc update version");
  }

  pending = true;
  try {
    await readFile(helperUnitPath);
  } catch (error) {
    pending = false;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("The system updater is not installed; rerun the AutoDisc installer before using in-app updates");
    }
    throw error;
  }

  let temporaryPath: string | undefined;
  let temporaryCreated = false;
  try {
    temporaryPath = `${updateRequestPath}.${randomUUID()}.tmp`;
    const request = await open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    try {
      await request.writeFile(`${version}\n`, "utf8");
      await request.sync();
    } finally {
      await request.close();
    }
    try {
      await rename(temporaryPath, updateRequestPath);
      temporaryCreated = false;
    } catch (error) {
      await unlink(temporaryPath).catch((cleanupError: NodeJS.ErrnoException) => {
        if (cleanupError.code !== "ENOENT") throw cleanupError;
      });
      temporaryCreated = false;
      throw error;
    }
  } catch (error) {
    pending = false;
    if (temporaryCreated && temporaryPath) {
      await unlink(temporaryPath).catch((cleanupError: NodeJS.ErrnoException) => {
        if (cleanupError.code !== "ENOENT") throw new AggregateError([error, cleanupError], "Could not clean up a failed update request");
      });
    }
    throw error;
  }
}

export function isUpdatePending(): boolean {
  return pending;
}

export function clearUpdatePending(): void {
  pending = false;
}

export async function getUpdateStatus(): Promise<UpdateStatus> {
  try {
    const status = (await readFile(updateStatusPath, "utf8")).trim();
    if (status === "idle" || status === "applying" || status === "success" || status === "failed") return status;
    throw new Error("The system updater returned an invalid status");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "idle";
    throw error;
  }
}
