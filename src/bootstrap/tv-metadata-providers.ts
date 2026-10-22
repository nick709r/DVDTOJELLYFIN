import type { MetadataProviderCandidate } from "../contracts/metadata-provider.js";
import type { TvMetadataLookupInput } from "../application/tv-metadata-provider-registry.js";
import { TvMetadataProviderRegistry } from "../application/tv-metadata-provider-registry.js";

interface TvSeriesResult {
  id: string;
  title: string;
  year?: number;
  overview?: string;
  artwork?: Array<{ kind: string; url: string }>;
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
    { seriesId: item.id, title: item.title, year: item.year ?? null, overview: item.overview ?? null,
      artwork: item.artwork ?? [] },
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
  const search = await request(searchUrl) as { results?: Array<{
    id?: number; name?: string; first_air_date?: string; overview?: string; poster_path?: string | null; backdrop_path?: string | null
  }> };
  const series = (search.results ?? []).filter((result) => typeof result.id === "number" && typeof result.name === "string")
    .map((result) => ({
      id: String(result.id),
      title: result.name!,
      ...(result.first_air_date?.match(/^\d{4}/) ? { year: Number(result.first_air_date.slice(0, 4)) } : {}),
      ...(result.overview ? { overview: result.overview } : {}),
      artwork: [
        ...(result.poster_path ? [{ kind: "poster", url: `https://image.tmdb.org/t/p/original${result.poster_path}` }] : []),
        ...(result.backdrop_path ? [{ kind: "backdrop", url: `https://image.tmdb.org/t/p/original${result.backdrop_path}` }] : [])
      ]
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

async function tvdbLookupById(id: string, apiKey: string, fetcher: typeof fetch): Promise<MetadataProviderCandidate | undefined> {
  const signal = AbortSignal.timeout(10000);
  const login = await responseJson<{ data?: { token?: string } }>(await fetcher("https://api4.thetvdb.com/v4/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apikey: apiKey }),
    signal
  }), "TVDB");
  if (!login.data?.token) throw new Error("TVDB authentication failure: response did not include a token");
  const response = await responseJson<{ data?: { id?: number | string; name?: string; year?: string; overview?: string; image?: string } }>(
    await fetcher(`https://api4.thetvdb.com/v4/series/${encodeURIComponent(id)}/extended`, {
      headers: { Authorization: `Bearer ${login.data.token}` },
      signal
    }), "TVDB"
  );
  const series = response.data;
  if (!series?.name) return undefined;
  const year = series.year?.match(/^\d{4}/) ? Number(series.year.slice(0, 4)) : undefined;
  return candidate(String(series.id ?? id), "series", series.name, 1, {
    seriesId: String(series.id ?? id),
    title: series.name,
    year: year ?? null,
    overview: series.overview ?? null,
    artwork: series.image?.startsWith("https://artworks.thetvdb.com/")
      ? [{ kind: "poster", url: series.image }] : []
  }, { tvdbId: String(series.id ?? id) });
}

async function tmdbLookupById(id: string, apiKey: string, fetcher: typeof fetch): Promise<MetadataProviderCandidate | undefined> {
  const url = new URL(`https://api.themoviedb.org/3/tv/${encodeURIComponent(id)}`);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("append_to_response", "aggregate_credits,images");
  url.searchParams.set("include_image_language", "en,null");
  const response = await responseJson<{ id?: number; name?: string; first_air_date?: string; overview?: string;
    number_of_seasons?: number;
    poster_path?: string | null; backdrop_path?: string | null; vote_average?: number;
    genres?: Array<{ name?: string }>; aggregate_credits?: { cast?: Array<{ name?: string }> };
    images?: { posters?: Array<{ file_path?: string }>; backdrops?: Array<{ file_path?: string }>;
      logos?: Array<{ file_path?: string }> } }>(
    await fetcher(url, { signal: AbortSignal.timeout(10000) }), "TMDB TV");
  if (typeof response.id !== "number" || typeof response.name !== "string") return undefined;
  const year = response.first_air_date?.match(/^\d{4}/) ? Number(response.first_air_date.slice(0, 4)) : undefined;
  return candidate(String(response.id), "series", response.name, 1, {
    seriesId: String(response.id), title: response.name, year: year ?? null, overview: response.overview ?? null,
    rating: response.vote_average ?? null,
    numberOfSeasons: typeof response.number_of_seasons === "number" ? response.number_of_seasons : null,
    genres: (response.genres ?? []).flatMap((genre) => genre.name ? [genre.name] : []),
    cast: (response.aggregate_credits?.cast ?? []).slice(0, 20).flatMap    ((person) => person.name ? [person.name] : []),
    artwork: [
      ...(response.poster_path ? [{ kind: "poster", url: `https://image.tmdb.org/t/p/original${response.poster_path}` }] : []),
      ...(response.images?.posters?.[0]?.file_path
        ? [{ kind: "poster", url: `https://image.tmdb.org/t/p/original${response.images.posters[0].file_path}` }] : []),
      ...(response.backdrop_path ? [{ kind: "backdrop", url: `https://image.tmdb.org/t/p/original${response.backdrop_path}` }] : []),
      ...(response.images?.backdrops?.[0]?.file_path
        ? [{ kind: "fanart", url: `https://image.tmdb.org/t/p/original${response.images.backdrops[0].file_path}` }] : []),
      ...(response.images?.logos?.[0]?.file_path
        ? [{ kind: "logo", url: `https://image.tmdb.org/t/p/original${response.images.logos[0].file_path}` }] : [])
    ]
  }, { tmdbTvId: String(response.id) });
}

async function imdbLookupById(id: string, apiKey: string, fetcher: typeof fetch): Promise<MetadataProviderCandidate | undefined> {
  const url = new URL(`https://api.themoviedb.org/3/find/${encodeURIComponent(id)}`);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("external_source", "imdb_id");
  const response = await responseJson<{ tv_results?: Array<{ id?: number; name?: string; first_air_date?: string; overview?: string }> }>(
    await fetcher(url, { signal: AbortSignal.timeout(10000) }), "TMDB IMDb ID lookup");
  const result = response.tv_results?.find((item) => typeof item.id === "number" && typeof item.name === "string");
  if (!result?.id || !result.name) return undefined;
  const details = await tmdbLookupById(String(result.id), apiKey, fetcher);
  return details ? {
    ...details,
    id,
    identifiers: { ...(details.identifiers ?? {}), imdbId: id, tmdbTvId: String(result.id) }
  } : undefined;
}

async function tmdbEpisodesById(
  id: string,
  seasonNumber: number,
  apiKey: string,
  fetcher: typeof fetch
): Promise<readonly { seriesId: string; seasonNumber: number; episodeNumber: number; title: string }[]> {
  const url = new URL(`https://api.themoviedb.org/3/tv/${encodeURIComponent(id)}/season/${seasonNumber}`);
  url.searchParams.set("api_key", apiKey);
  const response = await responseJson<{ episodes?: Array<{
    name?: string; season_number?: number; episode_number?: number
  }> }>(await fetcher(url, { signal: AbortSignal.timeout(10000) }), "TMDB TV");
  return (response.episodes ?? []).flatMap((episode) =>
    typeof episode.name === "string" && typeof episode.episode_number === "number"
      ? [{
        seriesId: id,
        seasonNumber: episode.season_number ?? seasonNumber,
        episodeNumber: episode.episode_number,
        title: episode.name
      }]
      : []);
}

async function tvdbEpisodesById(
  id: string,
  seasonNumber: number,
  apiKey: string,
  fetcher: typeof fetch
): Promise<readonly { seriesId: string; seasonNumber: number; episodeNumber: number; title: string }[]> {
  const signal = AbortSignal.timeout(10000);
  const login = await responseJson<{ data?: { token?: string } }>(await fetcher("https://api4.thetvdb.com/v4/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apikey: apiKey }),
    signal
  }), "TVDB");
  if (!login.data?.token) throw new Error("TVDB authentication failure: response did not include a token");
  const url = new URL(`https://api4.thetvdb.com/v4/series/${encodeURIComponent(id)}/episodes/default`);
  url.searchParams.set("season", String(seasonNumber));
  url.searchParams.set("page", "0");
  const response = await responseJson<{ data?: { episodes?: Array<{
    name?: string; seasonNumber?: number; number?: number
  }> } }>(await fetcher(url, {
    headers: { Authorization: `Bearer ${login.data.token}` },
    signal
  }), "TVDB");
  return (response.data?.episodes ?? []).flatMap((episode) =>
    typeof episode.name === "string" && typeof episode.number === "number"
      ? [{
        seriesId: id,
        seasonNumber: episode.seasonNumber ?? seasonNumber,
        episodeNumber: episode.number,
        title: episode.name
      }]
      : []);
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
  lookup(input, apiKey, fetcher) { return tvdbLookup(input, apiKey, fetcher); },
  lookupById(id, apiKey, fetcher) { return tvdbLookupById(id, apiKey, fetcher); },
  lookupEpisodesById(id, season, apiKey, fetcher) { return tvdbEpisodesById(id, season, apiKey, fetcher); }
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
  lookup(input, apiKey, fetcher) { return tmdbLookup(input, apiKey, fetcher); },
  lookupById(id, apiKey, fetcher) { return tmdbLookupById(id, apiKey, fetcher); },
  lookupImdbId(id, apiKey, fetcher) { return imdbLookupById(id, apiKey, fetcher); },
  lookupEpisodesById(id, season, apiKey, fetcher) { return tmdbEpisodesById(id, season, apiKey, fetcher); }
});
