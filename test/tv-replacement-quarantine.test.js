import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { copyToQuarantine } from "../dist/application/tv-replacement-quarantine.js";

test("quarantine rejects unsupported platforms before touching media", {
  skip: process.platform === "linux"
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "autodisc-quarantine-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "original.mkv");
  const target = join(root, "quarantine.mkv");
  await writeFile(source, "original");
  await assert.rejects(copyToQuarantine(source, target), /supported Linux/);
  assert.equal(await readFile(source, "utf8"), "original");
  await assert.rejects(readFile(target), { code: "ENOENT" });
});

test("quarantine creates an exclusive verified copy and retains the original", {
  skip: process.platform !== "linux"
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "autodisc-quarantine-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "original.mkv");
  const target = join(root, "quarantine.mkv");
  const contents = Buffer.alloc(2 * 1024 * 1024 + 17, 91);
  await writeFile(source, contents);
  const result = await copyToQuarantine(source, target);
  assert.equal(result.size, BigInt(contents.length));
  assert.equal(result.checksum, createHash("sha256").update(contents).digest("hex"));
  assert.deepEqual(await readFile(source), contents);
  assert.deepEqual(await readFile(target), contents);
  await assert.rejects(copyToQuarantine(source, target), { code: "EEXIST" });
  assert.deepEqual(await readFile(source), contents);
  assert.deepEqual(await readFile(target), contents);
});

test("quarantine refuses symlink and hard-link sources without altering files", {
  skip: process.platform !== "linux"
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "autodisc-quarantine-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "original.mkv");
  const target = join(root, "quarantine.mkv");
  await writeFile(source, "original");
  await symlink(source, join(root, "symlink.mkv"));
  await assert.rejects(copyToQuarantine(join(root, "symlink.mkv"), target), { code: "ELOOP" });
  await link(source, join(root, "hardlink.mkv"));
  await assert.rejects(copyToQuarantine(source, target), /additional hard links/);
  await assert.rejects(readFile(target), { code: "ENOENT" });
  assert.equal(await readFile(source, "utf8"), "original");
  await mkdir(join(root, "real-directory"));
  await symlink(join(root, "real-directory"), join(root, "directory-link"));
  await assert.rejects(copyToQuarantine(source, join(root, "directory-link", "copy.mkv")),
    /must not traverse symbolic links/);
});

test("quarantine failures and process crashes retain the original at every checkpoint", {
  skip: process.platform !== "linux"
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "autodisc-quarantine-faults-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "original.mkv");
  const contents = Buffer.alloc(1024 * 1024 + 1, 23);
  await writeFile(source, contents);
  const moduleUrl = new URL("../dist/application/tv-replacement-quarantine.js", import.meta.url).href;
  for (const step of ["created", "copied", "file-synced", "verified", "directory-synced"]) {
    const target = join(root, `${step}-error.mkv`);
    await assert.rejects(copyToQuarantine(source, target, (current) => {
      if (current === step) throw new Error(`injected ${step}`);
    }), new RegExp(`injected ${step}`));
    assert.deepEqual(await readFile(source), contents);

    const crashTarget = join(root, `${step}-crash.mkv`);
    const script = `
      import { copyToQuarantine } from ${JSON.stringify(moduleUrl)};
      await copyToQuarantine(process.argv[1], process.argv[2], (step) => {
        if (step === process.argv[3]) process.kill(process.pid, "SIGKILL");
      });
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, source, crashTarget, step]);
    assert.equal(child.signal, "SIGKILL", child.stderr.toString());
    assert.deepEqual(await readFile(source), contents);
    if (step !== "created") assert.deepEqual(await readFile(crashTarget), contents);
  }
});

test("quarantine rejects a changed original pathname without removing either file", {
  skip: process.platform !== "linux"
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "autodisc-quarantine-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "original.mkv");
  const saved = join(root, "saved.mkv");
  const target = join(root, "quarantine.mkv");
  await writeFile(source, "original");
  await assert.rejects(copyToQuarantine(source, target, (step) => {
    if (step === "verified") {
      renameSync(source, saved);
      writeFileSync(source, "unexpected file");
    }
  }), /changed during verification/);
  assert.equal(await readFile(source, "utf8"), "unexpected file");
  assert.equal(await readFile(saved, "utf8"), "original");
  assert.equal(await readFile(target, "utf8"), "original");
});
