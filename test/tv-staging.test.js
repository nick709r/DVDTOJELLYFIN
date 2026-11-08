import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import test from "node:test";
import { createHash } from "node:crypto";
import { JobCoordinator } from "../dist/application/job-coordinator.js";
import { defaultSettings } from "../dist/infrastructure/database/default-settings.js";
import { migrateDatabase } from "../dist/infrastructure/database/migrations.js";
import { createSqliteRepositories } from "../dist/infrastructure/database/repositories.js";
import { DvdWorkflow } from "../dist/providers/workflows/dvd.js";
import { recoverTemporaryFiles } from "../dist/recovery.js";
import { findTvEpisodeConflicts } from "../dist/application/tv-episode-conflicts.js";
import { tvEpisodeOutput } from "../dist/application/tv-episode-output.js";
import { keepExistingConflicts, keepExistingMapping } from "../dist/application/tv-keep-existing.js";

test("unknown TV discs stage, resume without reacquiring the disc, and delete only staging", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autodisc-tv-staging-"));
  const database = new Database(":memory:");
  migrateDatabase(database, defaultSettings);
  const outputDestinations = {
    ...defaultSettings.outputDestinations,
    profiles: defaultSettings.outputDestinations.profiles.map((profile) =>
      profile.id === defaultSettings.outputDestinations.activeProfileId
        ? {
          ...profile,
          jellyfin: {
            ...profile.jellyfin,
            paths: { ...profile.jellyfin.paths, tv: path.join(root, "published-tv") }
          }
        }
        : profile)
  };
  const repositories = createSqliteRepositories(database, {
    ...defaultSettings,
    workDir: path.join(root, "work"),
    tvStagingDir: path.join(root, "dedicated-tv-staging"),
    tvStagingRetentionDays: 1,
    tvRootDir: path.join(root, "published-tv"),
    moviesDir: path.join(root, "published-movies"),
    musicDir: path.join(root, "published-music"),
    outputDestinations
  });
  repositories.settings.save({
    workDir: path.join(root, "work"),
    tvStagingDir: path.join(root, "dedicated-tv-staging"),
    tvRootDir: path.join(root, "published-tv"),
    moviesDir: path.join(root, "published-movies"),
    musicDir: path.join(root, "published-music"),
    outputDestinations
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
    hasCompletedTvHistory: () => false,
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
  let conversions = 0;
  const workflow = new DvdWorkflow(tvWorkflow, undefined, async (_input, target, _title, _settings, onPublishing, onProgress) => {
    conversions += 1;
    await writeFile(target, Buffer.alloc(2048, 11));
    onPublishing({ name: "Test encoder", codec: "libx264", hardware: false });
    onProgress(1);
    return { encoder: { name: "Test encoder", codec: "libx264", hardware: false }, outputBytes: 2048 };
  }, async (directory) => {
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
    let task = jobs.listTvMatchingTasks()[0];
    assert.ok(task);
    assert.equal(task.status, "awaiting-identification");
    assert.equal(task.stagingPath, path.join(root, "dedicated-tv-staging", task.jobId));
    assert.equal(Object.keys(task.files).length, 4);
    assert.equal(jobs.getJob(task.jobId).status, "review");
    const stagedFile = path.join(task.stagingPath, task.files["1"]);
    assert.equal((await stat(stagedFile)).size, 2048);
    assert.match(await readFile(path.join(task.stagingPath, "metadata.json"), "utf8"), /episodeCount/);
    database.prepare("UPDATE tv_matching_tasks SET created_at = ? WHERE job_id = ?")
      .run("2000-01-01T00:00:00.000Z", task.jobId);
    await workflow.pruneExpiredTvMatchingTasks();
    assert.equal((await stat(stagedFile)).size, 2048, "legacy retention settings must not delete unmatched media");
    const orphanId = "10000000-0000-4000-8000-000000000001";
    const orphanPath = path.join(root, "dedicated-tv-staging", orphanId);
    await mkdir(orphanPath, { recursive: true });
    await writeFile(path.join(orphanPath, "recovered-track.mkv"), Buffer.alloc(2048));
    await workflow.recoverOrphanedTvStagingDirectories();
    assert.equal((await stat(path.join(orphanPath, "recovered-track.mkv"))).size, 2048);

    repositories.tvMatchingTasks.update(task.jobId, { status: "processing" });
    repositories.jobs.setStatus(task.jobId, "converting", "Matching episodes");
    migrateDatabase(database, defaultSettings);
    await recoverTemporaryFiles(repositories);
    workflow.recoverInterruptedTvMatchingTasks();
    task = jobs.getTvMatchingTask(task.jobId);
    assert.equal(jobs.getJob(task.jobId).status, "failed");
    assert.equal(task.status, "awaiting-identification");
    assert.equal(repositories.reviewItems.list({ category: "tv_review", status: "active" }).length, 1);

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
    task = jobs.getTvMatchingTask(task.jobId);
    assert.equal(acquisitions, 4);
    assert.equal(jobs.getTvMatchingTask(task.jobId).status, "awaiting-mapping");
    assert.equal(jobs.getJob(task.jobId).status, "review");
    assert.equal(jobs.getTvMatchingTask(task.jobId).assignments.length, 4);
    const assignments = task.assignments.map((assignment, index) => ({
      ...assignment,
      confirmed: true,
      confirmedAt: "2026-01-01T00:00:00.000Z",
      selectedEpisodes: [{
        seriesId: "292941",
        seasonNumber: 3,
        episodeNumber: index + 1
      }]
    }));
    repositories.tvMatchingTasks.update(task.jobId, { assignments, status: "ready-to-publish" });
    const mappings = assignments.map((assignment) => ({
      trackId: assignment.trackId,
      episodes: [...assignment.selectedEpisodes]
    }));
    repositories.discRecovery.update(task.fingerprint, { mappings });
    await workflow.continueTvMatching(task.jobId, "continue-action");
    task = jobs.getTvMatchingTask(task.jobId);
    assert.equal(acquisitions, 4);
    assert.equal(conversions, 4);
    assert.equal(task.status, "completed");
    assert.equal(jobs.getJob(task.jobId).status, "completed");
    const publications = repositories.tvEpisodePublications.listForSeason(3);
    assert.equal(publications.length, 4);
    assert.equal(publications.find((item) => item.episodeNumber === 1).trackId, "1");
    assert.equal(publications.find((item) => item.episodeNumber === 1).confirmedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(publications.find((item) => item.episodeNumber === 1).fingerprint, task.fingerprint);
    const secondJobId = "20000000-0000-4000-8000-000000000002";
    const secondFingerprint = "second-disc";
    const secondStaging = path.join(root, "dedicated-tv-staging", secondJobId);
    await mkdir(secondStaging, { recursive: true });
    await writeFile(path.join(secondStaging, "title-1.mkv"), Buffer.alloc(2048, 3));
    repositories.jobs.add(secondJobId, "Disc 2", secondFingerprint, "dvd");
    repositories.jobs.finish(secondJobId, "review", "Awaiting episode matching");
    repositories.discRecovery.recordDetection(secondFingerprint, "dvd", "tv_series");
    repositories.discRecovery.update(secondFingerprint, {
      metadataProvider: "tvdb", providerId: "292941", seriesName: "Fresh Off The Boat",
      seasonNumber: 3, discNumber: 2, identifiedBy: "user"
    });
    repositories.tvMatchingTasks.create({
      jobId: secondJobId, fingerprint: secondFingerprint, status: "ready-to-publish",
      stagingPath: secondStaging, source: { ...task.source, label: "Disc 2" }, diagnostics: {},
      files: { "1": "title-1.mkv" }, assignments: [assignments[0]]
    });
    await assert.rejects(workflow.continueTvMatching(secondJobId), /Episode conflict: Season 3 Episode 1/);
    assert.equal(conversions, 4, "a conflict must not start conversion");
    const firstEpisode = publications.find((item) => item.episodeNumber === 1);
    assert.equal((await readFile(firstEpisode.outputPath))[0], 11, "existing media must remain unchanged");
    assert.equal((await stat(path.join(secondStaging, "title-1.mkv"))).size, 2048);
    assert.equal(repositories.tvMatchingTasks.get(secondJobId).status, "awaiting-mapping");
    const secondTask = repositories.tvMatchingTasks.get(secondJobId);
    const secondRecovery = repositories.discRecovery.get(secondFingerprint);
    const secondConflicts = await findTvEpisodeConflicts(repositories.tvEpisodePublications, secondRecovery,
      secondRecovery.mappings, {
        targetPath: (mapping) => tvEpisodeOutput(repositories.settings.get(), secondRecovery, mapping).targetPath,
        legacyHistory: (season) => repositories.completedTvDiscHistory.listForSeason(season),
        jobOutputPath: (id) => repositories.history.get(id)?.outputPath ?? null
      });
    const decision = {
      mapping: keepExistingMapping(secondRecovery, secondTask.assignments[0]),
      conflicts: await keepExistingConflicts(secondConflicts)
    };
    repositories.tvMatchingTasks.update(secondJobId, {
      assignments: [{ ...secondTask.assignments[0], keepExisting: decision }]
    });
    await writeFile(firstEpisode.outputPath, Buffer.alloc(2048, 12));
    await assert.rejects(workflow.continueTvMatching(secondJobId), /conflict decision no longer matches/);
    assert.equal((await readFile(path.join(secondStaging, "title-1.mkv")))[0], 3);
    await writeFile(firstEpisode.outputPath, Buffer.alloc(2048, 11));
    await workflow.continueTvMatching(secondJobId);
    assert.equal(jobs.getJob(secondJobId).status, "completed");
    assert.equal(jobs.getTvMatchingTask(secondJobId).status, "completed");
    assert.equal(conversions, 4, "Keep Existing does not convert the dismissed title");
    assert.equal((await readFile(firstEpisode.outputPath))[0], 11);
    assert.equal((await readFile(path.join(secondStaging, "title-1.mkv")))[0], 3);
    assert.deepEqual(repositories.discRecovery.get(secondFingerprint).mappings, []);
    const mixedJobId = "30000000-0000-4000-8000-000000000003";
    const mixedFingerprint = "mixed-disc";
    const mixedStaging = path.join(root, "dedicated-tv-staging", mixedJobId);
    await mkdir(mixedStaging, { recursive: true });
    await writeFile(path.join(mixedStaging, "title-1.mkv"), Buffer.alloc(2048, 4));
    await writeFile(path.join(mixedStaging, "title-2.mkv"), Buffer.alloc(2048, 5));
    repositories.jobs.add(mixedJobId, "Disc 3", mixedFingerprint, "dvd");
    repositories.jobs.finish(mixedJobId, "review", "Awaiting matching");
    repositories.discRecovery.recordDetection(mixedFingerprint, "dvd", "tv_series");
    const mixedRecovery = repositories.discRecovery.update(mixedFingerprint, {
      metadataProvider: "tvdb", providerId: "292941", seriesName: "Fresh Off The Boat",
      seasonNumber: 3, discNumber: 3, identifiedBy: "user"
    });
    const mixedAssignments = [
      assignments[0],
      { ...assignments[1], selectedEpisodes: [{ seriesId: "292941", seasonNumber: 3, episodeNumber: 5 }] }
    ];
    const mixedMappings = mixedAssignments.map((assignment) => ({
      trackId: assignment.trackId, episodes: assignment.selectedEpisodes
    }));
    const mixedConflicts = await findTvEpisodeConflicts(repositories.tvEpisodePublications, mixedRecovery,
      mixedMappings, {
        targetPath: (mapping) => tvEpisodeOutput(repositories.settings.get(), mixedRecovery, mapping).targetPath,
        legacyHistory: (season) => repositories.completedTvDiscHistory.listForSeason(season),
        jobOutputPath: (id) => repositories.history.get(id)?.outputPath ?? null
      });
    assert.equal(mixedConflicts.length, 1);
    const mixedDecision = {
      mapping: keepExistingMapping(mixedRecovery, mixedAssignments[0]),
      conflicts: await keepExistingConflicts(mixedConflicts)
    };
    repositories.tvMatchingTasks.create({
      jobId: mixedJobId, fingerprint: mixedFingerprint, status: "awaiting-mapping",
      stagingPath: mixedStaging, source: { ...task.source, label: "Disc 3" }, diagnostics: {},
      files: { "1": "title-1.mkv", "2": "title-2.mkv" },
      assignments: [{ ...mixedAssignments[0], keepExisting: mixedDecision }, mixedAssignments[1]]
    });
    await workflow.continueTvMatching(mixedJobId);
    assert.equal(jobs.getJob(mixedJobId).status, "completed");
    assert.equal(conversions, 5, "non-conflicting titles still publish");
    assert.deepEqual(repositories.discRecovery.get(mixedFingerprint).mappings.map((mapping) => mapping.trackId), ["2"]);
    assert.equal(repositories.tvEpisodePublications.listForSeason(3).find((item) =>
      item.fingerprint === mixedFingerprint).episodeNumber, 5);
    assert.equal((await readFile(path.join(mixedStaging, "title-1.mkv")))[0], 4);
    assert.equal((await readFile(path.join(mixedStaging, "title-2.mkv")))[0], 5);
    assert.equal((await readFile(firstEpisode.outputPath))[0], 11);
    for (const [action, suffix] of [["mark_as_extras", "4"], ["keep_both", "5"]]) {
      const jobId = `${suffix}0000000-0000-4000-8000-00000000000${suffix}`;
      const fingerprint = `decision-disc-${suffix}`;
      const staging = path.join(root, "dedicated-tv-staging", jobId);
      await mkdir(staging, { recursive: true });
      await writeFile(path.join(staging, "title-1.mkv"), Buffer.alloc(2048, Number(suffix)));
      repositories.jobs.add(jobId, `Disc ${suffix}`, fingerprint, "dvd");
      repositories.jobs.finish(jobId, "review", "Awaiting matching");
      repositories.discRecovery.recordDetection(fingerprint, "dvd", "tv_series");
      const disc = repositories.discRecovery.update(fingerprint, {
        metadataProvider: "tvdb", providerId: "292941", seriesName: "Fresh Off The Boat",
        seasonNumber: 3, discNumber: Number(suffix), identifiedBy: "user"
      });
      const assignment = action === "keep_both"
        ? { ...assignments[0], selectedEpisodes: [...assignments[0].selectedEpisodes,
          { seriesId: "292941", seasonNumber: 3, episodeNumber: 6 }] }
        : assignments[0];
      const mapping = { trackId: "1", episodes: assignment.selectedEpisodes };
      const found = await findTvEpisodeConflicts(repositories.tvEpisodePublications, disc, [mapping], {
        targetPath: (item) => tvEpisodeOutput(repositories.settings.get(), disc, item).targetPath,
        legacyHistory: (season) => repositories.completedTvDiscHistory.listForSeason(season),
        jobOutputPath: (id) => repositories.history.get(id)?.outputPath ?? null
      });
      assert.equal(found.length, 1);
      const choice = { action, mapping: keepExistingMapping(disc, assignment),
        conflicts: await keepExistingConflicts(found) };
      repositories.tvMatchingTasks.create({
        jobId, fingerprint, status: "awaiting-mapping", stagingPath: staging,
        source: { ...task.source, label: `Disc ${suffix}` }, diagnostics: {},
        files: { "1": "title-1.mkv" }, assignments: [{ ...assignment, keepExisting: choice }]
      });
      repositories.tvConflictJournal.appendAudit({
        id: `audit-${suffix}`, jobId, at: "2026-01-01T00:00:00.000Z", action,
        seasonNumber: 3, episodeNumber: 1, incoming: { fingerprint, discLabel: `Disc ${suffix}`,
          trackId: "1", trackTitle: "Episode 1", confirmedAt: assignment.confirmedAt },
        existing: found[0].existing, provenanceStatus: found[0].provenanceStatus,
        decisionBy: "admin", details: { disposition: "decision recorded" }
      });
      if (action === "keep_both") {
        const output = tvEpisodeOutput(repositories.settings.get(), disc, mapping);
        const tag = createHash("sha256").update(jobId).update("\0").update("1").digest("hex").slice(0, 12);
        const occupied = path.join(output.seasonDir, `${output.baseName} [alternate-${tag}].${repositories.settings.get().format}`);
        await writeFile(occupied, Buffer.alloc(2048, 77));
        await assert.rejects(workflow.continueTvMatching(jobId), /conflict decision no longer matches/);
        assert.equal((await readFile(occupied))[0], 77, "an occupied alternate must never be overwritten");
        assert.equal((await readFile(firstEpisode.outputPath))[0], 11);
        assert.equal((await readFile(path.join(staging, "title-1.mkv")))[0], Number(suffix));
        await rm(occupied);
        const failingWorkflow = new DvdWorkflow(tvWorkflow, undefined, async () => {
          throw new Error("Injected conversion failure");
        }, async (directory) => mkdir(directory, { recursive: true }), jobs);
        await assert.rejects(failingWorkflow.continueTvMatching(jobId), /Injected conversion failure/);
        assert.equal((await readFile(firstEpisode.outputPath))[0], 11);
        assert.equal((await readFile(path.join(staging, "title-1.mkv")))[0], Number(suffix));
      }
      await workflow.continueTvMatching(jobId);
      assert.equal(jobs.getJob(jobId).status, "completed");
      assert.equal((await readFile(path.join(staging, "title-1.mkv")))[0], Number(suffix));
      assert.equal((await readFile(firstEpisode.outputPath))[0], 11);
      const audit = repositories.tvConflictJournal.listAuditForJob(jobId);
      if (action === "mark_as_extras") {
        assert.deepEqual(repositories.discRecovery.get(fingerprint).mappings, []);
        const published = audit.find((entry) => entry.details.disposition === "extra published");
        assert.ok(published);
        assert.equal(path.basename(path.dirname(published.details.outputPath)), "Extras");
        assert.equal((await readFile(published.details.outputPath))[0], 11);
        assert.equal(repositories.tvEpisodePublications.listForSeason(3).some((entry) =>
          entry.fingerprint === fingerprint), false);
      } else {
        const published = repositories.tvEpisodePublications.listForSeason(3).find((entry) =>
          entry.fingerprint === fingerprint);
        assert.ok(published);
        assert.match(path.basename(published.outputPath), /\[alternate-[a-f0-9]{12}\]/);
        assert.equal((await readFile(published.outputPath))[0], 11);
        assert.deepEqual(repositories.tvEpisodePublications.listForSeason(3)
          .filter((entry) => entry.fingerprint === fingerprint)
          .map((entry) => entry.episodeNumber).sort((a, b) => a - b), [1, 6]);
      }
    }
    const publishedEpisode = jobs.getJob(task.jobId).outputPath;
    assert.ok(publishedEpisode);
    const publishedRoot = path.join(root, "published-tv");
    const libraryInfo = await stat(publishedRoot);
    const seriesInfo = await stat(path.dirname(path.dirname(publishedEpisode)));
    const episodeInfo = await stat(publishedEpisode);
    if (process.platform !== "win32") {
      assert.equal(seriesInfo.gid, libraryInfo.gid);
      assert.equal(episodeInfo.gid, libraryInfo.gid);
      assert.equal(seriesInfo.mode & 0o777, 0o775);
      assert.equal(episodeInfo.mode & 0o777, 0o664);
      assert.equal(seriesInfo.mode & 0o002, 0);
      assert.equal(episodeInfo.mode & 0o002, 0);
    }
    const timeline = repositories.history.timeline(task.jobId);
    const lastResumeIndex = timeline.map((event) =>
      event.message === "Resuming from preserved extracted media").lastIndexOf(true);
    const continuationStates = timeline.slice(lastResumeIndex)
      .filter((event) => ["ripping", "converting", "publishing", "completed"].includes(event.stage))
      .map((event) => event.stage);
    assert.deepEqual(continuationStates, [
      "converting", "converting", "publishing", "publishing", "publishing", "publishing", "completed"
    ]);
    await workflow.removeTvMatchingTask(task.jobId);
    await assert.rejects(stat(task.stagingPath), { code: "ENOENT" });
    assert.equal(jobs.getTvMatchingTask(task.jobId), undefined);
    assert.equal(database.prepare("SELECT status FROM jobs WHERE id = ?").get(task.jobId).status, "deleted");
    assert.equal((await readdir(path.join(root, "published-tv"))).length, 1);
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
    repositories.jobs.add("decision-tv-job", "TV disc", "decision-tv-fingerprint", "dvd");
    repositories.jobs.setStatus("decision-tv-job", "converting", "Publishing conflict decision");
    repositories.discRecovery.recordDetection("decision-tv-fingerprint", "dvd", "tv_series");
    repositories.discRecovery.update("decision-tv-fingerprint", {
      seriesName: "Example", seasonNumber: 1
    });
    repositories.tvMatchingTasks.create({
      jobId: "decision-tv-job", fingerprint: "decision-tv-fingerprint", status: "processing",
      stagingPath: path.join(root, "staging", "decision-tv-job"),
      source: { sourceId: "dvd0", providerId: "dvd", mediaKind: "dvd", label: "TV disc",
        manifest: { mediaKind: "dvd", items: [] } },
      diagnostics: {}, files: { "1": "episode01.mkv" },
      assignments: [{ trackId: "1", title: "Episode 1", durationSeconds: 1000, episodeCandidates: [],
        confirmed: true, selectedEpisodes: [{ seriesId: "Example", seasonNumber: 1, episodeNumber: 1 }],
        keepExisting: { action: "keep_both", mapping: "mapping", conflicts: "snapshot" } }]
    });
    new DvdWorkflow(undefined, undefined, undefined, async () => {}, jobs).recoverInterruptedTvMatchingTasks();
    assert.equal(repositories.tvMatchingTasks.get("decision-tv-job").status, "awaiting-mapping",
      "interrupted conflict publication must not automatically resume");
    assert.equal(repositories.history.get("decision-tv-job").status, "interrupted");
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
