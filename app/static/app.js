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
  activeChallenge: null,
  community: [],
  youtubeResults: [],
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const isSongPage = window.location.pathname.startsWith("/songs/") || window.location.pathname.startsWith("/jobs/");
document.body.classList.add(isSongPage ? "shared-song" : "home-page");

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
  const response = await fetch(path, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed (${response.status})`);
  }
  return response.json();
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
      <audio controls preload="metadata" src="${escapeHtml(take.audio_url)}"></audio>
      <div class="groove-score"><span>${take.score ?? "—"}</span><small>GROOVE · ${take.score_count} VOTE${take.score_count === 1 ? "" : "S"}</small></div>
      ${take.owned ? `<button class="unpublish-take" data-unpublish="${take.id}" type="button">Unpublish</button>` : `<div class="score-buttons" aria-label="Score ${escapeHtml(take.owner)}'s take">${[1,2,3,4,5].map((score) => `<button class="${take.your_score === score ? "active" : ""}" data-score-publication="${take.id}" data-score="${score}" type="button" title="${score} out of 5">${score}</button>`).join("")}</div>`}
    </article>`).join("");
  $$(".community-take audio", list).forEach((audio) => audio.addEventListener("play", () => {
    $$("audio").forEach((other) => { if (other !== audio) other.pause(); });
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
    <button type="button" data-challenge-genre="${genre.id}" ${genre.count === 0 ? "disabled" : ""}>
      <span>${escapeHtml(genre.label)}</span><b>${genre.count == null ? "YT" : genre.count.toLocaleString()}</b>
    </button>`).join("");
  $$('[data-challenge-genre]', grid).forEach((button) => button.addEventListener("click", () => drawChallenge(button.dataset.challengeGenre)));
}

async function drawChallenge(genre) {
  $$('[data-challenge-genre]').forEach((button) => { button.disabled = true; });
  try {
    state.challengeDraw = await api("/api/challenges/draw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ genre, ready_only: $("#challenge-pool").value === "ready" }),
    });
    state.challengeDraw.genre = genre;
    const selected = state.challengeGenres.genres.find((item) => item.id === genre);
    $("#challenge-genre").textContent = `${selected?.label || genre} · RANDOM DRAW`;
    $("#challenge-song-title").textContent = state.challengeDraw.track.title;
    $("#challenge-song-meta").textContent = `${state.challengeDraw.track.artist || "Unknown artist"} · ${state.challengeDraw.track.album || "Library"}${state.challengeDraw.ready_job_id ? " · READY NOW" : " · SEPARATION NEEDED"}`;
    $("#challenge-kind").textContent = state.challengeDraw.challenge.kind.replaceAll("-", " ").toUpperCase();
    $("#challenge-rule-title").textContent = state.challengeDraw.challenge.title;
    $("#challenge-rule-copy").textContent = state.challengeDraw.challenge.instruction;
    $("#challenge-card").classList.remove("hidden");
    $("#redraw-challenge").dataset.genre = genre;
  } catch (error) { toast(error.message); }
  finally { renderChallengeGenres(); }
}

async function acceptChallenge() {
  const draw = state.challengeDraw;
  if (!draw) return;
  state.activeChallenge = draw;
  try { sessionStorage.setItem("grooveslate-challenge", JSON.stringify(draw)); } catch {}
  renderActiveChallenge();
  $("#challenge-drawer").classList.add("hidden");
  if (draw.ready_job_id) {
    await openPracticeSession(draw.ready_job_id);
    toast("Challenge accepted — go earn it");
    return;
  }
  if (draw.youtube_url) {
    const imported = await importURL(draw.youtube_url, draw.track.title);
    if (imported) {
      draw.track = imported;
      state.activeChallenge = draw;
      try { sessionStorage.setItem("grooveslate-challenge", JSON.stringify(draw)); } catch {}
      renderActiveChallenge();
    }
    return;
  }
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
  $("#selected-path").textContent = track ? track.relative_path : "Search, upload, or browse your private library.";
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
    if (state.session.source_mode === "youtube") {
      document.body.classList.add("youtube-only");
      $$('[data-library-only]').forEach((element) => element.classList.add("hidden"));
      $("#challenge-source-copy").textContent = "Every draw searches YouTube in your chosen genre, then gives you a focused drumming mission.";
      $("#challenge-pool").innerHTML = '<option value="all">YouTube song</option>';
      $("#home-song-search-input").placeholder = "Find a song on YouTube";
      $("#provider-search-input").placeholder = "Search YouTube";
      $("#selected-path").textContent = "Search YouTube or paste a permitted video URL.";
      $("#source-footer").textContent = "YOUTUBE DISCOVERY · PRIVATE PRACTICE WORKSPACE";
    }
  } catch {
    // The authentication middleware handles expired sessions.
  }
}

function resetCards() {
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
      audio.src = `${model.audio_url}?v=${encodeURIComponent(job.updated_at)}`;
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
    const container = $(".stem-buttons", card);
    container.innerHTML = stems.map((stem) => `
      <button class="stem-toggle ${stem.name === "drums" ? "removed" : ""}" data-stem="${stem.name}">
        ${escapeHtml(stem.name)}
      </button>
    `).join("");
    $$(".stem-toggle", container).forEach((button) => {
      button.addEventListener("click", () => {
        button.classList.toggle("removed");
        scheduleCustomMix(jobId, model, card);
      });
    });
    const build = $(".build-mix", card);
    build.disabled = false;
    build.onclick = () => buildCustomMix(jobId, model, card);
  } catch (error) {
    state.stemsLoaded.delete(cacheKey);
    $(".stem-buttons", card).innerHTML = `<i>${escapeHtml(error.message)}</i>`;
  }
}

function scheduleCustomMix(jobId, model, card) {
  window.clearTimeout(card._mixTimer);
  $(".phase-detail", card).textContent = "Mix selection changed — rebuilding…";
  card._mixTimer = window.setTimeout(() => buildCustomMix(jobId, model, card), 250);
}

async function buildCustomMix(jobId, model, card) {
  const build = $(".build-mix", card);
  const excluded = $$(".stem-toggle.removed", card).map((button) => button.dataset.stem);
  if (card.dataset.mixBusy === "true") {
    card.dataset.mixPending = "true";
    return;
  }
  card.dataset.mixBusy = "true";
  build.disabled = true;
  build.textContent = "Building mix…";
  $(".phase-detail", card).textContent = excluded.length
    ? `Removing ${excluded.join(", ")}`
    : "Restoring all separated stems";
  try {
    const mix = await api(`/api/jobs/${jobId}/mix/${model}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ excluded }),
    });
    const audio = $("audio", card);
    replaceAudioSource(audio, `${mix.audio_url}?v=${Date.now()}`);
    const download = $(".download", card);
    download.href = mix.download_url;
    download.classList.remove("disabled");
    setCopyLink(card, mix.audio_url);
    $(".phase-detail", card).textContent = mix.excluded.length
      ? `Removed: ${mix.excluded.join(", ")}`
      : "All stems included";
    toast(`${model === "scnet" ? "SCNet" : "RoFormer"} mix updated`);
  } catch (error) {
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

function replaceAudioSource(audio, source) {
  const resumeAt = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  const wasPlaying = !audio.paused && !audio.ended;
  const playbackRate = audio.playbackRate;
  const volume = audio.volume;
  const muted = audio.muted;

  audio.addEventListener("loadedmetadata", () => {
    const latestPosition = Number.isFinite(audio.duration)
      ? Math.min(resumeAt, Math.max(0, audio.duration - 0.05))
      : resumeAt;
    audio.currentTime = latestPosition;
    audio.playbackRate = playbackRate;
    audio.volume = volume;
    audio.muted = muted;
    if (wasPlaying) {
      audio.play().catch(() => toast("Mix updated — press play to continue"));
    }
  }, { once: true });

  audio.src = source;
  audio.load();
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
}

function setupPracticePlayer(card) {
  const audio = $("audio", card);
  const play = $(".transport-play", card);
  const scrubber = $(".scrubber", card);
  const loop = $(".loop-button", card);
  const speed = $(".speed-select", card);

  const setReady = () => {
    const ready = Number.isFinite(audio.duration) && audio.duration > 0;
    play.disabled = !ready;
    scrubber.disabled = !ready;
    loop.disabled = !ready;
    speed.disabled = !ready;
    $$(".seek-button", card).forEach((button) => { button.disabled = !ready; });
    $(".duration", card).textContent = formatTime(audio.duration);
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
    audio.playbackRate = Number(speed.value);
    toast(`Playback speed: ${speed.value}×`);
  });
  loop.addEventListener("click", () => {
    if (!Number.isFinite(card._loopStart)) {
      card._loopStart = audio.currentTime;
      loop.textContent = `Set loop B · ${formatTime(card._loopStart)}`;
      loop.classList.add("active");
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
      toast("A/B loop is active");
      return;
    }
    card._loopStart = null;
    card._loopEnd = null;
    loop.textContent = "Set loop A";
    loop.classList.remove("active");
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
  const artist = track.folder && track.folder !== "."
    ? track.folder.split("/", 1)[0]
    : "";
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
  document.body.classList.add("studio-open");
  setBrowserMode(mode);
  $("#studio").scrollIntoView({ behavior: "smooth", block: "start" });
  window.setTimeout(() => {
    if (mode === "import") $("#provider-search-input").focus();
    if (mode === "library") $("#search-input").focus();
  }, 450);
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
  audio.play().catch(() => {});
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
  state.challengeDraw = null;
  renderChallengeGenres();
});
$("#redraw-challenge").addEventListener("click", (event) => drawChallenge(event.currentTarget.dataset.genre));
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
  await loadSession();
  await Promise.allSettled([
    state.session?.source_mode === "youtube" ? Promise.resolve() : loadLibrary(),
    loadCompleted(), loadCommunity(), loadImportCapabilities(), restoreRecentJob(),
  ]);
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
};
