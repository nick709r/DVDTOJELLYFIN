import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { restoreQuarantinedFile } from "../dist/application/tv-replacement-rollback.js";

test("rollback restores a verified quarantine copy and is idempotent", {
  skip: process.platform !== "linux"
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "autodisc-rollback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = join(root, "original.mkv");
  const quarantine = join(root, "quarantine.mkv");
  const candidate = join(root, "candidate.mkv");
  const contents = Buffer.alloc(1024 * 1024 + 17, 91);
  const evidence = { checksum: createHash("sha256").update(contents).digest("hex"), size: BigInt(contents.length) };
  await writeFile(quarantine, contents);
  await writeFile(candidate, "replacement");
  await restoreQuarantinedFile(original, quarantine, evidence);
  await restoreQuarantinedFile(original, quarantine, evidence);
  assert.deepEqual(await readFile(original), contents);
  assert.deepEqual(await readFile(quarantine), contents);
  assert.equal(await readFile(candidate, "utf8"), "replacement");
});

test("rollback refuses unexpected files and unverified quarantine copies", {
  skip: process.platform !== "linux"
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "autodisc-rollback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = join(root, "original.mkv");
  const quarantine = join(root, "quarantine.mkv");
  const evidence = { checksum: createHash("sha256").update("original").digest("hex"), size: 8n };
  await writeFile(quarantine, "original");
  await writeFile(original, "unexpected");
  await assert.rejects(restoreQuarantinedFile(original, quarantine, evidence), /verification failed/);
  assert.equal(await readFile(original, "utf8"), "unexpected");
  assert.equal(await readFile(quarantine, "utf8"), "original");
  await rm(original);
  await writeFile(quarantine, "tampered");
  await assert.rejects(restoreQuarantinedFile(original, quarantine, evidence), /verification failed/);
  await assert.rejects(readFile(original), { code: "ENOENT" });
  await rm(quarantine);
  await symlink(original, quarantine);
  await assert.rejects(restoreQuarantinedFile(original, quarantine, evidence), { code: "ELOOP" });
});

test("rollback can be retried after failure or process termination at its checkpoints", {
  skip: process.platform !== "linux"
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "autodisc-rollback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const quarantine = join(root, "quarantine.mkv");
  const contents = Buffer.alloc(65536, 37);
  const digest = createHash("sha256").update(contents).digest("hex");
  const evidence = { checksum: digest, size: BigInt(contents.length) };
  await writeFile(quarantine, contents);
  const moduleUrl = new URL("../dist/application/tv-replacement-rollback.js", import.meta.url).href;
  for (const step of ["quarantine-verified", "copy-created", "copy-copied", "copy-file-synced",
    "copy-verified", "copy-directory-synced", "restored"]) {
    const original = join(root, `${step}-error.mkv`);
    await assert.rejects(restoreQuarantinedFile(original, quarantine, evidence, (current) => {
      if (current === step) throw new Error(`injected ${step}`);
    }), new RegExp(`injected ${step}`));
    if (step === "copy-created") {
      await assert.rejects(restoreQuarantinedFile(original, quarantine, evidence), /verification failed/);
      assert.equal((await readFile(original)).length, 0);
    } else {
      await restoreQuarantinedFile(original, quarantine, evidence);
      assert.deepEqual(await readFile(original), contents);
    }

    const crashOriginal = join(root, `${step}-crash.mkv`);
    const script = `
      import { restoreQuarantinedFile } from ${JSON.stringify(moduleUrl)};
      await restoreQuarantinedFile(process.argv[1], process.argv[2],
        { checksum: process.argv[3], size: BigInt(process.argv[4]) },
        (step) => { if (step === process.argv[5]) process.kill(process.pid, "SIGKILL"); });
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script,
      crashOriginal, quarantine, digest, String(contents.length), step]);
    assert.equal(child.signal, "SIGKILL", child.stderr.toString());
    if (step === "copy-created") {
      await assert.rejects(restoreQuarantinedFile(crashOriginal, quarantine, evidence), /verification failed/);
      assert.equal((await readFile(crashOriginal)).length, 0);
    } else {
      await restoreQuarantinedFile(crashOriginal, quarantine, evidence);
      assert.deepEqual(await readFile(crashOriginal), contents);
    }
    assert.deepEqual(await readFile(quarantine), contents);
  }
});
