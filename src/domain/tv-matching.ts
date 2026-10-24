import type { MediaCandidate } from "./media.js";
import type { Episode } from "./television.js";

export type TvMatchingStatus =
  | "awaiting-identification"
  | "awaiting-mapping"
  | "partially-matched"
  | "ready-to-publish"
  | "processing"
  | "completed";

export interface TvMatchingEpisodeCandidate {
  episodes: readonly Episode[];
  confidence: number;
}

export interface TvMatchingAssignment {
  trackId: string;
  title: string;
  durationSeconds: number;
  resolution?: string;
  episodeCandidates: readonly TvMatchingEpisodeCandidate[];
  selectedEpisodes?: readonly Episode[];
  confirmed?: boolean;
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

export interface TvMatchingProgress {
  matchedCount: number;
  totalCount: number;
  unmatchedCount: number;
  fullyMatched: boolean;
}

export function tvMatchingProgress(assignments: readonly TvMatchingAssignment[]): TvMatchingProgress {
  const matchedCount = assignments.filter((assignment) =>
    assignment.confirmed === true && Boolean(assignment.selectedEpisodes?.length)).length;
  const totalCount = assignments.length;
  return {
    matchedCount,
    totalCount,
    unmatchedCount: totalCount - matchedCount,
    fullyMatched: totalCount > 0 && matchedCount === totalCount
  };
}

export function tvMatchingReviewStatus(assignments: readonly TvMatchingAssignment[]): TvMatchingStatus {
  const { matchedCount, totalCount, fullyMatched } = tvMatchingProgress(assignments);
  if (fullyMatched) return "ready-to-publish";
  if (matchedCount > 0) return "partially-matched";
  return totalCount > 0 ? "awaiting-mapping" : "awaiting-identification";
}
