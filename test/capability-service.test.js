import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityService } from "../dist/capability-service.js";

test("Windows capability report checks enumeration and handle permissions without ejecting", async () => {
  const root = await mkdtemp(join(tmpdir(), "autodisc-capabilities-"));
  try {
    const invocations = [];
    const service = new CapabilityService(() => ({
      opticalDevice: "D:",
      workDir: root
    }), {
      platform: "win32",
      isExecutableAvailable: async () => true,
      run: async (command, args) => {
        invocations.push({ command, args });
        return { stdout: "D:\\\r\n", stderr: "" };
      }
    });

    test("Linux capability checks report missing device permissions without trying to eject", async () => {
      const root = await mkdtemp(join(tmpdir(), "autodisc-capabilities-"));
      try {
        const invocations = [];
        const service = new CapabilityService(() => ({
          opticalDevice: join(root, "missing-device"),
          workDir: root
        }), {
          platform: "linux",
          isExecutableAvailable: async () => true,
          run: async (command, args) => {
            invocations.push({ command, args });
            throw new Error("unexpected command execution during permission preflight");
          }
        });
        assert.equal(await service.canReadDiscs(), false);
        assert.equal(await service.canEjectDrives(), false);
        assert.deepEqual(invocations, []);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    assert.equal(await service.canDetectDrives(), true);
    assert.equal(await service.canReadDiscs(), true);
    assert.equal(await service.canEjectDrives(), true);
    assert.equal(await service.canAccessTempDirectories(), true);
    const report = await service.getCapabilityReport();
    assert.deepEqual(report.checks.map(({ id, ok }) => [id, ok]), [
      ["drive-detection", true],
      ["disc-reading", true],
      ["drive-ejection", true],
      ["temp-storage", true]
    ]);
    assert.ok(invocations.length > 0);
    assert.ok(invocations.every(({ command }) => command === "powershell.exe"));
    const scripts = invocations.filter(({ args }) => args.includes("-EncodedCommand"))
      .map(({ args }) => Buffer.from(args[3] ?? "", "base64").toString("utf16le"));
    assert.ok(scripts.length > 0);
    assert.ok(scripts.every((script) => !script.includes("DeviceIoControl") && !script.includes("InvokeVerb('Eject')")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
