import assert from "node:assert/strict";
import test from "node:test";
import { MediaReviewQueueService } from "../dist/application/media-review-queue-service.js";
import {
  ReviewJobItemAdapter,
  TvMatchingTaskItemAdapter,
  TvPlanItemAdapter,
  convertStoredCandidates
} from "../dist/application/media-review-item-adapters.js";
import { MediaReviewError } from "../dist/domain/media-review.js";
import { tvMatchingReviewStatus } from "../dist/domain/tv-matching.js";

const now = "2026-01-02T00:00:00.000Z";

function job(id, overrides = {}) {
  return {
    id, originalJobId: `orig-${id}`, status: "pending", discType: "dvd", discLabel: "THE_BREAK_UP",
    createdAt: now, updatedAt: now, notificationActive: true,
    metadata: {
      title: "Unknown Title 2026-01-02",
      namingSource: "Fallback",
      filesystemVolumeName: "THE_BREAK_UP",
      movieIdentificationRequiresConfirmation: true,
      movieIdentificationEvidence: { confidence: 0.61, minimumConfidence: 0.8 },
      movieCandidates: [
        { id: "7", providerId: "metadata.tmdb.movie", title: "The Break-Up (2006)", confidence: 0.61, year: 2006 }
      ]
    },
    ...overrides
  };
}

function jobRepo(jobs) {
  const map = new Map(jobs.map((entry) => [entry.id, entry]));
  return { get: (id) => map.get(id), list: () => [...map.values()] };
}

function setup(jobs, extras = {}) {
  const calls = { metadata: [], resumed: [] };
  const queue = new MediaReviewQueueService();
  queue.register(new ReviewJobItemAdapter(jobRepo(jobs), () => ({
    updateMetadata: async (id, patch) => { calls.metadata.push([id, patch]); },
    resume: async (id) => { calls.resumed.push(id); }
  })));
  if (extras.tasks) {
    queue.register(new TvMatchingTaskItemAdapter(
      { get: (id) => extras.tasks.find((t) => t.jobId === id), list: () => extras.tasks },
      { get: (fingerprint) => extras.recoveries?.[fingerprint] },
      extras.environment
    ));
  }
  if (extras.plans) {
    queue.register(new TvPlanItemAdapter({
      get: (id) => extras.plans.find((p) => p.id === id), list: () => extras.plans
    }, extras.approve));
  }
  return { queue, calls };
}

const tvTask = {
  jobId: "t1", fingerprint: "fp1", status: "awaiting-identification", source: { label: "SHOW_S1D1" },
  createdAt: "2026-01-03T00:00:00.000Z", updatedAt: now, assignments: []
};
const tvPlan = {
  id: "p1", state: "awaiting-review", series: { id: "99", title: "Show", year: 2020 }, seriesConfidence: 0.7,
  confidence: 0.55, reviewReasons: ["Low confidence", "Missing episode"], createdAt: "2026-01-01T00:00:00.000Z"
};

test("movie review job loads as a unified identification item", () => {
  const { queue } = setup([job("j1")]);
  const [item] = queue.list();
  assert.equal(item.id, "review-job:j1");
  assert.equal(item.mediaType, "movie");
  assert.equal(item.status, "pending");
  assert.equal(item.kind, "identification");
  assert.equal(item.originalTitle, "THE_BREAK_UP");
  assert.equal(item.selectedTitle, undefined);
  assert.equal(item.confidence, 0.61);
  assert.equal(item.candidates[0].title, "The Break-Up (2006)");
});

test("TV matching tasks and plans load as unified items", () => {
  const { queue } = setup([], {
    tasks: [tvTask],
    recoveries: { fp1: { seriesName: "Show", metadataProvider: "tmdb-tv", providerId: "99" } },
    plans: [tvPlan]
  });
  const task = queue.get("tv-matching-task:t1");
  assert.equal(task.mediaType, "tv");
  assert.equal(task.kind, "identification");
  assert.equal(task.originalTitle, "SHOW_S1D1");
  assert.equal(task.metadata.providerId, "99");
  const plan = queue.get("tv-plan:p1");
  assert.equal(plan.kind, "plan-review");
  assert.equal(plan.reviewReason, "Low confidence; Missing episode");
  assert.equal(plan.candidates[0].title, "Show");
});

test("unified queue mixes media types, sorts newest first, filters and isolates failures", () => {
  const { queue } = setup([job("j1")], { tasks: [tvTask], plans: [tvPlan] });
  assert.deepEqual(queue.list().map((item) => item.id), ["tv-matching-task:t1", "review-job:j1", "tv-plan:p1"]);
  assert.deepEqual(queue.list({ mediaType: "movie" }).map((item) => item.id), ["review-job:j1"]);
  assert.deepEqual(queue.list({ sourceKind: "tv-plan" }).map((item) => item.id), ["tv-plan:p1"]);
  assert.equal(queue.summary().byMediaType.tv, 2);
  queue.register({ sourceKind: "tv-matching-task-broken", list: () => { throw new Error("boom"); }, get: () => undefined });
  assert.equal(queue.list().length, 3);
});

test("legacy stored candidates and pre-gating jobs are converted", () => {
  const converted = convertStoredCandidates(["Plain Title", { name: "Named", id: 5, confidence: "0.4", year: "1999" }, 42, {}]);
  assert.equal(converted.repaired, true);
  assert.deepEqual(converted.candidates.map((c) => [c.id, c.title, c.confidence, c.year]), [
    ["5", "Named", 0.4, 1999], ["Plain Title", "Plain Title", 0, undefined]
  ]);
  const { queue } = setup([job("old", { metadata: { title: "Old Movie", suggestedTitle: "Old Movie", movieCandidates: ["Old Movie"] } })]);
  const item = queue.get("review-job:old");
  assert.equal(item.legacy, true);
  assert.equal(item.selectedTitle, "Old Movie");
  assert.equal(item.candidates.length, 1);
});

test("completing a review selects a candidate, confirms the title and resumes processing", async () => {
  const { queue, calls } = setup([job("j1")]);
  await queue.complete("review-job:j1", { candidateId: "7" });
  assert.deepEqual(calls.metadata, [["j1", {
    title: "The Break-Up (2006)", movieIdentificationConfirmed: true, namingSource: "User review",
    movieMatchId: "7", movieMatchYear: 2006
  }]]);
  assert.deepEqual(calls.resumed, ["j1"]);
  await queue.complete("review-job:j1", { title: "Manual Title" });
  assert.equal(calls.metadata[1][1].title, "Manual Title");
  assert.equal(calls.metadata[1][1].movieMatchId, null);
});

test("review completion rejects invalid, conflicting, unsupported and unknown items", async () => {
  const { queue } = setup([job("j1"), job("done", { status: "completed" })], { tasks: [tvTask] });
  const code = (promise) => promise.then(() => "ok", (error) => error instanceof MediaReviewError ? error.code : "other");
  assert.equal(await code(queue.complete("review-job:j1", {})), "conflict");
  assert.equal(await code(queue.complete("review-job:j1", { title: "Unknown Title 2026-01-02" })), "invalid");
  assert.equal(await code(queue.complete("review-job:j1", { candidateId: "nope" })), "invalid");
  assert.equal(await code(queue.complete("review-job:done", { title: "X" })), "conflict");
  assert.equal(await code(queue.complete("tv-matching-task:t1", { title: "X" })), "unavailable");
  queue.register({ sourceKind: "tv-plan-readonly", list: () => [], get: () => ({}) });
  assert.equal(await code(queue.complete("tv-plan-readonly:x", {})), "unsupported");
  assert.equal(await code(queue.complete("review-job:missing", { title: "X" })), "not-found");
  assert.equal(await code(queue.complete("bogus", { title: "X" })), "not-found");
});

function tvHarness({ active = false, conflict = false } = {}) {
  const state = {
    active,
    continued: [],
    identifications: [],
    recoveries: {},
    task: {
      jobId: "t1", fingerprint: "fp1", status: "awaiting-identification", source: { label: "SHOW_S1D1" },
      createdAt: now, updatedAt: now,
      assignments: [1, 2].map((n) => ({ trackId: String(n), title: `Title ${n}`, durationSeconds: 1300, episodeCandidates: [] }))
    }
  };
  const environment = {
    saveIdentification(_task, identification) {
      state.identifications.push(identification);
      state.recoveries.fp1 = {
        seriesName: identification.seriesName, providerId: identification.providerId,
        seasonNumber: identification.seasonNumber, metadataProvider: identification.provider,
        discNumber: identification.discNumber, discName: identification.discName,
        mediaTypeOverridden: false, finalMediaType: "tv_series"
      };
      state.task = { ...state.task, status: "awaiting-mapping" };
      return { recovery: state.recoveries.fp1, task: state.task };
    },
    saveAssignments(_task, assignments) {
      state.task = { ...state.task, assignments, status: tvMatchingReviewStatus(assignments) };
      return state.task;
    },
    hasActiveJob: () => state.active,
    hasEpisodeConflicts: async () => conflict,
    continueTask: (jobId, source) => { state.continued.push([jobId, source]); },
    isAllowedPoster: (url) => url.startsWith("https://image.tmdb.org/")
  };
  const queue = new MediaReviewQueueService();
  queue.register(new TvMatchingTaskItemAdapter(
    { get: (id) => (id === state.task.jobId ? state.task : undefined), list: () => [state.task] },
    { get: (fingerprint) => state.recoveries[fingerprint] },
    environment
  ));
  return { queue, state };
}

const identification = { seriesName: "Show", provider: "tvdb", providerId: "1", seasonNumber: 1 };
const fullAssignments = [{ trackId: "1", episodeNumbers: [1] }, { trackId: "2", episodeNumbers: [2, 3] }];
const code = (promise) => promise.then(() => "ok", (error) => error instanceof MediaReviewError ? error.code : `other:${error}`);

test("TV review completes through the unified service with identification and episode ranges", async () => {
  const { queue, state } = tvHarness();
  assert.deepEqual(queue.get("tv-matching-task:t1").tv.requires, ["identification", "assignments"]);
  const result = await queue.complete("tv-matching-task:t1", { identification, assignments: fullAssignments });
  assert.equal(result.continuation, "started");
  assert.deepEqual(state.continued, [["t1", "assignment-save"]]);
  assert.equal(result.item.status, "ready");
  assert.deepEqual(result.item.tv.requires, []);
  assert.deepEqual(result.item.tv.progress, { matched: 2, total: 2 });
  assert.deepEqual(result.item.tv.tracks[1].episodeNumbers, [2, 3]);
  assert.equal(result.item.selectedTitle, "Show");
  assert.ok(state.task.assignments[0].confirmedAt);
});

test("TV episode conflicts keep assignments staged instead of continuing", async () => {
  const { queue, state } = tvHarness({ conflict: true });
  const result = await queue.complete("tv-matching-task:t1", { identification, assignments: fullAssignments });
  assert.equal(result.continuation, "blocked");
  assert.deepEqual(state.continued, []);
  assert.ok(state.task.assignments[0].confirmedAt);
  assert.equal(await code(queue.complete("tv-matching-task:t1", { publish: "required" })), "conflict");
});

test("movie and TV reviews complete through the same service call and result shape", async () => {
  const movie = setup([job("j1")]);
  const tv = tvHarness();
  const movieResult = await movie.queue.complete("review-job:j1", { title: "The Break-Up (2006)" });
  const tvResult = await tv.queue.complete("tv-matching-task:t1", { identification, assignments: fullAssignments });
  for (const result of [movieResult, tvResult]) {
    assert.equal(result.continuation, "started");
    assert.ok(result.item.id);
  }
  assert.equal(movieResult.item.mediaType, "movie");
  assert.equal(tvResult.item.mediaType, "tv");
});

test("partial TV completion saves matches without publishing", async () => {
  const { queue, state } = tvHarness();
  const result = await queue.complete("tv-matching-task:t1", {
    identification, assignments: [{ trackId: "1", episodeNumbers: [1] }, { trackId: "2", episodeNumbers: [] }]
  });
  assert.equal(result.continuation, "not-ready");
  assert.deepEqual(state.continued, []);
  assert.deepEqual(result.item.tv.requires, ["assignments"]);
});

test("legacy TV endpoint semantics map onto completion publish modes", async () => {
  // PUT /identification -> publish "never"
  const first = tvHarness();
  const saved = await first.queue.complete("tv-matching-task:t1", { identification, publish: "never" });
  assert.equal(saved.continuation, "not-ready");
  assert.deepEqual(first.state.continued, []);
  assert.ok(saved.details.recovery);
  assert.ok(saved.details.task);

  // PUT /assignments -> publish "when-ready"; POST /continue -> publish "required"
  await first.queue.complete("tv-matching-task:t1", {
    assignments: [{ trackId: "1", episodeNumbers: [1] }], publish: "when-ready"
  });
  assert.equal(await code(first.queue.complete("tv-matching-task:t1", { publish: "required" })), "conflict");
  const ready = await first.queue.complete("tv-matching-task:t1", { assignments: fullAssignments });
  assert.equal(ready.details.progress.fullyMatched, true);
  const continued = await first.queue.complete("tv-matching-task:t1", { publish: "required" });
  assert.equal(continued.continuation, "started");
  assert.deepEqual(first.state.continued.at(-1), ["t1", "continue-action"]);

  const busy = tvHarness({ active: true });
  await busy.queue.complete("tv-matching-task:t1", { identification, publish: "never" });
  const queued = await busy.queue.complete("tv-matching-task:t1", { assignments: fullAssignments });
  assert.equal(queued.continuation, "queued");
  assert.equal(await code(busy.queue.complete("tv-matching-task:t1", { publish: "required" })), "conflict");
});

test("TV adapter validates input before persisting anything", async () => {
  const { queue, state } = tvHarness();
  const complete = (input) => code(queue.complete("tv-matching-task:t1", input));
  assert.equal(await complete({ identification: { ...identification, provider: "nope" } }), "invalid");
  assert.equal(await complete({ identification: { ...identification, extra: 1 } }), "invalid");
  assert.equal(await complete({ identification: { ...identification, seasonNumber: 101 } }), "invalid");
  assert.equal(await complete({ identification: { ...identification, posterUrl: "https://evil.example/p.jpg" } }), "invalid");
  assert.equal(await complete({ identification, assignments: [{ trackId: "9", episodeNumbers: [1] }] }), "invalid");
  assert.equal(await complete({ identification, assignments: [{ trackId: "1", episodeNumbers: [1, 2, 3, 4] }] }), "invalid");
  assert.equal(await complete({ identification, assignments: [{ trackId: "1", episodeNumbers: [1, 1] }] }), "invalid");
  assert.equal(await complete({ assignments: "nope" }), "invalid");
  assert.deepEqual(state.identifications, []);
  assert.equal(await complete({ assignments: fullAssignments }), "conflict");

  state.task = { ...state.task, status: "processing" };
  assert.equal(await complete({ identification }), "conflict");
  state.task = { ...state.task, status: "completed" };
  assert.equal(await complete({ assignments: fullAssignments }), "conflict");
  assert.equal(await code(queue.complete("tv-matching-task:missing", {})), "not-found");
});

test("TV plans complete by approval and reject non-pending plans", async () => {
  const approved = [];
  const plans = [{ ...tvPlan }, { ...tvPlan, id: "p2", state: "approved" }];
  const { queue } = setup([], {
    plans,
    approve: (planId, reviewer) => { approved.push([planId, reviewer]); plans[0].state = "approved"; }
  });
  const result = await queue.complete("tv-plan:p1", { reviewer: "admin" });
  assert.deepEqual(approved, [["p1", "admin"]]);
  assert.equal(result.item.status, "completed");
  assert.equal(await code(queue.complete("tv-plan:p2", {})), "conflict");
});

test("movie jobs with nothing left to decide resume without a title", async () => {
  const processing = job("proc", { metadata: { title: "Known Movie", namingSource: "Metadata match" } });
  const { queue, calls } = setup([processing]);
  const result = await queue.complete("review-job:proc", {});
  assert.equal(result.continuation, "started");
  assert.deepEqual(calls.resumed, ["proc"]);
  assert.deepEqual(calls.metadata, []);
  assert.equal(await code(setup([job("j2")]).queue.complete("review-job:j2", {})), "conflict");
});

test("concurrent completions of one review item are rejected while the first is in flight", async () => {
  const jobs = [job("j1")];
  const calls = { metadata: [], resumed: [] };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const queue = new MediaReviewQueueService();
  queue.register(new ReviewJobItemAdapter(jobRepo(jobs), () => ({
    updateMetadata: async (id, patch) => { await gate; calls.metadata.push([id, patch]); },
    resume: async (id) => { calls.resumed.push(id); }
  })));
  const first = queue.complete("review-job:j1", { candidateId: "7" });
  const second = code(queue.complete("review-job:j1", { title: "Other Title" }));
  assert.equal(await second, "conflict");
  release();
  await first;
  assert.deepEqual(calls.resumed, ["j1"]);
  assert.equal(calls.metadata.length, 1);
  assert.equal(calls.metadata[0][1].title, "The Break-Up (2006)");
  // The lock is released afterwards, even when the completion fails.
  assert.equal(await code(queue.complete("review-job:j1", { title: "Unknown Title 2026-01-02" })), "invalid");
  assert.equal(await code(queue.complete("review-job:j1", { title: "Again" })), "ok");
});

test("a metadata update refused after processing began is reported as a conflict, not invalid", async () => {
  const queue = new MediaReviewQueueService();
  queue.register(new ReviewJobItemAdapter(jobRepo([job("j1")]), () => ({
    updateMetadata: async () => { throw new MediaReviewError("conflict", "no longer pending"); },
    resume: async () => { throw new Error("must not resume"); }
  })));
  assert.equal(await code(queue.complete("review-job:j1", { title: "Late Title" })), "conflict");
});

test("TV tasks that are already completed are rejected for every completion mode", async () => {
  const { queue, state } = tvHarness();
  state.task = { ...state.task, status: "completed" };
  for (const input of [{}, { publish: "required" }, { publish: "never" }, { identification },
    { assignments: fullAssignments }]) {
    assert.equal(await code(queue.complete("tv-matching-task:t1", input)), "conflict");
  }
  assert.deepEqual(state.continued, []);
  assert.deepEqual(state.identifications, []);
});

test("movie reviews only resume without a title when one is stored or confirmed", async () => {
  const untitled = (id, extra = {}) => job(id, { metadata: { ...extra } });
  const blocked = setup([untitled("none")]);
  assert.equal(await code(blocked.queue.complete("review-job:none", {})), "invalid");
  assert.deepEqual(blocked.calls.resumed, []);

  const confirmed = setup([untitled("conf", { movieIdentificationConfirmed: true })]);
  assert.equal(await code(confirmed.queue.complete("review-job:conf", {})), "ok");
  assert.deepEqual(confirmed.calls.resumed, ["conf"]);

  const stored = setup([untitled("stored", { title: "Stored Movie", namingSource: "Metadata match" })]);
  assert.equal(await code(stored.queue.complete("review-job:stored", {})), "ok");
  assert.deepEqual(stored.calls.resumed, ["stored"]);
});

test("a blank title does not override a selected candidate", async () => {
  const { queue, calls } = setup([job("j1")]);
  await queue.complete("review-job:j1", { candidateId: "7", title: "   " });
  assert.equal(calls.metadata[0][1].title, "The Break-Up (2006)");
  assert.equal(await code(queue.complete("review-job:j1", { title: "   " })), "conflict");
});

test("an unknown candidate id is rejected even when a title is also supplied", async () => {
  const { queue, calls } = setup([job("j1")]);
  assert.equal(await code(queue.complete("review-job:j1", { candidateId: "nope", title: "Manual" })), "invalid");
  assert.deepEqual(calls.metadata, []);
  assert.deepEqual(calls.resumed, []);
});
