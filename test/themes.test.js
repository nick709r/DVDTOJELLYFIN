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

test("v2 keeps every v1.37.0 screen hook, form field, page and navigation target", async () => {
  const html = await read("../web/index.html");
  for (const [kind, expected] of Object.entries(baseline)) {
    const present = attrs(html, kind);
    const missing = expected.filter((value) => !present.has(value));
    assert.deepEqual(missing, [], `${kind} values removed since v1.37.0`);
  }
  const extraIds = [...attrs(html, "id")].filter((id) => !baseline.id.includes(id));
  assert.deepEqual(extraIds, ["theme-select"], "the theme picker is the only new element");
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
