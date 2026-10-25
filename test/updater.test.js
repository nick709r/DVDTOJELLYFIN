import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("AutoDisc update versions compare numerically and reject invalid tags", async () => {
  const { compareVersions } = await import("../dist/updater.js");

  assert.equal(compareVersions("v1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.0.0", "v1.0.0"), 0);
  assert.equal(compareVersions("1.0.0", "1.0.1"), -1);
  assert.throws(() => compareVersions("main", "1.0.0"), /Invalid AutoDisc version/);
});

test("update check selects the highest stable version tag and ignores other tags", async () => {
  const { checkForUpdate } = await import("../dist/updater.js");
  let requestedUrl = "";
  const result = await checkForUpdate(async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify([
      { name: "v1.9.0" },
      { name: "v1.10.0" },
      { name: "v1.11.0" },
      { name: "v1.12.0" },
      { name: "v1.13.0" },
      { name: "v1.14.0" },
      { name: "v1.15.2" },
      { name: "v1.16.0" },
      { name: "v1.17.0" },
      { name: "v1.18.0" },
      { name: "v1.19.0" },
      { name: "v1.20.0" },
      { name: "v1.21.0" },
      { name: "v1.22.0" },
      { name: "v2.0.0-rc.1" },
      { name: "main" },
      { name: 2 }
    ]), { status: 200, headers: { "Content-Type": "application/json" } });
  });

  assert.equal(requestedUrl, "https://api.github.com/repos/nick709r/DVDTOJELLYFIN/tags?per_page=100");
  assert.equal(result.currentVersion, "1.22.0");
  assert.equal(result.latestVersion, "v1.22.0");
  assert.equal(result.updateAvailable, false);
});

test("release notes fall back to the matching README release section", async () => {
  const { getReleaseNotes } = await import("../dist/updater.js");
  const result = await getReleaseNotes("v1.5.1", async (input) => {
    if (String(input).includes("/releases/tags/")) return new Response("", { status: 404 });
    return new Response([
      "# AutoDisc",
      "## Release history",
      "### Version 1.5.1",
      "- Fix audio CD detection.",
      "- Check configured paths.",
      "### Version 1.5.0",
      "- Add home-network access."
    ].join("\n"), { status: 200 });
  });

  assert.equal(result.releaseNotesSource, "readme");
  assert.match(result.releaseNotesUrl, /\/blob\/v1\.5\.1\/README\.md$/);
  assert.equal(result.releaseNotes, "- Fix audio CD detection.\n- Check configured paths.");
});

test("update status reads only recognized state values", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autodisc-updater-"));
  const statusPath = path.join(root, "updater", "status");
  await mkdir(path.dirname(statusPath));
  process.env.AUTODISC_UPDATE_STATUS_PATH = statusPath;
  try {
    const { getUpdateStatus } = await import(`../dist/updater.js?status-test=${Date.now()}`);
    assert.equal(await getUpdateStatus(), "idle");
    await writeFile(statusPath, "applying\n");
    assert.equal(await getUpdateStatus(), "applying");
    await writeFile(statusPath, "unexpected\n");
    await assert.rejects(getUpdateStatus(), /invalid status/);
    assert.equal(await readFile(statusPath, "utf8"), "unexpected\n");
  } finally {
    delete process.env.AUTODISC_UPDATE_STATUS_PATH;
    await rm(root, { recursive: true, force: true });
  }
});

test("update requests accept only version tags and can be queued once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autodisc-update-request-"));
  const requestPath = path.join(root, "request");
  const statusPath = path.join(root, "updater", "status");
  const unitPath = path.join(root, "autodisc-update.path");
  await mkdir(path.dirname(requestPath), { recursive: true });
  await writeFile(unitPath, "[Path]\n");
  process.env.AUTODISC_UPDATE_REQUEST_PATH = requestPath;
  process.env.AUTODISC_UPDATE_STATUS_PATH = statusPath;
  process.env.AUTODISC_UPDATE_UNIT_PATH = unitPath;
  try {
    const updater = await import(`../dist/updater.js?queue-test=${Date.now()}`);
    await assert.rejects(updater.queueUpdate("main"), /Invalid AutoDisc update version/);
    await updater.queueUpdate("v1.2.0");
    assert.equal(await readFile(requestPath, "utf8"), "v1.2.0\n");
    assert.equal(updater.isUpdatePending(), true);
    await assert.rejects(updater.queueUpdate("v1.3.0"), /already queued/);
    updater.clearUpdatePending();
  } finally {
    delete process.env.AUTODISC_UPDATE_REQUEST_PATH;
    delete process.env.AUTODISC_UPDATE_STATUS_PATH;
    delete process.env.AUTODISC_UPDATE_UNIT_PATH;
    await rm(root, { recursive: true, force: true });
  }
});
