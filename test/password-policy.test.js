import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("simple passwords are accepted and migrated administrators must choose a new password", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autodisc-pw-"));
  process.env.DATABASE_PATH = path.join(root, "state.sqlite");
  process.env.MOVIES_DIR = root;
  process.env.WORK_DIR = root;
  const { app } = await import("../dist/server.js");
  const { db, repositories } = await import("../dist/db.js");

  const tooShort = await app.inject({
    method: "POST",
    url: "/api/v1/setup",
    payload: { username: "admin", password: "abc", confirmPassword: "abc" }
  });
  assert.equal(tooShort.statusCode, 400);
  const setup = await app.inject({
    method: "POST",
    url: "/api/v1/setup",
    payload: { username: "admin", password: "abcd", confirmPassword: "abcd" }
  });
  assert.equal(setup.statusCode, 201);
  assert.equal(repositories.setup.get().passwordChangeRequired, false);

  // Simulate an installation upgraded by migration 23.
  db.prepare("UPDATE setup_state SET password_change_required = 1 WHERE id = 1").run();
  const login = await app.inject({ method: "POST", url: "/api/v1/login", payload: { username: "admin", password: "abcd" } });
  assert.equal(login.statusCode, 200);
  assert.equal(login.json().passwordChangeRequired, true);
  const cookie = login.headers["set-cookie"].split(";")[0];
  const authed = (options) => app.inject({ ...options, headers: { cookie } });

  const blocked = await authed({ method: "GET", url: "/api/v1/settings" });
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.json().passwordChangeRequired, true);

  const same = await authed({ method: "POST", url: "/api/v1/account/password", payload: { password: "abcd", confirmPassword: "abcd" } });
  assert.equal(same.statusCode, 400);
  const short = await authed({ method: "POST", url: "/api/v1/account/password", payload: { password: "xyz", confirmPassword: "xyz" } });
  assert.equal(short.statusCode, 400);
  const mismatch = await authed({ method: "POST", url: "/api/v1/account/password", payload: { password: "wxyz", confirmPassword: "wxy2" } });
  assert.equal(mismatch.statusCode, 400);
  const changed = await authed({ method: "POST", url: "/api/v1/account/password", payload: { password: "wxyz", confirmPassword: "wxyz" } });
  assert.equal(changed.statusCode, 200);

  assert.equal((await authed({ method: "GET", url: "/api/v1/settings" })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/login", payload: { username: "admin", password: "abcd" } })).statusCode, 401);
  const relogin = await app.inject({ method: "POST", url: "/api/v1/login", payload: { username: "admin", password: "wxyz" } });
  assert.equal(relogin.statusCode, 200);
  assert.equal(relogin.json().passwordChangeRequired, false);
});
