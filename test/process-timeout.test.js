import assert from "node:assert/strict";
import test from "node:test";
import { runProcess, ProcessFailure } from "../dist/process.js";
import { defaultSettings } from "../dist/infrastructure/database/default-settings.js";
import { DEFAULT_MAKEMKV_DISCOVERY_ABSOLUTE_TIMEOUT_MS, DEFAULT_MAKEMKV_DISCOVERY_TIMEOUT_MS } from "../dist/media.js";

const node = process.execPath;
const script = (source) => ["-e", source];

test("the MakeMKV discovery timeout defaults to five minutes", () => {
  assert.equal(defaultSettings.makemkvDiscoveryTimeoutMs, 300_000);
  assert.equal(DEFAULT_MAKEMKV_DISCOVERY_TIMEOUT_MS, 300_000);
});

test("a process that finishes before the inactivity timeout succeeds", async () => {
  const result = await runProcess(node, script("console.log('done')"), { inactivityTimeoutMs: 5000 });
  assert.match(result.stdout, /done/);
});

test("the inactivity timeout is configurable and terminates a silent process", async () => {
  const started = Date.now();
  await assert.rejects(
    runProcess(node, script("setInterval(() => {}, 1000)"), { inactivityTimeoutMs: 300 }),
    (error) => error instanceof ProcessFailure && /timed out/.test(error.message)
  );
  assert.ok(Date.now() - started < 4000);
});

test("continuing output extends a run past the configured timeout", async () => {
  const chatty = "let n = 0; const t = setInterval(() => { console.log('PRGV:' + (++n)); if (n === 8) { clearInterval(t); } }, 100);";
  const started = Date.now();
  const result = await runProcess(node, script(chatty), { inactivityTimeoutMs: 400 });
  assert.ok(Date.now() - started > 400, "ran longer than the inactivity timeout");
  assert.match(result.stdout, /PRGV:8/);
});

test("output that stops is terminated after the inactivity timeout", async () => {
  const stalls = "console.log('started'); setInterval(() => {}, 1000);";
  await assert.rejects(
    runProcess(node, script(stalls), { inactivityTimeoutMs: 300 }),
    (error) => error instanceof ProcessFailure && /timed out/.test(error.message)
  );
});

test("the absolute timeout still applies when no inactivity timeout is given", async () => {
  const chatty = "setInterval(() => console.log('tick'), 50);";
  await assert.rejects(
    runProcess(node, script(chatty), { timeoutMs: 400 }),
    (error) => error instanceof ProcessFailure && /timed out/.test(error.message)
  );
});

test("start, completion and timeout are logged under the requested component", async () => {
  const records = [];
  const original = { info: console.info, warn: console.warn };
  console.info = (line) => records.push(JSON.parse(line));
  console.warn = (line) => records.push(JSON.parse(line));
  try {
    await runProcess(node, script("console.log('ok')"), {
      inactivityTimeoutMs: 5000,
      logging: { component: "makemkv", fields: { drive: "dev:/dev/sr0" } }
    });
    await runProcess(node, script("setInterval(() => {}, 1000)"), {
      inactivityTimeoutMs: 200,
      logging: { component: "makemkv", fields: { drive: "dev:/dev/sr0" } }
    }).catch(() => undefined);
  } finally {
    console.info = original.info;
    console.warn = original.warn;
  }
  const makemkv = records.filter((record) => record.component === "makemkv");
  const started = makemkv.find((record) => record.message === "Command started");
  assert.equal(started.drive, "dev:/dev/sr0");
  assert.equal(started.timeoutMs, 5000);
  const completed = makemkv.find((record) => record.message === "Command completed" && record.exitCode === 0);
  assert.equal(typeof completed.elapsedMs, "number");
  const killed = makemkv.find((record) => record.message === "Command killed due to inactivity timeout");
  assert.equal(killed.timeoutKind, "inactivity");
  assert.equal(killed.timeoutMs, 200);
  assert.equal(typeof killed.elapsedMs, "number");
  assert.equal(typeof killed.lastOutputAgeMs, "number");
});

const chattyForever = "setInterval(() => console.log('PRGV:1'), 50);";
const silentForever = "setInterval(() => {}, 1000);";
const timedOut = (error) => error instanceof ProcessFailure && /timed out/.test(error.message);

test("the absolute timeout stops a process whose continuous output keeps resetting the inactivity timer", async () => {
  const started = Date.now();
  await assert.rejects(
    runProcess(node, script(chattyForever), { inactivityTimeoutMs: 5000, timeoutMs: 500 }),
    timedOut
  );
  assert.ok(Date.now() - started < 4000, "terminated by the absolute limit, not the inactivity limit");
});

test("with both limits, a silent process is stopped by the inactivity timeout first", async () => {
  const started = Date.now();
  await assert.rejects(
    runProcess(node, script(silentForever), { inactivityTimeoutMs: 300, timeoutMs: 20_000 }),
    timedOut
  );
  assert.ok(Date.now() - started < 4000);
});

test("with both limits, a process that completes normally succeeds and leaves no timers running", async () => {
  const result = await runProcess(node, script("console.log('fine')"), { inactivityTimeoutMs: 5000, timeoutMs: 10_000 });
  assert.match(result.stdout, /fine/);
});

test("kills are logged as inactivity or absolute so they can be told apart", async () => {
  const records = [];
  const original = { info: console.info, warn: console.warn };
  console.info = (line) => records.push(JSON.parse(line));
  console.warn = (line) => records.push(JSON.parse(line));
  const logging = { component: "makemkv", fields: { drive: "dev:/dev/sr0" } };
  try {
    await runProcess(node, script(chattyForever), { inactivityTimeoutMs: 5000, timeoutMs: 400, logging }).catch(() => undefined);
    await runProcess(node, script(silentForever), { inactivityTimeoutMs: 200, timeoutMs: 20_000, logging }).catch(() => undefined);
  } finally {
    console.info = original.info;
    console.warn = original.warn;
  }
  const absolute = records.find((record) => record.message === "Command killed due to absolute timeout");
  assert.equal(absolute.timeoutKind, "absolute");
  assert.equal(absolute.timeoutMs, 400);
  assert.ok(absolute.lastOutputAgeMs < 400, "output was still flowing when the absolute limit hit");
  const inactivity = records.find((record) => record.message === "Command killed due to inactivity timeout");
  assert.equal(inactivity.timeoutMs, 200);
  const started = records.filter((record) => record.message === "Command started");
  assert.equal(started[0].absoluteTimeoutMs, 400);
  assert.equal(started[0].inactivityTimeoutMs, 5000);
});

test("MakeMKV discovery defaults to a 15 minute absolute limit", () => {
  assert.equal(defaultSettings.makemkvDiscoveryAbsoluteTimeoutMs, 900_000);
  assert.equal(DEFAULT_MAKEMKV_DISCOVERY_ABSOLUTE_TIMEOUT_MS, 900_000);
});
