import assert from "node:assert/strict";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("settings endpoint redacts secrets and enforces configured admin authentication", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autodisc-test-"));
  const linuxRoot = root.replace(/^[A-Za-z]:/, "").replace(/\\/g, "/");
  process.env.DATABASE_PATH = path.join(root, "state.sqlite");
  process.env.MOVIES_DIR = root;
  process.env.WORK_DIR = root;

  const server = await import("../dist/server.js");
  const { app } = server;
  const { db } = await import("../dist/db.js");
  const jobs = await import("../dist/db.js");
  const jobControl = await import("../dist/job-control.js");
  const manualMetadata = await import("../dist/manual-music-metadata.js");
  let sessionCookie = "";
  const originalInject = app.inject.bind(app);
  app.inject = async (options) => {
    const response = await originalInject({
      ...options,
      headers: { ...(sessionCookie ? { cookie: sessionCookie } : {}), ...(options.headers || {}) }
    });
    const setCookie = response.headers["set-cookie"];
    if (typeof setCookie === "string") sessionCookie = setCookie.split(";")[0];
    return response;
  };
  try {
    const home = await app.inject({ method: "GET", url: "/" });
    assert.equal(home.statusCode, 302);
    assert.equal(home.headers.location, "/setup");
    const setupPage = await app.inject({ method: "GET", url: "/setup" });
    assert.equal(setupPage.statusCode, 200);
    assert.match(setupPage.body, /Create administrator account/);
    assert.match(setupPage.body, /Confirm password/);
    assert.match(setupPage.body, /setup-account-step/);
    assert.match(setupPage.body, /setup-confirm-step/);
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/setup/status" })).json().setupComplete, false);

    const blockedSettings = await app.inject({ method: "GET", url: "/api/v1/settings" });
    assert.equal(blockedSettings.statusCode, 503);
    assert.equal(blockedSettings.json().setupRequired, true);
    const blockedDashboard = await app.inject({ method: "GET", url: "/api/v1/dashboard" });
    assert.equal(blockedDashboard.statusCode, 503);
    const invalidSetup = await app.inject({
      method: "POST",
      url: "/api/v1/setup",
      payload: { username: "admin", password: "VeryStrongPassword123!", confirmPassword: "different" }
    });
    assert.equal(invalidSetup.statusCode, 400);
    const setup = await app.inject({
      method: "POST",
      url: "/api/v1/setup",
      payload: { username: "admin", password: "VeryStrongPassword123!", confirmPassword: "VeryStrongPassword123!" }
    });
    assert.equal(setup.statusCode, 201);
    assert.equal(setup.json().setupComplete, true);
    const setupState = db.prepare("SELECT setup_complete, admin_username, admin_password_hash FROM setup_state WHERE id = 1").get();
    assert.equal(setupState.setup_complete, 1);
    assert.equal(setupState.admin_username, "admin");
    assert.notEqual(setupState.admin_password_hash, "VeryStrongPassword123!");
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/setup", payload: {} })).statusCode, 401);
    const homeAfterSetup = await app.inject({ method: "GET", url: "/" });
    assert.equal(homeAfterSetup.statusCode, 200);
    assert.match(homeAfterSetup.body, /Disc Diagnostics/);
    assert.match(homeAfterSetup.body, /library-settings-health/);
    assert.match(homeAfterSetup.body, /classification-form/);
    const unauthenticatedSettings = await app.inject({ method: "GET", url: "/api/v1/settings" });
    assert.equal(unauthenticatedSettings.statusCode, 401);
    const unauthenticatedDirectoryBrowse = await app.inject({ method: "GET", url: "/api/v1/directories?path=/" });
    assert.equal(unauthenticatedDirectoryBrowse.statusCode, 401);
    const initialLogin = await app.inject({
      method: "POST",
      url: "/api/v1/login",
      payload: { username: "admin", password: "VeryStrongPassword123!" }
    });
    assert.equal(initialLogin.statusCode, 200);
    const setupRerun = await app.inject({
      method: "POST",
      url: "/api/v1/setup",
      payload: { username: "admin", password: "AnotherStrongPassword123!", confirmPassword: "AnotherStrongPassword123!" }
    });
    assert.equal(setupRerun.statusCode, 409);

    const initial = await app.inject({ method: "GET", url: "/api/v1/settings" });
    assert.equal(initial.statusCode, 200);
    assert.equal(initial.json().settings.adminPasswordConfigured, true);
    assert.equal(initial.json().settings.musicMetadataEnabled, false);
    assert.equal(initial.json().settings.lidarrEnabled, false);
    assert.equal(initial.json().settings.tvDetectionEnabled, true);
    assert.equal(initial.json().settings.tvStagingRetentionDays, null);
    assert.equal(initial.json().settings.tvRootDir, "/srv/jellyfin/TV");
    assert.equal(initial.json().settings.tvValidationLoggingEnabled, true);
    assert.equal(initial.json().settings.musicBrainzContactEmail, "");
    assert.equal(initial.json().settings.libraryMetadata.automaticImport, true);
    assert.equal(initial.json().settings.libraryMetadata.generateNfo, true);
    assert.equal(initial.json().settings.libraryMetadata.libraryStructure, "jellyfin");
    assert.equal("adminPasswordHash" in initial.json().settings, false);
    assert.equal("lidarrApiKey" in initial.json().settings, false);
    assert.equal(typeof initial.json().settings.outputDestinations.activeProfileId, "string");
    assert.equal(initial.json().settings.automationMode, "regular_auto");
    const emptyDiagnostics = await app.inject({ method: "GET", url: "/api/v1/diagnostics" });
    assert.equal(emptyDiagnostics.statusCode, 200);
    assert.equal(emptyDiagnostics.json().job, null);
    assert.deepEqual(emptyDiagnostics.json().timeline, []);

    const pathCheck = await app.inject({
      method: "POST",
      url: "/api/v1/paths/check",
      payload: {
        moviesDir: root,
        musicDir: root,
        tvRootDir: path.posix.join(linuxRoot, "tv-library"),
        workDir: root,
        opticalDevice: path.join(root, "missing-device"),
        lidarrImportDir: path.join(root, "lidarr-import"),
        lidarrEnabled: false
      }
    });
    assert.equal(pathCheck.statusCode, 200);
    assert.equal(pathCheck.json().ok, false);
    assert.equal(pathCheck.json().checks.length, 5);
    assert.deepEqual(pathCheck.json().checks.map((check) => check.name), [
      "Movies folder", "Music folder", "TV root folder", "Temporary work folder", "Optical drive"
    ]);
    const tvRootCheck = pathCheck.json().checks.find((check) => check.name === "TV root folder");
    assert.equal(tvRootCheck.ok, true);
    assert.equal(tvRootCheck.message, "Readable, searchable, and can create and remove files");
    assert.ok(tvRootCheck.availableBytes > 0);
    assert.equal((await readdir(root)).includes("tv-library"), true);
    assert.equal(pathCheck.json().checks.find((check) => check.name === "Optical drive").ok, false);
    assert.equal((await readdir(root)).some((name) => name.startsWith(".autodisc-permission-check-")), false);
    const directoryListing = await app.inject({
      method: "GET",
      url: `/api/v1/directories?path=${encodeURIComponent(linuxRoot)}`
    });
    assert.equal(directoryListing.statusCode, 200);
    assert.equal(directoryListing.json().path, linuxRoot);
    assert.ok(Array.isArray(directoryListing.json().directories));
    const lidarrPathCheck = await app.inject({
      method: "POST",
      url: "/api/v1/paths/check",
      payload: {
        moviesDir: root,
        musicDir: root,
        tvRootDir: path.posix.join(linuxRoot, "tv-library"),
        workDir: root,
        opticalDevice: path.join(root, "missing-device"),
        lidarrImportDir: root,
        lidarrEnabled: true
      }
    });
    assert.equal(lidarrPathCheck.statusCode, 200);
    assert.equal(lidarrPathCheck.json().checks.length, 6);
    assert.equal(
      lidarrPathCheck.json().checks.some((check) => check.name === "Lidarr downloads/import folder"),
      true
    );
    const invalidTvPath = path.posix.join(linuxRoot, "not-a-directory");
    await writeFile(path.join(root, "not-a-directory"), "not a directory");
    const invalidTvPathCheck = await app.inject({
      method: "POST",
      url: "/api/v1/paths/check",
      payload: {
        moviesDir: root,
        musicDir: root,
        tvRootDir: invalidTvPath,
        workDir: root,
        opticalDevice: path.join(root, "missing-device"),
        lidarrImportDir: root,
        lidarrEnabled: false
      }
    });
    assert.equal(invalidTvPathCheck.statusCode, 200);
    const invalidTvCheck = invalidTvPathCheck.json().checks.find((check) => check.name === "TV root folder");
    assert.equal(invalidTvCheck.ok, false);
    const tvPathReviews = await app.inject({
      method: "GET",
      url: "/api/v1/reviews?category=configuration_issue"
    });
    assert.equal(tvPathReviews.json().items.length, 1);
    assert.equal(tvPathReviews.json().items[0].requestedPath, invalidTvPath);
    assert.equal(tvPathReviews.json().items[0].errorDetails.path, invalidTvPath);
    assert.match(tvPathReviews.json().items[0].errorDetails.validationFailure, /exist|directory/i);
    assert.equal(tvPathReviews.json().items[0].suggestedActions.some((action) => action.type === "open-settings"), true);
    const invalidTvSettings = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      payload: { tvRootDir: invalidTvPath }
    });
    assert.equal(invalidTvSettings.statusCode, 400);
    jobs.saveSettings({ tvRootDir: invalidTvPath });
    const failedLibraryCreation = await app.inject({
      method: "POST",
      url: "/api/library/create",
      payload: { type: "tv" }
    });
    assert.equal(failedLibraryCreation.statusCode, 400);
    assert.equal(failedLibraryCreation.json().exists, false);
    assert.equal(failedLibraryCreation.json().writable, false);
    assert.match(failedLibraryCreation.json().error, /directory/i);
    jobs.saveSettings({ tvRootDir: "/srv/jellyfin/TV" });
    await app.inject({
      method: "POST",
      url: "/api/v1/paths/check",
      payload: {
        moviesDir: root,
        musicDir: root,
        tvRootDir: invalidTvPath,
        workDir: root,
        opticalDevice: path.join(root, "missing-device"),
        lidarrImportDir: root,
        lidarrEnabled: false
      }
    });
    const deduplicatedTvReviews = await app.inject({
      method: "GET",
      url: "/api/v1/reviews?category=configuration_issue"
    });
    assert.equal(deduplicatedTvReviews.json().items.length, 1);

    const lidarrWithoutKey = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      payload: { lidarrEnabled: true }
    });
    assert.equal(lidarrWithoutKey.statusCode, 400);

    jobs.addJob("active-job-one", "Disc One");
    assert.equal(jobs.activeJob().mediaType, "dvd");
    assert.throws(() => jobs.addJob("active-job-two", "Disc Two"));
    jobs.finishJob("active-job-one", "failed", "expected test failure");
    jobs.addJob("active-job-two", "Disc Two");
    jobs.updateJob("active-job-two", { conversionSeconds: 12 });
    jobs.finishJob("active-job-two", "completed", null, "test-disc-fingerprint");
    assert.equal(jobs.jobStats().total, 2);
    assert.equal(jobs.jobStats().successful, 1);
    assert.equal(jobs.jobStats().failures, 1);
    assert.equal(jobs.jobStats().averageSeconds, 12);
    assert.equal(jobs.lastDiscFingerprint(), "test-disc-fingerprint");
    jobs.clearInsertedDisc();
    assert.equal(jobs.lastDiscFingerprint(), null);
    jobs.addJob("music-job", "Audio CD test", "audio-disc-fingerprint", "audio_cd");
    jobs.finishJob("music-job", "completed", null, "audio-disc-fingerprint");
    assert.equal(jobs.listJobs(10).find((job) => job.id === "music-job").mediaType, "audio_cd");
    assert.equal(jobs.lastDiscFingerprint(), "audio-disc-fingerprint");

    jobs.addJob("active-history-entry", "Active disc");
    const activeDelete = await app.inject({ method: "DELETE", url: "/api/v1/history/active-history-entry" });
    assert.equal(activeDelete.statusCode, 409);
    jobs.finishJob("active-history-entry", "failed", "test cleanup");

    const cancelController = new AbortController();
    jobs.addJob("cancelled-job", "Disc to cancel");
    jobs.setJobStatus("cancelled-job", "converting", "Encoding disc");
    jobControl.beginDiscOperation(cancelController);
    jobControl.registerActiveJob("cancelled-job");
    const cancelResponse = await app.inject({ method: "POST", url: "/api/v1/jobs/cancelled-job/cancel" });
    assert.equal(cancelResponse.statusCode, 200);
    assert.equal(cancelController.signal.aborted, true);
    jobs.updateJob("cancelled-job", { outputPath: path.join(root, "finished-movie.mkv") });
    await writeFile(path.join(root, "finished-movie.mkv"), "finished media");
    jobs.finishJob("cancelled-job", "cancelled", "Cancelled by user");
    jobControl.endDiscOperation(cancelController);
    assert.equal(jobs.jobStats().total, 4);
    assert.equal(jobs.jobStats().successful, 2);
    assert.equal(jobs.jobStats().failures, 2);
    const deleteResponse = await app.inject({ method: "DELETE", url: "/api/v1/history/cancelled-job" });
    assert.equal(deleteResponse.statusCode, 200);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE id = ?").get("cancelled-job").count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM job_events WHERE job_id = ?").get("cancelled-job").count, 0);
    assert.equal(jobs.jobStats().total, 4);
    await access(path.join(root, "finished-movie.mkv"));
    const missingDelete = await app.inject({ method: "DELETE", url: "/api/v1/history/cancelled-job" });
    assert.equal(missingDelete.statusCode, 404);

    const setMusicSettings = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      payload: {
        musicMetadataEnabled: true,
        musicBrainzContactEmail: "music-admin@example.com",
        musicDir: path.posix.join(linuxRoot, "music-library"),
        tvRootDir: path.posix.join(linuxRoot, "saved-tv-library"),
        lidarrApiKey: "lidarr-test-secret",
        tvDetectionEnabled: false,
        tvStagingRetentionDays: 120,
        tvValidationLoggingEnabled: false
      }
    });
    assert.equal(setMusicSettings.statusCode, 200);
    assert.equal(setMusicSettings.json().settings.musicDir, path.posix.join(linuxRoot, "music-library"));
    assert.equal(setMusicSettings.json().settings.tvRootDir, path.posix.join(linuxRoot, "saved-tv-library"));
    assert.equal((await readdir(root)).includes("saved-tv-library"), true);
    assert.equal((await readdir(root)).includes("music-library"), true);
    assert.equal(setMusicSettings.json().settings.musicMetadataEnabled, true);
    assert.equal(setMusicSettings.json().settings.musicBrainzContactEmail, "music-admin@example.com");
    assert.equal(setMusicSettings.json().settings.tvDetectionEnabled, false);
    assert.equal(setMusicSettings.json().settings.tvStagingRetentionDays, 120);
    assert.equal(setMusicSettings.json().settings.tvValidationLoggingEnabled, false);
    assert.equal(setMusicSettings.json().settings.lidarrApiKeyConfigured, true);
    assert.equal("lidarrApiKey" in setMusicSettings.json().settings, false);
    const invalidTvRetention = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      payload: { tvStagingRetentionDays: 0 }
    });
    assert.equal(invalidTvRetention.statusCode, 400);
    const libraryMetadata = {
      ...setMusicSettings.json().settings.libraryMetadata,
      libraryStructure: "custom",
      movieFolderTemplate: "{Movie Title} ({Year}) {Unknown}"
    };
    const invalidLibraryMetadata = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      payload: { libraryMetadata }
    });
    assert.equal(invalidLibraryMetadata.statusCode, 400);
    libraryMetadata.movieFolderTemplate = "{Movie Title} ({Year})";
    libraryMetadata.downloadRatings = false;
    const setLibraryMetadata = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      payload: { libraryMetadata }
    });
    assert.equal(setLibraryMetadata.statusCode, 200);
    assert.equal(setLibraryMetadata.json().settings.libraryMetadata.libraryStructure, "custom");
    assert.equal(setLibraryMetadata.json().settings.libraryMetadata.downloadRatings, false);

    const libraryPath = path.posix.join(linuxRoot, "library-created-by-api");
    jobs.saveSettings({ tvRootDir: libraryPath });
    const createLibrary = await app.inject({
      method: "POST",
      url: "/api/library/create",
      payload: { type: "tv" }
    });
    assert.equal(createLibrary.statusCode, 200);
    assert.equal(createLibrary.json().ok, true);
    assert.equal(createLibrary.json().status.exists, true);
    assert.equal(createLibrary.json().status.writable, true);
    assert.equal((await readdir(root)).includes("library-created-by-api"), true);
    const libraryHealth = await app.inject({ method: "GET", url: "/api/library/health" });
    assert.equal(libraryHealth.statusCode, 200);
    assert.equal(libraryHealth.json().libraries.find((library) => library.type === "tv").exists, true);
    const invalidLibrary = await app.inject({
      method: "POST",
      url: "/api/library/create",
      payload: { type: "invalid" }
    });
    assert.equal(invalidLibrary.statusCode, 400);
    jobs.saveSettings({ tvRootDir: path.posix.join(linuxRoot, "saved-tv-library") });

    const setPassword = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      payload: { adminPassword: "NewStrongPassword123!", logLevel: "error" }
    });
    assert.equal(setPassword.statusCode, 200);
    assert.equal(setPassword.json().settings.logLevel, "error");

    const unauthorized = await app.inject({ method: "GET", url: "/api/v1/settings" });
    assert.equal(unauthorized.statusCode, 401);
    const unauthorizedReviews = await app.inject({ method: "GET", url: "/api/v1/reviews" });
    assert.equal(unauthorizedReviews.statusCode, 401);

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/login",
      payload: { username: "admin", password: "NewStrongPassword123!" }
    });
    assert.equal(login.statusCode, 200);
    const setCookie = login.headers["set-cookie"];
    assert.equal(typeof setCookie, "string");
    const cookie = setCookie.split(";")[0];

    const reviewRetryPath = path.join(root, "review-retry", "Music", "Artist", "Album");
    const reviewItem = jobs.repositories.reviewItems.create({
      category: "folder_creation_failure",
      severity: "high",
      title: "Could not create the Music destination folder",
      description: "Permission denied while creating the album folder",
      relatedDisc: "Audio CD test",
      discFingerprint: "review-api-disc",
      relatedDrive: jobs.getSettings().opticalDevice,
      requestedPath: reviewRetryPath,
      errorDetails: { code: "EACCES", stage: "publish" },
      suggestedActions: [{ type: "retry", label: "Retry folder and processing" }]
    });
    const filteredReviews = await app.inject({
      method: "GET",
      url: "/api/v1/reviews?category=folder_creation_failure&severity=high&status=active",
      headers: { cookie }
    });
    assert.equal(filteredReviews.statusCode, 200);
    assert.equal(filteredReviews.json().items.length, 1);
    assert.equal(filteredReviews.json().summary.active, 2);
    const reviewDetail = await app.inject({
      method: "GET",
      url: `/api/v1/reviews/${reviewItem.id}`,
      headers: { cookie }
    });
    assert.equal(reviewDetail.json().item.requestedPath, reviewRetryPath);
    const reviewRetry = await app.inject({
      method: "POST",
      url: `/api/v1/reviews/${reviewItem.id}/retry`,
      headers: { cookie }
    });
    assert.equal(reviewRetry.statusCode, 200);
    assert.equal(reviewRetry.json().item.status, "retrying");
    assert.equal(reviewRetry.json().item.retryCount, 1);
    await assert.rejects(access(reviewRetryPath), { code: "ENOENT" });
    const reviewResolved = await app.inject({
      method: "POST",
      url: `/api/v1/reviews/${reviewItem.id}/resolve`,
      headers: { cookie }
    });
    assert.equal(reviewResolved.statusCode, 200);
    assert.equal(reviewResolved.json().item.status, "resolved");
    const reviewDateFilter = await app.inject({
      method: "GET",
      url: "/api/v1/reviews?from=invalid-date",
      headers: { cookie }
    });
    assert.equal(reviewDateFilter.statusCode, 400);

    const authenticated = await app.inject({
      method: "GET",
      url: "/api/v1/settings",
      headers: { cookie }
    });
    assert.equal(authenticated.statusCode, 200);
    assert.equal(authenticated.json().settings.adminPasswordConfigured, true);
    assert.equal("metadataApiKey" in authenticated.json().settings, false);
    assert.equal("adminPasswordHash" in authenticated.json().settings, false);
    assert.equal(authenticated.json().settings.tvDetectionEnabled, false);
    assert.equal(authenticated.json().settings.tvValidationLoggingEnabled, false);

    const episode = { seriesId: "series-api", seasonNumber: 1, episodeNumber: 1, title: "Pilot" };
    const makePlan = (fingerprint) => jobs.repositories.tvProcessingPlans.save({
      sourceId: "dvd-source",
      manifestId: `manifest-${fingerprint}`,
      fingerprint,
      series: { id: "series-api", title: "Example Series" },
      seriesConfidence: 0.9,
      season: { seriesId: "series-api", number: 1 },
      seasonConfidence: 0.9,
      assignments: [{
        itemId: "title-1",
        itemSignature: `signature-${fingerprint}`,
        itemTitle: "Pilot",
        decision: "suggested",
        episodes: [episode],
        confidence: 0.8,
        confidenceBand: "medium",
        explanation: ["Episode title and runtime are similar"],
        alternatives: [{
          episodes: [episode],
          confidence: 0.8,
          evidence: ["Runtime similarity"],
          scoreComponents: { runtimeSimilarity: 0.9 },
          kind: "single"
        }],
        reviewRequirement: "required"
      }],
      confidence: 0.8,
      confidenceBand: "medium",
      automaticProcessingSafe: false,
      reviewRequirement: "required",
      reviewReasons: ["Manual review required"],
      duplicateTracks: [],
      alternateTracks: [],
      commentaryTracks: [],
      bonusFeatures: [],
      specialFeatures: [],
      approvalRequired: true,
      executionEnabled: false,
      executionBlocker: "V2 TV plan execution is not enabled"
    });
    const approvalPlan = makePlan("api-plan-approve");
    const unknownPlan = makePlan("api-plan-unknown");
    const tvSummary = await app.inject({ method: "GET", url: "/api/v1/tv/summary", headers: { cookie } });
    assert.equal(tvSummary.statusCode, 200);
    assert.equal(tvSummary.json().totalDiscsAnalyzed, 2);
    const matchingJobId = "staged-tv-api-job";
    const matchingFingerprint = "staged-tv-api-fingerprint";
    jobs.repositories.jobs.add(matchingJobId, "fresh-off-the-boat", matchingFingerprint, "dvd");
    jobs.repositories.jobs.finish(matchingJobId, "awaiting-identification", "Awaiting series identification");
    jobs.repositories.discRecovery.recordDetection(matchingFingerprint, "dvd", "tv_series");
    jobs.repositories.tvMatchingTasks.create({
      jobId: matchingJobId,
      fingerprint: matchingFingerprint,
      status: "awaiting-identification",
      stagingPath: path.join(root, "tv-staging", matchingJobId),
      source: {
        sourceId: "dvd-api",
        providerId: "source.video-dvd.makemkv",
        mediaKind: "dvd",
        label: "fresh-off-the-boat",
        manifest: { mediaKind: "dvd", attributes: {}, items: [] }
      },
      diagnostics: { status: "analysis-unavailable" },
      files: { "1": "episode01.mkv" },
      assignments: [{
        trackId: "1",
        title: "Title 1",
        durationSeconds: 1300,
        episodeCandidates: [],
        selectedEpisodes: undefined
      }]
    });
    const matchingQueue = await app.inject({ method: "GET", url: "/api/v1/tv/matching", headers: { cookie } });
    assert.equal(matchingQueue.statusCode, 200);
    assert.equal(matchingQueue.json().tasks.some(({ task }) => task.jobId === matchingJobId), true);
    const saveMatchingIdentification = await app.inject({
      method: "PUT",
      url: `/api/v1/tv/matching/${matchingJobId}/identification`,
      headers: { cookie },
      payload: {
        seriesName: "Fresh Off The Boat",
        provider: "tvdb",
        providerId: "292941",
        seasonNumber: 3,
        discNumber: 1
      }
    });
    assert.equal(saveMatchingIdentification.statusCode, 200);
    assert.equal(saveMatchingIdentification.json().recovery.seriesName, "Fresh Off The Boat");
    const saveMatchingAssignments = await app.inject({
      method: "PUT",
      url: `/api/v1/tv/matching/${matchingJobId}/assignments`,
      headers: { cookie },
      payload: { assignments: [{ trackId: "1", episodeNumbers: [1, 2] }] }
    });
    assert.equal(saveMatchingAssignments.statusCode, 200);
    assert.deepEqual(saveMatchingAssignments.json().task.assignments[0].selectedEpisodes.map((item) => item.episodeNumber), [1, 2]);
    let continuedMatchingJobId;
    server.setTvMatchingActions({
      continue: async (jobId) => { continuedMatchingJobId = jobId; },
      remove: async (jobId) => {
        const task = jobs.repositories.tvMatchingTasks.get(jobId);
        if (!task || !jobs.repositories.tvMatchingTasks.deleteTemporaryRecords(jobId, task.fingerprint)) {
          throw new Error("TV task removal failed");
        }
      }
    });
    const continueMatching = await app.inject({
      method: "POST",
      url: `/api/v1/tv/matching/${matchingJobId}/continue`,
      headers: { cookie }
    });
    assert.equal(continueMatching.statusCode, 202);
    assert.equal(continuedMatchingJobId, matchingJobId);
    const deleteWithoutConfirmation = await app.inject({
      method: "DELETE",
      url: `/api/v1/history/${matchingJobId}`,
      headers: { cookie }
    });
    assert.equal(deleteWithoutConfirmation.statusCode, 400);
    const deleteMatching = await app.inject({
      method: "DELETE",
      url: `/api/v1/history/${matchingJobId}`,
      headers: { cookie },
      payload: { confirmed: true }
    });
    assert.equal(deleteMatching.statusCode, 200);
    assert.equal(jobs.repositories.tvMatchingTasks.get(matchingJobId), undefined);
    assert.equal(db.prepare("SELECT status FROM jobs WHERE id = ?").get(matchingJobId).status, "deleted");
    const invalidTvFilter = await app.inject({
      method: "GET",
      url: "/api/v1/tv/analysis?confidence=impossible",
      headers: { cookie }
    });
    assert.equal(invalidTvFilter.statusCode, 400);
    const acceptMatch = await app.inject({
      method: "POST",
      url: `/api/v1/tv/plans/${approvalPlan.id}/corrections`,
      headers: { cookie },
      payload: {
        action: "accept-match",
        itemId: "title-1",
        episodes: [episode],
        reviewer: "admin",
        reason: "Verified from disc packaging"
      }
    });
    assert.equal(acceptMatch.statusCode, 200);
    assert.equal(acceptMatch.json().correction.outcome, "accepted");
    const markUnknown = await app.inject({
      method: "POST",
      url: `/api/v1/tv/plans/${unknownPlan.id}/corrections`,
      headers: { cookie },
      payload: {
        action: "mark-unknown",
        itemId: "title-1",
        reviewer: "admin",
        reason: "Disc evidence is ambiguous"
      }
    });
    assert.equal(markUnknown.statusCode, 200);
    assert.equal(markUnknown.json().plan.assignments[0].decision, "unknown");
    const approvePlan = await app.inject({
      method: "POST",
      url: `/api/v1/tv/plans/${approvalPlan.id}/review`,
      headers: { cookie },
      payload: { action: "approve", reviewer: "admin" }
    });
    assert.equal(approvePlan.statusCode, 200);
    assert.equal(approvePlan.json().plan.state, "approved");
    assert.equal(approvePlan.json().plan.executionEnabled, false);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/tags?")) {
        return new Response(JSON.stringify([
          { name: "v1.5.0" },
          { name: "v1.10.0" },
          { name: "v1.11.0" },
          { name: "v1.12.0" },
          { name: "v1.13.0" },
          { name: "v1.14.0" },
          { name: "v1.15.2" },
          { name: "main" }
        ]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/releases/tags/")) return new Response("", { status: 404 });
      return new Response("### Version 1.15.2\n- Test release notes.", { status: 200 });
    };
    try {
      const updateCheck = await app.inject({
        method: "GET",
        url: "/api/v1/updates/check",
        headers: { cookie }
      });
      assert.equal(updateCheck.statusCode, 200);
      assert.equal(updateCheck.json().latestVersion, "v1.15.2");
      assert.equal(updateCheck.json().updateAvailable, false);
      assert.match(updateCheck.json().releaseNotes, /Test release notes/);
    } finally {
      globalThis.fetch = originalFetch;
    }

    jobs.addJob("update-blocked-by-active-job", "Disc during update test");
    const updateDuringJob = await app.inject({
      method: "POST",
      url: "/api/v1/updates/apply",
      headers: { cookie }
    });
    assert.equal(updateDuringJob.statusCode, 409);
    jobs.finishJob("update-blocked-by-active-job", "failed", "expected test cleanup");
    jobs.addEvent("update-blocked-by-active-job", "diagnostic-fixture", "warn", "fixture diagnostic event");
    const diagnosticHistory = await app.inject({
      method: "GET",
      url: "/api/v1/diagnostics?jobId=update-blocked-by-active-job",
      headers: { cookie }
    });
    assert.equal(diagnosticHistory.statusCode, 200);
    assert.equal(diagnosticHistory.json().job.id, "update-blocked-by-active-job");
    assert.equal(diagnosticHistory.json().timeline.at(-1).stage, "diagnostic-fixture");

    const invalidBody = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: { cookie },
      payload: null
    });
    assert.equal(invalidBody.statusCode, 400);

    const invalidQuality = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: { cookie },
      payload: { quality: 99 }
    });
    assert.equal(invalidQuality.statusCode, 400);

    const invalidLidarrUrl = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: { cookie },
      payload: { lidarrUrl: "ftp://localhost:8686" }
    });
    assert.equal(invalidLidarrUrl.statusCode, 400);

    const invalidMusicBrainzEmail = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: { cookie },
      payload: { musicBrainzContactEmail: "not-an-email" }
    });
    assert.equal(invalidMusicBrainzEmail.statusCode, 400);

    jobs.addJob("manual-metadata-job", "Audio CD test", "manual-audio-fingerprint", "audio_cd");
    const pendingMetadata = manualMetadata.waitForManualMusicMetadata("manual-metadata-job", {
      discId: "01234567",
      fingerprint: "manual-audio-fingerprint",
      trackNumbers: [1, 2]
    });
    const dashboardWithPrompt = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard",
      headers: { cookie }
    });
    assert.equal(dashboardWithPrompt.json().manualMusicMetadata.jobId, "manual-metadata-job");

    const invalidReleaseId = await app.inject({
      method: "POST",
      url: "/api/v1/musicbrainz/release",
      headers: { cookie },
      payload: { jobId: "manual-metadata-job", releaseId: "invalid" }
    });
    assert.equal(invalidReleaseId.statusCode, 400);

    const originalMusicBrainzFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      title: "Test album",
      date: "2002-03-04",
      "artist-credit": [{ name: "Test artist" }],
      media: [{
        discs: [{ id: "01234567" }],
        tracks: [
          { recording: { title: "Opening track" } },
          { recording: { title: "Closing track" } }
        ]
      }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
    try {
      const lookup = await app.inject({
        method: "POST",
        url: "/api/v1/musicbrainz/release",
        headers: { cookie },
        payload: {
          jobId: "manual-metadata-job",
          releaseId: "12345678-1234-1234-1234-123456789abc"
        }
      });
      assert.equal(lookup.statusCode, 200);
      assert.equal(lookup.json().metadata.album, "Test album");
      assert.equal(lookup.json().metadata.tracks[1].title, "Closing track");
    } finally {
      globalThis.fetch = originalMusicBrainzFetch;
    }

    const invalidTrackSubmit = await app.inject({
      method: "POST",
      url: "/api/v1/jobs/manual-metadata-job/music-metadata",
      headers: { cookie },
      payload: {
        artist: "Test artist",
        album: "Test album",
        tracks: [{ number: 1, title: "Only one" }]
      }
    });
    assert.equal(invalidTrackSubmit.statusCode, 400);
    const submitMetadata = await app.inject({
      method: "POST",
      url: "/api/v1/jobs/manual-metadata-job/music-metadata",
      headers: { cookie },
      payload: {
        artist: "Test artist",
        album: "Test album",
        year: "2002",
        source: "musicbrainz",
        tracks: [
          { number: 1, title: "Opening track" },
          { number: 2, title: "Closing track" }
        ]
      }
    });
    assert.equal(submitMetadata.statusCode, 200);
    assert.deepEqual(await pendingMetadata, {
      artist: "Test artist",
      album: "Test album",
      year: "2002",
      source: "musicbrainz",
      tracks: [
        { number: 1, title: "Opening track" },
        { number: 2, title: "Closing track" }
      ]
    });
    jobs.finishJob("manual-metadata-job", "completed", null);

    const activeSettings = (await app.inject({
      method: "GET", url: "/api/v1/settings", headers: { cookie }
    })).json().settings;
    const outputDestinations = structuredClone(activeSettings.outputDestinations);
    const activeProfile = outputDestinations.profiles.find((profile) => profile.id === outputDestinations.activeProfileId);
    activeProfile.routes = { tv: "folder", movies: "folder", music: "folder" };
    activeProfile.folder = { tv: linuxRoot, movies: linuxRoot, music: linuxRoot };
    activeProfile.jellyfin = { root: "", paths: { tv: linuxRoot, movies: linuxRoot, music: linuxRoot } };
    const { outputDestinationsPayloadIsValid } = await import("../dist/output-destinations.js");
    assert.equal(outputDestinationsPayloadIsValid(outputDestinations), true, JSON.stringify(outputDestinations));
    const invalidAutomation = await app.inject({
      method: "PUT", url: "/api/v1/settings", headers: { cookie }, payload: { automationMode: "hands_off" }
    });
    assert.equal(invalidAutomation.statusCode, 400);
    const saveDestinations = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: { cookie },
      payload: { outputDestinations, automationMode: "review_based" }
    });
    assert.equal(saveDestinations.statusCode, 200, saveDestinations.body);
    assert.equal(saveDestinations.json().settings.automationMode, "review_based");
    assert.equal(saveDestinations.json().settings.outputDestinations.profiles[0].routes.tv, "folder");
    assert.equal(saveDestinations.json().settings.tvRootDir, linuxRoot);

    const approvalItem = jobs.repositories.reviewItems.create({
      category: "configuration_issue",
      severity: "medium",
      title: "Disc detected — approval required",
      description: "Approve processing",
      relatedDisc: "Example DVD",
      relatedDrive: jobs.getSettings().opticalDevice,
      errorDetails: { approvalRequired: true, detectionSignature: "test-signature" },
      suggestedActions: [{ type: "approve-process", label: "Approve & Process" }]
    });
    let approvedSignature = "";
    server.setDiscApprovalAction(async (item) => {
      approvedSignature = String(item.errorDetails?.detectionSignature ?? "");
    });
    const approved = await app.inject({
      method: "POST",
      url: `/api/v1/reviews/${approvalItem.id}/approve-process`,
      headers: { cookie }
    });
    assert.equal(approved.statusCode, 200);
    assert.equal(approvedSignature, "test-signature");
    assert.equal(approved.json().item.status, "resolved");
  } finally {
    await app.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
