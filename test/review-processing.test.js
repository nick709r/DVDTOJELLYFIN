import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import test from "node:test";
import { JobCoordinator } from "../dist/application/job-coordinator.js";
import { ReviewJobProcessor } from "../dist/application/review-job-processor.js";
import { ReviewWorkspaceService } from "../dist/application/review-workspace-service.js";
import { DvdWorkflow } from "../dist/providers/workflows/dvd.js";
import { defaultSettings } from "../dist/infrastructure/database/default-settings.js";
import { migrateDatabase } from "../dist/infrastructure/database/migrations.js";
import { createSqliteRepositories } from "../dist/infrastructure/database/repositories.js";

test("DVD metadata failure queues verified extraction without requiring another rip", async () => {
  const root = await mkdtemp(join(tmpdir(), "dvd-review-processing-"));
  const db = new Database(":memory:");
  migrateDatabase(db, defaultSettings);
  const repositories = createSqliteRepositories(db, defaultSettings);
  try {
    const workDir = join(root, "working");
    const moviesDir = join(root, "movies");
    repositories.settings.save({ workDir, moviesDir, metadataEnabled: true, autoEject: false });
    const jobs = new JobCoordinator(repositories, { publish() {} }, {
      begin() {},
      end() {},
      register() {},
      cancel() { return false; },
      wasCancelled() { return false; }
    });

    const workspaces = new ReviewWorkspaceService(repositories.reviewJobs);
    const workflow = new DvdWorkflow(undefined, workspaces);
    let ripCount = 0;
    const source = {
      provider: {},
      candidate: {
        providerId: "source.video-dvd.makemkv",
        sourceId: "drive-1",
        mediaKind: "dvd",
        label: "Example Film",
        manifest: {
          mediaKind: "dvd",
          items: [{ id: "1", kind: "title", title: "Feature", durationSeconds: 7200 }]
        }
      }
    };
    const handled = await workflow.process({
      source,
      sources: {
        acquire: async (_source, workspacePath) => {
          ripCount += 1;
          const mediaPath = join(workspacePath, "extracted.mkv");
          await writeFile(mediaPath, Buffer.alloc(4096, 4));
          return {
            source: { id: "drive-1", providerId: "source.video-dvd.makemkv", kind: "dvd" },
            artifacts: [{ id: "video-1", kind: "video", path: mediaPath }]
          };
        }
      },
      jobs,
      metadata: {
        resolve: async () => ({
          selected: undefined,
          candidates: [],
          providerFailures: [{ providerId: "metadata.test", message: "Provider offline" }]
        })
      },
      signal: new AbortController().signal,
      devicePath: "/dev/sr0"
    });

    assert.equal(handled, true);
    assert.equal(ripCount, 1);
    const reviewJob = repositories.reviewJobs.list()[0];
    assert.equal(reviewJob.status, "pending");
    assert.equal(reviewJob.failureStage, "metadata");
    const [mediaPath] = await workspaces.mediaFiles(reviewJob.id);
    assert.equal((await stat(mediaPath)).size, 4096);
    assert.equal(JSON.parse(await readFile(join(reviewJob.storagePath, "review.json"), "utf8")).ripCompleted, true);
    assert.equal(repositories.history.get(reviewJob.originalJobId).status, "review");
  } finally {
    repositories.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("movie metadata and provider identity persist by disc fingerprint and are reused on rediscovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "dvd-metadata-recovery-"));
  const db = new Database(":memory:");
  migrateDatabase(db, defaultSettings);
  const repositories = createSqliteRepositories(db, defaultSettings);
  try {
    const moviesDir = join(root, "movies");
    repositories.settings.save({
      workDir: join(root, "working"),
      moviesDir,
      metadataEnabled: true,
      autoEject: false,
      libraryMetadata: { ...defaultSettings.libraryMetadata, downloadArtwork: false }
    });
    const jobs = new JobCoordinator(repositories, { publish() {} }, {
      begin() {},
      end() {},
      register() {},
      cancel() { return false; },
      wasCancelled() { return false; }
    });
    const workflow = new DvdWorkflow(undefined, undefined, async (_input, target, _title, _settings, onPublishing, onProgress) => {
      await writeFile(target, Buffer.alloc(4096, 9));
      onPublishing({ name: "Test encoder", codec: "libx264", hardware: false });
      onProgress(1);
      return { encoder: { name: "Test encoder", codec: "libx264", hardware: false }, outputBytes: 4096 };
    }, async () => {});
    const source = {
      provider: {},
      candidate: {
        providerId: "source.video-dvd.makemkv",
        sourceId: "drive-1",
        mediaKind: "dvd",
        label: "Example Film",
        manifest: { mediaKind: "dvd", items: [{ id: "1", kind: "title", title: "Feature", durationSeconds: 7200 }] }
      }
    };
    let resolveCalls = 0;
    let enrichCalls = 0;
    const metadata = {
      resolve: async () => {
        resolveCalls += 1;
        return {
          selected: {
            id: "123",
            providerId: "metadata.tmdb.movie",
            entityType: "movie",
            title: "Example Film (2024)",
            confidence: 0.98,
            metadata: { title: "Example Film", year: 2024, overview: "A sample film" },
            identifiers: { tmdbMovieId: "123" }
          },
          candidates: [],
          providerFailures: []
        };
      },
      enrich: async (candidate) => {
        enrichCalls += 1;
        return { ...candidate, metadata: { ...candidate.metadata, rating: 8.1 } };
      }
    };
    const context = {
      source,
      sources: { acquire: async () => ({ artifacts: [{ id: "video", kind: "video", path: "input.mkv" }] }) },
      jobs,
      metadata,
      signal: new AbortController().signal,
      devicePath: "/dev/sr0"
    };
    assert.equal(await workflow.process(context), true);
    const saved = repositories.discRecovery.list(10)[0];
    assert.equal(saved.metadataProvider, "tmdb");
    assert.equal(saved.providerId, "123");
    assert.equal(saved.importedMetadata.rating, 8.1);
    assert.equal(saved.importedMetadata.entityType, "movie");
    const movieJob = repositories.history.list(10).find((job) => job.status === "completed");
    assert.ok(movieJob?.outputPath, "movie publishing did not record an output path");
    assert.match(await readFile(join(dirname(movieJob.outputPath), "movie.nfo"), "utf8"), /A sample film/);
    const movieDirectory = dirname(movieJob.outputPath);
    const movieInfo = await stat(movieDirectory);
    const movieFileInfo = await stat(movieJob.outputPath);
    const movieLibraryInfo = await stat(moviesDir);
    if (process.platform !== "win32") {
      assert.equal(movieInfo.gid, movieLibraryInfo.gid);
      assert.equal(movieFileInfo.gid, movieLibraryInfo.gid);
      assert.equal(movieInfo.mode & 0o777, 0o775);
      assert.equal(movieFileInfo.mode & 0o777, 0o664);
      assert.equal(movieInfo.mode & 0o002, 0);
      assert.equal(movieFileInfo.mode & 0o002, 0);
    }
    repositories.recovery.clearInsertedDisc();
    assert.equal(await workflow.process(context), true);
    assert.equal(resolveCalls, 1);
    assert.equal(enrichCalls, 1);
    assert.equal(repositories.history.list(10).filter((job) => job.status === "completed").length, 2);
  } finally {
    repositories.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("review retry resumes metadata from saved media without a source provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "dvd-review-resume-"));
  const db = new Database(":memory:");
  migrateDatabase(db, defaultSettings);
  const repositories = createSqliteRepositories(db, defaultSettings);
  const jobId = "d07deddd-79e0-4dc7-a2d4-a8e8df68e12e";
  try {
    const workDir = join(root, "working");
    repositories.settings.save({ workDir, moviesDir: join(root, "movies"), metadataEnabled: true });
    repositories.jobs.add(jobId, "Example Film", "fingerprint", "dvd");
    repositories.jobs.finish(jobId, "review", "Metadata provider offline");
    const workspaces = new ReviewWorkspaceService(repositories.reviewJobs);
    const mediaPath = join(root, "already-extracted.mkv");
    await writeFile(mediaPath, Buffer.alloc(4096, 7));
    const reviewJob = await workspaces.create({
      id: jobId,
      originalJobId: jobId,
      discType: "dvd",
      discLabel: "Example Film",
      metadata: { title: null },
      workDir,
      mediaSource: mediaPath
    });
    await workspaces.markPending(jobId, {
      reason: "Metadata provider offline",
      stage: "metadata",
      resumeStage: "metadata"
    });
    let metadataLookups = 0;
    const jobs = new JobCoordinator(repositories, { publish() {} }, {
      begin() {},
      end() {},
      register() {},
      cancel() { return false; },
      wasCancelled() { return false; }
    });
    const processor = new ReviewJobProcessor(
      repositories.reviewJobs,
      workspaces,
      jobs,
      () => repositories.settings.get(),
      {
        resolve: async () => {
          metadataLookups += 1;
          return { selected: undefined, candidates: [], providerFailures: [{ providerId: "offline", message: "Still offline" }] };
        }
      }
    );

    await assert.rejects(processor.continue(reviewJob.job.id), /Metadata lookup failed/);
    assert.equal(metadataLookups, 1);
    assert.equal(repositories.reviewJobs.get(jobId).status, "pending");
    assert.equal((await stat((await workspaces.mediaFiles(jobId))[0])).size, 4096);
    assert.equal(repositories.history.get(jobId).status, "review");
  } finally {
    repositories.close();
    await rm(root, { recursive: true, force: true });
  }
});
