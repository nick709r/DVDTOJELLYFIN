import { MediaSourceCoordinator } from "../application/media-source-coordinator.js";
import { MetadataProviderRegistry } from "../application/metadata-provider-registry.js";
import { MetadataResolver } from "../application/metadata-resolver.js";
import { MediaWorkflowRegistry } from "../application/media-workflow-registry.js";
import { ProviderRegistry } from "../contracts/provider-registry.js";
import type { MediaSourceProvider } from "../contracts/media-source.js";
import type { Provider } from "../contracts/provider.js";
import type { AppSettings } from "../model.js";
import type { JobCoordinator } from "../application/job-coordinator.js";
import { log } from "../logger.js";
import { CdParanoiaSourceProvider } from "../providers/sources/audio-cd.js";
import { MakeMkvDvdSourceProvider } from "../providers/sources/dvd.js";
import { TmdbMovieMetadataProvider } from "../providers/metadata/tmdb-movie.js";
import { MusicBrainzMetadataProvider } from "../providers/metadata/musicbrainz.js";
import { AudioCdWorkflow } from "../providers/workflows/audio-cd.js";
import { DvdWorkflow } from "../providers/workflows/dvd.js";

function isMediaSourceProvider(provider: Provider): provider is MediaSourceProvider {
  return provider.describe().kind === "source" &&
    "inspect" in provider && typeof provider.inspect === "function" &&
    "acquire" in provider && typeof provider.acquire === "function";
}

export async function createProviderRuntime(
  getSettings: () => AppSettings,
  jobs: JobCoordinator
): Promise<{
  registry: ProviderRegistry<Provider>;
  sources: MediaSourceCoordinator;
  workflows: MediaWorkflowRegistry;
  metadataProviders: MetadataProviderRegistry;
  metadata: MetadataResolver;
  jobs: JobCoordinator;
}> {
  const registry = new ProviderRegistry<Provider>({
    logger: {
      log(level, message, fields) {
        log(level, "provider", message, fields ? { ...fields } : {});
      }
    }
  });
  const sourceProviders: MediaSourceProvider[] = [
    new CdParanoiaSourceProvider(),
    new MakeMkvDvdSourceProvider()
  ];
  const metadataProviders = new MetadataProviderRegistry();
  const configuredMetadataProviders = [
    new TmdbMovieMetadataProvider(getSettings),
    new MusicBrainzMetadataProvider(getSettings)
  ];
  for (const provider of sourceProviders) registry.register(provider);
  for (const provider of configuredMetadataProviders) {
    registry.register(provider);
    metadataProviders.register(provider);
  }
  await registry.initializeAll();
  const registeredSources = registry.getProviders().filter((provider) => provider.describe().kind === "source");
  const validSources = registeredSources.filter(isMediaSourceProvider);
  if (validSources.length !== registeredSources.length) {
    throw new Error("A registered source provider does not implement the media source contract");
  }
  for (const result of await metadataProviders.healthCheckAll()) {
    if (result.health.status !== "available") {
      log(result.health.status === "unavailable" ? "warn" : "info", "provider",
        result.health.message ?? `Metadata provider ${result.providerId} is ${result.health.status}`,
        { providerId: result.providerId, status: result.health.status });
    }
  }
  const workflows = new MediaWorkflowRegistry();
  workflows.register(new AudioCdWorkflow());
  workflows.register(new DvdWorkflow());

  return {
    registry,
    sources: new MediaSourceCoordinator(validSources),
    workflows,
    metadataProviders,
    metadata: new MetadataResolver(metadataProviders.list()),
    jobs
  };
}
