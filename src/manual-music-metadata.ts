import type { AudioDisc } from "./audio-cd.js";
import type { MusicAlbumMetadata } from "./music-metadata.js";
import { events } from "./events.js";

export interface ManualMusicMetadataPrompt {
  jobId: string;
  discId: string | null;
  tracks: Array<{ number: number; title: string }>;
}

interface PendingPrompt {
  prompt: ManualMusicMetadataPrompt;
  resolve: (metadata: MusicAlbumMetadata) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const pendingPrompts = new Map<string, PendingPrompt>();

export function getManualMusicMetadataPrompt(jobId?: string): ManualMusicMetadataPrompt | null {
  const pending = jobId
    ? pendingPrompts.get(jobId)
    : pendingPrompts.values().next().value as PendingPrompt | undefined;
  if (!pending) return null;
  return {
    ...pending.prompt,
    tracks: pending.prompt.tracks.map((track) => ({ ...track }))
  };
}

export function waitForManualMusicMetadata(
  jobId: string,
  disc: AudioDisc,
  signal?: AbortSignal
): Promise<MusicAlbumMetadata> {
  if (signal?.aborted) return Promise.reject(new Error("Audio CD processing cancelled"));
  if (pendingPrompts.has(jobId)) return Promise.reject(new Error("Manual music metadata is already pending for this job"));

  return new Promise((resolve, reject) => {
    const prompt: ManualMusicMetadataPrompt = {
      jobId,
      discId: disc.discId,
      tracks: disc.trackNumbers.map((number) => ({
        number,
        title: `Track ${String(number).padStart(2, "0")}`
      }))
    };
    const pending: PendingPrompt = { prompt, resolve, reject, ...(signal ? { signal } : {}) };
    if (signal) {
      pending.onAbort = () => {
        pendingPrompts.delete(jobId);
        reject(new Error("Audio CD processing cancelled"));
        events.emit("status");
      };
      signal.addEventListener("abort", pending.onAbort, { once: true });
    }
    pendingPrompts.set(jobId, pending);
    events.emit("status");
  });
}

export function submitManualMusicMetadata(
  jobId: string,
  metadata: MusicAlbumMetadata
): boolean {
  const pending = pendingPrompts.get(jobId);
  if (!pending) return false;
  pendingPrompts.delete(jobId);
  if (pending.signal && pending.onAbort) {
    pending.signal.removeEventListener("abort", pending.onAbort);
  }
  pending.resolve(metadata);
  events.emit("status");
  return true;
}
