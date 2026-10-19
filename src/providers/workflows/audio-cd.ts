import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import type { MediaWorkflow, MediaWorkflowContext } from "../../application/media-workflow-registry.js";
import { processAudioCd } from "../../music-pipeline.js";

export class AudioCdWorkflow implements MediaWorkflow {
  readonly mediaKind = "audio_cd";

  async process({ source, sources, jobs, metadata, signal, devicePath }: MediaWorkflowContext): Promise<boolean> {
    const candidate = source.candidate;
    const discId = candidate.manifest.identifiers?.musicBrainzDiscId ?? null;
    const trackNumbers = candidate.manifest.items
      .map((item) => item.trackNumber)
      .filter((number): number is number => typeof number === "number");
    return processAudioCd(devicePath, {
      trackNumbers,
      discId,
      fingerprint: candidate.fingerprint ?? createHash("sha256").update(JSON.stringify(candidate.manifest)).digest("hex")
    }, async (workspacePath, jobSignal) => {
      const acquired = await sources.acquire(source, workspacePath, undefined, jobSignal);
      return Promise.all(acquired.artifacts.map(async (artifact) => ({
        number: artifact.trackNumber ?? 0,
        path: artifact.path,
        bytes: Number(artifact.attributes?.bytes ?? (await stat(artifact.path)).size)
      })));
    }, signal, metadata, jobs, candidate.providerId, sources.inspectionDiagnostics?.()?.attemptedProviders ?? []);
  }
}
