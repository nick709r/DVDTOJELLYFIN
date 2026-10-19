import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  TvProcessingPlan,
  TvProcessingPlanInput,
  TvProcessingPlanRepository
} from "../../domain/television.js";

interface TvProcessingPlanRow {
  id: string;
  plan_json: string;
}

function parsePlan(row: TvProcessingPlanRow | undefined): TvProcessingPlan | undefined {
  if (!row) return undefined;
  const plan = JSON.parse(row.plan_json) as TvProcessingPlan;
  if (plan.id !== row.id) throw new Error(`Persisted TV processing plan ${row.id} has a mismatched ID`);
  return plan;
}

function validatePlan(plan: TvProcessingPlanInput): void {
  if (!plan.sourceId.trim() || !plan.manifestId.trim() || !plan.fingerprint.trim()) {
    throw new Error("TV processing plan requires source, manifest, and fingerprint identifiers");
  }
  for (const [label, score] of [
    ["series", plan.seriesConfidence],
    ["season", plan.seasonConfidence],
    ["overall", plan.confidence]
  ] as const) {
    if (!Number.isFinite(score) || score < 0 || score > 1) {
      throw new Error(`TV processing plan ${label} confidence is invalid`);
    }
  }
  if (plan.executionEnabled !== false || !plan.executionBlocker.trim()) {
    throw new Error("TV processing plan must remain analysis-only until execution is implemented");
  }
}

export class SqliteTvProcessingPlanRepository implements TvProcessingPlanRepository {
  constructor(private readonly db: Database.Database) {}

  save(plan: TvProcessingPlanInput): TvProcessingPlan {
    validatePlan(plan);
    const saved: TvProcessingPlan = {
      ...plan,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      state: plan.automaticProcessingSafe ? "ready" : "awaiting-review",
      reviewHistory: []
    };
    this.db.prepare(`
      INSERT INTO tv_processing_plans (id, fingerprint, state, plan_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(saved.id, saved.fingerprint, saved.state, JSON.stringify(saved), saved.createdAt);
    return saved;
  }

  get(id: string): TvProcessingPlan | undefined {
    if (!id.trim()) throw new Error("TV processing plan lookup requires an ID");
    return parsePlan(this.db.prepare("SELECT id, plan_json FROM tv_processing_plans WHERE id = ?")
      .get(id) as TvProcessingPlanRow | undefined);
  }

  latestForFingerprint(fingerprint: string): TvProcessingPlan | undefined {
    if (!fingerprint.trim()) throw new Error("TV processing plan lookup requires a fingerprint");
    return parsePlan(this.db.prepare(`
      SELECT id, plan_json FROM tv_processing_plans
      WHERE fingerprint = ? ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(fingerprint) as TvProcessingPlanRow | undefined);
  }

  recordReview(
    id: string,
    decision: "approved" | "rejected" | "deferred",
    reviewer: string,
    reason?: string
  ): TvProcessingPlan | undefined {
    if (!id.trim()) throw new Error("TV processing plan state update requires an ID");
    if (!reviewer.trim()) throw new Error("TV processing plan state update requires a reviewer");
    if (!["approved", "rejected", "deferred"].includes(decision)) {
      throw new Error("TV processing plan review decision is invalid");
    }
    if (decision === "rejected" && !reason?.trim()) throw new Error("Rejecting a TV processing plan requires a reason");
    if (reason !== undefined && reason.length > 2000) {
      throw new Error("TV processing plan review reason must not exceed 2000 characters");
    }
    const plan = this.get(id);
    if (!plan) return undefined;
    if (plan.state === "approved" || plan.state === "rejected") {
      throw new Error(`TV processing plan ${id} is already ${plan.state}`);
    }
    const reviewedAt = new Date().toISOString();
    const reviewRecord = {
      decision,
      reviewer: reviewer.trim(),
      at: reviewedAt,
      ...(reason === undefined ? {} : { reason: reason.trim() })
    };
    const updated: TvProcessingPlan = {
      ...plan,
      ...(decision === "deferred" ? {} : { state: decision }),
      reviewedBy: reviewer.trim(),
      reviewedAt,
      reviewReason: reason?.trim() ?? "",
      reviewHistory: [...(plan.reviewHistory ?? []), reviewRecord]
    };
    const result = this.db.prepare(`
      UPDATE tv_processing_plans SET state = ?, plan_json = ? WHERE id = ?
    `).run(updated.state, JSON.stringify(updated), id);
    if (result.changes !== 1) throw new Error(`TV processing plan ${id} could not be updated`);
    return updated;
  }
}
