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

export interface MetadataLookupAvailability {
  /** False when this provider does not handle the entity type at all; such lookups are not counted. */
  applicable: boolean;
  /** Set when the provider handles the entity type but will not query it (disabled, no key, empty query). */
  skipReason?: string;
}

export interface MetadataProvider extends Provider {
  /** Optional pre-check so the resolver can log and count skipped lookups accurately. */
  lookupAvailability?(input: MetadataIdentificationInput): MetadataLookupAvailability;
  identify(input: MetadataIdentificationInput, signal?: AbortSignal): Promise<readonly MetadataProviderCandidate[]>;
  enrich?(
    candidate: MetadataProviderCandidate,
    signal?: AbortSignal
  ): Promise<MetadataProviderCandidate>;
}
