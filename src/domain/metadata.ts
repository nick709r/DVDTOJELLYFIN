export type MetadataConfidence = number;

export interface MetadataCandidate {
  id: string;
  providerId: string;
  entityType: string;
  title: string;
  confidence: MetadataConfidence;
  metadata: Readonly<Record<string, unknown>>;
  identifiers?: Readonly<Record<string, string>>;
  lookupDiagnostics?: {
    sourceProviderId: string;
    fallbackUsed: boolean;
    cacheHit: boolean;
    durationMs: number;
  };
}

export interface MetadataResult {
  selected?: MetadataCandidate;
  candidates: readonly MetadataCandidate[];
  providerFailures: readonly { providerId: string; message: string }[];
  /** Providers that handle the entity type but did not query it, with the reason. */
  providerSkips?: readonly { providerId: string; reason: string }[];
}

export function normalizeConfidence(value: number): MetadataConfidence {
  if (!Number.isFinite(value)) throw new Error("Metadata confidence must be a finite number");
  return Math.max(0, Math.min(1, value));
}
