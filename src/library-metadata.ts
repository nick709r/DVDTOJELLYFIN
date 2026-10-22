import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { safeTitle } from "./media.js";
import type { LibraryMetadataSettings } from "./model.js";

export type MetadataEntity = "movie" | "series" | "season" | "episode" | "artist" | "album";
export type ArtworkKind = "poster" | "backdrop" | "fanart" | "logo" | "banner" | "season-poster" |
  "episode-image" | "disc" | "artist" | "album";

export interface ArtworkAsset {
  kind: ArtworkKind;
  url: string;
}

export interface LibraryMetadataDocument {
  title: string;
  seriesTitle?: string;
  year?: string | number | null;
  overview?: string | null;
  providerId?: string | null;
  provider?: string | null;
  rating?: string | number | null;
  genres?: readonly string[];
  cast?: readonly string[];
  season?: number;
  episode?: number;
  airDate?: string | null;
  runtimeMinutes?: number | null;
  artist?: string;
  album?: string;
  tracks?: readonly { title: string; number: number }[];
}

const presetTemplates: Pick<LibraryMetadataSettings,
  "seriesFolderTemplate" | "seasonFolderTemplate" | "episodeFileTemplate" | "movieFolderTemplate" |
  "movieFileTemplate" | "artistFolderTemplate" | "albumFolderTemplate"> = {
  seriesFolderTemplate: "{Series Name} ({Year})",
  seasonFolderTemplate: "Season {Season Number:00}",
  episodeFileTemplate: "{Series Name} - S{Season:00}E{Episode:00} - {Episode Title}",
  movieFolderTemplate: "{Movie Title} ({Year})",
  movieFileTemplate: "{Movie Title} ({Year})",
  artistFolderTemplate: "{Artist}",
  albumFolderTemplate: "{Album} ({Year})"
};

export function libraryTemplate(
  settings: LibraryMetadataSettings,
  key: keyof typeof presetTemplates
): string {
  return settings.libraryStructure === "custom" ? settings[key] : presetTemplates[key];
}

export function metadataDocument(
  title: string,
  provider: string | undefined,
  providerId: string | undefined,
  metadata: Readonly<Record<string, unknown>>
): LibraryMetadataDocument {
  const stringValue = (key: string): string | undefined => {
    const value = metadata[key];
    return typeof value === "string" ? value : undefined;
  };
  const numberValue = (key: string): number | undefined => {
    const value = metadata[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };
  const listValue = (key: string): string[] => {
    const value = metadata[key];
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  };
  const year = stringValue("year") ?? numberValue("year");
  const overview = stringValue("overview");
  const rating = stringValue("rating") ?? numberValue("rating");
  const seriesTitle = stringValue("title");
  const artist = stringValue("artist");
  const album = stringValue("album");
  return {
    title,
    ...(year === undefined ? {} : { year }),
    ...(overview === undefined ? {} : { overview }),
    ...(providerId === undefined ? {} : { providerId }),
    ...(provider === undefined ? {} : { provider }),
    ...(rating === undefined ? {} : { rating }),
    genres: listValue("genres"),
    cast: listValue("cast"),
    ...(artist === undefined ? {} : { artist }),
    ...(album === undefined ? {} : { album }),
    tracks: Array.isArray(metadata.tracks) ? metadata.tracks.flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const track = item as Record<string, unknown>;
      return typeof track.title === "string" && Number.isInteger(track.number)
        ? [{ title: track.title, number: Number(track.number) }] : [];
    }) : [],
    ...(seriesTitle === undefined ? {} : { seriesTitle })
  };
}

export function artworkAssets(value: unknown): ArtworkAsset[] {
  if (!Array.isArray(value)) return [];
  const kinds = new Set<ArtworkKind>([
    "poster", "backdrop", "fanart", "logo", "banner", "season-poster", "episode-image", "disc", "artist", "album"
  ]);
  return value.flatMap((item): ArtworkAsset[] => {
    if (typeof item !== "object" || item === null) return [];
    const asset = item as Record<string, unknown>;
    return typeof asset.kind === "string" && kinds.has(asset.kind as ArtworkKind) && typeof asset.url === "string"
      ? [{ kind: asset.kind as ArtworkKind, url: asset.url }] : [];
  });
}

export function artworkFromMetadata(metadata: Readonly<Record<string, unknown>>): ArtworkAsset[] {
  return artworkAssets(metadata.artwork);
}

const imageHosts = new Set(["image.tmdb.org", "artworks.thetvdb.com", "coverartarchive.org", "archive.org"]);
const permittedImageHost = (hostname: string): boolean =>
  imageHosts.has(hostname) || hostname.endsWith(".archive.org");

function xml(value: unknown): string {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&apos;");
}

function tag(name: string, value: unknown): string {
  return value === undefined || value === null || value === "" ? "" : `  <${name}>${xml(value)}</${name}>\n`;
}

export function renderLibraryTemplate(template: string, values: Readonly<Record<string, string | number | null | undefined>>): string {
  const allowedTokens = new Set([
    "Series Name", "Year", "Season Number", "Season", "Episode", "Episode Title",
    "Movie Title", "Artist", "Album"
  ]);
  const tokens = [...template.matchAll(/\{([^{}]+)\}/g)];
  if (/[{}]/.test(template.replace(/\{[^{}]+\}/g, "")) || tokens.some((token) => {
    const parts = token[1]?.split(":");
    return !parts || !allowedTokens.has(parts[0] ?? "") ||
      (parts.length !== 1 && !(parts.length === 2 && parts[1] === "00"));
  })) {
    throw new Error("Library naming template contains an unsupported token");
  }
  const rendered = template.replace(/\{([A-Za-z ]+)(?::(00))?\}/g, (_match, key: string, padded?: string) => {
    const value = values[key];
    if (value === undefined || value === null) return "";
    const text = String(value);
    return padded && /^\d+$/.test(text) ? text.padStart(2, "0") : text;
  });
  const normalized = rendered.replace(/\s+/g, " ").replace(/\(\s*\)/g, "").trim();
  if (!normalized) throw new Error("Library naming template produced an empty path component");
  const result = safeTitle(normalized);
  return result;
}

export function renderNfo(entity: MetadataEntity, document: LibraryMetadataDocument, settings: LibraryMetadataSettings): string {
  const tagName = entity === "series" ? "tvshow" : entity;
  const fields = [
    tag("title", document.title),
    tag("showtitle", entity === "episode" ? document.seriesTitle : undefined),
    tag("year", document.year),
    tag("plot", document.overview),
    tag("season", document.season),
    tag("episode", document.episode),
    tag("aired", document.airDate),
    tag("runtime", document.runtimeMinutes),
  ].filter(Boolean);
  if (document.providerId) {
    fields.push(`  <uniqueid type="${xml(document.provider ?? "unknown")}">${xml(document.providerId)}</uniqueid>\n`);
  }
  if (settings.downloadRatings && document.rating !== undefined && document.rating !== null) {
    fields.push(`  <ratings><rating name="default" max="10"><value>${xml(document.rating)}</value></rating></ratings>\n`);
  }
  if (document.genres?.length) fields.push(...document.genres.map((genre) => tag("genre", genre)));
  if (settings.downloadCastInformation && document.cast?.length) {
    fields.push(...document.cast.map((actor) => `  <actor><name>${xml(actor)}</name></actor>\n`));
  }
  if (entity === "album") {
    fields.push(tag("artist", document.artist));
    fields.push(...(document.tracks ?? []).map((track) =>
      `  <track><position>${track.number}</position><title>${xml(track.title)}</title></track>\n`));
  }
  void settings.nfoFormat;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<${tagName}>\n${fields.join("")}</${tagName}>\n`;
}

async function writeIfAbsent(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { flag: "wx", mode: 0o640 });
  try {
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function writeNfo(
  directory: string,
  fileName: string,
  entity: MetadataEntity,
  document: LibraryMetadataDocument,
  settings: LibraryMetadataSettings
): Promise<string | undefined> {
  if (!settings.generateNfo) return undefined;
  const safeName = basename(fileName);
  if (safeName !== fileName || !safeName.endsWith(".nfo")) throw new Error("Invalid NFO file name");
  await mkdir(directory, { recursive: true });
  const path = join(directory, safeName);
  await writeIfAbsent(path, renderNfo(entity, document, settings));
  return path;
}

const artworkFileNames: Record<ArtworkKind, string> = {
  poster: "poster.jpg",
  backdrop: "backdrop.jpg",
  fanart: "fanart.jpg",
  logo: "logo.png",
  banner: "banner.jpg",
  "season-poster": "season-poster.jpg",
  "episode-image": "thumb.jpg",
  disc: "discart.png",
  artist: "folder.jpg",
  album: "folder.jpg"
};

export async function downloadArtwork(
  directory: string,
  assets: readonly ArtworkAsset[],
  settings: LibraryMetadataSettings,
  fetcher: typeof fetch = fetch
): Promise<string[]> {
  if (!settings.downloadArtwork || !settings.automaticImport) return [];
  await mkdir(directory, { recursive: true });
  const saved: string[] = [];
  for (const asset of assets) {
    if ((asset.kind === "season-poster" && !settings.downloadSeasonArtwork) ||
      (asset.kind === "episode-image" && !settings.downloadEpisodeImages) ||
      (asset.kind === "fanart" && !settings.downloadFanart) ||
      (asset.kind === "logo" && !settings.downloadLogos) ||
      (asset.kind === "backdrop" && !settings.downloadBackdrops) ||
      (asset.kind === "banner" && !settings.downloadBanners)) continue;
    let target = join(directory, artworkFileNames[asset.kind]);
    try {
      await readFile(target);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let url = new URL(asset.url);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      if (url.protocol !== "https:" || !permittedImageHost(url.hostname)) {
        throw new Error(`Artwork source host is not permitted: ${url.hostname}`);
      }
      const response = await fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(12_000) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location || redirects === 3) throw new Error("Artwork download exceeded its redirect limit");
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) throw new Error(`Artwork download returned HTTP ${response.status}`);
      const contentType = response.headers.get("content-type")?.split(";")[0]?.trim();
      if (contentType !== "image/jpeg" && contentType !== "image/png" && contentType !== "image/webp") {
        throw new Error(`Artwork download returned an unsupported content type: ${contentType ?? "unknown"}`);
      }
      const maximumBytes = 15 * 1024 * 1024;
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
        throw new Error("Artwork download exceeds the 15 MB size limit");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Artwork download returned an empty response");
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          totalBytes += chunk.value.length;
          if (totalBytes > maximumBytes) {
            await reader.cancel();
            throw new Error("Artwork download exceeds the 15 MB size limit");
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      if (totalBytes === 0) throw new Error("Artwork download is empty");
      const extension = contentType === "image/png" ? ".png" : contentType === "image/webp" ? ".webp" : ".jpg";
      target = target.replace(/\.(?:jpg|png)$/, extension);
      try {
        await readFile(target);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), totalBytes);
      const temporary = `${target}.${randomUUID()}.download`;
      try {
        await writeFile(temporary, bytes, { flag: "wx", mode: 0o640 });
        await link(temporary, target);
        saved.push(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      } finally {
        await rm(temporary, { force: true });
      }
      break;
    }
  }
  return saved;
}

export async function writeMetadataBundle(
  directory: string,
  entity: MetadataEntity,
  document: LibraryMetadataDocument,
  assets: readonly ArtworkAsset[],
  settings: LibraryMetadataSettings,
  options: { nfoFileName: string; fetcher?: typeof fetch }
): Promise<{ nfoPath?: string; artworkPaths: string[] }> {
  const nfoPath = await writeNfo(directory, options.nfoFileName, entity, document, settings);
  const artworkPaths = await downloadArtwork(directory, assets, settings, options.fetcher);
  return { ...(nfoPath ? { nfoPath } : {}), artworkPaths };
}
