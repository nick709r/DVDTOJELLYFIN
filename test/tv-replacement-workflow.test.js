import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("conflict action executes replacement through the staged TV workflow", {
  skip: process.platform !== "linux"
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "autodisc-replacement-workflow-"));
  const workDir = join(root, "work");
  const stagingRoot = join(root, "staging");
  const library = join(root, "tv");
  const jobId = "20000000-0000-4000-8000-000000000002";
  const staging = join(stagingRoot, jobId);
  const probe = join(root, "ffprobe");
  await Promise.all([mkdir(staging, { recursive: true }), mkdir(library), mkdir(workDir)]);
  await writeFile(probe, "#!/bin/sh\nprintf '123.0\\n'\n");
  await chmod(probe, 0o700);
  process.env.DATABASE_PATH = join(root, "state.sqlite");
  process.env.FFPROBE_COMMAND = probe;
  const { app } = await import("../dist/server.js");
  const { repositories, db } = await import("../dist/db.js");
  const { defaultSettings } = await import("../dist/infrastructure/database/default-settings.js");
  const { JobCoordinator } = await import("../dist/application/job-coordinator.js");
  const { DvdWorkflow } = await import("../dist/providers/workflows/dvd.js");
  t.after(async () => {
    await app.close();
    repositories.close();
    delete process.env.DATABASE_PATH;
    delete process.env.FFPROBE_COMMAND;
    await rm(root, { recursive: true, force: true });
  });
  const profile = defaultSettings.outputDestinations.profiles[0];
  repositories.settings.save({
    workDir, tvStagingDir: stagingRoot, tvRootDir: library, moviesDir: join(root, "movies"),
    musicDir: join(root, "music"), lidarrImportDir: "", format: "mkv",
    outputDestinations: {
      activeProfileId: profile.id,
      profiles: [{ ...profile, jellyfin: { root: "", paths: { tv: library, movies: "", music: "" } },
        sonarr: { seriesRoot: "" }, radarr: { movieRoot: "" }, lidarr: { artistRoot: "" },
        folder: { tv: "", movies: "", music: "" } }]
    },
    libraryMetadata: { ...defaultSettings.libraryMetadata, automaticImport: false,
      downloadSeriesMetadata: false, downloadEpisodeMetadata: false, generateNfo: false }
  });
  const original = join(library, "existing.mkv");
  const source = join(staging, "source.mkv");
  await writeFile(original, Buffer.alloc(2048, 1));
  await writeFile(source, Buffer.alloc(2048, 2));
  repositories.tvEpisodePublications.record([{
    outputPath: original, fingerprint: "old", discLabel: "Disc 1", discNumber: 1,
    trackId: "7", trackTitle: "Old", seriesName: "Example", metadataProvider: "tvdb",
    providerId: "123", seasonNumber: 1, episodeNumber: 7, confirmedAt: "2026-01-01",
    publishedAt: "2026-01-02"
  }]);
  repositories.jobs.add(jobId, "Disc 2", "new", "dvd");
  repositories.jobs.finish(jobId, "review", "Awaiting matching");
  repositories.reviewItems.create({ category: "tv_review", severity: "medium", title: "TV review",
    description: "Match episodes", relatedJobId: jobId, discFingerprint: "new", suggestedActions: [] });
  repositories.discRecovery.recordDetection("new", "dvd", "tv_series");
  repositories.discRecovery.update("new", { metadataProvider: "tvdb", providerId: "123",
    seriesName: "Example", seasonNumber: 1, discNumber: 2, identifiedBy: "user" });
  const item = { id: "1", kind: "title", title: "New", durationSeconds: 1300 };
  const assignment = { trackId: "1", title: "New", durationSeconds: 1300, episodeCandidates: [],
    confirmed: true, confirmedAt: "2026-01-03",
    selectedEpisodes: [{ seriesId: "123", seasonNumber: 1, episodeNumber: 7 }] };
  repositories.tvMatchingTasks.create({
    jobId, fingerprint: "new", status: "awaiting-mapping", stagingPath: staging,
    source: { sourceId: "dvd", providerId: "dvd", mediaKind: "dvd", label: "Disc 2",
      manifest: { mediaKind: "dvd", items: [item] } },
    diagnostics: {}, files: { "1": "source.mkv" }, assignments: [assignment]
  });
  const setup = await app.inject({ method: "POST", url: "/api/v1/setup",
    payload: { username: "admin", password: "SecurePassword123!", confirmPassword: "SecurePassword123!" } });
  assert.equal(setup.statusCode, 201, setup.body);
  const login = await app.inject({ method: "POST", url: "/api/v1/login",
    payload: { username: "admin", password: "SecurePassword123!" } });
  const cookie = login.headers["set-cookie"].split(";")[0];
  const listing = await app.inject({ method: "GET", url: `/api/v1/tv/matching/${jobId}`, headers: { cookie } });
  const conflict = listing.json().conflicts[0];
  assert.ok(conflict);
  const decision = await app.inject({
    method: "POST", url: `/api/v1/tv/matching/${jobId}/keep-existing`, headers: { cookie },
    payload: { action: "replace_existing", trackId: "1",
      updatedAt: repositories.tvMatchingTasks.get(jobId).updatedAt, expectedConflict: conflict }
  });
  assert.equal(decision.statusCode, 200, decision.body);
  assert.equal(decision.json().remainingConflicts, 0);
  const jobs = new JobCoordinator(repositories, { publish() {} }, {
    begin() {}, end() {}, register() {}, cancel() { return false; }, wasCancelled() { return false; }
  });
  const tvWorkflow = {
    async prepare() {
      return { analysis: { items: [{ itemId: "1", kind: "episode-candidate", title: "New", durationSeconds: 1300 }] },
        matches: { items: [] }, metadataLookups: [], identification: { queries: [], failures: [] } };
    }
  };
  const workflow = new DvdWorkflow(tvWorkflow, undefined,
    async (_input, target, _title, _settings, onPublishing, onProgress) => {
      await writeFile(target, Buffer.alloc(2048, 3));
      onPublishing({ name: "Test", codec: "libx264", hardware: false });
      onProgress(1);
      return { encoder: { name: "Test", codec: "libx264", hardware: false }, outputBytes: 2048 };
    }, async (directory) => { await mkdir(directory, { recursive: true }); }, jobs);
  await workflow.continueTvMatching(jobId);
  assert.equal((await readFile(original))[0], 3);
  assert.equal((await readFile(source))[0], 2);
  assert.equal(repositories.tvEpisodePublications.listForSeason(1)[0].fingerprint, "new");
  assert.equal(repositories.history.get(jobId).status, "completed");
  assert.equal(repositories.tvMatchingTasks.get(jobId).status, "completed");
  assert.equal(repositories.reviewItems.list({ status: "active" }).filter((review) => review.relatedJobId === jobId).length, 0);
  assert.equal(db.prepare("SELECT state FROM tv_replacement_transactions WHERE job_id = ?").get(jobId).state, "completed");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tv_replacement_claims").get().count, 0);

  const coordinatorUrl = new URL("../dist/application/job-coordinator.js", import.meta.url).href;
  const workflowUrl = new URL("../dist/providers/workflows/dvd.js", import.meta.url).href;
  const connectionUrl = new URL("../dist/infrastructure/database/connection.js", import.meta.url).href;
  const factoryUrl = new URL("../dist/infrastructure/database/repositories.js", import.meta.url).href;
  const defaultsUrl = new URL("../dist/infrastructure/database/default-settings.js", import.meta.url).href;
  const childScript = `
    import { writeFile, mkdir } from "node:fs/promises";
    import { openSqliteDatabase } from ${JSON.stringify(connectionUrl)};
    import { createSqliteRepositories } from ${JSON.stringify(factoryUrl)};
    import { defaultSettings } from ${JSON.stringify(defaultsUrl)};
    import { JobCoordinator } from ${JSON.stringify(coordinatorUrl)};
    import { DvdWorkflow } from ${JSON.stringify(workflowUrl)};
    const repositories = createSqliteRepositories(openSqliteDatabase(process.argv[1]), defaultSettings);
    const journal = repositories.tvConflictJournal;
    const transition = journal.transitionTransaction.bind(journal);
    journal.transitionTransaction = (id, from, to, evidence) => {
      if (process.argv[3] === "after-publication" && to === "published") process.kill(process.pid, "SIGKILL");
      transition(id, from, to, evidence);
      if (process.argv[3] === "before-publication" && to === "quarantined") process.kill(process.pid, "SIGKILL");
    };
    if (process.argv[3] === "before-completion") {
      journal.completeReplacementTransaction = () => process.kill(process.pid, "SIGKILL");
    } else if (process.argv[3] === "after-completion") {
      const complete = journal.completeReplacementTransaction.bind(journal);
      journal.completeReplacementTransaction = (id, audit) => {
        complete(id, audit);
        process.kill(process.pid, "SIGKILL");
      };
    }
    const jobs = new JobCoordinator(repositories, { publish() {} },
      { begin() {}, end() {}, register() {}, cancel() { return false; }, wasCancelled() { return false; } });
    const tv = { async prepare() { return {
      analysis: { items: [{ itemId: "1", kind: "episode-candidate", title: "New", durationSeconds: 1300 }] },
      matches: { items: [] }, metadataLookups: [], identification: { queries: [], failures: [] }
    }; } };
    const workflow = new DvdWorkflow(tv, undefined,
      async (_input, target, _title, _settings, publishing, progress) => {
        await writeFile(target, Buffer.alloc(2048, 3));
        publishing({ name: "Test", codec: "libx264", hardware: false }); progress(1);
        return { encoder: { name: "Test", codec: "libx264", hardware: false }, outputBytes: 2048 };
      }, async (directory) => mkdir(directory, { recursive: true }), jobs);
    await workflow.continueTvMatching(process.argv[2]);
  `;
  const { migrateDatabase } = await import("../dist/infrastructure/database/migrations.js");
  const { recoverTemporaryFiles } = await import("../dist/recovery.js");
  for (const [index, boundary] of ["before-publication", "after-publication", "before-completion", "after-completion"].entries()) {
    const id = `30000000-0000-4000-8000-00000000000${index}`;
    const fingerprint = `restart-${index}`;
    const episodeNumber = 8 + index;
    const oldPath = join(library, `existing-${index}.mkv`);
    const taskStaging = join(stagingRoot, id);
    await mkdir(taskStaging);
    await writeFile(join(taskStaging, "source.mkv"), Buffer.alloc(2048, 2));
    await writeFile(oldPath, Buffer.alloc(2048, 1));
    repositories.tvEpisodePublications.record([{
      outputPath: oldPath, fingerprint: `old-${index}`, discLabel: "Disc 1", discNumber: 1,
      trackId: "7", trackTitle: "Old", seriesName: "Example", metadataProvider: "tvdb",
      providerId: "123", seasonNumber: 1, episodeNumber, confirmedAt: "2026-01-01", publishedAt: "2026-01-02"
    }]);
    repositories.jobs.add(id, "Disc 2", fingerprint, "dvd");
    repositories.jobs.finish(id, "review", "Awaiting matching");
    repositories.reviewItems.create({ category: "tv_review", severity: "medium", title: "TV review",
      description: "Match episodes", relatedJobId: id, discFingerprint: fingerprint, suggestedActions: [] });
    repositories.discRecovery.recordDetection(fingerprint, "dvd", "tv_series");
    repositories.discRecovery.update(fingerprint, { metadataProvider: "tvdb", providerId: "123",
      seriesName: "Example", seasonNumber: 1, discNumber: 2, identifiedBy: "user" });
    repositories.tvMatchingTasks.create({
      jobId: id, fingerprint, status: "awaiting-mapping", stagingPath: taskStaging,
      source: { sourceId: "dvd", providerId: "dvd", mediaKind: "dvd", label: "Disc 2",
        manifest: { mediaKind: "dvd", items: [item] } },
      diagnostics: {}, files: { "1": "source.mkv" },
      assignments: [{ ...assignment, selectedEpisodes: [{ seriesId: "123", seasonNumber: 1, episodeNumber }] }]
    });
    const detail = await app.inject({ method: "GET", url: `/api/v1/tv/matching/${id}`, headers: { cookie } });
    const choice = await app.inject({
      method: "POST", url: `/api/v1/tv/matching/${id}/keep-existing`, headers: { cookie },
      payload: { action: "replace_existing", trackId: "1", updatedAt: repositories.tvMatchingTasks.get(id).updatedAt,
        expectedConflict: detail.json().conflicts[0] }
    });
    assert.equal(choice.statusCode, 200, choice.body);
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", childScript,
      join(root, "state.sqlite"), id, boundary]);
    assert.equal(child.signal, "SIGKILL", child.stderr.toString());
    migrateDatabase(db, defaultSettings);
    await recoverTemporaryFiles(repositories);
    await recoverTemporaryFiles(repositories);
    const transaction = db.prepare("SELECT state, quarantine_path AS quarantinePath FROM tv_replacement_transactions WHERE job_id = ?").get(id);
    const completed = boundary !== "before-publication";
    assert.equal(transaction.state, completed ? "completed" : "rolled_back");
    assert.equal((await readFile(oldPath))[0], completed ? 3 : 1);
    assert.equal((await readFile(transaction.quarantinePath))[0], 1);
    assert.equal((await readFile(join(taskStaging, "source.mkv")))[0], 2);
    assert.equal(repositories.tvEpisodePublications.listForSeason(1).find((entry) =>
      entry.episodeNumber === episodeNumber).fingerprint, completed ? fingerprint : `old-${index}`);
    assert.equal(repositories.history.get(id).status, completed ? "completed" : "failed");
    assert.equal(repositories.tvMatchingTasks.get(id).status, completed ? "completed" : "processing");
    if (completed) {
      assert.equal(repositories.reviewItems.list({ status: "active" }).filter((review) => review.relatedJobId === id).length, 0);
    } else {
      workflow.recoverInterruptedTvMatchingTasks();
      assert.equal(repositories.tvMatchingTasks.get(id).status, "awaiting-mapping");
      await workflow.continueTvMatching(id);
      assert.equal(repositories.history.get(id).status, "completed");
      assert.equal((await readFile(oldPath))[0], 3);
    }
  }
});
