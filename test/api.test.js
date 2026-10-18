import assert from "node:assert/strict";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("settings endpoint redacts secrets and enforces configured admin authentication", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autodisc-test-"));
  process.env.DATABASE_PATH = path.join(root, "state.sqlite");
  process.env.MOVIES_DIR = root;
  process.env.WORK_DIR = root;

  const { app } = await import("../dist/server.js");
  const { db } = await import("../dist/db.js");
  const jobs = await import("../dist/db.js");
  const jobControl = await import("../dist/job-control.js");
  const manualMetadata = await import("../dist/manual-music-metadata.js");
  try {
    const home = await app.inject({ method: "GET", url: "/" });
    assert.equal(home.statusCode, 200);
    assert.match(home.body, /AutoDisc/);

    const initial = await app.inject({ method: "GET", url: "/api/v1/settings" });
    assert.equal(initial.statusCode, 200);
    assert.equal(initial.json().settings.adminPasswordConfigured, false);
    assert.equal(initial.json().settings.musicMetadataEnabled, false);
    assert.equal(initial.json().settings.lidarrEnabled, false);
    assert.equal(initial.json().settings.musicBrainzContactEmail, "");
    assert.equal("adminPasswordHash" in initial.json().settings, false);
    assert.equal("lidarrApiKey" in initial.json().settings, false);

    const pathCheck = await app.inject({
      method: "POST",
      url: "/api/v1/paths/check",
      payload: {
        moviesDir: root,
        musicDir: root,
        workDir: root,
        opticalDevice: path.join(root, "missing-device"),
        lidarrImportDir: path.join(root, "lidarr-import"),
        lidarrEnabled: false
      }
    });
    assert.equal(pathCheck.statusCode, 200);
    assert.equal(pathCheck.json().ok, false);
    assert.equal(pathCheck.json().checks.length, 4);
    assert.deepEqual(pathCheck.json().checks.map((check) => check.name), [
      "Movies folder", "Music folder", "Temporary work folder", "Optical drive"
    ]);
    assert.equal(pathCheck.json().checks.find((check) => check.name === "Optical drive").ok, false);
    assert.equal((await readdir(root)).some((name) => name.startsWith(".autodisc-permission-check-")), false);
    const lidarrPathCheck = await app.inject({
      method: "POST",
      url: "/api/v1/paths/check",
      payload: {
        moviesDir: root,
        musicDir: root,
        workDir: root,
        opticalDevice: path.join(root, "missing-device"),
        lidarrImportDir: root,
        lidarrEnabled: true
      }
    });
    assert.equal(lidarrPathCheck.statusCode, 200);
    assert.equal(lidarrPathCheck.json().checks.length, 5);
    assert.equal(
      lidarrPathCheck.json().checks.some((check) => check.name === "Lidarr downloads/import folder"),
      true
    );

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
        lidarrApiKey: "lidarr-test-secret"
      }
    });
    assert.equal(setMusicSettings.statusCode, 200);
    assert.equal(setMusicSettings.json().settings.musicDir, "/srv/jellyfin/Music");
    assert.equal(setMusicSettings.json().settings.musicMetadataEnabled, true);
    assert.equal(setMusicSettings.json().settings.musicBrainzContactEmail, "music-admin@example.com");
    assert.equal(setMusicSettings.json().settings.lidarrApiKeyConfigured, true);
    assert.equal("lidarrApiKey" in setMusicSettings.json().settings, false);

    const setPassword = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      payload: { adminPassword: "a-test-password-long-enough", logLevel: "error" }
    });
    assert.equal(setPassword.statusCode, 200);
    assert.equal(setPassword.json().settings.logLevel, "error");

    const unauthorized = await app.inject({ method: "GET", url: "/api/v1/settings" });
    assert.equal(unauthorized.statusCode, 401);

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/login",
      payload: { username: "admin", password: "a-test-password-long-enough" }
    });
    assert.equal(login.statusCode, 200);
    const setCookie = login.headers["set-cookie"];
    assert.equal(typeof setCookie, "string");
    const cookie = setCookie.split(";")[0];

    const authenticated = await app.inject({
      method: "GET",
      url: "/api/v1/settings",
      headers: { cookie }
    });
    assert.equal(authenticated.statusCode, 200);
    assert.equal(authenticated.json().settings.adminPasswordConfigured, true);
    assert.equal("metadataApiKey" in authenticated.json().settings, false);
    assert.equal("adminPasswordHash" in authenticated.json().settings, false);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/tags?")) {
        return new Response(JSON.stringify([
          { name: "v1.5.0" },
          { name: "v1.7.0" },
          { name: "main" }
        ]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/releases/tags/")) return new Response("", { status: 404 });
      return new Response("### Version 1.7.0\n- Test release notes.", { status: 200 });
    };
    try {
      const updateCheck = await app.inject({
        method: "GET",
        url: "/api/v1/updates/check",
        headers: { cookie }
      });
      assert.equal(updateCheck.statusCode, 200);
      assert.equal(updateCheck.json().latestVersion, "v1.7.0");
      assert.equal(updateCheck.json().updateAvailable, true);
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
  } finally {
    await app.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
