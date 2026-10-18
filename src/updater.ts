import { open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = "nick709r/DVDTOJELLYFIN";
const updateDirectory = process.env.AUTODISC_UPDATE_DIRECTORY ?? "/var/lib/autodisc/updater";
const updateRequestPath = process.env.AUTODISC_UPDATE_REQUEST_PATH ?? join(updateDirectory, "request");
const updateStatusPath = process.env.AUTODISC_UPDATE_STATUS_PATH ?? join(updateDirectory, "status");
const helperUnitPath = process.env.AUTODISC_UPDATE_UNIT_PATH ?? "/etc/systemd/system/autodisc-update.path";

export type UpdateStatus = "idle" | "applying" | "success" | "failed";

export interface UpdateCheck {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
}

export interface ReleaseNotes {
  releaseNotes: string | null;
  releaseNotesUrl: string;
  releaseNotesSource: "release" | "readme" | "unavailable";
  releaseNotesMessage?: string;
}

let pending = false;

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

export async function getInstalledVersion(): Promise<string> {
  const packagePath = join(dirname(fileURLToPath(import.meta.url)), "../package.json");
  const manifest = JSON.parse(await readFile(packagePath, "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "string" || !versionParts(manifest.version)) {
    throw new Error("The installed AutoDisc version is invalid");
  }
  return manifest.version;
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
    updateAvailable: compareVersions(latestVersion, installedVersion) > 0
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
