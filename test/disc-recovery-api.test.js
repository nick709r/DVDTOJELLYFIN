import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("disc recovery API preserves detections and gives saved manual values precedence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autodisc-disc-recovery-"));
  process.env.DATABASE_PATH = path.join(root, "state.sqlite");
  process.env.MOVIES_DIR = root;
  process.env.TV_ROOT_DIR = path.join(root, "TV");
  process.env.WORK_DIR = path.join(root, "work");
  const { app } = await import("../dist/server.js");
  const { db, repositories } = await import("../dist/db.js");
  try {
    const setup = await app.inject({
      method: "POST",
      url: "/api/v1/setup",
      payload: {
        username: "recovery-admin",
        password: "RecoverySecurePassword123!",
        confirmPassword: "RecoverySecurePassword123!"
      }
    });
    assert.equal(setup.statusCode, 201);
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/login",
      payload: { username: "recovery-admin", password: "RecoverySecurePassword123!" }
    });
    assert.equal(login.statusCode, 200);
    const cookie = login.headers["set-cookie"].split(";")[0];
    const inject = (options) => app.inject({
      ...options,
      headers: { cookie, ...(options.headers || {}) }
    });

    const unauthenticated = await app.inject({
      method: "GET",
      url: "/api/v1/discs/recovery/fingerprint-recovery"
    });
    assert.equal(unauthenticated.statusCode, 401);

    repositories.discRecovery.recordDetection("fingerprint-recovery", "dvd", "movie", 0.82);
    const update = await inject({
      method: "PUT",
      url: "/api/v1/discs/recovery/fingerprint-recovery",
      payload: {
        discType: "dvd",
        mediaType: "tv_series",
        mediaTypeReason: "Several episode-length titles",
        metadataProvider: "manual",
        providerId: null,
        seriesName: "Example Show",
        seasonNumber: 1,
        notes: "Manual identification",
        importedMetadata: { title: "Example Show", year: 2020, overview: "Series details" },
        artworkReferences: [{ kind: "poster", url: "https://image.tmdb.org/t/p/original/poster.jpg" }],
        mappings: [{
          trackId: "1",
          episodes: [{
            seriesId: "manual:Example Show",
            seasonNumber: 1,
            episodeNumber: 1,
            title: "Pilot",
            airDate: "2020-01-01",
            notes: "User-verified episode"
          }]
        }]
      }
    });
    assert.equal(update.statusCode, 200);
    assert.equal(update.json().recovery.detectedMediaType, "movie");
    assert.equal(update.json().recovery.detectedConfidence, 0.82);
    assert.equal(update.json().recovery.finalMediaType, "tv_series");
    assert.equal(update.json().recovery.mediaTypeOverridden, true);
    const persisted = await inject({ method: "GET", url: "/api/v1/discs/recovery/fingerprint-recovery" });
    const overrideAudit = persisted.json().mediaTypeAudit;
    assert.equal(overrideAudit.length, 1);
    assert.equal(overrideAudit[0].originalType, "movie");
    assert.equal(overrideAudit[0].newType, "tv_series");
    assert.equal(overrideAudit[0].username, "recovery-admin");
    assert.equal(overrideAudit[0].reason, "Several episode-length titles");
    assert.equal(update.json().recovery.mappings[0].episodes[0].airDate, "2020-01-01");
    assert.equal(update.json().recovery.mappings[0].episodes[0].notes, "User-verified episode");
    assert.equal(update.json().recovery.importedMetadata.overview, "Series details");
    assert.equal(update.json().recovery.artworkReferences[0].kind, "poster");
    assert.deepEqual(persisted.json().recovery.mappings, update.json().recovery.mappings);
    assert.deepEqual(persisted.json().recovery.artworkReferences, update.json().recovery.artworkReferences);
    repositories.discRecovery.recordDetection("fingerprint-recovery", "dvd", "movie", 0.95);
    assert.equal(repositories.discRecovery.get("fingerprint-recovery").finalMediaType, "tv_series");

    const dataDiscOverride = await inject({
      method: "PUT",
      url: "/api/v1/discs/recovery/fingerprint-recovery",
      payload: { mediaType: "data_disc", mediaTypeReason: "The disc contains files, not video" }
    });
    assert.equal(dataDiscOverride.statusCode, 200);
    assert.equal(dataDiscOverride.json().recovery.finalMediaType, "data_disc");
    const updatedAudit = await inject({ method: "GET", url: "/api/v1/discs/recovery/fingerprint-recovery" });
    assert.equal(updatedAudit.json().mediaTypeAudit.length, 2);
    assert.equal(updatedAudit.json().mediaTypeAudit[0].originalType, "tv_series");
    assert.equal(updatedAudit.json().mediaTypeAudit[0].newType, "data_disc");

    const invalid = await inject({
      method: "PUT",
      url: "/api/v1/discs/recovery/fingerprint-recovery",
      payload: { seasonNumber: 101 }
    });
    assert.equal(invalid.statusCode, 400);
    const invalidAirDate = await inject({
      method: "PUT",
      url: "/api/v1/discs/recovery/fingerprint-recovery",
      payload: {
        mappings: [{
          trackId: "1",
          episodes: [{
            seriesId: "manual:Example Show",
            seasonNumber: 1,
            episodeNumber: 1,
            airDate: "2023-02-30"
          }]
        }]
      }
    });
    assert.equal(invalidAirDate.statusCode, 400);
    const invalidArtwork = await inject({
      method: "PUT",
      url: "/api/v1/discs/recovery/fingerprint-recovery",
      payload: { artworkReferences: [{ kind: "poster", url: "https://example.invalid/poster.jpg" }] }
    });
    assert.equal(invalidArtwork.statusCode, 400);

    const manualLookup = await inject({
      method: "POST",
      url: "/api/v1/tv/metadata/series/lookup",
      payload: { provider: "manual", providerId: "", seriesName: "Example Show" }
    });
    assert.equal(manualLookup.statusCode, 200);
    assert.equal(manualLookup.json().series.title, "Example Show");

    const unsupportedProvider = await inject({
      method: "POST",
      url: "/api/v1/tv/metadata/episodes/lookup",
      payload: { provider: "anidb", providerId: "123", seasonNumber: 1 }
    });
    assert.equal(unsupportedProvider.statusCode, 501);
    const overridden = await inject({ method: "GET", url: "/api/v1/discs/overridden" });
    assert.equal(overridden.statusCode, 200);
    assert.equal(overridden.json().discs[0].fingerprint, "fingerprint-recovery");

    const fingerprint = "f".repeat(64);
    repositories.discRecovery.recordDetection(fingerprint, "dvd", "tv_series");
    repositories.discRecovery.update(fingerprint, {
      seriesName: "Forget Me",
      seasonNumber: 1,
      mappings: [{
        trackId: "1",
        episodes: [{ seriesId: "manual:Forget Me", seasonNumber: 1, episodeNumber: 1, title: "Pilot" }]
      }]
    });
    const review = repositories.reviewItems.create({
      category: "tv_review",
      severity: "medium",
      title: "TV match needs review",
      description: "Review the unidentified disc.",
      discFingerprint: fingerprint,
      suggestedActions: [{ type: "dismiss", label: "Dismiss" }]
    });
    repositories.tvEpisodeFeedback.record({
      fingerprint,
      itemSignature: "item-1",
      outcome: "accepted",
      episodes: [{ seriesId: "manual:Forget Me", seasonNumber: 1, episodeNumber: 1, title: "Pilot" }]
    });
    db.prepare("UPDATE drive_state SET last_fingerprint = ?, processed_at = ? WHERE id = 1")
      .run(fingerprint, new Date().toISOString());
    db.prepare(`INSERT INTO tv_processing_plans (id, fingerprint, state, plan_json, created_at)
      VALUES (?, ?, 'ready', '{}', ?)`).run("forget-plan", fingerprint, new Date().toISOString());
    db.prepare(`INSERT INTO tv_validation_evidence (id, fingerprint, captured_at, origin, evidence_json)
      VALUES (?, ?, ?, 'imported', '{}')`).run("forget-evidence", fingerprint, new Date().toISOString());
    const diagnostics = await import("../dist/diagnostics.js");
    diagnostics.beginDiscDiagnostics("/dev/test");
    diagnostics.updateDiscDiagnostics({ fingerprint });

    const forgotten = await inject({ method: "POST", url: `/api/v1/discs/${fingerprint}/forget` });
    assert.equal(forgotten.statusCode, 200);
    assert.equal(forgotten.json().fingerprint, fingerprint);
    assert.equal(repositories.discRecovery.get(fingerprint), undefined);
    assert.equal(repositories.tvEpisodeFeedback.listForFingerprint(fingerprint).length, 0);
    assert.equal(repositories.reviewItems.get(review.id), undefined);
    assert.equal(db.prepare("SELECT last_fingerprint FROM drive_state WHERE id = 1").get().last_fingerprint, null);
    assert.equal(db.prepare("SELECT 1 FROM tv_processing_plans WHERE fingerprint = ?").get(fingerprint), undefined);
    assert.equal(db.prepare("SELECT 1 FROM tv_validation_evidence WHERE fingerprint = ?").get(fingerprint), undefined);
    assert.equal(repositories.recovery.lastDiscFingerprint(), null);
    assert.equal(diagnostics.getLiveDiscDiagnostics(), null);
    assert.equal((await inject({ method: "POST", url: `/api/v1/discs/${fingerprint}/forget` })).statusCode, 404);
    const resumedJobId = "a072f579-f2f2-4a68-87ca-53a14a27f23f";
    repositories.jobs.add(resumedJobId, "Reinserted disc", fingerprint, "dvd");
    assert.equal(repositories.jobs.active()?.id, resumedJobId);
    assert.equal((await inject({ method: "POST", url: `/api/v1/discs/${fingerprint}/forget` })).statusCode, 409);
  } finally {
    await app.close();
    repositories.close();
    await rm(root, { recursive: true, force: true });
  }
});
