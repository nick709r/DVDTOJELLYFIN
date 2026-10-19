import type { MetadataProvider } from "../contracts/metadata-provider.js";
import type { ProviderHealth } from "../contracts/provider.js";

export class MetadataProviderRegistry {
  private readonly providers = new Map<string, MetadataProvider>();

  register(provider: MetadataProvider): void {
    if (!provider || typeof provider.identify !== "function") {
      throw new Error("Metadata provider must implement identify");
    }
    const descriptor = provider.describe();
    if (descriptor.kind !== "metadata") {
      throw new Error(`Provider ${descriptor.id} is not a metadata provider`);
    }
    if (this.providers.has(descriptor.id)) {
      throw new Error(`Metadata provider is already registered: ${descriptor.id}`);
    }
    this.providers.set(descriptor.id, provider);
  }

  list(): MetadataProvider[] {
    return [...this.providers.values()];
  }

  async healthCheckAll(): Promise<Array<{ providerId: string; health: ProviderHealth }>> {
    return Promise.all(this.list().map(async (provider) => {
      const providerId = provider.describe().id;
      try {
        return { providerId, health: await provider.healthCheck() };
      } catch (error) {
        return {
          providerId,
          health: {
            status: "unavailable" as const,
            message: `Metadata provider health check failed: ${error instanceof Error ? error.message : "unknown error"}`
          }
        };
      }
    }));
  }
}
