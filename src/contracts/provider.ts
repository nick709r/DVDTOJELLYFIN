export const providerApiMajor = 1;

export type ProviderKind =
  | "source"
  | "drive"
  | "metadata"
  | "transform"
  | "library"
  | "notification"
  | "platform"
  | "storage"
  | "telemetry";

export type ProviderHealthStatus = "available" | "degraded" | "unavailable";

export interface ProviderDescriptor {
  id: string;
  apiVersion: string;
  kind: ProviderKind;
  capabilities: readonly string[];
}

export interface ProviderHealth {
  status: ProviderHealthStatus;
  message?: string;
}

export interface ProviderLogger {
  log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    fields?: Readonly<Record<string, string | number | boolean | null>>
  ): void;
}

export interface ProviderContext {
  logger: ProviderLogger;
}

export interface Provider {
  describe(): ProviderDescriptor;
  initialize(context: ProviderContext): Promise<void>;
  healthCheck(): Promise<ProviderHealth>;
  dispose(): Promise<void>;
}
