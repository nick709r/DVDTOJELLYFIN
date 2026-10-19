import assert from "node:assert/strict";
import test from "node:test";
import { classifyOpticalDeviceEvent } from "../dist/disc-monitor.js";

test("optical media change events request a fresh inspection for the configured drive", () => {
  assert.equal(classifyOpticalDeviceEvent("change", "/dev/sr0", "/dev/sr0"), "media-change");
  assert.equal(classifyOpticalDeviceEvent("add", "/dev/sr01", "/dev/sr0"), "media-change");
});

test("unrelated udev events do not request an optical media inspection", () => {
  assert.equal(classifyOpticalDeviceEvent("change", "/dev/sdb", "/dev/sr0"), null);
  assert.equal(classifyOpticalDeviceEvent("remove", "/dev/sr0", "/dev/sr0"), "removed");
  assert.equal(classifyOpticalDeviceEvent(undefined, "/dev/sr0", "/dev/sr0"), null);
});
