import assert from "node:assert/strict";
import test from "node:test";

test("encoder capability check reports a missing FFmpeg executable without failing the request", async () => {
  process.env.FFMPEG_COMMAND = "autodisc-test-missing-ffmpeg";
  const { availableEncoders } = await import("../dist/encoding.js");
  const result = await availableEncoders();

  assert.equal(result.nvidia, false);
  assert.equal(result.software, false);
  assert.match(result.error, /FFmpeg encoder check failed/);
});
