import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ProcessFailure, runProcess } from "./process.js";
import { log } from "./logger.js";
import { musicBrainzDiscIdFromToc } from "./musicbrainz-discid.js";

const cdparanoia = process.env.CDPARANOIA_COMMAND ?? "cdparanoia";
const cdDiscId = process.env.CD_DISCID_COMMAND ?? "cd-discid";

export interface AudioDisc {
  trackNumbers: number[];
  discId: string | null;
  fingerprint: string;
}

export interface AudioTrackFile {
  number: number;
  path: string;
  bytes: number;
}

export function parseAudioTrackNumbers(output: string): number[] {
  return [...new Set([...output.matchAll(/^\s*track\s+(\d+):/gim)]
    .map((match) => Number(match[1]))
    .filter((track) => Number.isInteger(track) && track > 0))]
    .sort((left, right) => left - right);
}

export async function inspectAudioCd(device: string, signal?: AbortSignal): Promise<AudioDisc | null> {
  let result;
  try {
    result = await runProcess(cdparanoia, ["-Q", "-d", device], {
      timeoutMs: 30_000,
      ...(signal ? { signal } : {})
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof ProcessFailure && error.message.includes("ENOENT")) {
      log("warn", "audio-cd", "cdparanoia is unavailable; audio CD detection is disabled");
    }
    return null;
  }

  const output = `${result.stdout}\n${result.stderr}`;
  const trackNumbers = parseAudioTrackNumbers(output);
  if (trackNumbers.length === 0) return null;

  let discId: string | null = null;
  try {
    const identity = await runProcess(cdDiscId, ["--musicbrainz", device], {
      timeoutMs: 15_000,
      ...(signal ? { signal } : {})
    });
    discId = musicBrainzDiscIdFromToc(identity.stdout, trackNumbers.length);
  } catch (error) {
    if (signal?.aborted) throw error;
    log("warn", "audio-cd", "Could not read CD disc ID; using the detected table of contents", {
      errorType: error instanceof Error ? error.name : "unknown"
    });
  }

  const toc = output.split(/\r?\n/).filter((line) => /^\s*track\s+\d+:/i.test(line)).join("\n");
  const fingerprint = createHash("sha256").update(discId ?? toc).digest("hex");
  return { trackNumbers, discId, fingerprint };
}

export async function ripAudioTracks(
  device: string,
  workDir: string,
  signal?: AbortSignal
): Promise<AudioTrackFile[]> {
  const outputDir = join(workDir, "audio-tracks");
  await mkdir(outputDir, { recursive: true, mode: 0o750 });
  await runProcess(cdparanoia, ["-B", "-d", device], {
    timeoutMs: 8 * 60 * 60 * 1000,
    cwd: outputDir,
    ...(signal ? { signal } : {})
  });
  const entries = await readdir(outputDir);
  const tracks = await Promise.all(entries
    .map((name) => {
      const match = /^track(\d+)\.cdda\.wav$/i.exec(name);
      return match ? { number: Number(match[1]), path: join(outputDir, name) } : null;
    })
    .filter((track): track is { number: number; path: string } => track !== null)
    .map(async (track) => ({ ...track, bytes: (await stat(track.path)).size })));
  tracks.sort((left, right) => left.number - right.number);
  if (tracks.length === 0 || tracks.some((track) => track.bytes < 1024)) {
    throw new Error("CD paranoia did not produce valid audio track files");
  }
  return tracks;
}
