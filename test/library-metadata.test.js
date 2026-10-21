import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultSettings } from "../dist/infrastructure/database/default-settings.js";
import {
  downloadArtwork,
  libraryTemplate,
  renderLibraryTemplate,
  renderNfo,
  writeNfo
} from "../dist/library-metadata.js";

test("library templates render safe components and zero-pad numeric values", () => {
  const settings = defaultSettings.libraryMetadata;
  assert.equal(libraryTemplate(settings, "episodeFileTemplate"), settings.episodeFileTemplate);
  assert.equal(renderLibraryTemplate("{Series Name} - S{Season:00}E{Episode:00} - {Episode Title}", {
    "Series Name": "Example/Show",
    Season: 1,
    Episode: 3,
    "Episode Title": "Pilot"
  }), "Show - S01E03 - Pilot");
  assert.equal(renderLibraryTemplate("{Movie Title} ({Year})", { "Movie Title": "Movie", Year: null }), "Movie");
  assert.throws(() => renderLibraryTemplate("{Title}", { Title: "Unknown" }), /unsupported token/);
});

test("NFO output is escaped, includes configured metadata, and never overwrites a manual file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autodisc-nfo-test-"));
  try {
    const document = renderNfo("movie", {
      title: "A < B & C",
      year: 2024,
      provider: "tmdb",
      providerId: "123",
      rating: 8.2,
      genres: ["Drama & Comedy"],
      cast: ["Actor <One>"]
    }, defaultSettings.libraryMetadata);
    assert.match(document, /A &lt; B &amp; C/);
    assert.match(document, /<uniqueid type="tmdb">123<\/uniqueid>/);
    assert.match(document, /<ratings>/);
    assert.match(document, /Actor &lt;One&gt;/);
    const path = await writeNfo(directory, "movie.nfo", "movie", { title: "First" }, defaultSettings.libraryMetadata);
    assert.ok(path);
    await writeNfo(directory, "movie.nfo", "movie", { title: "Second" }, defaultSettings.libraryMetadata);
    assert.match(await readFile(path, "utf8"), /First/);
    assert.doesNotMatch(await readFile(path, "utf8"), /Second/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("artwork downloads require approved HTTPS hosts and preserve actual image format", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autodisc-artwork-test-"));
  try {
    const settings = defaultSettings.libraryMetadata;
    const saved = await downloadArtwork(directory, [{
      kind: "poster",
      url: "https://image.tmdb.org/t/p/original/poster"
    }], settings, async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "image/png" }
    }));
    assert.deepEqual(saved, [join(directory, "poster.png")]);
    assert.deepEqual([...await readFile(saved[0])], [1, 2, 3]);
    await assert.rejects(downloadArtwork(directory, [{
      kind: "poster",
      url: "https://example.invalid/poster.jpg"
    }], settings), /not permitted/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("automatic import and per-category options default on without enabling provider lookups", () => {
  assert.equal(defaultSettings.libraryMetadata.automaticImport, true);
  assert.equal(defaultSettings.libraryMetadata.downloadArtwork, true);
  assert.equal(defaultSettings.libraryMetadata.generateNfo, true);
  assert.equal(defaultSettings.metadataEnabled, false);
  assert.equal(defaultSettings.musicMetadataEnabled, false);
  assert.equal(defaultSettings.tvMetadataLookupEnabled, false);
});
