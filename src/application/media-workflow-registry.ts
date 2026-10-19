import type { MediaSourceCoordinator, InspectedMediaSource } from "./media-source-coordinator.js";
import type { JobCoordinator } from "./job-coordinator.js";
import type { MetadataResolver } from "./metadata-resolver.js";

export interface MediaWorkflowContext {
  source: InspectedMediaSource;
  sources: MediaSourceCoordinator;
  jobs: JobCoordinator;
  metadata: MetadataResolver;
  signal: AbortSignal;
  devicePath: string;
}

export interface MediaWorkflow {
  readonly mediaKind: string;
  process(context: MediaWorkflowContext): Promise<boolean>;
}

export class MediaWorkflowRegistry {
  private readonly workflows = new Map<string, MediaWorkflow>();

  register(workflow: MediaWorkflow): void {
    if (!workflow.mediaKind.trim()) throw new Error("Media workflow kind must not be empty");
    if (this.workflows.has(workflow.mediaKind)) {
      throw new Error(`Media workflow is already registered: ${workflow.mediaKind}`);
    }
    this.workflows.set(workflow.mediaKind, workflow);
  }

  list(): string[] {
    return [...this.workflows.keys()];
  }

  async process(source: InspectedMediaSource, context: Omit<MediaWorkflowContext, "source">): Promise<boolean> {
    const workflow = this.workflows.get(source.candidate.mediaKind);
    if (!workflow) throw new Error(`No workflow is registered for media kind ${source.candidate.mediaKind}`);
    return workflow.process({ ...context, source });
  }
}
