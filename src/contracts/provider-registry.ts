import {
  providerApiMajor,
  type Provider,
  type ProviderContext,
  type ProviderDescriptor,
  type ProviderHealth
} from "./provider.js";

const providerIdPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const apiVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const providerKinds = new Set([
  "source", "drive", "metadata", "transform", "library", "notification", "platform", "storage", "telemetry"
]);

export type ProviderRegistryState = "registering" | "initializing" | "initialized" | "failed" | "disposed";

function isProviderKind(value: string): value is ProviderDescriptor["kind"] {
  return providerKinds.has(value);
}

function validateDescriptor(input: unknown): ProviderDescriptor {
  if (typeof input !== "object" || input === null) {
    throw new Error("Provider descriptor must be an object");
  }
  const descriptor = input as Record<string, unknown>;
  if (typeof descriptor.id !== "string" || typeof descriptor.apiVersion !== "string" ||
    typeof descriptor.kind !== "string" || !Array.isArray(descriptor.capabilities)) {
    throw new Error("Provider descriptor is missing required fields");
  }
  if (!providerIdPattern.test(descriptor.id)) {
    throw new Error(`Invalid provider ID: ${descriptor.id}`);
  }

  const version = apiVersionPattern.exec(descriptor.apiVersion);
  if (!version || Number(version[1]) !== providerApiMajor) {
    throw new Error(`Provider ${descriptor.id} uses unsupported API version ${descriptor.apiVersion}`);
  }

  if (!isProviderKind(descriptor.kind)) {
    throw new Error(`Provider ${descriptor.id} has unsupported kind ${descriptor.kind}`);
  }

  const capabilities: string[] = [];
  for (const capability of descriptor.capabilities) {
    if (typeof capability !== "string" || !providerIdPattern.test(capability)) {
      throw new Error(`Provider ${descriptor.id} must declare unique, valid capabilities`);
    }
    capabilities.push(capability);
  }
  if (!capabilities.length || new Set(capabilities).size !== capabilities.length) {
    throw new Error(`Provider ${descriptor.id} must declare unique, valid capabilities`);
  }

  return {
    id: descriptor.id,
    apiVersion: descriptor.apiVersion,
    kind: descriptor.kind,
    capabilities
  };
}

export class ProviderRegistry<P extends Provider = Provider> {
  private readonly providers = new Map<string, { provider: P; descriptor: ProviderDescriptor }>();
  private readonly initialized: P[] = [];
  private stateValue: ProviderRegistryState = "registering";

  constructor(private readonly context: ProviderContext) {}

  get state(): ProviderRegistryState {
    return this.stateValue;
  }

  register(provider: P): void {
    if (this.stateValue !== "registering") {
      throw new Error(`Cannot register providers while registry is ${this.stateValue}`);
    }
    if (typeof provider?.describe !== "function" ||
      typeof provider.initialize !== "function" ||
      typeof provider.healthCheck !== "function" ||
      typeof provider.dispose !== "function") {
      throw new Error("Provider must implement describe, initialize, healthCheck, and dispose");
    }

    const descriptor = validateDescriptor(provider.describe());
    if (this.providers.has(descriptor.id)) {
      throw new Error(`Provider ID is already registered: ${descriptor.id}`);
    }
    this.providers.set(descriptor.id, { provider, descriptor });
  }

  get(id: string): P | undefined {
    return this.providers.get(id)?.provider;
  }

  getProviders(): P[] {
    return [...this.providers.values()].map(({ provider }) => provider);
  }

  list(): ProviderDescriptor[] {
    return [...this.providers.values()].map(({ descriptor }) => ({
      ...descriptor,
      capabilities: [...descriptor.capabilities]
    }));
  }

  async initializeAll(): Promise<void> {
    if (this.stateValue !== "registering") {
      throw new Error(`Cannot initialize providers while registry is ${this.stateValue}`);
    }

    this.stateValue = "initializing";
    try {
      for (const { provider } of this.providers.values()) {
        await provider.initialize(this.context);
        this.initialized.push(provider);
      }
      this.stateValue = "initialized";
    } catch (initializationError) {
      this.stateValue = "failed";
      const cleanupErrors = await this.disposeInitialized();
      if (cleanupErrors.length) {
        throw new AggregateError(
          [initializationError, ...cleanupErrors],
          "Provider initialization failed and initialized providers could not all be disposed"
        );
      }
      throw initializationError;
    }
  }

  async healthCheckAll(): Promise<Array<{ descriptor: ProviderDescriptor; health: ProviderHealth }>> {
    if (this.stateValue !== "initialized") {
      throw new Error(`Cannot check provider health while registry is ${this.stateValue}`);
    }
    return Promise.all([...this.providers.values()].map(async ({ provider, descriptor }) => ({
      descriptor: { ...descriptor, capabilities: [...descriptor.capabilities] },
      health: await provider.healthCheck()
    })));
  }

  async disposeAll(): Promise<void> {
    if (this.stateValue === "disposed") return;
    const errors = await this.disposeInitialized();
    this.stateValue = "disposed";
    if (errors.length) {
      throw new AggregateError(errors, "One or more providers failed to dispose");
    }
  }

  private async disposeInitialized(): Promise<unknown[]> {
    const providers = this.initialized.splice(0).reverse();
    const errors: unknown[] = [];
    for (const provider of providers) {
      try {
        await provider.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }
}
