import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import type { ReviewJob, ReviewJobInput, ReviewResumeStage } from "../domain/review-jobs.js";
import type { ReviewJobRepository } from "../domain/review-jobs.js";

interface ReviewManifest {
  jobId: string;
  discType: string;
  discLabel: string | null;
  failureReason: string;
  failureStage: string;
  ripCompleted: boolean;
  createdAt: string;
  lastModifiedAt: string;
  temporaryStorageSize: number;
  resumeStage: ReviewResumeStage;
  metadata: Readonly<Record<string, unknown>>;
}

export class ReviewWorkspaceService {
  constructor(private readonly jobs: ReviewJobRepository) {}

  async create(input: Omit<ReviewJobInput, "storagePath" | "mediaSize" | "failureReason" | "failureStage" | "resumeStage"> & {
    workDir: string;
    mediaSource: string;
  }): Promise<{ job: ReviewJob; mediaPath: string }> {
    const jobId = input.id;
    if (!/^[a-f0-9-]{36}$/i.test(jobId)) throw new Error("Review workspace job ID is invalid");
    const root = resolve(input.workDir, "reviews");
    const workspace = resolve(root, jobId);
    if (!workspace.startsWith(`${root}${sep}`)) throw new Error("Review workspace path is invalid");
    const source = await stat(input.mediaSource);
    if (!source.isFile() || source.size < 1024) throw new Error("Extracted media failed file validation");
    const mediaPath = join(workspace, "media", `input${extname(input.mediaSource) || ".bin"}`);
    await mkdir(join(workspace, "media"), { recursive: true, mode: 0o750 });
    await mkdir(join(workspace, "metadata"), { recursive: true, mode: 0o750 });
    await mkdir(join(workspace, "artwork"), { recursive: true, mode: 0o750 });
    await mkdir(join(workspace, "logs"), { recursive: true, mode: 0o750 });
    let mediaInstalled = false;
    let recordCreated = false;
    try {
      await writeFile(join(workspace, "metadata", "current.json"), `${JSON.stringify(input.metadata, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o640,
        flag: "wx"
      });
      await writeFile(join(workspace, "logs", "processing.log"), "", { encoding: "utf8", mode: 0o640, flag: "wx" });
      const now = new Date().toISOString();
      const initial: ReviewJobInput = {
        id: input.id,
        originalJobId: input.originalJobId,
        discType: input.discType,
        discLabel: input.discLabel,
        failureReason: "",
        failureStage: "metadata",
        storagePath: workspace,
        mediaSize: source.size,
        resumeStage: "metadata",
        metadata: input.metadata
      };
      const manifestJob: ReviewJob = {
        ...initial,
        status: "processing",
        createdAt: now,
        updatedAt: now,
        notificationActive: true
      };
      await this.writeManifest(manifestJob, source.size);
      try {
        await rename(input.mediaSource, mediaPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        await copyFile(input.mediaSource, mediaPath, constants.COPYFILE_EXCL);
        await unlink(input.mediaSource);
      }
      mediaInstalled = true;
      const copied = await stat(mediaPath);
      if (!copied.isFile() || copied.size !== source.size) throw new Error("Extracted media copy failed validation");
      const job = this.jobs.create(initial);
      recordCreated = true;
      this.jobs.update(job.id, { status: "processing" });
      await this.writeManifest({ ...job, status: "processing" }, await this.directorySize(workspace));
      return { job: this.jobs.get(job.id) ?? job, mediaPath };
    } catch (error) {
      if (!mediaInstalled) {
        await rm(workspace, { recursive: true, force: true });
      } else if (recordCreated) {
        this.jobs.update(input.id, {
          status: "pending",
          failureReason: error instanceof Error ? error.message : "Review workspace initialization failed",
          failureStage: "workspace",
          resumeStage: "metadata"
        });
      }
      throw error;
    }
  }

  async recoverProcessing(): Promise<void> {
    for (const job of this.jobs.list()) {
      if (job.status !== "processing" && job.status !== "retrying") continue;
      const message = "Service restarted while this review job was processing";
      const updated = this.jobs.update(job.id, {
        status: "pending",
        failureReason: message,
        failureStage: "service-recovery"
      });
      if (updated) await this.writeManifest(updated, await this.directorySize(join(updated.storagePath, "media")));
    }
  }

  async markPending(id: string, input: {
    reason: string;
    stage: string;
    resumeStage: ReviewResumeStage;
    metadata?: Readonly<Record<string, unknown>>;
  }): Promise<ReviewJob> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Review job ${id} was not found`);
    const metadata = input.metadata ?? job.metadata;
    const mediaSize = await this.directorySize(join(job.storagePath, "media"));
    const updated = this.jobs.update(id, {
      status: "pending",
      failureReason: input.reason,
      failureStage: input.stage,
      resumeStage: input.resumeStage,
      mediaSize,
      metadata
    });
    if (!updated) throw new Error(`Review job ${id} could not be updated`);
    await writeFile(join(job.storagePath, "metadata", "current.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    await writeFile(join(job.storagePath, "logs", "processing.log"),
      `${new Date().toISOString()} [${input.stage}] ${input.reason}\n`, { encoding: "utf8", flag: "a" });
    const totalSize = await this.directorySize(job.storagePath);
    await this.writeManifest(updated, totalSize);
    return updated;
  }

  async updateMetadata(id: string, patch: Readonly<Record<string, unknown>>): Promise<ReviewJob> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Review job ${id} was not found`);
    const metadata = { ...job.metadata, ...patch };
    const updated = this.jobs.update(id, { metadata });
    if (!updated) throw new Error(`Review job ${id} could not be updated`);
    await writeFile(join(job.storagePath, "metadata", "current.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    await this.writeManifest(updated, await this.directorySize(job.storagePath));
    return updated;
  }

  async manifest(id: string): Promise<ReviewManifest> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Review job ${id} was not found`);
    return JSON.parse(await readFile(join(job.storagePath, "review.json"), "utf8")) as ReviewManifest;
  }

  async mediaFiles(id: string): Promise<string[]> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Review job ${id} was not found`);
    const mediaDirectory = join(job.storagePath, "media");
    const entries = await readdir(mediaDirectory, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const path = join(mediaDirectory, entry.name);
      const info = await lstat(path);
      if (info.isFile()) files.push(path);
    }
    return files.sort();
  }

  async remove(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    const path = resolve(job.storagePath);
    if (!/^[a-f0-9-]{36}$/i.test(id) ||
      basename(dirname(path)) !== "reviews" || basename(path) !== id) {
      throw new Error("Review workspace path failed validation");
    }
    const info = await lstat(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (info?.isSymbolicLink()) throw new Error("Review workspace must not be a symbolic link");
    await rm(path, { recursive: true, force: true });
    this.jobs.delete(id);
  }

  private async writeManifest(job: ReviewJob, totalSize: number): Promise<void> {
    const manifest: ReviewManifest = {
      jobId: job.originalJobId,
      discType: job.discType,
      discLabel: job.discLabel,
      failureReason: job.failureReason,
      failureStage: job.failureStage,
      ripCompleted: true,
      createdAt: job.createdAt,
      lastModifiedAt: new Date().toISOString(),
      temporaryStorageSize: totalSize,
      resumeStage: job.resumeStage,
      metadata: job.metadata
    };
    const temporary = join(job.storagePath, `.review-${job.id}.tmp`);
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o640 });
    await rename(temporary, join(job.storagePath, "review.json"));
  }

  private async directorySize(path: string): Promise<number> {
    let size = 0;
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) size += await this.directorySize(child);
      else if (entry.isFile()) size += (await stat(child)).size;
    }
    return size;
  }
}
