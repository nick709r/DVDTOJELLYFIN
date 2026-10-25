export type JobStatus =
  | "inspecting"
  | "ripping"
  | "converting"
  | "publishing"
  | "review"
  | "awaiting-identification"
  | "completed"
  | "failed"
  | "cancelled"
  | "ignored"
  | "interrupted"
  | "deleted";

export type EncoderChoice = "auto" | "nvidia" | "software";
export type OutputFormat = "mp4" | "mkv";
export type EncodingPreset = "ultrafast" | "veryfast" | "medium";
export type LibraryStructure = "jellyfin" | "sonarr" | "radarr" | "lidarr" | "kodi" | "custom";
export type NfoFormat = "jellyfin" | "kodi" | "emby";
export type OutputTarget = "jellyfin" | "sonarr" | "radarr" | "lidarr" | "folder";
export type AutomationMode = "full_auto" | "regular_auto" | "review_based";

export interface OutputProfile {
  id: string;
  name: string;
  routes: {
    tv: "jellyfin" | "sonarr" | "folder";
    movies: "jellyfin" | "radarr" | "folder";
    music: "jellyfin" | "lidarr" | "folder";
  };
  jellyfin: {
    root: string;
    paths: { tv: string; movies: string; music: string };
  };
  sonarr: { seriesRoot: string };
  radarr: { movieRoot: string };
  lidarr: { artistRoot: string };
  folder: { tv: string; movies: string; music: string };
}

export interface OutputDestinationSettings {
  activeProfileId: string;
  profiles: OutputProfile[];
}

export interface LibraryMetadataSettings {
  automaticImport: boolean;
  downloadSeriesMetadata: boolean;
  downloadEpisodeMetadata: boolean;
  downloadMovieMetadata: boolean;
  downloadMusicMetadata: boolean;
  downloadCastInformation: boolean;
  downloadRatings: boolean;
  downloadArtwork: boolean;
  downloadSeasonArtwork: boolean;
  downloadEpisodeImages: boolean;
  downloadFanart: boolean;
  downloadLogos: boolean;
  downloadBackdrops: boolean;
  downloadBanners: boolean;
  generateNfo: boolean;
  nfoFormat: NfoFormat;
  libraryStructure: LibraryStructure;
  seriesFolderTemplate: string;
  seasonFolderTemplate: string;
  episodeFileTemplate: string;
  movieFolderTemplate: string;
  movieFileTemplate: string;
  artistFolderTemplate: string;
  albumFolderTemplate: string;
}

export interface TvMetadataValidationResult {
  status: "success" | "failure";
  message: string;
  validatedAt: string;
}

export interface AppSettings {
  moviesDir: string;
  musicDir: string;
  tvRootDir: string;
  workDir: string;
  tvStagingDir: string;
  opticalDevice: string;
  format: OutputFormat;
  quality: number;
  preset: EncodingPreset;
  encoder: EncoderChoice;
  autoEject: boolean;
  automationMode: AutomationMode;
  metadataEnabled: boolean;
  metadataProvider: "tmdb";
  metadataApiKey: string;
  musicMetadataEnabled: boolean;
  musicBrainzContactEmail: string;
  lidarrEnabled: boolean;
  lidarrUrl: string;
  lidarrApiKey: string;
  lidarrImportDir: string;
  adminPasswordSalt: string;
  adminPasswordHash: string;
  tvDetectionEnabled: boolean;
  tvStagingRetentionDays: number | null;
  storageWarningThresholdGb: 50 | 100 | 250 | 500 | null;
  autoWarnLargeReviewQueues: boolean;
  autoCleanTempLogsAfterDays: number | null;
  autoCleanFailedConversionsAfterDays: number | null;
  tvValidationLoggingEnabled: boolean;
  tvMetadataLookupEnabled: boolean;
  tvMetadataPreferredProviderId: string;
  tvMetadataFallbackProviderId: string;
  tvMetadataCacheEnabled: boolean;
  tvMetadataCacheDurationHours: number;
  tvMetadataProviderEnabled: Record<string, boolean>;
  tvMetadataProviderApiKeys: Record<string, string>;
  tvMetadataProviderValidation: Record<string, TvMetadataValidationResult>;
  tvMetadataProviderStatus: Record<string, {
    status: "healthy" | "unavailable" | "authentication_failure" | "rate_limited";
    lastSuccessfulLookup: string | null;
    lastFailure: string | null;
    lastFailureAt: string | null;
    usageCount: number;
  }>;
  libraryMetadata: LibraryMetadataSettings;
  outputDestinations: OutputDestinationSettings;
  logLevel: "debug" | "info" | "warn" | "error";
}

export interface Job {
  id: string;
  status: JobStatus;
  mediaType: string;
  discFingerprint: string | null;
  classification?: {
    detectedMediaType: string;
    finalMediaType: string;
    mediaTypeOverridden: boolean;
    audit: Array<{
      originalType: string;
      newType: string;
      username: string;
      timestamp: string;
      reason: string | null;
    }>;
  } | null;
  discLabel: string | null;
  title: string | null;
  outputPath: string | null;
  encoder: string | null;
  outputBytes: number | null;
  startedAt: string;
  finishedAt: string | null;
  durationSeconds: number | null;
  conversionSeconds: number | null;
  progress: number;
  error: string | null;
}

export interface DiscTitle {
  id: number;
  name: string;
  durationSeconds: number;
}

export interface EncoderResult {
  name: string;
  codec: "h264_nvenc" | "libx264";
  hardware: boolean;
}
