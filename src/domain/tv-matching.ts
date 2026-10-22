import type { MediaCandidate } from "./media.js";
import type { Episode } from "./television.js";

export type TvMatchingStatus = "awaiting-identification" | "awaiting-mapping" | "processing" | "completed";

export interface TvMatchingEpisodeCandidate {
  episodes: readonly Episode[];
  confidence: number;
}

export interface TvMatchingAssignment {
  trackId: string;
  title: string;
  durationSeconds: number;
  episodeCandidates: readonly TvMatchingEpisodeCandidate[];
  selectedEpisodes?: readonly Episode[];
}

export interface TvMatchingTask {
  jobId: string;
  fingerprint: string;
  status: TvMatchingStatus;
  stagingPath: string;
  source: MediaCandidate;
  diagnostics: Readonly<Record<string, unknown>>;
  files: Readonly<Record<string, string>>;
  assignments: readonly TvMatchingAssignment[];
  createdAt: string;
  updatedAt: string;
  failure?: string;
}

export interface TvMatchingTaskInput extends Omit<TvMatchingTask, "createdAt" | "updatedAt"> {}

export interface TvMatchingTaskRepository {
  create(input: TvMatchingTaskInput): TvMatchingTask;
  get(jobId: string): TvMatchingTask | undefined;
  list(): TvMatchingTask[];
  update(jobId: string, patch: Partial<Pick<TvMatchingTask,
    "status" | "stagingPath" | "diagnostics" | "files" | "assignments">> & { failure?: string | null }): TvMatchingTask | undefined;
  delete(jobId: string): boolean;
  deleteTemporaryRecords(jobId: string, fingerprint: string): boolean;
}
