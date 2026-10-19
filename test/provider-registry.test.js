import assert from "node:assert/strict";
import test from "node:test";
import { ProviderRegistry } from "../dist/contracts/provider-registry.js";

function createProvider(id, calls = [], overrides = {}) {
  return {
    describe: () => ({
      id,
      apiVersion: "1.0.0",
      kind: "source",
      capabilities: ["video.disc.dvd"],
      ...overrides.descriptor
    }),
    initialize: async () => {
      calls.push(`initialize:${id}`);
      if (overrides.initializeError) throw overrides.initializeError;
    },
    healthCheck: async () => ({ status: "available" }),
    dispose: async () => {
      calls.push(`dispose:${id}`);
      if (overrides.disposeError) throw overrides.disposeError;
    }
  };
}

test("provider registry validates registrations and returns defensive descriptors", () => {
  const registry = new ProviderRegistry({ logger: { log() {} } });
  const provider = createProvider("source.dvd");
  registry.register(provider);
  assert.equal(registry.get("source.dvd"), provider);

  const descriptor = registry.list()[0];
  descriptor.capabilities.push("mutated");
  assert.deepEqual(registry.list()[0].capabilities, ["video.disc.dvd"]);
  assert.throws(() => registry.register(createProvider("source.dvd")), /already registered/);
  assert.throws(() => registry.register(createProvider("bad id")), /Invalid provider ID/);
  assert.throws(
    () => registry.register(createProvider("source.bad-kind", [], { descriptor: { kind: "unknown" } })),
    /unsupported kind/
  );
  assert.throws(
    () => registry.register(createProvider("source.v2", [], { descriptor: { apiVersion: "2.0.0" } })),
    /unsupported API version/
  );
  assert.throws(
    () => registry.register(createProvider("source.duplicate-capability", [], {
      descriptor: { capabilities: ["video.disc.dvd", "video.disc.dvd"] }
    })),
    /unique, valid capabilities/
  );
  assert.throws(
    () => registry.register({ describe: () => null }),
    /must implement describe, initialize, healthCheck, and dispose/
  );
});

test("provider registry initializes in registration order and disposes in reverse", async () => {
  const calls = [];
  const registry = new ProviderRegistry({ logger: { log() {} } });
  registry.register(createProvider("source.dvd", calls));
  registry.register(createProvider("metadata.tmdb", calls));

  await registry.initializeAll();
  assert.equal(registry.state, "initialized");
  assert.deepEqual((await registry.healthCheckAll()).map(({ health }) => health.status), ["available", "available"]);
  await registry.disposeAll();
  assert.equal(registry.state, "disposed");
  assert.deepEqual(calls, [
    "initialize:source.dvd",
    "initialize:metadata.tmdb",
    "dispose:metadata.tmdb",
    "dispose:source.dvd"
  ]);
  await registry.disposeAll();
  assert.throws(() => registry.register(createProvider("source.file")), /Cannot register providers/);
});

test("provider initialization failure disposes prior providers and remains explicit", async () => {
  const calls = [];
  const failure = new Error("provider failed to initialize");
  const registry = new ProviderRegistry({ logger: { log() {} } });
  registry.register(createProvider("source.dvd", calls));
  registry.register(createProvider("metadata.tmdb", calls, { initializeError: failure }));

  await assert.rejects(registry.initializeAll(), (error) => error === failure);
  assert.equal(registry.state, "failed");
  assert.deepEqual(calls, [
    "initialize:source.dvd",
    "initialize:metadata.tmdb",
    "dispose:source.dvd"
  ]);
});

test("provider initialization reports rollback failures without hiding the original", async () => {
  const initializationFailure = new Error("initialization");
  const disposalFailure = new Error("disposal");
  const registry = new ProviderRegistry({ logger: { log() {} } });
  registry.register(createProvider("source.dvd", [], { disposeError: disposalFailure }));
  registry.register(createProvider("metadata.tmdb", [], { initializeError: initializationFailure }));

  await assert.rejects(registry.initializeAll(), (error) =>
    error instanceof AggregateError &&
    error.errors[0] === initializationFailure &&
    error.errors[1] === disposalFailure
  );
});
