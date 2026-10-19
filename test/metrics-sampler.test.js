import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DashboardMetricSampler } from "../dist/metrics-sampler.js";

test("dashboard metrics are sampled only while a dashboard subscriber is active", async () => {
  let samples = 0;
  const sampler = new DashboardMetricSampler(async () => ({ sequence: ++samples }), 25, (error) => {
    throw error;
  });
  await delay(60);
  assert.equal(samples, 0);

  const received = [];
  const unsubscribe = sampler.subscribe((snapshot) => {
    received.push(snapshot.sequence);
    return true;
  });
  await delay(12);
  assert.equal(samples, 1);
  assert.deepEqual(received, [1]);

  unsubscribe();
  await delay(60);
  assert.equal(samples, 1);

  const unsubscribeAgain = sampler.subscribe(() => false);
  await delay(15);
  assert.equal(samples, 2);
  await delay(45);
  assert.equal(samples, 2);
  unsubscribeAgain();
  sampler.stop();
});
