import { MediaSourceCoordinator } from "../application/media-source-coordinator.js";
import { ProviderRegistry } from "../contracts/provider-registry.js";
import type { MediaSourceProvider } from "../contracts/media-source.js";
import type { Provider } from "../contracts/provider.js";
import { log } from "../logger.js";
import { CdParanoiaSourceProvider } from "../providers/sources/audio-cd.js";
import { MakeMkvDvdSourceProvider } from "../providers/sources/dvd.js";

export async function createProviderRuntime(): Promise<{
  registry: ProviderRegistry<Provider>;
  sources: MediaSourceCoordinator;
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
  for (const provider of sourceProviders) registry.register(provider);
  await registry.initializeAll();

  return { registry, sources: new MediaSourceCoordinator(sourceProviders) };
}
