import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import test from "node:test";
import { JobCoordinator } from "../dist/application/job-coordinator.js";
import { defaultSettings } from "../dist/infrastructure/database/default-settings.js";
import { migrateDatabase } from "../dist/infrastructure/database/migrations.js";
import { createSqliteRepositories } from "../dist/infrastructure/database/repositories.js";
import { DvdWorkflow } from "../dist/providers/workflows/dvd.js";

test("unknown TV discs stage, resume without reacquiring the disc, and delete only staging", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autodisc-tv-staging-"));
  const database = new Database(":memory:");
  migrateDatabase(database, defaultSettings);
  const repositories = createSqliteRepositories(database, {
    ...defaultSettings,
    workDir: path.join(root, "work"),
    tvRootDir: path.join(root, "published-tv"),
    moviesDir: path.join(root, "published-movies"),
    musicDir: path.join(root, "published-music")
  });
  repositories.settings.save({
    workDir: path.join(root, "work"),
    tvRootDir: path.join(root, "published-tv"),
    moviesDir: path.join(root, "published-movies"),
    musicDir: path.join(root, "published-music")
  });
  await Promise.all([
    mkdir(path.join(root, "work"), { recursive: true }),
    mkdir(path.join(root, "published-tv"), { recursive: true }),
    mkdir(path.join(root, "published-movies"), { recursive: true }),
    mkdir(path.join(root, "published-music"), { recursive: true })
  ]);
  const jobs = new JobCoordinator(repositories, { publish() {} }, {
    begin() {},
    end() {},
    register() {},
    cancel() { return false; },
    wasCancelled() { return false; }
  });
  const manifest = {
    mediaKind: "dvd",
    attributes: { filesystemVolumeName: "fresh-off-the-boat" },
    items: [1, 2, 3, 4].map((id) => ({
      id: String(id),
      kind: "title",
      title: `Episode ${id}`,
      durationSeconds: 1300
    }))
  };
  let acquisitions = 0;
  const sources = {
    async acquire(_source, directory, options) {
      acquisitions += 1;
      const output = path.join(directory, `title-${options.selection.manifestItemId}.mkv`);
      await writeFile(output, Buffer.alloc(2048));
      return { artifacts: [{ kind: "video", path: output }] };
    },
    inspectionDiagnostics() { return null; }
  };
  let analysisCalls = 0;
  const tvWorkflow = {
    async prepare() {
      analysisCalls += 1;
      if (analysisCalls === 1) return undefined;
      return {
        analysis: { items: manifest.items.map((item) => ({
          itemId: item.id,
          kind: "episode-candidate",
          title: item.title,
          durationSeconds: item.durationSeconds
        })) },
        matches: { items: [] },
        metadataLookups: [],
        identification: { queries: [], failures: [] }
      };
    }
  };
  const workflow = new DvdWorkflow(tvWorkflow, undefined, undefined, async (directory) => {
    await mkdir(directory, { recursive: true });
  }, jobs);
  const source = {
    provider: {},
    candidate: {
      sourceId: "dvd0",
      providerId: "source.video-dvd.makemkv",
      mediaKind: "dvd",
      label: "",
      manifest
    }
  };
  const context = {
    source,
    sources,
    jobs,
    metadata: {},
    signal: new AbortController().signal,
    devicePath: ""
  };

  try {
    assert.equal(await workflow.process(context), true);
    const task = jobs.listTvMatchingTasks()[0];
    assert.ok(task);
    assert.equal(task.status, "awaiting-identification");
    assert.equal(Object.keys(task.files).length, 4);
    assert.equal(jobs.getJob(task.jobId).status, "awaiting-identification");
    const stagedFile = path.join(task.stagingPath, task.files["1"]);
    assert.equal((await stat(stagedFile)).size, 2048);
    assert.match(await readFile(path.join(task.stagingPath, "metadata.json"), "utf8"), /episodeCount/);

    repositories.discRecovery.update(task.fingerprint, {
      finalMediaType: "tv_series",
      metadataProvider: "tvdb",
      providerId: "292941",
      seriesName: "Fresh Off The Boat",
      seasonNumber: 3,
      discNumber: 1,
      identifiedBy: "user",
      importedMetadata: { entityType: "series", title: "Fresh Off The Boat" }
    });
    await workflow.continueTvMatching(task.jobId);
    assert.equal(acquisitions, 4);
    assert.equal(jobs.getTvMatchingTask(task.jobId).status, "awaiting-mapping");
    assert.equal(jobs.getJob(task.jobId).status, "review");
    assert.equal(jobs.getTvMatchingTask(task.jobId).assignments.length, 4);
    await workflow.removeTvMatchingTask(task.jobId);
    await assert.rejects(stat(task.stagingPath), { code: "ENOENT" });
    assert.equal(jobs.getTvMatchingTask(task.jobId), undefined);
    assert.equal(database.prepare("SELECT status FROM jobs WHERE id = ?").get(task.jobId).status, "deleted");
    assert.equal((await readdir(path.join(root, "published-tv"))).length, 0);
    assert.equal((await readdir(path.join(root, "published-movies"))).length, 0);
    assert.equal((await readdir(path.join(root, "published-music"))).length, 0);
  } finally {
    repositories.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("interrupted TV identification recovers to a durable queue after restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autodisc-tv-restart-"));
  const filename = path.join(root, "state.sqlite");
  let database = new Database(filename);
  let repositories = createSqliteRepositories(database, defaultSettings);
  try {
    migrateDatabase(database, defaultSettings);
    const jobs = new JobCoordinator(repositories, { publish() {} }, {
      begin() {},
      end() {},
      register() {},
      cancel() { return false; },
      wasCancelled() { return false; }
    });
    repositories.jobs.add("recoverable-tv-job", "Unknown TV disc", "recoverable-tv-fingerprint", "dvd");
    repositories.jobs.setStatus("recoverable-tv-job", "converting", "Continuing staged TV identification");
    repositories.discRecovery.recordDetection("recoverable-tv-fingerprint", "dvd", "tv_series", 0.42);
    repositories.tvMatchingTasks.create({
      jobId: "recoverable-tv-job",
      fingerprint: "recoverable-tv-fingerprint",
      status: "processing",
      stagingPath: path.join(root, "staging", "recoverable-tv-job"),
      source: {
        sourceId: "dvd0",
        providerId: "source.video-dvd.makemkv",
        mediaKind: "dvd",
        label: "Unknown TV disc",
        manifest: { mediaKind: "dvd", attributes: {}, items: [] }
      },
      diagnostics: { status: "identification-incomplete", confidence: 0.42 },
      files: { "1": "episode01.mkv" },
      assignments: []
    });

    new DvdWorkflow(undefined, undefined, undefined, async () => {}, jobs).recoverInterruptedTvMatchingTasks();
    assert.equal(repositories.tvMatchingTasks.get("recoverable-tv-job").status, "awaiting-identification");
    assert.equal(repositories.history.get("recoverable-tv-job").status, "interrupted");
    repositories.close();

    database = new Database(filename);
    migrateDatabase(database, defaultSettings);
    repositories = createSqliteRepositories(database, defaultSettings);
    const recoveredTask = repositories.tvMatchingTasks.get("recoverable-tv-job");
    assert.equal(recoveredTask.status, "awaiting-identification");
    assert.equal(recoveredTask.diagnostics.confidence, 0.42);
    assert.equal(repositories.discRecovery.get("recoverable-tv-fingerprint").finalMediaType, "tv_series");
    assert.equal(repositories.history.get("recoverable-tv-job").status, "interrupted");
  } finally {
    repositories.close();
    await rm(root, { recursive: true, force: true });
  }
});
