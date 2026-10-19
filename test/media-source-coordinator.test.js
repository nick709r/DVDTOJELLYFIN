import assert from "node:assert/strict";
import test from "node:test";
import { MediaSourceCoordinator } from "../dist/application/media-source-coordinator.js";

function createProvider(id, candidate, acquired) {
  return {
    describe: () => ({
      id,
      apiVersion: "1.0.0",
      kind: "source",
      capabilities: ["video.disc.dvd"]
    }),
    initialize: async () => {},
    healthCheck: async () => ({ status: "available" }),
    dispose: async () => {},
    inspect: async () => candidate,
    acquire: async (...args) => {
      if (acquired instanceof Error) throw acquired;
      return acquired(...args);
    }
  };
}

test("source coordinator probes in order and dispatches acquisition to the selected provider", async () => {
  const probes = [];
  const dvdCandidate = {
    providerId: "source.dvd",
    mediaKind: "dvd",
    sourceId: "drive-1",
    label: "Movie",
    manifest: { mediaKind: "dvd", items: [] }
  };
  const acquisition = {
    source: { id: "drive-1", providerId: "source.dvd", kind: "dvd" },
    artifacts: [{ id: "movie", kind: "video", path: "workspace/movie.mkv" }]
  };
  const first = createProvider("source.audio", null, () => {
    throw new Error("audio provider must not acquire");
  });
  first.inspect = async () => {
    probes.push("source.audio");
    return null;
  };
  const second = createProvider("source.dvd", dvdCandidate, async (candidate, workspace, options, signal) => {
    probes.push("source.dvd.acquire");
    assert.equal(candidate, dvdCandidate);
    assert.equal(workspace, "workspace");
    assert.deepEqual(options, { selection: { manifestItemId: "3" } });
    assert.equal(signal, undefined);
    return acquisition;
  });
  second.inspect = async (sourceId) => {
    probes.push(`source.dvd:${sourceId}`);
    return dvdCandidate;
  };

  const coordinator = new MediaSourceCoordinator([first, second]);
  const inspected = await coordinator.inspect("drive-1");
  assert.equal(inspected.provider, second);
  assert.equal(inspected.candidate, dvdCandidate);
  assert.deepEqual(probes, ["source.audio", "source.dvd:drive-1"]);
  assert.equal(await coordinator.acquire(inspected, "workspace", {
    selection: { manifestItemId: "3" }
  }), acquisition);
  assert.deepEqual(probes, ["source.audio", "source.dvd:drive-1", "source.dvd.acquire"]);
});

test("source coordinator rejects providers returning candidates with mismatched identity", async () => {
  const provider = createProvider("source.dvd", {
    providerId: "source.other",
    mediaKind: "dvd",
    sourceId: "drive-1",
    label: "",
    manifest: { mediaKind: "dvd", items: [] }
  }, () => ({ source: { id: "drive-1", providerId: "source.dvd", kind: "dvd" }, artifacts: [] }));
  const coordinator = new MediaSourceCoordinator([provider]);

  await assert.rejects(coordinator.inspect("drive-1"), /mismatched identity/);
});

test("source coordinator requires at least one configured provider", () => {
  assert.throws(() => new MediaSourceCoordinator([]), /At least one media source provider/);
});

test("source coordinator logs when no provider recognizes the inserted media", async () => {
  const provider = createProvider("source.video-dvd.makemkv", null, () => {
    throw new Error("No source candidate should be acquired");
  });
  const messages = [];
  const originalWarn = console.warn;
  console.warn = (message) => messages.push(JSON.parse(message));
  try {
    const coordinator = new MediaSourceCoordinator([provider]);
    assert.equal(await coordinator.inspect("/dev/sr0"), null);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(messages.length, 1);
  assert.equal(messages[0].message, "No registered source provider recognized the inserted media");
  assert.deepEqual(messages[0].attemptedProviders, ["source.video-dvd.makemkv"]);
});

test("source coordinator accepts a media kind unknown to core orchestration", async () => {
  const candidate = {
    providerId: "source.future",
    sourceId: "watch-folder-1",
    mediaKind: "uhd_bluray",
    label: "Future media",
    manifest: { mediaKind: "uhd_bluray", items: [{ id: "playlist-1", kind: "program" }] }
  };
  const acquired = {
    source: { id: "watch-folder-1", providerId: "source.future", kind: "uhd_bluray" },
    artifacts: [{ id: "feature-1", kind: "video", path: "workspace/feature.mkv" }]
  };
  const provider = createProvider("source.future", candidate, () => acquired);
  const coordinator = new MediaSourceCoordinator([provider]);

  const inspected = await coordinator.inspect("watch-folder-1");
  assert.equal(inspected.candidate.mediaKind, "uhd_bluray");
  assert.equal(await coordinator.acquire(inspected, "workspace"), acquired);
});
