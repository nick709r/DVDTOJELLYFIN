import type { AppSettings } from "./model.js";
import { log } from "./logger.js";

interface TmdbMovie {
  title?: string;
  release_date?: string;
  popularity?: number;
}

export async function resolveTitle(label: string, settings: AppSettings, signal?: AbortSignal): Promise<{ title: string; source: string }> {
  const fallback = label.trim() || `Unknown Title ${new Date().toISOString().slice(0, 10)}`;
  if (!settings.metadataEnabled || !settings.metadataApiKey.trim() || !label.trim()) {
    return { title: fallback, source: "disc-label" };
  }

  try {
    const url = new URL("https://api.themoviedb.org/3/search/movie");
    url.searchParams.set("query", label);
    url.searchParams.set("api_key", settings.metadataApiKey);
    const timeout = AbortSignal.timeout(8000);
    const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok) throw new Error(`Metadata provider returned HTTP ${response.status}`);
    const payload = await response.json() as { results?: TmdbMovie[] };
    const candidates = (payload.results ?? [])
      .filter((item) => typeof item.title === "string" && item.title.trim())
      .sort((left, right) => (right.popularity ?? 0) - (left.popularity ?? 0));
    const match = candidates[0];
    if (match?.title) {
      const year = match.release_date?.match(/^\d{4}/)?.[0];
      return { title: year ? `${match.title} (${year})` : match.title, source: "tmdb" };
    }
  } catch (error) {
    log("warn", "metadata", "Optional title lookup failed; using disc label", {
      errorType: error instanceof Error ? error.name : "Unknown metadata error"
    });
  }
  return { title: fallback, source: "disc-label" };
}
