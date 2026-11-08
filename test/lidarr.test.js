import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { importAlbumToLidarr, testLidarrConnection, validateLidarrUrl } from "../dist/lidarr.js";

function matchedItem(id, path) {
  return {
    id,
    path,
    name: `Track ${id}`,
    artist: { id: 11 },
    album: { id: 22, path: "/srv/jellyfin/Music/Artist/Album" },
    albumReleaseId: 33,
    tracks: [{ id: id + 100 }]
  };
}

test("Lidarr URLs are validated and normalized without credentials", () => {
  assert.equal(validateLidarrUrl("http://localhost:8686/"), "http://localhost:8686");
  assert.equal(validateLidarrUrl("http://192.168.1.50:8686/"), "http://192.168.1.50:8686");
  assert.equal(validateLidarrUrl("http://[::1]:8686/"), "http://[::1]:8686");
  assert.equal(validateLidarrUrl("https://music.example/lidarr/"), "https://music.example/lidarr");
  assert.throws(() => validateLidarrUrl("ftp://localhost:8686"), /HTTP or HTTPS/);
  const credentialUrl = new URL("http://localhost:8686");
  credentialUrl.username = "user";
  credentialUrl.password = "pass";
  assert.throws(() => validateLidarrUrl(credentialUrl.toString()), /credentials/);
});

test("Lidarr requests do not follow redirects or disclose the API key", async () => {
  let redirected = 0;
  const destination = createServer((_req, res) => { redirected++; res.end("{}"); });
  await new Promise((resolve) => destination.listen(0, "127.0.0.1", resolve));
  const source = createServer((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${destination.address().port}/` });
    res.end();
  });
  await new Promise((resolve) => source.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(testLidarrConnection({
      url: `http://127.0.0.1:${source.address().port}`,
      apiKey: "secret-key"
    }), /Could not reach Lidarr/);
    assert.equal(redirected, 0);
  } finally {
    await Promise.all([
      new Promise((resolve, reject) => source.close((error) => error ? reject(error) : resolve())),
      new Promise((resolve, reject) => destination.close((error) => error ? reject(error) : resolve()))
    ]);
  }
});

test("Lidarr connection test sends the API key without exposing it in the result", async () => {
  let request;
  const result = await testLidarrConnection(
    { url: "http://localhost:8686", apiKey: "secret-key" },
    async (url, init) => {
      request = { url: String(url), key: new Headers(init?.headers).get("X-Api-Key") };
      return Response.json({ version: "2.0.0" });
    }
  );

  assert.deepEqual(result, { version: "2.0.0" });
  assert.equal(request.url, "http://localhost:8686/api/v1/system/status");
  assert.equal(request.key, "secret-key");
});

test("Lidarr imports tracks only after matching their named files and moves them into its library", async () => {
  const folder = "/var/cache/autodisc/lidarr-import/Artist - Album";
  const tracks = [`${folder}/01 - Intro.flac`, `${folder}/02 - Finale.flac`];
  const candidates = tracks.map((path, index) => matchedItem(index + 1, path));
  const requests = [];
  const result = await importAlbumToLidarr(
    { url: "http://localhost:8686", apiKey: "secret-key" },
    folder,
    tracks,
    undefined,
    async (url, init) => {
      const target = new URL(String(url));
      assert.equal(init.redirect, "error");
      requests.push({ target, init });
      if (target.pathname.endsWith("/manualimport") && init?.method === "POST") {
        return Response.json(candidates);
      }
      if (target.pathname.endsWith("/manualimport")) return Response.json(candidates);
      if (target.pathname.endsWith("/command") && init?.method === "POST") return Response.json({ id: 55 }, { status: 201 });
      if (target.pathname.endsWith("/command/55")) return Response.json({ id: 55, status: "completed" });
      throw new Error(`Unexpected Lidarr request ${target}`);
    }
  );

  assert.deepEqual(result, { imported: 2, albumPath: "/srv/jellyfin/Music/Artist/Album" });
  assert.equal(requests[0].target.searchParams.get("folder"), folder);
  assert.equal(requests[0].target.searchParams.get("filterExistingFiles"), "false");
  const command = requests.find(({ target, init }) => target.pathname.endsWith("/command") && init?.method === "POST");
  assert.ok(command);
  assert.equal(new Headers(command.init.headers).get("X-Api-Key"), "secret-key");
  const payload = JSON.parse(command.init.body);
  assert.equal(payload.importMode, "Move");
  assert.deepEqual(payload.files.map((file) => file.path), tracks);
  assert.deepEqual(payload.files.map((file) => file.trackIds), [[101], [102]]);
});

test("Lidarr leaves unmatched named files unsubmitted", async () => {
  let requestCount = 0;
  await assert.rejects(
    importAlbumToLidarr(
      { url: "http://localhost:8686", apiKey: "secret-key" },
      "/incoming/Unknown Album",
      ["/incoming/Unknown Album/01 - Track 01.flac"],
      undefined,
      async () => {
        requestCount += 1;
        return Response.json([{
          id: 1,
          path: "/incoming/Unknown Album/01 - Track 01.flac",
          name: "01 - Track 01",
          rejections: [{ reason: "No match" }]
        }]);
      }
    ),
    /could not match/
  );
  assert.equal(requestCount, 1);
});
