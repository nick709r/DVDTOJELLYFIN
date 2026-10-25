import assert from "node:assert/strict";
import test from "node:test";
import { EjectService } from "../dist/eject.js";

function createService(overrides = {}) {
  const calls = [];
  const service = new EjectService({
    platform: "linux",
    isExecutableAvailable: async () => true,
    waitForProcesses: async () => true,
    pause: async () => {},
    run: async (command, args) => {
      calls.push({ command, args });
      return { stdout: "", stderr: "" };
    },
    ...overrides
  });
  return { service, calls };
}

test("eject succeeds with the preferred Linux eject utility", async () => {
  const { service, calls } = createService();
  await service.eject("/dev/sr0");
  assert.deepEqual(calls, [{ command: "eject", args: ["/dev/sr0"] }]);
});

test("busy drive retries and reports the accumulated failure", async () => {
  const { service, calls } = createService({
    run: async (command, args) => {
      calls.push({ command, args });
      throw new Error("device is busy");
    }
  });
  await assert.rejects(service.eject("/dev/sr0"), /after 3 attempts.*device is busy/);
  assert.equal(calls.filter(({ command, args }) => command === "eject" && args[0] === "/dev/sr0").length, 3);
});

test("missing permissions fall through to remaining Linux eject methods", async () => {
  const { service, calls } = createService({
    run: async (command, args) => {
      calls.push({ command, args });
      if (command === "eject") throw new Error("Operation not permitted");
      if (command === "python3") return { stdout: "", stderr: "" };
      return { stdout: "", stderr: "" };
    }
  });
  await service.eject("/dev/sr0");
  assert.deepEqual(calls.map(({ command }) => command), ["eject", "udisksctl", "python3"]);
});

test("missing eject utilities report an actionable failure", async () => {
  const { service } = createService({ isExecutableAvailable: async () => false });
  await assert.rejects(service.eject("/dev/sr0"), /Required utility .* unavailable/);
});

test("ejection is deferred while a managed child process remains active", async () => {
  let waits = 0;
  const { service, calls } = createService({
    waitForProcesses: async () => {
      waits += 1;
      return false;
    }
  });
  await assert.rejects(service.eject("/dev/sr0"), /child processes remain active/);
  assert.equal(waits, 3);
  assert.deepEqual(calls, []);
});

test("Windows eject falls back from native API to PowerShell and WMI methods", async () => {
  const calls = [];
  const service = new EjectService({
    platform: "win32",
    isExecutableAvailable: async () => true,
    waitForProcesses: async () => true,
    pause: async () => {},
    run: async (command, args) => {
      calls.push({ command, args });
      if (calls.length < 3) throw new Error("The device did not accept the eject request");
      return { stdout: "", stderr: "" };
    }
  });
  await service.eject("D:");
  assert.equal(calls.length, 3);
  assert.ok(calls.every(({ command }) => command === "powershell.exe"));
  assert.deepEqual(calls.map(({ args }) => args[2]), ["-EncodedCommand", "-EncodedCommand", "-EncodedCommand"]);
});

test("Linux eject falls back through udisksctl recovery and CD-ROM ioctl", async () => {
  const { service, calls } = createService({
    run: async (command, args) => {
      calls.push({ command, args });
      if (command === "eject") throw new Error("device is busy");
      return { stdout: "", stderr: "" };
    }
  });
  await service.eject("/dev/sr0");
  assert.deepEqual(calls.map(({ command }) => command), ["eject", "udisksctl", "python3"]);
});
