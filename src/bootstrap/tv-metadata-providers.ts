import { TvMetadataProviderRegistry } from "../application/tv-metadata-provider-registry.js";

async function requireSuccessfulResponse(response: Response, providerName: string): Promise<void> {
  if (!response.ok) {
    throw new Error(`${providerName} connection failed with HTTP ${response.status}`);
  }
}

export const tvMetadataProviderRegistry = new TvMetadataProviderRegistry();

tvMetadataProviderRegistry.register({
  id: "tvdb",
  name: "TVDB",
  apiKeyRequired: true,
  lookupImplemented: false,
  async validateConnection(apiKey, fetcher) {
    const response = await fetcher("https://api4.thetvdb.com/v4/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apikey: apiKey }),
      signal: AbortSignal.timeout(10000)
    });
    await requireSuccessfulResponse(response, "TVDB");
    const payload = await response.json() as { data?: { token?: unknown } };
    if (typeof payload.data?.token !== "string" || payload.data.token.length === 0) {
      throw new Error("TVDB accepted the request but did not return an authentication token");
    }
  }
});

tvMetadataProviderRegistry.register({
  id: "tmdb-tv",
  name: "TMDB TV",
  apiKeyRequired: true,
  lookupImplemented: false,
  async validateConnection(apiKey, fetcher) {
    const url = new URL("https://api.themoviedb.org/3/configuration");
    url.searchParams.set("api_key", apiKey);
    const response = await fetcher(url, { signal: AbortSignal.timeout(10000) });
    await requireSuccessfulResponse(response, "TMDB");
    await response.body?.cancel();
  }
});
