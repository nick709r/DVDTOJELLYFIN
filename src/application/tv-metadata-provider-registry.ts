import type { MetadataProviderCandidate } from "../contracts/metadata-provider.js";
import type { AppSettings, TvMetadataValidationResult } from "../model.js";

export type TvMetadataProviderHealth =
  | "disabled"
  | "not_configured"
  | "unverified"
  | "healthy"
  | "unavailable"
  | "authentication_failure"
  | "rate_limited";

export interface TvMetadataLookupInput {
  entityType: string;
  query: string;
  seasonNumber?: number;
  items?: readonly { id: string; title?: string; durationSeconds?: number }[];
  signal?: AbortSignal;
}

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
  lastSuccessfulLookup: string | null;
  lastFailure: string | null;
  lastFailureAt: string | null;
  usageCount: number;
}

export interface TvMetadataProvider {
  id: string;
  name: string;
  apiKeyRequired: boolean;
  lookupImplemented: boolean;
  validateConnection(apiKey: string, fetcher: typeof fetch): Promise<void>;
  lookup(input: TvMetadataLookupInput, apiKey: string, fetcher: typeof fetch): Promise<readonly MetadataProviderCandidate[]>;
  lookupById?(providerId: string, apiKey: string, fetcher: typeof fetch): Promise<MetadataProviderCandidate | undefined>;
  lookupImdbId?(imdbId: string, apiKey: string, fetcher: typeof fetch): Promise<MetadataProviderCandidate | undefined>;
  lookupEpisodesById?(
    providerId: string,
    seasonNumber: number,
    apiKey: string,
    fetcher: typeof fetch
  ): Promise<readonly { seriesId: string; seasonNumber: number; episodeNumber: number; title: string }[]>;
}

function validationHealth(result: TvMetadataValidationResult | null): TvMetadataProviderHealth {
  if (!result) return "unverified";
  if (result.status === "success") return "healthy";
  if (/rate limited|HTTP 429/i.test(result.message)) return "rate_limited";
  if (/authentication|HTTP 401|HTTP 403/i.test(result.message)) return "authentication_failure";
  return "unavailable";
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

  isLookupImplemented(id: string): boolean {
    return this.providers.get(id)?.lookupImplemented ?? false;
  }

  list(settings: AppSettings): TvMetadataProviderDescriptor[] {
    return [...this.providers.values()].filter((provider) => provider.lookupImplemented).map((provider) => {
      const apiKeyConfigured = Boolean(settings.tvMetadataProviderApiKeys[provider.id]);
      const lastValidation = settings.tvMetadataProviderValidation[provider.id] ?? null;
      const lookupStatus = settings.tvMetadataProviderStatus[provider.id];
      const health: TvMetadataProviderHealth = !(settings.tvMetadataProviderEnabled[provider.id] ?? false)
        ? "disabled"
        : !apiKeyConfigured
          ? "not_configured"
          : lookupStatus?.status ?? validationHealth(lastValidation);
      const healthMessage = health === "disabled"
        ? "Provider is disabled."
        : health === "not_configured"
          ? "API key is not configured."
          : health === "healthy"
            ? lookupStatus?.lastSuccessfulLookup
              ? "Last lookup succeeded."
              : lastValidation?.status === "success" ? "Provider connection validated." : "Provider is healthy."
            : lookupStatus?.lastFailure ??
              (lastValidation?.status === "failure" ? lastValidation.message : null) ??
              lastValidation?.message ?? "Provider has not completed a lookup.";
      return {
        id: provider.id,
        name: provider.name,
        lookupImplemented: provider.lookupImplemented,
        enabled: settings.tvMetadataProviderEnabled[provider.id] ?? false,
        apiKeyRequired: provider.apiKeyRequired,
        apiKeyConfigured,
        health,
        healthMessage,
        lastValidation,
        lastSuccessfulLookup: lookupStatus?.lastSuccessfulLookup ?? null,
        lastFailure: lookupStatus?.lastFailure ??
          (lastValidation?.status === "failure" ? lastValidation.message : null),
        lastFailureAt: lookupStatus?.lastFailureAt ??
          (lastValidation?.status === "failure" ? lastValidation.validatedAt : null),
        usageCount: lookupStatus?.usageCount ?? 0
      };
    });
  }

  async validateConnection(id: string, apiKey: string, fetcher: typeof fetch = fetch): Promise<void> {
    const provider = this.providers.get(id);
    if (!provider) throw new Error("TV metadata provider is not registered");
    if (provider.apiKeyRequired && !apiKey) throw new Error("Save an API key before testing this provider");
    await provider.validateConnection(apiKey, fetcher);
  }

  async lookup(
    id: string,
    input: TvMetadataLookupInput,
    apiKey: string,
    fetcher: typeof fetch = fetch
  ): Promise<readonly MetadataProviderCandidate[]> {
    const provider = this.providers.get(id);
    if (!provider) throw new Error("TV metadata provider is not registered");
    if (!provider.lookupImplemented) throw new Error(`TV metadata lookup is not implemented for ${provider.name}`);
    if (provider.apiKeyRequired && !apiKey) throw new Error(`${provider.name} API key is not configured`);
    return provider.lookup(input, apiKey, fetcher);
  }

  async lookupById(
    id: string,
    providerId: string,
    apiKey: string,
    fetcher: typeof fetch = fetch
  ): Promise<MetadataProviderCandidate | undefined> {
    const provider = this.providers.get(id);
    if (!provider) throw new Error("TV metadata provider is not registered");
    if (!provider.lookupById) throw new Error(`Direct ID lookup is not implemented for ${provider.name}`);
    if (provider.apiKeyRequired && !apiKey) throw new Error(`${provider.name} API key is not configured`);
    return provider.lookupById(providerId, apiKey, fetcher);
  }

  async lookupEpisodesById(
    id: string,
    providerId: string,
    seasonNumber: number,
    apiKey: string,
    fetcher: typeof fetch = fetch
  ): Promise<readonly { seriesId: string; seasonNumber: number; episodeNumber: number; title: string }[]> {
    const provider = this.providers.get(id);
    if (!provider) throw new Error("TV metadata provider is not registered");
    if (!provider.lookupEpisodesById) throw new Error(`Episode lookup is not implemented for ${provider.name}`);
    if (provider.apiKeyRequired && !apiKey) throw new Error(`${provider.name} API key is not configured`);
    return provider.lookupEpisodesById(providerId, seasonNumber, apiKey, fetcher);
  }

  async lookupImdbId(
    id: string,
    apiKey: string,
    fetcher: typeof fetch = fetch
  ): Promise<MetadataProviderCandidate | undefined> {
    const provider = this.providers.get("tmdb-tv");
    if (!provider?.lookupImdbId) throw new Error("IMDb ID lookup is not implemented");
    if (provider.apiKeyRequired && !apiKey) throw new Error(`${provider.name} API key is not configured`);
    return provider.lookupImdbId(id, apiKey, fetcher);
  }

  listIds(): string[] {
    return [...this.providers.keys()];
  }
}
