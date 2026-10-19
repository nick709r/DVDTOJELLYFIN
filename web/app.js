const $ = (selector) => document.querySelector(selector);
const state = { page: "dashboard", metrics: null, statsRange: "7d", metricsStream: null, statusStream: null, manualMusicMetadata: null };
const loginDialog = $("#login-dialog");
const themeToggle = $("#theme-toggle");

function setTheme(theme) {
  const isLight = theme === "light";
  document.documentElement.dataset.theme = isLight ? "light" : "dark";
  themeToggle.textContent = isLight ? "Dark mode" : "Light mode";
  themeToggle.setAttribute("aria-pressed", String(isLight));
  localStorage.setItem("autodisc-theme", isLight ? "light" : "dark");
}

setTheme(localStorage.getItem("autodisc-theme") === "light" ? "light" : "dark");
themeToggle.addEventListener("click", () => {
  setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
});

function notify(message, isError = false) {
  const box = $("#notice");
  box.textContent = message;
  box.classList.toggle("hidden", !message);
  box.classList.toggle("warning", isError);
  box.classList.toggle("notice", !isError);
  if (message && !isError) setTimeout(() => box.classList.add("hidden"), 5000);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers }
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    if (!loginDialog.open) loginDialog.showModal();
    $("#auth-state").textContent = "Sign-in required";
    throw new Error(payload.error || "Sign-in required");
  }
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unavailable";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function renderJob(job, fallbackStatus = "idle") {
  const status = job?.status || fallbackStatus;
  const badge = $("#job-badge");
  badge.textContent = status === "publishing" ? "Moving" : status === "failed" ? "Error" : status;
  badge.className = `badge ${status}`;
  const isMusic = job?.mediaType === "audio_cd";
  $("#job-title").textContent = job?.title || job?.discLabel || (status === "idle" ? "Waiting for a disc" : status === "completed" ? "Disc completed" : status === "failed" ? "Disc processing error" : "Checking inserted disc…");
  $("#job-detail").textContent = job?.error || (job?.outputPath
    ? job.outputPath
    : status === "idle" ? "Insert a video DVD or music CD to begin." : status === "inspecting" ? "Checking disc contents and title information." : status === "completed" ? (isMusic ? "Finished album is ready in Jellyfin Music." : "Finished movie is ready in Jellyfin Movies.") : status === "failed" ? "Check conversion history and service logs for details." : `Processing stage: ${status === "publishing" ? "moving" : status}`);
  const progress = Number(job?.progress || 0);
  $("#progress-bar").style.width = `${Math.max(0, Math.min(100, progress))}%`;
  $("#progress-label").textContent = status === "idle" ? "Waiting" : `${Math.round(progress)}%`;
  $("#encoder-label").textContent = job?.encoder ? `Encoder: ${job.encoder}` : "Encoder —";
  const canCancel = job && ["ripping", "converting"].includes(status);
  $("#cancel-job").classList.toggle("hidden", !canCancel);
  $("#cancel-job").dataset.jobId = canCancel ? job.id : "";
  if (!canCancel) {
    $("#cancel-job").disabled = false;
    $("#cancel-status").classList.add("hidden");
    $("#cancel-status").textContent = "";
  }
  document.querySelectorAll("[data-stage]").forEach((element) => {
    element.classList.toggle("active", ["ripping", "converting", "publishing"].includes(status) && element.dataset.stage === status);
  });
}

function renderManualMusicMetadata(prompt) {
  const dialog = $("#music-metadata-dialog");
  if (!prompt) {
    if (dialog.open) dialog.close();
    state.manualMusicMetadata = null;
    return;
  }
  if (state.manualMusicMetadata?.jobId === prompt.jobId && dialog.open) return;
  state.manualMusicMetadata = prompt;
  $("#music-metadata-disc").textContent = prompt.discId
    ? `Disc ID: ${prompt.discId}. The job is paused; the disc will remain in the drive.`
    : "No disc ID was available. The job is paused; the disc will remain in the drive.";
  $("#manual-track-fields").innerHTML = prompt.tracks.map((track) =>
    `<label>Track ${String(track.number).padStart(2, "0")} title<input name="track-${track.number}" maxlength="200" value="${escapeHtml(track.title)}" required></label>`
  ).join("");
  $("#music-metadata-form").elements.namedItem("artist").value = "";
  $("#music-metadata-form").elements.namedItem("album").value = "";
  $("#music-metadata-form").elements.namedItem("year").value = "";
  $("#music-metadata-form").elements.namedItem("source").value = "manual";
  $("#music-metadata-form").elements.namedItem("releaseId").value = "";
  $("#music-metadata-status").textContent = "Enter a release ID to load matching album and track details, or fill them in below.";
  $("#music-metadata-dialog").showModal();
}

function renderJobList(target, jobs, allowDelete = false) {
  if (!jobs.length) {
    target.innerHTML = '<div class="empty-state">No discs have been processed yet.</div>';
    return;
  }
  target.innerHTML = jobs.map((job) => {
    const title = escapeHtml(job.title || job.discLabel || "Unknown title");
    const when = new Date(job.startedAt).toLocaleString();
    const size = job.outputBytes ? formatBytes(job.outputBytes) : "—";
    const duration = formatDuration(job.durationSeconds);
    const type = job.mediaType === "audio_cd" ? "Music CD" : "DVD";
    const isActive = ["inspecting", "ripping", "converting", "publishing"].includes(job.status);
    const action = allowDelete && !isActive
      ? `<button class="button danger remove-job" type="button" data-job-id="${escapeHtml(job.id)}" aria-label="Remove ${title} from history">Remove</button>`
      : "";
    return `<div class="list-row${action ? " with-actions" : ""}"><div class="list-title">${title}<span class="list-sub">${escapeHtml(type)} · ${escapeHtml(when)}</span></div><span>${escapeHtml(job.encoder || "—")}</span><span>${size}</span><span class="result ${escapeHtml(job.status)}">${escapeHtml(job.status)}</span>${action}</div><div class="list-sub extra">${duration}${job.error ? ` · ${escapeHtml(job.error)}` : ""}</div>`;
  }).join("");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

async function refreshDashboard() {
  const data = await api("/api/v1/dashboard");
  state.hasActiveJob = Boolean(data.active);
  renderManualMusicMetadata(data.manualMusicMetadata);
  $("#total-count").textContent = data.stats.total ?? 0;
  $("#success-count").textContent = data.stats.successful ?? 0;
  $("#failure-count").textContent = data.stats.failures ?? 0;
  $("#average-duration").textContent = formatDuration(data.stats.averageSeconds);
  const lastFinished = ["completed", "failed", "cancelled"].includes(data.state) ? data.recent[0] : null;
  renderJob(data.active || lastFinished, data.state);
  renderJobList($("#recent-list"), data.recent);
  await refreshChart(state.statsRange);
  await loadTvSummary();
}

async function refreshHistory() {
  const data = await api("/api/v1/history?limit=250");
  renderJobList($("#history-list"), data.jobs, true);
}

function tvStat(label, value) {
  return `<article class="card stat"><span class="muted">${escapeHtml(label)}</span><strong>${escapeHtml(value ?? "0")}</strong></article>`;
}

function confidenceLabel(band) {
  return band === "high" ? "High confidence" : band === "medium" ? "Medium confidence" : "Review required";
}

function renderTvTrend(daily) {
  const points = daily.slice(-30);
  const maximum = Math.max(1, ...points.map((item) => item.count));
  $("#tv-trend").innerHTML = points.length
    ? points.map((item) => `<span title="${escapeHtml(item.day)}: ${item.count} TV discs" style="height:${Math.max(3, item.count / maximum * 100)}%"></span>`).join("")
    : '<div class="empty-state">No TV analysis history yet.</div>';
}

async function loadTvSummary() {
  const summary = await api("/api/v1/tv/summary");
  const stats = [
    ["TV discs analyzed", summary.totalDiscsAnalyzed],
    ["Episodes identified", summary.totalEpisodesIdentified],
    ["Matches suggested", summary.totalEpisodeMatchesSuggested],
    ["High confidence", summary.highConfidenceMatches],
    ["Medium confidence", summary.mediumConfidenceMatches],
    ["Low / review required", summary.lowConfidenceMatches],
    ["Reviews pending", summary.manualReviewsRequired],
    ["Reviews completed", summary.manualReviewsCompleted],
    ["Corrections applied", summary.correctionsApplied],
    ["Duplicate tracks", summary.duplicateTracksIdentified],
    ["Bonus features", summary.bonusFeaturesIdentified],
    ["Commentary tracks", summary.commentaryTracksIdentified]
  ];
  $("#tv-dashboard-stats").innerHTML = stats.map(([label, value]) => tvStat(label, value)).join("");
  renderTvTrend(summary.daily);
  $("#tv-statistics").innerHTML = [
    ["TV series processed", summary.totalSeriesProcessed],
    ["Seasons processed", summary.totalSeasonsProcessed],
    ["Episode matches suggested", summary.totalEpisodeMatchesSuggested],
    ["Manual corrections", summary.correctionsApplied],
    ["Labeled-case accuracy", summary.heldOutAccuracy === null ? "Not enough labels" : `${Math.round(summary.heldOutAccuracy * 100)}%`],
    ["Average plan confidence", summary.meanConfidence === null ? "—" : `${Math.round(summary.meanConfidence * 100)}%`],
    ["Review approval rate", summary.reviewApprovalRate === null ? "—" : `${Math.round(summary.reviewApprovalRate * 100)}%`]
  ].map(([label, value]) => tvStat(label, value)).join("");
  $("#tv-validation-summary").innerHTML = [
    ["Validation cases", summary.validation.cases],
    ["Labeled tracks", summary.validation.heldOutLabeledTracks],
    ["Exact matches", summary.validation.exactMatches],
    ["Incorrect matches", summary.validation.incorrectMatches],
    ["Abstentions", summary.validation.abstentions],
    ["Unresolved tracks", summary.validation.unresolvedTracks],
    ["Corrections", summary.correctionsApplied]
  ].map(([label, value]) => tvStat(label, value)).join("");
}

function renderTvPlanCard(plan, includeActions = false) {
  const editable = includeActions && !["approved", "rejected"].includes(plan.state);
  const series = plan.series?.title || "Unknown series";
  const season = plan.season ? `Season ${plan.season.number}` : "Unknown season";
  const disc = plan.discPosition?.discNumber ? `Disc ${plan.discPosition.discNumber}` : "Disc position unknown";
  const confidence = Math.round(plan.confidence * 100);
  const assignments = plan.assignments.map((assignment) => {
    const episodes = assignment.episodes.length
      ? assignment.episodes.map((episode) => `S${episode.seasonNumber}E${episode.episodeNumber}${episode.title ? ` · ${episode.title}` : ""}`).join(" + ")
      : "Unknown episode";
    return `<div class="tv-assignment ${assignment.confidenceBand}">
      <div><b>${escapeHtml(assignment.itemTitle || assignment.itemId)}</b><span class="list-sub">${escapeHtml(episodes)}</span></div>
      <span class="confidence-pill ${assignment.confidenceBand}">${Math.round(assignment.confidence * 100)}% · ${escapeHtml(confidenceLabel(assignment.confidenceBand))}</span>
      <p class="tv-reasoning">${assignment.explanation.map(escapeHtml).join(" · ") || "No explanation recorded."}</p>
      ${assignment.alternatives.length ? `<details><summary>${assignment.alternatives.length} alternative suggestion(s)</summary><ul>${assignment.alternatives.map((option) => `<li>${escapeHtml(option.episodes.map((episode) => `S${episode.seasonNumber}E${episode.episodeNumber}${episode.title ? ` · ${episode.title}` : ""}`).join(" + "))} · ${Math.round(option.confidence * 100)}%</li>`).join("")}</ul></details>` : ""}
      ${editable ? `<div class="tv-actions">
        ${assignment.episodes.length ? `<button class="button secondary tv-action" data-action="accept-match" data-plan-id="${escapeHtml(plan.id)}" data-item-id="${escapeHtml(assignment.itemId)}">Accept suggestion</button><button class="button secondary tv-action" data-action="reject-match" data-plan-id="${escapeHtml(plan.id)}" data-item-id="${escapeHtml(assignment.itemId)}">Reject suggestion</button>` : ""}
        <button class="button secondary tv-action" data-action="override-match" data-plan-id="${escapeHtml(plan.id)}" data-item-id="${escapeHtml(assignment.itemId)}">Override match</button>
        <button class="button secondary tv-action" data-action="mark-unknown" data-plan-id="${escapeHtml(plan.id)}" data-item-id="${escapeHtml(assignment.itemId)}">Mark unknown</button>
      </div>` : ""}
    </div>`;
  }).join("");
  return `<article class="tv-plan-card">
    <div class="tv-plan-heading"><div><b>${escapeHtml(series)}</b><span class="list-sub">${escapeHtml(season)} · ${escapeHtml(disc)} · ${new Date(plan.createdAt).toLocaleString()}</span></div>
    <span class="confidence-pill ${escapeHtml(plan.confidenceBand)}">${confidence}% · ${escapeHtml(confidenceLabel(plan.confidenceBand))}</span></div>
    <p>${plan.reviewReasons.map(escapeHtml).join(" · ") || "No additional review reasons."}</p>
    ${assignments || '<div class="empty-state">No episode assignments were generated.</div>'}
    <div class="tv-plan-foot"><span>State: ${escapeHtml(plan.state)} · ${plan.duplicateTracks.length} duplicates · ${plan.bonusFeatures.length} bonus · ${plan.commentaryTracks.length} commentary</span>
      <button class="button secondary tv-action" data-action="view-plan" data-plan-id="${escapeHtml(plan.id)}">Analysis details</button>
    </div>
    ${editable ? `<div class="tv-actions">
      <button class="button primary tv-action" data-action="approve-plan" data-plan-id="${escapeHtml(plan.id)}">Approve plan</button>
      <button class="button danger tv-action" data-action="reject-plan" data-plan-id="${escapeHtml(plan.id)}">Reject plan</button>
      <button class="button secondary tv-action" data-action="defer-plan" data-plan-id="${escapeHtml(plan.id)}">Defer</button>
    </div>` : ""}
  </article>`;
}

async function loadTvAnalysis() {
  const confidence = $("#tv-analysis-confidence").value;
  const planState = $("#tv-analysis-state").value;
  const query = new URLSearchParams({ limit: "100" });
  if (confidence) query.set("confidence", confidence);
  if (planState) query.set("state", planState);
  const data = await api(`/api/v1/tv/analysis?${query}`);
  $("#tv-analysis-list").innerHTML = data.plans.length
    ? data.plans.map((plan) => `<div class="tv-list-row">${renderTvPlanCard(plan).replace(/^<article class="tv-plan-card">|<\/article>$/g, "")}</div>`).join("")
    : '<div class="empty-state">No TV reports match these filters.</div>';
}

async function showTvPlan(planId, target = "#tv-analysis-detail") {
  const { plan, evidence } = await api(`/api/v1/tv/analysis/${encodeURIComponent(planId)}`);
  const detail = $(target);
  detail.innerHTML = `<div class="card-heading"><div><p class="eyebrow">ANALYSIS REPORT</p><h2>${escapeHtml(plan.series?.title || "Unknown series")} · ${escapeHtml(plan.season ? `Season ${plan.season.number}` : "Unknown season")}</h2></div><button class="text-button close-tv-detail">Close</button></div>
    <p>Disc position: ${escapeHtml(plan.discPosition ? `${plan.discPosition.discNumber}${plan.discPosition.discCount ? ` of ${plan.discPosition.discCount}` : ""}` : "unknown")} · Confidence ${Math.round(plan.confidence * 100)}% · ${escapeHtml(plan.state)}</p>
    <p>${plan.reviewReasons.map(escapeHtml).join(" · ") || "No review warnings."}</p>
    ${renderTvPlanCard(plan, false)}
    <div class="tv-detail-columns"><div><h3>Duplicate tracks</h3><pre>${escapeHtml(JSON.stringify(plan.duplicateTracks, null, 2))}</pre></div><div><h3>Alternate tracks</h3><pre>${escapeHtml(JSON.stringify(plan.alternateTracks, null, 2))}</pre></div>
      <div><h3>Bonus & commentary</h3><pre>${escapeHtml(JSON.stringify({ bonus: plan.bonusFeatures, commentary: plan.commentaryTracks, specialFeatures: plan.specialFeatures }, null, 2))}</pre></div></div>
    <h3>Decision evidence</h3><pre>${escapeHtml(evidence ? JSON.stringify({ source: evidence.source, metadata: evidence.metadata, policy: evidence.policy, analysis: evidence.analysis, matches: evidence.matches }, null, 2) : "Evidence capture is disabled or no validation case was retained.")}</pre>`;
  detail.classList.remove("hidden");
  detail.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function loadTvMatching() {
  const { plans } = await api("/api/v1/tv/analysis?limit=100");
  const items = plans.flatMap((plan) => plan.assignments.map((assignment) => ({ plan, assignment })));
  $("#tv-matching-list").innerHTML = items.length
    ? items.map(({ plan, assignment }) => renderTvPlanCard({
      ...plan,
      assignments: [assignment]
    }, true)).join("")
    : '<div class="empty-state">No TV episode suggestions are available yet.</div>';
}

async function loadTvReviews() {
  const selected = $("#tv-review-filter").value;
  const query = new URLSearchParams({ limit: "100" });
  if (selected) query.set("state", selected);
  const { plans } = await api(`/api/v1/tv/reviews?${query}`);
  $("#tv-review-list").innerHTML = plans.length
    ? plans.map((plan) => `${renderTvPlanCard(plan, true)}${plan.reviewHistory?.length ? `<p class="list-sub">Last reviewed by ${escapeHtml(plan.reviewedBy || "unknown")} · ${escapeHtml(plan.reviewedAt ? new Date(plan.reviewedAt).toLocaleString() : "")}${plan.reviewReason ? ` · ${escapeHtml(plan.reviewReason)}` : ""}</p>` : ""}`).join("")
    : '<div class="empty-state">No plans in this review state.</div>';
}

async function loadTvValidation() {
  const { summary, correctionCount, cases } = await api("/api/v1/tv/validation");
  $("#tv-validation-summary").innerHTML = [
    ["Validation cases", summary.cases],
    ["Held-out labels", summary.heldOutLabeledTracks],
    ["Exact matches", summary.exactMatches],
    ["Incorrect matches", summary.incorrectMatches],
    ["Abstentions", summary.abstentions],
    ["Unresolved tracks", summary.unresolvedTracks],
    ["Corrections", Object.values(summary.correctionOutcomes).reduce((total, count) => total + count, 0)]
  ].map(([label, value]) => tvStat(label, value)).join("");
  const matchBands = { high: 0, medium: 0, low: 0 };
  const reviewIssues = new Map();
  for (const evidence of cases) {
    for (const item of evidence.matches.items) {
      const band = item.confidence >= 0.9 ? "high" : item.confidence >= 0.72 ? "medium" : "low";
      matchBands[band] += 1;
    }
    for (const reason of evidence.plan.reviewReasons) {
      reviewIssues.set(reason, (reviewIssues.get(reason) || 0) + 1);
    }
  }
  const correctionRate = summary.tracks ? `${Math.round(correctionCount / summary.tracks * 100)}%` : "—";
  const accuracy = summary.heldOutLabeledTracks
    ? `${Math.round(summary.exactMatches / summary.heldOutLabeledTracks * 100)}%` : "Not enough labels";
  const commonIssues = [...reviewIssues].sort((left, right) => right[1] - left[1]).slice(0, 4)
    .map(([reason, count]) => `${reason} (${count})`).join(" · ") || "No review issues recorded";
  $("#tv-validation-insights").innerHTML = [
    ["Held-out accuracy", accuracy],
    ["Correction rate", correctionRate],
    ["High-confidence tracks", matchBands.high],
    ["Medium-confidence tracks", matchBands.medium],
    ["Low-confidence tracks", matchBands.low],
    ["Common review issues", commonIssues]
  ].map(([label, value]) => tvStat(label, value)).join("");
  $("#tv-validation-list").innerHTML = cases.length
    ? cases.map((evidence) => `<div class="list-row tv-case-row"><div class="list-title">${escapeHtml(evidence.plan.series?.title || evidence.source.label || "Unknown series")}<span class="list-sub">${escapeHtml(evidence.source.mediaKind)} · ${new Date(evidence.capturedAt).toLocaleString()} · ${escapeHtml(evidence.origin)}</span></div><span>${Math.round(evidence.plan.confidence * 100)}%</span><span>${escapeHtml(evidence.plan.state)}</span><button class="button secondary tv-action" data-action="view-case" data-case-id="${escapeHtml(evidence.id)}">View report</button></div>`).join("")
    : '<div class="empty-state">No validation evidence has been captured. Enable evidence capture in Settings to collect future cases.</div>';
  $("#tv-validation-detail").classList.add("hidden");
}

async function showTvValidationCase(caseId) {
  const detail = await api(`/api/v1/tv/validation/${encodeURIComponent(caseId)}`);
  const target = $("#tv-validation-detail");
  target.innerHTML = `<div class="card-heading"><h2>Validation report · ${escapeHtml(detail.evidence.source.label || detail.evidence.id)}</h2><button class="text-button close-tv-detail">Close</button></div><pre>${escapeHtml(detail.report)}</pre>`;
  target.classList.remove("hidden");
  target.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function loadStatistics() {
  const [dashboard, tv] = await Promise.all([api("/api/v1/dashboard"), api("/api/v1/tv/summary")]);
  const dvdStats = dashboard.mediaStats.find((item) => item.mediaType === "dvd") || { total: 0 };
  const musicStats = dashboard.mediaStats.find((item) => item.mediaType === "audio_cd") || { total: 0 };
  $("#processing-statistics").innerHTML = [
    ["Movies processed", dvdStats.total],
    ["Music CDs processed", musicStats.total],
    ["TV discs analyzed", tv.totalDiscsAnalyzed],
    ["Average processing time", formatDuration(dashboard.stats.averageSeconds)],
    ["Successful jobs", dashboard.stats.successful],
    ["Failed jobs", dashboard.stats.failures],
    ["Job success rate", dashboard.stats.total ? `${Math.round(dashboard.stats.successful / dashboard.stats.total * 100)}%` : "—"]
  ].map(([label, value]) => tvStat(label, value)).join("");
}

async function refreshChart(range) {
  state.statsRange = range;
  const data = await api(`/api/v1/stats?range=${encodeURIComponent(range)}`);
  const series = data.series || [];
  const max = Math.max(1, ...series.flatMap((entry) => [entry.successful || 0, entry.failures || 0]));
  const count = range === "30d" ? 30 : 7;
  const dateMap = new Map(series.map((entry) => [entry.day, entry]));
  const today = new Date();
  const items = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(today);
    date.setDate(today.getDate() - offset);
    const key = date.toISOString().slice(0, 10);
    const item = dateMap.get(key) || {};
    const success = Number(item.successful || 0);
    const failures = Number(item.failures || 0);
    const dayLabel = count === 7 || offset % 5 === 0 || offset === 0
      ? date.toLocaleDateString(undefined, { month: "numeric", day: "numeric" })
      : "";
    items.push(`<div class="chart-day" title="${key}: ${success} success, ${failures} failures"><div class="bars"><i class="bar" style="height:${Math.max(success ? 5 : 0, success / max * 100)}%"></i><i class="bar fail" style="height:${Math.max(failures ? 5 : 0, failures / max * 100)}%"></i></div><small>${dayLabel}</small></div>`);
  }
  $("#chart").innerHTML = items.join("");
}

async function loadSettings() {
  const data = await api("/api/v1/settings");
  const form = $("#settings-form");
  for (const key of ["moviesDir", "musicDir", "workDir", "opticalDevice", "format", "quality", "preset", "encoder", "logLevel", "lidarrUrl", "lidarrImportDir", "musicBrainzContactEmail"]) {
    if (data.settings[key] !== undefined) form.elements.namedItem(key).value = data.settings[key];
  }
  form.elements.namedItem("autoEject").checked = data.settings.autoEject;
  form.elements.namedItem("metadataEnabled").checked = data.settings.metadataEnabled;
  form.elements.namedItem("musicMetadataEnabled").checked = data.settings.musicMetadataEnabled;
  form.elements.namedItem("lidarrEnabled").checked = data.settings.lidarrEnabled;
  form.elements.namedItem("tvDetectionEnabled").checked = data.settings.tvDetectionEnabled;
  form.elements.namedItem("tvValidationLoggingEnabled").checked = data.settings.tvValidationLoggingEnabled;
  $("#lidarr-key-status").textContent = data.settings.lidarrApiKeyConfigured
    ? "A Lidarr API key is saved. It is never displayed."
    : "No Lidarr API key is saved.";
  $("#metadata-key-status").textContent = data.settings.metadataApiKeyConfigured
    ? "A metadata API key is saved. It is never displayed."
    : "No metadata API key is saved; lookup will use the disc label until one is configured.";
  $("#auth-state").textContent = data.settings.adminPasswordConfigured ? "Admin protection enabled" : "Password not configured";
  $("#logout").classList.toggle("hidden", !data.settings.adminPasswordConfigured);
  await refreshUpdateStatus();
  const encoders = await api("/api/v1/encoders");
  $("#encoder-capability").textContent = encoders.encoders.error
    ? encoders.encoders.error
    : `FFmpeg: ${encoders.encoders.nvidia ? "NVENC listed" : "NVENC unavailable"} · ${encoders.encoders.software ? "libx264 available" : "libx264 unavailable"}. Auto mode tests NVENC and falls back to software.`;
}

async function refreshUpdateStatus() {
  const data = await api("/api/v1/updates/status");
  $("#update-version").textContent = `Installed version: ${data.currentVersion}`;
  const status = $("#update-status");
  const button = $("#check-updates");
  if (data.state === "applying") {
    status.textContent = "An update is being installed. AutoDisc will restart automatically; do not power off the server.";
    button.disabled = true;
  } else if (data.state === "success") {
    status.textContent = `AutoDisc ${data.currentVersion} was updated successfully.`;
    button.disabled = false;
  } else if (data.state === "failed") {
    status.textContent = "The update failed. Check the updater journal for recovery details.";
    button.disabled = false;
  } else {
    status.textContent = "Updates are checked only when you click the button. A newer version is applied automatically.";
    button.disabled = false;
  }
}

function renderReleaseNotes(check) {
  $("#release-notes-title").textContent = `Release notes · ${check.latestVersion}`;
  $("#release-notes-body").textContent = check.releaseNotes ||
    check.releaseNotesMessage ||
    `Release notes are unavailable for ${check.latestVersion}.`;
  const link = $("#release-notes-link");
  if (check.releaseNotesUrl) {
    try {
      const url = new URL(check.releaseNotesUrl);
      if (url.protocol !== "https:" || url.hostname !== "github.com") throw new Error("Invalid release notes URL");
      link.href = url.href;
      link.classList.remove("hidden");
    } catch {
      link.removeAttribute("href");
      link.classList.add("hidden");
    }
  } else {
    link.removeAttribute("href");
    link.classList.add("hidden");
  }
}

async function waitForUpdate() {
  const deadline = Date.now() + 30 * 60 * 1000;
  let sawApplying = false;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      const data = await api("/api/v1/updates/status");
      $("#update-version").textContent = `Installed version: ${data.currentVersion}`;
      if (data.state === "applying") {
        sawApplying = true;
        $("#update-status").textContent = "Installing update… AutoDisc will restart when it is complete.";
      } else if (data.state === "success") {
        $("#update-status").textContent = `AutoDisc ${data.currentVersion} was updated successfully.`;
        return;
      } else if (data.state === "failed") {
        $("#update-status").textContent = "The update failed. Check the updater journal for recovery details.";
        return;
      } else if (sawApplying) {
        $("#update-status").textContent = "Update service restarted. Confirming the installed version…";
      }
    } catch {
      $("#update-status").textContent = "AutoDisc is restarting to apply the update…";
    }
  }
  $("#update-status").textContent = "The update is taking longer than expected. Check the AutoDisc system service and updater logs.";
}

function renderMetrics(snapshot) {
  state.metrics = snapshot;
  const cpu = snapshot.cpuPercent;
  $("#cpu-value").textContent = Number.isFinite(cpu) ? `${cpu}%` : "Measuring…";
  $("#cpu-bar").style.width = `${Number.isFinite(cpu) ? cpu : 0}%`;
  const memory = snapshot.memoryBytes;
  if (memory?.total > 0) {
    const percent = Math.round(memory.used / memory.total * 100);
    $("#memory-value").textContent = `${formatBytes(memory.used)} / ${formatBytes(memory.total)}`;
    $("#memory-bar").style.width = `${percent}%`;
  } else {
    $("#memory-value").textContent = "Unavailable";
  }
  if (snapshot.gpu && !snapshot.gpu.unavailable) {
    $("#gpu-value").textContent = `${snapshot.gpu.utilization}% · ${snapshot.gpu.memoryUsedMiB}/${snapshot.gpu.memoryTotalMiB} MiB`;
    $("#gpu-bar").style.width = `${snapshot.gpu.utilization}%`;
  } else {
    $("#gpu-value").textContent = "Unavailable";
    $("#gpu-bar").style.width = "0%";
  }
  $("#work-free").textContent = formatBytes(snapshot.freeDiskBytes?.work);
  $("#movies-free").textContent = formatBytes(snapshot.freeDiskBytes?.movies);
  $("#music-free").textContent = formatBytes(snapshot.freeDiskBytes?.music);
  if (snapshot.job) renderJob(snapshot.job);
}

function stopStreams() {
  state.metricsStream?.close();
  state.metricsStream = null;
  state.statusStream?.close();
  state.statusStream = null;
}

function updateStreams() {
  stopStreams();
  if (document.hidden) return;
  state.statusStream = new EventSource("/api/v1/events");
  state.statusStream.addEventListener("status", (event) => {
    const previous = state.hasActiveJob;
    const payload = JSON.parse(event.data);
    const active = payload.active;
    state.hasActiveJob = Boolean(active);
    renderManualMusicMetadata(payload.manualMusicMetadata);
    renderJob(active, payload.state);
    if (previous && !active) {
      if (state.page === "dashboard") refreshDashboard().catch((error) => notify(error.message, true));
      if (state.page === "history") refreshHistory().catch((error) => notify(error.message, true));
      if (state.page === "tv-analysis") loadTvAnalysis().catch((error) => notify(error.message, true));
      if (state.page === "episode-matching") loadTvMatching().catch((error) => notify(error.message, true));
      if (state.page === "tv-reviews") loadTvReviews().catch((error) => notify(error.message, true));
      if (state.page === "tv-validation") loadTvValidation().catch((error) => notify(error.message, true));
      if (state.page === "statistics") loadStatistics().catch((error) => notify(error.message, true));
    }
  });
  if (state.page === "dashboard") {
    state.metricsStream = new EventSource("/api/v1/system/events");
    state.metricsStream.addEventListener("metrics", (event) => renderMetrics(JSON.parse(event.data)));
  }
}

function showPage(page) {
  state.page = page;
  document.querySelectorAll(".page").forEach((section) => section.classList.toggle("hidden", section.id !== `page-${page}`));
  document.querySelectorAll("[data-page]").forEach((button) => button.classList.toggle("active", button.dataset.page === page));
  const pageTitles = {
    dashboard: "Dashboard",
    history: "History",
    "tv-analysis": "TV Analysis",
    "episode-matching": "Episode Matching",
    "tv-reviews": "TV Review Queue",
    "tv-validation": "TV Validation",
    statistics: "Statistics",
    settings: "Settings"
  };
  $("#page-title").textContent = pageTitles[page] || page;
  updateStreams();
  if (page === "dashboard") refreshDashboard().catch((error) => notify(error.message, true));
  if (page === "history") refreshHistory().catch((error) => notify(error.message, true));
  if (page === "tv-analysis") loadTvAnalysis().catch((error) => notify(error.message, true));
  if (page === "episode-matching") loadTvMatching().catch((error) => notify(error.message, true));
  if (page === "tv-reviews") loadTvReviews().catch((error) => notify(error.message, true));
  if (page === "tv-validation") loadTvValidation().catch((error) => notify(error.message, true));
  if (page === "statistics") loadStatistics().catch((error) => notify(error.message, true));
  if (page === "settings") loadSettings().catch((error) => notify(error.message, true));
}

document.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", () => showPage(button.dataset.page)));
document.querySelectorAll(".range").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll(".range").forEach((item) => item.classList.toggle("active", item === button));
  refreshChart(button.dataset.range).catch((error) => notify(error.message, true));
}));
$("#refresh-history").addEventListener("click", () => refreshHistory().catch((error) => notify(error.message, true)));
$("#tv-analysis-confidence").addEventListener("change", () => loadTvAnalysis().catch((error) => notify(error.message, true)));
$("#tv-analysis-state").addEventListener("change", () => loadTvAnalysis().catch((error) => notify(error.message, true)));
$("#tv-review-filter").addEventListener("change", () => loadTvReviews().catch((error) => notify(error.message, true)));

document.addEventListener("click", async (event) => {
  const button = event.target.closest(".tv-action, .close-tv-detail");
  if (!button) return;
  if (button.classList.contains("close-tv-detail")) {
    button.closest(".tv-detail")?.classList.add("hidden");
    return;
  }
  button.disabled = true;
  const planId = button.dataset.planId;
  const itemId = button.dataset.itemId;
  try {
    if (button.dataset.action === "view-plan") {
      if (state.page !== "tv-analysis") showPage("tv-analysis");
      await showTvPlan(planId);
      return;
    }
    if (button.dataset.action === "view-case") {
      await showTvValidationCase(button.dataset.caseId);
      return;
    }
    if (["approve-plan", "reject-plan", "defer-plan"].includes(button.dataset.action)) {
      const action = button.dataset.action.replace("-plan", "");
      const reason = action === "reject" ? prompt("Why is this TV plan being rejected?") : "";
      if (action === "reject" && !reason?.trim()) return;
      const result = await api(`/api/v1/tv/plans/${encodeURIComponent(planId)}/review`, {
        method: "POST",
        body: JSON.stringify({ action, reviewer: "admin", ...(reason ? { reason } : {}) })
      });
      notify(`TV plan ${result.plan.state}. Media execution remains disabled.`);
      await Promise.all([loadTvReviews(), loadTvSummary()]);
      return;
    }
    if (["accept-match", "reject-match", "override-match", "mark-unknown"].includes(button.dataset.action)) {
      let action = button.dataset.action;
      let episodes;
      let reason;
      if (action === "accept-match" || action === "reject-match") {
        const planData = await api(`/api/v1/tv/analysis/${encodeURIComponent(planId)}`);
        episodes = planData.plan.assignments.find((item) => item.itemId === itemId)?.episodes;
        if (action === "accept-match") {
          reason = "Accepted suggested match";
          if (!episodes?.length) throw new Error("There is no suggested episode to accept");
        } else {
          reason = prompt("Why is this episode suggestion incorrect?")?.trim();
          if (!reason) return;
        }
      } else if (action === "override-match") {
        const entered = prompt("Enter the episode as seriesId, season number, episode number (comma-separated):");
        if (!entered) return;
        const [seriesId, seasonNumber, episodeNumber] = entered.split(",").map((value) => value.trim());
        if (!seriesId || !/^\d+$/.test(seasonNumber) || !/^\d+$/.test(episodeNumber)) {
          throw new Error("Use the format seriesId, season number, episode number");
        }
        episodes = [{ seriesId, seasonNumber: Number(seasonNumber), episodeNumber: Number(episodeNumber) }];
        action = "assign-episodes";
        reason = prompt("Correction reason:")?.trim();
        if (!reason) return;
      } else {
        reason = prompt("Why should this track remain unknown?")?.trim();
        if (!reason) return;
      }
      await api(`/api/v1/tv/plans/${encodeURIComponent(planId)}/corrections`, {
        method: "POST",
        body: JSON.stringify({ action, itemId, episodes, reviewer: "admin", reason })
      });
      notify(action === "mark-unknown" ? "Track marked unknown." : "TV correction recorded for future matching.");
      await Promise.all([loadTvMatching(), loadTvReviews(), loadTvSummary()]);
    }
  } catch (error) {
    notify(error.message, true);
  } finally {
    button.disabled = false;
  }
});

$("#export-tv-validation").addEventListener("click", async () => {
  try {
    const dataset = await api("/api/v1/tv/validation/export");
    const file = new Blob([JSON.stringify(dataset, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(file);
    link.download = "autodisc-tv-validation.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  } catch (error) {
    notify(error.message, true);
  }
});
$("#cancel-job").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const id = button.dataset.jobId;
  if (!id || !confirm("Cancel the current disc job? Any finished media remains untouched.")) return;
  button.disabled = true;
  $("#cancel-status").textContent = "Sending cancellation request…";
  $("#cancel-status").classList.remove("hidden");
  try {
    await api(`/api/v1/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
    $("#cancel-status").textContent = "Cancellation requested. Temporary files will be cleaned up.";
  } catch (error) {
    button.disabled = false;
    $("#cancel-status").textContent = error.message;
    notify(error.message, true);
  }
});
$("#cancel-metadata-job").addEventListener("click", async () => {
  const jobId = state.manualMusicMetadata?.jobId;
  if (!jobId || !confirm("Cancel this disc job? The disc will not be processed.")) return;
  try {
    await api(`/api/v1/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
    $("#music-metadata-status").textContent = "Cancellation requested. Temporary files will be cleaned up.";
  } catch (error) {
    $("#music-metadata-status").textContent = error.message;
  }
});
$("#music-metadata-dialog").addEventListener("cancel", (event) => event.preventDefault());
$("#lookup-musicbrainz-release").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const prompt = state.manualMusicMetadata;
  const form = $("#music-metadata-form");
  const releaseId = form.elements.namedItem("releaseId").value.trim();
  if (!prompt || !releaseId) {
    $("#music-metadata-status").textContent = "Enter a MusicBrainz release ID first.";
    return;
  }
  button.disabled = true;
  $("#music-metadata-status").textContent = "Looking up this release on MusicBrainz…";
  try {
    const result = await api("/api/v1/musicbrainz/release", {
      method: "POST",
      body: JSON.stringify({ jobId: prompt.jobId, releaseId })
    });
    const metadata = result.metadata;
    form.elements.namedItem("artist").value = metadata.artist;
    form.elements.namedItem("album").value = metadata.album;
    form.elements.namedItem("year").value = metadata.year || "";
    form.elements.namedItem("source").value = "musicbrainz";
    for (const track of metadata.tracks) {
      const field = form.elements.namedItem(`track-${track.number}`);
      if (field) field.value = track.title;
    }
    $("#music-metadata-status").textContent = "Release matched. Review the details and save to continue.";
  } catch (error) {
    $("#music-metadata-status").textContent = `${error.message} Manual album and track entry is still available below.`;
  } finally {
    button.disabled = false;
  }
});
$("#music-metadata-form").addEventListener("input", (event) => {
  if (event.target.name !== "source") {
    $("#music-metadata-form").elements.namedItem("source").value = "manual";
  }
});
$("#music-metadata-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const prompt = state.manualMusicMetadata;
  if (!prompt || !form.reportValidity()) return;
  const values = new FormData(form);
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  $("#music-metadata-status").textContent = "Saving metadata and resuming CD processing…";
  try {
    await api(`/api/v1/jobs/${encodeURIComponent(prompt.jobId)}/music-metadata`, {
      method: "POST",
      body: JSON.stringify({
        artist: values.get("artist"),
        album: values.get("album"),
        year: values.get("year"),
        source: values.get("source"),
        tracks: prompt.tracks.map((track) => ({
          number: track.number,
          title: values.get(`track-${track.number}`)
        }))
      })
    });
    renderManualMusicMetadata(null);
    notify("Music metadata saved. CD processing resumed.");
  } catch (error) {
    $("#music-metadata-status").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
$("#history-list").addEventListener("click", async (event) => {
  const button = event.target.closest(".remove-job");
  if (!button || !confirm("Remove this entry from history? The finished media file will not be deleted.")) return;
  button.disabled = true;
  try {
    await api(`/api/v1/history/${encodeURIComponent(button.dataset.jobId)}`, { method: "DELETE" });
    await refreshHistory();
  } catch (error) {
    button.disabled = false;
    notify(error.message, true);
  }
});
document.addEventListener("visibilitychange", updateStreams);

$("#check-updates").addEventListener("click", async () => {
  const button = $("#check-updates");
  const status = $("#update-status");
  button.disabled = true;
  status.textContent = "Checking GitHub for a newer AutoDisc release…";
  try {
    const check = await api("/api/v1/updates/check");
    renderReleaseNotes(check);
    if (!check.updateAvailable) {
      status.textContent = `AutoDisc ${check.currentVersion} is up to date.`;
      return;
    }
    status.textContent = `AutoDisc ${check.latestVersion} is available. Starting the automatic update…`;
    await api("/api/v1/updates/apply", { method: "POST" });
    await waitForUpdate();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    try {
      const update = await api("/api/v1/updates/status");
      button.disabled = update.state === "applying";
    } catch {
      button.disabled = false;
    }
  }
});

$("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const patch = {
    moviesDir: values.get("moviesDir"),
    musicDir: values.get("musicDir"),
    workDir: values.get("workDir"),
    opticalDevice: values.get("opticalDevice"),
    format: values.get("format"),
    quality: Number(values.get("quality")),
    preset: values.get("preset"),
    encoder: values.get("encoder"),
    autoEject: form.elements.namedItem("autoEject").checked,
    metadataEnabled: form.elements.namedItem("metadataEnabled").checked,
    musicMetadataEnabled: form.elements.namedItem("musicMetadataEnabled").checked,
    musicBrainzContactEmail: values.get("musicBrainzContactEmail"),
    lidarrEnabled: form.elements.namedItem("lidarrEnabled").checked,
    tvDetectionEnabled: form.elements.namedItem("tvDetectionEnabled").checked,
    tvValidationLoggingEnabled: form.elements.namedItem("tvValidationLoggingEnabled").checked,
    lidarrUrl: values.get("lidarrUrl"),
    lidarrImportDir: values.get("lidarrImportDir"),
    metadataProvider: "tmdb",
    logLevel: values.get("logLevel")
  };
  if (values.get("metadataApiKey")) patch.metadataApiKey = values.get("metadataApiKey");
  if (form.elements.namedItem("clearMetadataKey").checked) patch.metadataApiKey = "";
  if (values.get("lidarrApiKey")) patch.lidarrApiKey = values.get("lidarrApiKey");
  if (form.elements.namedItem("clearLidarrApiKey").checked) patch.lidarrApiKey = "";
  if (values.get("adminPassword")) patch.adminPassword = values.get("adminPassword");
  try {
    await api("/api/v1/settings", { method: "PUT", body: JSON.stringify(patch) });
    form.elements.namedItem("adminPassword").value = "";
    form.elements.namedItem("metadataApiKey").value = "";
    form.elements.namedItem("clearMetadataKey").checked = false;
    form.elements.namedItem("lidarrApiKey").value = "";
    form.elements.namedItem("clearLidarrApiKey").checked = false;
    $("#settings-message").textContent = "Settings saved.";
    notify("Settings saved. Active jobs continue with their original settings.");
    if (patch.adminPassword) {
      $("#settings-message").textContent = "Password updated. Sign in again to continue.";
      $("#login-error").textContent = "";
      loginDialog.showModal();
    }
  } catch (error) {
    $("#settings-message").textContent = error.message;
  }
});

$("#check-paths").addEventListener("click", async () => {
  const button = $("#check-paths");
  const status = $("#paths-status");
  const form = $("#settings-form");
  const values = new FormData(form);
  button.disabled = true;
  status.classList.remove("hidden");
  status.textContent = "Checking configured folders and optical drive permissions…";
  try {
    const result = await api("/api/v1/paths/check", {
      method: "POST",
      body: JSON.stringify({
        moviesDir: values.get("moviesDir"),
        musicDir: values.get("musicDir"),
        workDir: values.get("workDir"),
        opticalDevice: values.get("opticalDevice"),
        lidarrImportDir: values.get("lidarrImportDir"),
        lidarrEnabled: form.elements.namedItem("lidarrEnabled").checked
      })
    });
    status.innerHTML = `<strong>${result.ok ? "All configured paths passed." : "Some path checks failed."}</strong>${result.checks.map((check) =>
      `<div class="path-check ${check.ok ? "passed" : "failed"}"><span>${check.ok ? "OK" : "FAIL"} · ${escapeHtml(check.name)}</span><span>${escapeHtml(check.message)}</span><small>${escapeHtml(check.path)}</small></div>`
    ).join("")}`;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("#test-lidarr").addEventListener("click", async () => {
  const status = $("#lidarr-status");
  status.textContent = "Connecting to Lidarr…";
  try {
    const form = $("#settings-form");
    const result = await api("/api/v1/lidarr/test", {
      method: "POST",
      body: JSON.stringify({
        url: form.elements.namedItem("lidarrUrl").value,
        apiKey: form.elements.namedItem("lidarrApiKey").value
      })
    });
    status.textContent = `Connected to Lidarr${result.version ? ` ${result.version}` : ""}.`;
  } catch (error) {
    status.textContent = error.message;
  }
});

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  try {
    await api("/api/v1/login", {
      method: "POST",
      body: JSON.stringify({ username: values.get("username"), password: values.get("password") })
    });
    form.elements.namedItem("password").value = "";
    loginDialog.close();
    $("#login-error").textContent = "";
    await loadSettings();
    await refreshDashboard();
    updateStreams();
  } catch (error) {
    $("#login-error").textContent = error.message;
  }
});

$("#logout").addEventListener("click", async () => {
  await api("/api/v1/logout", { method: "POST" }).catch(() => {});
  location.reload();
});

async function initialize() {
  try {
    const health = await api("/api/health");
    const notices = [];
    if (!health.ready) {
      notices.push(`Service needs attention: ${Object.entries(health.checks).filter(([name, ready]) => name !== "makemkv" && !ready).map(([name]) => name).join(", ")} unavailable. Check systemd logs and install required host tools.`);
    }
    if (!health.dvdReady) {
      notices.push("DVD ripping is unavailable because AutoDisc cannot find an executable makemkvcon on the service PATH. Install MakeMKV or make sure its command is available to the AutoDisc service; music CD ripping is unaffected.");
    }
    const status = await api("/api/v1/status");
    if (!status.passwordConfigured) {
      $("#auth-state").textContent = "Password not configured";
      notices.push("Admin password is unset. Anyone who can reach the service can administer it; restrict access to your trusted LAN and configure a password in Settings. Do not expose port 8787 to the internet.");
    }
    if (notices.length) {
      $("#warning").textContent = notices.join(" ");
      $("#warning").classList.remove("hidden");
    }
    await refreshDashboard();
    updateStreams();
  } catch (error) {
    if (error.message !== "Sign-in required") notify(error.message, true);
  }
}

initialize();
