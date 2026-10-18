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
  source: "musicbrainz" | "manual" | "offline";
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
  if (!release?.title || !medium?.tracks || medium.tracks.length !== disc.trackNumbers.length) return fallback;
  const artist = releaseArtist(release);
  if (!artist) return fallback;
  const tracks = disc.trackNumbers.map((number, index) => ({
    number,
    title: medium.tracks?.[index]?.recording?.title ?? medium.tracks?.[index]?.title ?? ""
  }));
  if (tracks.some((track) => !track.title.trim())) return fallback;

  return {
    artist,
    album: release.title,
    year: release.date?.match(/^\d{4}/)?.[0] ?? null,
    tracks,
    source: "musicbrainz"
  };
}

function musicBrainzHeaders(contactEmail: string): HeadersInit {
  const contact = contactEmail.trim();
  return {
    "User-Agent": `AutoDisc/1.6.5 (https://github.com/nick709r/DVDTOJELLYFIN${contact ? `; contact: ${contact}` : ""})`
  };
}

export async function resolveMusicBrainzRelease(
  releaseId: string,
  disc: AudioDisc,
  contactEmail = "",
  signal?: AbortSignal
): Promise<MusicAlbumMetadata | null> {
  const id = releaseId.trim();
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id)) {
    throw new Error("Enter a valid MusicBrainz release ID");
  }

  const url = new URL(`https://musicbrainz.org/ws/2/release/${encodeURIComponent(id)}`);
  url.searchParams.set("inc", "artists+recordings");
  url.searchParams.set("fmt", "json");
  const timeout = AbortSignal.timeout(10_000);
  const response = await fetch(url, {
    headers: musicBrainzHeaders(contactEmail),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`MusicBrainz returned HTTP ${response.status}`);
  const release = await response.json() as MusicBrainzRelease;
  const metadata = parseMusicBrainzRelease({ releases: [release] }, disc);
  return metadata.source === "musicbrainz" ? metadata : null;
}

export async function resolveMusicMetadata(
  disc: AudioDisc,
  enabled: boolean,
  signal?: AbortSignal,
  contactEmail = ""
): Promise<MusicAlbumMetadata> {
  const fallback = fallbackMetadata(disc.trackNumbers);
  if (!enabled || !disc.discId) return fallback;

  try {
    const url = new URL(`https://musicbrainz.org/ws/2/discid/${encodeURIComponent(disc.discId)}`);
    url.searchParams.set("inc", "artists+recordings");
    url.searchParams.set("fmt", "json");
    const timeout = AbortSignal.timeout(10_000);
    const response = await fetch(url, {
      headers: musicBrainzHeaders(contactEmail),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
    if (!response.ok) throw new Error(`MusicBrainz returned HTTP ${response.status}`);
    const payload = await response.json() as { releases?: MusicBrainzRelease[] };
    return parseMusicBrainzRelease(payload, disc);
  } catch (error) {
    if (signal?.aborted) throw error;
    log("warn", "music-metadata", "Automatic MusicBrainz lookup failed; manual metadata may be needed", {
      errorType: error instanceof Error ? error.name : "unknown"
    });
    return fallback;
  }
}
