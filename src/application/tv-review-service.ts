import type {
  Episode,
  TvApprovalAction,
  TvCorrectionAction,
  TvEpisodeFeedback,
  TvEpisodeFeedbackRepository,
  TvProcessingPlan,
  TvProcessingPlanRepository
} from "../domain/television.js";

function episodeIdentity(episode: Episode): string {
  return `${episode.seriesId}:${episode.seasonNumber}:${episode.episodeNumber}`;
}

function episodeListIdentity(episodes: readonly Episode[]): string {
  return episodes.map(episodeIdentity).join("|");
}

export class TvReviewService {
  constructor(
    private readonly feedback: TvEpisodeFeedbackRepository,
    private readonly plans: TvProcessingPlanRepository
  ) {}

  applyCorrection(action: TvCorrectionAction): TvEpisodeFeedback {
    const plan = this.requireOpenPlan(action.planId);
    const assignment = plan.assignments.find((candidate) => candidate.itemId === action.itemId);
    if (!assignment) throw new Error(`TV processing plan has no track ${action.itemId}`);
    if (action.episodes.length === 0) throw new Error("A TV correction must include at least one episode");
    if (action.type !== "assign-episodes" && action.episodes.length !== 1) {
      throw new Error("Accept and reject actions must reference exactly one episode");
    }
    if (action.type !== "assign-episodes") {
      const candidateExists = assignment.alternatives.some((candidate) =>
        episodeListIdentity(candidate.episodes) === episodeListIdentity(action.episodes)
      );
      if (!candidateExists) {
        throw new Error("Accepted or rejected episode is not a candidate in this processing plan");
      }
    }
    if (action.type === "reject-match" && !action.reason.trim()) {
      throw new Error("Rejecting an episode match requires a reason");
    }
    return this.feedback.record({
      fingerprint: plan.fingerprint,
      itemSignature: assignment.itemSignature,
      outcome: action.type === "accept-match"
        ? "accepted"
        : action.type === "reject-match" ? "rejected" : "manual-assignment",
      episodes: action.episodes,
      ...(action.reason === undefined ? {} : { reason: action.reason.trim() })
    });
  }

  applyApproval(action: TvApprovalAction): TvProcessingPlan {
    const plan = this.requireOpenPlan(action.planId);
    if (!action.reviewer.trim()) throw new Error("TV plan approval requires a reviewer identity");
    if (action.type === "reject-plan" && !action.reason.trim()) {
      throw new Error("Rejecting a TV processing plan requires a reason");
    }
    const state = action.type === "approve-plan" ? "approved" : action.type === "reject-plan" ? "rejected" : undefined;
    if (!state) return plan;
    const updated = this.plans.setState(
      action.planId,
      state,
      action.reviewer,
      action.type === "reject-plan" ? action.reason.trim() : undefined
    );
    if (!updated) throw new Error(`TV processing plan ${action.planId} could not be updated`);
    return updated;
  }

  private requireOpenPlan(planId: string): TvProcessingPlan {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(`TV processing plan ${planId} was not found`);
    if (plan.state === "approved" || plan.state === "rejected") {
      throw new Error(`TV processing plan ${planId} is already ${plan.state}`);
    }
    return plan;
  }
}
