export interface LidarrConfig {
  url: string;
  apiKey: string;
}

interface LidarrTrack {
  id?: number;
}

interface LidarrAlbum {
  id?: number;
  path?: string;
}

interface LidarrArtist {
  id?: number;
}

interface LidarrImportItem {
  id?: number;
  path?: string;
  name?: string;
  artist?: LidarrArtist;
  album?: LidarrAlbum;
  albumReleaseId?: number;
  tracks?: LidarrTrack[];
  trackIds?: number[];
  quality?: unknown;
  releaseGroup?: string;
  indexerFlags?: number;
  downloadId?: string;
  additionalFile?: boolean;
  replaceExistingFiles?: boolean;
  disableReleaseSwitching?: boolean;
  rejections?: unknown[];
}

interface LidarrCommand {
  id?: number;
  status?: string;
  errorMessage?: string;
  message?: string;
}

type Fetcher = typeof fetch;

function normalizedBaseUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Lidarr URL must be a valid HTTP or HTTPS URL");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Lidarr URL must use HTTP or HTTPS and must not contain credentials, a query, or a fragment");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed;
}

export function validateLidarrUrl(url: string): string {
  return normalizedBaseUrl(url).toString().replace(/\/+$/, "");
}

function endpoint(baseUrl: URL, path: string): URL {
  const result = new URL(baseUrl);
  const separator = path.indexOf("?");
  const apiPath = separator < 0 ? path : path.slice(0, separator);
  const query = separator < 0 ? "" : path.slice(separator + 1);
  const prefix = baseUrl.pathname.replace(/\/+$/, "");
  result.pathname = `${prefix}/api/v1/${apiPath.replace(/^\/+/, "")}`;
  if (query) result.search = query;
  return result;
}

async function requestJson<T>(
  baseUrl: URL,
  apiKey: string,
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal,
  fetcher: Fetcher = fetch
): Promise<T> {
  const timeout = AbortSignal.timeout(15_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    const headers = new Headers(init.headers);
    headers.set("X-Api-Key", apiKey);
    headers.set("Accept", "application/json");
    if (init.body) headers.set("Content-Type", "application/json");
    response = await fetcher(endpoint(baseUrl, path), {
      ...init,
      headers,
      signal: requestSignal
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Could not reach Lidarr: ${error instanceof Error ? error.message : "network request failed"}`);
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500).replace(/\s+/g, " ").trim();
    throw new Error(`Lidarr returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  try {
    return await response.json() as T;
  } catch {
    throw new Error("Lidarr returned an invalid JSON response");
  }
}

function validId(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function isUsableMatch(item: LidarrImportItem): boolean {
  return validId(item.id) &&
    typeof item.path === "string" &&
    typeof item.name === "string" &&
    validId(item.artist?.id) &&
    validId(item.album?.id) &&
    validId(item.albumReleaseId) &&
    Array.isArray(item.tracks) &&
    item.tracks.length === 1 &&
    item.tracks.every((track) => validId(track.id));
}

function itemForPath(items: LidarrImportItem[], path: string): LidarrImportItem | undefined {
  const target = path.replace(/\\/g, "/");
  return items.find((item) =>
    typeof item.path === "string" &&
    item.path.replace(/\\/g, "/") === target &&
    isUsableMatch(item)
  );
}

function commandId(command: LidarrCommand, response: Response): number {
  if (validId(command.id)) return command.id;
  const location = response.headers.get("location");
  const match = location?.match(/\/(\d+)\/?$/);
  if (match) {
    const id = Number(match[1]);
    if (validId(id)) return id;
  }
  throw new Error("Lidarr accepted the import but did not return a command ID");
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function testLidarrConnection(
  config: LidarrConfig,
  fetcher: Fetcher = fetch
): Promise<{ version: string | null }> {
  if (!config.apiKey.trim()) throw new Error("Lidarr API key is required");
  const baseUrl = normalizedBaseUrl(config.url);
  const status = await requestJson<{ version?: string }>(baseUrl, config.apiKey, "system/status", {}, undefined, fetcher);
  return { version: typeof status.version === "string" ? status.version : null };
}

export async function importAlbumToLidarr(
  config: LidarrConfig,
  folder: string,
  trackPaths: string[],
  signal?: AbortSignal,
  fetcher: Fetcher = fetch
): Promise<{ imported: number; albumPath: string | null }> {
  if (!config.apiKey.trim()) throw new Error("Lidarr API key is required");
  if (trackPaths.length === 0) throw new Error("There are no named audio tracks to import into Lidarr");

  const baseUrl = normalizedBaseUrl(config.url);
  const query = new URLSearchParams({
    folder,
    filterExistingFiles: "false",
    replaceExistingFiles: "false"
  });
  const candidates = await requestJson<LidarrImportItem[]>(
    baseUrl,
    config.apiKey,
    `manualimport?${query.toString()}`,
    {},
    signal,
    fetcher
  );
  if (!Array.isArray(candidates)) throw new Error("Lidarr returned an invalid manual-import list");

  const selected = trackPaths.map((path) => {
    const item = itemForPath(candidates, path);
    if (!item) {
      throw new Error(`Lidarr could not match ${path} to an artist, album, and track. Add the album to Lidarr and enable MusicBrainz lookup.`);
    }
    return item;
  });
  const firstMatch = selected[0];
  if (!firstMatch || selected.some((item) =>
    item.artist?.id !== firstMatch.artist?.id ||
    item.album?.id !== firstMatch.album?.id ||
    item.albumReleaseId !== firstMatch.albumReleaseId
  )) {
    throw new Error("Lidarr matched the named tracks to different albums or releases; check the MusicBrainz match and Lidarr album catalog");
  }
  if (new Set(selected.map((item) => item.tracks?.[0]?.id)).size !== selected.length) {
    throw new Error("Lidarr matched multiple named files to the same track; no files were submitted");
  }

  const updated = await requestJson<LidarrImportItem[]>(
    baseUrl,
    config.apiKey,
    "manualimport",
    {
      method: "POST",
      body: JSON.stringify(selected.map((item) => ({
        id: item.id,
        path: item.path,
        name: item.name,
        artistId: item.artist?.id,
        albumId: item.album?.id,
        albumReleaseId: item.albumReleaseId,
        trackIds: item.tracks?.map((track) => track.id),
        quality: item.quality,
        releaseGroup: item.releaseGroup,
        indexerFlags: item.indexerFlags,
        downloadId: item.downloadId,
        additionalFile: item.additionalFile ?? false,
        replaceExistingFiles: false,
        disableReleaseSwitching: false
      })))
    },
    signal,
    fetcher
  );
  if (!Array.isArray(updated) || updated.length !== trackPaths.length ||
      new Set(updated.map((item) => item.path?.replace(/\\/g, "/"))).size !== trackPaths.length ||
      trackPaths.some((path) => !updated.some((item) => item.path?.replace(/\\/g, "/") === path.replace(/\\/g, "/")))) {
    throw new Error("Lidarr did not confirm every track for import");
  }

  const importFiles = updated.map((item) => {
    if (!isUsableMatch(item)) {
      throw new Error(`Lidarr could not confirm the artist, album, and track match for ${item.path ?? "an audio track"}`);
    }
    return {
      path: item.path,
      artistId: item.artist?.id,
      albumId: item.album?.id,
      albumReleaseId: item.albumReleaseId,
      trackIds: item.tracks?.map((track) => track.id),
      quality: item.quality,
      releaseGroup: item.releaseGroup,
      indexerFlags: item.indexerFlags ?? 0,
      downloadId: item.downloadId,
      disableReleaseSwitching: false
    };
  });
  let commandResponse: Response;
  try {
    commandResponse = await fetcher(endpoint(baseUrl, "command"), {
      method: "POST",
      headers: {
        "X-Api-Key": config.apiKey,
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ name: "ManualImport", files: importFiles, importMode: "Move", replaceExistingFiles: false }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000)
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Could not submit the album to Lidarr: ${error instanceof Error ? error.message : "network request failed"}`);
  }
  if (!commandResponse.ok) {
    const detail = (await commandResponse.text()).slice(0, 500).replace(/\s+/g, " ").trim();
    throw new Error(`Lidarr returned HTTP ${commandResponse.status}${detail ? `: ${detail}` : ""}`);
  }
  let command: LidarrCommand = {};
  try {
    const payload: unknown = await commandResponse.json();
    if (validId(payload)) command.id = payload;
    else if (typeof payload === "object" && payload !== null) command = payload as LidarrCommand;
  } catch {
    command = {};
  }
  const id = commandId(command, commandResponse);

  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (signal?.aborted) throw new Error("Lidarr import was interrupted");
    const state = await requestJson<LidarrCommand>(baseUrl, config.apiKey, `command/${id}`, {}, signal, fetcher);
    const status = state.status?.toLowerCase();
    if (status === "completed") {
      const albums = updated.map((item) => item.album).filter((album): album is LidarrAlbum => Boolean(album));
      return {
        imported: updated.length,
        albumPath: albums.find((album) => typeof album.path === "string" && album.path.length > 0)?.path ?? null
      };
    }
    if (status === "failed" || status === "aborted" || status === "cancelled") {
      throw new Error(`Lidarr import ${status}${state.errorMessage || state.message ? `: ${state.errorMessage ?? state.message}` : ""}`);
    }
    await wait(1000);
  }
  throw new Error("Timed out waiting for Lidarr to finish importing the album");
}
