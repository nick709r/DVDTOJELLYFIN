import { createHash } from "node:crypto";
import type { MediaCandidate } from "./media.js";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, canonicalize(entry)])
  );
}

export function fingerprintDisc(candidate: MediaCandidate): string {
  const identity = {
    version: 2,
    providerId: candidate.providerId,
    mediaKind: candidate.mediaKind,
    label: candidate.label.trim().normalize("NFKC").toLowerCase(),
    manifest: candidate.manifest
  };
  return createHash("sha256").update(JSON.stringify(canonicalize(identity))).digest("hex");
}
