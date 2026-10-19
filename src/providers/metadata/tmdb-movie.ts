import type {
  MetadataIdentificationInput,
  MetadataProvider,
  MetadataProviderCandidate
} from "../../contracts/metadata-provider.js";
import type { ProviderDescriptor, ProviderHealth, ProviderContext } from "../../contracts/provider.js";
import type { AppSettings } from "../../model.js";

interface TmdbMovie {
  id?: number;
  title?: string;
  release_date?: string;
  popularity?: number;
}

function normalizedWords(value: string): Set<string> {
  return new Set(value.normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim().split(/\s+/).filter(Boolean));
}

function titleSimilarity(query: string, title: string): number {
  const queryWords = normalizedWords(query);
  const titleWords = normalizedWords(title);
  if (queryWords.size === 0 || titleWords.size === 0) return 0;
  const overlap = [...queryWords].filter((word) => titleWords.has(word)).length;
  return overlap / new Set([...queryWords, ...titleWords]).size;
}

export class TmdbMovieMetadataProvider implements MetadataProvider {
  constructor(
    private readonly getSettings: () => AppSettings,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  describe(): ProviderDescriptor {
    return {
      id: "metadata.tmdb.movie",
      apiVersion: "1.0.0",
      kind: "metadata",
      capabilities: ["metadata.movie.identification"]
    };
  }

  async initialize(context: ProviderContext): Promise<void> {
    void context;
  }

  async healthCheck(): Promise<ProviderHealth> {
    const settings = this.getSettings();
    if (!settings.metadataEnabled) {
      return { status: "degraded", message: "TMDB metadata lookup is disabled" };
    }
    if (!settings.metadataApiKey.trim()) {
      return { status: "degraded", message: "TMDB API key is not configured" };
    }
    return { status: "available" };
  }

  async dispose(): Promise<void> {
    return Promise.resolve();
  }

  async identify(input: MetadataIdentificationInput, signal?: AbortSignal): Promise<readonly MetadataProviderCandidate[]> {
    if (input.entityType !== "movie" || !input.query?.trim()) return [];
    const settings = this.getSettings();
    if (!settings.metadataEnabled) return [];
    const apiKey = settings.metadataApiKey.trim();
    if (!apiKey) return [];

    const url = new URL("https://api.themoviedb.org/3/search/movie");
    url.searchParams.set("query", input.query);
    url.searchParams.set("api_key", apiKey);
    const timeout = AbortSignal.timeout(8000);
    const response = await this.fetcher(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok) throw new Error(`TMDB returned HTTP ${response.status}`);
    const payload = await response.json() as { results?: TmdbMovie[] };
    const movies = (payload.results ?? [])
      .filter((movie): movie is TmdbMovie & { id: number; title: string } =>
        typeof movie.id === "number" && typeof movie.title === "string" && Boolean(movie.title.trim())
      );
    const maxPopularity = Math.max(1, ...movies.map((movie) => movie.popularity ?? 0));
    return movies.map((movie) => {
      const year = movie.release_date?.match(/^\d{4}/)?.[0];
      return {
        id: String(movie.id),
        entityType: "movie",
        title: year ? `${movie.title} (${year})` : movie.title,
        confidence: Math.min(0.99,
          0.1 + 0.8 * titleSimilarity(input.query ?? "", movie.title) +
          0.09 * ((movie.popularity ?? 0) / maxPopularity)),
        metadata: {
          title: movie.title,
          year: year ? Number(year) : null,
          popularity: movie.popularity ?? 0
        },
        identifiers: { tmdbMovieId: String(movie.id) }
      };
    });
  }
}
