import type { MetadataProviderCandidate } from "../contracts/metadata-provider.js";
import type { TvMetadataLookupInput } from "../application/tv-metadata-provider-registry.js";
import { TvMetadataProviderRegistry } from "../application/tv-metadata-provider-registry.js";

interface TvSeriesResult {
  id: string;
  title: string;
  year?: number;
  overview?: string;
}

interface TvEpisodeResult {
  id: string;
  title: string;
  seasonNumber: number;
  episodeNumber: number;
  runtimeSeconds?: number;
  overview?: string;
}

function titleSimilarity(left: string, right: string): number {
  const words = (value: string): Set<string> =>
    new Set(value.toLocaleLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).filter(Boolean));
  const a = words(left);
  const b = words(right);
  if (!a.size || !b.size) return 0;
  return [...a].filter((word) => b.has(word)).length / new Set([...a, ...b]).size;
}

function candidate(
  id: string,
  entityType: string,
  title: string,
  confidence: number,
  metadata: Record<string, unknown>,
  identifiers: Record<string, string>
): MetadataProviderCandidate {
  return { id, entityType, title, confidence: Math.max(0, Math.min(1, confidence)), metadata, identifiers };
}

function seriesCandidates(series: readonly TvSeriesResult[], providerId: string, query: string): MetadataProviderCandidate[] {
  return series.map((item) => candidate(
    item.id,
    "series",
    item.title,
    0.35 + titleSimilarity(query, item.title) * 0.6,
    { seriesId: item.id, title: item.title, year: item.year ?? null, overview: item.overview ?? null },
    { [providerId]: item.id }
  ));
}

function episodeCandidates(
  series: TvSeriesResult,
  episodes: readonly TvEpisodeResult[],
  input: TvMetadataLookupInput,
  providerId: string
): MetadataProviderCandidate[] {
  const items = input.items ?? [];
  return items.flatMap((item) => episodes.map((episode) => {
    const titleScore = item.title ? titleSimilarity(item.title, episode.title) : 0;
    const runtimeScore = item.durationSeconds && episode.runtimeSeconds
      ? Math.max(0, 1 - Math.abs(item.durationSeconds - episode.runtimeSeconds) / Math.max(item.durationSeconds, episode.runtimeSeconds))
      : 0;
    return candidate(
      `${episode.id}:${item.id}`,
      "episode",
      episode.title,
      0.35 + titleScore * 0.45 + runtimeScore * 0.2,
      {
        itemId: item.id,
        seriesId: series.id,
        seasonNumber: episode.seasonNumber,
        episodeNumber: episode.episodeNumber,
        title: episode.title,
        runtimeSeconds: episode.runtimeSeconds ?? null,
        overview: episode.overview ?? null
      },
      { [providerId]: episode.id }
    );
  }));
}

async function responseJson<T>(response: Response, providerName: string): Promise<T> {
  if (!response.ok) {
    const detail = response.status === 401 || response.status === 403
      ? `authentication failure (HTTP ${response.status})`
      : response.status === 429 ? `rate limited (HTTP ${response.status})` : `HTTP ${response.status}`;
    throw new Error(`${providerName} ${detail}`);
  }
  return await response.json() as T;
}

async function tmdbLookup(
  input: TvMetadataLookupInput,
  apiKey: string,
  fetcher: typeof fetch
): Promise<MetadataProviderCandidate[]> {
  const request = async (url: URL): Promise<unknown> => {
    url.searchParams.set("api_key", apiKey);
    const timeout = AbortSignal.timeout(10000);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    return responseJson<unknown>(await fetcher(url, { signal }), "TMDB TV");
  };
  const searchUrl = new URL("https://api.themoviedb.org/3/search/tv");
  searchUrl.searchParams.set("query", input.query);
  const search = await request(searchUrl) as { results?: Array<{ id?: number; name?: string; first_air_date?: string; overview?: string }> };
  const series = (search.results ?? []).filter((result) => typeof result.id === "number" && typeof result.name === "string")
    .map((result) => ({
      id: String(result.id),
      title: result.name!,
      ...(result.first_air_date?.match(/^\d{4}/) ? { year: Number(result.first_air_date.slice(0, 4)) } : {}),
      ...(result.overview ? { overview: result.overview } : {})
    }));
  if (input.entityType === "series") return seriesCandidates(series, "tmdbTvId", input.query);
  const first = series[0];
  if (!first) return [];
  if (input.entityType === "season") {
    if (input.seasonNumber === undefined) return [];
    return [candidate(
      `${first.id}:season:${input.seasonNumber}`,
      "season",
      `Season ${input.seasonNumber}`,
      0.8,
      { seriesId: first.id, seasonNumber: input.seasonNumber, title: `Season ${input.seasonNumber}`, isSpecials: input.seasonNumber === 0 },
      { tmdbTvId: first.id }
    )];
  }
  if (input.seasonNumber === undefined) return [];
  const seasonNumber = input.seasonNumber;
  const episodesUrl = new URL(`https://api.themoviedb.org/3/tv/${encodeURIComponent(first.id)}/season/${seasonNumber}`);
  const payload = await request(episodesUrl) as { episodes?: Array<{ id?: number; name?: string; episode_number?: number; season_number?: number; runtime?: number; overview?: string }> };
  const episodes = (payload.episodes ?? []).filter((episode) =>
    typeof episode.id === "number" && typeof episode.name === "string" &&
    typeof episode.episode_number === "number"
  ).map((episode) => ({
    id: String(episode.id),
    title: episode.name!,
    seasonNumber: episode.season_number ?? seasonNumber,
    episodeNumber: episode.episode_number!,
    ...(typeof episode.runtime === "number" ? { runtimeSeconds: episode.runtime * 60 } : {}),
    ...(episode.overview ? { overview: episode.overview } : {})
  }));
  return episodeCandidates(first, episodes, input, "tmdbTvId");
}

async function tvdbLookup(
  input: TvMetadataLookupInput,
  apiKey: string,
  fetcher: typeof fetch
): Promise<MetadataProviderCandidate[]> {
  const timeout = AbortSignal.timeout(10000);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  const login = await responseJson<{ data?: { token?: string } }>(
    await fetcher("https://api4.thetvdb.com/v4/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apikey: apiKey }),
      signal
    }), "TVDB"
  );
  if (!login.data?.token) throw new Error("TVDB authentication failure: response did not include a token");
  const headers = { Authorization: `Bearer ${login.data.token}` };
  const searchUrl = new URL("https://api4.thetvdb.com/v4/search");
  searchUrl.searchParams.set("query", input.query);
  searchUrl.searchParams.set("type", "series");
  const search = await responseJson<{ data?: Array<{ tvdb_id?: string; name?: string; year?: string; overview?: string }> }>(
    await fetcher(searchUrl, { headers, signal }), "TVDB"
  );
  const series = (search.data ?? []).filter((item) => item.tvdb_id && item.name).map((item) => ({
    id: item.tvdb_id!,
    title: item.name!,
    ...(item.year?.match(/^\d{4}/) ? { year: Number(item.year.slice(0, 4)) } : {}),
    ...(item.overview ? { overview: item.overview } : {})
  }));
  if (input.entityType === "series") return seriesCandidates(series, "tvdbId", input.query);
  const first = series[0];
  if (!first) return [];
  if (input.seasonNumber === undefined) return [];
  const seasonNumber = input.seasonNumber;
  if (input.entityType === "season") {
    return [candidate(
      `${first.id}:season:${seasonNumber}`,
      "season",
      `Season ${seasonNumber}`,
      0.8,
      { seriesId: first.id, seasonNumber, title: `Season ${seasonNumber}`, isSpecials: seasonNumber === 0 },
      { tvdbId: first.id }
    )];
  }
  const episodeUrl = new URL(`https://api4.thetvdb.com/v4/series/${encodeURIComponent(first.id)}/episodes/default`);
  episodeUrl.searchParams.set("season", String(seasonNumber));
  episodeUrl.searchParams.set("page", "0");
  const response = await responseJson<{ data?: { episodes?: Array<{ id?: number; name?: string; seasonNumber?: number; number?: number; runtime?: number; overview?: string }> } }>(
    await fetcher(episodeUrl, { headers, signal }), "TVDB"
  );
  const episodes = (response.data?.episodes ?? []).filter((item) =>
    typeof item.id === "number" && typeof item.name === "string" && typeof item.number === "number"
    && (typeof item.seasonNumber !== "number" || item.seasonNumber === seasonNumber)
  ).map((item) => ({
    id: String(item.id),
    title: item.name!,
    seasonNumber: item.seasonNumber ?? seasonNumber,
    episodeNumber: item.number!,
    ...(typeof item.runtime === "number" ? { runtimeSeconds: item.runtime * 60 } : {}),
    ...(item.overview ? { overview: item.overview } : {})
  }));
  return episodeCandidates(first, episodes, input, "tvdbId");
}

export const tvMetadataProviderRegistry = new TvMetadataProviderRegistry();

tvMetadataProviderRegistry.register({
  id: "tvdb",
  name: "TVDB",
  apiKeyRequired: true,
  lookupImplemented: true,
  async validateConnection(apiKey, fetcher) {
    const response = await fetcher("https://api4.thetvdb.com/v4/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apikey: apiKey }),
      signal: AbortSignal.timeout(10000)
    });
    const result = await responseJson<{ data?: { token?: unknown } }>(response, "TVDB");
    if (typeof result.data?.token !== "string" || !result.data.token) {
      throw new Error("TVDB authentication failure: response did not include an authentication token");
    }
  },
  lookup(input, apiKey, fetcher) { return tvdbLookup(input, apiKey, fetcher); }
});

tvMetadataProviderRegistry.register({
  id: "tmdb-tv",
  name: "TMDB TV",
  apiKeyRequired: true,
  lookupImplemented: true,
  async validateConnection(apiKey, fetcher) {
    const url = new URL("https://api.themoviedb.org/3/configuration");
    url.searchParams.set("api_key", apiKey);
    await responseJson<unknown>(await fetcher(url, { signal: AbortSignal.timeout(10000) }), "TMDB TV");
  },
  lookup(input, apiKey, fetcher) { return tmdbLookup(input, apiKey, fetcher); }
});
