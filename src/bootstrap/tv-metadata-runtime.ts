import { db, getSettings } from "../db.js";
import { TvMetadataLookupService } from "../application/tv-metadata-lookup-service.js";
import { tvMetadataProviderRegistry } from "./tv-metadata-providers.js";

export const tvMetadataLookupService = new TvMetadataLookupService(db, getSettings, tvMetadataProviderRegistry);
