import type Database from "better-sqlite3";
import type { AppSettings } from "../../model.js";
import type { SettingsRepository } from "../../contracts/repositories.js";

export class SqliteSettingsRepository implements SettingsRepository {
  constructor(private readonly db: Database.Database, private readonly defaults: AppSettings) {}

  get(): AppSettings {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>;
    const values: Record<string, unknown> = {};
    for (const row of rows) values[row.key] = JSON.parse(row.value) as unknown;
    return { ...this.defaults, ...values } as AppSettings;
  }

  save(patch: Partial<AppSettings>): AppSettings {
    const now = new Date().toISOString();
    const update = this.db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    const save = this.db.transaction(() => {
      for (const [key, value] of Object.entries(patch)) update.run(key, JSON.stringify(value), now);
    });
    save();
    return this.get();
  }
}
