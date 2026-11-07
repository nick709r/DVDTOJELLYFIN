import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const baseline = JSON.parse(await read("./fixtures/v1.37.0-ui-hooks.json"));

function attrs(html, name) {
  return new Set([...html.matchAll(new RegExp(`${name}="([^"]+)"`, "g"))].map((match) => match[1]));
}

function loadEngine(savedTheme) {
  const store = new Map(savedTheme === undefined ? [] : [["autodisc-theme", savedTheme]]);
  const events = [];
  const root = { dataset: {}, style: {} };
  const sandbox = {
    document: { documentElement: root, dispatchEvent: (event) => events.push(event.detail.theme) },
    localStorage: { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } }
  };
  sandbox.window = sandbox;
  return read("../web/themes.js").then((source) => {
    vm.runInNewContext(source, sandbox);
    return { engine: sandbox.AutoDiscThemes, root, store, events };
  });
}

test("themes retain v1.37.0 hooks except for the merged identification navigation target", async () => {
  const html = await read("../web/index.html");
  for (const [kind, expected] of Object.entries(baseline)) {
    const present = attrs(html, kind);
    const missing = expected.filter((value) => !present.has(value) &&
      !(kind === "data-page" && value === "tv-analysis"));
    assert.deepEqual(missing, [], `${kind} values removed since v1.37.0`);
  }
  const extraIds = [...attrs(html, "id")].filter((id) => !baseline.id.includes(id));
  assert.deepEqual(extraIds, ["theme-select"], "the theme picker is the only new element");
});

test("TV analysis is available inside the Review Center instead of a separate page", async () => {
  const html = await read("../web/index.html");
  const script = await read("../web/app.js");
  assert.match(html, /data-page="tv-reviews"[^>]*>Review Center<\/button>/);
  assert.doesNotMatch(html, /data-page="tv-analysis"/);
  assert.match(html, /<section id="page-tv-reviews"[\s\S]*<details id="page-tv-analysis"/);
  assert.match(script, /\$\("#page-tv-analysis"\)\.open = true/);
  assert.doesNotMatch(script, /showPage\("tv-analysis"\)/);
});

test("staged TV and preserved review cards expose the confirmed Forget Disc action", async () => {
  const html = await read("../web/index.html");
  const script = await read("../web/app.js");
  assert.match(script, /forget-disc" data-job-id="\$\{escapeHtml\(task\.jobId\)\}"/);
  assert.match(script, /forget-disc" data-job-id="\$\{escapeHtml\(item\.originalJobId\)\}"/);
  assert.match(script, /forgetDiscDialog\.showModal\(\)/);
  assert.match(html, /Review records and staged media/);
  assert.match(html, /Published library files are not removed/);
});

test("Review Center labels action types and displays both sources of an episode conflict", async () => {
  const script = await read("../web/app.js");
  for (const label of ["Needs Match", "Needs Identification", "Episode Conflict", "Metadata Conflict",
    "Processing Warnings", "Needs User Decision"]) {
    assert.ok(script.includes(label), `${label} appears in the review UI`);
  }
  assert.match(script, /existing\.discLabel/);
  assert.match(script, /existing\.trackId/);
  assert.match(script, /conflict\.trackId/);
});

test("episode conflict provenance displays both sources without overstating verification", async () => {
  const script = await read("../web/app.js");
  const start = script.indexOf("function renderTvEpisodeConflict(");
  const end = script.indexOf("\nfunction renderTvMatchingTask(", start);
  assert.ok(start >= 0 && end > start);
  const sandbox = {
    escapeHtml: (value) => String(value).replace(/[&<>"']/g, (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char])
  };
  vm.runInNewContext(script.slice(start, end), sandbox);
  const task = {
    fingerprint: "new-disc",
    source: { label: "Disc 2" },
    assignments: [{ trackId: "1", title: "<Episode>", confirmed: true, confirmedAt: "new-confirmed" }]
  };
  const conflict = {
    seasonNumber: 1, episodeNumber: 7, trackId: "1", provenanceStatus: "verified",
    existing: {
      discLabel: "Disc 1", discNumber: 1, trackId: "7", trackTitle: "Blooper",
      fingerprint: "old-disc", confirmedAt: "old-confirmed", publishedAt: "old-published",
      outputPath: "Show & episode.mkv"
    }
  };
  const verified = sandbox.renderTvEpisodeConflict(conflict, task, 2);
  for (const value of ["Verified", "file contents are not verified", "old-disc", "new-disc",
    "old-confirmed", "old-published", "new-confirmed", "Disc 1", "Disc 2", "Verified — user-confirmed mapping",
    "&lt;Episode&gt;", "Show &amp; episode.mkv", "Replace Existing", "Keep Existing", "Keep Both", "Mark As Extras"]) {
    assert.ok(verified.includes(value), `${value} appears in the conflict display`);
  }
  const legacy = sandbox.renderTvEpisodeConflict({ ...conflict, provenanceStatus: "legacy" }, task, 2);
  assert.match(legacy, /Legacy.*unambiguous disc history/);
  const unknown = sandbox.renderTvEpisodeConflict({
    ...conflict, provenanceStatus: "unknown",
    existing: { outputPath: "episode.mkv" }
  }, { ...task, assignments: [] }, null);
  assert.match(unknown, /Unknown.*source could not be established/);
  assert.match(unknown, /Unknown disc/);
  assert.match(unknown, /Unknown — no recorded mapping confirmation/);
  assert.doesNotMatch(unknown, /old-confirmed|old-published|undefined/);
});

test("conflict history renders audit actions with escaped source and reviewer values", async () => {
  const script = await read("../web/app.js");
  const start = script.indexOf("function renderTvConflictHistory(");
  const end = script.indexOf("\nfunction renderTvMatchingTask(", start);
  assert.ok(start >= 0 && end > start);
  const sandbox = {
    escapeHtml: (value) => String(value).replace(/[&<>"']/g, (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char])
  };
  vm.runInNewContext(script.slice(start, end), sandbox);
  assert.equal(sandbox.renderTvConflictHistory([]), "");
  const markup = sandbox.renderTvConflictHistory([{
    action: "keep_both", seasonNumber: 1, episodeNumber: 7, at: "2026-01-01",
    decisionBy: "<admin>", provenanceStatus: "legacy",
    existing: { discLabel: "Disc 1", trackId: "7" },
    incoming: { discLabel: "<Disc 2>", trackId: "1" }
  }]);
  for (const value of ["Keep Both", "Season 1 Episode 7", "2026-01-01",
    "&lt;admin&gt;", "&lt;Disc 2&gt;", "Disc 1", "legacy"]) {
    assert.ok(markup.includes(value), `${value} appears in the audit history`);
  }
  assert.doesNotMatch(markup, /<admin>|<Disc 2>/);
});

test("the theme picker replaces the Light/Dark toggle and offers exactly the four themes", async () => {
  const html = await read("../web/index.html");
  const script = await read("../web/app.js");
  assert.doesNotMatch(html, /id="theme-toggle"/);
  assert.doesNotMatch(script, /theme-toggle|themeToggle/);
  assert.match(html, /<select id="theme-select"/);
  assert.match(html, /href="\/themes\.css"/);
  assert.match(html, /<script src="\/themes\.js"><\/script>/);
  const { engine } = await loadEngine();
  assert.deepEqual([...engine.themes.map((theme) => theme.label)],
    ["Modern Light", "Modern Dark", "Windows 95 Classic", "DOS Terminal"]);
});

test("theme engine applies, persists and migrates themes", async () => {
  const fresh = await loadEngine();
  assert.equal(fresh.engine.current(), "modern-dark");
  assert.equal(fresh.root.dataset.theme, "dark");

  assert.equal(fresh.engine.apply("win95"), "win95");
  assert.equal(fresh.root.dataset.theme, "win95");
  assert.equal(fresh.root.dataset.skin, "retro");
  assert.equal(fresh.store.get("autodisc-theme"), "win95");
  assert.equal(fresh.events.at(-1), "win95");

  fresh.engine.apply("dos");
  assert.equal(fresh.root.dataset.theme, "dos");
  assert.equal(fresh.root.style.colorScheme, "dark");

  fresh.engine.apply("modern-light");
  assert.equal(fresh.root.dataset.theme, "light");
  assert.equal(fresh.root.dataset.skin, "modern");

  assert.equal(fresh.engine.apply("not-a-theme"), "modern-dark");

  const legacyLight = await loadEngine("light");
  assert.equal(legacyLight.engine.current(), "modern-light");
  const legacyDark = await loadEngine("dark");
  assert.equal(legacyDark.engine.current(), "modern-dark");
  const saved = await loadEngine("dos");
  assert.equal(saved.root.dataset.theme, "dos");
});

test("themes are presentation only: no API, data, workflow or settings access", async () => {
  const engine = await read("../web/themes.js");
  const css = await read("../web/themes.css");
  assert.doesNotMatch(engine, /fetch\(|XMLHttpRequest|api\(|\/api\/|settings|EventSource/);
  assert.doesNotMatch(css, /display:\s*none\s*!important/i, "themes must not hide actions");
  for (const selector of ['data-theme="win95"', 'data-theme="dos"', 'data-skin="retro"']) {
    assert.ok(css.includes(selector), `${selector} styles exist`);
  }
  // The theme setting is a browser preference, never a persisted application setting.
  const script = await read("../web/app.js");
  assert.doesNotMatch(script, /autodisc-theme["'`]/);
  const server = await read("../src/server.ts");
  assert.doesNotMatch(server, /autodisc-theme|themes\.(js|css)/);
});

test("retro themes restyle without changing controls: DOS hides only the logo image behind a text brand", async () => {
  const css = (await read("../web/themes.css")).replace(/\/\*[\s\S]*?\*\//g, "");
  const hidden = [...css.matchAll(/([^{}]+)\{[^{}]*display:none[^{}]*\}/g)].map((match) => match[1].trim());
  const allowed = [
    ':root[data-theme="win95"] .topbar .eyebrow',
    ':root[data-theme="dos"] .brand img',
    ':root[data-skin="retro"] .nav-link.active:before',
    ':root[data-theme="win95"] .nav-group>summary:after',
    ':root[data-theme="dos"] .nav-group>summary:after'
  ];
  assert.deepEqual(hidden.filter((selector) => !allowed.includes(selector)), []);
});
