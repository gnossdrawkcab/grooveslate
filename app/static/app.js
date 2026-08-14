const state = {
  tracks: [],
  completed: [],
  importResults: [],
  importCapabilities: null,
  importBusy: false,
  session: null,
  browserMode: "completed",
  selected: null,
  job: null,
  pollTimer: null,
  clockTimer: null,
  stemsLoaded: new Set(),
  challengeGenres: null,
  challengeDraw: null,
  challengeHand: null,
  challengeSeen: {},
  challengeDrawSerial: 0,
  selectedChallengeGenre: null,
  activeChallenge: null,
  community: [],
  youtubeResults: [],
  jobActivity: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const isSongPage = window.location.pathname.startsWith("/songs/") || window.location.pathname.startsWith("/jobs/");
document.body.classList.add(isSongPage ? "shared-song" : "home-page");

let pendingInstallPrompt = null;
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  pendingInstallPrompt = event;
  $("#install-app").classList.remove("hidden");
});
window.addEventListener("appinstalled", () => {
  pendingInstallPrompt = null;
  $("#install-app").classList.add("hidden");
});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/service-worker.js").catch(() => {});

const globalActivities = new Map();
let globalActivitySequence = 0;

function renderGlobalActivity() {
  const panel = $("#global-progress");
  const current = [...globalActivities.values()].at(-1);
  panel.classList.toggle("active", Boolean(current));
  if (!current) {
    panel.setAttribute("aria-valuetext", "Idle");
    return;
  }
  const hasPercent = Number.isFinite(current.percent);
  $("#global-progress-label").textContent = current.label;
  $("#global-progress-percent").textContent = hasPercent ? `${Math.round(current.percent)}%` : "";
  $("#global-progress-fill").style.width = hasPercent ? `${Math.max(2, current.percent)}%` : "32%";
  panel.classList.toggle("indeterminate", !hasPercent);
  panel.setAttribute("aria-valuenow", hasPercent ? String(Math.round(current.percent)) : "0");
  panel.setAttribute("aria-valuetext", hasPercent ? `${current.label}, ${Math.round(current.percent)} percent` : `${current.label}, in progress`);
}

function beginActivity(label, percent = null) {
  const token = `activity-${++globalActivitySequence}`;
  globalActivities.set(token, { label, percent });
  renderGlobalActivity();
  return token;
}

function updateActivity(token, label, percent = null) {
  if (!token || !globalActivities.has(token)) return;
  globalActivities.set(token, { label, percent });
  renderGlobalActivity();
}

function endActivity(token) {
  if (!token) return;
  globalActivities.delete(token);
  renderGlobalActivity();
}

function apiActivity(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  if (path.startsWith("/api/imports/search")) return "Searching YouTube…";
  if (path === "/api/challenges/draw") return "Drawing a full-song challenge…";
  if (path === "/api/imports/url") return "Downloading and preparing the song…";
  if (path === "/api/imports/upload") return "Uploading source audio…";
  if (path === "/api/jobs" && method === "POST") return "Queueing GPU separation…";
  if (path.includes("/mix/") && method === "POST") return "Updating the stem mix…";
  if (path.includes("/pitch/") && method === "POST") return "Shifting pitch without changing tempo…";
  if (path.includes("/waveform/")) return "Updating waveform for the selected mix…";
  if (path.includes("/auto-map")) return "Analyzing beats, form, and energy…";
  if (path.includes("/practice/takes") && method === "POST") return "Saving the recorded take…";
  if (path.includes("/practice") && method === "PUT") return "Saving chart and practice settings…";
  if (path.includes("/community") && method !== "GET") return "Updating Community Takes…";
  if (["POST", "PUT", "DELETE"].includes(method)) return "Saving changes…";
  return null;
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  window.setTimeout(() => element.classList.remove("show"), 3200);
}

function formatBytes(bytes) {
  if (!bytes) return "—";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

async function api(path, options) {
  const label = apiActivity(path, options);
  const activity = label ? beginActivity(label) : null;
  try {
    const response = await fetch(path, options);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.detail || `Request failed (${response.status})`);
    }
    return response.json();
  } finally {
    endActivity(activity);
  }
}

function renderTracks() {
  const list = $("#track-list");
  if (!state.tracks.length) {
    list.innerHTML = `<div class="empty-library">No matching audio found. Check the mounted music directory or change your search.</div>`;
    return;
  }
  list.innerHTML = state.tracks.map((track, index) => `
    <button class="track ${state.selected?.id === track.id ? "active" : ""}" data-track-id="${track.id}">
      <span class="track-index">${String(index + 1).padStart(2, "0")}</span>
      <span class="track-copy-mini">
        <strong>${escapeHtml(track.title)}</strong>
        <small>${escapeHtml(track.folder === "." ? "Library root" : track.folder)} · ${formatBytes(track.size)}</small>
      </span>
      <span class="track-ext">${track.extension}</span>
    </button>
  `).join("");
  $$(".track", list).forEach((button) => button.addEventListener("click", () => {
    state.selected = state.tracks.find((track) => track.id === button.dataset.trackId);
    renderTracks();
    renderSelection();
  }));
}

function renderCompleted() {
  const list = $("#track-list");
  $("#completed-summary").textContent = `${state.completed.length} completed track${state.completed.length === 1 ? "" : "s"}`;
  if (!state.completed.length) {
    list.innerHTML = `<div class="empty-library">No completed comparisons yet.</div>`;
    return;
  }
  list.innerHTML = state.completed.map((item, index) => `
    <button class="track ${state.job?.id === item.job_id ? "active" : ""}" data-job-id="${item.job_id}">
      <span class="track-index">${String(index + 1).padStart(2, "0")}</span>
      <span class="track-copy-mini">
        <strong>${escapeHtml(item.track.title)}</strong>
        <small>${escapeHtml(item.track.folder === "." ? "Library root" : item.track.folder)} · ${new Date(item.completed_at).toLocaleDateString()}</small>
      </span>
      <span class="track-ext">READY</span>
    </button>
  `).join("");
  $$(".track", list).forEach((button) => {
    button.addEventListener("click", () => openCompletedJob(button.dataset.jobId));
  });
}

function renderHomePractice() {
  const grid = $("#home-practice-grid");
  const resume = $("#resume-latest");
  const summary = $("#home-library-summary");
  summary.textContent = `${state.completed.length} ready session${state.completed.length === 1 ? "" : "s"} · private to you`;
  if (!state.completed.length) {
    resume.disabled = true;
    $("b", resume).textContent = "Resume latest session";
    grid.innerHTML = `
      <div class="practice-empty">
        <span>♪</span>
        <div><strong>No practice tracks yet</strong><p>Search for a song and GrooveSlate will build your first play-along mix.</p></div>
        <button type="button" id="empty-add-song">Add a song</button>
      </div>`;
    $("#empty-add-song").addEventListener("click", () => openStudio("import"));
    return;
  }
  const latest = state.completed[0];
  resume.disabled = false;
  $("b", resume).textContent = `Resume · ${latest.track.title}`;
  resume.onclick = () => openPracticeSession(latest.job_id);
  grid.innerHTML = state.completed.map((item, index) => {
    const artwork = item.track.thumbnail_url
      ? `<img src="${escapeHtml(item.track.thumbnail_url)}" alt="" loading="lazy" />`
      : `<span class="practice-disc">♪</span>`;
    return `
      <article class="practice-row">
        <span class="practice-number">${String(index + 1).padStart(2, "0")}</span>
        <div class="practice-art">${artwork}</div>
        <div class="practice-tile-copy">
          <h2>${escapeHtml(item.track.title)}</h2>
          <span>${escapeHtml(item.track.folder === "." ? (item.track.source_label || "Library") : item.track.folder)}</span>
        </div>
        <div class="practice-stats">
          <span>${item.practice?.marker_count || 0} MKR</span>
          <span>${item.practice?.take_count || 0} TAKE</span>
          ${item.practice?.has_best_take ? "<strong>★</strong>" : ""}
        </div>
        <audio controls preload="metadata" controlslist="nodownload" src="${escapeHtml(item.audio_url)}"></audio>
        <button class="open-practice" type="button" data-job-id="${item.job_id}">OPEN <span>→</span></button>
      </article>`;
  }).join("");
  $$(".practice-row audio", grid).forEach((audio) => {
    audio.addEventListener("play", () => {
      $$(".practice-row audio", grid).forEach((other) => {
        if (other !== audio) other.pause();
      });
    });
  });
  $$(".open-practice", grid).forEach((button) => {
    button.addEventListener("click", () => openPracticeSession(button.dataset.jobId));
  });
}

function renderCommunity() {
  const list = $("#community-takes");
  $("#community-summary").textContent = `${state.community.length} shared performance${state.community.length === 1 ? "" : "s"} · opt-in only`;
  if (!state.community.length) {
    list.innerHTML = '<div class="community-empty">Record a take, then choose “Publish” to share it here. Private takes stay private.</div>';
    return;
  }
  list.innerHTML = state.community.map((take) => `
    <article class="community-take">
      <div class="community-person"><span>${escapeHtml(take.owner.slice(0, 1).toUpperCase())}</span><div><strong>${escapeHtml(take.owner)}</strong><small>${new Date(take.published_at).toLocaleDateString()}</small></div></div>
      <div class="community-song"><strong>${escapeHtml(take.song_title)}</strong><small>${escapeHtml(take.song_artist || "GrooveSlate performance")} · ${escapeHtml(take.take_name)}</small></div>
      ${String(take.mime_type || "").startsWith("video/")
        ? `<video controls playsinline preload="metadata" src="${escapeHtml(take.audio_url)}"></video>`
        : `<audio controls preload="metadata" src="${escapeHtml(take.audio_url)}"></audio>`}
      <div class="groove-score"><span>${take.score ?? "—"}</span><small>GROOVE · ${take.score_count} VOTE${take.score_count === 1 ? "" : "S"}</small></div>
      ${take.owned ? `<button class="unpublish-take" data-unpublish="${take.id}" type="button">Unpublish</button>` : `<div class="score-buttons" aria-label="Score ${escapeHtml(take.owner)}'s take">${[1,2,3,4,5].map((score) => `<button class="${take.your_score === score ? "active" : ""}" data-score-publication="${take.id}" data-score="${score}" type="button" title="${score} out of 5">${score}</button>`).join("")}</div>`}
    </article>`).join("");
  $$(".community-take audio, .community-take video", list).forEach((media) => media.addEventListener("play", () => {
    $$("audio, video").forEach((other) => { if (other !== media) other.pause(); });
  }));
  $$('[data-score-publication]', list).forEach((button) => button.addEventListener("click", () => scoreCommunityTake(button.dataset.scorePublication, Number(button.dataset.score))));
  $$('[data-unpublish]', list).forEach((button) => button.addEventListener("click", () => unpublishCommunityTake(button.dataset.unpublish)));
}

async function loadCommunity() {
  try {
    state.community = (await api("/api/community")).takes;
    renderCommunity();
  } catch (error) { $("#community-summary").textContent = error.message; }
}

async function scoreCommunityTake(id, score) {
  try {
    await api(`/api/community/${id}/score`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ score }) });
    await loadCommunity(); toast(`Groove score saved: ${score}/5`);
  } catch (error) { toast(error.message); }
}

async function unpublishCommunityTake(id) {
  if (!window.confirm("Remove this take from Community Takes? Your private recording will remain saved.")) return;
  try {
    await api(`/api/community/${id}`, { method: "DELETE" });
    await loadCommunity(); toast("Take is private again");
  } catch (error) { toast(error.message); }
}

function renderYoutubeHome() {
  const list = $("#youtube-home-results");
  if (!state.youtubeResults.length) {
    list.innerHTML = "<p>No results yet. Search by song, artist, or a specific live version.</p>";
    return;
  }
  list.innerHTML = state.youtubeResults.map((item) => `
    <article class="youtube-result">
      <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener" title="Preview on YouTube"><img src="${escapeHtml(item.thumbnail_url)}" alt="" loading="lazy" /><i>▶</i></a>
      <div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.channel)} · ${formatDuration(item.duration)}</small></div>
      <button type="button" data-youtube-prepare="${escapeHtml(item.url)}" data-youtube-title="${escapeHtml(item.title)}">Prepare drumless →</button>
    </article>`).join("");
  $$('[data-youtube-prepare]', list).forEach((button) => button.addEventListener("click", () => {
    openStudio("import");
    importURL(button.dataset.youtubePrepare, button.dataset.youtubeTitle);
  }));
}

async function searchYoutubeHome(event) {
  event.preventDefault();
  const query = $("#youtube-home-query").value.trim();
  if (!query) return;
  const button = $("#youtube-home-search button");
  button.disabled = true; button.textContent = "Searching…";
  $("#youtube-home-results").innerHTML = "<p>Searching YouTube…</p>";
  try {
    state.youtubeResults = (await api(`/api/imports/search?q=${encodeURIComponent(query)}&limit=8`)).results;
    renderYoutubeHome();
  } catch (error) {
    $("#youtube-home-results").innerHTML = `<p>${escapeHtml(error.message)}</p>`;
  } finally { button.disabled = false; button.textContent = "Search YouTube"; }
}

function renderActiveChallenge() {
  const banner = $("#active-challenge");
  const active = state.activeChallenge;
  const matches = active && state.job?.track?.id === active.track.id;
  banner.classList.toggle("hidden", !matches);
  if (!matches) return;
  $("#active-challenge-title").textContent = active.challenge.title;
  $("#active-challenge-copy").textContent = active.challenge.instruction;
}

function updateChallengeProgress(session) {
  const active = state.activeChallenge;
  if (!active || state.job?.track?.id !== active.track.id) return;
  const takes = session?.takes || [];
  const markers = session?.markers || [];
  const scores = takes.map((take) => take.analysis?.pocket_score).filter(Number.isFinite);
  const ranges = takes.map((take) => take.analysis?.velocity?.dynamic_range).filter(Number.isFinite);
  let progress = "Challenge in progress";
  let complete = false;
  if (active.challenge.kind === "pocket") {
    complete = markers.length >= 4 && Math.max(-1, ...scores) >= active.challenge.target;
    progress = `${Math.min(markers.length, 4)}/4 sections · best Pocket ${Math.max(0, ...scores)}/${active.challenge.target}`;
  } else if (active.challenge.kind === "improve") {
    complete = scores.length >= 2 && scores[0] > scores[1];
    progress = `${Math.min(takes.length, 2)}/2 takes${scores.length >= 2 ? ` · ${scores[0] - scores[1] >= 0 ? "+" : ""}${scores[0] - scores[1]} Pocket` : ""}`;
  } else if (active.challenge.kind === "dynamics") {
    complete = Math.max(0, ...ranges) >= active.challenge.target;
    progress = `Best dynamic range ${Math.max(0, ...ranges)}/${active.challenge.target}`;
  } else if (active.challenge.kind === "one-take") {
    complete = takes.length >= 1;
    progress = `${Math.min(takes.length, 1)}/1 committed take`;
  } else if (active.challenge.kind === "deep-chart") {
    complete = markers.length >= active.challenge.target && takes.length >= 1;
    progress = `${Math.min(markers.length, active.challenge.target)}/${active.challenge.target} markers · ${takes.length ? "take recorded" : "take needed"}`;
  }
  const label = $("#active-challenge-progress");
  label.textContent = complete ? `✓ CHALLENGE COMPLETE · ${progress}` : progress;
  label.classList.toggle("complete", complete);
}

async function loadChallengeGenres() {
  if (!state.challengeGenres) state.challengeGenres = await api("/api/challenges/genres");
  renderChallengeGenres();
}

function renderChallengeGenres() {
  const readyOnly = $("#challenge-pool").value === "ready";
  const genres = readyOnly ? state.challengeGenres?.ready_genres : state.challengeGenres?.genres;
  const grid = $("#challenge-genres");
  if (!genres) return;
  grid.innerHTML = genres.map((genre) => `
    <button type="button" data-challenge-genre="${genre.id}" class="${state.selectedChallengeGenre === genre.id ? "active" : ""}" aria-pressed="${state.selectedChallengeGenre === genre.id}" ${genre.count === 0 ? "disabled" : ""}>
      <span>${escapeHtml(genre.label)}</span><b>${genre.count == null ? (state.selectedChallengeGenre === genre.id ? "✓" : "CHOOSE") : genre.count.toLocaleString()}</b>
    </button>`).join("");
  $$('[data-challenge-genre]', grid).forEach((button) => button.addEventListener("click", () => selectChallengeGenre(button.dataset.challengeGenre)));
  const selected = state.challengeGenres?.genres.find((genre) => genre.id === state.selectedChallengeGenre);
  $("#selected-genre-name").textContent = selected ? selected.label : "No genre selected";
  $("#draw-selected-genre").disabled = !selected;
}

function selectChallengeGenre(genre) {
  state.selectedChallengeGenre = genre;
  state.challengeDraw = null;
  state.challengeHand = null;
  $("#challenge-card").classList.add("hidden");
  $(".genre-choice").classList.remove("hidden");
  renderChallengeGenres();
}

async function drawChallenge(genre) {
  const serial = ++state.challengeDrawSerial;
  state.selectedChallengeGenre = genre;
  renderChallengeGenres();
  $$('[data-challenge-genre]').forEach((button) => { button.disabled = true; });
  $("#draw-selected-genre").disabled = true;
  $("#surprise-challenge").disabled = true;
  $("#redraw-challenge").disabled = true;
  $("#accept-challenge").disabled = true;
  $("#challenge-card").classList.add("loading");
  const priorRerollLabel = $("#redraw-challenge").textContent;
  $("#redraw-challenge").textContent = "Dealing 5…";
  try {
    const hand = await api("/api/challenges/draw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        genre,
        ready_only: $("#challenge-pool").value === "ready",
        exclude: state.challengeSeen[genre] || [],
      }),
    });
    if (serial !== state.challengeDrawSerial) return;
    state.challengeHand = hand;
    const seen = new Set(state.challengeSeen[genre] || []);
    state.challengeHand.options.forEach((option) => {
      if (option.shuffle_key) seen.add(option.shuffle_key);
    });
    state.challengeSeen[genre] = [...seen].slice(-200);
    const selected = state.challengeGenres.genres.find((item) => item.id === genre);
    state.challengeDraw = null;
    $("#challenge-genre").textContent = `${selected?.label || genre} · PICK 1 OF ${state.challengeHand.options.length}`;
    $("#challenge-song-title").textContent = "Choose your song";
    $("#challenge-song-meta").textContent = "Balanced studio picks · familiar, discovery, and deep cuts";
    $("#challenge-kind").textContent = state.challengeHand.challenge.kind.replaceAll("-", " ").toUpperCase();
    $("#challenge-rule-title").textContent = state.challengeHand.challenge.title;
    $("#challenge-rule-copy").textContent = state.challengeHand.challenge.instruction;
    $("#challenge-hand").innerHTML = state.challengeHand.options.map((option, index) => `
      <button type="button" data-challenge-option="${index}">
        <span>${escapeHtml(option.track.title)}</span>
        <small>${escapeHtml(option.track.artist || "Unknown artist")} · ${(option.selection_lane || "library pick").replace("-", " ").toUpperCase()}${option.studio_only ? " · STUDIO" : ""}</small>
        <b>CHOOSE</b>
      </button>`).join("");
    $$('[data-challenge-option]', $("#challenge-hand")).forEach((button) => button.addEventListener("click", () => {
      const option = state.challengeHand.options[Number(button.dataset.challengeOption)];
      state.challengeDraw = { ...option, challenge: state.challengeHand.challenge, genre };
      $$('[data-challenge-option]', $("#challenge-hand")).forEach((item) => {
        const active = item === button;
        item.classList.toggle("active", active);
        $("b", item).textContent = active ? "✓ SELECTED" : "CHOOSE";
      });
      $("#challenge-song-title").textContent = option.track.title;
      $("#challenge-song-meta").textContent = `${option.track.artist || "Unknown artist"} · ${(option.selection_lane || "library pick").replace("-", " ").toUpperCase()}${option.studio_only ? " · STUDIO VERSION" : ""}`;
      $("#accept-challenge").disabled = false;
    }));
    $("#challenge-card").classList.remove("hidden");
    $(".genre-choice").classList.add("hidden");
    $("#redraw-challenge").dataset.genre = genre;
    $("#redraw-challenge").textContent = "↻ Reroll 5";
    $("#accept-challenge").disabled = true;
  } catch (error) {
    if (serial === state.challengeDrawSerial) {
      $("#redraw-challenge").textContent = priorRerollLabel;
      toast(error.message);
    }
  } finally {
    if (serial === state.challengeDrawSerial) {
      $("#challenge-card").classList.remove("loading");
      $("#surprise-challenge").disabled = false;
      $("#redraw-challenge").disabled = false;
      renderChallengeGenres();
    }
  }
}

async function acceptChallenge() {
  const draw = state.challengeDraw;
  if (!draw) return;
  if (draw.ready_job_id) {
    state.activeChallenge = draw;
    try { sessionStorage.setItem("grooveslate-challenge", JSON.stringify(draw)); } catch {}
    $("#challenge-drawer").classList.add("hidden");
    await openPracticeSession(draw.ready_job_id);
    toast("Challenge accepted — go earn it");
    return;
  }
  if (draw.youtube_url) {
    const accept = $("#accept-challenge");
    const originalLabel = accept.textContent;
    accept.disabled = true;
    accept.textContent = "Preparing song…";
    $("#redraw-challenge").disabled = true;
    $("#challenge-song-meta").textContent = "DOWNLOADING FULL SONG · THEN REMOVING DRUMS";
    try {
      const imported = await importURL(draw.youtube_url, draw.track.title);
      if (!imported) {
        $("#challenge-song-meta").textContent = `${draw.track.artist || "YouTube"} · READY WHEN YOU ARE`;
        return;
      }
      draw.track = imported;
      state.activeChallenge = draw;
      try { sessionStorage.setItem("grooveslate-challenge", JSON.stringify(draw)); } catch {}
      renderActiveChallenge();
      $("#challenge-drawer").classList.add("hidden");
      toast("Challenge accepted — separation is underway");
    } finally {
      accept.disabled = false;
      accept.textContent = originalLabel;
      $("#redraw-challenge").disabled = false;
    }
    return;
  }
  state.activeChallenge = draw;
  try { sessionStorage.setItem("grooveslate-challenge", JSON.stringify(draw)); } catch {}
  renderActiveChallenge();
  $("#challenge-drawer").classList.add("hidden");
  state.selected = draw.track;
  renderSelection();
  document.body.classList.add("studio-open");
  $("#studio").scrollIntoView({ behavior: "smooth", block: "start" });
  await startJob();
  toast("Challenge accepted — your drumless mix is being prepared");
}

async function openPracticeSession(jobId) {
  await openCompletedJob(jobId);
  document.body.classList.add("studio-open");
  $("#studio").scrollIntoView({ behavior: "smooth", block: "start" });
}

function formatDuration(seconds) {
  if (!seconds) return "Unknown length";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function renderImportResults() {
  const list = $("#track-list");
  if (!state.importResults.length) {
    list.innerHTML = `<div class="empty-library">${state.session?.source_mode === "youtube" ? "Search YouTube, then choose a permitted song to prepare for practice." : "Search your server library first, then YouTube. Select a result to add it to your practice list."}</div>`;
    return;
  }
  let previousKind = "";
  list.innerHTML = state.importResults.map((item) => {
    const heading = item.kind !== previousKind
      ? `<div class="search-source-heading">${item.kind === "library" ? "YOUR MUSIC LIBRARY" : "YOUTUBE"}</div>`
      : "";
    previousKind = item.kind;
    if (item.kind === "library") {
      const ready = state.completed.find((entry) => entry.track.id === item.track.id);
      return `${heading}
        <button class="track" data-library-result="${item.track.id}">
          <span class="track-index">♫</span>
          <span class="track-copy-mini">
            <strong>${escapeHtml(item.track.title)}</strong>
            <small>${escapeHtml(item.track.folder === "." ? "Library root" : item.track.folder)}</small>
          </span>
          <span class="track-ext">${ready ? "READY" : "LIBRARY"}</span>
        </button>`;
    }
    return `${heading}
      <button class="track" data-import-url="${escapeHtml(item.url)}" data-import-title="${escapeHtml(item.title)}">
        <img class="track-thumbnail" src="${escapeHtml(item.thumbnail_url)}" alt="" loading="lazy" />
        <span class="track-copy-mini">
          <strong>${escapeHtml(item.title)}</strong>
          <small>${escapeHtml(item.channel)} · ${formatDuration(item.duration)}</small>
        </span>
        <span class="track-ext">YOUTUBE</span>
      </button>`;
  }).join("");
  $$('[data-library-result]', list).forEach((button) => {
    button.addEventListener("click", async () => {
      const item = state.importResults.find((result) => result.kind === "library" && result.track.id === button.dataset.libraryResult);
      const ready = state.completed.find((entry) => entry.track.id === button.dataset.libraryResult);
      if (ready) return openCompletedJob(ready.job_id);
      state.selected = item.track;
      renderSelection();
      toast("Library track selected. Starting RoFormer…");
      await startJob();
    });
  });
  $$("[data-import-url]", list).forEach((button) => {
    button.addEventListener("click", () => importURL(button.dataset.importUrl, button.dataset.importTitle));
  });
}

function setBrowserMode(mode) {
  state.browserMode = mode;
  $$(".browser-tabs button").forEach((button) => {
    button.classList.toggle("active", button.dataset.browser === mode);
  });
  $("#library-filters").classList.toggle("hidden", mode !== "library");
  $("#completed-summary").classList.toggle("hidden", mode !== "completed");
  $("#import-panel").classList.toggle("hidden", mode !== "import");
  $("#refresh-button").title = mode === "library" ? "Rescan library" : mode === "completed" ? "Refresh completed tracks" : "Refresh import options";
  if (mode === "library") renderTracks();
  else if (mode === "completed") renderCompleted();
  else renderImportResults();
}

function escapeHtml(value) {
  const node = document.createElement("div");
  node.textContent = value;
  return node.innerHTML;
}

function renderSelection() {
  const track = state.selected;
  const sameJob = Boolean(track && state.job?.track?.id === track.id);
  const processing = ["queued", "processing"].includes(state.job?.status);
  const ready = sameJob && state.job?.status === "complete";
  $("#selected-title").textContent = track ? track.title : "Choose a track to begin";
  $("#selected-path").textContent = track
    ? [track.artist, track.relative_path].filter(Boolean).join(" · ")
    : "Search, upload, or browse your private library.";
  $("#run-button").disabled = !track || processing || ready;
  $("#run-button span").textContent = processing && sameJob
    ? "Processing…"
    : ready
      ? "Ready to practice"
      : "Run RoFormer";
  $("#share-button").disabled = !sameJob;
}

async function loadLibrary(refresh = false) {
  const params = new URLSearchParams({
    q: $("#search-input").value,
    folder: $("#folder-select").value,
  });
  if (refresh) params.set("refresh", "true");
  try {
    const data = await api(`/api/library?${params}`);
    state.tracks = data.tracks;
    $("#track-count").textContent = `${data.total.toLocaleString()} track${data.total === 1 ? "" : "s"}`;
    if (!$("#folder-select").dataset.ready) {
      $("#folder-select").insertAdjacentHTML(
        "beforeend",
        data.folders.map((folder) => `<option value="${escapeHtml(folder)}">${escapeHtml(folder)}</option>`).join("")
      );
      $("#folder-select").dataset.ready = "true";
    }
    if (state.browserMode === "library") renderTracks();
    if (refresh) toast("Music library rescanned");
  } catch (error) {
    if (state.browserMode === "library") {
      $("#track-list").innerHTML = `<div class="empty-library">${escapeHtml(error.message)}</div>`;
    }
    $("#gpu-state").textContent = "OFFLINE";
  }
}

async function loadCompleted() {
  try {
    const data = await api("/api/completed?limit=500");
    state.completed = data.completed;
    renderHomePractice();
    if (state.browserMode === "completed") renderCompleted();
  } catch (error) {
    $("#completed-summary").textContent = error.message;
  }
}

async function loadSession() {
  try {
    state.session = await api("/api/session");
    $("#current-user-chip").textContent = state.session.role === "admin"
      ? `${state.session.user} · Admin`
      : state.session.user;
    $("#current-user-name").textContent = `${state.session.user}’s`;
    if (state.session.demo) {
      document.body.classList.add("public-demo");
      $("#challenge-drawer").classList.add("hidden");
      $("#home-title").textContent = "GrooveSlate demo";
      $("#home-intro").textContent = "Explore the synchronized mix, chart, tabs, guided drills, and recording studio.";
    } else if (state.session.source_mode === "youtube") {
      document.body.classList.add("youtube-only");
      $$('[data-library-only]').forEach((element) => element.classList.add("hidden"));
      $("#challenge-source-copy").textContent = "Balanced between familiar songs, discoveries, and deep cuts in your chosen genre. Studio recordings only.";
      $("#challenge-pool").innerHTML = '<option value="all">YouTube song</option>';
      $("#home-song-search-input").placeholder = "Find a song on YouTube";
      $("#provider-search-input").placeholder = "Search YouTube";
      $("#selected-path").textContent = "Search YouTube or paste a permitted video URL.";
      $("#source-footer").textContent = "YOUTUBE DISCOVERY · PRIVATE PRACTICE WORKSPACE";
      $("#home-title").textContent = "Take the challenge";
      $("#home-intro").textContent = "Draw an unfamiliar song, chart the form, and record your best drum take.";
      $("#challenge-drawer").classList.remove("hidden");
      $("#close-challenge").classList.add("hidden");
      loadChallengeGenres().catch((error) => toast(error.message));
    }
  } catch {
    // The authentication middleware handles expired sessions.
  }
}

function resetCards() {
  endActivity(state.jobActivity);
  state.jobActivity = null;
  document.dispatchEvent(new CustomEvent("drumless:clear-job"));
  $$(".model-card").forEach((card) => {
    card.classList.remove("ready");
    $(".model-status", card).textContent = "WAITING";
    $(".model-time", card).textContent = "— processing time";
    $(".phase-name", card).textContent = "Waiting";
    $(".phase-percent", card).textContent = "0%";
    $(".phase-rail i", card).style.width = "0%";
    $(".phase-detail", card).textContent = "Queued until processing starts";
    const audio = $("audio", card);
    audio.removeAttribute("src");
    audio.load();
    resetPracticePlayer(card);
    const download = $(".download", card);
    download.classList.add("disabled");
    download.removeAttribute("href");
    const copyLink = $(".copy-link", card);
    copyLink.disabled = true;
    copyLink.removeAttribute("data-url");
    copyLink.onclick = null;
    $(".stem-buttons", card).innerHTML = "<i>Available after separation</i>";
    $(".mix-presets", card).innerHTML = "<i>Available after separation</i>";
    $(".build-mix", card).disabled = true;
  });
  $("#empty-note").classList.remove("hidden");
  $("#sync-play").disabled = true;
  $("#sync-stop").disabled = true;
}

async function startJob() {
  if (!state.selected) return;
  resetCards();
  $("#run-button").disabled = true;
  $("#job-progress").classList.remove("hidden");
  try {
    state.job = await api("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ track_id: state.selected.id }),
    });
    renderActiveChallenge();
    setJobUrl(state.job);
    updateJobView(state.job);
    pollJob(state.job.id);
  } catch (error) {
    toast(error.message);
    renderSelection();
  }
}

function setImportBusy(busy, message = "") {
  state.importBusy = busy;
  $$("#import-panel button, #import-panel input").forEach((control) => {
    control.disabled = busy;
  });
  if (message) $("#import-status").textContent = message;
}

async function loadImportCapabilities() {
  try {
    state.importCapabilities = await api("/api/imports/capabilities");
    $("#import-status").textContent = state.importCapabilities.youtube_only
      ? "Search YouTube or paste a YouTube link you have permission to use."
      : state.importCapabilities.media_extractor
      ? "Library matches appear first, followed by YouTube."
      : "Library search is ready. YouTube search is disabled.";
    if (state.browserMode === "import") renderImportResults();
  } catch (error) {
    $("#import-status").textContent = error.message;
  }
}

async function searchProvider(event) {
  event.preventDefault();
  const query = $("#provider-search-input").value.trim();
  if (!query || state.importBusy) return;
  setImportBusy(true, state.session?.source_mode === "youtube" ? "Searching YouTube…" : "Searching your library…");
  state.importResults = [];
  try {
    if (state.session?.source_mode === "youtube") {
      const youtubeOnlyResults = await api(`/api/imports/search?q=${encodeURIComponent(query)}&limit=20`);
      state.importResults = youtubeOnlyResults.results.map((item) => ({ ...item, kind: "youtube" }));
      renderImportResults();
      $("#import-status").textContent = `${youtubeOnlyResults.results.length} YouTube result${youtubeOnlyResults.results.length === 1 ? "" : "s"}.`;
      return;
    }
    const local = await api(`/api/library?q=${encodeURIComponent(query)}&limit=20`);
    state.importResults = local.tracks.map((track) => ({ kind: "library", track }));
    renderImportResults();
    $("#import-status").textContent = state.importCapabilities?.media_extractor
      ? `${local.tracks.length} library match${local.tracks.length === 1 ? "" : "es"}. Searching YouTube…`
      : `${local.tracks.length} library match${local.tracks.length === 1 ? "" : "es"}.`;
    if (state.importCapabilities?.media_extractor) {
      const remote = await api(`/api/imports/search?q=${encodeURIComponent(query)}&limit=10`);
      state.importResults.push(...remote.results.map((item) => ({ ...item, kind: "youtube" })));
      renderImportResults();
      $("#import-status").textContent = `${local.tracks.length} library · ${remote.results.length} YouTube result${remote.results.length === 1 ? "" : "s"}.`;
    }
  } catch (error) {
    toast(error.message);
    $("#import-status").textContent = error.message;
  } finally {
    setImportBusy(false);
  }
}

async function importURL(url, title = "") {
  if (!url || state.importBusy) return;
  const youtubeOnly = state.session?.source_mode === "youtube";
  if (youtubeOnly && !window.confirm("I confirm I own this song or have permission to download and use it for private practice.")) return;
  setImportBusy(true, "Importing audio… Keep this page open until processing is queued.");
  try {
    const data = await api("/api/imports/url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        title,
        rights_confirmed: youtubeOnly,
      }),
    });
    state.selected = data.track;
    if (!state.tracks.some((track) => track.id === data.track.id)) state.tracks.unshift(data.track);
    renderSelection();
    toast("Audio imported. Starting RoFormer…");
    await startJob();
    return data.track;
  } catch (error) {
    toast(error.message);
    $("#import-status").textContent = error.message;
  } finally {
    setImportBusy(false);
  }
}

async function uploadAudio(file) {
  if (!file || state.importBusy) return;
  const form = new FormData();
  form.append("file", file);
  setImportBusy(true, `Uploading ${file.name}…`);
  try {
    const data = await api("/api/imports/upload", { method: "POST", body: form });
    state.selected = data.track;
    if (!state.tracks.some((track) => track.id === data.track.id)) state.tracks.unshift(data.track);
    renderSelection();
    toast("Upload complete. Starting RoFormer…");
    await startJob();
  } catch (error) {
    toast(error.message);
    $("#import-status").textContent = error.message;
  } finally {
    $("#audio-upload").value = "";
    setImportBusy(false);
  }
}

function updateJobView(job) {
  state.job = job;
  if (!["complete", "failed"].includes(job.status)) {
    if (!state.jobActivity) state.jobActivity = beginActivity(job.stage || "Separating song…", job.progress || 0);
    updateActivity(state.jobActivity, job.stage || "Separating song…", job.progress || 0);
  } else {
    endActivity(state.jobActivity);
    state.jobActivity = null;
  }
  $("#job-stage").textContent = job.stage;
  $("#job-percent").textContent = `${job.progress}%`;
  $("#progress-fill").style.width = `${job.progress}%`;
  renderElapsed(job);
  window.clearInterval(state.clockTimer);
  if (!["complete", "failed"].includes(job.status)) {
    state.clockTimer = window.setInterval(() => renderElapsed(state.job), 1000);
  }
  const activity = job.activity || [];
  $("#activity-log").innerHTML = activity.slice(-5).reverse().map((event) => {
    const time = new Date(event.at).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const label = event.model ? event.model.replace("roformer", "RoFormer") : "System";
    return `<li><span>${time}</span><span>${label}</span><span>${escapeHtml(event.message)}</span></li>`;
  }).join("");

  Object.entries(job.models).forEach(([key, model]) => {
    const card = $(`.model-card[data-model="${key}"]`);
    if (!card) return;
    $(".model-status", card).textContent = model.status.toUpperCase();
    $(".phase-name", card).textContent = model.phase || model.status;
    $(".phase-percent", card).textContent = `${model.progress || 0}%`;
    $(".phase-rail i", card).style.width = `${model.progress || 0}%`;
    $(".phase-detail", card).textContent = model.detail || fallbackDetail(model);
    if (model.status === "complete") {
      card.classList.add("ready");
      const audio = $("audio", card);
      const sourceUrl = `${model.audio_url}?v=${encodeURIComponent(job.updated_at)}`;
      audio.src = sourceUrl;
      card.dataset.baseAudioUrl = sourceUrl;
      card.dataset.mixId = "";
      card.dataset.excluded = "drums";
      const download = $(".download", card);
      download.href = model.download_url;
      download.classList.remove("disabled");
      const slug = shareSlug(job.track);
      setCopyLink(card, `/songs/${slug}/audio/${key}`);
      download.href = `/songs/${slug}/download/${key}`;
      $(".model-time", card).textContent = `${model.elapsed_seconds}s processing time`;
      loadStems(job.id, key, card);
    } else if (model.status === "failed") {
      $(".model-time", card).textContent = "Model failed — see status";
    }
  });

  const readyAudio = $$(".model-card.ready audio");
  $("#empty-note").classList.toggle("hidden", readyAudio.length > 0);
  $("#sync-play").disabled = readyAudio.length < 2;
  $("#sync-stop").disabled = readyAudio.length === 0;

  if (["complete", "failed"].includes(job.status)) {
    window.clearTimeout(state.pollTimer);
    renderSelection();
    if (job.status === "complete") loadCompleted();
    if (job.error) toast(job.error);
  }
  if (job.status === "complete" && job.models?.roformer?.status === "complete") {
    document.dispatchEvent(new CustomEvent("drumless:practice-job", { detail: job }));
  }
}

async function loadStems(jobId, model, card) {
  const cacheKey = `${jobId}:${model}`;
  if (state.stemsLoaded.has(cacheKey)) return;
  state.stemsLoaded.add(cacheKey);
  try {
    const { stems } = await api(`/api/jobs/${jobId}/stems/${model}`);
    const available = new Set(stems.map((stem) => stem.name));
    const container = $(".stem-buttons", card);
    container.innerHTML = stems.map((stem) => `
      <div class="stem-channel" data-stem="${escapeHtml(stem.name)}">
        <span>${escapeHtml(stem.name)}</span>
        <div role="group" aria-label="${escapeHtml(stem.name)} channel controls">
          <button class="stem-toggle ${stem.name === "drums" ? "removed" : ""}" data-stem="${escapeHtml(stem.name)}" aria-label="Mute ${escapeHtml(stem.name)}" aria-pressed="${stem.name === "drums"}">Mute</button>
          <button class="solo-toggle" data-stem="${escapeHtml(stem.name)}" aria-label="Solo ${escapeHtml(stem.name)}" aria-pressed="false">Solo</button>
        </div>
      </div>
    `).join("");
    $$(".stem-toggle", container).forEach((button) => {
      button.addEventListener("click", () => {
        button.classList.toggle("removed");
        button.setAttribute("aria-pressed", String(button.classList.contains("removed")));
        if (button.classList.contains("removed")) {
          const solo = $(`.solo-toggle[data-stem="${button.dataset.stem}"]`, card);
          solo.classList.remove("active");
          solo.setAttribute("aria-pressed", "false");
        }
        syncMixPreset(card);
        syncMixUrl(card);
        scheduleCustomMix(jobId, model, card);
      });
    });
    $$(".solo-toggle", container).forEach((button) => {
      button.addEventListener("click", () => {
        button.classList.toggle("active");
        button.setAttribute("aria-pressed", String(button.classList.contains("active")));
        if (button.classList.contains("active")) {
          const mute = $(`.stem-toggle[data-stem="${button.dataset.stem}"]`, card);
          mute.classList.remove("removed");
          mute.setAttribute("aria-pressed", "false");
        }
        syncMixPreset(card);
        syncMixUrl(card);
        scheduleCustomMix(jobId, model, card);
      });
    });
    const presets = $(".mix-presets", card);
    presets.innerHTML = '<button type="button" class="reset-mix">Reset mixer</button>';
    $(".reset-mix", presets).addEventListener("click", () => {
      $$(".stem-toggle", card).forEach((stemButton) => {
        stemButton.classList.remove("removed");
        stemButton.setAttribute("aria-pressed", "false");
      });
      $$(".solo-toggle", card).forEach((soloButton) => {
        soloButton.classList.remove("active");
        soloButton.setAttribute("aria-pressed", "false");
      });
      syncMixPreset(card);
      syncMixUrl(card);
      scheduleCustomMix(jobId, model, card);
    });
    const linkedMix = linkedMixState(available);
    if (linkedMix !== null) {
      $$(".stem-toggle", card).forEach((stemButton) => {
        stemButton.classList.toggle("removed", linkedMix.muted.has(stemButton.dataset.stem));
        stemButton.setAttribute("aria-pressed", String(stemButton.classList.contains("removed")));
      });
      $$(".solo-toggle", card).forEach((soloButton) => {
        soloButton.classList.toggle("active", linkedMix.soloed.has(soloButton.dataset.stem));
        soloButton.setAttribute("aria-pressed", String(soloButton.classList.contains("active")));
      });
    }
    syncMixPreset(card);
    syncMixUrl(card);
    setMixStatus(card, "Mix ready");
    const build = $(".build-mix", card);
    build.disabled = false;
    build.onclick = () => buildCustomMix(jobId, model, card);
    const excluded = currentMixState(card).excluded;
    if (linkedMix !== null && excluded.join(",") !== "drums") {
      await buildCustomMix(jobId, model, card);
    }
  } catch (error) {
    state.stemsLoaded.delete(cacheKey);
    $(".stem-buttons", card).innerHTML = `<i>${escapeHtml(error.message)}</i>`;
  }
}

function syncMixPreset(card) {
  const { muted, soloed } = currentMixState(card);
  const reset = $(".reset-mix", card);
  if (reset) reset.disabled = !muted.length && !soloed.length;
}

function linkedMixState(available) {
  const params = new URLSearchParams(window.location.search);
  if (!params.has("remove") && !params.has("solo")) return null;
  const parse = (name) => {
    const value = (params.get(name) || "").trim().toLowerCase();
    if (!value || value === "none") return new Set();
    return new Set(value.split(",").map((stem) => stem.trim()).filter((stem) => available.has(stem)));
  };
  return { muted: parse("remove"), soloed: parse("solo") };
}

function currentMixState(card) {
  const muted = $$(".stem-toggle.removed", card).map((button) => button.dataset.stem).sort();
  const soloed = $$(".solo-toggle.active", card).map((button) => button.dataset.stem).sort();
  const mutedSet = new Set(muted);
  const soloedSet = new Set(soloed);
  const excluded = $$(".stem-channel", card)
    .map((channel) => channel.dataset.stem)
    .filter((stem) => mutedSet.has(stem) || (soloed.length && !soloedSet.has(stem)))
    .sort();
  return { muted, soloed, excluded };
}

function muteStemForScorePart(label) {
  const card = $(".model-card[data-model='roformer']");
  const value = String(label || "").toLowerCase();
  const candidates = value.includes("drum") || value.includes("percussion")
    ? ["drums"]
    : value.includes("bass") ? ["bass"]
    : value.includes("vocal") || value.includes("voice") ? ["vocals"]
    : value.includes("guitar") ? ["guitar", "other"]
    : value.includes("piano") || value.includes("key") || value.includes("synth") || value.includes("organ")
      ? ["piano", "keys", "other"] : ["other"];
  const button = candidates.map((stem) => $(`.stem-toggle[data-stem="${stem}"]`, card)).find(Boolean);
  if (!button) return false;
  $$(".solo-toggle.active", card).forEach((solo) => solo.click());
  if (!button.classList.contains("removed")) button.click();
  return button.dataset.stem;
}

function syncMixUrl(card) {
  if (!state.job || !window.location.pathname.startsWith("/songs/")) return;
  const { muted, soloed } = currentMixState(card);
  const url = new URL(window.location.href);
  url.searchParams.set("remove", muted.length ? muted.join(",") : "none");
  if (soloed.length) url.searchParams.set("solo", soloed.join(","));
  else url.searchParams.delete("solo");
  window.history.replaceState({ jobId: state.job.id }, "", `${url.pathname}${url.search}${url.hash}`);
}

function syncPracticeUrl(card) {
  if (!state.job || !window.location.pathname.startsWith("/songs/")) return;
  const url = new URL(window.location.href);
  if (Number.isFinite(card._loopStart) && Number.isFinite(card._loopEnd)) {
    url.searchParams.set("loop", `${card._loopStart.toFixed(2)}-${card._loopEnd.toFixed(2)}`);
  } else {
    url.searchParams.delete("loop");
  }
  const speed = Number($(".speed-select", card)?.value || $("audio", card)?.playbackRate || 1);
  if (Math.abs(speed - 1) > 0.001) url.searchParams.set("speed", String(speed));
  else url.searchParams.delete("speed");
  const pitch = Number($(".pitch-select", card)?.value || 0);
  if (pitch) url.searchParams.set("pitch", String(pitch));
  else url.searchParams.delete("pitch");
  window.history.replaceState({ jobId: state.job.id }, "", `${url.pathname}${url.search}${url.hash}`);
}

function selectPlaybackRate(rate, { announce = false } = {}) {
  const card = $(".model-card[data-model='roformer']");
  const audio = $("audio", card);
  const select = $(".speed-select", card);
  const value = Math.max(0.5, Math.min(1.25, Number(rate) || 1));
  if (![...select.options].some((option) => Number(option.value) === value)) {
    select.add(new Option(`${Math.round(value * 100)}%`, String(value)));
  }
  select.value = String(value);
  audio.playbackRate = value;
  syncPracticeUrl(card);
  document.dispatchEvent(new CustomEvent("drumless:rate-changed", { detail: { rate: value } }));
  if (announce) toast(`Playback speed: ${Math.round(value * 100)}%`);
  return value;
}

function scheduleCustomMix(jobId, model, card) {
  window.clearTimeout(card._mixTimer);
  card._mixRevision = (card._mixRevision || 0) + 1;
  const message = pendingMixMessage(card);
  setMixStatus(card, message, true);
  $(".phase-detail", card).textContent = message;
  card._mixTimer = window.setTimeout(() => buildCustomMix(jobId, model, card), 250);
}

function pendingMixMessage(card) {
  const { muted, soloed } = currentMixState(card);
  if (soloed.length) return `Loading ${soloed.join(" + ")} solo…`;
  if (muted.length) return `Loading mix · muted: ${muted.join(", ")}…`;
  return "Loading full mix…";
}

function setMixStatus(card, message, loading = false) {
  const status = $(".mix-status", card);
  if (!status) return;
  status.classList.toggle("loading", loading);
  $("strong", status).textContent = message;
}

async function buildCustomMix(jobId, model, card) {
  const build = $(".build-mix", card);
  const { excluded, soloed } = currentMixState(card);
  const revision = card._mixRevision || 0;
  if (card.dataset.mixBusy === "true") {
    card.dataset.mixPending = "true";
    return;
  }
  card.dataset.mixBusy = "true";
  setMixStatus(card, pendingMixMessage(card), true);
  build.disabled = true;
  build.textContent = "Building mix…";
  $(".phase-detail", card).textContent = soloed.length
    ? `Soloing ${soloed.join(" + ")}`
    : excluded.length
    ? `Removing ${excluded.join(", ")}`
    : "Restoring all separated stems";
  try {
    const stockDrumless = excluded.length === 1 && excluded[0] === "drums"
      ? state.job?.models?.[model]
      : null;
    const mix = stockDrumless?.audio_url ? {
      audio_url: stockDrumless.audio_url,
      download_url: stockDrumless.download_url,
      excluded: ["drums"],
    } : await api(`/api/jobs/${jobId}/mix/${model}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excluded }),
      });
    const audio = $("audio", card);
    card.dataset.baseAudioUrl = mix.audio_url;
    card.dataset.mixId = mix.mix_id || "";
    card.dataset.excluded = (mix.excluded || excluded).join(",");
    syncMixUrl(card);
    const pitch = Number($(".pitch-select", card)?.value || 0);
    if (pitch) await applyPitch(card, false);
    else await replaceAudioSource(audio, cacheBusted(mix.audio_url));
    document.dispatchEvent(new CustomEvent("drumless:mix-changed", {
      detail: { jobId, model, excluded: mix.excluded || excluded, mixId: mix.mix_id || "" },
    }));
    const download = $(".download", card);
    download.href = mix.download_url;
    download.classList.remove("disabled");
    setCopyLink(card, mix.audio_url);
    $(".phase-detail", card).textContent = mix.excluded.length
      ? `Removed: ${mix.excluded.join(", ")}`
      : "All stems included";
    if (revision === (card._mixRevision || 0)) {
      const ready = soloed.length
        ? `${soloed.join(" + ")} solo ready`
        : excluded.length
          ? `Mix ready · muted: ${excluded.join(", ")}`
          : "Full mix ready";
      setMixStatus(card, ready);
    }
    toast(`${model === "scnet" ? "SCNet" : "RoFormer"} mix updated`);
  } catch (error) {
    if (revision === (card._mixRevision || 0)) setMixStatus(card, "Mix update failed");
    toast(error.message);
  } finally {
    card.dataset.mixBusy = "false";
    build.disabled = false;
    build.textContent = "Rebuild selected mix";
    if (card.dataset.mixPending === "true") {
      card.dataset.mixPending = "false";
      buildCustomMix(jobId, model, card);
    }
  }
}

async function applyPitch(card, announce = true) {
  const audio = $("audio", card);
  const select = $(".pitch-select", card);
  const semitones = Number(select.value);
  select.disabled = true;
  try {
    if (semitones === 0) {
      await replaceAudioSource(audio, cacheBusted(card.dataset.baseAudioUrl));
    } else {
      const variant = await api(`/api/jobs/${state.job.id}/pitch/${card.dataset.model}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          semitones,
          excluded: (card.dataset.excluded || "").split(",").filter(Boolean),
          mix_id: card.dataset.mixId || "",
        }),
      });
      await replaceAudioSource(audio, cacheBusted(variant.audio_url));
    }
    if (announce) toast(semitones ? `Pitch shifted ${semitones > 0 ? "+" : ""}${semitones} semitone${Math.abs(semitones) === 1 ? "" : "s"}` : "Original pitch restored");
  } catch (error) {
    toast(error.message);
  } finally {
    select.disabled = false;
  }
}

function cacheBusted(url) {
  return `${url}${url.includes("?") ? "&" : "?"}v=${Date.now()}`;
}

function replaceAudioSource(audio, source) {
  // Preflight the replacement while the current mix keeps playing. Only touch
  // the real player after the new source proves it can load.
  return new Promise((resolve, reject) => {
    const preload = new Audio();
    preload.preload = "metadata";
    preload.addEventListener("error", () => reject(new Error("The new mix could not be loaded. Your current mix is still playing.")), { once: true });
    preload.addEventListener("loadedmetadata", () => {
      // Capture at the actual swap—not when rendering starts—so a long first-time
      // custom mix never sends the drummer backward in the song.
      const resumeAt = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
      const wasPlaying = !audio.paused && !audio.ended;
      const playbackRate = audio.playbackRate;
      const volume = audio.volume;
      const muted = audio.muted;
      const finish = async () => {
        const latestPosition = Number.isFinite(audio.duration)
          ? Math.min(resumeAt, Math.max(0, audio.duration - 0.05))
          : resumeAt;
        audio.currentTime = latestPosition;
        audio.playbackRate = playbackRate;
        audio.volume = volume;
        audio.muted = muted;
        if (wasPlaying) {
          try { await audio.play(); }
          catch { toast("Mix updated — press play to continue"); }
        }
        resolve();
      };
      audio.addEventListener("loadedmetadata", finish, { once: true });
      audio.src = source;
      audio.load();
    }, { once: true });
    preload.src = source;
    preload.load();
  });
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function resetPracticePlayer(card) {
  card._loopStart = null;
  card._loopEnd = null;
  const play = $(".transport-play", card);
  if (!play) return;
  play.disabled = true;
  play.classList.remove("playing");
  play.innerHTML = "<span>▶</span>";
  $(".current-time", card).textContent = "0:00";
  $(".duration", card).textContent = "0:00";
  const scrubber = $(".scrubber", card);
  scrubber.value = 0;
  scrubber.disabled = true;
  $$(".seek-button", card).forEach((button) => { button.disabled = true; });
  const loop = $(".loop-button", card);
  loop.disabled = true;
  loop.classList.remove("active");
  loop.textContent = "Set loop A";
  const speed = $(".speed-select", card);
  speed.disabled = true;
  speed.value = "1";
  const pitch = $(".pitch-select", card);
  pitch.disabled = true;
  pitch.value = "0";
  $(".band-score-button", card).disabled = true;
  card.dataset.mixId = "";
  card.dataset.excluded = "drums";
  card.dataset.baseAudioUrl = "";
  card.dataset.practiceUrlRestored = "false";
  card.dataset.pitchUrlRestored = "false";
}

function setupPracticePlayer(card) {
  const audio = $("audio", card);
  const play = $(".transport-play", card);
  const scrubber = $(".scrubber", card);
  const loop = $(".loop-button", card);
  const speed = $(".speed-select", card);
  const pitch = $(".pitch-select", card);
  const bandScore = $(".band-score-button", card);

  const setReady = () => {
    const ready = Number.isFinite(audio.duration) && audio.duration > 0;
    play.disabled = !ready;
    scrubber.disabled = !ready;
    loop.disabled = !ready;
    speed.disabled = !ready;
    pitch.disabled = !ready;
    bandScore.disabled = !ready;
    $$(".seek-button", card).forEach((button) => { button.disabled = !ready; });
    $(".duration", card).textContent = formatTime(audio.duration);
    if (ready && card.dataset.practiceUrlRestored !== "true") {
      card.dataset.practiceUrlRestored = "true";
      const params = new URLSearchParams(window.location.search);
      const rate = Number(params.get("speed"));
      if (rate >= 0.5 && rate <= 1.25) selectPlaybackRate(rate);
      const range = (params.get("loop") || "").match(/^([0-9.]+)-([0-9.]+)$/);
      if (range && Number(range[2]) > Number(range[1])) {
        setLoopRange(Number(range[1]), Math.min(Number(range[2]), audio.duration));
      }
      const linkedPitch = Number(params.get("pitch"));
      if (Number.isInteger(linkedPitch) && linkedPitch >= -12 && linkedPitch <= 12 && linkedPitch !== 0
          && card.dataset.pitchUrlRestored !== "true") {
        card.dataset.pitchUrlRestored = "true";
        pitch.value = String(linkedPitch);
        applyPitch(card, false);
      }
    }
  };

  const updatePosition = () => {
    $(".current-time", card).textContent = formatTime(audio.currentTime);
    if (Number.isFinite(audio.duration) && audio.duration > 0 && !scrubber.matches(":active")) {
      scrubber.value = Math.round(audio.currentTime / audio.duration * 1000);
    }
    if (
      Number.isFinite(card._loopStart)
      && Number.isFinite(card._loopEnd)
      && audio.currentTime >= card._loopEnd
    ) {
      const passAt = performance.now();
      if (!card._lastLoopPassAt || passAt - card._lastLoopPassAt > 400) {
        card._lastLoopPassAt = passAt;
        document.dispatchEvent(new CustomEvent("drumless:loop-pass", {
          detail: { start: card._loopStart, end: card._loopEnd, rate: audio.playbackRate },
        }));
      }
      audio.currentTime = card._loopStart;
    }
  };

  audio.addEventListener("loadedmetadata", setReady);
  audio.addEventListener("durationchange", setReady);
  audio.addEventListener("timeupdate", updatePosition);
  audio.addEventListener("play", () => {
    play.classList.add("playing");
    play.innerHTML = "<span>❚❚</span>";
    play.setAttribute("aria-label", "Pause");
  });
  audio.addEventListener("pause", () => {
    play.classList.remove("playing");
    play.innerHTML = "<span>▶</span>";
    play.setAttribute("aria-label", "Play");
  });

  play.addEventListener("click", () => {
    if (audio.paused) audio.play().catch(() => toast("Press play again to start"));
    else audio.pause();
  });
  scrubber.addEventListener("input", () => {
    if (Number.isFinite(audio.duration)) {
      audio.currentTime = Number(scrubber.value) / 1000 * audio.duration;
      updatePosition();
    }
  });
  $$(".seek-button", card).forEach((button) => {
    button.addEventListener("click", () => {
      audio.currentTime = Math.max(
        0,
        Math.min(audio.duration || 0, audio.currentTime + Number(button.dataset.seek))
      );
    });
  });
  speed.addEventListener("change", () => {
    selectPlaybackRate(Number(speed.value), { announce: true });
  });
  pitch.addEventListener("change", () => { syncPracticeUrl(card); applyPitch(card); });
  bandScore.addEventListener("click", () => {
    document.dispatchEvent(new CustomEvent("drumless:open-score"));
  });
  loop.addEventListener("click", () => {
    if (!Number.isFinite(card._loopStart)) {
      card._loopStart = audio.currentTime;
      loop.textContent = `Set loop B · ${formatTime(card._loopStart)}`;
      loop.classList.add("active");
      syncPracticeUrl(card);
      toast("Loop start set");
      return;
    }
    if (!Number.isFinite(card._loopEnd)) {
      if (audio.currentTime <= card._loopStart + 0.5) {
        toast("Move forward before setting loop end");
        return;
      }
      card._loopEnd = audio.currentTime;
      loop.textContent = `Loop ${formatTime(card._loopStart)}–${formatTime(card._loopEnd)}`;
      audio.currentTime = card._loopStart;
      audio.play().catch(() => {});
      syncPracticeUrl(card);
      toast("A/B loop is active");
      return;
    }
    card._loopStart = null;
    card._loopEnd = null;
    loop.textContent = "Set loop A";
    loop.classList.remove("active");
    syncPracticeUrl(card);
    toast("Loop cleared");
  });
}

function fallbackDetail(model) {
  if (model.status === "processing") return "Model process is active";
  if (model.status === "complete") return "Drumless FLAC is ready to play";
  if (model.status === "failed") return model.error || "Processing failed";
  return "Waiting for its processing slot";
}

function renderElapsed(job) {
  if (!job?.created_at) return;
  const end = ["complete", "failed"].includes(job.status) ? new Date(job.updated_at) : new Date();
  const seconds = Math.max(0, Math.floor((end - new Date(job.created_at)) / 1000));
  $("#job-elapsed").textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function slugifyTitle(title) {
  return title.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100) || "track";
}

function shareSlug(track) {
  const artist = track.artist || (track.folder && track.folder !== "."
    ? track.folder.split("/", 1)[0]
    : "");
  const match = track.title.match(/\s+-\s+(?:\d{1,3}(?:-\d{1,3})?)\s+-\s+(.+)$/);
  const song = match ? match[1] : track.title;
  return slugifyTitle(`${artist} ${song}`.trim());
}

function setJobUrl(job) {
  const path = `/songs/${shareSlug(job.track)}`;
  if (window.location.pathname !== path) {
    window.history.pushState({ jobId: job.id }, "", path);
  }
  $("#share-button").disabled = false;
}

function setCopyLink(card, url) {
  const button = $(".copy-link", card);
  button.disabled = false;
  button.dataset.url = new URL(url, window.location.origin).href;
  button.onclick = () => copyText(button.dataset.url, "Result link copied");
}

async function copyText(value, message) {
  try {
    await navigator.clipboard.writeText(value);
    toast(message);
  } catch {
    window.prompt("Copy this link:", value);
  }
}

async function pollJob(jobId) {
  try {
    const job = await api(`/api/jobs/${jobId}`);
    updateJobView(job);
    if (!["complete", "failed"].includes(job.status)) {
      state.pollTimer = window.setTimeout(() => pollJob(jobId), 2000);
    }
  } catch (error) {
    toast(error.message);
    state.pollTimer = window.setTimeout(() => pollJob(jobId), 5000);
  }
}

function displayJob(job) {
  window.clearTimeout(state.pollTimer);
  resetCards();
  state.job = job;
  document.body.classList.add("studio-open", "practice-active");
  state.selected = state.tracks.find((track) => track.id === job.track.id) || job.track;
  renderActiveChallenge();
  renderSelection();
  if (state.browserMode === "completed") renderCompleted();
  else renderTracks();
  $("#job-progress").classList.remove("hidden");
  setJobUrl(job);
  updateJobView(job);
  if (!["complete", "failed"].includes(job.status)) pollJob(job.id);
}

async function openCompletedJob(jobId) {
  try {
    displayJob(await api(`/api/jobs/${jobId}`));
  } catch (error) {
    toast(error.message);
  }
}

async function restoreRecentJob() {
  try {
    const songMatch = window.location.pathname.match(/^\/songs\/([^/]+)\/?$/);
    const jobMatch = window.location.pathname.match(/^\/jobs\/([a-f0-9]+)(?:\/[^/]+)?\/?$/);
    if (songMatch) {
      displayJob(await api(`/api/songs/${songMatch[1]}`));
    } else if (jobMatch) {
      displayJob(await api(`/api/jobs/${jobMatch[1]}`));
    }
  } catch {
    // A missing or unreadable prior job should not block normal library browsing.
  }
}

function openStudio(mode) {
  document.body.classList.remove("practice-active");
  document.body.classList.add("studio-open");
  setBrowserMode(mode);
  $("#studio").scrollIntoView({ behavior: "smooth", block: "start" });
  window.setTimeout(() => {
    if (mode === "import") $("#provider-search-input").focus();
    if (mode === "library") $("#search-input").focus();
  }, 450);
}

function chooseNewSong() {
  if (window.location.pathname !== "/") {
    window.location.assign("/");
    return;
  }
  $$('audio').forEach((audio) => audio.pause());
  document.body.classList.remove("studio-open");
  document.body.classList.remove("practice-active");
  window.scrollTo({ top: 0, behavior: "smooth" });
  window.setTimeout(() => $("#home-song-search-input").focus(), 450);
}

function applyTheme(theme) {
  const selected = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = selected;
  const toggle = $("#theme-toggle");
  toggle.textContent = selected === "dark" ? "☀" : "☾";
  toggle.setAttribute("aria-label", selected === "dark" ? "Switch to light mode" : "Switch to dark mode");
  $("meta[name='theme-color']").content = selected === "dark" ? "#0d0c0b" : "#f1eee7";
  try { localStorage.setItem("drumless-theme", selected); } catch {}
}

function playTogether() {
  const players = $$(".model-card.ready audio");
  if (players.length < 2) return;
  const time = Math.min(...players.map((player) => player.currentTime));
  players.forEach((player) => {
    player.currentTime = time;
    player.play();
  });
}

function stopTogether() {
  $$(".model-card audio").forEach((player) => {
    player.pause();
    player.currentTime = 0;
  });
}

function setLoopRange(start, end) {
  const card = $(".model-card[data-model='roformer']");
  const audio = $("audio", card);
  const loop = $(".loop-button", card);
  if (!audio || !(end > start)) return;
  card._loopStart = start; card._loopEnd = end;
  loop.disabled = false; loop.classList.add("active");
  loop.textContent = `Loop ${formatTime(start)}–${formatTime(end)}`;
  audio.currentTime = start;
  syncPracticeUrl(card);
  document.dispatchEvent(new CustomEvent("drumless:loop-changed", { detail: { start, end } }));
  audio.play().catch(() => {});
}

function clearLoopRange() {
  const card = $(".model-card[data-model='roformer']");
  const loop = $(".loop-button", card);
  card._loopStart = null;
  card._loopEnd = null;
  loop.textContent = "Set loop A";
  loop.classList.remove("active");
  syncPracticeUrl(card);
  document.dispatchEvent(new CustomEvent("drumless:loop-changed", { detail: null }));
}

let searchTimer;
$("#search-input").addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => loadLibrary(), 220);
});
$("#folder-select").addEventListener("change", () => loadLibrary());
$("#refresh-button").addEventListener("click", () => {
  if (state.browserMode === "library") loadLibrary(true);
  else if (state.browserMode === "completed") loadCompleted();
  else loadImportCapabilities();
});
$$(".browser-tabs button").forEach((button) => {
  button.addEventListener("click", () => setBrowserMode(button.dataset.browser));
});
$$('[data-home-action]').forEach((button) => {
  button.addEventListener("click", () => openStudio(button.dataset.homeAction));
});
$("#theme-toggle").addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});
$("#new-song-button").addEventListener("click", chooseNewSong);
$("#install-app").addEventListener("click", async () => {
  if (!pendingInstallPrompt) return;
  await pendingInstallPrompt.prompt();
  pendingInstallPrompt = null;
  $("#install-app").classList.add("hidden");
});
$(".brand").addEventListener("click", (event) => {
  if (window.location.pathname !== "/") return;
  event.preventDefault();
  window.scrollTo({ top: 0, behavior: "smooth" });
});
$("#run-button").addEventListener("click", startJob);
$("#provider-search-form").addEventListener("submit", searchProvider);
$("#youtube-home-search").addEventListener("submit", searchYoutubeHome);
$("#home-song-search").addEventListener("submit", (event) => {
  event.preventDefault();
  const query = $("#home-song-search-input").value.trim();
  if (!query) return;
  openStudio("import");
  $("#provider-search-input").value = query;
  window.setTimeout(() => $("#provider-search-form").requestSubmit(), 150);
});
$("#url-import-form").addEventListener("submit", (event) => {
  event.preventDefault();
  importURL($("#url-import-input").value.trim());
});
$("#audio-upload").addEventListener("change", (event) => uploadAudio(event.target.files[0]));
$("#share-button").addEventListener("click", () => copyText(window.location.href, "Share URL copied"));
$("#sync-play").addEventListener("click", playTogether);
$("#sync-stop").addEventListener("click", stopTogether);
$("#open-challenge").addEventListener("click", async () => {
  $("#challenge-drawer").classList.remove("hidden");
  try { await loadChallengeGenres(); } catch (error) { toast(error.message); }
  $("#challenge-drawer").scrollIntoView({ behavior: "smooth", block: "nearest" });
});
$("#close-challenge").addEventListener("click", () => $("#challenge-drawer").classList.add("hidden"));
$("#challenge-pool").addEventListener("change", () => {
  $("#challenge-card").classList.add("hidden");
  $(".genre-choice").classList.remove("hidden");
  state.challengeDraw = null;
  renderChallengeGenres();
});
$("#redraw-challenge").addEventListener("click", (event) => drawChallenge(event.currentTarget.dataset.genre));
$("#draw-selected-genre").addEventListener("click", () => {
  if (state.selectedChallengeGenre) drawChallenge(state.selectedChallengeGenre);
});
$("#surprise-challenge").addEventListener("click", async () => {
  try {
    await loadChallengeGenres();
    const genres = state.challengeGenres?.genres || [];
    if (genres.length) {
      const genre = genres[Math.floor(Math.random() * genres.length)].id;
      state.selectedChallengeGenre = genre;
      renderChallengeGenres();
      await drawChallenge(genre);
    }
  } catch (error) { toast(error.message); }
});
$("#accept-challenge").addEventListener("click", acceptChallenge);
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    setBrowserMode("library");
    $("#search-input").focus();
    return;
  }
  if (["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(event.target.tagName)) return;
  const audio = $(".model-card.ready audio");
  if (!audio) return;
  if (event.code === "Space") {
    event.preventDefault();
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    audio.currentTime = Math.max(0, audio.currentTime - 5);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5);
  }
});

$$(".model-card").forEach(setupPracticePlayer);
applyTheme(document.documentElement.dataset.theme);
try { state.activeChallenge = JSON.parse(sessionStorage.getItem("grooveslate-challenge") || "null"); } catch {}
renderActiveChallenge();
async function boot() {
  const activity = beginActivity("Loading your practice room…");
  try {
    await loadSession();
    await Promise.allSettled([
      state.session?.source_mode === "youtube" ? Promise.resolve() : loadLibrary(),
      loadCompleted(), loadCommunity(), loadImportCapabilities(), restoreRecentJob(),
    ]);
  } finally { endActivity(activity); }
}
boot();

// Keep the server library index warm and pick up newly added music automatically.
window.setInterval(() => {
  if (!document.hidden && state.browserMode === "library" && state.session?.source_mode !== "youtube") loadLibrary();
}, 60_000);

window.DrumlessApp = {
  api,
  toast,
  formatTime,
  escapeHtml,
  getJob: () => state.job,
  getPracticeAudio: () => $(".model-card[data-model=\"roformer\"] audio"),
  refreshPracticeLibrary: loadCompleted,
  refreshCommunity: loadCommunity,
  updateChallengeProgress,
  setLoopRange,
  clearLoopRange,
  getLoopRange: () => {
    const card = $(".model-card[data-model='roformer']");
    return Number.isFinite(card?._loopStart) && Number.isFinite(card?._loopEnd)
      ? { start: card._loopStart, end: card._loopEnd } : null;
  },
  setPlaybackRate: (rate, options) => selectPlaybackRate(rate, options),
  getPlaybackRate: () => $(".model-card[data-model='roformer'] audio")?.playbackRate || 1,
  muteStemForScorePart,
  beginActivity,
  updateActivity,
  endActivity,
};
