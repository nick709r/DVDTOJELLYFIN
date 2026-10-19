export type JobStatus =
  | "inspecting"
  | "ripping"
  | "converting"
  | "publishing"
  | "review"
  | "completed"
  | "failed"
  | "cancelled"
  | "ignored"
  | "interrupted";

export type EncoderChoice = "auto" | "nvidia" | "software";
export type OutputFormat = "mp4" | "mkv";
export type EncodingPreset = "ultrafast" | "veryfast" | "medium";

export interface TvMetadataValidationResult {
  status: "success" | "failure";
  message: string;
  validatedAt: string;
}

export interface AppSettings {
  moviesDir: string;
  musicDir: string;
  workDir: string;
  opticalDevice: string;
  format: OutputFormat;
  quality: number;
  preset: EncodingPreset;
  encoder: EncoderChoice;
  autoEject: boolean;
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
  logLevel: "debug" | "info" | "warn" | "error";
}

export interface Job {
  id: string;
  status: JobStatus;
  mediaType: string;
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
