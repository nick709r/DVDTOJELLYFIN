const $ = (selector) => document.querySelector(selector);
const state = { page: "dashboard", statsRange: "7d", metricsStream: null, statusStream: null, manualMusicMetadata: null, currentActiveJob: null, currentRuntimeStatus: "idle", statusEventVersion: 0, diagnosticsJobId: "", diagnosticsRefreshTimer: null, dashboardAttentionTimer: null, dashboardRequestId: 0, dashboardAttentionRequestId: 0, diagnosticsRequestId: 0, tvReviewsRequestId: 0, reviewCentreRequestId: 0, reviewJobsRequestId: 0, tvAnalysisRequestId: 0, tvMatchingRequestId: 0, chartRequestId: 0, storageManagerRequestId: 0, storageDashboardLastLoadedAt: 0, outputDestinations: null, legacyOutputPaths: {}, directoryPickerTarget: null, tvDeleteJobId: null, reviewDeletionTarget: null, orphanCleanupReport: null, storageCleanupCategory: null };
let capabilityReportLoaded = false;
const loginDialog = $("#login-dialog");
const passwordChangeDialog = $("#password-change-dialog");
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
  if (response.status === 403 && payload.passwordChangeRequired) {
    if (!passwordChangeDialog.open) passwordChangeDialog.showModal();
    throw new Error(payload.error);
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
  const jobDetail = job?.error || (job?.outputPath
    ? job.outputPath
    : status === "idle" ? "Insert a video DVD or music CD to begin." : status === "inspecting" ? "Checking disc contents and title information." : status === "completed" ? (isMusic ? "Finished album is ready in Jellyfin Music." : "Finished movie is ready in Jellyfin Movies.") : status === "failed" ? "Check conversion history and service logs for details." : `Processing stage: ${status === "publishing" ? "moving" : status}`);
  const classificationDetail = job?.classification
    ? `Automatic classification: ${job.classification.detectedMediaType}. ${job.classification.mediaTypeOverridden
      ? `Manual override active: ${job.classification.finalMediaType}.`
      : "No manual override."}`
    : "";
  $("#job-detail").textContent = [jobDetail, classificationDetail].filter(Boolean).join(" · ");
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
      ? `<button class="button danger remove-job" type="button" data-job-id="${escapeHtml(job.id)}" aria-label="Remove ${title} from history">Remove</button><button class="button danger forget-disc" type="button" data-job-id="${escapeHtml(job.id)}">Forget Disc</button>`
      : "";
    const classification = job.classification;
    const mediaTypeOptions = [
      ["movie", "Movie"], ["tv_series", "TV Series"], ["music_album", "Music"], ["data_disc", "Data Disc"]
    ];
    if (classification && !mediaTypeOptions.some(([value]) => value === classification.finalMediaType)) {
      mediaTypeOptions.unshift([classification.finalMediaType, `Current: ${classification.finalMediaType}`]);
    }
    const classificationControl = job.discFingerprint && classification
      ? `<details class="job-media-override"><summary>${classification.mediaTypeOverridden ? "Manual classification active" : "Automatic classification"} · ${escapeHtml(classification.finalMediaType)}</summary>
        <form class="job-media-override-form" data-fingerprint="${escapeHtml(job.discFingerprint)}">
          <p class="hint">Automatic Classification: ${escapeHtml(classification.detectedMediaType)}${classification.mediaTypeOverridden ? ` · Active Manual Override: ${escapeHtml(classification.finalMediaType)}` : ""}</p>
          <label>Manual override<select name="mediaType">${mediaTypeOptions.map(([value, label]) => `<option value="${escapeHtml(value)}"${classification.finalMediaType === value ? " selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select></label>
          <label>Reason (optional)<input name="mediaTypeReason" maxlength="500"></label>
          <button class="button secondary" type="submit"${isActive ? " disabled" : ""}>Save classification</button>
          ${isActive ? '<p class="hint">Changes are paused while this job is processing to protect its output. Save after it finishes.</p>' : ""}
          ${classification.audit?.length ? `<ul>${classification.audit.map((record) =>
            `<li>${escapeHtml(record.originalType)} → ${escapeHtml(record.newType)} · ${escapeHtml(record.username)} · ${escapeHtml(new Date(record.timestamp).toLocaleString())}${record.reason ? ` · ${escapeHtml(record.reason)}` : ""}</li>`
          ).join("")}</ul>` : ""}
        </form>
      </details>`
      : "";
    return `<div class="list-row${action ? " with-actions" : ""}"><div class="list-title">${title}<span class="list-sub">${escapeHtml(type)} · ${escapeHtml(when)}</span></div><span>${escapeHtml(job.encoder || "—")}</span><span>${size}</span><span class="result ${escapeHtml(job.status)}">${escapeHtml(job.status)}</span>${action}</div><div class="list-sub extra">${duration}${job.error ? ` · ${escapeHtml(job.error)}` : ""}${classificationControl}</div>`;
  }).join("");
}

document.addEventListener("submit", async (event) => {
  const form = event.target.closest(".job-media-override-form");
  if (!form) return;
  event.preventDefault();
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    await api(`/api/v1/discs/recovery/${encodeURIComponent(form.dataset.fingerprint)}`, {
      method: "PUT",
      body: JSON.stringify({
        mediaType: form.elements.mediaType.value,
        mediaTypeReason: form.elements.mediaTypeReason.value.trim() || undefined
      })
    });
    notify("Manual media classification saved and audit logged.");
    await Promise.all([refreshHistory(), refreshDashboard()]);
  } catch (error) {
    notify(error.message, true);
  } finally {
    button.disabled = false;
  }
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function parseDiagnosticMessage(message) {
  try {
    const value = JSON.parse(message);
    return value && typeof value === "object" ? value : { detail: String(value) };
  } catch {
    return { detail: message };
  }
}

function diagnosticValue(value) {
  if (value === null || value === undefined || value === "") return "Unavailable";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function diagnosticConfidence(value) {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : "Unavailable";
}

function diagnosticMediaType(value) {
  return ({
    dvd: "DVD",
    audio_cd: "Audio CD",
    unknown: "Unknown"
  })[value] || diagnosticValue(value);
}

function diagnosticClassification(value) {
  return ({
    movie: "Movie",
    tv: "TV",
    review: "Review Required",
    audio: "Audio",
    audio_cd: "Audio",
    unknown: "Unknown"
  })[value] || diagnosticValue(value);
}

function diagnosticPairs(entries) {
  return `<dl class="diagnostic-pairs">${entries.map(([label, value]) =>
    `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(diagnosticValue(value))}</dd></div>`
  ).join("")}</dl>`;
}

const DISK_TYPE_LABELS = { dvd: "DVD", bluray: "Blu-ray", audio_cd: "CD Audio", cdrom: "CD-ROM", mixed_mode: "Mixed Mode", unknown: "Unknown" };
const diskTypeLabel = (type) => DISK_TYPE_LABELS[type] || type;
state.classification = null;
state.diagnosticsFingerprint = null;

async function renderClassification(record, requestId = state.diagnosticsRequestId) {
  state.classification = record || null;
  const meta = await api("/api/v1/classification/audit?limit=1");
  if (requestId !== state.diagnosticsRequestId) return;
  const form = $("#classification-form");
  const m = (await api("/api/v1/classification/metrics")).metrics;
  if (requestId !== state.diagnosticsRequestId) return;
  const corrections = m.corrections.map((c) => `${escapeHtml(diskTypeLabel(c.from))} → ${escapeHtml(diskTypeLabel(c.to))}: ${c.count}`).join(" · ") || "none";
  $("#classification-metrics").innerHTML = diagnosticPairs([
    ["Total processed", m.totalProcessed], ["Auto accepted", m.autoAccepted], ["Reviewed", m.reviewed],
    ["Manual corrections", m.manualCorrections], ["Review required", m.reviewRequired]
  ]) + `<p class="hint">Common corrections: ${corrections}</p>`;
  if (!record) {
    $("#classification-summary").textContent = "No disc selected.";
    form.classList.add("hidden");
    return;
  }
  const overridden = record.detectedType !== record.finalType;
  $("#classification-summary").innerHTML = diagnosticPairs([
    ["Original detection", diskTypeLabel(record.detectedType)],
    ["Final type", diskTypeLabel(record.finalType) + (overridden ? " (manual override)" : "")],
    ["Confidence", record.confidence === null ? "Not available" : record.confidence.toFixed(2)],
    ["Review status", record.reviewStatus],
    ["Override reason", record.overrideReason || "—"],
    ["Reviewed by", record.reviewedBy || "—"],
    ["Reviewed at", record.reviewedAt ? new Date(record.reviewedAt).toLocaleString() : "—"]
  ]);
  const types = [...new Set([...meta.diskTypes, record.detectedType, record.finalType])];
  $("#classification-final").innerHTML = types.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(diskTypeLabel(t))}</option>`).join("");
  $("#classification-final").value = record.finalType;
  $("#classification-reason").innerHTML = '<option value="">Not needed (no change)</option>' +
    meta.overrideReasons.map((r) => `<option value="${r}">${r}</option>`).join("");
  $("#classification-reason").value = record.overrideReason || "";
  form.elements.namedItem("notes").value = record.notes || "";
  form.classList.remove("hidden");
}

async function renderDiscRecovery(payload, requestId = state.diagnosticsRequestId) {
  const form = $("#disc-recovery-form");
  const recovery = payload.job?.discFingerprint
    ? await api(`/api/v1/discs/recovery/${encodeURIComponent(payload.job.discFingerprint)}`)
    : state.diagnosticsFingerprint
      ? await api(`/api/v1/discs/recovery/${encodeURIComponent(state.diagnosticsFingerprint)}`)
      : { recovery: null };
  if (requestId !== state.diagnosticsRequestId) return;
  if (!recovery.recovery) {
    form.classList.add("hidden");
    return;
  }
  const item = recovery.recovery;
  form.dataset.fingerprint = item.fingerprint;
  const discTypes = [
    ["cd", "CD"], ["dvd", "DVD"], ["bluray", "Blu-ray"], ["uhd_bluray", "UHD Blu-ray"],
    ["data_disc", "Data Disc"], ["unknown", "Unknown"]
  ];
  form.elements.discType.innerHTML = discTypes.map(([value, label]) =>
    `<option value="${value}">${label}</option>`).join("");
  form.elements.discType.value = item.finalDiscType;
  form.elements.mediaType.value = item.finalMediaType;
  form.elements.mediaTypeReason.value = "";
  form.elements.metadataProvider.value = item.metadataProvider;
  form.elements.providerId.value = item.providerId || "";
  form.elements.seriesName.value = item.seriesName || "";
  form.elements.seasonNumber.value = item.seasonNumber ?? "";
  form.elements.notes.value = item.notes || "";
  $("#disc-recovery-summary").textContent =
    `Automatic Classification: ${item.detectedMediaType}; Manual Override: ${item.mediaTypeOverridden ? item.finalMediaType : "None (automatic classification active)"}. ` +
    `Detected disc: ${item.detectedDiscType}; final disc: ${item.finalDiscType}` +
    `${item.detectedConfidence === null ? "" : ` · detection confidence ${Math.round(item.detectedConfidence * 100)}%`}` +
    `${item.mediaTypeOverridden ? " · MANUAL MEDIA OVERRIDE ACTIVE" : ""}.` +
    ((recovery.mediaTypeAudit || []).length
      ? ` Last override: ${recovery.mediaTypeAudit[0].originalType} → ${recovery.mediaTypeAudit[0].newType} by ${recovery.mediaTypeAudit[0].username} at ${new Date(recovery.mediaTypeAudit[0].timestamp).toLocaleString()}${recovery.mediaTypeAudit[0].reason ? ` (${recovery.mediaTypeAudit[0].reason})` : ""}.`
      : "");
  form.classList.remove("hidden");
}

$("#classification-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const record = (await api(`/api/v1/classification/audit/${encodeURIComponent(state.classification.id)}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ finalType: form.finalType.value, overrideReason: form.overrideReason.value || undefined, notes: form.notes.value || undefined })
    })).record;
    await renderClassification(record);
    notify("Classification review saved.");
  } catch (error) { notify(error.message, true); }
});

$("#disc-recovery-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const season = form.elements.seasonNumber.value;
    await api(`/api/v1/discs/recovery/${encodeURIComponent(form.dataset.fingerprint)}`, {
      method: "PUT",
      body: JSON.stringify({
        discType: form.elements.discType.value,
        mediaType: form.elements.mediaType.value,
        mediaTypeReason: form.elements.mediaTypeReason.value.trim() || undefined,
        metadataProvider: form.elements.metadataProvider.value,
        providerId: form.elements.providerId.value.trim() || null,
        seriesName: form.elements.seriesName.value.trim() || null,
        seasonNumber: season === "" ? null : Number(season),
        notes: form.elements.notes.value
      })
    });
    notify("Media recovery saved. The new values take priority on the next disc detection.");
    await loadDiagnostics($("#diagnostics-job").value);
  } catch (error) {
    notify(error.message, true);
  }
});

function renderDiagnostics(payload) {
  const select = $("#diagnostics-job");
  const selectedId = payload.job?.id || (payload.liveOnly ? "" : state.diagnosticsJobId);
  const jobs = payload.jobs || [];
  select.innerHTML = `<option value="">Live / latest disc</option>${jobs.map((job) => {
    const label = job.title || job.discLabel || job.id;
    return `<option value="${escapeHtml(job.id)}">${escapeHtml(label)} · ${escapeHtml(new Date(job.startedAt).toLocaleString())} · ${escapeHtml(job.status)}</option>`;
  }).join("")}`;
  if (selectedId && jobs.some((job) => job.id === selectedId)) select.value = selectedId;
  else select.value = "";
  state.diagnosticsJobId = select.value;

  const live = payload.live;
  const job = payload.job;
  const timeline = Array.isArray(payload.timeline) ? payload.timeline : [];
  const events = timeline.map((item) => ({ ...item, data: parseDiagnosticMessage(item.message) }));
  const inspection = events.find((item) => item.stage === "disc-detected")?.data || live?.candidate || {};
  state.diagnosticsFingerprint = job?.discFingerprint || inspection.fingerprint || live?.fingerprint || null;
  const scoreEvent = [...events].reverse().find((item) => item.stage === "tv-classification" &&
    Array.isArray(item.data.criteria) && item.data.criteria.some((criterion) => Number.isFinite(criterion.weight))) ||
    [...events].reverse().find((item) => item.stage === "tv-classification" &&
      (item.data.decision || item.data.classification));
  const selectedClassification = diagnosticClassification(scoreEvent?.data.decision || scoreEvent?.data.classification ||
    (job?.mediaType === "audio_cd" ? "Audio" : live?.classification || "Unknown"));
  const activeLabel = job?.discLabel || inspection.label || live?.discLabel;
  const selectedMedia = job?.mediaType || inspection.discType || live?.mediaType;
  const liveFacts = [
    ["Drive ID", inspection.driveId || live?.driveId || `Configured drive · ${payload.configuredDevice || "Unavailable"}`],
    ["Device path", inspection.devicePath || live?.devicePath || payload.configuredDevice],
    ["Disc type", diagnosticMediaType(selectedMedia)],
    ["Detection time", (inspection.detectedAt || live?.detectedAt)
      ? new Date(inspection.detectedAt || live.detectedAt).toLocaleString()
      : "Unavailable"],
    ["Disc label", activeLabel],
    ["Disc fingerprint", job?.id ? inspection.fingerprint : live?.fingerprint],
    ["Detection method", inspection.detectionMethod || live?.detectionMethod],
    ["Source provider", inspection.sourceProvider || live?.sourceProvider],
    ["Providers attempted", (inspection.providersAttempted || live?.providersAttempted || []).join(", ") || "Unavailable"],
    ["Media classification", selectedClassification],
    ["Job status", job?.status || live?.status || "Waiting for disc"]
  ];
  $("#diagnostics-live").innerHTML = diagnosticPairs(liveFacts);
  $("#diagnostics-live-status").textContent = job
    ? `${job.title || activeLabel || "Disc"} · ${job.id}${job.error ? ` · ${job.error}` : ""}`
    : live?.reason || (live ? `${live.status} · Updated ${new Date(live.updatedAt).toLocaleString()}` : "No disc detection is currently active. Live diagnostics update when a disc is detected.");

  if (scoreEvent) {
    const criteria = Array.isArray(scoreEvent.data.criteria) ? scoreEvent.data.criteria : [];
    $("#diagnostics-classification").innerHTML = `
      ${diagnosticPairs([
        ["Overall classification", diagnosticClassification(scoreEvent.data.decision || scoreEvent.data.classification)],
        ["Confidence score", diagnosticConfidence(scoreEvent.data.confidence)],
        ["Decision", diagnosticClassification(scoreEvent.data.decision || scoreEvent.data.classification)],
        ["Reason", (scoreEvent.data.reasons || []).join("; ") || "No failed criteria"]
      ])}
      <div class="diagnostic-criteria">${criteria.map((criterion) => `
        <div class="${criterion.passed ? "criterion-pass" : "criterion-fail"}">
          <b>${criterion.passed ? "✓" : "✗"} ${escapeHtml(criterion.id)}</b>
          <span>${escapeHtml(criterion.explanation)}</span>
          <small>Weight ${diagnosticConfidence(criterion.weight)} · Contribution ${diagnosticConfidence(criterion.contribution)}</small>
        </div>`).join("") || '<p class="empty-state">Scorecard is not available for this disc.</p>'}</div>`;
  } else {
    $("#diagnostics-classification").innerHTML = '<div class="empty-state">Classification has not been recorded for this disc.</div>';
  }

  const manifest = inspection.manifest || live?.candidate?.manifest;
  const items = Array.isArray(manifest?.items) ? manifest.items : [];
  if (selectedMedia === "audio_cd") {
    const tracks = inspection.tracks || items.map((item) => ({ number: item.trackNumber, durationSeconds: item.durationSeconds }));
    $("#diagnostics-structure").innerHTML = `${diagnosticPairs([
      ["Track count", inspection.trackCount ?? tracks.length],
      ["Disc ID", inspection.discId || manifest?.identifiers?.musicBrainzDiscId],
      ["Disc fingerprint", inspection.fingerprint || live?.fingerprint]
    ])}<div class="diagnostic-list">${tracks.map((track) =>
      `<div>Track ${escapeHtml(diagnosticValue(track.number))}<span>${track.durationSeconds ? escapeHtml(formatDuration(track.durationSeconds)) : "Length unavailable from current CD inspection"}</span></div>`
    ).join("") || '<p class="empty-state">Audio track data is not available.</p>'}</div>`;
  } else if (selectedMedia === "dvd") {
    const titles = inspection.tvCandidateTitles || [];
    const bonus = inspection.bonusContentCandidates || [];
    const mainId = String(inspection.mainTitleCandidate ?? "");
    $("#diagnostics-structure").innerHTML = `${diagnosticPairs([
      ["Title count", inspection.titleCount ?? items.filter((item) => item.kind === "title").length],
      ["Chapters", "Unavailable from current MakeMKV inspection"],
      ["Main title candidate", mainId ? `Title ${mainId}` : "Unavailable"]
    ])}<div class="diagnostic-list">${items.filter((item) => item.kind === "title").map((item) => {
      const isMain = String(item.id) === mainId;
      const isTv = titles.some((candidate) => String(candidate.id) === String(item.id));
      const isBonus = bonus.some((candidate) => String(candidate.id) === String(item.id));
      return `<div><b>Title ${escapeHtml(item.id)}${item.title ? ` · ${escapeHtml(item.title)}` : ""}</b><span>${formatDuration(item.durationSeconds)}${isMain ? " · Main title candidate" : ""}${isTv ? " · TV candidate" : ""}${isBonus ? " · Bonus candidate" : ""}</span></div>`;
    }).join("") || '<p class="empty-state">No title manifest is available.</p>'}</div>`;
  } else {
    $("#diagnostics-structure").innerHTML = '<div class="empty-state">Disc structure is not available until a source provider recognizes the media.</div>';
  }

  const analysisEvent = [...events].reverse().find((item) => item.stage === "tv-analysis");
  const identificationEvent = [...events].reverse().find((item) => item.stage === "tv-identification");
  const stagedTask = payload.tvMatchingTask;
  $("#diagnostics-identification").innerHTML = (identificationEvent
    ? renderIdentificationDiagnostics(identificationEvent.data)
    : '<div class="empty-state">TV identification was not run for this disc.</div>') +
    (stagedTask ? `<h3>TV Matching staging</h3>${diagnosticPairs([
      ["Task status", stagedTask.status],
      ["Disc volume label", stagedTask.sourceLabel],
      ["Filesystem volume name", stagedTask.filesystemVolumeName],
      ["Fingerprint", stagedTask.fingerprint],
      ["Staged episode count", stagedTask.episodeCount],
      ["Failure", stagedTask.failure]
    ])}<details><summary>Staged assignment and lookup diagnostics</summary><pre>${escapeHtml(JSON.stringify({
      assignments: stagedTask.assignments,
      diagnostics: stagedTask.diagnostics
    }, null, 2))}</pre></details>` : "");
  $("#diagnostics-identify").classList.toggle("hidden", !state.diagnosticsFingerprint);
  const analysis = analysisEvent?.data.analysis;
  const matching = analysisEvent?.data.matching;
  if (analysis) {
    const series = analysis.seriesCandidates || [];
    const seasons = analysis.seasonCandidates || [];
    const itemsAnalysis = analysis.items || [];
    const matches = matching?.items || [];
    $("#diagnostics-tv").innerHTML = `<h3>Series candidates</h3>${series.length ? series.map((candidate) =>
      `<div class="diagnostic-row">${escapeHtml(candidate.series?.title || "Unknown series")} · ${diagnosticConfidence(candidate.confidence)} · ${escapeHtml(candidate.providerId || "provider unavailable")}</div>`
    ).join("") : '<p class="empty-state">No series candidates.</p>'}
      <h3>Season candidates</h3>${seasons.length ? seasons.map((candidate) =>
      `<div class="diagnostic-row">Season ${escapeHtml(candidate.season?.number)} · ${diagnosticConfidence(candidate.confidence)} · ${escapeHtml(candidate.providerId || "provider unavailable")}</div>`
    ).join("") : '<p class="empty-state">No season candidates.</p>'}
      <h3>Disc items and duplicate / bonus / commentary evidence</h3>${itemsAnalysis.map((item) =>
      `<div class="diagnostic-row">${escapeHtml(item.title || item.itemId)} · ${escapeHtml(item.kind)} · ${diagnosticConfidence(item.confidence)}${item.duplicateOf ? ` · duplicate of ${escapeHtml(item.duplicateOf)}` : ""}</div>`
    ).join("") || '<p class="empty-state">No TV item analysis.</p>'}
      <div class="diagnostic-analysis-summary">${[
        ["Duplicate detection", analysis.probableDuplicates],
        ["Alternate detection", analysis.probableAlternates],
        ["Bonus features", analysis.probableBonusContent],
        ["Commentary detection", analysis.commentaryTracks]
      ].map(([label, values]) => `<div><b>${label}</b><span>${values?.length ? values.map((item) =>
        `${escapeHtml(item.title || item.itemId)} · ${diagnosticConfidence(item.confidence)}`
      ).join("; ") : "None identified"}</span></div>`).join("")}</div>
      <h3>Episode matching</h3>${matches.map((item) =>
      `<div class="diagnostic-row"><b>${escapeHtml(item.itemTitle || item.itemId)}</b> · ${item.decision === "unknown" ? "Unknown" : escapeHtml((item.suggestedEpisodes || []).map((episode) => `S${episode.seasonNumber}E${episode.episodeNumber} ${episode.title || ""}`).join(", ") || item.decision)} · ${diagnosticConfidence(item.confidence)}
      <p>${escapeHtml((item.evidence || []).join("; "))}</p>${(item.alternatives || []).map((alternative) =>
        `<small>Alternative: ${escapeHtml((alternative.episodes || []).map((episode) => `S${episode.seasonNumber}E${episode.episodeNumber} ${episode.title || ""}`).join(", "))} · ${diagnosticConfidence(alternative.confidence)}</small>`
      ).join("")}</div>`
    ).join("") || '<p class="empty-state">No episode matches were recorded.</p>'}`;
  } else {
    $("#diagnostics-tv").innerHTML = '<div class="empty-state">TV analysis was not triggered for this disc.</div>';
  }

  const metadataEvent = [...events].reverse().find((item) => item.stage === "metadata-lookups" || item.stage === "metadata-results");
  const lookups = metadataEvent?.data.lookups || (metadataEvent ? [metadataEvent.data] : []);
  $("#diagnostics-metadata").innerHTML = lookups.length ? lookups.map((lookup) =>
    `<div class="diagnostic-metadata"><b>${escapeHtml(lookup.entityType || "Metadata lookup")}</b>
      <span>Duration: ${Number.isFinite(lookup.durationMs) ? `${lookup.durationMs} ms` : "Unavailable"}</span>
      <span>Providers used: ${escapeHtml([...new Set((lookup.candidates || []).map((candidate) => candidate.lookupDiagnostics?.sourceProviderId || candidate.providerId))].join(", ") || "No provider result")}</span>
      <span>Fallback provider: ${lookup.candidates?.some((candidate) => candidate.lookupDiagnostics?.fallbackUsed) ? "Used" : lookup.candidates?.length ? "Not used for returned candidates" : "Unavailable"}</span>
      <span>Cache: ${lookup.candidates?.length && lookup.candidates.every((candidate) => candidate.lookupDiagnostics) ? lookup.candidates.some((candidate) => candidate.lookupDiagnostics.cacheHit) ? "Hit" : "Miss" : "Unavailable for this result"}</span>
      ${(lookup.candidates || []).map((candidate) => `<div>${escapeHtml(candidate.title || candidate.metadata?.title || candidate.id)} · ${diagnosticConfidence(candidate.confidence)} · ${escapeHtml(candidate.lookupDiagnostics?.sourceProviderId || candidate.providerId)} · ${Number.isFinite(candidate.lookupDiagnostics?.durationMs) ? `${candidate.lookupDiagnostics.durationMs} ms` : "Timing unavailable"}</div>`).join("")}
      ${(lookup.failures || []).map((failure) => `<div class="diagnostic-error">Provider failure · ${escapeHtml(failure.providerId)}: ${escapeHtml(failure.message)}</div>`).join("")}
      ${(lookup.candidates || []).length === 0 && (lookup.failures || []).length === 0 ? '<small>No candidate or failure was reported by the provider.</small>' : ""}
    </div>`
  ).join("") : '<div class="empty-state">No metadata lookup event was recorded for this job.</div>';

  $("#diagnostics-pipeline").innerHTML = events.length ? events.map((item, index) => {
    const next = events[index + 1];
    const start = Date.parse(item.at);
    const end = next ? Date.parse(next.at) : job?.finishedAt ? Date.parse(job.finishedAt) : Date.now();
    const elapsed = Number.isFinite(start) && Number.isFinite(end) ? formatDuration(Math.max(0, (end - start) / 1000)) : "Unavailable";
    return `<div class="pipeline-event ${item.level === "error" ? "is-error" : item.level === "warn" ? "is-warning" : ""}">
      <div><b>${escapeHtml(item.stage)}</b><span class="result">${escapeHtml(item.level)}</span></div>
      <small>${escapeHtml(new Date(item.at).toLocaleString())} · ${escapeHtml(elapsed)} to next event</small>
      <p>${escapeHtml(item.message)}</p>
    </div>`;
  }).join("") : '<div class="empty-state">No processing pipeline events have been recorded.</div>';
  $("#diagnostics-log").innerHTML = events.length ? [...events].reverse().slice(0, 80).map((item) =>
    `<div class="diagnostic-log-row"><time>${escapeHtml(new Date(item.at).toLocaleTimeString())}</time><b class="${item.level === "error" ? "diagnostic-error" : item.level === "warn" ? "diagnostic-warning" : ""}">${escapeHtml(item.level)} · ${escapeHtml(item.stage)}</b><span>${escapeHtml(item.message)}</span></div>`
  ).join("") : '<div class="empty-state">Live job events will appear here as AutoDisc processes the disc.</div>';
}

async function loadDiagnostics(jobId = "", liveOnly = false) {
  const requestId = ++state.diagnosticsRequestId;
  const query = liveOnly ? "?live=1" : jobId ? `?jobId=${encodeURIComponent(jobId)}` : "";
  const payload = await api(`/api/v1/diagnostics${query}`);
  if (requestId !== state.diagnosticsRequestId) return;
  renderDiagnostics(payload);
  renderClassification(payload.classification, requestId).catch((error) => {
    if (requestId === state.diagnosticsRequestId) notify(error.message, true);
  });
  renderDiscRecovery(payload, requestId).catch((error) => {
    if (requestId === state.diagnosticsRequestId) notify(error.message, true);
  });
  if (!capabilityReportLoaded) loadCapabilities().catch((error) => notify(error.message, true));
}

function renderCapabilities(report) {
  $("#capability-platform").textContent =
    `${report.osName} · Checked ${new Date(report.checkedAt).toLocaleString()}`;
  $("#capability-report").innerHTML = report.checks.map((check) => {
    const passed = check.status === "available";
    return `<div class="${passed ? "criterion-pass" : "criterion-fail"}">
      <b>${passed ? "✓" : "⚠"} ${escapeHtml(check.title)}</b>
      <span>${escapeHtml(check.details)}</span>
      ${check.status !== "available" && check.remediation.length
        ? `<small>Steps: ${check.remediation.map((step) => escapeHtml(step)).join(" ")}</small>`
        : ""}
    </div>`;
  }).join("");
}

async function loadCapabilities() {
  const report = await api("/api/v1/capabilities");
  renderCapabilities(report);
  capabilityReportLoaded = true;
}

async function refreshDashboard() {
  const requestId = ++state.dashboardRequestId;
  const statusEventVersion = state.statusEventVersion;
  const data = await api("/api/v1/dashboard");
  if (requestId !== state.dashboardRequestId) return;
  const statusIsCurrent = statusEventVersion === state.statusEventVersion;
  if (statusIsCurrent) {
    state.currentActiveJob = data.active;
    state.currentRuntimeStatus = data.state;
    state.hasActiveJob = Boolean(data.active);
    renderManualMusicMetadata(data.manualMusicMetadata);
  }
  const lastFinished = ["completed", "failed", "cancelled"].includes(data.state) ? data.recent[0] : null;
  renderJob(statusIsCurrent ? data.active || lastFinished : state.currentActiveJob, state.currentRuntimeStatus);
  renderJobList($("#recent-list"), data.recent);
  renderLibraryHealth($("#library-dashboard-health"), data.libraries, false);
  await refreshChart(state.statsRange);
  if (requestId !== state.dashboardRequestId) return;
  await Promise.all([loadDashboardAttention(data), loadTvSummary(), loadTvMetadataMetrics(), loadDashboardStorage(requestId)]);
}

function formatStorageDate(value) {
  return value ? new Date(value).toLocaleString() : "—";
}

function renderStorageSummary(target, summary) {
  const values = [
    ["Total Application Storage", formatBytes(summary.totalApplicationBytes)],
    ["Recoverable Storage", formatBytes(summary.recoverableBytes)],
    ["Active Processing", formatBytes(summary.activeProcessingBytes)],
    ["Published Media", "Excluded"]
  ];
  $(target).innerHTML = values.map(([label, value]) =>
    `<div class="storage-summary-value"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`
  ).join("");
}

function renderStorageBreakdown(target, categories, totalBytes) {
  const visible = categories.filter((category) => category.bytes > 0);
  const maxBytes = Math.max(totalBytes, ...visible.map((category) => category.bytes), 1);
  $(target).innerHTML = visible.length
    ? visible.map((category) => `<div class="storage-breakdown-row">
      <span>${escapeHtml(category.name)}</span>
      <div class="storage-breakdown-track"><i style="width:${Math.min(100, category.bytes / maxBytes * 100)}%"></i></div>
      <b>${escapeHtml(formatBytes(category.bytes))}</b>
    </div>`).join("")
    : '<p class="muted">No AutoDisc storage data was found.</p>';
}

async function loadDashboardStorage(requestId) {
  if (Date.now() - state.storageDashboardLastLoadedAt < 60_000) return;
  state.storageDashboardLastLoadedAt = Date.now();
  const summary = await api("/api/v1/storage/summary");
  if (requestId !== state.dashboardRequestId) return;
  renderStorageSummary("#dashboard-storage-summary", summary);
  renderStorageBreakdown("#dashboard-storage-breakdown", summary.categories, summary.totalApplicationBytes);
  const warningVisible = summary.reviewQueueWarningActive;
  $("#dashboard-storage-warning").classList.toggle("hidden", !warningVisible);
  if (!warningVisible) return;
  $("#dashboard-storage-warning-message").textContent =
    `Review Queue data is using ${formatBytes(summary.reviewQueueBytes)} (threshold ${summary.reviewQueueWarningThresholdGb} GB).`;
  $("#dashboard-storage-warning-items").innerHTML = summary.largestReviewConsumers.map((item) =>
    `<div><b>${escapeHtml(item.name)}</b><span>${escapeHtml(formatBytes(item.bytes))}</span></div>`
  ).join("") || "<span>No individual review workspaces were found.</span>";
}

const storageCleanupActions = {
  "review-queue-data": "Clean Review Queue",
  "temporary-conversion-files": "Clean Conversion Cache",
  "artwork-cache": "Clean Artwork Cache",
  "metadata-cache": "Clean Metadata Cache",
  "orphaned-data": "Clean Orphaned Data",
  "failed-processing-jobs": "Clean Failed Jobs",
  "temporary-logs": "Clean Temporary Logs",
  "everything-safe": "Clean Everything Safe"
};

function renderStorageCategories(categories) {
  $("#storage-category-list").innerHTML = categories.map((category) => {
    const action = storageCleanupActions[category.id];
    const cleanupButton = action && category.reclaimableBytes > 0
      ? `<button class="button secondary" data-storage-cleanup="${escapeHtml(category.id)}">${escapeHtml(action)}</button>`
      : `<span class="muted">${category.id === "unmatched-tv-content" || category.id === "staged-rips" ? "Protected user media" : "Nothing to reclaim"}</span>`;
    return `<article class="storage-category">
      <div><h3>${escapeHtml(category.name)}</h3><p>${category.itemCount} item${category.itemCount === 1 ? "" : "s"} · Last changed ${escapeHtml(formatStorageDate(category.lastModifiedAt))}</p></div>
      <div><b>${escapeHtml(formatBytes(category.bytes))}</b><p>Storage used</p></div>
      <div><b>${escapeHtml(formatBytes(category.reclaimableBytes))}</b><p>Reclaimable</p></div>
      ${cleanupButton}
    </article>`;
  }).join("");
}

async function loadStorageManager() {
  const requestId = ++state.storageManagerRequestId;
  const [summary, orphanReport] = await Promise.all([
    api("/api/v1/storage/summary"),
    api("/api/v1/storage/orphans")
  ]);
  if (requestId !== state.storageManagerRequestId) return;
  const orphans = orphanReport.items;
  renderStorageSummary("#storage-manager-summary", summary);
  renderStorageBreakdown("#storage-manager-breakdown", summary.categories, summary.totalApplicationBytes);
  renderStorageCategories(summary.categories);
  $("#storage-orphan-summary").textContent = `${orphans.length} orphaned workspaces · ${formatBytes(orphans.reduce((sum, item) => sum + item.size, 0))} potentially reclaimable.${orphanReport.errors.length ? ` ${orphanReport.errors.length} scan issue(s) need attention.` : ""}`;
  const orphanRows = orphans.map((item) => `<div class="storage-orphan-row">
    <div><b>${escapeHtml(item.kind)}</b><br><code>${escapeHtml(item.path)}</code></div>
    <span>${escapeHtml(formatBytes(item.size))}</span>
    <span>${item.ageDays === null ? "Age unknown" : `${item.ageDays} days old`}</span>
    <span>${item.originalJobId ? `Original job ${escapeHtml(item.originalJobId)}` : "No original job found"}</span>
  </div>`).join("");
  $("#storage-orphan-list").innerHTML = [
    orphanReport.errors.length ? `<div class="warning">${orphanReport.errors.map(escapeHtml).join("<br>")}</div>` : "",
    orphanRows || '<div class="empty-state">No orphaned AutoDisc workspaces were found.</div>'
  ].join("");
  const largest = summary.categories.flatMap((category) => category.resources)
    .filter((item) => item.bytes > 0)
    .sort((first, second) => second.bytes - first.bytes)
    .slice(0, 10);
  $("#storage-largest-list").innerHTML = largest.length
    ? largest.map((item) => `<div class="storage-consumer">
      <div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.category.replaceAll("-", " "))}${item.jobId ? ` · Job ${escapeHtml(item.jobId)}` : ""}</p></div>
      <span>${escapeHtml(item.path || "Database cache")}</span>
      <b>${escapeHtml(formatBytes(item.bytes))}</b>
    </div>`).join("")
    : '<div class="empty-state">No storage consumers were found.</div>';
}

async function refreshStorageViews() {
  state.storageDashboardLastLoadedAt = 0;
  try {
    if (state.page === "storage-manager") await loadStorageManager();
    if (state.page === "dashboard") await loadDashboardStorage(state.dashboardRequestId);
  } catch (error) {
    notify(`Storage refresh failed: ${error.message}`, true);
  }
}

async function showStorageCleanupPreview(category) {
  const impact = await api(`/api/v1/storage/impact/${encodeURIComponent(category)}`);
  state.storageCleanupCategory = category;
  $("#storage-cleanup-title").textContent = storageCleanupActions[category] || "Confirm storage cleanup";
  $("#storage-cleanup-summary").textContent = impact.summary;
  $("#storage-cleanup-impact").textContent =
    `${impact.items} item${impact.items === 1 ? "" : "s"} · ${impact.files} file${impact.files === 1 ? "" : "s"} · Estimated ${formatBytes(impact.bytes)} recoverable.`;
  $("#storage-cleanup-confirm").disabled = impact.items === 0 && impact.files === 0 && impact.bytes === 0;
  $("#storage-cleanup-dialog").showModal();
}

$("#storage-cleanup-cancel").addEventListener("click", () => {
  state.storageCleanupCategory = null;
  $("#storage-cleanup-dialog").close();
});
$("#storage-cleanup-confirm").addEventListener("click", async () => {
  const category = state.storageCleanupCategory;
  if (!category) return;
  const button = $("#storage-cleanup-confirm");
  button.disabled = true;
  try {
    const result = await api(`/api/v1/storage/cleanup/${encodeURIComponent(category)}`, {
      method: "POST",
      body: JSON.stringify({ confirmed: true })
    });
    const recovered = formatBytes(result.bytesRecovered);
    const message = result.category === "metadata-cache"
      ? `Cleared ${result.recordsDeleted} metadata cache records (${formatBytes(result.bytes)} of reusable cache data). SQLite's database file was retained.`
      : `Cleanup finished: ${result.filesDeleted} files removed, ${recovered} recovered, ${result.recordsDeleted} database records removed.`;
    $("#storage-cleanup-result").textContent = message;
    notify(message);
    state.storageCleanupCategory = null;
    $("#storage-cleanup-dialog").close();
    state.storageDashboardLastLoadedAt = 0;
    await loadStorageManager();
    await refreshDashboard();
  } catch (error) {
    $("#storage-cleanup-result").textContent = error.message;
    notify(error.message, true);
    await refreshStorageViews();
  } finally {
    button.disabled = false;
  }
});
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-storage-cleanup]");
  if (!button) return;
  showStorageCleanupPreview(button.dataset.storageCleanup).catch((error) => notify(error.message, true));
});

async function loadDashboardAttention(dashboard) {
  const requestId = ++state.dashboardAttentionRequestId;
  const [{ tasks }, reviews, retryingReviews, { reviewJobs }, { plans }] = await Promise.all([
    api("/api/v1/tv/matching"),
    api("/api/v1/reviews?limit=250&status=active"),
    api("/api/v1/reviews?limit=250&status=retrying"),
    api("/api/v1/review-jobs"),
    api("/api/v1/tv/reviews?limit=100&state=awaiting-review")
  ]);
  if (requestId !== state.dashboardAttentionRequestId) return;
  const unmatchedTasks = tasks.filter((entry) => {
    const task = entry.task || entry;
    const assignments = task.assignments || [];
    const fullyMatched = entry.progress?.fullyMatched ??
      (assignments.length > 0 && assignments.every((assignment) => assignment.confirmed && assignment.selectedEpisodes?.length));
    return task.status !== "completed" && !fullyMatched;
  });
  const reviewItems = [...reviews.items, ...retryingReviews.items];
  const reviewItemsComplete = reviewItems.length === reviews.summary.active;
  const failedItems = new Set(reviewItems
    .filter((item) => item.category === "metadata_issue" || item.category === "processing_failure")
    .map((item) => item.relatedJobId || item.id));
  for (const entry of tasks) {
    const task = entry.task || entry;
    if (task.failure) failedItems.add(task.jobId);
  }
  const activeJob = state.statusEventVersion ? state.currentActiveJob : dashboard.active;
  const manualMusicMetadata = state.statusEventVersion ? state.manualMusicMetadata : dashboard.manualMusicMetadata;
  const activeTasks = new Set([
    ...(activeJob?.id ? [activeJob.id] : []),
    ...tasks.filter((entry) => (entry.task || entry).status === "processing")
      .map((entry) => (entry.task || entry).jobId)
  ]);
  const pendingReviewJobs = reviewJobs.filter((job) => job.status === "pending");
  const reviewJobIds = new Set(reviewItems.map((item) => item.relatedJobId).filter(Boolean));
  const reviewFingerprints = new Set(reviewItems.map((item) => item.discFingerprint).filter(Boolean));
  const additionalReviewIds = new Set();
  for (const job of pendingReviewJobs) {
    const key = job.originalJobId ? `job:${job.originalJobId}` : `review-job:${job.id}`;
    if (!reviewItemsComplete || !reviewJobIds.has(job.originalJobId)) additionalReviewIds.add(key);
  }
  for (const plan of plans) {
    if (!reviewItemsComplete || !reviewFingerprints.has(plan.fingerprint)) {
      additionalReviewIds.add(`disc:${plan.fingerprint}`);
    }
  }
  const waitingForReview = reviews.summary.active + additionalReviewIds.size;
  const unmatchedCount = unmatchedTasks.length;
  const failedCount = failedItems.size;
  const attentionCount = waitingForReview + unmatchedCount + failedCount;

  $("#dashboard-active-count").textContent = activeTasks.size;
  $("#dashboard-review-count").textContent = waitingForReview;
  $("#dashboard-unmatched-count").textContent = unmatchedCount;
  $("#dashboard-failed-count").textContent = failedCount;
  if (Array.isArray(dashboard.recent)) $("#dashboard-activity-count").textContent = dashboard.recent.length;
  $("#dashboard-attention").classList.toggle("hidden", attentionCount === 0);
  $("#dashboard-attention-message").textContent =
    `${unmatchedCount} unmatched TV disc${unmatchedCount === 1 ? "" : "s"}, ` +
    `${waitingForReview} item${waitingForReview === 1 ? "" : "s"} waiting for review, and ` +
    `${failedCount} failed identification${failedCount === 1 ? "" : "s"}.`;
  document.querySelectorAll("[data-attention-action]").forEach((button) => {
    const action = button.dataset.attentionAction;
    const visible = action === "open-review" ? waitingForReview > 0
      : action === "review-match" ? unmatchedCount > 0 || plans.length > 0
      : action === "fix-metadata" ? reviewItems.some((item) => item.category === "metadata_issue")
        : action === "continue-processing" ? pendingReviewJobs.length > 0 || Boolean(manualMusicMetadata)
          : unmatchedCount > 0;
    button.classList.toggle("hidden", !visible);
  });
}

function scheduleDashboardAttention(dashboard) {
  clearTimeout(state.dashboardAttentionTimer);
  state.dashboardAttentionTimer = setTimeout(() => {
    if (state.page !== "dashboard") return;
    loadDashboardAttention(dashboard).catch((error) => notify(error.message, true));
  }, 300);
}

function renderLibraryHealth(target, libraries, allowCreate) {
  if (!target) return;
  const names = { movies: "Movies", tv: "TV Shows", music: "Music" };
  target.innerHTML = libraries.map((library) => {
    const ready = library.exists && library.writable;
    const label = !library.exists ? "Missing" : library.writable ? "Ready" : "Not writable";
    return `<div class="library-health ${ready ? "ready" : "warning"}"><span>${ready ? "✓" : "⚠"} ${escapeHtml(names[library.type])} Library ${label}</span><span>${escapeHtml(library.path)} · Free space: ${formatBytes(library.freeBytes)}</span>${library.error ? `<small>${escapeHtml(library.error)}</small>` : ""}${allowCreate ? `<button class="button secondary create-library" data-library="${escapeHtml(library.type)}" type="button">${library.exists ? "Verify / repair folder" : "Create Folder"}</button>` : ""}</div>`;
  }).join("");
}

async function refreshLibraryHealth() {
  const { libraries } = await api("/api/library/health");
  renderLibraryHealth($("#library-settings-health"), libraries, true);
  renderLibraryHealth($("#library-dashboard-health"), libraries, false);
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
    ["TV series analyzed", summary.totalSeriesProcessed],
    ["Seasons analyzed", summary.totalSeasonsProcessed],
    ["Episode matches suggested", summary.totalEpisodeMatchesSuggested],
    ["Manual corrections", summary.correctionsApplied],
    ["Labeled validation accuracy", summary.heldOutAccuracy === null ? "Not enough labels" : `${Math.round(summary.heldOutAccuracy * 100)}%`],
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

async function loadTvMetadataMetrics() {
  const target = $("#tv-metadata-dashboard-stats");
  const status = $("#tv-metadata-dashboard-status");
  try {
    const metrics = await api("/api/v1/tv/metadata/metrics");
    const cacheTotal = metrics.cacheHits + metrics.cacheMisses;
    target.innerHTML = [
      ["Lookups attempted", metrics.lookupsAttempted],
      ["Lookups successful", metrics.lookupsSuccessful],
      ["Lookups failed", metrics.lookupsFailed],
      ["Cache hits", metrics.cacheHits],
      ["Cache misses", metrics.cacheMisses],
      ["Cache hit rate", cacheTotal ? `${Math.round(metrics.cacheHits / cacheTotal * 100)}%` : "—"],
      ["Average lookup time", metrics.averageLookupTimeMs === null ? "—" : `${metrics.averageLookupTimeMs} ms`]
    ].map(([label, value]) => tvStat(label, value)).join("");
    $("#tv-metadata-provider-activity").innerHTML = metrics.providers.length
      ? metrics.providers.map((provider) => `<div class="provider-activity-row">
          <b>${escapeHtml(provider.name)}</b>
          <span class="provider-health ${escapeHtml(provider.status)}">${escapeHtml(provider.status.replaceAll("_", " "))}</span>
          <span>Usage ${provider.usageCount}</span>
          <span>Last success ${provider.lastSuccessfulLookup ? escapeHtml(new Date(provider.lastSuccessfulLookup).toLocaleString()) : "—"}</span>
          <span>Last failure ${provider.lastFailure ? `${escapeHtml(provider.lastFailure)}${provider.lastFailureAt ? ` · ${escapeHtml(new Date(provider.lastFailureAt).toLocaleString())}` : ""}` : "—"}</span>
        </div>`).join("")
      : '<div class="empty-state">No TV metadata providers are registered.</div>';
    status.textContent = `Preferred provider: ${metrics.activeProvider?.name || "None"}. Provider usage counts include live API lookups; cached results are counted separately.`;
  } catch (error) {
    target.innerHTML = "";
    $("#tv-metadata-provider-activity").innerHTML = "";
    status.textContent = `Metadata metrics could not be loaded: ${error.message}`;
  }
}

function renderTvMetadataProviders(providers) {
  const providerMarkup = providers.length ? providers.map((provider) => {
    const validation = provider.lastValidation
      ? `${provider.lastValidation.status === "success" ? "Success" : "Failure"} · ${provider.lastValidation.message} · ${new Date(provider.lastValidation.validatedAt).toLocaleString()}`
      : "Not tested";
    const healthLabel = {
      healthy: "Healthy",
      unavailable: "Unavailable",
      authentication_failure: "Authentication failure",
      rate_limited: "Rate limited",
      disabled: "Disabled",
      not_configured: "Not configured",
      unverified: "Unverified"
    }[provider.health] || provider.health;
    return `<section class="tv-metadata-provider">
      <div class="card-heading"><div><h3>${escapeHtml(provider.name)}</h3><span class="provider-health ${escapeHtml(provider.health)}">${escapeHtml(healthLabel)}</span></div><span class="muted">${provider.lookupImplemented ? "TV lookup enabled" : "Lookup unavailable"}</span></div>
      <p class="hint">${escapeHtml(provider.healthMessage)}</p>
      <p class="hint">Usage ${provider.usageCount} · Last successful lookup ${provider.lastSuccessfulLookup ? escapeHtml(new Date(provider.lastSuccessfulLookup).toLocaleString()) : "—"} · Last failure ${provider.lastFailure ? `${escapeHtml(provider.lastFailure)}${provider.lastFailureAt ? ` · ${escapeHtml(new Date(provider.lastFailureAt).toLocaleString())}` : ""}` : "—"}</p>
      <label class="check"><input class="tv-metadata-provider-enabled" type="checkbox" data-provider-id="${escapeHtml(provider.id)}"${provider.enabled ? " checked" : ""}> Enable provider for lookup</label>
      ${provider.apiKeyRequired ? `<label>API key<input class="tv-metadata-provider-key" type="password" autocomplete="off" data-provider-id="${escapeHtml(provider.id)}" placeholder="${provider.apiKeyConfigured ? "Leave blank to keep saved key" : "Enter API key"}"></label>
      <label class="check"><input class="tv-metadata-provider-clear" type="checkbox" data-provider-id="${escapeHtml(provider.id)}"> Clear saved API key</label>
      <p class="hint">${provider.apiKeyConfigured ? "API key saved; its value is never displayed." : "No API key saved."}</p>` : ""}
      <button class="button secondary test-tv-metadata-provider" type="button" data-provider-id="${escapeHtml(provider.id)}">Test ${escapeHtml(provider.name)} connection</button>
      <p class="inline-info tv-metadata-validation" data-provider-validation="${escapeHtml(provider.id)}" role="status">${escapeHtml(validation)}</p>
    </section>`;
  }).join("") : '<div class="empty-state">No TV metadata providers are registered.</div>';
  $("#tv-metadata-providers").innerHTML = providerMarkup;

  const options = providers.map((provider) =>
    `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.name)}</option>`
  ).join("");
  const preferred = $("#settings-form").elements.namedItem("tvMetadataPreferredProviderId");
  const fallback = $("#settings-form").elements.namedItem("tvMetadataFallbackProviderId");
  preferred.innerHTML = options;
  fallback.innerHTML = `<option value="">None</option>${options}`;
}

async function loadTvMetadataSettings() {
  const data = await api("/api/v1/tv/metadata");
  const settings = data.settings;
  const form = $("#settings-form");
  renderTvMetadataProviders(data.providers);
  form.elements.namedItem("tvMetadataLookupEnabled").checked = settings.lookupEnabled;
  form.elements.namedItem("tvMetadataPreferredProviderId").value = settings.preferredProviderId;
  form.elements.namedItem("tvMetadataFallbackProviderId").value = settings.fallbackProviderId;
  form.elements.namedItem("tvMetadataCacheEnabled").checked = settings.cacheEnabled;
  form.elements.namedItem("tvMetadataCacheDurationHours").value = settings.cacheDurationHours;
  const thresholds = data.matchingPolicy.confidenceThresholds;
  const matching = data.matchingPolicy.matchingThresholds;
  $("#tv-metadata-matching-policy").innerHTML = `
    <p>High confidence: ≥ ${thresholds.high.toFixed(2)} · Medium confidence: ≥ ${thresholds.medium.toFixed(2)} · Below medium: review required.</p>
    <p>Episode match minimum: ${matching.minimumConfidence.toFixed(2)} · Ambiguity margin: ${matching.minimumMargin.toFixed(2)}.</p>
    <p>${escapeHtml(data.matchingPolicy.reviewPolicy)}</p><p>${escapeHtml(data.matchingPolicy.matchingPolicy)}</p>`;
}

const identificationStatusLabels = {
  matched: "✓ matched", "no-match": "– no match", skipped: "skipped", failed: "✗ failed", informational: "info"
};

function renderIdentificationDiagnostics(d) {
  if (!d) return '<p class="hint">No identification diagnostics have been recorded for this disc yet.</p>';
  const queries = d.queries || [];
  const terms = [...new Set(queries.map((query) => query.query))];
  const matchSummary = Object.entries(d.providerMatches || {}).map(([provider, count]) => `${provider}: ${count}`).join(", ");
  const selected = d.selected
    ? `${d.selected.title}${d.selected.year ? ` (${d.selected.year})` : ""} · ${d.selected.providerId} · via ${d.selected.origin}`
    : "None - identify the disc manually";
  return `<div class="tv-identification-diagnostics">${diagnosticPairs([
    ["Disc volume label", d.volumeLabel || "(empty)"],
    ["Filesystem volume name", d.filesystemVolumeName || "(unavailable)"],
    ["MakeMKV disc name", d.makemkvDiscName || "(unavailable)"],
    ["Fingerprint", d.fingerprint],
    ["Metadata providers queried", (d.providersQueried || []).join(", ") || "None"],
    ["Query terms used", terms.join(" | ") || "None (no usable disc name)"],
    ["Matches per provider", matchSummary || "None"],
    ["Selected", selected]
  ])}
    <h4>Identification pipeline</h4>
    <div class="diagnostic-list">${(d.steps || []).map((step) =>
      `<div><b>${escapeHtml(step.order)}. ${escapeHtml(step.name)}</b><span>${escapeHtml(identificationStatusLabels[step.status] || step.status)} · ${escapeHtml(step.detail)}</span></div>`).join("")}</div>
    <h4>Name sources and normalized search variants</h4>
    <div class="diagnostic-list">${(d.nameSources || []).map((source) =>
      `<div><b>${escapeHtml(source.name)}</b><span>${source.raw ? `"${escapeHtml(source.raw)}" → ${source.variants?.length ? escapeHtml(source.variants.join(" | ")) : "no usable name"}` : "Not available"}</span></div>`).join("")}</div>
    <h4>Queries sent</h4>
    <div class="diagnostic-list">${queries.map((query) =>
      `<div><b>${escapeHtml(query.query)}</b><span>${escapeHtml(query.providerId)} · ${escapeHtml(query.nameSource)} · ${escapeHtml(query.matches)} matches · ${escapeHtml(query.durationMs)} ms${query.failure ? ` · failed: ${escapeHtml(query.failure)}` : ""}</span></div>`).join("") || "<p class=\"empty-state\">No metadata query could be sent.</p>"}</div>
    <h4>Series candidates</h4>
    <div class="diagnostic-list">${(d.seriesCandidates || []).map((candidate) =>
      `<div><b>${escapeHtml(candidate.title)}${candidate.year ? ` (${escapeHtml(candidate.year)})` : ""}</b><span>${escapeHtml(candidate.providerId)} · ${diagnosticConfidence(candidate.confidence)}</span></div>`).join("") || '<p class="empty-state">No series candidates.</p>'}</div>
    <h4>Season candidates</h4>
    <div class="diagnostic-list">${(d.seasonCandidates || []).map((candidate) =>
      `<div><b>Season ${escapeHtml(candidate.seasonNumber)}</b><span>${escapeHtml(candidate.providerId)} · ${diagnosticConfidence(candidate.confidence)}</span></div>`).join("") || '<p class="empty-state">No season candidates.</p>'}</div>
    ${(d.failures || []).map((failure) => `<div class="diagnostic-error">Lookup failure · ${escapeHtml(failure.providerId)} (${escapeHtml(failure.query)}): ${escapeHtml(failure.message)}</div>`).join("")}
  </div>`;
}

const identifyDialog = $("#identify-disc-dialog");
const identifyState = { planId: null, taskId: null, fingerprint: null, selected: null, existing: null };

function fillNumberSelect(select, from, to, value, zeroLabel = "", optionalLabel = "") {
  const options = optionalLabel
    ? [`<option value=""${value === null || value === undefined ? " selected" : ""}>${escapeHtml(optionalLabel)}</option>`]
    : [];
  for (let number = from; number <= to; number += 1) {
    options.push(`<option value="${number}"${number === value ? " selected" : ""}>${number === 0 && zeroLabel ? zeroLabel : number}</option>`);
  }
  select.innerHTML = options.join("");
}

function showIdentifySelection(selected, season, disc, discName) {
  identifyState.selected = selected;
  $("#identify-step-series").classList.remove("active");
  $("#identify-step-season").classList.add("active");
  $("#identify-assignment").classList.remove("hidden");
  $("#identify-selected").innerHTML = `<b>${escapeHtml(selected.title)}${selected.year ? ` (${escapeHtml(selected.year)})` : ""}</b> · ${escapeHtml(selected.providerName || selected.provider)}`;
  const maxSeason = Math.max(selected.seasonCount || 0, season || 0, 15);
  fillNumberSelect($("#identify-season"), 0, maxSeason, season ?? 1, "0 - Specials");
  fillNumberSelect($("#identify-disc"), 1, Math.max(disc || 0, 20), disc, "", "Not specified");
  $("#identify-disc-name").value = discName || "";
  $("#identify-save").disabled = false;
}

function renderIdentifyResults(candidates) {
  $("#identify-results").innerHTML = candidates.map((candidate, index) => `
    <button type="button" class="identify-result" data-index="${index}">
      ${candidate.posterUrl ? `<img src="${escapeHtml(candidate.posterUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="identify-poster-missing">No poster</span>'}
      <span class="identify-result-body">
        <b>${escapeHtml(candidate.title)}</b>
        <small>${candidate.year ? escapeHtml(candidate.year) : "Year unknown"} · ${candidate.seasonCount ? `${escapeHtml(candidate.seasonCount)} season${candidate.seasonCount === 1 ? "" : "s"}` : "Seasons not reported"}</small>
        <small>${escapeHtml(candidate.providerName)} · ${diagnosticConfidence(candidate.confidence)} match</small>
        ${candidate.overview ? `<small class="identify-overview">${escapeHtml(candidate.overview.slice(0, 160))}</small>` : ""}
      </span>
    </button>`).join("");
  identifyState.candidates = candidates;
}

async function runIdentifySearch() {
  const query = $("#identify-search").value.trim();
  if (!query) return;
  const status = $("#identify-status");
  status.textContent = "Searching metadata providers...";
  $("#identify-results").innerHTML = "";
  try {
    const data = await api("/api/v1/tv/identify/search", { method: "POST", body: JSON.stringify({ query }) });
    renderIdentifyResults(data.candidates);
    const summary = data.queries.map((entry) => `${entry.providerId}: ${entry.failure ? `failed (${entry.failure})` : `${entry.matches} matches`} for "${entry.query}"`).join("; ");
    status.textContent = data.candidates.length ? summary : `No series found. ${summary}`;
  } catch (error) {
    status.textContent = error.message;
  }
}

async function openIdentifyDialog({ planId = null, taskId = null, fingerprint = null, suggested = "", focus = "series" }) {
  identifyState.planId = planId;
  identifyState.taskId = taskId;
  identifyState.selected = null;
  identifyState.existing = null;
  identifyState.candidates = [];
  let existing = null;
  if (taskId) {
    const data = await api(`/api/v1/tv/matching/${encodeURIComponent(taskId)}`);
    identifyState.fingerprint = data.task.fingerprint;
    existing = data.recovery?.seriesName ? {
      seriesName: data.recovery.seriesName, provider: data.recovery.metadataProvider,
      providerId: data.recovery.providerId, seasonNumber: data.recovery.seasonNumber,
      discNumber: data.recovery.discNumber, discName: data.recovery.discName
    } : null;
  } else if (planId) {
    const data = await api(`/api/v1/tv/plans/${encodeURIComponent(planId)}/identification`);
    identifyState.fingerprint = data.fingerprint;
    existing = data.identification;
  } else {
    identifyState.fingerprint = fingerprint;
    const { recovery } = await api(`/api/v1/discs/recovery/${encodeURIComponent(fingerprint)}`);
    existing = recovery?.seriesName ? {
      seriesName: recovery.seriesName, provider: recovery.metadataProvider, providerId: recovery.providerId,
      seasonNumber: recovery.seasonNumber, discNumber: recovery.discNumber, discName: recovery.discName
    } : null;
  }
  identifyState.existing = existing;
  $("#identify-step-series").classList.toggle("active", !existing);
  $("#identify-step-season").classList.toggle("active", Boolean(existing));
  $("#identify-disc-context").textContent = taskId
    ? `Disc fingerprint ${identifyState.fingerprint}. Identification will continue processing from the staged video without reinserting or re-ripping the disc.`
    : `Disc fingerprint ${identifyState.fingerprint}. The identification is remembered and applied automatically whenever this disc is inserted again.`;
  $("#identify-save").textContent = taskId ? "Identify And Continue" : "Save";
  $("#identify-assignment").classList.add("hidden");
  $("#identify-save").disabled = true;
  $("#identify-results").innerHTML = "";
  $("#identify-status").textContent = "Search by series title, TVDB ID (tvdb:12345), TMDB ID (tmdb:12345) or IMDb ID (tt1234567).";
  $("#identify-search").value = existing?.seriesName || suggested || "";
  if (existing) {
    showIdentifySelection({
      title: existing.seriesName, provider: existing.provider, providerName: existing.provider,
      seriesId: existing.providerId, year: null, seasonCount: 0
    }, existing.seasonNumber ?? 1, existing.discNumber ?? 1, existing.discName);
  }
  identifyDialog.showModal();
  if (focus === "season" && existing) $("#identify-season").focus();
  else if (focus === "disc" && existing) $("#identify-disc").focus();
  else $("#identify-search").focus();
  if (!existing && $("#identify-search").value) await runIdentifySearch();
}

$("#identify-search-button").addEventListener("click", () => runIdentifySearch());
$("#identify-search").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    runIdentifySearch();
  }
});
$("#identify-results").addEventListener("click", (event) => {
  const button = event.target.closest(".identify-result");
  if (!button) return;
  const candidate = identifyState.candidates[Number(button.dataset.index)];
  const current = identifyState.existing;
  showIdentifySelection(candidate, current?.seasonNumber ?? 1, current?.discNumber ?? 1, "");
  $("#identify-results").querySelectorAll(".identify-result").forEach((item) => item.classList.toggle("selected", item === button));
});
$("#identify-cancel").addEventListener("click", () => identifyDialog.close());
$("#identify-disc-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const selected = identifyState.selected;
  if (!selected) return;
  const save = $("#identify-save");
  save.disabled = true;
  try {
    const body = {
      seriesName: selected.title,
      provider: selected.provider,
      providerId: selected.seriesId || null,
      seasonNumber: Number($("#identify-season").value),
      discNumber: $("#identify-disc").value ? Number($("#identify-disc").value) : null,
      discName: $("#identify-disc-name").value.trim() || null,
      ...(selected.year ? { year: selected.year } : {}),
      ...(selected.posterUrl ? { posterUrl: selected.posterUrl } : {}),
      ...(selected.overview ? { overview: selected.overview } : {})
    };
    const path = identifyState.planId
      ? `/api/v1/tv/plans/${encodeURIComponent(identifyState.planId)}/identification`
      : `/api/v1/discs/${encodeURIComponent(identifyState.fingerprint)}/identification`;
    if (identifyState.taskId) {
      await api(`/api/v1/tv/matching/${encodeURIComponent(identifyState.taskId)}/identification`, {
        method: "PUT", body: JSON.stringify(body)
      });
      await api(`/api/v1/tv/matching/${encodeURIComponent(identifyState.taskId)}/continue`, { method: "POST" });
    } else {
      await api(path, { method: "PUT", body: JSON.stringify(body) });
    }
    identifyDialog.close();
    notify(identifyState.taskId
      ? `Identified ${selected.title}; processing is continuing from staged files.`
      : `Saved: ${selected.title} season ${body.seasonNumber} disc ${body.discNumber}. This disc will be recognised automatically next time.`);
    if (state.page === "tv-reviews") await loadTvReviews();
    if (state.page === "diagnostics") await loadDiagnostics($("#diagnostics-job").value);
  } catch (error) {
    notify(error.message, true);
  } finally {
    save.disabled = false;
  }
});

document.addEventListener("click", (event) => {
  const button = event.target.closest(".tv-identify");
  if (!button) return;
  openIdentifyDialog({
    planId: button.dataset.planId || null,
    taskId: button.dataset.taskId || null,
    fingerprint: button.dataset.fingerprint || null,
    suggested: button.dataset.suggested || "",
    focus: button.dataset.focus || "series"
  }).catch((error) => notify(error.message, true));
});

$("#diagnostics-identify").addEventListener("click", () => {
  if (!state.diagnosticsFingerprint) return;
  openIdentifyDialog({ fingerprint: state.diagnosticsFingerprint })
    .catch((error) => notify(error.message, true));
});

$("#identify-disc-open").addEventListener("click", async () => {
  try {
    const { plans } = await api("/api/v1/tv/reviews?limit=1&state=awaiting-review");
    if (!plans.length) {
      notify("No TV disc is awaiting review. Open Disc Diagnostics for a disc and use Identify Disc there.", true);
      return;
    }
    await openIdentifyDialog({ planId: plans[0].id, suggested: plans[0].series?.title || "" });
  } catch (error) { notify(error.message, true); }
});

function renderTvIdentifyActions(plan, recovery) {
  const identified = Boolean(recovery?.seriesName);
  const suggested = escapeHtml(recovery?.seriesName || plan.series?.title || "");
  const attrs = `data-plan-id="${escapeHtml(plan.id)}" data-suggested="${suggested}"`;
  const saved = identified
    ? `<p class="hint">Saved identification: <b>${escapeHtml(recovery.seriesName)}</b>${recovery.seasonNumber === null || recovery.seasonNumber === undefined ? "" : ` · Season ${escapeHtml(recovery.seasonNumber)}`}${recovery.discNumber ? ` · Disc ${escapeHtml(recovery.discNumber)}` : ""}${recovery.discName ? ` · ${escapeHtml(recovery.discName)}` : ""} (${recovery.identifiedBy === "user" ? "manual" : "saved mapping"}). It is applied automatically when this disc is inserted.</p>`
    : "";
  return `<div class="tv-identify-actions">
    ${saved}
    <div class="tv-actions">
      <button type="button" class="button ${identified || plan.series ? "secondary" : "primary"} tv-identify" ${attrs} data-focus="series">${identified || plan.series ? "Change Series" : "Identify Series"}</button>
      <button type="button" class="button secondary tv-identify" ${attrs} data-focus="season">Change Season</button>
      <button type="button" class="button secondary tv-identify" ${attrs} data-focus="disc">Change Disc Number</button>
    </div>
    <details class="tv-identification-details"><summary>Why this series? Identification diagnostics</summary>${renderIdentificationDiagnostics(recovery?.identificationDiagnostics)}</details>
  </div>`;
}

function renderTvRecoveryEditor(plan, recovery) {
  const trackOptions = plan.assignments.map((assignment) =>
    `<option value="${escapeHtml(assignment.itemId)}">${escapeHtml(assignment.itemTitle || `Track ${assignment.itemId}`)}</option>`).join("");
  const mappings = recovery?.mappings?.length
    ? recovery.mappings.flatMap((mapping) => mapping.episodes.map((episode) => ({
      trackId: mapping.trackId, episode, seriesId: episode.seriesId
    })))
    : plan.assignments.flatMap((assignment) => assignment.episodes.map((episode) => ({
      trackId: assignment.itemId, episode, seriesId: episode.seriesId
    })));
  const mappingRows = (mappings.length ? mappings : [{ trackId: plan.assignments[0]?.itemId || "", episode: {}, seriesId: plan.series?.id || "" }])
    .map(({ trackId, episode, seriesId }) => `<div class="tv-episode-map-row" data-episode-map-row>
      <label>Track<select data-map-track>${trackOptions.replace(`value="${escapeHtml(trackId)}"`, `value="${escapeHtml(trackId)}" selected`)}</select></label>
      <label>Provider episode<select data-map-provider-episode><option value="">Manual mapping</option></select></label>
      <label>Season<input data-map-season type="number" min="0" max="100" value="${escapeHtml(episode.seasonNumber ?? recovery?.seasonNumber ?? plan.season?.number ?? "")}"></label>
      <label>Episode<input data-map-episode type="number" min="0" max="1000" value="${escapeHtml(episode.episodeNumber ?? "")}"></label>
      <label>Episode title<input data-map-title maxlength="500" value="${escapeHtml(episode.title || "")}"></label>
      <label>Air date<input data-map-air-date type="date" value="${escapeHtml(episode.airDate || "")}"></label>
      <label>Episode notes<input data-map-notes maxlength="1000" value="${escapeHtml(episode.notes || "")}"></label>
      <input data-map-series-id type="hidden" value="${escapeHtml(seriesId || plan.series?.id || "")}">
      <button type="button" class="button secondary" data-action="remove-episode-map">Remove</button>
    </div>`).join("");
  const discType = recovery?.finalDiscType || "dvd";
  const mediaType = recovery?.finalMediaType || "tv_series";
  const provider = recovery?.metadataProvider || "manual";
  return `<details class="tv-recovery-editor">
    <summary>Manual classification, metadata & episode recovery</summary>
    <p class="hint">Automatic Classification: ${escapeHtml(recovery?.detectedMediaType || "TV series")} · Manual Override: ${escapeHtml(recovery?.mediaTypeOverridden ? mediaType : "None")}${recovery?.mediaTypeOverridden ? " (active)" : ""}. Physical disc: ${escapeHtml(recovery?.detectedDiscType || "DVD")} → ${escapeHtml(discType)}</p>
    <form class="tv-recovery-form" data-plan-id="${escapeHtml(plan.id)}">
      <div class="tv-recovery-fields">
        <label>Disc type<select name="discType">${[
          ["cd", "CD"], ["dvd", "DVD"], ["bluray", "Blu-ray"], ["uhd_bluray", "UHD Blu-ray"], ["data_disc", "Data Disc"], ["unknown", "Unknown"]
        ].map(([value, label]) => `<option value="${value}"${discType === value ? " selected" : ""}>${label}</option>`).join("")}</select></label>
        <label>Media type<select name="mediaType">${[
          ["movie", "Movie"], ["tv_series", "TV Series"], ["music_album", "Music"], ["data_disc", "Data Disc"], ["audiobook", "Audiobook"],
          ["music_video", "Music Video"], ["concert", "Concert"], ["documentary", "Documentary"], ["mixed_content", "Mixed Content"], ["other", "Other"]
        ].map(([value, label]) => `<option value="${value}"${mediaType === value ? " selected" : ""}>${label}</option>`).join("")}</select></label>
        <label>Override reason (optional)<input name="mediaTypeReason" maxlength="500"></label>
        <label>Metadata provider<select name="metadataProvider">${[
          ["tvdb", "TVDB"], ["tmdb", "TMDB"], ["imdb", "IMDb"], ["anidb", "AniDB"], ["manual", "Manual Entry"]
        ].map(([value, label]) => `<option value="${value}"${provider === value ? " selected" : ""}>${label}</option>`).join("")}</select></label>
        <label>Provider ID<input name="providerId" maxlength="200" value="${escapeHtml(recovery?.providerId || "")}"></label>
        <label>Series name<input name="seriesName" maxlength="200" value="${escapeHtml(recovery?.seriesName || plan.series?.title || "")}"></label>
        <label>Season number<input name="seasonNumber" type="number" min="0" max="100" value="${escapeHtml(recovery?.seasonNumber ?? plan.season?.number ?? "")}"></label>
      </div>
      <div class="tv-actions">
        <button type="button" class="button secondary" data-action="lookup-series">Lookup Series</button>
        <button type="button" class="button secondary" data-action="import-series" disabled>Import Metadata</button>
        <button type="button" class="button secondary" data-action="add-episode-map">Add episode mapping</button>
      </div>
      <div class="tv-series-lookup-result" aria-live="polite"></div>
      <h4>Detected tracks (drag a track to a mapping, or use its dropdown)</h4>
      <div class="tv-recovery-tracks">${plan.assignments.map((assignment) => `<div class="tv-recovery-track" draggable="true" data-track-id="${escapeHtml(assignment.itemId)}">${escapeHtml(assignment.itemTitle || `Track ${assignment.itemId}`)} · ${escapeHtml(assignment.itemId)}</div>`).join("")}</div>
      <h4>Episode mapping</h4>
      <div class="tv-episode-map-list">${mappingRows}</div>
      <label>Notes<textarea name="notes" maxlength="2000">${escapeHtml(recovery?.notes || "")}</textarea></label>
      <button type="submit" class="button primary">Save Metadata and Mappings</button>
      <p class="hint">Saving applies the manual classification and mappings on the next disc detection. TV outputs use Series/Season NN/Series - SnnEnn - Episode Title.ext.</p>
    </form>
  </details>`;
}

function renderTvPlanCard(plan, includeActions = false, recovery = null, includeRecovery = false) {
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
      <span class="tv-assignment-source">${escapeHtml(tvAssignmentSource(
        assignment.assignmentMethod || (assignment.episodes.length ? "runtime-matching" : undefined), recovery
      ))}</span>
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
    ${includeRecovery ? renderTvIdentifyActions(plan, recovery) : ""}
    ${assignments || '<div class="empty-state">No episode assignments were generated.</div>'}
    <div class="tv-plan-foot"><span>State: ${escapeHtml(plan.state)} · ${plan.duplicateTracks.length} duplicates · ${plan.bonusFeatures.length} bonus · ${plan.commentaryTracks.length} commentary</span>
      <button class="button secondary tv-action" data-action="view-plan" data-plan-id="${escapeHtml(plan.id)}">Analysis details</button>
    </div>
    ${editable ? `<div class="tv-actions">
      <button class="button primary tv-action" data-action="approve-plan" data-plan-id="${escapeHtml(plan.id)}">Approve plan</button>
      <button class="button danger tv-action" data-action="reject-plan" data-plan-id="${escapeHtml(plan.id)}">Reject plan</button>
      <button class="button secondary tv-action" data-action="defer-plan" data-plan-id="${escapeHtml(plan.id)}">Defer</button>
    </div>` : ""}
    ${includeRecovery ? renderTvRecoveryEditor(plan, recovery) : ""}
  </article>`;
}

async function loadTvAnalysis() {
  const requestId = ++state.tvAnalysisRequestId;
  const confidence = $("#tv-analysis-confidence").value;
  const planState = $("#tv-analysis-state").value;
  const query = new URLSearchParams({ limit: "100" });
  if (confidence) query.set("confidence", confidence);
  if (planState) query.set("state", planState);
  const data = await api(`/api/v1/tv/analysis?${query}`);
  if (requestId !== state.tvAnalysisRequestId) return;
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
  const requestId = ++state.tvMatchingRequestId;
  const { plans } = await api("/api/v1/tv/analysis?limit=100");
  if (requestId !== state.tvMatchingRequestId) return;
  const items = plans.flatMap((plan) => plan.assignments.map((assignment) => ({ plan, assignment })));
  $("#tv-matching-list").innerHTML = items.length
    ? items.map(({ plan, assignment }) => renderTvPlanCard({
      ...plan,
      assignments: [assignment]
    }, true)).join("")
    : '<div class="empty-state">No TV episode suggestions are available yet.</div>';
}

const tvEpisodeGuides = new Map();

function tvEpisodeGuideKey(recovery) {
  return `${recovery.metadataProvider}:${recovery.providerId}:${recovery.seasonNumber}`;
}

async function loadTvEpisodeGuides(entries) {
  await Promise.all(entries.map(async ({ task, recovery }) => {
    if (!recovery?.seriesName || recovery.seasonNumber === null || recovery.seasonNumber === undefined ||
      !recovery.providerId || !["tvdb", "tmdb", "imdb"].includes(recovery.metadataProvider)) return;
    const key = tvEpisodeGuideKey(recovery);
    if (tvEpisodeGuides.has(key)) return;
    try {
      const { episodes } = await api("/api/v1/tv/metadata/episodes/lookup", {
        method: "POST",
        body: JSON.stringify({
          provider: recovery.metadataProvider,
          providerId: recovery.providerId,
          seasonNumber: recovery.seasonNumber
        })
      });
      tvEpisodeGuides.set(key, { episodes, error: "" });
    } catch (error) {
      tvEpisodeGuides.set(key, { episodes: [], error: error.message });
    }
  }));
}

function tvEpisodeOptions(task, recovery, assignment) {
  const episodes = new Map();
  const guide = recovery ? tvEpisodeGuides.get(tvEpisodeGuideKey(recovery)) : null;
  for (const episode of guide?.episodes || []) {
    if (episode.seasonNumber === recovery.seasonNumber) episodes.set(episode.episodeNumber, episode);
  }
  for (const candidate of assignment.episodeCandidates || []) {
    for (const episode of candidate.episodes || []) {
      if (episode.seasonNumber === recovery?.seasonNumber) episodes.set(episode.episodeNumber, episode);
    }
  }
  for (let episodeNumber = 0; episodeNumber <= 100; episodeNumber += 1) {
    if (!episodes.has(episodeNumber)) episodes.set(episodeNumber, {
      seriesId: recovery?.providerId || recovery?.seriesName || task.fingerprint,
      seasonNumber: recovery?.seasonNumber ?? 0,
      episodeNumber,
      title: ""
    });
  }
  return [...episodes.values()].sort((left, right) => left.episodeNumber - right.episodeNumber);
}

function tvEpisodeOptionLabel(episode) {
  const code = `S${String(episode.seasonNumber).padStart(2, "0")}E${String(episode.episodeNumber).padStart(2, "0")}`;
  return `${code}${episode.title ? ` - ${episode.title}` : ""}`;
}

function tvMatchingStatus(progress, task) {
  if (progress.fullyMatched || task.status === "processing") return { label: task.status === "processing" ? "Publishing" : "Fully matched", className: "fully-matched" };
  if (progress.matchedCount) return { label: "Partially matched", className: "partially-matched" };
  return task.status === "awaiting-identification"
    ? { label: "Identification required", className: "unidentified" }
    : { label: "Needs review", className: "unidentified" };
}

function tvAssignmentSource(method, recovery, manual = false) {
  if (manual) return "Manual Assignment";
  if (method === "provider-disc-mapping") {
    return recovery?.metadataProvider === "tvdb" ? "TVDB Disc Mapping" : "Provider Disc Mapping";
  }
  if (method === "sequential-disc-assignment") return "Sequential Assignment";
  if (method === "runtime-matching") return "Runtime Ranking";
  if (method === "exact-fingerprint-history") return "Fingerprint History";
  if (method === "user-correction") return "User Correction History";
  return "Unspecified";
}

function tvCandidateMatchesEpisodes(candidate, episodes) {
  if (!candidate || candidate.episodes.length !== episodes.length) return false;
  const signature = (episode) => `${episode.seriesId}:${episode.seasonNumber}:${episode.episodeNumber}`;
  const left = candidate.episodes.map(signature).sort();
  const right = episodes.map(signature).sort();
  return left.every((value, index) => value === right[index]);
}

function tvAssignmentConfidence(confidence) {
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return "Confidence unavailable";
  const band = confidence >= 0.9 ? "High" : confidence >= 0.72 ? "Medium" : "Review required";
  return `${band} confidence · ${Math.round(confidence * 100)}%`;
}

function formatCompletedTvDiscDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown date";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  }).format(date).replace(",", "");
}

function tvDiscEvidenceList(evidence, type) {
  const entries = (evidence || []).filter((item) => item.type === type);
  if (!entries.length) return "";
  const heading = type === "positive" ? "Positive evidence" :
    type === "negative" ? "Negative evidence" : "Neutral evidence";
  return `<div class="tv-evidence-group tv-evidence-${type}">
    <h6>${heading}</h6>
    <ul>${entries.map((item) => `<li><span>${escapeHtml(item.message)}</span><b>${item.scoreImpact > 0 ? "+" : ""}${Number(item.scoreImpact).toFixed(1)}</b></li>`).join("")}</ul>
  </div>`;
}

function renderTvDiscPositionEvidence(task, recovery) {
  const candidates = task.diagnostics?.discPositionCandidates || [];
  if (!candidates.length) return "";
  const selectedDiscNumber = Number.isInteger(recovery?.discNumber)
    ? recovery.discNumber
    : task.diagnostics?.selected?.discNumber;
  const selected = candidates.find((candidate) => candidate.discNumber === selectedDiscNumber) || candidates[0];
  const alternatives = candidates.filter((candidate) => candidate !== selected);
  const breakdown = selected.confidenceBreakdown;
  const selectedEvidence = breakdown ? `
    <div class="tv-evidence-score"><span>Base score</span><b>${Number(breakdown.baseScore).toFixed(1)}</b></div>
    ${tvDiscEvidenceList(breakdown.evidence, "positive")}
    ${tvDiscEvidenceList(breakdown.evidence, "negative")}
    ${tvDiscEvidenceList(breakdown.evidence, "neutral")}
    <div class="tv-evidence-score tv-evidence-final"><span>Final score</span><b>${Number(breakdown.finalScore).toFixed(1)}</b></div>` : "";
  return `<details class="tv-disc-evidence">
    <summary>TV matching evidence</summary>
    <section class="tv-selected-evidence">
      <h5>Disc ${escapeHtml(selected.discNumber)} · Confidence ${Math.round(selected.confidence * 100)}%</h5>
      <h6>Why this match?</h6>
      ${selectedEvidence}
    </section>
    ${alternatives.map((candidate) => {
      const rejected = (candidate.confidenceBreakdown?.evidence || []).filter((item) => item.type === "negative");
      const ranking = (candidate.confidenceBreakdown?.evidence || []).filter((item) =>
        item.category === "candidate-ranking"
      );
      return `<section class="tv-alternative-evidence">
        <h5>Alternative: Disc ${escapeHtml(candidate.discNumber)} · Confidence ${Math.round(candidate.confidence * 100)}%</h5>
        <h6>Rejected because:</h6>
        ${rejected.length
          ? `<ul>${rejected.map((item) => `<li>${escapeHtml(item.message)} <b>${Number(item.scoreImpact).toFixed(1)}</b></li>`).join("")}</ul>`
          : `<ul>${ranking.map((item) => `<li>${escapeHtml(item.message)}</li>`).join("")}</ul>`}
      </section>`;
    }).join("")}
  </details>`;
}

function renderTvMatchingTask(entry) {
  const { task, recovery, completedDiscHistory = [], mediaTypeAudit = [] } = entry;
  const series = recovery?.seriesName || "";
  const season = recovery?.seasonNumber;
  const discNumber = recovery?.discNumber;
  const metadata = recovery?.importedMetadata || {};
  const yearValue = metadata.year ?? metadata.yearFirstAired ?? metadata.firstAired;
  const year = typeof yearValue === "string" && /^\d{4}/.test(yearValue)
    ? yearValue.slice(0, 4) : Number.isInteger(yearValue) ? String(yearValue) : "";
  const overview = typeof metadata.overview === "string" ? metadata.overview : "";
  const poster = recovery?.artworkReferences?.find((asset) => asset.kind === "poster" || asset.kind === "season-poster")?.url;
  const progress = entry.progress || {
    matchedCount: task.assignments.filter((assignment) => assignment.confirmed && assignment.selectedEpisodes?.length).length,
    totalCount: task.assignments.length,
    unmatchedCount: task.assignments.length,
    fullyMatched: false
  };
  const status = tvMatchingStatus(progress, task);
  const confidence = recovery?.detectedConfidence ?? task.diagnostics?.confidence;
  const confidenceLabel = confidence === undefined || confidence === null
    ? "Unavailable"
    : `${confidence >= 0.9 ? "High" : confidence >= 0.72 ? "Medium" : "Low"} · ${Math.round(confidence * 100)}%`;
  const totalRuntime = Math.round(task.assignments.reduce((sum, assignment) =>
    sum + assignment.durationSeconds, 0) / 60);
  const canMap = Boolean(series && season !== null && season !== undefined);
  const guide = recovery ? tvEpisodeGuides.get(tvEpisodeGuideKey(recovery)) : null;
  const trackRows = task.assignments.map((assignment) => {
    const options = tvEpisodeOptions(task, recovery, assignment);
    const selectedEpisodes = assignment.confirmed
      ? assignment.selectedEpisodes || []
      : assignment.selectedEpisodes?.length
        ? assignment.selectedEpisodes
        : assignment.episodeCandidates?.[0]?.episodes || [];
    const selectedNumbers = new Set(selectedEpisodes.map((episode) => episode.episodeNumber));
    const confirmedCandidate = assignment.confirmed
      ? assignment.episodeCandidates?.find((candidate) =>
        tvCandidateMatchesEpisodes(candidate, assignment.selectedEpisodes || []))
      : null;
    const suggestedCandidate = confirmedCandidate || assignment.episodeCandidates?.[0];
    const selectRows = [...selectedNumbers].length ? [...selectedNumbers] : [null];
    const selectMarkup = selectRows.map((selectedNumber) => `
      <select data-episode-select data-track-id="${escapeHtml(assignment.trackId)}">
        <option value="">Not matched</option>
        ${options.map((episode) => `<option value="${episode.episodeNumber}" data-title="${escapeHtml(episode.title || "")}"${selectedNumber === episode.episodeNumber ? " selected" : ""}>${escapeHtml(tvEpisodeOptionLabel(episode))}</option>`).join("")}
      </select>`).join("");
    const suggestion = assignment.confirmed ? "" : selectedEpisodes.length
      ? `<div class="tv-assignment-meta"><span>${escapeHtml(tvAssignmentSource(suggestedCandidate?.assignmentMethod || "runtime-matching", recovery))}</span><span>${escapeHtml(tvAssignmentConfidence(suggestedCandidate?.confidence))}</span><small>Suggested match · save to confirm</small></div>`
      : "";
    const assignmentSummary = assignment.confirmed
      ? `<div class="tv-assignment-meta"><span>${escapeHtml(tvAssignmentSource(suggestedCandidate?.assignmentMethod, recovery, !confirmedCandidate))}</span><span>${escapeHtml(confirmedCandidate ? tvAssignmentConfidence(confirmedCandidate.confidence) : "Confirmed manually")}</span></div>`
      : "";
    return `<article class="tv-track-row" data-track-id="${escapeHtml(assignment.trackId)}">
      <div class="tv-track-heading">
        <div><span class="tv-track-number">TRACK ${escapeHtml(assignment.trackId)}</span><h4>${escapeHtml(assignment.title)}</h4></div>
        <div class="tv-track-tech"><span>${formatDuration(assignment.durationSeconds)}</span><span data-track-resolution>${escapeHtml(assignment.resolution || "Resolution unavailable")}</span></div>
      </div>
      <div class="tv-track-preview">
        <div class="tv-track-thumbnail-strip" data-thumbnail-strip><span class="tv-thumbnail-placeholder">Preview frames appear here</span></div>
        <button class="button secondary tv-track-preview-button" type="button" data-track-id="${escapeHtml(assignment.trackId)}">Preview</button>
      </div>
      ${canMap ? `<div class="tv-track-mapping">
        <label>Match to episode<input type="search" data-episode-search placeholder="Search episode title or number" autocomplete="off"></label>
        <div class="tv-episode-select-list" data-episode-select-list>${selectMarkup}</div>
        <div class="tv-track-map-actions"><button class="text-button tv-add-episode" type="button" data-track-id="${escapeHtml(assignment.trackId)}">+ Add another episode</button><span data-episode-preview class="tv-episode-preview">Not matched</span></div>
        ${assignmentSummary}
        ${suggestion}
      </div>` : ""}
    </article>`;
  }).join("");
  const mediaTypeOptions = [
    ["movie", "Movie"], ["tv_series", "TV Series"], ["music_album", "Music"], ["data_disc", "Data Disc"]
  ];
  if (recovery && !mediaTypeOptions.some(([value]) => value === recovery.finalMediaType)) {
    mediaTypeOptions.unshift([recovery.finalMediaType, `Current: ${recovery.finalMediaType}`]);
  }
  const seasonText = season === null || season === undefined ? "Season not identified" : `Season ${season}`;
  const discText = discNumber === null || discNumber === undefined ? "Disc number not specified" : `Disc ${discNumber}`;
  const labelSuggestion = task.diagnostics?.discLabelSuggestion;
  const labelSuggestionText = Number.isInteger(labelSuggestion?.seasonNumber) &&
    Number.isInteger(labelSuggestion?.discNumber)
    ? `Disc label suggests: Season ${labelSuggestion.seasonNumber} Disc ${labelSuggestion.discNumber}`
    : "";
  const completedDiscNotices = completedDiscHistory
    .filter((record) => Number.isInteger(record.discNumber))
    .map((record) =>
      `Season ${record.seasonNumber} Disc ${record.discNumber} already processed on ${formatCompletedTvDiscDate(record.completedAt)}.`
    );
  return `<article class="tv-disc-review tv-matching-task" data-job-id="${escapeHtml(task.jobId)}">
    <div class="tv-disc-summary">
      ${poster
        ? `<img class="tv-disc-poster" src="${escapeHtml(poster)}" alt="${escapeHtml(series ? `${series} poster` : "TV series poster")}" loading="lazy" referrerpolicy="no-referrer">`
        : '<div class="tv-disc-poster tv-disc-poster-placeholder" aria-hidden="true">TV</div>'}
      <div class="tv-disc-info">
        <p class="eyebrow">STAGED TV DISC</p>
        <h3>${escapeHtml(series || task.source.label || "Unidentified TV disc")}</h3>
        <p class="tv-disc-season">${escapeHtml(seasonText)}${discNumber === null || discNumber === undefined ? "" : ` · ${escapeHtml(discText)}`}</p>
        ${labelSuggestionText ? `<p class="tv-disc-label-evidence">${escapeHtml(labelSuggestionText)}</p>` : ""}
        ${completedDiscNotices.map((notice) => `<p class="tv-disc-history-notice">${escapeHtml(notice)}</p>`).join("")}
        <div class="tv-disc-facts">
          ${year ? `<span>${escapeHtml(year)}</span>` : ""}
          <span>${task.assignments.length} tracks</span>
          <span>${totalRuntime} min</span>
          <span class="tv-match-confidence">Confidence ${escapeHtml(confidenceLabel)}</span>
        </div>
        <p class="tv-disc-identifier">Disc ID <code>${escapeHtml(task.fingerprint)}</code></p>
        ${overview ? `<p class="tv-disc-overview">${escapeHtml(overview)}</p>` : ""}
      </div>
      <div class="tv-disc-progress">
        <span class="tv-match-status ${status.className}">${escapeHtml(status.label)}</span>
        <strong>Matched ${progress.matchedCount} / ${progress.totalCount}</strong>
        <span>${progress.unmatchedCount} unmatched</span>
      </div>
    </div>
    ${task.failure ? `<p class="diagnostic-error">${escapeHtml(task.failure)}</p>` : ""}
    <div class="tv-disc-actions">
      <button type="button" class="button primary tv-task-open">${canMap ? "Open Matching" : "Identify Series"}</button>
      <button type="button" class="button secondary tv-identify" data-task-id="${escapeHtml(task.jobId)}" data-fingerprint="${escapeHtml(task.fingerprint)}" data-suggested="${escapeHtml(task.source.label || "")}">${series ? "Change Identification" : "Search for Series"}</button>
      ${progress.matchedCount > 0 && progress.unmatchedCount > 0
        ? `<button type="button" class="button danger tv-delete-unmatched">Delete unmatched tracks</button>` : ""}
      <button type="button" class="text-button tv-task-delete">Remove disc from review</button>
    </div>
    <section class="tv-disc-matching hidden" data-matching-panel>
      ${canMap ? `<div class="tv-matching-guide">
        <div><h4>Match each staged track</h4><p>Suggestions are not confirmed until you save. Unmatched tracks remain safely staged.</p></div>
        ${guide?.error ? `<p class="tv-episode-guide-error">Episode guide unavailable: ${escapeHtml(guide.error)}. You can still choose episode numbers.</p>` : ""}
      </div>
      ${renderTvDiscPositionEvidence(task, recovery)}
      <div class="tv-track-list">${trackRows}</div>
      <div class="tv-save-workflow">
        <p>Matched <b data-matched-count>${progress.matchedCount} / ${progress.totalCount}</b> · Unmatched <b data-unmatched-count>${progress.unmatchedCount}</b></p>
        <button type="button" class="button primary tv-task-save">${progress.fullyMatched ? "Save matches & publish" : "Save progress"}</button>
      </div>` : `<div class="tv-matching-guide"><h4>Identify this disc to start episode matching</h4><p>The complete disc is already staged and will not be published before you review it.</p></div>`}
      ${recovery ? `<details class="tv-classification-details"><summary>Media classification</summary>
        <form class="tv-task-media-override" data-fingerprint="${escapeHtml(task.fingerprint)}">
          <p class="hint">Automatic Classification: ${escapeHtml(recovery.detectedMediaType)} · Manual Override: ${escapeHtml(recovery.mediaTypeOverridden ? recovery.finalMediaType : "None")}${recovery.mediaTypeOverridden ? " (active)" : ""}</p>
          <label>Media type<select name="mediaType">${mediaTypeOptions.map(([value, label]) => `<option value="${escapeHtml(value)}"${recovery.finalMediaType === value ? " selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select></label>
          <label>Override reason (optional)<input name="mediaTypeReason" maxlength="500"></label>
          <button type="submit" class="button secondary">Save classification</button>
        </form>
      </details>` : ""}
      ${mediaTypeAudit.length ? `<details><summary>Classification history (${mediaTypeAudit.length})</summary><ul>${mediaTypeAudit.map((record) =>
        `<li>${escapeHtml(record.originalType)} → ${escapeHtml(record.newType)} · ${escapeHtml(record.username)} · ${escapeHtml(new Date(record.timestamp).toLocaleString())}${record.reason ? ` · ${escapeHtml(record.reason)}` : ""}</li>`
      ).join("")}</ul></details>` : ""}
    </section>
  </article>`;
}

const forgetDiscDialog = $("#forget-disc-dialog");
let forgetDiscRequestPath = null;
document.addEventListener("click", (event) => {
  const button = event.target.closest(".forget-disc, #forget-diagnostics-disc");
  if (!button) return;
  const target = button.dataset.jobId
    ? { jobId: button.dataset.jobId }
    : button.dataset.fingerprint
      ? { fingerprint: button.dataset.fingerprint }
      : { jobId: $("#diagnostics-job").value };
  if (!target.jobId && !target.fingerprint) { notify("Select a disc to forget.", true); return; }
  forgetDiscRequestPath = target.jobId
    ? `/api/v1/history/${encodeURIComponent(target.jobId)}/forget`
    : `/api/v1/discs/${encodeURIComponent(target.fingerprint)}/forget`;
  forgetDiscDialog.showModal();
});
$("#forget-disc-cancel").addEventListener("click", () => {
  forgetDiscRequestPath = null;
  forgetDiscDialog.close();
});
$("#forget-disc-confirm").addEventListener("click", async () => {
  if (!forgetDiscRequestPath) return;
  const button = $("#forget-disc-confirm");
  button.disabled = true;
  try {
    await api(forgetDiscRequestPath, { method: "POST" });
    forgetDiscDialog.close();
    forgetDiscRequestPath = null;
    state.diagnosticsJobId = "";
    notify("Disc forgotten.");
    await Promise.all([refreshDashboard(), refreshHistory(), refreshReviewQueue(), loadDiagnostics("")]);
  } catch (error) {
    notify(error.message, true);
  } finally {
    button.disabled = false;
  }
});

const tvDeleteDialog = $("#tv-delete-dialog");
function requestTvTaskDeletion(jobId) {
  state.tvDeleteJobId = jobId;
  if (!tvDeleteDialog.open) tvDeleteDialog.showModal();
}

$("#tv-delete-cancel").addEventListener("click", () => {
  state.tvDeleteJobId = null;
  tvDeleteDialog.close();
});
$("#tv-delete-confirm").addEventListener("click", async () => {
  const jobId = state.tvDeleteJobId;
  if (!jobId) return;
  const button = $("#tv-delete-confirm");
  button.disabled = true;
  try {
    await api(`/api/v1/history/${encodeURIComponent(jobId)}`, {
      method: "DELETE", body: JSON.stringify({ confirmed: true })
    });
    tvDeleteDialog.close();
    state.tvDeleteJobId = null;
    await loadTvReviews();
    await refreshHistory();
    await refreshStorageViews();
    notify("Unmatched TV staging and temporary records were deleted. Published media was not affected.");
  } catch (error) {
    notify(error.message, true);
    await refreshStorageViews();
  } finally {
    button.disabled = false;
  }
});

const tvUnmatchedDeleteDialog = $("#tv-unmatched-delete-dialog");
let tvUnmatchedDeleteJobId = null;

$("#tv-unmatched-delete-cancel").addEventListener("click", () => {
  tvUnmatchedDeleteJobId = null;
  tvUnmatchedDeleteDialog.close();
});
$("#tv-unmatched-delete-confirm").addEventListener("click", async () => {
  if (!tvUnmatchedDeleteJobId) return;
  const button = $("#tv-unmatched-delete-confirm");
  button.disabled = true;
  try {
    const result = await api(`/api/v1/tv/matching/${encodeURIComponent(tvUnmatchedDeleteJobId)}/unmatched`, {
      method: "DELETE",
      body: JSON.stringify({ confirmed: true })
    });
    tvUnmatchedDeleteDialog.close();
    tvUnmatchedDeleteJobId = null;
    notify(result.continuation === "started"
      ? "Unmatched tracks were deleted. The fully matched disc is now publishing."
      : "Unmatched tracks were deleted. Publishing will continue when the active job finishes.");
    await loadTvReviews();
    await refreshStorageViews();
  } catch (error) {
    notify(error.message, true);
    await refreshStorageViews();
  } finally {
    button.disabled = false;
  }
});

function updateTvTrackSelection(trackRow) {
  const selects = [...trackRow.querySelectorAll("[data-episode-select]")];
  const selected = selects.map((select) => select.selectedOptions[0]).filter((option) => option?.value);
  const preview = trackRow.querySelector("[data-episode-preview]");
  preview.textContent = selected.length
    ? selected.map((option) => option.textContent.trim()).join(" + ")
    : "Not matched";
  preview.classList.toggle("matched", selected.length > 0 && selected.length === selects.length);
}

function updateTvTaskProgress(card) {
  const trackRows = [...card.querySelectorAll(".tv-track-row")];
  const matchedCount = trackRows.filter((row) => {
    const selects = [...row.querySelectorAll("[data-episode-select]")];
    return selects.length > 0 && selects.every((select) => Boolean(select.value));
  }).length;
  const unmatchedCount = trackRows.length - matchedCount;
  const matched = card.querySelector("[data-matched-count]");
  const unmatched = card.querySelector("[data-unmatched-count]");
  if (matched) matched.textContent = `${matchedCount} / ${trackRows.length}`;
  if (unmatched) unmatched.textContent = String(unmatchedCount);
  const save = card.querySelector(".tv-task-save");
  if (save) save.textContent = unmatchedCount === 0 ? "Save matches & publish" : "Save progress";
}

function filterTvEpisodeOptions(trackRow) {
  const query = trackRow.querySelector("[data-episode-search]").value.trim().toLocaleLowerCase();
  for (const select of trackRow.querySelectorAll("[data-episode-select]")) {
    for (const option of select.options) {
      option.hidden = Boolean(query && option.value && !option.textContent.toLocaleLowerCase().includes(query));
    }
  }
}

async function saveTvTaskAssignments(button) {
  const card = button.closest(".tv-matching-task");
  const taskId = card.dataset.jobId;
  button.disabled = true;
  try {
    const assignments = [...card.querySelectorAll(".tv-track-row")].map((row) => {
      const selectedOptions = [...row.querySelectorAll("[data-episode-select]")]
        .map((select) => select.selectedOptions[0])
        .filter((option) => option?.value);
      const episodeNumbers = selectedOptions.map((option) => Number(option.value));
      if (new Set(episodeNumbers).size !== episodeNumbers.length) {
        throw new Error(`Track ${row.dataset.trackId} contains the same episode more than once.`);
      }
      return {
        trackId: row.dataset.trackId,
        episodeNumbers,
        episodeTitles: selectedOptions.map((option) => option.dataset.title || "")
      };
    });
    const result = await api(`/api/v1/tv/matching/${encodeURIComponent(taskId)}/assignments`, {
      method: "PUT",
      body: JSON.stringify({ assignments })
    });
    const progress = result.progress;
    if (result.continuation === "started") {
      notify(`Saved ${progress.matchedCount} of ${progress.totalCount} matches. Publishing has resumed automatically.`);
    } else if (result.continuation === "queued") {
      notify(`Saved ${progress.matchedCount} of ${progress.totalCount} matches. Publishing will resume after the active job.`);
    } else if (result.continuation === "blocked") {
      notify("Matches were saved, but the manual media classification must be set to TV Series before publishing.", true);
    } else {
      notify(`Saved ${progress.matchedCount} of ${progress.totalCount} matches. Unmatched tracks remain safely staged.`);
    }
    await loadTvReviews();
  } catch (error) {
    notify(error.message, true);
  } finally {
    button.disabled = false;
  }
}

const tvPreviewDialog = $("#tv-track-preview-dialog");
const tvPreviewVideo = $("#tv-track-preview-video");
let tvPreviewTrackRow = null;

function addPreviewThumbnail(strip, dataUrl, time, label) {
  const button = document.createElement("button");
  button.className = "tv-preview-thumbnail";
  button.type = "button";
  button.dataset.seek = String(time);
  button.setAttribute("aria-label", `Seek to ${label}`);
  const image = document.createElement("img");
  image.src = dataUrl;
  image.alt = label;
  button.append(image);
  strip.append(button);
}

async function captureTvPreviewFrames() {
  const status = $("#tv-track-preview-status");
  const dialogStrip = $("#tv-track-preview-thumbnails");
  dialogStrip.replaceChildren();
  const duration = tvPreviewVideo.duration;
  if (!Number.isFinite(duration) || duration <= 0 || !tvPreviewVideo.videoWidth) {
    status.textContent = "Preview loaded, but video frames are not available.";
    return;
  }
  const positions = [0.15, 0.5, 0.85];
  try {
    for (const position of positions) {
      const time = Math.min(Math.max(0, duration - 0.1), duration * position);
      if (Math.abs(tvPreviewVideo.currentTime - time) > 0.05) {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Timed out while seeking preview")), 10000);
          tvPreviewVideo.addEventListener("seeked", () => {
            clearTimeout(timeout);
            resolve();
          }, { once: true });
          tvPreviewVideo.currentTime = time;
        });
      }
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 180;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Thumbnail canvas is unavailable");
      const scale = Math.min(canvas.width / tvPreviewVideo.videoWidth, canvas.height / tvPreviewVideo.videoHeight);
      const width = tvPreviewVideo.videoWidth * scale;
      const height = tvPreviewVideo.videoHeight * scale;
      context.fillStyle = "#000";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(tvPreviewVideo, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.78);
      const label = formatDuration(time);
      addPreviewThumbnail(dialogStrip, dataUrl, time, label);
      if (tvPreviewTrackRow) {
        const trackStrip = tvPreviewTrackRow.querySelector("[data-thumbnail-strip]");
        trackStrip.replaceChildren();
        for (const thumbnail of dialogStrip.querySelectorAll(".tv-preview-thumbnail")) {
          const copy = thumbnail.cloneNode(true);
          trackStrip.append(copy);
        }
      }
    }
    tvPreviewVideo.currentTime = 0;
    status.textContent = "Preview ready. Select a thumbnail to jump to that moment.";
  } catch (error) {
    status.textContent = error.message;
  }
}

tvPreviewVideo.addEventListener("loadedmetadata", () => {
  if (tvPreviewTrackRow) {
    const resolution = tvPreviewTrackRow.querySelector("[data-track-resolution]");
    resolution.textContent = `${tvPreviewVideo.videoWidth} × ${tvPreviewVideo.videoHeight}`;
  }
  void captureTvPreviewFrames();
});
tvPreviewVideo.addEventListener("error", () => {
  $("#tv-track-preview-status").textContent = "This staged track preview could not be played. The original remains safely staged.";
});
$("#tv-track-preview-close").addEventListener("click", () => {
  tvPreviewVideo.pause();
  tvPreviewVideo.removeAttribute("src");
  tvPreviewVideo.load();
  tvPreviewDialog.close();
  tvPreviewTrackRow = null;
});

document.addEventListener("click", async (event) => {
  const openButton = event.target.closest(".tv-task-open");
  if (openButton) {
    const card = openButton.closest(".tv-matching-task");
    const panel = card.querySelector("[data-matching-panel]");
    panel.classList.toggle("hidden");
    openButton.textContent = panel.classList.contains("hidden") ? "Open Matching" : "Close Matching";
    return;
  }
  const deleteButton = event.target.closest(".tv-task-delete");
  if (deleteButton) {
    requestTvTaskDeletion(deleteButton.closest(".tv-matching-task").dataset.jobId);
    return;
  }
  const unmatchedButton = event.target.closest(".tv-delete-unmatched");
  if (unmatchedButton) {
    tvUnmatchedDeleteJobId = unmatchedButton.closest(".tv-matching-task").dataset.jobId;
    tvUnmatchedDeleteDialog.showModal();
    return;
  }
  const addEpisodeButton = event.target.closest(".tv-add-episode");
  if (addEpisodeButton) {
    const row = addEpisodeButton.closest(".tv-track-row");
    const list = row.querySelector("[data-episode-select-list]");
    if (list.children.length >= 3) {
      notify("A staged track can map to at most three episodes.", true);
      return;
    }
    const select = list.querySelector("[data-episode-select]").cloneNode(true);
    select.value = "";
    list.append(select);
    updateTvTrackSelection(row);
    updateTvTaskProgress(addEpisodeButton.closest(".tv-matching-task"));
    return;
  }
  const previewButton = event.target.closest(".tv-track-preview-button");
  if (previewButton) {
    const row = previewButton.closest(".tv-track-row");
    const card = previewButton.closest(".tv-matching-task");
    tvPreviewTrackRow = row;
    $("#tv-track-preview-title").textContent = `Track ${row.dataset.trackId} · ${row.querySelector("h4").textContent}`;
    $("#tv-track-preview-status").textContent = "Preparing a short preview clip and thumbnail strip…";
    $("#tv-track-preview-thumbnails").replaceChildren();
    tvPreviewVideo.src = `/api/v1/tv/matching/${encodeURIComponent(card.dataset.jobId)}/preview/${encodeURIComponent(row.dataset.trackId)}`;
    tvPreviewDialog.showModal();
    tvPreviewVideo.load();
    return;
  }
  const thumbnail = event.target.closest(".tv-preview-thumbnail");
  if (thumbnail) {
    tvPreviewVideo.currentTime = Number(thumbnail.dataset.seek);
    return;
  }
  const saveButton = event.target.closest(".tv-task-save");
  if (saveButton) await saveTvTaskAssignments(saveButton);
});

document.addEventListener("input", (event) => {
  const search = event.target.closest("[data-episode-search]");
  if (search) filterTvEpisodeOptions(search.closest(".tv-track-row"));
});
document.addEventListener("change", (event) => {
  const select = event.target.closest("[data-episode-select]");
  if (!select) return;
  const row = select.closest(".tv-track-row");
  updateTvTrackSelection(row);
  updateTvTaskProgress(select.closest(".tv-matching-task"));
});

async function loadTvReviews() {
  const requestId = ++state.tvReviewsRequestId;
  const selected = $("#tv-review-filter").value;
  const query = new URLSearchParams({ limit: "100" });
  if (selected) query.set("state", selected);
  const [{ plans }, { tasks }] = await Promise.all([
    api(`/api/v1/tv/reviews?${query}`),
    api("/api/v1/tv/matching")
  ]);
  await loadTvEpisodeGuides(tasks);
  if (requestId !== state.tvReviewsRequestId) return;
  const planCards = plans.length
    ? (await Promise.all(plans.map(async (plan) => {
      const { recovery, mediaTypeAudit = [] } = await api(`/api/v1/tv/plans/${encodeURIComponent(plan.id)}/recovery`);
      const audit = mediaTypeAudit.length
        ? `<details><summary>Media classification audit (${mediaTypeAudit.length})</summary><ul>${mediaTypeAudit.map((record) =>
          `<li>${escapeHtml(record.originalType)} → ${escapeHtml(record.newType)} · ${escapeHtml(record.username)} · ${escapeHtml(new Date(record.timestamp).toLocaleString())}${record.reason ? ` · ${escapeHtml(record.reason)}` : ""}</li>`
        ).join("")}</ul></details>`
        : "";
      return `${renderTvPlanCard(plan, true, recovery, true)}${audit}${plan.reviewHistory?.length ? `<p class="list-sub">Last reviewed by ${escapeHtml(plan.reviewedBy || "unknown")} · ${escapeHtml(plan.reviewedAt ? new Date(plan.reviewedAt).toLocaleString() : "")}${plan.reviewReason ? ` · ${escapeHtml(plan.reviewReason)}` : ""}</p>` : ""}`;
    }))).join("")
    : "";
  if (requestId !== state.tvReviewsRequestId) return;
  const identificationCards = tasks.length
    ? `<h3>TV discs requiring identification</h3>${tasks.map(renderTvMatchingTask).join("")}`
    : "";
  $("#tv-review-list").innerHTML = planCards || identificationCards
    ? `${identificationCards}${planCards}`
    : '<div class="empty-state">No plans or unknown TV discs require review.</div>';
}

const reviewCategoryLabels = {
  tv_review: "TV review",
  cd_review: "CD review",
  metadata_issue: "Metadata issue",
  processing_failure: "Processing failure",
  folder_creation_failure: "Folder creation",
  disc_read_error: "Disc read error",
  validation_warning: "Validation warning",
  configuration_issue: "Configuration issue",
  system_warning: "System warning"
};

function renderReviewItem(item) {
  const actions = item.status === "active" || item.status === "retrying"
    ? item.suggestedActions.map((action) => {
      if (action.type === "retry" || action.type === "retry-after-correction") {
        return `<button class="button primary review-action" data-action="retry" data-review-id="${escapeHtml(item.id)}">${escapeHtml(action.label)}</button>`;
      }
      if (action.type === "approve-process") {
        return `<button class="button primary review-action" data-action="approve-process" data-review-id="${escapeHtml(item.id)}">${escapeHtml(action.label)}</button>`;
      }
      if (action.type === "open-settings") {
        return `<button class="button secondary review-action" data-action="open-settings">${escapeHtml(action.label)}</button>`;
      }
      if (action.type === "enter-metadata") {
        return `<button class="button secondary review-action" data-action="enter-metadata" data-job-id="${escapeHtml(item.relatedJobId || "")}">${escapeHtml(action.label)}</button>`;
      }
      if (action.type === "view-job") {
        return `<button class="button secondary review-action" data-action="view-job" data-review-id="${escapeHtml(item.id)}">${escapeHtml(action.label)}</button>`;
      }
      if (action.type === "open-review") {
        return `<button class="button secondary review-action" data-action="open-review">${escapeHtml(action.label)}</button>`;
      }
      if (action.type === "resolve") {
        return `<button class="button secondary review-action" data-action="resolve" data-review-id="${escapeHtml(item.id)}">${escapeHtml(action.label)}</button>`;
      }
      if (action.type === "dismiss") {
        return `<button class="button danger review-action" data-action="dismiss" data-review-id="${escapeHtml(item.id)}">${escapeHtml(action.label)}</button>`;
      }
      return "";
    }).join("")
    : "";
  const details = {
    ...(item.relatedJobId ? { jobId: item.relatedJobId } : {}),
    ...(item.relatedDisc ? { disc: item.relatedDisc } : {}),
    ...(item.relatedDrive ? { drive: item.relatedDrive } : {}),
    ...(item.requestedPath ? { requestedPath: item.requestedPath } : {}),
    ...(item.errorDetails || {})
  };
  return `<article class="review-item ${escapeHtml(item.severity)}">
    <div class="review-heading"><div><span class="review-category">${escapeHtml(item.errorDetails?.approvalRequired ? "Disc approval" : reviewCategoryLabels[item.category] || item.category)}</span><span class="confidence-pill ${item.severity === "critical" || item.severity === "high" ? "low" : item.severity === "medium" ? "medium" : "high"}">${escapeHtml(item.severity)}</span>
      <h3>${escapeHtml(item.title)}</h3><span class="list-sub">${escapeHtml(item.relatedDisc || "Disc not identified")}${item.relatedDrive ? ` · ${escapeHtml(item.relatedDrive)}` : ""} · ${new Date(item.createdAt).toLocaleString()}</span></div>
      <span class="review-status">${escapeHtml(item.status)}</span></div>
    <p>${escapeHtml(item.description)}</p>
    ${Object.keys(details).length ? `<details><summary>Error details and suggested resolution</summary><pre>${escapeHtml(JSON.stringify(details, null, 2))}</pre></details>` : ""}
    ${item.resolutionDetails ? `<p class="list-sub">Resolution: ${escapeHtml(item.resolutionDetails)}${item.resolvedAt ? ` · ${escapeHtml(new Date(item.resolvedAt).toLocaleString())}` : ""}</p>` : ""}
    ${item.retryCount ? `<p class="list-sub">Retry attempts: ${item.retryCount}</p>` : ""}
    <div class="tv-actions">${actions}<button class="button danger review-action" data-action="delete" data-review-id="${escapeHtml(item.id)}">Delete</button>${item.relatedJobId || item.discFingerprint
      ? `<button class="button danger forget-disc" type="button"${item.relatedJobId
        ? ` data-job-id="${escapeHtml(item.relatedJobId)}"`
        : ` data-fingerprint="${escapeHtml(item.discFingerprint)}"`}>Forget Disc</button>`
      : ""}</div>
    <div class="review-job-details" data-review-details="${escapeHtml(item.id)}"></div>
  </article>`;
}

function renderReviewJob(item, storage = {}) {
  const title = typeof item.metadata?.title === "string" && item.metadata.title
    ? item.metadata.title
    : item.metadata?.suggestedTitle || item.discLabel || item.originalJobId;
  const movieTitleConfirmed = item.metadata?.movieIdentificationConfirmed === true;
  const generatedUnknownTitle = typeof item.metadata?.title === "string" &&
    /^Unknown Title \d{4}-\d{2}-\d{2}$/i.test(item.metadata.title.trim());
  const needsMovieConfirmation = item.metadata?.movieIdentificationRequiresConfirmation === true ||
    generatedUnknownTitle ||
    (typeof item.metadata?.title === "string" && item.metadata.title.trim() &&
      item.metadata.namingSource !== "Metadata match" && !movieTitleConfirmed);
  const movieCandidates = Array.isArray(item.metadata?.movieCandidates)
    ? item.metadata.movieCandidates.filter((candidate) =>
      candidate && typeof candidate.title === "string" && candidate.title.trim())
    : [];
  const actions = item.status === "pending"
    ? `${needsMovieConfirmation && !movieTitleConfirmed ? "" :
      `<button class="button secondary review-job-action" data-action="open" data-id="${escapeHtml(item.id)}">Edit Title</button>
      <button class="button primary review-job-action" data-action="continue" data-id="${escapeHtml(item.id)}">${needsMovieConfirmation ? "Publish Confirmed Movie" : "Approve &amp; Continue"}</button>`}
      <button class="button danger review-job-action" data-action="delete" data-id="${escapeHtml(item.id)}">Delete</button>
      <button class="button secondary review-job-action" data-action="clear" data-id="${escapeHtml(item.id)}">Clear Notification</button>`
    : ["completed", "dismissed"].includes(item.status)
      ? `<button class="button danger review-job-action" data-action="delete" data-id="${escapeHtml(item.id)}">Delete</button>
        <button class="button secondary review-job-action" data-action="clear" data-id="${escapeHtml(item.id)}">Clear Notification</button>`
      : "";
  return `<article class="review-item">
    <div class="review-heading"><div><h3>${escapeHtml(title)}</h3>
      <span class="list-sub">${escapeHtml(item.discType)}${item.discLabel ? ` · ${escapeHtml(item.discLabel)}` : ""} · ${escapeHtml(new Date(item.createdAt).toLocaleString())}</span></div>
      <span class="review-status">${escapeHtml(item.status)}</span></div>
    <p>${escapeHtml(item.failureReason || "Processing requires review")} · Stage: ${escapeHtml(item.failureStage || "unknown")}</p>
    <p class="list-sub">Staged ${escapeHtml(formatBytes(storage.stagedBytes ?? item.mediaSize))} · Artwork ${escapeHtml(formatBytes(storage.artworkBytes ?? 0))} · Metadata ${escapeHtml(formatBytes(storage.metadataBytes ?? 0))} · Total ${escapeHtml(formatBytes(storage.totalBytes ?? item.mediaSize))} · Resume stage: ${escapeHtml(item.resumeStage)}</p>
    ${needsMovieConfirmation ? `<section class="movie-review-evidence">
      <h4>Movie Evidence</h4>
      <p>✓ Disc volume name: ${escapeHtml(item.metadata.filesystemVolumeName || "Unavailable")}</p>
      ${movieCandidates.length ? `<label>Metadata candidates<select class="movie-review-candidate" data-id="${escapeHtml(item.id)}">
        <option value="">Choose a candidate or enter a title</option>
        ${movieCandidates.map((candidate, index) => `<option value="${index}" data-title="${escapeHtml(candidate.title)}">${escapeHtml(candidate.title)} · ${Math.round(Number(candidate.confidence || 0) * 100)}%</option>`).join("")}
      </select></label><p>✓ Metadata candidate: ${escapeHtml(movieCandidates[0].title)}</p>` : "<p>✗ No metadata candidates found</p>"}
      <p>✗ Confidence below threshold (${escapeHtml(Number(item.metadata.movieIdentificationEvidence?.confidence ?? 0).toFixed(2))} &lt; ${escapeHtml(Number(item.metadata.movieIdentificationEvidence?.minimumConfidence ?? 0).toFixed(2))})</p>
      <p>Action: ${movieTitleConfirmed ? "Title confirmed by user" : "Manual confirmation required"}</p>
      <p class="list-sub">Naming source: ${escapeHtml(item.metadata.namingSource || "Fallback")}</p>
    </section>` : ""}
    <div class="tv-actions">${actions}</div>
    ${item.status === "pending" ? `<div class="review-job-editor${needsMovieConfirmation && !movieTitleConfirmed ? "" : " hidden"}" data-review-editor="${escapeHtml(item.id)}">
      <label>${needsMovieConfirmation ? "Confirmed movie title" : "Title"}<input data-review-title type="text" maxlength="200" value="${escapeHtml(typeof item.metadata?.title === "string" ? item.metadata.title : item.metadata?.suggestedTitle || title)}"></label>
      <button class="button ${needsMovieConfirmation ? "primary" : "secondary"} review-job-action" data-action="save" data-id="${escapeHtml(item.id)}">${needsMovieConfirmation ? "Confirm Title" : "Save Metadata"}</button>
    </div>` : ""}
  </article>`;
}

async function loadReviewJobs() {
  const requestId = ++state.reviewJobsRequestId;
  const { reviewJobs } = await api("/api/v1/review-jobs");
  if (requestId !== state.reviewJobsRequestId) return;
  let sizes = [];
  try {
    ({ items: sizes } = await api("/api/v1/storage/review-sizes"));
  } catch (error) {
    notify(`Review storage sizes are unavailable: ${error.message}`, true);
  }
  if (requestId !== state.reviewJobsRequestId) return;
  const sizesById = new Map(sizes.map((item) => [item.reviewId, item]));
  $("#review-jobs-list").innerHTML = reviewJobs.length
    ? reviewJobs.map((item) => renderReviewJob(item, sizesById.get(item.id))).join("")
    : '<div class="empty-state">No extracted media is waiting for review.</div>';
}

async function loadReviewCentre() {
  const requestId = ++state.reviewCentreRequestId;
  const query = new URLSearchParams({ limit: "250" });
  for (const [id, key] of [
    ["review-category", "category"],
    ["review-severity", "severity"],
    ["review-status", "status"],
    ["review-from", "from"],
    ["review-to", "to"]
  ]) {
    const value = $(`#${id}`).value;
    if (value) query.set(key, key === "to" ? `${value}T23:59:59.999Z` : key === "from" ? `${value}T00:00:00.000Z` : value);
  }
  const [{ summary, items }, orphanReport] = await Promise.all([
    api(`/api/v1/reviews?${query}`),
    api("/api/v1/review-cleanup/orphans")
  ]);
  if (requestId !== state.reviewCentreRequestId) return;
  state.orphanCleanupReport = orphanReport;
  $("#orphaned-data").innerHTML = orphanReport.items.length || orphanReport.errors.length
    ? `<article class="review-item ${orphanReport.errors.length ? "medium" : "low"}">
        <div class="review-heading"><div><span class="review-category">Temporary storage</span><h3>Orphaned data found</h3></div>
          <span class="review-status">${orphanReport.items.length} item${orphanReport.items.length === 1 ? "" : "s"}</span></div>
        <p>${orphanReport.files} file${orphanReport.files === 1 ? "" : "s"} · ${escapeHtml(formatBytes(orphanReport.bytes))} potentially recoverable.
          Untracked temporary files are retained until you choose to clean them up.</p>
        ${orphanReport.errors.length ? `<p class="hint">${escapeHtml(orphanReport.errors.join("; "))}</p>` : ""}
        ${orphanReport.items.length ? `<button class="button danger orphan-cleanup-request" type="button">Review and clean up orphaned data</button>` : ""}
      </article>`
    : "";
  $("#review-summary").innerHTML = [
    ["Active reviews", summary.active],
    ["Critical reviews", summary.critical],
    ["TV reviews", summary.tv],
    ["CD reviews", summary.cd],
    ["Processing failures", summary.processingFailures],
    ["Resolved today", summary.resolvedToday]
  ].map(([label, value]) => tvStat(label, value)).join("");
  $("#review-list").innerHTML = items.length
    ? items.map(renderReviewItem).join("")
    : '<div class="empty-state">No review items match the selected filters.</div>';
  await loadReviewJobs();
}

async function refreshReviewQueue() {
  await Promise.all([loadReviewCentre(), loadTvReviews()]);
}

const reviewDeletionRecordLabels = {
  reviewItems: "review_items",
  jobs: "jobs",
  jobEvents: "job_events",
  reviewJobs: "review_jobs",
  tvMatchingTasks: "tv_matching_tasks",
  mediaTypeOverrideAudit: "media_type_override_audit",
  discRecovery: "disc_recovery",
  tvEpisodeFeedback: "tv_episode_feedback",
  tvProcessingPlans: "tv_processing_plans",
  tvValidationEvidence: "tv_validation_evidence"
};

function renderDeletionPathList(paths) {
  return paths.length
    ? `<ul class="deletion-impact-list">${paths.map((path) => `<li><code>${escapeHtml(path)}</code></li>`).join("")}</ul>`
    : '<p class="list-sub">None</p>';
}

function renderReviewDeletionImpact(impact) {
  const records = Object.entries(impact.recordCounts)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `<li><code>${escapeHtml(reviewDeletionRecordLabels[name] || name)}</code>: ${count}</li>`)
    .join("");
  $("#review-delete-impact").innerHTML = `
    <p><strong>Estimated reclaimed space: ${escapeHtml(formatBytes(impact.bytes))}</strong> ·
      ${impact.files} files · ${impact.records} database records</p>
    <details open>
      <summary>Exact removal plan</summary>
      <h3>Files (${impact.filePaths.length})</h3>
      ${renderDeletionPathList(impact.filePaths)}
      <h3>Directories (${impact.directoryPaths.length})</h3>
      ${renderDeletionPathList(impact.directoryPaths)}
      <h3>Database records (${impact.records})</h3>
      ${records ? `<ul class="deletion-impact-list">${records}</ul>` : '<p class="list-sub">None</p>'}
    </details>`;
}

async function requestReviewDeletion(type, id) {
  const endpoint = type === "review-job" ? `/api/v1/review-jobs/${encodeURIComponent(id)}` : `/api/v1/reviews/${encodeURIComponent(id)}`;
  const impact = await api(`${endpoint}/deletion-impact`);
  state.reviewDeletionTarget = { type, id };
  renderReviewDeletionImpact(impact);
  $("#review-delete-dialog").showModal();
}

$("#review-delete-cancel").addEventListener("click", () => {
  state.reviewDeletionTarget = null;
  $("#review-delete-dialog").close();
});

$("#review-delete-confirm").addEventListener("click", async () => {
  const target = state.reviewDeletionTarget;
  if (!target) return;
  const button = $("#review-delete-confirm");
  button.disabled = true;
  try {
    const endpoint = target.type === "review-job"
      ? `/api/v1/review-jobs/${encodeURIComponent(target.id)}`
      : `/api/v1/reviews/${encodeURIComponent(target.id)}`;
    const result = await api(endpoint, { method: "DELETE" });
    $("#review-delete-dialog").close();
    state.reviewDeletionTarget = null;
    const deletedType = target.type === "review-job" ? "Review workspace" : "Review item";
    notify(`${deletedType} deleted. Removed ${result.filesDeleted} files and ${result.recordsDeleted} database records. Reclaimed ${formatBytes(result.bytesRecovered)}.`);
    state.storageDashboardLastLoadedAt = 0;
    await Promise.all([refreshDashboard(), refreshHistory(), refreshReviewQueue()]);
  } catch (error) {
    notify(error.message, true);
    await refreshStorageViews();
  } finally {
    button.disabled = false;
  }
});

$("#orphaned-data").addEventListener("click", (event) => {
  if (!event.target.closest(".orphan-cleanup-request")) return;
  const report = state.orphanCleanupReport;
  if (!report?.items.length) return;
  $("#orphan-cleanup-impact").textContent =
    `${report.items.length} untracked directories, ${report.files} files, and ${formatBytes(report.bytes)} potentially recoverable.`;
  $("#orphan-cleanup-dialog").showModal();
});

$("#orphan-cleanup-cancel").addEventListener("click", () => $("#orphan-cleanup-dialog").close());
$("#orphan-cleanup-confirm").addEventListener("click", async () => {
  const button = $("#orphan-cleanup-confirm");
  button.disabled = true;
  try {
    const result = await api("/api/v1/review-cleanup/orphans", { method: "DELETE" });
    $("#orphan-cleanup-dialog").close();
    notify(`Orphaned data cleanup completed. Recovered ${formatBytes(result.bytesRecovered)}.`);
    await refreshReviewQueue();
    await refreshStorageViews();
  } catch (error) {
    notify(error.message, true);
    await refreshReviewQueue();
    await refreshStorageViews();
  } finally {
    button.disabled = false;
  }
});

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
    ["Labeled validation accuracy", accuracy],
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
    ["Total discs processed", dashboard.stats.total],
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
  const requestId = ++state.chartRequestId;
  const data = await api(`/api/v1/stats?range=${encodeURIComponent(range)}`);
  if (requestId !== state.chartRequestId || range !== state.statsRange) return;
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
  for (const key of ["workDir", "tvStagingDir", "opticalDevice", "format", "quality", "preset", "encoder", "logLevel", "lidarrUrl", "lidarrImportDir", "musicBrainzContactEmail"]) {
    if (data.settings[key] !== undefined) form.elements.namedItem(key).value = data.settings[key];
  }
  form.elements.namedItem("autoEject").checked = data.settings.autoEject;
  form.elements.namedItem("automationMode").value = data.settings.automationMode || "regular_auto";
  form.elements.namedItem("metadataEnabled").checked = data.settings.metadataEnabled;
  form.elements.namedItem("movieIdentificationMinimumConfidence").value =
    data.settings.movieIdentificationMinimumConfidence;
  form.elements.namedItem("musicMetadataEnabled").checked = data.settings.musicMetadataEnabled;
  form.elements.namedItem("lidarrEnabled").checked = data.settings.lidarrEnabled;
  state.outputDestinations = data.settings.outputDestinations;
  state.legacyOutputPaths = { tv: data.settings.tvRootDir, movies: data.settings.moviesDir, music: data.settings.musicDir };
  renderOutputProfiles();
  form.elements.namedItem("tvDetectionEnabled").checked = data.settings.tvDetectionEnabled;
  form.elements.namedItem("tvValidationLoggingEnabled").checked = data.settings.tvValidationLoggingEnabled;
  form.elements.namedItem("storageWarningThresholdGb").value =
    data.settings.storageWarningThresholdGb === null ? "null" : String(data.settings.storageWarningThresholdGb);
  form.elements.namedItem("autoWarnLargeReviewQueues").checked = data.settings.autoWarnLargeReviewQueues;
  form.elements.namedItem("autoCleanTempLogsAfterDays").value =
    data.settings.autoCleanTempLogsAfterDays === null ? "" : String(data.settings.autoCleanTempLogsAfterDays);
  form.elements.namedItem("autoCleanFailedConversionsAfterDays").value =
    data.settings.autoCleanFailedConversionsAfterDays === null ? "" : String(data.settings.autoCleanFailedConversionsAfterDays);
  const libraryMetadata = data.settings.libraryMetadata;
  for (const key of [
    "automaticImport", "downloadSeriesMetadata", "downloadEpisodeMetadata", "downloadMovieMetadata",
    "downloadMusicMetadata", "downloadCastInformation", "downloadRatings", "downloadArtwork",
    "downloadSeasonArtwork", "downloadEpisodeImages", "downloadFanart", "downloadLogos",
    "downloadBackdrops", "downloadBanners", "generateNfo"
  ]) form.elements.namedItem(key).checked = libraryMetadata[key];
  for (const key of [
    "nfoFormat", "libraryStructure", "seriesFolderTemplate", "seasonFolderTemplate",
    "episodeFileTemplate", "movieFolderTemplate", "movieFileTemplate", "artistFolderTemplate",
    "albumFolderTemplate"
  ]) form.elements.namedItem(key).value = libraryMetadata[key];
  updateLibraryTemplateFields(form);
  await loadTvMetadataSettings();
  $("#lidarr-key-status").textContent = data.settings.lidarrApiKeyConfigured
    ? "A Lidarr API key is saved. It is never displayed."
    : "No Lidarr API key is saved.";
  $("#metadata-key-status").textContent = data.settings.metadataApiKeyConfigured
    ? "A metadata API key is saved. It is never displayed."
    : "No metadata API key is saved; movie identification will require title confirmation.";
  $("#auth-state").textContent = data.settings.adminPasswordConfigured ? "Admin protection enabled" : "Password not configured";
  $("#logout").classList.toggle("hidden", !data.settings.adminPasswordConfigured);
  await refreshLibraryHealth();
  await refreshStoragePathDiagnostics();
  updateOutputPreview();
  await refreshUpdateStatus();
  const encoders = await api("/api/v1/encoders");
  $("#encoder-capability").textContent = encoders.encoders.error
    ? encoders.encoders.error
    : `FFmpeg: ${encoders.encoders.nvidia ? "NVENC listed" : "NVENC unavailable"} · ${encoders.encoders.software ? "libx264 available" : "libx264 unavailable"}. Auto mode tests NVENC and falls back to software.`;
}

async function refreshStoragePathDiagnostics() {
  const data = await api("/api/v1/paths/diagnostics");
  const paths = data.resolvedPaths;
  const validation = data.tvStaging;
  const pathEntries = [
    ["Work", paths.work],
    ["Review", paths.review],
    ["TV Staging", paths.tvStaging],
    ["Cache", paths.cache],
    ["Jellyfin Output", paths.jellyfinOutput],
    ["Sonarr Output", paths.sonarrOutput],
    ["Radarr Output", paths.radarrOutput],
    ["Custom Output", paths.customOutput]
  ];
  const active = data.activePublishingDirectories.map((directory) =>
    `<li><strong>${escapeHtml(directory.media)} (${escapeHtml(directory.target)})</strong>: ${escapeHtml(directory.path)}</li>`
  ).join("");
  const validationMarkup = `<div class="library-health ${validation.valid ? "ready" : "warning"}">
    <strong>${validation.valid ? "✅ Valid" : "❌ Invalid"}</strong>
    <p>${escapeHtml(validation.message)}</p>
  </div>`;
  $("#tv-staging-validation").innerHTML = validationMarkup;
  $("#diagnostics-tv-staging-validation").innerHTML = validationMarkup;
  $("#tv-staging-path-source").textContent = validation.source === "work-directory"
    ? `TV staging path is currently derived from Work Directory: ${validation.path}`
    : `TV staging path is explicitly configured: ${validation.path}`;
  $("#storage-active-publishing-directories").innerHTML =
    `<h4>Active Publishing Directories</h4>${active ? `<ul>${active}</ul>` : "<p>None configured.</p>"}`;
  $("#tv-staging-autofix-details").innerHTML = validation.recommendedPath
    ? `<p>Current: <code>${escapeHtml(validation.path)}</code><br>Recommended: <code>${escapeHtml(validation.recommendedPath)}</code></p>${validation.changeBlockedReason ? `<p>${escapeHtml(validation.changeBlockedReason)}</p>` : ""}`
    : "<p>No non-overlapping recommended location could be found. Choose a path outside all active publishing directories.</p>";
  const autoFix = $("#tv-staging-autofix");
  autoFix.classList.toggle("hidden", !validation.canAutoFix);
  autoFix.disabled = !validation.canAutoFix;
  $("#storage-resolved-paths").innerHTML = diagnosticPairs([
    ["Work Directory", paths.work],
    ["TV Staging Directory", paths.tvStaging],
    ["Review Directory", paths.review],
    ["Cache Directory", paths.cache]
  ]);
  $("#diagnostics-storage-paths").innerHTML = diagnosticPairs(pathEntries);
}

function activeOutputProfile() {
  return state.outputDestinations?.profiles.find((profile) => profile.id === state.outputDestinations.activeProfileId) ||
    state.outputDestinations?.profiles[0];
}

function saveOutputProfileForm() {
  const profile = activeOutputProfile();
  if (!profile) return;
  const form = $("#settings-form");
  const value = (name) => form.elements.namedItem(name).value.trim();
  profile.name = $("#output-profile-name").value.trim() || "Output Profile";
  profile.routes = {
    tv: value("routeTv"),
    movies: value("routeMovies"),
    music: value("routeMusic")
  };
  profile.jellyfin = {
    root: value("jellyfinRoot"),
    paths: { tv: value("jellyfinTvPath"), movies: value("jellyfinMoviesPath"), music: value("jellyfinMusicPath") }
  };
  profile.sonarr = { seriesRoot: value("sonarrSeriesRoot") };
  profile.radarr = { movieRoot: value("radarrMovieRoot") };
  profile.lidarr = { artistRoot: value("lidarrArtistRoot") };
  profile.folder = { tv: value("folderTv"), movies: value("folderMovies"), music: value("folderMusic") };
}

function renderOutputProfiles() {
  if (!state.outputDestinations?.profiles?.length) return;
  const select = $("#output-profile-select");
  select.innerHTML = state.outputDestinations.profiles.map((profile) =>
    `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)}</option>`).join("");
  select.value = state.outputDestinations.activeProfileId;
  loadOutputProfileForm();
}

function loadOutputProfileForm() {
  const profile = activeOutputProfile();
  if (!profile) return;
  const form = $("#settings-form");
  $("#output-profile-name").value = profile.name;
  const fields = {
    routeTv: profile.routes.tv,
    routeMovies: profile.routes.movies,
    routeMusic: profile.routes.music,
    jellyfinRoot: profile.jellyfin.root,
    jellyfinTvPath: profile.jellyfin.paths.tv,
    jellyfinMoviesPath: profile.jellyfin.paths.movies,
    jellyfinMusicPath: profile.jellyfin.paths.music,
    sonarrSeriesRoot: profile.sonarr.seriesRoot,
    radarrMovieRoot: profile.radarr.movieRoot,
    lidarrArtistRoot: profile.lidarr.artistRoot,
    folderTv: profile.folder.tv,
    folderMovies: profile.folder.movies,
    folderMusic: profile.folder.music
  };
  for (const [name, value] of Object.entries(fields)) form.elements.namedItem(name).value = value;
  updateOutputRouteFields();
}

function updateOutputRouteFields() {
  const form = $("#settings-form");
  const routes = {
    tv: form.elements.namedItem("routeTv").value,
    movies: form.elements.namedItem("routeMovies").value,
    music: form.elements.namedItem("routeMusic").value
  };
  const targets = Object.values(routes);
  for (const group of form.querySelectorAll("[data-route-group]")) {
    group.classList.toggle("hidden", !targets.includes(group.dataset.routeGroup));
  }
  $("#settings-form").elements.namedItem("jellyfinRoot").closest("label")
    .classList.toggle("hidden", !targets.includes("jellyfin"));
  for (const label of form.querySelectorAll("[data-route-for]")) {
    label.classList.toggle("hidden", routes[label.dataset.routeFor] !== label.dataset.routeTarget);
  }
  const lidarrEnabled = form.elements.namedItem("lidarrEnabled").checked;
  $("#lidarr-settings-card").classList.toggle("hidden", !lidarrEnabled && routes.music !== "lidarr");
  updateOutputPreview();
}

function outputPathForPreview(media) {
  const form = $("#settings-form");
  const routeName = media === "tv" ? "routeTv" : media === "movies" ? "routeMovies" : "routeMusic";
  const target = form.elements.namedItem(routeName).value;
  const name = (field) => form.elements.namedItem(field).value.trim();
  if (target === "jellyfin") {
    const override = name(media === "tv" ? "jellyfinTvPath" : media === "movies" ? "jellyfinMoviesPath" : "jellyfinMusicPath");
    const root = name("jellyfinRoot");
    if (override) return override;
    if (root) return joinPreviewPath(root, media === "tv" ? "TV Shows" : media === "movies" ? "Movies" : "Music");
    return state.legacyOutputPaths[media] || "(set a library path)";
  }
  if (target === "sonarr") return name("sonarrSeriesRoot") || "(set Sonarr series root)";
  if (target === "radarr") return name("radarrMovieRoot") || "(set Radarr movie root)";
  if (target === "lidarr") return name("lidarrArtistRoot") || "(set Lidarr artist root)";
  return name(media === "tv" ? "folderTv" : media === "movies" ? "folderMovies" : "folderMusic") || "(set folder path)";
}

function joinPreviewPath(base, child) {
  const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${separator}${child}`;
}

function previewTemplate(template, values) {
  return template.replace(/\{([^}]+)\}/g, (match, key) => String(values[key] ?? match));
}

function updateOutputPreview() {
  const form = $("#settings-form");
  if (!form || !state.outputDestinations) return;
  const library = {};
  for (const key of ["seriesFolderTemplate", "seasonFolderTemplate", "episodeFileTemplate", "movieFolderTemplate", "movieFileTemplate", "artistFolderTemplate", "albumFolderTemplate"]) {
    const input = form.elements.namedItem(key);
    if (input) library[key] = input.value;
  }
  const sample = { "Series Name": "Example Series", "Movie Title": "Example Movie", Year: 2024, "Season Number:00": "01", Season: "01", "Season:00": "01", Episode: "01", "Episode:00": "01", "Episode Title": "Pilot", Artist: "Example Artist", Album: "Example Album" };
  const tvBase = outputPathForPreview("tv");
  const tvSeries = previewTemplate(library.seriesFolderTemplate || "{Series Name} ({Year})", sample);
  const tvSeason = previewTemplate(library.seasonFolderTemplate || "Season {Season Number:00}", sample);
  const tvPath = joinPreviewPath(joinPreviewPath(joinPreviewPath(tvBase, tvSeries), tvSeason), previewTemplate(library.episodeFileTemplate || "{Series Name} - S{Season:00}E{Episode:00} - {Episode Title}", sample) + `.${form.elements.namedItem("format").value}`);
  const movieBase = outputPathForPreview("movies");
  const movieFolder = previewTemplate(library.movieFolderTemplate || "{Movie Title} ({Year})", sample);
  const movieName = previewTemplate(library.movieFileTemplate || "{Movie Title} ({Year})", sample);
  const moviePath = joinPreviewPath(joinPreviewPath(movieBase, movieFolder), `${movieName}.${form.elements.namedItem("format").value}`);
  const musicBase = outputPathForPreview("music");
  const artist = previewTemplate(library.artistFolderTemplate || "{Artist}", sample);
  const album = previewTemplate(library.albumFolderTemplate || "{Album} ({Year})", sample);
  const musicPath = joinPreviewPath(joinPreviewPath(joinPreviewPath(musicBase, artist), album), "01 - Example Track.flac");
  const targetLabels = { jellyfin: "Jellyfin", sonarr: "Sonarr-compatible folder", radarr: "Radarr-compatible folder", lidarr: "Lidarr", folder: "Generic folder" };
  const routeTarget = (media) => form.elements.namedItem(media === "tv" ? "routeTv" : media === "movies" ? "routeMovies" : "routeMusic").value;
  const rows = [
    ["TV Series · Example Series", "tv", tvPath],
    ["Movie · Example Movie", "movies", moviePath],
    ["Music Album · Example Album", "music", musicPath]
  ];
  const importEnabled = form.elements.namedItem("automaticImport").checked;
  const metadata = [
    form.elements.namedItem("downloadArtwork").checked ? "Artwork" : "",
    form.elements.namedItem("generateNfo").checked ? "NFO files" : "",
    form.elements.namedItem("downloadSeriesMetadata").checked || form.elements.namedItem("downloadMovieMetadata").checked || form.elements.namedItem("downloadMusicMetadata").checked ? "Metadata" : ""
  ].filter(Boolean);
  $("#output-preview").innerHTML = rows.map(([label, media, path]) =>
    `<div class="output-preview-row"><b>${escapeHtml(label)}</b><span>${escapeHtml(path)}</span><small>Publishing mode: ${escapeHtml(targetLabels[routeTarget(media)])} · ${escapeHtml(importEnabled && metadata.length ? metadata.join(", ") : "Metadata import disabled")}</small></div>`
  ).join("");
}

async function loadDirectoryPicker(path) {
  const error = $("#directory-picker-error");
  const list = $("#directory-picker-list");
  error.textContent = "";
  list.textContent = "Loading folders…";
  try {
    const result = await api(`/api/v1/directories?path=${encodeURIComponent(path)}`);
    $("#directory-picker-path").value = result.path;
    list.innerHTML = [
      ...(result.parentPath ? [`<button class="directory-choice" type="button" data-directory-path="${escapeHtml(result.parentPath)}">.. (parent folder)</button>`] : []),
      ...result.directories.map((directory) =>
        `<button class="directory-choice" type="button" data-directory-path="${escapeHtml(directory.path)}">${escapeHtml(directory.name)}</button>`)
    ].join("") || '<p class="muted">No visible subfolders.</p>';
  } catch (cause) {
    list.textContent = "";
    error.textContent = cause.message;
  }
}

function updateLibraryTemplateFields(form = $("#settings-form")) {
  const custom = form.elements.namedItem("libraryStructure").value === "custom";
  for (const input of form.querySelectorAll('[name$="Template"]')) input.disabled = !custom;
}

$("#settings-form").elements.namedItem("libraryStructure").addEventListener("change", () => {
  updateLibraryTemplateFields();
});
$("#settings-form").addEventListener("input", updateOutputPreview);
$("#settings-form").addEventListener("change", updateOutputPreview);

async function refreshUpdateStatus() {
  const data = await api("/api/v1/updates/status");
  renderUpdateDiagnostics(data);
  const status = $("#update-status");
  const button = $("#check-updates");
  if (data.state === "applying") {
    status.textContent = "An update is being installed. AutoDisc will restart automatically; do not power off the server.";
    button.disabled = true;
  } else if (data.state === "success" && data.verificationSucceeded === true) {
    status.textContent = `AutoDisc ${data.currentVersion} was updated successfully.`;
    button.disabled = false;
  } else if (data.state === "failed") {
    status.textContent = data.lastError || "The update failed. Check the updater journal for recovery details.";
    button.disabled = false;
  } else if (data.state === "success") {
    status.textContent = "The update helper completed, but the running version could not be verified.";
    button.disabled = false;
  } else {
    status.textContent = "Updates are checked only when you click the button. A newer version is applied automatically.";
    button.disabled = false;
  }
}

function renderUpdateDiagnostics(data) {
  $("#update-version").textContent = `Current version: ${data.currentVersion || "unknown"}`;
  $("#update-target-version").textContent = `Target version: ${data.targetVersion || "none"}`;
  const formatState = (value) => (value || "not_started").replaceAll("_", " ");
  $("#update-download-state").textContent = `Download state: ${formatState(data.downloadState)}`;
  $("#update-install-state").textContent = `Install state: ${formatState(data.installState)}`;
  const error = $("#update-last-error");
  if (data.lastError) {
    error.textContent = `Last update error: ${data.lastError}`;
    error.classList.remove("hidden");
  } else {
    error.textContent = "";
    error.classList.add("hidden");
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
      renderUpdateDiagnostics(data);
      if (data.state === "applying") {
        sawApplying = true;
        $("#update-status").textContent = "Installing update… AutoDisc will restart when it is complete.";
      } else if (data.state === "success" && data.verificationSucceeded === true) {
        $("#update-status").textContent = `AutoDisc ${data.currentVersion} was updated successfully.`;
        return;
      } else if (data.state === "failed") {
        $("#update-status").textContent = data.lastError || "The update failed. Check the updater journal for recovery details.";
        return;
      } else if (sawApplying || data.state === "success") {
        $("#update-status").textContent = "Update service restarted. Confirming the running version…";
      }
    } catch {
      $("#update-status").textContent = "AutoDisc is restarting to apply the update…";
    }
  }
  $("#update-status").textContent = "The update is taking longer than expected. Check the AutoDisc system service and updater logs.";
}

function renderMetrics(snapshot) {
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
  clearTimeout(state.diagnosticsRefreshTimer);
  state.diagnosticsRefreshTimer = null;
  clearTimeout(state.dashboardAttentionTimer);
  state.dashboardAttentionTimer = null;
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
    state.statusEventVersion += 1;
    state.currentActiveJob = active;
    state.currentRuntimeStatus = payload.state;
    state.hasActiveJob = Boolean(active);
    renderManualMusicMetadata(payload.manualMusicMetadata);
    renderJob(active, payload.state);
    if (state.page === "dashboard" && !(previous && !active)) {
      scheduleDashboardAttention({
        active,
        manualMusicMetadata: payload.manualMusicMetadata
      });
    }
    if (previous && !active) {
      if (state.page === "dashboard") refreshDashboard().catch((error) => notify(error.message, true));
      if (state.page === "history") refreshHistory().catch((error) => notify(error.message, true));
      if (state.page === "tv-analysis") loadTvAnalysis().catch((error) => notify(error.message, true));
      if (state.page === "tv-analysis") loadTvMatching().catch((error) => notify(error.message, true));
      if (state.page === "tv-reviews") loadTvReviews().catch((error) => notify(error.message, true));
      if (state.page === "tv-validation") loadTvValidation().catch((error) => notify(error.message, true));
      if (state.page === "tv-validation") loadStatistics().catch((error) => notify(error.message, true));
    }
    if (state.page === "diagnostics") {
      clearTimeout(state.diagnosticsRefreshTimer);
      state.diagnosticsRefreshTimer = setTimeout(() => {
        if (state.page !== "diagnostics") return;
        loadDiagnostics(state.diagnosticsJobId, !state.diagnosticsJobId).catch((error) => notify(error.message, true));
      }, 150);
    }
  });
  if (state.page === "dashboard") {
    state.metricsStream = new EventSource("/api/v1/system/events");
    state.metricsStream.addEventListener("metrics", (event) => renderMetrics(JSON.parse(event.data)));
  }
}

function showPage(page, activeNavButton = null) {
  state.page = page;
  document.querySelectorAll(".page").forEach((section) => section.classList.toggle("hidden", section.id !== `page-${page}`));
  const navButtons = [...document.querySelectorAll(".nav-link[data-page]")];
  const currentNavButton = activeNavButton || navButtons.find((button) =>
    button.dataset.page === page && (page !== "settings" || button.dataset.scroll === "#general-settings-card"));
  navButtons.forEach((button) => button.classList.toggle("active", button === currentNavButton));
  document.querySelectorAll(".nav-group").forEach((group) => {
    const active = Boolean(currentNavButton?.closest(".nav-group") === group);
    group.classList.toggle("active", active);
    if (active) group.open = true;
  });
  const pageTitles = {
    dashboard: "Dashboard",
    diagnostics: "Disc Diagnostics",
    history: "History",
    "tv-analysis": "TV Identification",
    "tv-reviews": "Review Queue",
    "tv-validation": "Activity & Insights",
    "storage-manager": "Storage Manager",
    settings: "Settings"
  };
  $("#page-title").textContent = pageTitles[page] || page;
  updateStreams();
  if (page === "dashboard") refreshDashboard().catch((error) => notify(error.message, true));
  if (page === "diagnostics") {
    loadDiagnostics().catch((error) => notify(error.message, true));
    refreshStoragePathDiagnostics().catch((error) => notify(error.message, true));
  }
  if (page === "history") refreshHistory().catch((error) => notify(error.message, true));
  if (page === "tv-analysis") {
    loadTvAnalysis().catch((error) => notify(error.message, true));
    loadTvMatching().catch((error) => notify(error.message, true));
  }
  if (page === "tv-reviews") loadTvReviews().catch((error) => notify(error.message, true));
  if (page === "tv-reviews") loadReviewCentre().catch((error) => notify(error.message, true));
  if (page === "tv-validation") {
    loadTvValidation().catch((error) => notify(error.message, true));
    loadStatistics().catch((error) => notify(error.message, true));
  }
  if (page === "storage-manager") loadStorageManager().catch((error) => notify(error.message, true));
  if (page === "settings") loadSettings().catch((error) => notify(error.message, true));
}

$("#storage-manager-refresh").addEventListener("click", () => {
  loadStorageManager().catch((error) => notify(error.message, true));
});

document.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", (event) => {
  if (button.tagName === "A") event.preventDefault();
  if (button.dataset.reviewCategory) $("#review-category").value = button.dataset.reviewCategory;
  showPage(button.dataset.page, button.classList.contains("nav-link") ? button : null);
  if (button.dataset.scroll) {
    requestAnimationFrame(() => document.querySelector(button.dataset.scroll)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }
}));
document.querySelectorAll(".range").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll(".range").forEach((item) => item.classList.toggle("active", item === button));
  refreshChart(button.dataset.range).catch((error) => notify(error.message, true));
}));
$("#refresh-history").addEventListener("click", () => refreshHistory().catch((error) => notify(error.message, true)));
$("#refresh-diagnostics").addEventListener("click", () => loadDiagnostics(state.diagnosticsJobId, !state.diagnosticsJobId).catch((error) => notify(error.message, true)));
$("#refresh-capabilities").addEventListener("click", () => {
  capabilityReportLoaded = false;
  loadCapabilities().catch((error) => notify(error.message, true));
});
$("#refresh-storage-diagnostics").addEventListener("click", () =>
  refreshStoragePathDiagnostics().catch((error) => notify(error.message, true)));
$("#tv-staging-autofix").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const result = await api("/api/v1/paths/tv-staging/auto-fix", { method: "POST" });
    $("#settings-form").elements.namedItem("tvStagingDir").value = result.settings.tvStagingDir;
    await refreshStoragePathDiagnostics();
    notify(`TV staging moved to ${result.settings.tvStagingDir}.`);
  } catch (error) {
    notify(error.message, true);
  } finally {
    button.disabled = false;
  }
});
$("#diagnostics-job").addEventListener("change", () => {
  const jobId = $("#diagnostics-job").value;
  loadDiagnostics(jobId, !jobId).catch((error) => notify(error.message, true));
});
$("#tv-analysis-confidence").addEventListener("change", () => loadTvAnalysis().catch((error) => notify(error.message, true)));
$("#tv-analysis-state").addEventListener("change", () => loadTvAnalysis().catch((error) => notify(error.message, true)));
$("#tv-review-filter").addEventListener("change", () => loadTvReviews().catch((error) => notify(error.message, true)));
$("#refresh-reviews").addEventListener("click", () => refreshReviewQueue().catch((error) => notify(error.message, true)));
$("#library-settings-health").addEventListener("click", async (event) => {
  const button = event.target.closest(".create-library");
  if (!button) return;
  button.disabled = true;
  try {
    const result = await api("/api/library/create", {
      method: "POST",
      body: JSON.stringify({ type: button.dataset.library })
    });
    notify(`${result.type} library folder is ready at ${result.path}.`);
    await refreshLibraryHealth();
  } catch (error) {
    notify(error.message, true);
    await refreshLibraryHealth().catch(() => {});
  } finally {
    button.disabled = false;
  }
});

["review-category", "review-severity", "review-status", "review-from", "review-to"].forEach((id) =>
  $(`#${id}`).addEventListener("change", () => loadReviewCentre().catch((error) => notify(error.message, true))));

$("#review-list").addEventListener("click", async (event) => {
  const button = event.target.closest(".review-action");
  if (!button) return;
  button.disabled = true;
  try {
    const action = button.dataset.action;
    if (action === "delete") {
      await requestReviewDeletion("review-item", button.dataset.reviewId);
      return;
    }
    if (action === "open-settings") {
      showPage("settings");
      return;
    }
    if (action === "open-review") {
      showPage("tv-reviews");
      $("#review-jobs-list").scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (action === "enter-metadata") {
      showPage("dashboard");
      const status = await api("/api/v1/status");
      renderManualMusicMetadata(status.manualMusicMetadata);
      if (!status.manualMusicMetadata) notify("This CD is no longer waiting for manual metadata.", true);
      return;
    }
    if (action === "view-job") {
      const { job } = await api(`/api/v1/reviews/${encodeURIComponent(button.dataset.reviewId)}`);
      const container = button.closest(".review-item").querySelector(".review-job-details");
      container.innerHTML = `<details open><summary>Related job and logs</summary>${job ? `<p>${escapeHtml(job.job.title || job.job.discLabel || job.job.id)} · ${escapeHtml(job.job.status)}</p><pre>${escapeHtml(JSON.stringify(job.timeline, null, 2))}</pre>` : "<p>Related job is no longer available.</p>"}</details>`;
      return;
    }
    const endpoint = action === "retry" ? "retry" : action === "resolve" ? "resolve" :
      action === "approve-process" ? "approve-process" : "dismiss";
    const result = await api(`/api/v1/reviews/${encodeURIComponent(button.dataset.reviewId)}/${endpoint}`, { method: "POST" });
    notify(result.message || (action === "approve-process" ? "Disc approved and processing completed." :
      `Review ${action === "dismiss" ? "dismissed" : action === "retry" ? "retry requested" : "resolved"}.`));
    await refreshReviewQueue();
  } catch (error) {
    notify(error.message, true);
  } finally {
    button.disabled = false;
  }
});

$("#review-jobs-list").addEventListener("click", async (event) => {
  const button = event.target.closest(".review-job-action");
  if (!button) return;
  const id = button.dataset.id;
  const action = button.dataset.action;
  const card = button.closest(".review-item");
  button.disabled = true;
  try {
    if (action === "open") {
      card.querySelector(".review-job-editor").classList.toggle("hidden");
      return;
    }
    if (action === "save") {
      const title = card.querySelector("[data-review-title]").value.trim();
      await api(`/api/v1/review-jobs/${encodeURIComponent(id)}/metadata`, {
        method: "POST",
        body: JSON.stringify({ title })
      });
      notify("Review metadata saved.");
    } else if (action === "continue") {
      const editor = card.querySelector(".review-job-editor");
      if (!editor.classList.contains("hidden")) {
        const title = card.querySelector("[data-review-title]").value.trim();
        await api(`/api/v1/review-jobs/${encodeURIComponent(id)}/metadata`, {
          method: "POST",
          body: JSON.stringify({ title })
        });
      }
      const result = await api(`/api/v1/review-jobs/${encodeURIComponent(id)}/continue`, { method: "POST" });
      notify(result.message);
    } else if (action === "delete") {
      await requestReviewDeletion("review-job", id);
      return;
    } else if (action === "clear") {
      const result = await api(`/api/v1/review-jobs/${encodeURIComponent(id)}/clear-notification`, { method: "POST" });
      notify(result.message);
    }
    await refreshReviewQueue();
  } catch (error) {
    notify(error.message, true);
  } finally {
    button.disabled = false;
  }
});

$("#review-jobs-list").addEventListener("change", (event) => {
  const select = event.target.closest(".movie-review-candidate");
  if (!select) return;
  const title = select.selectedOptions[0]?.dataset.title;
  if (!title) return;
  const card = select.closest(".review-item");
  const titleInput = card.querySelector("[data-review-title]");
  if (titleInput) titleInput.value = title;
});

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
      const recoveryResponse = await api(`/api/v1/tv/plans/${encodeURIComponent(planId)}/recovery`);
      const manualMappings = new Map((recoveryResponse.recovery?.mappings || []).map((mapping) =>
        [mapping.trackId, mapping.episodes]));
      const mappingsToApply = (recoveryResponse.recovery?.mediaTypeOverridden &&
        recoveryResponse.recovery.finalMediaType === "tv_series")
        ? (recoveryResponse.recovery.mappings || [])
        : [];
      for (const mapping of mappingsToApply) {
        await api(`/api/v1/tv/plans/${encodeURIComponent(planId)}/corrections`, {
          method: "POST",
          body: JSON.stringify({
            action: "assign-episodes",
            itemId: mapping.trackId,
            episodes: mapping.episodes,
            reviewer: "admin",
            reason: "Applied saved manual recovery mapping"
          })
        });
      }
      const result = await api(`/api/v1/tv/plans/${encodeURIComponent(planId)}/review`, {
        method: "POST",
        body: JSON.stringify({ action, reviewer: "admin", ...(reason ? { reason } : {}) })
      });
      notify(`TV plan ${result.plan.state}. Automatic execution remains disabled; manual recovery mappings can be processed.`);
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

document.addEventListener("click", async (event) => {
  const button = event.target.closest(".tv-recovery-form [data-action]");
  if (!button) return;
  const form = button.closest(".tv-recovery-form");
  const action = button.dataset.action;
  if (action === "add-episode-map") {
    const list = form.querySelector(".tv-episode-map-list");
    const template = list.querySelector("[data-episode-map-row]");
    if (!template) return;
    const row = template.cloneNode(true);
    row.querySelector("[data-map-track]").selectedIndex = 0;
    row.querySelector("[data-map-provider-episode]").selectedIndex = 0;
    row.querySelector("[data-map-season]").value = form.elements.seasonNumber.value;
    row.querySelector("[data-map-episode]").value = "";
    row.querySelector("[data-map-title]").value = "";
    row.querySelector("[data-map-air-date]").value = "";
    row.querySelector("[data-map-notes]").value = "";
    list.append(row);
    return;
  }
  if (action === "remove-episode-map") {
    button.closest("[data-episode-map-row]")?.remove();
    return;
  }
  if (action === "import-series") {
    if (!form.dataset.lookupResult) return;
    button.disabled = true;
    try {
      const candidate = JSON.parse(form.dataset.lookupResult).series;
      form.elements.seriesName.value = candidate.title;
      const metadataSeriesId = candidate.metadata?.seriesId || candidate.id;
      form.querySelectorAll("[data-map-series-id]").forEach((input) => { input.value = metadataSeriesId; });
      if (!form.elements.providerId.value) form.elements.providerId.value = candidate.id;
      const provider = form.elements.metadataProvider.value;
      if (provider !== "manual") {
        const seasonNumber = Number(form.elements.seasonNumber.value);
        if (!Number.isInteger(seasonNumber) || seasonNumber < 0) {
          throw new Error("Enter a season number before importing episode metadata.");
        }
        const { episodes } = await api("/api/v1/tv/metadata/episodes/lookup", {
          method: "POST",
          body: JSON.stringify({
            provider,
            providerId: form.elements.providerId.value.trim(),
            seasonNumber
          })
        });
        form.dataset.providerEpisodes = JSON.stringify(episodes);
        const options = `<option value="">Manual mapping</option>${episodes.map((episode) =>
          `<option value="${escapeHtml(JSON.stringify(episode))}">S${String(episode.seasonNumber).padStart(2, "0")}E${String(episode.episodeNumber).padStart(2, "0")} · ${escapeHtml(episode.title)}</option>`).join("")}`;
        form.querySelectorAll("[data-map-provider-episode]").forEach((select) => { select.innerHTML = options; });
        notify(`Imported ${episodes.length} episode metadata entries for ${candidate.title}. Select an episode for each track, then save.`);
      } else {
        notify(`Imported manual series metadata for ${candidate.title}. Save to persist it.`);
      }
    } catch (error) {
      notify(error.message, true);
    } finally {
      button.disabled = false;
    }
    return;
  }
  if (action === "lookup-series") {
    const provider = form.elements.metadataProvider.value;
    const providerId = form.elements.providerId.value.trim();
    const seriesName = form.elements.seriesName.value.trim();
    if (provider !== "manual" && !providerId) {
      notify("Enter a provider ID before looking up the series.", true);
      return;
    }
    button.disabled = true;
    try {
      const { series } = await api("/api/v1/tv/metadata/series/lookup", {
        method: "POST",
        body: JSON.stringify({ provider, providerId, seriesName })
      });
      form.dataset.lookupResult = JSON.stringify({ series });
      const preview = form.querySelector(".tv-series-lookup-result");
      preview.innerHTML = `<div class="tv-series-preview"><b>${escapeHtml(series.title)}</b>${series.metadata?.year ? ` (${escapeHtml(series.metadata.year)})` : ""}<p>${escapeHtml(series.metadata?.overview || "No provider overview supplied.")}</p></div>`;
      form.querySelector('[data-action="import-series"]').disabled = false;
    } catch (error) {
      notify(error.message, true);
    } finally {
      button.disabled = false;
    }
  }
});

document.addEventListener("submit", async (event) => {
  const tvForm = event.target.closest(".tv-task-media-override");
  if (tvForm) {
    event.preventDefault();
    const button = tvForm.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      await api(`/api/v1/discs/recovery/${encodeURIComponent(tvForm.dataset.fingerprint)}`, {
        method: "PUT",
        body: JSON.stringify({
          mediaType: tvForm.elements.mediaType.value,
          mediaTypeReason: tvForm.elements.mediaTypeReason.value.trim() || undefined
        })
      });
      notify("Manual media classification saved and audit logged.");
      await loadTvReviews();
    } catch (error) {
      notify(error.message, true);
    } finally {
      button.disabled = false;
    }
    return;
  }
  const form = event.target.closest(".tv-recovery-form");
  if (!form) return;
  event.preventDefault();
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    const mappingsByTrack = new Map();
    for (const row of form.querySelectorAll("[data-episode-map-row]")) {
      const trackId = row.querySelector("[data-map-track]").value;
      const seasonValue = row.querySelector("[data-map-season]").value;
      const episodeValue = row.querySelector("[data-map-episode]").value;
      const title = row.querySelector("[data-map-title]").value.trim();
      if (!episodeValue && !title) continue;
      if (!trackId || !/^\d+$/.test(seasonValue) || !/^\d+$/.test(episodeValue)) {
        throw new Error("Each episode mapping needs a track, season number, and episode number.");
      }
      const seriesId = row.querySelector("[data-map-series-id]").value ||
        form.elements.providerId.value.trim() || `manual:${form.elements.seriesName.value.trim()}`;
      if (!mappingsByTrack.has(trackId)) mappingsByTrack.set(trackId, []);
      mappingsByTrack.get(trackId).push({
        seriesId,
        seasonNumber: Number(seasonValue),
        episodeNumber: Number(episodeValue),
        ...(title ? { title } : {}),
        ...(row.querySelector("[data-map-air-date]").value
          ? { airDate: row.querySelector("[data-map-air-date]").value } : {}),
        ...(row.querySelector("[data-map-notes]").value.trim()
          ? { notes: row.querySelector("[data-map-notes]").value.trim() } : {})
      });
    }
    const seasonValue = form.elements.seasonNumber.value;
    const importedSeries = form.dataset.lookupResult
      ? JSON.parse(form.dataset.lookupResult).series
      : null;
    await api(`/api/v1/tv/plans/${encodeURIComponent(form.dataset.planId)}/recovery`, {
      method: "PUT",
      body: JSON.stringify({
        discType: form.elements.discType.value,
        mediaType: form.elements.mediaType.value,
        mediaTypeReason: form.elements.mediaTypeReason.value.trim() || undefined,
        metadataProvider: form.elements.metadataProvider.value,
        providerId: form.elements.providerId.value.trim() || null,
        seriesName: form.elements.seriesName.value.trim() || null,
        seasonNumber: seasonValue === "" ? null : Number(seasonValue),
        mappings: [...mappingsByTrack].map(([trackId, episodes]) => ({ trackId, episodes })),
        ...(importedSeries ? {
          importedMetadata: { ...(importedSeries.metadata || {}), entityType: importedSeries.entityType },
          artworkReferences: importedSeries.metadata?.artwork || []
        } : {}),
        notes: form.elements.notes.value
      })
    });
    notify("Manual recovery saved. The next detection will use these classification and episode decisions.");
    await loadTvReviews();
  } catch (error) {
    notify(error.message, true);
  } finally {
    button.disabled = false;
  }
});

document.addEventListener("change", (event) => {
  const select = event.target.closest("[data-map-provider-episode]");
  if (!select?.value) return;
  const episode = JSON.parse(select.value);
  const row = select.closest("[data-episode-map-row]");
  row.querySelector("[data-map-season]").value = episode.seasonNumber;
  row.querySelector("[data-map-episode]").value = episode.episodeNumber;
  row.querySelector("[data-map-title]").value = episode.title || "";
  row.querySelector("[data-map-air-date]").value = episode.airDate || "";
  row.querySelector("[data-map-series-id]").value = episode.seriesId;
});

document.addEventListener("dragstart", (event) => {
  const track = event.target.closest(".tv-recovery-track");
  if (!track || !event.dataTransfer) return;
  event.dataTransfer.setData("text/plain", track.dataset.trackId);
  event.dataTransfer.effectAllowed = "copy";
});
document.addEventListener("dragover", (event) => {
  const row = event.target.closest("[data-episode-map-row]");
  if (!row) return;
  event.preventDefault();
  row.classList.add("drag-target");
});
document.addEventListener("dragleave", (event) => {
  event.target.closest("[data-episode-map-row]")?.classList.remove("drag-target");
});
document.addEventListener("drop", (event) => {
  const row = event.target.closest("[data-episode-map-row]");
  if (!row || !event.dataTransfer) return;
  event.preventDefault();
  const trackId = event.dataTransfer.getData("text/plain");
  const select = row.querySelector("[data-map-track]");
  if ([...select.options].some((option) => option.value === trackId)) select.value = trackId;
  row.classList.remove("drag-target");
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
  if (!button) return;
  try {
    const { tasks } = await api("/api/v1/tv/matching");
    if (tasks.some(({ task }) => task.jobId === button.dataset.jobId)) {
      requestTvTaskDeletion(button.dataset.jobId);
      return;
    }
  } catch (error) {
    notify(error.message, true);
    return;
  }
  if (!confirm("Remove this entry from history? The finished media file will not be deleted.")) return;
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
    renderUpdateDiagnostics({
      currentVersion: check.currentVersion,
      targetVersion: check.updateAvailable ? check.latestVersion : null,
      downloadState: "not_started",
      installState: "not_started",
      lastError: null
    });
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

$("#output-profile-select").addEventListener("change", () => {
  saveOutputProfileForm();
  state.outputDestinations.activeProfileId = $("#output-profile-select").value;
  loadOutputProfileForm();
});

$("#output-profile-name").addEventListener("input", () => {
  const profile = activeOutputProfile();
  if (!profile) return;
  profile.name = $("#output-profile-name").value.trim() || "Output Profile";
  const option = [...$("#output-profile-select").options].find((item) => item.value === profile.id);
  if (option) option.textContent = profile.name;
});

$("#output-profile-new").addEventListener("click", () => {
  saveOutputProfileForm();
  const id = `profile-${Date.now()}`;
  const active = activeOutputProfile();
  const profile = active ? structuredClone(active) : null;
  if (!profile) return;
  profile.id = id;
  profile.name = "New Profile";
  state.outputDestinations.profiles.push(profile);
  state.outputDestinations.activeProfileId = id;
  renderOutputProfiles();
  $("#output-profile-name").focus();
});

$("#output-profile-delete").addEventListener("click", () => {
  if (state.outputDestinations.profiles.length <= 1) {
    notify("At least one output profile is required.", true);
    return;
  }
  state.outputDestinations.profiles = state.outputDestinations.profiles
    .filter((profile) => profile.id !== state.outputDestinations.activeProfileId);
  state.outputDestinations.activeProfileId = state.outputDestinations.profiles[0].id;
  renderOutputProfiles();
});

["routeTv", "routeMovies", "routeMusic"].forEach((name) =>
  $("#settings-form").elements.namedItem(name).addEventListener("change", updateOutputRouteFields));
$("#settings-form").elements.namedItem("lidarrEnabled").addEventListener("change", updateOutputRouteFields);

for (const name of [
  "jellyfinRoot", "jellyfinTvPath", "jellyfinMoviesPath", "jellyfinMusicPath",
  "sonarrSeriesRoot", "radarrMovieRoot", "lidarrArtistRoot",
  "folderTv", "folderMovies", "folderMusic"
]) {
  const input = $("#settings-form").elements.namedItem(name);
  const browse = document.createElement("button");
  browse.type = "button";
  browse.className = "button secondary directory-browse";
  browse.dataset.browseFor = name;
  browse.textContent = "Browse";
  input.insertAdjacentElement("afterend", browse);
}

$("#settings-form").addEventListener("click", (event) => {
  const button = event.target.closest("[data-browse-for]");
  if (!button) return;
  state.directoryPickerTarget = button.dataset.browseFor;
  const currentPath = $("#settings-form").elements.namedItem(state.directoryPickerTarget).value || "/";
  $("#directory-picker").showModal();
  loadDirectoryPicker(currentPath);
});

$("#directory-picker-close").addEventListener("click", () => $("#directory-picker").close());
$("#directory-picker-go").addEventListener("click", () => loadDirectoryPicker($("#directory-picker-path").value));
$("#directory-picker-path").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    loadDirectoryPicker(event.currentTarget.value);
  }
});
$("#directory-picker-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-directory-path]");
  if (button) loadDirectoryPicker(button.dataset.directoryPath);
});
$("#directory-picker-select").addEventListener("click", () => {
  if (!state.directoryPickerTarget) return;
  $("#settings-form").elements.namedItem(state.directoryPickerTarget).value = $("#directory-picker-path").value;
  $("#directory-picker").close();
});

$("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  saveOutputProfileForm();
  const patch = {
    outputDestinations: state.outputDestinations,
    workDir: values.get("workDir"),
    tvStagingDir: values.get("tvStagingDir"),
    opticalDevice: values.get("opticalDevice"),
    format: values.get("format"),
    quality: Number(values.get("quality")),
    preset: values.get("preset"),
    encoder: values.get("encoder"),
    autoEject: form.elements.namedItem("autoEject").checked,
    automationMode: values.get("automationMode"),
    metadataEnabled: form.elements.namedItem("metadataEnabled").checked,
    movieIdentificationMinimumConfidence: Number(values.get("movieIdentificationMinimumConfidence")),
    musicMetadataEnabled: form.elements.namedItem("musicMetadataEnabled").checked,
    musicBrainzContactEmail: values.get("musicBrainzContactEmail"),
    libraryMetadata: {
      automaticImport: form.elements.namedItem("automaticImport").checked,
      downloadSeriesMetadata: form.elements.namedItem("downloadSeriesMetadata").checked,
      downloadEpisodeMetadata: form.elements.namedItem("downloadEpisodeMetadata").checked,
      downloadMovieMetadata: form.elements.namedItem("downloadMovieMetadata").checked,
      downloadMusicMetadata: form.elements.namedItem("downloadMusicMetadata").checked,
      downloadCastInformation: form.elements.namedItem("downloadCastInformation").checked,
      downloadRatings: form.elements.namedItem("downloadRatings").checked,
      downloadArtwork: form.elements.namedItem("downloadArtwork").checked,
      downloadSeasonArtwork: form.elements.namedItem("downloadSeasonArtwork").checked,
      downloadEpisodeImages: form.elements.namedItem("downloadEpisodeImages").checked,
      downloadFanart: form.elements.namedItem("downloadFanart").checked,
      downloadLogos: form.elements.namedItem("downloadLogos").checked,
      downloadBackdrops: form.elements.namedItem("downloadBackdrops").checked,
      downloadBanners: form.elements.namedItem("downloadBanners").checked,
      generateNfo: form.elements.namedItem("generateNfo").checked,
      nfoFormat: values.get("nfoFormat"),
      libraryStructure: values.get("libraryStructure"),
      seriesFolderTemplate: form.elements.namedItem("seriesFolderTemplate").value,
      seasonFolderTemplate: form.elements.namedItem("seasonFolderTemplate").value,
      episodeFileTemplate: form.elements.namedItem("episodeFileTemplate").value,
      movieFolderTemplate: form.elements.namedItem("movieFolderTemplate").value,
      movieFileTemplate: form.elements.namedItem("movieFileTemplate").value,
      artistFolderTemplate: form.elements.namedItem("artistFolderTemplate").value,
      albumFolderTemplate: form.elements.namedItem("albumFolderTemplate").value
    },
    lidarrEnabled: form.elements.namedItem("lidarrEnabled").checked,
    tvDetectionEnabled: form.elements.namedItem("tvDetectionEnabled").checked,
    tvValidationLoggingEnabled: form.elements.namedItem("tvValidationLoggingEnabled").checked,
    storageWarningThresholdGb: values.get("storageWarningThresholdGb") === "null"
      ? null
      : Number(values.get("storageWarningThresholdGb")),
    autoWarnLargeReviewQueues: form.elements.namedItem("autoWarnLargeReviewQueues").checked,
    autoCleanTempLogsAfterDays: values.get("autoCleanTempLogsAfterDays")
      ? Number(values.get("autoCleanTempLogsAfterDays"))
      : null,
    autoCleanFailedConversionsAfterDays: values.get("autoCleanFailedConversionsAfterDays")
      ? Number(values.get("autoCleanFailedConversionsAfterDays"))
      : null,
    tvMetadataLookupEnabled: form.elements.namedItem("tvMetadataLookupEnabled").checked,
    tvMetadataPreferredProviderId: values.get("tvMetadataPreferredProviderId"),
    tvMetadataFallbackProviderId: values.get("tvMetadataFallbackProviderId"),
    tvMetadataCacheEnabled: form.elements.namedItem("tvMetadataCacheEnabled").checked,
    tvMetadataCacheDurationHours: Number(values.get("tvMetadataCacheDurationHours")),
    tvMetadataProviderEnabled: Object.fromEntries(
      [...form.querySelectorAll(".tv-metadata-provider-enabled")].map((input) =>
        [input.dataset.providerId, input.checked])
    ),
    metadataProvider: "tmdb",
    logLevel: values.get("logLevel")
  };
  const providerApiKeys = {};
  for (const input of form.querySelectorAll(".tv-metadata-provider-key")) {
    const providerId = input.dataset.providerId;
    const clearKey = form.querySelector(`.tv-metadata-provider-clear[data-provider-id="${CSS.escape(providerId)}"]`);
    if (clearKey.checked) providerApiKeys[providerId] = "";
    else if (input.value) providerApiKeys[providerId] = input.value;
  }
  patch.tvMetadataProviderApiKeys = providerApiKeys;
  if (values.get("lidarrUrl") || patch.lidarrEnabled) patch.lidarrUrl = values.get("lidarrUrl");
  if (values.get("lidarrImportDir") || patch.lidarrEnabled) patch.lidarrImportDir = values.get("lidarrImportDir");
  if (values.get("metadataApiKey")) patch.metadataApiKey = values.get("metadataApiKey");
  if (form.elements.namedItem("clearMetadataKey").checked) patch.metadataApiKey = "";
  if (values.get("lidarrApiKey")) patch.lidarrApiKey = values.get("lidarrApiKey");
  if (form.elements.namedItem("clearLidarrApiKey").checked) patch.lidarrApiKey = "";
  if (values.get("adminPassword")) patch.adminPassword = values.get("adminPassword");
  try {
    await api("/api/v1/settings", { method: "PUT", body: JSON.stringify(patch) });
    const savedSettings = await api("/api/v1/settings");
    state.outputDestinations = savedSettings.settings.outputDestinations;
    state.legacyOutputPaths = {
      tv: savedSettings.settings.tvRootDir,
      movies: savedSettings.settings.moviesDir,
      music: savedSettings.settings.musicDir
    };
      renderOutputProfiles();
    await refreshLibraryHealth();
    await refreshStoragePathDiagnostics();
    form.elements.namedItem("adminPassword").value = "";
    form.elements.namedItem("metadataApiKey").value = "";
    form.elements.namedItem("clearMetadataKey").checked = false;
    form.elements.namedItem("lidarrApiKey").value = "";
    form.elements.namedItem("clearLidarrApiKey").checked = false;
    form.querySelectorAll(".tv-metadata-provider-key").forEach((input) => { input.value = ""; });
    form.querySelectorAll(".tv-metadata-provider-clear").forEach((input) => { input.checked = false; });
    await loadTvMetadataSettings();
    $("#settings-message").textContent = "Settings saved.";
    state.storageDashboardLastLoadedAt = 0;
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
  saveOutputProfileForm();
  button.disabled = true;
  status.classList.remove("hidden");
  status.textContent = "Checking configured folders and optical drive permissions…";
  try {
    const result = await api("/api/v1/paths/check", {
      method: "POST",
      body: JSON.stringify({
        outputDestinations: state.outputDestinations,
        workDir: values.get("workDir"),
        opticalDevice: values.get("opticalDevice"),
        lidarrImportDir: values.get("lidarrImportDir"),
        lidarrEnabled: form.elements.namedItem("lidarrEnabled").checked
      })
    });
    status.innerHTML = `<strong>${result.ok ? "All configured paths passed." : "Some path checks failed."}</strong>${result.checks.map((check) =>
      `<div class="path-check ${check.ok ? "passed" : "failed"}"><span>${check.ok ? "OK" : "FAIL"} · ${escapeHtml(check.name)}</span><span>${escapeHtml(check.message)}</span><small>${escapeHtml(check.path)}</small>${check.name === "TV root folder" ? `<small>Permissions: ${escapeHtml(check.ok ? "Readable, searchable, and writable" : "Validation failed")} · Free space: ${check.availableBytes === undefined ? `Unavailable${check.spaceError ? ` (${escapeHtml(check.spaceError)})` : ""}` : escapeHtml(formatBytes(check.availableBytes))}</small>` : ""}</div>`
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

$("#tv-metadata-providers").addEventListener("click", async (event) => {
  const button = event.target.closest(".test-tv-metadata-provider");
  if (!button) return;
  const providerId = button.dataset.providerId;
  const status = $("#tv-metadata-providers").querySelector(
    `.tv-metadata-validation[data-provider-validation="${CSS.escape(providerId)}"]`
  );
  button.disabled = true;
  status.textContent = "Testing provider connection…";
  try {
    const result = await api(`/api/v1/tv/metadata/providers/${encodeURIComponent(providerId)}/test`, { method: "POST" });
    status.textContent = `Success · ${result.validation.message} · ${new Date(result.validation.validatedAt).toLocaleString()}`;
    await loadTvMetadataSettings();
  } catch (error) {
    status.textContent = `Failure · ${error.message}`;
  } finally {
    button.disabled = false;
  }
});

$("#refresh-tv-metadata-cache").addEventListener("click", async () => {
  const button = $("#refresh-tv-metadata-cache");
  const status = $("#tv-metadata-cache-status");
  button.disabled = true;
  status.textContent = "Requesting metadata cache refresh…";
  try {
    const result = await api("/api/v1/tv/metadata/cache/refresh", { method: "POST" });
    status.textContent = `${result.ok ? "Success" : "Failure"} · ${result.message} · ${new Date(result.refreshedAt).toLocaleString()}`;
    if (result.errors?.length) status.textContent += ` · ${result.errors.join("; ")}`;
    await Promise.all([loadTvMetadataMetrics(), loadTvMetadataSettings()]);
  } catch (error) {
    status.textContent = `Refresh unavailable: ${error.message}`;
  } finally {
    button.disabled = false;
  }
});

$("#clear-tv-metadata-cache").addEventListener("click", async () => {
  const button = $("#clear-tv-metadata-cache");
  const status = $("#tv-metadata-cache-status");
  button.disabled = true;
  try {
    const result = await api("/api/v1/tv/metadata/cache", { method: "DELETE" });
    status.textContent = `Cleared ${result.cleared} cached entries · ${new Date(result.refreshedAt).toLocaleString()}`;
    await refreshStorageViews();
  } catch (error) {
    status.textContent = `Cache clear failed: ${error.message}`;
  } finally {
    button.disabled = false;
  }
});

$("#refresh-tv-metadata-providers").addEventListener("click", async () => {
  const button = $("#refresh-tv-metadata-providers");
  const status = $("#tv-metadata-cache-status");
  button.disabled = true;
  try {
    const result = await api("/api/v1/tv/metadata/providers/refresh", { method: "POST" });
    status.textContent = `${result.ok ? "Success" : "Failure"} · Provider metadata refresh · ${new Date(result.refreshedAt).toLocaleString()} · ${result.metadata.refreshed} cached entries refreshed, ${result.metadata.failed} failed · ${
      result.providers.map((provider) => `${provider.id}: ${provider.status} (${provider.message})`).join("; ")
    }${result.metadata.errors.length ? ` · Errors: ${result.metadata.errors.join("; ")}` : ""}`;
    await Promise.all([loadTvMetadataSettings(), loadTvMetadataMetrics()]);
  } catch (error) {
    status.textContent = `Provider status refresh failed: ${error.message}`;
  } finally {
    button.disabled = false;
  }
});

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  try {
    const login = await api("/api/v1/login", {
      method: "POST",
      body: JSON.stringify({ username: values.get("username"), password: values.get("password") })
    });
    form.elements.namedItem("password").value = "";
    loginDialog.close();
    $("#login-error").textContent = "";
    if (login.passwordChangeRequired) {
      passwordChangeDialog.showModal();
      return;
    }
    await loadSettings();
    await refreshDashboard();
    updateStreams();
  } catch (error) {
    $("#login-error").textContent = error.message;
  }
});

$("#password-change-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  try {
    await api("/api/v1/account/password", {
      method: "POST",
      body: JSON.stringify({ password: values.get("password"), confirmPassword: values.get("confirmPassword") })
    });
    form.reset();
    $("#password-change-error").textContent = "";
    passwordChangeDialog.close();
    await loadSettings();
    await refreshDashboard();
    updateStreams();
  } catch (error) {
    $("#password-change-error").textContent = error.message;
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
