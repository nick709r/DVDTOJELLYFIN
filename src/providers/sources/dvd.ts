import type { MediaSourceCandidate, MediaSourceProvider, SourceAcquisitionOptions } from "../../contracts/media-source.js";
import type { ProviderDescriptor } from "../../contracts/provider.js";
import { inspectDisc, ripTitle } from "../../media.js";
import { executableAvailable } from "../../executable.js";

const descriptor: ProviderDescriptor = {
  id: "source.video-dvd.makemkv",
  apiVersion: "1.0.0",
  kind: "source",
  capabilities: ["video.disc.dvd", "video.title-ripping"]
};
const makeMkv = process.env.MAKEMKV_COMMAND ?? "makemkvcon";

export class MakeMkvDvdSourceProvider implements MediaSourceProvider {
  describe(): ProviderDescriptor {
    return descriptor;
  }

  async initialize(): Promise<void> {}

  async healthCheck(): Promise<{ status: "available" | "degraded" | "unavailable"; message?: string }> {
    if (await executableAvailable(makeMkv)) return { status: "available" };
    return { status: "unavailable", message: "makemkvcon is not executable on the service PATH" };
  }

  async dispose(): Promise<void> {}

  async inspect(sourceId: string, signal?: AbortSignal): Promise<MediaSourceCandidate> {
    const disc = await inspectDisc(`dev:${sourceId}`, signal);
    return {
      providerId: descriptor.id,
      mediaKind: "dvd",
      sourceId,
      label: disc.label,
      manifest: {
        mediaKind: "dvd",
        items: disc.titles.map((title) => ({
          id: String(title.id),
          kind: "title",
          title: title.name,
          durationSeconds: title.durationSeconds
        }))
      }
    };
  }

  async acquire(
    candidate: MediaSourceCandidate,
    workspacePath: string,
    options?: SourceAcquisitionOptions,
    signal?: AbortSignal
  ) {
    if (candidate.mediaKind !== "dvd" || candidate.providerId !== descriptor.id) {
      throw new Error("DVD provider received a candidate it does not own");
    }
    const selectedTitle = options?.selection?.manifestItemId;
    if (selectedTitle === undefined || !/^\d+$/.test(selectedTitle)) {
      throw new Error("DVD acquisition requires a selected manifest item ID");
    }
    return {
      source: {
        id: candidate.sourceId,
        providerId: descriptor.id,
        kind: candidate.mediaKind,
        location: candidate.sourceId
      },
      artifacts: [{
        id: `dvd-title-${selectedTitle}`,
        kind: "video",
        mediaType: "video/x-matroska",
        path: await ripTitle(`dev:${candidate.sourceId}`, Number(selectedTitle), workspacePath, signal)
      }]
    };
  }
}
