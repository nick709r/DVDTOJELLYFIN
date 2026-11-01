/** Media-agnostic candidate shown in every review search UI. */
export interface ReviewSearchCandidate {
  mediaType: string;
  provider: string;
  providerName: string;
  id: string;
  title: string;
  year?: number;
  overview?: string;
  posterUrl?: string;
  /** Media-specific summary line, for example "3 seasons". */
  detail?: string;
  confidence: number;
  /** Media-specific fields the adapter needs echoed back when a candidate is confirmed. */
  attributes: Readonly<Record<string, unknown>>;
}

export interface ReviewSearchProviderReport {
  providerId: string;
  query: string;
  matches: number;
  durationMs: number;
  failure?: string;
}

/** Raw result of one provider-level search for one query term. */
export interface ReviewAdapterSearchResult {
  candidates: readonly ReviewSearchCandidate[];
  providers: readonly ReviewSearchProviderReport[];
}

/** The only media-type-specific piece of the review workflow. */
export interface MediaReviewAdapter {
  readonly mediaType: string;
  readonly label: string;
  /** Hint shown in the shared search box. */
  readonly searchPlaceholder: string;
  search(term: string, signal?: AbortSignal): Promise<ReviewAdapterSearchResult>;
}

export interface ReviewSearchOutcome {
  mediaType: string;
  label: string;
  query: string;
  candidates: readonly ReviewSearchCandidate[];
  queries: readonly ReviewSearchProviderReport[];
  /** Present only when no candidates are presented; explains why. */
  emptyReason?: string;
}
