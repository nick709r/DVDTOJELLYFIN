import type { AudioDisc } from "./audio-cd.js";
import { log } from "./logger.js";

export interface MusicTrackMetadata {
  number: number;
  title: string;
}

export interface MusicAlbumMetadata {
  artist: string;
  album: string;
  year: string | null;
  tracks: MusicTrackMetadata[];
  source: "musicbrainz" | "offline";
}

interface MusicBrainzTrack {
  title?: string;
  recording?: { title?: string };
}

interface MusicBrainzMedium {
  tracks?: MusicBrainzTrack[];
  discs?: Array<{ id?: string }>;
}

interface MusicBrainzRelease {
  title?: string;
  date?: string;
  "artist-credit"?: Array<string | { name?: string; joinphrase?: string; artist?: { name?: string } }>;
  media?: MusicBrainzMedium[];
}

function fallbackMetadata(trackNumbers: number[]): MusicAlbumMetadata {
  return {
    artist: "Unknown Artist",
    album: `Audio CD ${new Date().toISOString().slice(0, 10)}`,
    year: null,
    tracks: trackNumbers.map((number) => ({ number, title: `Track ${String(number).padStart(2, "0")}` })),
    source: "offline"
  };
}

function releaseArtist(release: MusicBrainzRelease): string {
  return (release["artist-credit"] ?? [])
    .map((credit) => typeof credit === "string" ? credit : `${credit.name ?? credit.artist?.name ?? ""}${credit.joinphrase ?? ""}`)
    .join("")
    .trim();
}

export function parseMusicBrainzRelease(
  payload: { releases?: MusicBrainzRelease[] },
  disc: AudioDisc
): MusicAlbumMetadata {
  const fallback = fallbackMetadata(disc.trackNumbers);
  const releases = payload.releases ?? [];
  let release: MusicBrainzRelease | undefined;
  let medium: MusicBrainzMedium | undefined;

  for (const candidate of releases) {
    const match = candidate.media?.find((item) =>
      item.discs?.some((itemDisc) => itemDisc.id?.toLowerCase() === disc.discId)
    );
    if (match) {
      release = candidate;
      medium = match;
      break;
    }
  }
  if (!medium) {
    release = releases.find((candidate) =>
      candidate.media?.some((item) => item.tracks?.length === disc.trackNumbers.length)
    );
    medium = release?.media?.find((item) => item.tracks?.length === disc.trackNumbers.length);
  }
  if (!release?.title || !medium?.tracks) return fallback;
  const artist = releaseArtist(release);
  if (!artist) return fallback;

  return {
    artist,
    album: release.title,
    year: release.date?.match(/^\d{4}/)?.[0] ?? null,
    tracks: disc.trackNumbers.map((number, index) => ({
      number,
      title: medium.tracks?.[index]?.recording?.title ?? medium.tracks?.[index]?.title ?? `Track ${String(number).padStart(2, "0")}`
    })),
    source: "musicbrainz"
  };
}

export async function resolveMusicMetadata(
  disc: AudioDisc,
  enabled: boolean,
  signal?: AbortSignal
): Promise<MusicAlbumMetadata> {
  const fallback = fallbackMetadata(disc.trackNumbers);
  if (!enabled || !disc.discId) return fallback;

  try {
    const url = new URL(`https://musicbrainz.org/ws/2/discid/${encodeURIComponent(disc.discId)}`);
    url.searchParams.set("inc", "artists+recordings");
    url.searchParams.set("fmt", "json");
    const timeout = AbortSignal.timeout(10_000);
    const response = await fetch(url, {
      headers: { "User-Agent": "AutoDisc/0.1.0 (https://github.com/nick709r/DVDTOJELLYFIN)" },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
    if (!response.ok) throw new Error(`MusicBrainz returned HTTP ${response.status}`);
    const payload = await response.json() as { releases?: MusicBrainzRelease[] };
    return parseMusicBrainzRelease(payload, disc);
  } catch (error) {
    if (signal?.aborted) throw error;
    log("warn", "music-metadata", "Optional MusicBrainz lookup failed; using generic track names", {
      errorType: error instanceof Error ? error.name : "unknown"
    });
    return fallback;
  }
}
