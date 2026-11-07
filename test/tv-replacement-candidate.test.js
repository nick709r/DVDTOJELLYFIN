import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultSettings } from "../dist/infrastructure/database/default-settings.js";
import { openSqliteDatabase } from "../dist/infrastructure/database/connection.js";
import { migrateDatabase } from "../dist/infrastructure/database/migrations.js";
import { createSqliteRepositories } from "../dist/infrastructure/database/repositories.js";

test("candidate checkpoint verifies and retains all files and requires intact claims", {
  skip: process.platform !== "linux"
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "autodisc-candidate-"));
  const probe = join(root, "ffprobe");
  await writeFile(probe, "#!/bin/sh\nprintf '123.0\\n'\n");
  await chmod(probe, 0o700);
  process.env.FFPROBE_COMMAND = probe;
  const { prepareReplacementCandidate, quarantineReplacementOriginal, publishReplacement, reconcileReplacementTransaction } =
    await import("../dist/application/tv-replacement-executor.js");
  const dbPath = join(root, "state.sqlite");
  let db = openSqliteDatabase(dbPath);
  migrateDatabase(db, defaultSettings);
  let repositories = createSqliteRepositories(db, defaultSettings);
  t.after(async () => {
    repositories.close();
    delete process.env.FFPROBE_COMMAND;
    await rm(root, { recursive: true, force: true });
  });
  const library = join(root, "library");
  await mkdir(library);
  const workDir = join(root, "work");
  const quarantineDirectory = join(workDir, ".autodisc", "quarantine", "tx");
  await mkdir(quarantineDirectory, { recursive: true });
  const originalPath = join(library, "episode.mkv");
  const candidatePath = join(library, ".candidate.mkv");
  const stagedSourcePath = join(root, "staged.mkv");
  const originalBytes = Buffer.alloc(2048, 1);
  const candidateBytes = Buffer.alloc(2048, 2);
  const stagedBytes = Buffer.alloc(2048, 3);
  await writeFile(originalPath, originalBytes);
  await writeFile(candidatePath, candidateBytes);
  await writeFile(stagedSourcePath, stagedBytes);
  const existing = {
    outputPath: originalPath, fingerprint: "old", discLabel: "Disc 1", discNumber: 1, trackId: "7",
    trackTitle: "Old", seriesName: "Show", metadataProvider: "manual", providerId: null,
    seasonNumber: 1, episodeNumber: 7, confirmedAt: "2026-01-01", publishedAt: "2026-01-02"
  };
  const incoming = {
    fingerprint: "new", discLabel: "Disc 2", trackId: "1", trackTitle: "New", confirmedAt: "2026-01-03"
  };
  const transaction = {
    id: "tx", jobId: "job", state: "created", createdAt: "2026-01-04", updatedAt: "2026-01-04",
    originalPath, replacementPath: originalPath, quarantinePath: join(quarantineDirectory, "original.mkv"),
    originalChecksum: null, replacementChecksum: null, existing, incoming, failure: null
  };
  const snapshot = {
    candidatePath, stagedSourcePath, existingPublications: [existing],
    replacementPublications: [{ ...existing, ...incoming }], conflict: {},
    decisionBy: "admin", provenanceStatus: "verified"
  };
  const profile = defaultSettings.outputDestinations.profiles[0];
  const settings = {
    ...defaultSettings, workDir, tvRootDir: library, moviesDir: join(root, "movies"),
    musicDir: join(root, "music"), lidarrImportDir: "",
    outputDestinations: {
      activeProfileId: profile.id,
      profiles: [{
        ...profile, jellyfin: { root: "", paths: { tv: "", movies: "", music: "" } },
        sonarr: { seriesRoot: "" }, radarr: { movieRoot: "" }, lidarr: { artistRoot: "" },
        folder: { tv: "", movies: "", music: "" }
      }]
    }
  };
  repositories.settings.save(settings);
  repositories.tvEpisodePublications.record([existing]);
  repositories.tvConflictJournal.createReplacementTransaction(transaction, snapshot);
  assert.equal((await reconcileReplacementTransaction(repositories.tvConflictJournal, settings, "tx")).outcome, "review");
  await writeFile(probe, "#!/bin/sh\nfor arg do last=$arg; done\nprintf x >> \"$last\"\nprintf '123.0\\n'\n");
  await assert.rejects(prepareReplacementCandidate(repositories.tvConflictJournal, "tx"), /files changed/);
  assert.equal(repositories.tvConflictJournal.getTransaction("tx").state, "created");
  await writeFile(candidatePath, candidateBytes);
  await writeFile(probe, "#!/bin/sh\nprintf '123.0\\n'\n");
  const claim = db.prepare("SELECT claim_key AS key FROM tv_replacement_claims WHERE transaction_id = ? LIMIT 1").get("tx").key;
  db.prepare("DELETE FROM tv_replacement_claims WHERE claim_key = ?").run(claim);
  await assert.rejects(prepareReplacementCandidate(repositories.tvConflictJournal, "tx"), /claims have changed/);
  assert.equal(repositories.tvConflictJournal.getTransaction("tx").state, "created");
  db.prepare("INSERT INTO tv_replacement_claims (claim_key, transaction_id) VALUES (?, ?)").run(claim, "tx");
  await prepareReplacementCandidate(repositories.tvConflictJournal, "tx");
  assert.equal(repositories.tvConflictJournal.getTransaction("tx").state, "candidate_ready");
  assert.equal((await reconcileReplacementTransaction(repositories.tvConflictJournal, settings, "tx")).outcome, "review");
  const evidence = repositories.tvConflictJournal.getCandidateEvidence("tx");
  assert.equal(evidence.candidate.size, "2048");
  assert.equal(evidence.original.size, "2048");
  assert.equal(evidence.stagedSource.size, "2048");
  repositories.close();
  db = openSqliteDatabase(dbPath);
  migrateDatabase(db, defaultSettings);
  repositories = createSqliteRepositories(db, defaultSettings);
  assert.deepEqual(repositories.tvConflictJournal.getCandidateEvidence("tx"), evidence);
  assert.deepEqual(await readFile(originalPath), originalBytes);
  assert.deepEqual(await readFile(candidatePath), candidateBytes);
  assert.deepEqual(await readFile(stagedSourcePath), stagedBytes);
  await assert.rejects(prepareReplacementCandidate(repositories.tvConflictJournal, "tx"), /not ready/);
  await assert.rejects(quarantineReplacementOriginal(repositories.tvConflictJournal,
    { ...settings, tvRootDir: workDir }, "tx"), /overlaps a media library/);
  const libraryAlias = join(root, "library-alias");
  await symlink(workDir, libraryAlias);
  await assert.rejects(quarantineReplacementOriginal(repositories.tvConflictJournal,
    { ...settings, tvRootDir: libraryAlias }, "tx"), /resolves into a media library/);
  const claimAfterRestart = db.prepare("SELECT claim_key AS key FROM tv_replacement_claims WHERE transaction_id = ? LIMIT 1").get("tx").key;
  db.prepare("DELETE FROM tv_replacement_claims WHERE claim_key = ?").run(claimAfterRestart);
  await assert.rejects(quarantineReplacementOriginal(repositories.tvConflictJournal, settings, "tx"), /claims have changed/);
  await assert.rejects(readFile(transaction.quarantinePath), { code: "ENOENT" });
  db.prepare("INSERT INTO tv_replacement_claims (claim_key, transaction_id) VALUES (?, ?)").run(claimAfterRestart, "tx");
  await writeFile(transaction.quarantinePath, "unexpected file");
  await assert.rejects(quarantineReplacementOriginal(repositories.tvConflictJournal, settings, "tx"), { code: "EEXIST" });
  assert.equal(await readFile(transaction.quarantinePath, "utf8"), "unexpected file");
  assert.deepEqual(await readFile(originalPath), originalBytes);
  await rm(transaction.quarantinePath);
  await quarantineReplacementOriginal(repositories.tvConflictJournal, settings, "tx");
  assert.equal(repositories.tvConflictJournal.getTransaction("tx").state, "quarantined");
  assert.deepEqual(await readFile(transaction.quarantinePath), originalBytes);
  assert.deepEqual(await readFile(originalPath), originalBytes);
  assert.deepEqual(await readFile(candidatePath), candidateBytes);
  assert.deepEqual(await readFile(stagedSourcePath), stagedBytes);
  assert.deepEqual(await readFile(originalPath), originalBytes);
  await assert.rejects(publishReplacement(repositories.tvConflictJournal, settings, "tx"), { code: "EEXIST" });
  assert.equal(repositories.tvConflictJournal.getTransaction("tx").state, "quarantined");
  assert.deepEqual(await readFile(originalPath), originalBytes);
  await rm(originalPath);
  await writeFile(originalPath, "unexpected");
  assert.equal((await reconcileReplacementTransaction(repositories.tvConflictJournal, settings, "tx")).outcome, "review");
  await assert.rejects(publishReplacement(repositories.tvConflictJournal, settings, "tx"), { code: "EEXIST" });
  assert.equal(await readFile(originalPath, "utf8"), "unexpected");
  await rm(originalPath);
  await assert.rejects(publishReplacement(repositories.tvConflictJournal, settings, "tx", (step) => {
    if (step === "before-publication") throw new Error("injected failure");
  }), /injected failure/);
  assert.equal(repositories.tvConflictJournal.getTransaction("tx").state, "quarantined");
  const executor = new URL("../dist/application/tv-replacement-executor.js", import.meta.url).href;
  const connection = new URL("../dist/infrastructure/database/connection.js", import.meta.url).href;
  const factory = new URL("../dist/infrastructure/database/repositories.js", import.meta.url).href;
  const defaults = new URL("../dist/infrastructure/database/default-settings.js", import.meta.url).href;
  const script = `
    import { publishReplacement } from ${JSON.stringify(executor)};
    import { openSqliteDatabase } from ${JSON.stringify(connection)};
    import { createSqliteRepositories } from ${JSON.stringify(factory)};
    import { defaultSettings } from ${JSON.stringify(defaults)};
    const repositories = createSqliteRepositories(openSqliteDatabase(process.argv[1]), defaultSettings);
    await publishReplacement(repositories.tvConflictJournal, JSON.parse(process.argv[2]), "tx", (step) => {
      if (step === "after-publication") process.kill(process.pid, "SIGKILL");
    });
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, dbPath, JSON.stringify(settings)]);
  assert.equal(child.signal, "SIGKILL", child.stderr.toString());
  repositories.close();
  db = openSqliteDatabase(dbPath);
  repositories = createSqliteRepositories(db, defaultSettings);
  assert.equal(repositories.tvConflictJournal.getTransaction("tx").state, "quarantined");
  assert.deepEqual(await readFile(originalPath), candidateBytes);
  assert.deepEqual(await readFile(candidatePath), candidateBytes);
  assert.deepEqual(await readFile(stagedSourcePath), stagedBytes);
  assert.deepEqual(await readFile(transaction.quarantinePath), originalBytes);
  assert.equal(repositories.tvEpisodePublications.listForSeason(1)[0].fingerprint, "old");
  assert.equal((await reconcileReplacementTransaction(repositories.tvConflictJournal, settings, "tx")).outcome, "completed");
  assert.equal(repositories.tvConflictJournal.getTransaction("tx").state, "completed");
  assert.equal((await reconcileReplacementTransaction(repositories.tvConflictJournal, settings, "tx")).outcome, "completed");
  assert.equal(repositories.tvEpisodePublications.listForSeason(1)[0].fingerprint, "new");
  assert.deepEqual(await readFile(transaction.quarantinePath), originalBytes);
});

for (const originalState of ["present", "missing", "replacement", "crash-after-quarantine", "crash-before-publication",
  "crash-after-publication", "crash-after-journal", "crash-completion", "executor"]) test(`reconciliation handles ${originalState} original and remains repeatable`, {
  skip: process.platform !== "linux"
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "autodisc-reconcile-"));
  const library = join(root, "library");
  const workDir = join(root, "work");
  const quarantineDir = join(workDir, ".autodisc", "quarantine", "tx");
  await mkdir(library);
  await mkdir(quarantineDir, { recursive: true });
  const originalPath = join(library, "episode.mkv");
  const candidatePath = join(library, ".candidate.mkv");
  const stagedSourcePath = join(root, "staged.mkv");
  const quarantinePath = join(quarantineDir, "original.mkv");
  const originalBytes = Buffer.alloc(2048, 1);
  const candidateBytes = Buffer.alloc(2048, 2);
  await writeFile(originalPath, originalBytes);
  await writeFile(candidatePath, candidateBytes);
  await writeFile(stagedSourcePath, "staged source");
  const db = openSqliteDatabase(join(root, "state.sqlite"));
  migrateDatabase(db, defaultSettings);
  const repositories = createSqliteRepositories(db, defaultSettings);
  t.after(async () => {
    repositories.close();
    await rm(root, { recursive: true, force: true });
  });
  const { inspectRetainedFile } = await import("../dist/application/tv-replacement-quarantine.js");
  const { quarantineReplacementOriginal, reconcileReplacementTransaction, reconcileReplacementTransactions,
    replaceOccupiedOriginal, executeReplacementTransaction } =
    await import("../dist/application/tv-replacement-executor.js");
  const existing = {
    outputPath: originalPath, fingerprint: "old", discLabel: "Disc 1", discNumber: 1, trackId: "7",
    trackTitle: "Old", seriesName: "Show", metadataProvider: "manual", providerId: null,
    seasonNumber: 1, episodeNumber: 7, confirmedAt: "2026-01-01", publishedAt: "2026-01-02"
  };
  const incoming = {
    fingerprint: "new", discLabel: "Disc 2", trackId: "1", trackTitle: "New", confirmedAt: "2026-01-03"
  };
  const transaction = {
    id: "tx", jobId: "job", state: "created", createdAt: "2026-01-04", updatedAt: "2026-01-04",
    originalPath, replacementPath: originalPath, quarantinePath, originalChecksum: null,
    replacementChecksum: null, existing, incoming, failure: null
  };
  const snapshot = {
    candidatePath, stagedSourcePath, existingPublications: [existing],
    replacementPublications: [{ ...existing, ...incoming }], conflict: {},
    decisionBy: "admin", provenanceStatus: "verified"
  };
  const profile = defaultSettings.outputDestinations.profiles[0];
  const settings = {
    ...defaultSettings, workDir, tvRootDir: library, moviesDir: join(root, "movies"),
    musicDir: join(root, "music"), lidarrImportDir: "",
    outputDestinations: {
      activeProfileId: profile.id,
      profiles: [{
        ...profile, jellyfin: { root: "", paths: { tv: "", movies: "", music: "" } },
        sonarr: { seriesRoot: "" }, radarr: { movieRoot: "" }, lidarr: { artistRoot: "" },
        folder: { tv: "", movies: "", music: "" }
      }]
    }
  };
  repositories.settings.save(settings);
  repositories.tvEpisodePublications.record([existing]);
  const journal = repositories.tvConflictJournal;
  journal.createReplacementTransaction(transaction, snapshot);
  journal.recordCandidateReady("tx", {
    original: await inspectRetainedFile(originalPath), candidate: await inspectRetainedFile(candidatePath),
    stagedSource: await inspectRetainedFile(stagedSourcePath)
  });
  if (originalState === "executor") {
    await executeReplacementTransaction(journal, settings, "tx");
  } else {
    await quarantineReplacementOriginal(journal, settings, "tx");
  }
  if (originalState === "missing") await rm(originalPath);
  if (originalState === "replacement") await replaceOccupiedOriginal(journal, settings, "tx");
  if (originalState.startsWith("crash-")) {
    const executor = new URL("../dist/application/tv-replacement-executor.js", import.meta.url).href;
    const connection = new URL("../dist/infrastructure/database/connection.js", import.meta.url).href;
    const factory = new URL("../dist/infrastructure/database/repositories.js", import.meta.url).href;
    const defaults = new URL("../dist/infrastructure/database/default-settings.js", import.meta.url).href;
    const recoveryModule = new URL("../dist/recovery.js", import.meta.url).href;
    const script = `
      import { replaceOccupiedOriginal } from ${JSON.stringify(executor)};
      import { recoverTemporaryFiles } from ${JSON.stringify(recoveryModule)};
      import { openSqliteDatabase } from ${JSON.stringify(connection)};
      import { createSqliteRepositories } from ${JSON.stringify(factory)};
      import { defaultSettings } from ${JSON.stringify(defaults)};
      const db = openSqliteDatabase(process.argv[1]);
      const repositories = createSqliteRepositories(db, defaultSettings);
      if (process.argv[3] === "after-quarantine") process.kill(process.pid, "SIGKILL");
      if (process.argv[3] === "completion") {
        db.function("crash_during_completion", () => { process.kill(process.pid, "SIGKILL"); return 0; });
        db.exec("CREATE TEMP TRIGGER crash_completion BEFORE UPDATE OF state ON tv_replacement_transactions WHEN NEW.state = 'completed' BEGIN SELECT crash_during_completion(); END");
      }
      await replaceOccupiedOriginal(repositories.tvConflictJournal, JSON.parse(process.argv[2]), "tx", (step) => {
        if (step === process.argv[3]) process.kill(process.pid, "SIGKILL");
      });
      if (process.argv[3] === "completion") {
        await recoverTemporaryFiles(repositories);
      }
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script,
      join(root, "state.sqlite"), JSON.stringify(settings), originalState.slice("crash-".length)]);
    assert.equal(child.signal, "SIGKILL", child.stderr.toString());
    assert.equal(journal.getTransaction("tx").state,
      ["crash-after-journal", "crash-completion"].includes(originalState) ? "published" : "quarantined");
    const recoveryScript = `
      import { recoverTemporaryFiles } from ${JSON.stringify(recoveryModule)};
      import { openSqliteDatabase } from ${JSON.stringify(connection)};
      import { createSqliteRepositories } from ${JSON.stringify(factory)};
      import { defaultSettings } from ${JSON.stringify(defaults)};
      const repositories = createSqliteRepositories(openSqliteDatabase(process.argv[1]), defaultSettings);
      await recoverTemporaryFiles(repositories);
      await recoverTemporaryFiles(repositories);
      repositories.close();
    `;
    const recovery = spawnSync(process.execPath, ["--input-type=module", "-e", recoveryScript,
      join(root, "state.sqlite")]);
    assert.equal(recovery.status, 0, recovery.stderr.toString());
    const expected = ["crash-after-quarantine", "crash-before-publication"].includes(originalState)
      ? "rolled_back" : "completed";
    assert.equal(journal.getTransaction("tx").state, expected);
  }
  const replaced = ["replacement", "crash-after-publication", "crash-after-journal", "crash-completion", "executor"].includes(originalState);
  const outcome = replaced ? "completed" : "rolled_back";
  assert.deepEqual(await reconcileReplacementTransactions(journal, settings),
    originalState === "executor" || originalState.startsWith("crash-") ? [] : [{ id: "tx", outcome }]);
  assert.deepEqual(await reconcileReplacementTransactions(journal, settings), []);
  assert.equal((await reconcileReplacementTransaction(journal, settings, "tx")).outcome, outcome);
  assert.equal(journal.getTransaction("tx").state, outcome);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tv_replacement_claims WHERE transaction_id = ?").get("tx").count, 0);
  assert.deepEqual(await readFile(originalPath), replaced ? candidateBytes : originalBytes);
  assert.deepEqual(await readFile(quarantinePath), originalBytes);
  assert.deepEqual(await readFile(candidatePath), candidateBytes);
  assert.equal(await readFile(stagedSourcePath, "utf8"), "staged source");
  assert.equal(repositories.tvEpisodePublications.listForSeason(1)[0].fingerprint,
    replaced ? "new" : "old");
});
