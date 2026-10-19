import { createHash } from "node:crypto";

function hex(value: number, width: number): string {
  return value.toString(16).toUpperCase().padStart(width, "0");
}

export function musicBrainzDiscIdFromToc(output: string, expectedTracks?: number): string | null {
  const values = output.trim().split(/\s+/).map(Number);
  const trackCount = values[0];
  if (trackCount === undefined || !Number.isInteger(trackCount) || trackCount < 1 || trackCount > 99 ||
    values.length !== trackCount + 2 ||
    (expectedTracks !== undefined && expectedTracks !== trackCount)) {
    return null;
  }
  const offsets = values.slice(1, trackCount + 1);
  const leadOut = values[trackCount + 1];
  if (offsets.some((offset) => !Number.isInteger(offset) || offset < 0 || offset > 0xffffffff) ||
    leadOut === undefined || !Number.isInteger(leadOut) || leadOut < 0 || leadOut > 0xffffffff) {
    return null;
  }

  const toc = [
    hex(1, 2),
    hex(trackCount, 2),
    hex(leadOut, 8),
    ...offsets.map((offset) => hex(offset, 8)),
    ...Array.from({ length: 99 - trackCount }, () => "00000000")
  ].join("");
  return createHash("sha1").update(toc, "ascii").digest("base64")
    .replace(/\+/g, ".")
    .replace(/\//g, "_")
    .replace(/=+$/, "-");
}
