export type ReviewJobStatus = "processing" | "pending" | "retrying" | "completed" | "dismissed";
export type ReviewResumeStage = "metadata" | "artwork" | "naming" | "import";

export interface ReviewJob {
  id: string;
  originalJobId: string;
  status: ReviewJobStatus;
  discType: string;
  discLabel: string | null;
  failureReason: string;
  failureStage: string;
  storagePath: string;
  mediaSize: number;
  createdAt: string;
  updatedAt: string;
  resumeStage: ReviewResumeStage;
  metadata: Readonly<Record<string, unknown>>;
  notificationActive: boolean;
}

export type ReviewJobInput = Pick<ReviewJob,
  "id" | "originalJobId" | "discType" | "discLabel" | "failureReason" | "failureStage" |
  "storagePath" | "mediaSize" | "resumeStage" | "metadata">;

export interface ReviewJobRepository {
  create(input: ReviewJobInput): ReviewJob;
  get(id: string): ReviewJob | undefined;
  list(): ReviewJob[];
  update(id: string, patch: Partial<Pick<ReviewJob,
    "status" | "failureReason" | "failureStage" | "mediaSize" | "resumeStage" | "metadata" | "notificationActive">>): ReviewJob | undefined;
  delete(id: string): boolean;
}
