import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import test from "node:test";
import { findTvEpisodeConflicts } from "../dist/application/tv-episode-conflicts.js";
import { defaultSettings } from "../dist/infrastructure/database/default-settings.js";
import { migrateDatabase } from "../dist/infrastructure/database/migrations.js";
import { createSqliteRepositories } from "../dist/infrastructure/database/repositories.js";

test("episode provenance detects logical conflicts and ignores missing or unrelated files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autodisc-episode-conflicts-"));
  const db = new Database(":memory:");
  migrateDatabase(db, defaultSettings);
  const repositories = createSqliteRepositories(db, defaultSettings);
  t.after(async () => {
    repositories.close();
    await rm(root, { recursive: true, force: true });
  });
  const outputPath = path.join(root, "Show S01E07 - Blooper.mkv");
  await writeFile(outputPath, Buffer.alloc(2048));
  const publication = {
    outputPath, fingerprint: "old-disc", discLabel: "Disc 1", discNumber: 1, trackId: "7",
    trackTitle: "Blooper Reel", seriesName: "Example Show", metadataProvider: "tvdb",
    providerId: "123", seasonNumber: 1, episodeNumber: 7,
    confirmedAt: "2026-01-01T00:00:00.000Z", publishedAt: "2026-01-01T01:00:00.000Z"
  };
  repositories.tvEpisodePublications.record([publication]);
  const recovery = { seriesName: "Example Show", metadataProvider: "tvdb", providerId: "123" };
  const mappings = [{ trackId: "1", episodes: [{ seriesId: "123", seasonNumber: 1, episodeNumber: 7 }] }];
  const conflicts = await findTvEpisodeConflicts(repositories.tvEpisodePublications, recovery, mappings);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].trackId, "1");
  assert.equal(conflicts[0].provenanceStatus, "verified");
  assert.equal(conflicts[0].existing.trackId, "7");
  assert.equal(conflicts[0].existing.confirmedAt, publication.confirmedAt);
  assert.deepEqual(await findTvEpisodeConflicts(repositories.tvEpisodePublications, recovery, mappings, {
    targetPath: () => outputPath, legacyHistory: () => [], jobOutputPath: () => null,
    excludeOutputPaths: new Set([outputPath])
  }), [], "current transaction outputs are excluded from both provenance and filesystem scans");
  assert.equal((await findTvEpisodeConflicts(repositories.tvEpisodePublications,
    { ...recovery, providerId: "different" }, mappings)).length, 0);

  await rm(outputPath);
  assert.equal((await findTvEpisodeConflicts(repositories.tvEpisodePublications, recovery, mappings)).length, 0);
  await writeFile(outputPath, Buffer.alloc(2048, 1));
  repositories.tvEpisodePublications.record([{ ...publication, fingerprint: "new-disc", trackId: "1" }]);
  assert.equal(repositories.tvEpisodePublications.listForSeason(1)[0].fingerprint, "new-disc");

  await rm(outputPath);
  await mkdir(outputPath);
  await assert.rejects(findTvEpisodeConflicts(repositories.tvEpisodePublications, recovery, mappings),
    /not a regular file/);
});

test("exact output collisions use legacy history only when the source is unambiguous", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autodisc-legacy-conflicts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputPath = path.join(root, "Show S01E07.mkv");
  await writeFile(outputPath, Buffer.alloc(2048));
  const recovery = { seriesName: "Show", metadataProvider: "tvdb", providerId: "123" };
  const episode = { seriesId: "123", seasonNumber: 1, episodeNumber: 7 };
  const mappings = [{ trackId: "1", episodes: [episode] }];
  const history = {
    jobId: "legacy-job", fingerprint: "legacy-disc", metadataProvider: "tvdb", providerId: "123",
    seriesName: "Show", seasonNumber: 1, discNumber: 1,
    mappings: [{ trackId: "7", episodes: [episode] }], episodes: [episode], completedAt: "2025-01-01"
  };
  const options = { targetPath: () => outputPath, legacyHistory: () => [history], jobOutputPath: () => outputPath };
  const repository = { listForSeason: () => [] };
  let conflicts = await findTvEpisodeConflicts(repository, recovery, mappings, options);
  assert.equal(conflicts[0].provenanceStatus, "legacy");
  assert.equal(conflicts[0].existing.trackId, "7");
  conflicts = await findTvEpisodeConflicts(repository, recovery, mappings, {
    ...options, legacyHistory: () => [{ ...history, mappings: [history.mappings[0], history.mappings[0]] }]
  });
  assert.equal(conflicts[0].provenanceStatus, "unknown");
  assert.equal(conflicts[0].existing.trackId, "");
  conflicts = await findTvEpisodeConflicts(repository, recovery, mappings, {
    ...options, jobOutputPath: () => path.join(root, "different.mkv")
  });
  assert.equal(conflicts[0].provenanceStatus, "unknown");
});

test("unrecorded episode filenames are detected without confusing other episode numbers", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autodisc-filename-conflicts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = ["Show S01E07 - Old title.mkv", "Show S01E07-E08.mkv", "Show S01E70.mkv",
    "Show S02E07.mkv", "Show S01E07.nfo"];
  await Promise.all(files.map((file) => writeFile(path.join(root, file), Buffer.alloc(2048))));
  const options = {
    targetPath: () => path.join(root, "Show S01E07 - New title.mkv"),
    legacyHistory: () => [], jobOutputPath: () => null
  };
  const recovery = { seriesName: "Show", metadataProvider: "manual", providerId: null };
  const mappings = [{ trackId: "1", episodes: [{ seriesId: "show", seasonNumber: 1, episodeNumber: 7 }] }];
  const conflicts = await findTvEpisodeConflicts({ listForSeason: () => [] }, recovery, mappings, options);
  assert.deepEqual(conflicts.map((item) => path.basename(item.existing.outputPath)).sort(),
    ["Show S01E07 - Old title.mkv", "Show S01E07-E08.mkv"].sort());
  assert.ok(conflicts.every((item) => item.provenanceStatus === "unknown"));
  const excludingCurrentOutput = await findTvEpisodeConflicts({ listForSeason: () => [] }, recovery, mappings, {
    ...options, excludeOutputPaths: new Set([path.join(root, "Show S01E07 - Old title.mkv")])
  });
  assert.deepEqual(excludingCurrentOutput.map((item) => path.basename(item.existing.outputPath)),
    ["Show S01E07-E08.mkv"]);
  const episode8 = [{ trackId: "1", episodes: [{ seriesId: "show", seasonNumber: 1, episodeNumber: 8 }] }];
  const conflicts8 = await findTvEpisodeConflicts({ listForSeason: () => [] }, recovery, episode8, {
    ...options, targetPath: () => path.join(root, "Show S01E08.mkv")
  });
  assert.deepEqual(conflicts8.map((item) => path.basename(item.existing.outputPath)), ["Show S01E07-E08.mkv"]);
});

test("forgetting a disc removes its provenance without deleting published files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autodisc-forget-publication-"));
  const outputPath = path.join(root, "episode.mkv");
  await writeFile(outputPath, Buffer.alloc(2048));
  const db = new Database(":memory:");
  migrateDatabase(db, defaultSettings);
  const repositories = createSqliteRepositories(db, defaultSettings);
  t.after(async () => {
    repositories.close();
    await rm(root, { recursive: true, force: true });
  });
  repositories.tvEpisodePublications.record([{
    outputPath, fingerprint: "disc-fingerprint", discLabel: "Disc 1", discNumber: 1,
    trackId: "7", trackTitle: "Bonus", seriesName: "Show", metadataProvider: "manual", providerId: null,
    seasonNumber: 1, episodeNumber: 7, confirmedAt: null, publishedAt: "2026-01-01T00:00:00.000Z"
  }]);
  const result = repositories.forgetDisc.forgetDisc("disc-fingerprint");
  assert.equal(result.removed.tvEpisodePublications, 1);
  assert.equal(repositories.tvEpisodePublications.listForSeason(1).length, 0);
  assert.equal((await readFile(outputPath)).length, 2048);
});

test("episode provenance survives database reopen and repeated migration", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autodisc-publication-restart-"));
  const databasePath = path.join(root, "state.sqlite");
  let db = new Database(databasePath);
  migrateDatabase(db, defaultSettings);
  let repositories = createSqliteRepositories(db, defaultSettings);
  repositories.tvEpisodePublications.record([{
    outputPath: path.join(root, "episode.mkv"), fingerprint: "disc", discLabel: "Disc 1", discNumber: 1,
    trackId: "7", trackTitle: "Bonus", seriesName: "Show", metadataProvider: "manual", providerId: null,
    seasonNumber: 1, episodeNumber: 7, confirmedAt: "2026-01-01T00:00:00.000Z",
    publishedAt: "2026-01-01T01:00:00.000Z"
  }]);
  repositories.close();
  db = new Database(databasePath);
  migrateDatabase(db, defaultSettings);
  repositories = createSqliteRepositories(db, defaultSettings);
  t.after(async () => {
    repositories.close();
    await rm(root, { recursive: true, force: true });
  });
  const publications = repositories.tvEpisodePublications.listForSeason(1);
  assert.equal(publications.length, 1);
  assert.equal(publications[0].fingerprint, "disc");
  assert.equal(publications[0].confirmedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 30").get().count, 1);
});
