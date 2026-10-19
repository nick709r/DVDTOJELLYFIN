import { events } from "./events.js";
import type { MediaCandidate } from "./domain/media.js";

export interface LiveDiscDiagnostics {
  detectedAt: string;
  updatedAt: string;
  driveId: string;
  devicePath: string;
  detectionMethod: string;
  status: string;
  mediaType: string | null;
  sourceProvider: string | null;
  discLabel: string | null;
  fingerprint: string | null;
  classification: string | null;
  reason: string | null;
  providersAttempted: readonly string[];
  candidate?: MediaCandidate;
}

let liveDisc: LiveDiscDiagnostics | null = null;

export function beginDiscDiagnostics(devicePath: string): void {
  const detectedAt = new Date().toISOString();
  liveDisc = {
    detectedAt,
    updatedAt: detectedAt,
    driveId: devicePath,
    devicePath,
    detectionMethod: "udev event or optical-media presence monitor",
    status: "Inspection started",
    mediaType: null,
    sourceProvider: null,
    discLabel: null,
    fingerprint: null,
    classification: null,
    reason: null,
    providersAttempted: []
  };
  events.emit("status");
}

export function updateDiscDiagnostics(patch: Partial<LiveDiscDiagnostics>): void {
  if (!liveDisc) return;
  liveDisc = { ...liveDisc, ...patch, updatedAt: new Date().toISOString() };
  events.emit("status");
}

export function updateCandidateDiagnostics(candidate: MediaCandidate, providersAttempted: readonly string[] = []): void {
  updateDiscDiagnostics({
    status: "Source identified",
    mediaType: candidate.mediaKind,
    sourceProvider: candidate.providerId,
    providersAttempted,
    discLabel: candidate.label || null,
    fingerprint: candidate.fingerprint ?? null,
    reason: null,
    candidate
  });
}

export function getLiveDiscDiagnostics(): LiveDiscDiagnostics | null {
  return liveDisc;
}

export function clearDiscDiagnostics(): void {
  liveDisc = null;
  events.emit("status");
}
