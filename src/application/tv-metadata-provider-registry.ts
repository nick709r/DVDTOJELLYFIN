import type { AppSettings, TvMetadataValidationResult } from "../model.js";

export type TvMetadataProviderHealth =
  | "not_configured"
  | "unverified"
  | "healthy"
  | "validation_failed"
  | "lookup_unavailable";

export interface TvMetadataProviderDescriptor {
  id: string;
  name: string;
  lookupImplemented: boolean;
  enabled: boolean;
  apiKeyRequired: boolean;
  apiKeyConfigured: boolean;
  health: TvMetadataProviderHealth;
  healthMessage: string;
  lastValidation: TvMetadataValidationResult | null;
}

export interface TvMetadataProvider {
  id: string;
  name: string;
  apiKeyRequired: boolean;
  lookupImplemented: boolean;
  validateConnection(apiKey: string, fetcher: typeof fetch): Promise<void>;
}

export class TvMetadataProviderRegistry {
  private readonly providers = new Map<string, TvMetadataProvider>();

  register(provider: TvMetadataProvider): void {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(provider.id)) {
      throw new Error(`Invalid TV metadata provider ID: ${provider.id}`);
    }
    if (this.providers.has(provider.id)) {
      throw new Error(`TV metadata provider is already registered: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  list(settings: AppSettings): TvMetadataProviderDescriptor[] {
    return [...this.providers.values()].map((provider) => {
      const apiKeyConfigured = Boolean(settings.tvMetadataProviderApiKeys[provider.id]);
      const lastValidation = settings.tvMetadataProviderValidation[provider.id] ?? null;
      const health: TvMetadataProviderHealth = !provider.lookupImplemented
        ? "lookup_unavailable"
        : !apiKeyConfigured
          ? "not_configured"
          : !lastValidation
            ? "unverified"
            : lastValidation.status === "success" ? "healthy" : "validation_failed";
      const healthMessage = !provider.lookupImplemented
        ? "TV lookup integration is not implemented; settings do not affect processing."
        : !apiKeyConfigured
          ? "API key is not configured."
          : !lastValidation
            ? "Credentials have not been validated."
            : lastValidation.message;
      return {
        id: provider.id,
        name: provider.name,
        lookupImplemented: provider.lookupImplemented,
        enabled: settings.tvMetadataProviderEnabled[provider.id] ?? false,
        apiKeyRequired: provider.apiKeyRequired,
        apiKeyConfigured,
        health,
        healthMessage,
        lastValidation
      };
    });
  }

  async validateConnection(id: string, apiKey: string, fetcher: typeof fetch = fetch): Promise<void> {
    const provider = this.providers.get(id);
    if (!provider) throw new Error("TV metadata provider is not registered");
    if (provider.apiKeyRequired && !apiKey) throw new Error("Save an API key before testing this provider");
    await provider.validateConnection(apiKey, fetcher);
  }
}
