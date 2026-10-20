import type Database from "better-sqlite3";
import { scryptSync, timingSafeEqual } from "node:crypto";
import type { SetupRepository, SetupState } from "../../contracts/repositories.js";

interface SetupRow {
  setup_complete: number;
  admin_username: string | null;
  setup_completed_at: string | null;
}

export class SqliteSetupRepository implements SetupRepository {
  constructor(private readonly db: Database.Database) {}

  get(): SetupState {
    const row = this.db.prepare(`
      SELECT setup_complete, admin_username, setup_completed_at
      FROM setup_state WHERE id = 1
    `).get() as SetupRow | undefined;
    if (!row) throw new Error("Persistent setup state is missing");
    return {
      setupComplete: row.setup_complete === 1,
      adminUsername: row.admin_username,
      setupCompletedAt: row.setup_completed_at
    };
  }

  complete(username: string, salt: string, passwordHash: string): SetupState {
    if (this.get().setupComplete) throw new Error("Initial setup has already been completed");
    const timestamp = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE setup_state SET setup_complete = 1, admin_username = ?,
        admin_password_salt = ?, admin_password_hash = ?, setup_completed_at = ?
      WHERE id = 1 AND setup_complete = 0
    `).run(username, salt, passwordHash, timestamp);
    if (result.changes !== 1) throw new Error("Initial setup has already been completed");
    return this.get();
  }

  updatePassword(salt: string, passwordHash: string): void {
    const result = this.db.prepare(`
      UPDATE setup_state SET admin_password_salt = ?, admin_password_hash = ?
      WHERE id = 1 AND setup_complete = 1
    `).run(salt, passwordHash);
    if (result.changes !== 1) throw new Error("Administrator account is not configured");
  }

  authenticate(username: string, password: string): boolean {
    const row = this.db.prepare(`
      SELECT admin_password_salt, admin_password_hash FROM setup_state
      WHERE id = 1 AND setup_complete = 1 AND admin_username = ?
    `).get(username) as { admin_password_salt: string; admin_password_hash: string } | undefined;
    if (!row) return false;
    const candidate = scryptSync(password, Buffer.from(row.admin_password_salt, "hex"), 64);
    const expected = Buffer.from(row.admin_password_hash, "hex");
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  }
}
