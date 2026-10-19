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
    mediaType: "dvd",
    sourceId: "drive-1",
    label: "Movie",
    titles: []
  };
  const acquisition = { mediaType: "dvd", path: "workspace/movie.mkv" };
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
    assert.deepEqual(options, { titleId: 3 });
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
  assert.equal(await coordinator.acquire(inspected, "workspace", { titleId: 3 }), acquisition);
  assert.deepEqual(probes, ["source.audio", "source.dvd:drive-1", "source.dvd.acquire"]);
});

test("source coordinator rejects providers returning candidates with mismatched identity", async () => {
  const provider = createProvider("source.dvd", {
    providerId: "source.other",
    mediaType: "dvd",
    sourceId: "drive-1",
    label: "",
    titles: []
  }, () => ({ mediaType: "dvd", path: "unused" }));
  const coordinator = new MediaSourceCoordinator([provider]);

  await assert.rejects(coordinator.inspect("drive-1"), /mismatched identity/);
});

test("source coordinator requires at least one configured provider", () => {
  assert.throws(() => new MediaSourceCoordinator([]), /At least one media source provider/);
});
