import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDiscName, searchVariants } from "../dist/application/tv-name-normalization.js";
import { MetadataResolver } from "../dist/application/metadata-resolver.js";
import { TvWorkflowService } from "../dist/application/tv-workflow-service.js";

test("disc names normalize to the same title", () => {
  for (const raw of ["fresh-off-the-boat", "Fresh_Off_The_Boat", "FRESH OFF THE BOAT"]) {
    assert.equal(normalizeDiscName(raw), "Fresh Off The Boat");
  }
  assert.equal(normalizeDiscName("Fresh_Off_The_Boat_S3_D1"), "Fresh Off The Boat");
  assert.equal(normalizeDiscName("DVD_VIDEO"), "");
  assert.ok(searchVariants("fresh-off-the-boat").includes("Fresh Off The Boat"));
});

function service(queries, seriesSearch) {
  const resolver = new MetadataResolver([]);
  return new TvWorkflowService(
    resolver,
    { findForItemSignature: () => [] },
    { save: (plan) => ({ ...plan, id: "p1", createdAt: "2026-01-01T00:00:00.000Z", state: "awaiting-review" }) },
    undefined, undefined, undefined,
    { seriesSearch: async (query) => { queries.push(query); return seriesSearch(query); } }
  );
}

function source(label, attributes = {}) {
  return {
    sourceId: "d", providerId: "source.video-dvd.makemkv", mediaKind: "dvd", label,
    manifest: {
      mediaKind: "dvd", attributes,
      items: [1, 2, 3, 4].map((id) => ({ id: String(id), kind: "title", title: `T${id}`, durationSeconds: 1300 }))
    }
  };
}

test("empty label still searches using the filesystem volume name", async () => {
  const queries = [];
  const svc = service(queries, () => []);
  const result = await svc.prepare(source("", { filesystemVolumeName: "fresh-off-the-boat" }), "fp");
  assert.ok(queries.includes("Fresh Off The Boat"), JSON.stringify(queries));
  assert.ok(result.identification.steps.length >= 10);
});

test("identification queries every usable name source without an arbitrary query cap", async () => {
  const queries = [];
  const svc = service(queries, () => []);
  const result = await svc.prepare(source("The Galactic Chronicles: Lost Years (2019) Season 2 Disc 1", {
    filesystemVolumeName: "Different Show: The Second (2021)",
    makemkvDiscName: "Another Name: Revival (2020)",
    dvdTitle: "Fourth Series: Beyond (2015)"
  }), "fp");
  assert.ok(result.identification.queries.length > 8, JSON.stringify(result.identification.queries));
  assert.deepEqual(new Set(result.identification.queries.map((query) => query.nameSource)), new Set([
    "Optical disc volume label",
    "Filesystem volume name",
    "MakeMKV disc name",
    "DVD metadata"
  ]));
});
