import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("manual episode conflict is saved for review without starting publication", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autodisc-conflict-api-"));
  process.env.DATABASE_PATH = path.join(root, "state.sqlite");
  process.env.MOVIES_DIR = root;
  process.env.TV_DIR = path.join(root, "TV");
  process.env.WORK_DIR = path.join(root, "work");
  const { app } = await import("../dist/server.js");
  const { repositories } = await import("../dist/db.js");
  try {
    const setup = await app.inject({
      method: "POST", url: "/api/v1/setup",
      payload: { username: "admin", password: "SecurePassword123!", confirmPassword: "SecurePassword123!" }
    });
    assert.equal(setup.statusCode, 201);
    const login = await app.inject({
      method: "POST", url: "/api/v1/login", payload: { username: "admin", password: "SecurePassword123!" }
    });
    const cookie = login.headers["set-cookie"].split(";")[0];
    const oldOutput = path.join(root, "different episode filename.mkv");
    await writeFile(oldOutput, Buffer.alloc(2048));
    repositories.tvEpisodePublications.record([{
      outputPath: oldOutput, fingerprint: "old-disc", discLabel: "Disc 1", discNumber: 1,
      trackId: "7", trackTitle: "Blooper Reel", seriesName: "Example Show", metadataProvider: "tvdb",
      providerId: "123", seasonNumber: 1, episodeNumber: 7,
      confirmedAt: "2026-01-01T00:00:00.000Z", publishedAt: "2026-01-01T01:00:00.000Z"
    }]);
    repositories.jobs.add("new-job", "Disc 2", "new-disc", "dvd");
    repositories.jobs.finish("new-job", "review", "Awaiting matching");
    repositories.discRecovery.recordDetection("new-disc", "dvd", "tv_series");
    repositories.discRecovery.update("new-disc", {
      metadataProvider: "tvdb", providerId: "123", seriesName: "Example Show",
      seasonNumber: 1, discNumber: 2, identifiedBy: "user"
    });
    repositories.tvMatchingTasks.create({
      jobId: "new-job", fingerprint: "new-disc", status: "awaiting-mapping", stagingPath: root,
      source: { sourceId: "dvd", providerId: "dvd", mediaKind: "dvd", label: "Disc 2",
        manifest: { mediaKind: "dvd", items: [] } },
      diagnostics: {}, files: {},
      assignments: [{ trackId: "1", title: "Episode 7", durationSeconds: 1300, episodeCandidates: [] }]
    });
    const completed = await app.inject({
      method: "POST", url: "/api/v1/review/items/tv-matching-task%3Anew-job/complete",
      headers: { cookie }, payload: { assignments: [{ trackId: "1", episodeNumbers: [7] }] }
    });
    assert.equal(completed.statusCode, 200);
    assert.equal(completed.json().continuation, "blocked");
    const saved = repositories.tvMatchingTasks.get("new-job");
    assert.equal(saved.status, "awaiting-mapping");
    assert.ok(saved.assignments[0].confirmedAt);
    const listing = await app.inject({ method: "GET", url: "/api/v1/tv/matching", headers: { cookie } });
    assert.equal(listing.statusCode, 200);
    const conflict = listing.json().tasks[0].conflicts[0];
    assert.equal(conflict.existing.discLabel, "Disc 1");
    assert.equal(conflict.existing.trackId, "7");
    assert.equal(conflict.trackId, "1");
    assert.equal(conflict.episodeNumber, 7);
    assert.equal(conflict.provenanceStatus, "verified");
    const audit = {
      id: "history-test", jobId: "new-job", at: "2026-01-02T00:00:00.000Z",
      action: "keep_existing", seasonNumber: 1, episodeNumber: 7,
      incoming: { fingerprint: "new-disc", discLabel: "Disc 2", trackId: "1",
        trackTitle: "Episode 7", confirmedAt: saved.assignments[0].confirmedAt },
      existing: conflict.existing, provenanceStatus: "verified", decisionBy: "admin", details: {}
    };
    repositories.tvConflictJournal.appendAudit(audit);
    const listWithHistory = await app.inject({ method: "GET", url: "/api/v1/tv/matching", headers: { cookie } });
    assert.deepEqual(listWithHistory.json().tasks[0].conflictHistory, [audit]);
    const detailWithHistory = await app.inject({ method: "GET", url: "/api/v1/tv/matching/new-job", headers: { cookie } });
    assert.deepEqual(detailWithHistory.json().conflictHistory, [audit]);
    assert.equal(detailWithHistory.json().conflicts.length, 1, "audit records do not resolve conflicts");
    const stagedPath = path.join(root, "incoming.mkv");
    await writeFile(stagedPath, Buffer.alloc(2048, 3));
    repositories.tvMatchingTasks.update("new-job", { files: { "1": "incoming.mkv" } });
    const decisionTask = repositories.tvMatchingTasks.get("new-job");
    const decision = await app.inject({
      method: "POST", url: "/api/v1/tv/matching/new-job/keep-existing", headers: { cookie },
      payload: { trackId: "1", updatedAt: decisionTask.updatedAt, expectedConflict: conflict }
    });
    assert.equal(decision.statusCode, 200, decision.body);
    assert.equal(decision.json().remainingConflicts, 0);
    assert.equal(repositories.tvConflictJournal.listAuditForJob("new-job").at(-1).action, "keep_existing");
    for (const action of ["keep_both", "mark_as_extras"]) {
      const currentTask = repositories.tvMatchingTasks.get("new-job");
      const response = await app.inject({
        method: "POST", url: "/api/v1/tv/matching/new-job/keep-existing", headers: { cookie },
        payload: { action, trackId: "1", updatedAt: currentTask.updatedAt, expectedConflict: conflict }
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().remainingConflicts, 0);
      assert.equal(repositories.tvMatchingTasks.get("new-job").assignments[0].keepExisting.action, action);
      assert.equal(repositories.tvConflictJournal.listAuditForJob("new-job").at(-1).action, action);
    }
    assert.equal((await readFile(oldOutput))[0], 0);
    assert.equal((await readFile(stagedPath))[0], 3);
    const resolved = await app.inject({ method: "GET", url: "/api/v1/tv/matching/new-job", headers: { cookie } });
    assert.equal(resolved.json().conflicts.length, 0);
    await writeFile(oldOutput, Buffer.alloc(2048, 9));
    const changed = await app.inject({ method: "GET", url: "/api/v1/tv/matching/new-job", headers: { cookie } });
    assert.equal(changed.json().conflicts.length, 1, "changed existing media invalidates the decision");
    const stale = await app.inject({
      method: "POST", url: "/api/v1/tv/matching/new-job/keep-existing", headers: { cookie },
      payload: { trackId: "1", updatedAt: decisionTask.updatedAt, expectedConflict: conflict }
    });
    assert.equal(stale.statusCode, 409);
    await rm(oldOutput);
    const missing = await app.inject({ method: "GET", url: "/api/v1/tv/matching/new-job", headers: { cookie } });
    assert.equal(missing.json().conflicts[0].stale, true);
    const missingContinue = await app.inject({
      method: "POST", url: "/api/v1/review/items/tv-matching-task%3Anew-job/complete",
      headers: { cookie }, payload: { publish: "required" }
    });
    assert.equal(missingContinue.statusCode, 409);
    await writeFile(oldOutput, Buffer.alloc(2048));
    await writeFile(path.join(root, "unmatched.mkv"), Buffer.alloc(2048));
    repositories.tvMatchingTasks.update("new-job", {
      files: { "2": "unmatched.mkv" },
      assignments: [...saved.assignments, {
        trackId: "2", title: "Unmatched", durationSeconds: 1300, episodeCandidates: []
      }]
    });
    const removeUnmatched = await app.inject({
      method: "DELETE", url: "/api/v1/tv/matching/new-job/unmatched",
      headers: { cookie }, payload: { confirmed: true }
    });
    assert.equal(removeUnmatched.statusCode, 200);
    assert.equal(removeUnmatched.json().continuation, "blocked");
    assert.equal(repositories.tvMatchingTasks.get("new-job").status, "awaiting-mapping");
    const correction = await app.inject({
      method: "POST", url: "/api/v1/review/items/tv-matching-task%3Anew-job/complete",
      headers: { cookie }, payload: { assignments: [{ trackId: "1", episodeNumbers: [8] }], publish: "never" }
    });
    assert.equal(correction.statusCode, 200);
    assert.equal(repositories.tvMatchingTasks.get("new-job").status, "ready-to-publish");
    const correctedList = await app.inject({ method: "GET", url: "/api/v1/tv/matching", headers: { cookie } });
    assert.equal(correctedList.json().tasks[0].conflicts.length, 0);
    const { tvEpisodeOutput } = await import("../dist/application/tv-episode-output.js");
    const recovery = repositories.discRecovery.get("new-disc");
    const unknownOutput = tvEpisodeOutput(repositories.settings.get(), recovery, {
      trackId: "1", episodes: [{ seriesId: "123", seasonNumber: 1, episodeNumber: 8 }]
    });
    const relativeOutput = path.relative(root, unknownOutput.targetPath);
    assert.ok(relativeOutput && !path.isAbsolute(relativeOutput) && relativeOutput !== ".." &&
      !relativeOutput.startsWith(`..${path.sep}`));
    await mkdir(unknownOutput.seasonDir, { recursive: true });
    await writeFile(unknownOutput.targetPath, Buffer.alloc(2048));
    const unknownList = await app.inject({ method: "GET", url: "/api/v1/tv/matching", headers: { cookie } });
    assert.equal(unknownList.json().tasks[0].conflicts[0].provenanceStatus, "unknown");
    const continueRequest = await app.inject({
      method: "POST", url: "/api/v1/review/items/tv-matching-task%3Anew-job/complete",
      headers: { cookie }, payload: { publish: "required" }
    });
    assert.equal(continueRequest.statusCode, 409);
    const secondOld = path.join(root, "other existing episode.mkv");
    await writeFile(secondOld, Buffer.alloc(2048, 8));
    repositories.tvEpisodePublications.record([{
      ...conflict.existing, outputPath: secondOld, fingerprint: "another-disc", discLabel: "Disc 3"
    }]);
    repositories.jobs.add("multi-job", "Multi disc", "multi-disc", "dvd");
    repositories.jobs.finish("multi-job", "review", "Awaiting matching");
    repositories.discRecovery.recordDetection("multi-disc", "dvd", "tv_series");
    repositories.discRecovery.update("multi-disc", {
      metadataProvider: "tvdb", providerId: "123", seriesName: "Example Show",
      seasonNumber: 1, discNumber: 4, identifiedBy: "user"
    });
    repositories.tvMatchingTasks.create({
      jobId: "multi-job", fingerprint: "multi-disc", status: "awaiting-mapping", stagingPath: root,
      source: { sourceId: "dvd", providerId: "dvd", mediaKind: "dvd", label: "Disc 4",
        manifest: { mediaKind: "dvd", items: [] } }, diagnostics: {}, files: { "1": "incoming.mkv" },
      assignments: [{ ...saved.assignments[0], selectedEpisodes: [
        { seriesId: "123", seasonNumber: 1, episodeNumber: 7 },
        { seriesId: "123", seasonNumber: 1, episodeNumber: 8 }
      ] }]
    });
    const multiResponse = await app.inject({ method: "GET", url: "/api/v1/tv/matching/multi-job", headers: { cookie } });
    const multi = multiResponse.json();
    assert.ok(multi.conflicts.length >= 2);
    const incompleteDecision = await app.inject({
      method: "POST", url: "/api/v1/tv/matching/multi-job/keep-existing", headers: { cookie },
      payload: { action: "keep_both", trackId: "1", updatedAt: multi.task.updatedAt,
        expectedConflict: multi.conflicts[0] }
    });
    assert.equal(incompleteDecision.statusCode, 409, "all conflicts must be reviewed together");
    const multiDecision = await app.inject({
      method: "POST", url: "/api/v1/tv/matching/multi-job/keep-existing", headers: { cookie },
      payload: { action: "keep_both", trackId: "1", updatedAt: multi.task.updatedAt,
        expectedConflict: multi.conflicts[0], expectedConflicts: multi.conflicts }
    });
    assert.equal(multiDecision.statusCode, 200, multiDecision.body);
    assert.equal(multiDecision.json().remainingConflicts, 0);
    assert.equal(repositories.tvConflictJournal.listAuditForJob("multi-job").length, multi.conflicts.length);
    assert.equal((await readFile(secondOld))[0], 8);
  } finally {
    await app.close();
    repositories.close();
    await rm(root, { recursive: true, force: true });
  }
});
