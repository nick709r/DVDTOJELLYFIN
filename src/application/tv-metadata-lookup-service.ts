import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { MetadataIdentificationInput, MetadataProvider, MetadataProviderCandidate } from "../contracts/metadata-provider.js";
import type { ProviderDescriptor, ProviderHealth, ProviderContext } from "../contracts/provider.js";
import type { AppSettings } from "../model.js";
import {
  TvMetadataProviderRegistry,
  type TvMetadataLookupInput
} from "./tv-metadata-provider-registry.js";

function classifyFailure(message: string): "authentication_failure" | "rate_limited" | "unavailable" {
  if (/authentication failure|HTTP 401|HTTP 403/i.test(message)) return "authentication_failure";
  if (/rate limited|HTTP 429/i.test(message)) return "rate_limited";
  return "unavailable";
}

function attributesInput(input: MetadataIdentificationInput): TvMetadataLookupInput | undefined {
  if (!input.query?.trim()) return undefined;
  const seasonFromQuery = input.query.match(/\bseason[\s._-]*(\d+)\b/i) ?? input.query.match(/\bs(\d{1,2})\b/i);
  const rawItems = input.attributes?.items;
  const items = Array.isArray(rawItems) ? rawItems.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== "string") return [];
    return [{
      id: entry.id,
      ...(typeof entry.title === "string" ? { title: entry.title } : {}),
      ...(typeof entry.durationSeconds === "number" ? { durationSeconds: entry.durationSeconds } : {})
    }];
  }) : undefined;
  const seasonNumber = typeof input.attributes?.seasonNumber === "number"
    ? input.attributes.seasonNumber
    : seasonFromQuery ? Number(seasonFromQuery[1]) : undefined;
  return {
    entityType: input.entityType,
    query: input.query.trim(),
    ...(seasonNumber === undefined ? {} : { seasonNumber }),
    ...(items ? { items } : {})
  };
}

export class TvMetadataLookupService {
  constructor(
    private readonly database: Database.Database,
    private readonly getSettings: () => AppSettings,
    private readonly registry: TvMetadataProviderRegistry,
    private readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init)
  ) {}

  async lookup(input: TvMetadataLookupInput): Promise<MetadataProviderCandidate[]> {
    const settings = this.getSettings();
    if (!settings.tvMetadataLookupEnabled) return [];
    if (settings.tvMetadataCacheEnabled) {
      this.database.prepare("DELETE FROM tv_metadata_cache WHERE expires_at <= ?").run(new Date().toISOString());
    }
    const orderedIds = [
      settings.tvMetadataPreferredProviderId,
      settings.tvMetadataFallbackProviderId
    ].filter((id, index, values): id is string => Boolean(id) && values.indexOf(id) === index);
    const failures: string[] = [];
    for (const [providerIndex, providerId] of orderedIds.entries()) {
      if (!this.registry.has(providerId) || !settings.tvMetadataProviderEnabled[providerId]) continue;
      const apiKey = settings.tvMetadataProviderApiKeys[providerId] ?? "";
      if (!apiKey) continue;
      const health = this.registry.list(settings).find((provider) => provider.id === providerId)?.health;
      if (health === "authentication_failure" || health === "rate_limited" || health === "unavailable") {
        const message = `Provider lookup skipped because latest health status is ${health.replaceAll("_", " ")}`;
        failures.push(`${providerId}: ${message}`);
        this.audit(providerId, input, false, false, false, false, 0, health, message);
        continue;
      }
      const key = createHash("sha256").update(JSON.stringify({ providerId, ...input, signal: undefined })).digest("hex");
      if (settings.tvMetadataCacheEnabled) {
        const cached = this.database.prepare(`
          SELECT result_json FROM tv_metadata_cache WHERE cache_key = ? AND expires_at > ?
        `).get(key, new Date().toISOString()) as { result_json: string } | undefined;
        if (cached) {
          const result = JSON.parse(cached.result_json) as MetadataProviderCandidate[];
          this.audit(providerId, input, true, true, true, false, 0, null, null);
          if (result.length) return result.map((candidate) => ({
            ...candidate,
            lookupDiagnostics: {
              sourceProviderId: providerId,
              fallbackUsed: providerIndex > 0,
              cacheHit: true,
              durationMs: 0
            }
          }));
          continue;
        }
      }
      const startedAt = Date.now();
      try {
        const result = [...await this.registry.lookup(providerId, input, apiKey, this.fetcher)];
        const durationMs = Date.now() - startedAt;
        if (settings.tvMetadataCacheEnabled) {
          const cachedAt = new Date().toISOString();
          const expiresAt = new Date(Date.now() + settings.tvMetadataCacheDurationHours * 60 * 60 * 1000).toISOString();
          this.database.prepare(`
            INSERT INTO tv_metadata_cache
              (cache_key, provider_id, entity_type, query_text, result_json, cached_at, expires_at, input_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(cache_key) DO UPDATE SET result_json = excluded.result_json,
              cached_at = excluded.cached_at, expires_at = excluded.expires_at, input_json = excluded.input_json
          `).run(key, providerId, input.entityType, input.query, JSON.stringify(result), cachedAt, expiresAt,
            JSON.stringify({ ...input, signal: undefined }));
        }
        this.audit(providerId, input, true, false, settings.tvMetadataCacheEnabled, true, durationMs, null, null);
        this.saveProviderStatus(providerId, "healthy", new Date().toISOString(), null);
        if (result.length) return result.map((candidate) => ({
          ...candidate,
          lookupDiagnostics: {
            sourceProviderId: providerId,
            fallbackUsed: providerIndex > 0,
            cacheHit: false,
            durationMs
          }
        }));
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        const message = error instanceof Error ? error.message : "Unknown provider lookup failure";
        failures.push(`${providerId}: ${message}`);
        this.audit(providerId, input, false, false, settings.tvMetadataCacheEnabled, true, durationMs, classifyFailure(message), message);
        this.saveProviderStatus(providerId, classifyFailure(message), null, message);
      }
    }
    if (failures.length) throw new Error(failures.join("; "));
    return [];
  }

  private audit(
    providerId: string,
    input: TvMetadataLookupInput,
    success: boolean,
    cacheHit: boolean,
    cacheEnabled: boolean,
    providerCalled: boolean,
    durationMs: number,
    errorKind: string | null,
    errorMessage: string | null
  ): void {
    this.database.prepare(`
      INSERT INTO tv_metadata_lookup_audit
        (provider_id, entity_type, query_text, attempted_at, success, cache_hit, duration_ms, error_kind, error_message, cache_enabled, provider_called)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(providerId, input.entityType, input.query, new Date().toISOString(),
      success ? 1 : 0, cacheHit ? 1 : 0, durationMs, errorKind, errorMessage,
      cacheEnabled ? 1 : 0, providerCalled ? 1 : 0);
  }

  private saveProviderStatus(
    providerId: string,
    status: "healthy" | "unavailable" | "authentication_failure" | "rate_limited",
    successfulAt: string | null,
    failure: string | null
  ): void {
    const settings = this.getSettings();
    const previous = settings.tvMetadataProviderStatus[providerId];
    const usageCount = (this.database.prepare(`
      SELECT COUNT(*) AS count FROM tv_metadata_lookup_audit
      WHERE provider_id = ? AND provider_called = 1
    `).get(providerId) as { count: number }).count;
    const state = {
      status,
      lastSuccessfulLookup: successfulAt ?? previous?.lastSuccessfulLookup ?? null,
      lastFailure: failure ?? previous?.lastFailure ?? null,
      lastFailureAt: failure ? new Date().toISOString() : previous?.lastFailureAt ?? null,
      usageCount
    };
    const updated = { ...settings.tvMetadataProviderStatus, [providerId]: state };
    this.database.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run("tvMetadataProviderStatus", JSON.stringify(updated), new Date().toISOString());
  }

  async refreshCache(): Promise<{ refreshed: number; failed: number; refreshedAt: string; errors: string[] }> {
    const settings = this.getSettings();
    const rows = this.database.prepare(`
      SELECT cache_key AS cacheKey, provider_id AS providerId, entity_type AS entityType,
        query_text AS queryText, input_json AS inputJson
      FROM tv_metadata_cache
    `).all() as Array<{ cacheKey: string; providerId: string; entityType: string; queryText: string; inputJson: string }>;
    let refreshed = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const row of rows) {
      const input = JSON.parse(row.inputJson) as TvMetadataLookupInput;
      const apiKey = settings.tvMetadataProviderApiKeys[row.providerId] ?? "";
      const startedAt = Date.now();
      try {
        if (!settings.tvMetadataProviderEnabled[row.providerId] || !apiKey) {
          throw new Error("Provider is disabled or its API key is not configured");
        }
        const results = await this.registry.lookup(row.providerId, input, apiKey, this.fetcher);
        const cachedAt = new Date().toISOString();
        const expiresAt = new Date(Date.now() + settings.tvMetadataCacheDurationHours * 60 * 60 * 1000).toISOString();
        this.database.prepare(`
          UPDATE tv_metadata_cache SET result_json = ?, cached_at = ?, expires_at = ? WHERE cache_key = ?
        `).run(JSON.stringify(results), cachedAt, expiresAt, row.cacheKey);
        this.audit(row.providerId, input, true, false, settings.tvMetadataCacheEnabled, true,
          Date.now() - startedAt, null, null);
        this.saveProviderStatus(row.providerId, "healthy", cachedAt, null);
        refreshed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown provider refresh failure";
        this.audit(row.providerId, input, false, false, settings.tvMetadataCacheEnabled, true,
          Date.now() - startedAt, classifyFailure(message), message);
        this.saveProviderStatus(row.providerId, classifyFailure(message), null, message);
        failed += 1;
        errors.push(`${row.providerId} · ${row.entityType} · ${row.queryText}: ${message}`);
      }
    }
    return { refreshed, failed, refreshedAt: new Date().toISOString(), errors };
  }

  clearCache(): { cleared: number; refreshedAt: string } {
    const result = this.database.prepare("DELETE FROM tv_metadata_cache").run();
    return { cleared: result.changes, refreshedAt: new Date().toISOString() };
  }

  metrics(): Record<string, unknown> {
    const totals = this.database.prepare(`
      SELECT COUNT(*) AS lookupsAttempted,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS lookupsSuccessful,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS lookupsFailed,
        SUM(CASE WHEN cache_hit = 1 THEN 1 ELSE 0 END) AS cacheHits,
        SUM(CASE WHEN cache_enabled = 1 AND cache_hit = 0 AND provider_called = 1 THEN 1 ELSE 0 END) AS cacheMisses,
        AVG(CASE WHEN provider_called = 1 THEN duration_ms END) AS averageLookupTimeMs
      FROM tv_metadata_lookup_audit
    `).get() as Record<string, number | null>;
    const providers = this.database.prepare(`
      SELECT provider_id AS providerId, COUNT(*) AS lookupCount,
        SUM(CASE WHEN provider_called = 1 THEN 1 ELSE 0 END) AS usageCount,
        MAX(CASE WHEN success = 1 THEN attempted_at END) AS lastSuccessfulLookup,
        MAX(CASE WHEN success = 0 THEN attempted_at END) AS lastFailureAt,
        (SELECT error_message FROM tv_metadata_lookup_audit last
          WHERE last.provider_id = grouped.provider_id AND success = 0
          ORDER BY attempted_at DESC LIMIT 1) AS lastFailure
      FROM tv_metadata_lookup_audit grouped GROUP BY provider_id
    `).all() as Array<Record<string, string | number | null>>;
    const currentSettings = this.getSettings();
    const activeProvider = this.registry.list(currentSettings).find((item) =>
      item.enabled && item.apiKeyConfigured &&
      (item.id === currentSettings.tvMetadataPreferredProviderId || item.id === currentSettings.tvMetadataFallbackProviderId)
    );
    return {
      ...Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, value ?? 0])),
      averageLookupTimeMs: totals.averageLookupTimeMs == null ? null : Math.round(totals.averageLookupTimeMs),
      activeProvider: activeProvider ? { id: activeProvider.id, name: activeProvider.name } : null,
      providers: this.registry.list(currentSettings).map((provider) => {
        const lookupStats = providers.find((entry) => entry.providerId === provider.id);
        return {
          id: provider.id,
          name: provider.name,
          status: provider.health,
          lastSuccessfulLookup: lookupStats?.lastSuccessfulLookup ?? provider.lastSuccessfulLookup,
          lastFailure: lookupStats?.lastFailure ?? provider.lastFailure,
          lastFailureAt: lookupStats?.lastFailureAt ?? provider.lastFailureAt,
          usageCount: lookupStats?.usageCount ?? provider.usageCount
        };
      })
    };
  }

  async refreshProviders(): Promise<Array<{ id: string; status: string; message: string; refreshedAt: string }>> {
    const settings = this.getSettings();
    const output: Array<{ id: string; status: string; message: string; refreshedAt: string }> = [];
    for (const provider of this.registry.list(settings)) {
      if (!provider.enabled) {
        output.push({ id: provider.id, status: "disabled", message: "Provider is disabled.", refreshedAt: new Date().toISOString() });
        continue;
      }
      try {
        await this.registry.validateConnection(provider.id, settings.tvMetadataProviderApiKeys[provider.id] ?? "", this.fetcher);
        output.push({ id: provider.id, status: "healthy", message: "Provider connection validated.", refreshedAt: new Date().toISOString() });
        this.saveProviderStatus(provider.id, "healthy", null, null);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Provider validation failed";
        const status = classifyFailure(message);
        output.push({ id: provider.id, status, message, refreshedAt: new Date().toISOString() });
        this.saveProviderStatus(provider.id, status, null, message);
      }
    }
    return output;
  }
}

export class ConfiguredTvMetadataProvider implements MetadataProvider {
  constructor(private readonly lookupService: TvMetadataLookupService) {}

  describe(): ProviderDescriptor {
    return { id: "metadata.tv.configured", apiVersion: "1.0.0", kind: "metadata", capabilities: ["metadata.tv.identification"] };
  }

  async initialize(_context: ProviderContext): Promise<void> {}
  async healthCheck(): Promise<ProviderHealth> {
    return { status: "available" };
  }
  async dispose(): Promise<void> {}

  async identify(input: MetadataIdentificationInput, signal?: AbortSignal): Promise<readonly MetadataProviderCandidate[]> {
    const mapped = attributesInput(input);
    if (!mapped) return [];
    return this.lookupService.lookup({ ...mapped, ...(signal ? { signal } : {}) });
  }
}
