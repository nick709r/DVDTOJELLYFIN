const $ = (selector) => document.querySelector(selector);
const state = { page: "dashboard", metrics: null, statsRange: "7d", metricsStream: null, statusStream: null };
const loginDialog = $("#login-dialog");

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
  document.querySelectorAll("[data-stage]").forEach((element) => {
    element.classList.toggle("active", ["ripping", "converting", "publishing"].includes(status) && element.dataset.stage === status);
  });
}

function renderJobList(target, jobs) {
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
    return `<div class="list-row"><div class="list-title">${title}<span class="list-sub">${escapeHtml(type)} · ${escapeHtml(when)}</span></div><span>${escapeHtml(job.encoder || "—")}</span><span>${size}</span><span class="result ${escapeHtml(job.status)}">${escapeHtml(job.status)}</span></div><div class="list-sub extra">${duration}${job.error ? ` · ${escapeHtml(job.error)}` : ""}</div>`;
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
  $("#total-count").textContent = data.stats.total ?? 0;
  $("#success-count").textContent = data.stats.successful ?? 0;
  $("#failure-count").textContent = data.stats.failures ?? 0;
  $("#average-duration").textContent = formatDuration(data.stats.averageSeconds);
  const lastFinished = ["completed", "failed"].includes(data.state) ? data.recent[0] : null;
  renderJob(data.active || lastFinished, data.state);
  renderJobList($("#recent-list"), data.recent);
  await refreshChart(state.statsRange);
}

async function refreshHistory() {
  const data = await api("/api/v1/history?limit=250");
  renderJobList($("#history-list"), data.jobs);
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
  for (const key of ["moviesDir", "musicDir", "workDir", "opticalDevice", "format", "quality", "preset", "encoder", "logLevel", "lidarrUrl", "lidarrImportDir"]) {
    if (data.settings[key] !== undefined) form.elements.namedItem(key).value = data.settings[key];
  }
  form.elements.namedItem("autoEject").checked = data.settings.autoEject;
  form.elements.namedItem("metadataEnabled").checked = data.settings.metadataEnabled;
  form.elements.namedItem("musicMetadataEnabled").checked = data.settings.musicMetadataEnabled;
  form.elements.namedItem("lidarrEnabled").checked = data.settings.lidarrEnabled;
  $("#lidarr-key-status").textContent = data.settings.lidarrApiKeyConfigured
    ? "A Lidarr API key is saved. It is never displayed."
    : "No Lidarr API key is saved.";
  $("#metadata-key-status").textContent = data.settings.metadataApiKeyConfigured
    ? "A metadata API key is saved. It is never displayed."
    : "No metadata API key is saved; lookup will use the disc label until one is configured.";
  $("#auth-state").textContent = data.settings.adminPasswordConfigured ? "Admin protection enabled" : "Password not configured";
  $("#logout").classList.toggle("hidden", !data.settings.adminPasswordConfigured);
  const encoders = await api("/api/v1/encoders");
  $("#encoder-capability").textContent = encoders.encoders.error
    ? encoders.encoders.error
    : `FFmpeg: ${encoders.encoders.nvidia ? "NVENC listed" : "NVENC unavailable"} · ${encoders.encoders.software ? "libx264 available" : "libx264 unavailable"}. Auto mode tests NVENC and falls back to software.`;
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
    renderJob(active, payload.state);
    if (previous && !active) {
      if (state.page === "dashboard") refreshDashboard().catch((error) => notify(error.message, true));
      if (state.page === "history") refreshHistory().catch((error) => notify(error.message, true));
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
  $("#page-title").textContent = page.charAt(0).toUpperCase() + page.slice(1);
  updateStreams();
  if (page === "dashboard") refreshDashboard().catch((error) => notify(error.message, true));
  if (page === "history") refreshHistory().catch((error) => notify(error.message, true));
  if (page === "settings") loadSettings().catch((error) => notify(error.message, true));
}

document.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", () => showPage(button.dataset.page)));
document.querySelectorAll(".range").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll(".range").forEach((item) => item.classList.toggle("active", item === button));
  refreshChart(button.dataset.range).catch((error) => notify(error.message, true));
}));
$("#refresh-history").addEventListener("click", () => refreshHistory().catch((error) => notify(error.message, true)));
document.addEventListener("visibilitychange", updateStreams);

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
    lidarrEnabled: form.elements.namedItem("lidarrEnabled").checked,
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
      notices.push("DVD ripping is unavailable until MakeMKV is installed; music CD ripping is unaffected.");
    }
    const status = await api("/api/v1/status");
    if (!status.passwordConfigured) {
      $("#auth-state").textContent = "Password not configured";
      notices.push("Admin password is unset. The UI is unauthenticated; keep it on localhost or a trusted LAN and configure a password in Settings.");
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
