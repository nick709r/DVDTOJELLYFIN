import type { MetadataCandidate, MetadataConfidence } from "../domain/metadata.js";
import type { Provider, ProviderHealth } from "./provider.js";

export interface MetadataIdentificationInput {
  entityType: string;
  query?: string;
  identifiers?: Readonly<Record<string, string>>;
  attributes?: Readonly<Record<string, unknown>>;
}

export interface MetadataProviderCandidate extends Omit<MetadataCandidate, "providerId"> {
  confidence: MetadataConfidence;
}

export type MetadataProviderHealth = ProviderHealth;

export interface MetadataProvider extends Provider {
  identify(input: MetadataIdentificationInput, signal?: AbortSignal): Promise<readonly MetadataProviderCandidate[]>;
}
