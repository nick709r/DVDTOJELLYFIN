import assert from "node:assert/strict";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { executableAvailable } from "../dist/executable.js";

test("executable detection resolves commands on PATH without requiring a version flag", async () => {
  const executable = basename(process.execPath);
  assert.equal(await executableAvailable(executable, dirname(process.execPath)), true);
  assert.equal(await executableAvailable("autodisc-command-that-does-not-exist", dirname(process.execPath)), false);
  assert.equal(await executableAvailable(join(dirname(process.execPath), "missing-executable")), false);
});
