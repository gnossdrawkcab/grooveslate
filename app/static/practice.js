(() => {
  const app = window.DrumlessApp;
  const studio = document.querySelector("#session-studio");
  if (!app || !studio) return;

  const $ = (selector, root = studio) => root.querySelector(selector);
  const $$ = (selector, root = studio) => [...root.querySelectorAll(selector)];
  const practiceState = {
    job: null,
    session: null,
    audio: null,
    saveTimer: null,
    audioContext: null,
    mediaSource: null,
    backingGain: null,
    mixDestination: null,
    micStream: null,
    cameraStream: null,
    micSource: null,
    analyser: null,
    levelFrame: null,
    midiAccess: null,
    recorder: null,
    chunks: [],
    recordingStarted: 0,
    midiEvents: [],
    recordingTimer: null,
    metronomeTimer: null,
    tapTimes: [],
    markerKind: "section",
    waveform: null,
    waveformJobId: null,
    drumSamples: new Map(),
    sampleGroups: new Map(),
    samplePromise: null,
    sampleCounters: new Map(),
    chokeSources: new Map(),
    hiHatPedal: 127,
    wakeLock: null,
    midiOverrides: new Map(),
    midiLearnTarget: null,
    snareCalibration: null,
    scoreReady: false,
    scorePosition: 0,
    scoreClockFrame: null,
    scoreLastSent: 0,
    scoreReference: null,
    trainer: { active: false, passes: 0, rate: 1 },
  };

  const TABFORGE_ORIGIN = "https://tabforge.pathtpc.xyz";

  try {
    const savedMap = JSON.parse(localStorage.getItem("grooveslate-midi-map") || "{}");
    Object.entries(savedMap).forEach(([note, instrument]) => practiceState.midiOverrides.set(Number(note), instrument));
  } catch {}

  function setPanel(name) {
    $$("[data-workbench]").forEach((button) => button.classList.toggle("active", button.dataset.workbench === name));
    $$("[data-workbench-panel]").forEach((panel) => panel.classList.toggle("active", panel.dataset.workbenchPanel === name));
    if (name === "record") ensureDrumSamples().catch(() => {});
    if (name === "score") loadBandScore();
  }

  function postToScore(type, detail = {}) {
    const frame = $("#band-score-frame");
    if (!frame?.contentWindow) return;
    frame.contentWindow.postMessage({ source: "grooveslate", type, ...detail }, TABFORGE_ORIGIN);
  }

  function scoreOffset() {
    return Number(settings().score_offset_seconds) || 0;
  }

  function setScoreStatus(message, ready = false) {
    const status = $("#score-load-status");
    status.textContent = message;
    status.classList.toggle("ready", ready);
    const referenceCount = practiceState.scoreReference?.hits?.length || 0;
    $("#score-sync-status").textContent = ready
      ? `${message} · alignment ${scoreOffset() >= 0 ? "+" : ""}${scoreOffset().toFixed(2)}s${referenceCount ? ` · ${referenceCount.toLocaleString()} authored drum hits` : ""}`
      : message;
  }

  function sendScoreClock(force = false) {
    if (!practiceState.scoreReady || !settings().score_sync || !practiceState.audio) return;
    const now = performance.now();
    if (!force && now - practiceState.scoreLastSent < 90) return;
    practiceState.scoreLastSent = now;
    postToScore("grooveslate:clock", {
      position: Math.max(0, practiceState.audio.currentTime - scoreOffset()),
      duration: practiceState.audio.duration,
      playing: !practiceState.audio.paused,
      rate: practiceState.audio.playbackRate,
    });
  }

  function runScoreClock() {
    window.cancelAnimationFrame(practiceState.scoreClockFrame);
    const tick = () => {
      sendScoreClock();
      if (practiceState.audio && !practiceState.audio.paused) {
        practiceState.scoreClockFrame = window.requestAnimationFrame(tick);
      }
    };
    tick();
  }

  function sendScoreLoop() {
    const range = app.getLoopRange?.();
    postToScore("grooveslate:loop", range ? {
      start: Math.max(0, range.start - scoreOffset()),
      end: Math.max(0, range.end - scoreOffset()),
      enabled: true,
    } : { enabled: false });
  }

  function saveScoreAlignment(offset) {
    practiceState.session.settings.score_offset_seconds = Math.max(-120, Math.min(120, offset));
    renderSettings();
    scheduleSave();
    syncScoreUrl();
    sendScoreClock(true);
  }

  function syncScoreUrl(message = {}) {
    if (!window.location.pathname.startsWith("/songs/")) return;
    const url = new URL(window.location.href);
    if (message.scoreId) url.searchParams.set("tab", String(message.scoreId));
    if (Number.isInteger(Number(message.trackIndex))) url.searchParams.set("part", String(message.trackIndex));
    if (Math.abs(scoreOffset()) > .001) url.searchParams.set("offset", scoreOffset().toFixed(2));
    else url.searchParams.delete("offset");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }

  function handleScoreMessage(event) {
    const frame = $("#band-score-frame");
    if (event.origin !== TABFORGE_ORIGIN || event.source !== frame?.contentWindow
        || event.data?.source !== "tabforge") return;
    const message = event.data;
    if (message.type === "tabforge:loading") {
      setScoreStatus(message.message || "SEARCHING TAB SOURCES");
    } else if (message.type === "tabforge:ready") {
      practiceState.scoreReady = true;
      practiceState.scorePosition = Number(message.position) || 0;
      practiceState.scoreTrack = message.track || "selected part";
      $("#practice-score-part").disabled = !message.track;
      setScoreStatus(message.track ? `SYNCED · ${message.track}` : "SCORE READY", true);
      const linkedParams = new URLSearchParams(window.location.search);
      const linkedPart = linkedParams.has("part") ? Number(linkedParams.get("part")) : NaN;
      syncScoreUrl({ ...message, trackIndex: Number.isInteger(linkedPart) ? linkedPart : message.trackIndex });
      if (Number.isInteger(linkedPart) && linkedPart !== Number(message.trackIndex)) {
        postToScore("grooveslate:track-select", { index: linkedPart });
      }
      sendScoreClock(true);
      sendScoreLoop();
    } else if (message.type === "tabforge:position") {
      practiceState.scorePosition = Number(message.position) || 0;
      if (message.requestId === "align" && practiceState.audio) {
        saveScoreAlignment(practiceState.audio.currentTime - practiceState.scorePosition);
        app.toast("Score aligned to the recording at this moment");
      }
    } else if (message.type === "tabforge:seek" && settings().score_sync && practiceState.audio) {
      practiceState.audio.currentTime = Math.max(0, Math.min(
        practiceState.audio.duration || Infinity,
        (Number(message.position) || 0) + scoreOffset(),
      ));
      sendScoreClock(true);
    } else if (message.type === "tabforge:loop" && settings().score_sync) {
      const start = (Number(message.start) || 0) + scoreOffset();
      const end = (Number(message.end) || 0) + scoreOffset();
      if (end > start) {
        app.setLoopRange?.(Math.max(0, start), Math.min(practiceState.audio?.duration || end, end));
        setPanel("practice");
        app.toast("Score selection is now your GrooveSlate practice loop");
      }
    } else if (message.type === "tabforge:loop-clear" && settings().score_sync) {
      app.clearLoopRange?.();
    } else if (message.type === "tabforge:reference") {
      practiceState.scoreReference = message.confidence === "authored-drum-score"
        ? { confidence: message.confidence, hits: Array.isArray(message.hits) ? message.hits : [] }
        : null;
      if (practiceState.scoreReference?.hits.length) {
        setScoreStatus($("#score-load-status").textContent, true);
      }
    } else if (message.type === "tabforge:track") {
      practiceState.scoreTrack = message.track || "selected part";
      $("#practice-score-part").disabled = false;
      syncScoreUrl({ trackIndex: Number(message.index) });
      setScoreStatus(`SYNCED · ${message.track || "selected part"}`, true);
    }
  }

  window.addEventListener("message", handleScoreMessage);

  function bandScoreUrl() {
    const linked = new URLSearchParams(window.location.search).get("tab");
    if (linked && /^[A-Za-z0-9_-]{1,80}$/.test(linked)) {
      return `https://tabforge.pathtpc.xyz/songs/${encodeURIComponent(linked)}?embed=1`;
    }
    const track = practiceState.job?.track || {};
    const title = String(track.title || "")
      .replace(/\((?:official|lyrics?|audio|video|hd)[^)]*\)/gi, " ")
      .replace(/\[(?:official|lyrics?|audio|video|hd)[^\]]*\]/gi, " ")
      .replace(/\b(?:official\s+(?:music\s+)?video|lyrics?\s+video)\b/gi, " ")
      .replace(/\s+/g, " ").trim();
    const query = [track.artist, title].filter(Boolean).join(" ");
    return `https://tabforge.pathtpc.xyz/library?q=${encodeURIComponent(query)}&external=1&embed=1`;
  }

  function loadBandScore(force = false) {
    const frame = $("#band-score-frame");
    const url = bandScoreUrl();
    if (force || frame.dataset.song !== url) {
      practiceState.scoreReady = false;
      practiceState.scoreReference = null;
      setScoreStatus("SEARCHING TABFORGE…");
      frame.dataset.song = url;
      frame.src = force ? `${url}&reload=${Date.now()}` : url;
    }
  }

  function settings() {
    return practiceState.session?.settings || {
      bpm: 120, count_in_bars: 2, metronome: false, backing_volume: 0.8,
      score_sync: true, score_offset_seconds: 0,
      trainer_start: 0.6, trainer_goal: 1, trainer_step: 0.05, trainer_passes: 2,
    };
  }

  function markerId() {
    return window.crypto?.randomUUID?.() || `marker-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function setSaveState(label, saving = false) {
    const status = $("#session-save-state");
    status.textContent = label;
    status.classList.toggle("saving", saving);
  }

  function scheduleSave() {
    window.clearTimeout(practiceState.saveTimer);
    setSaveState("SAVING…", true);
    practiceState.saveTimer = window.setTimeout(saveSession, 450);
  }

  async function saveSession() {
    if (!practiceState.job || !practiceState.session) return;
    try {
      practiceState.session = await app.api(`/api/jobs/${practiceState.job.id}/practice`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          markers: practiceState.session.markers,
          settings: practiceState.session.settings,
          drills: practiceState.session.drills || [],
        }),
      });
      setSaveState("SAVED");
      app.refreshPracticeLibrary();
    } catch (error) {
      setSaveState("SAVE FAILED", true);
      app.toast(error.message);
    }
  }

  function markerPercent(marker) {
    const duration = practiceState.audio?.duration;
    return Number.isFinite(duration) && duration > 0 ? Math.min(99.5, marker.time / duration * 100) : 0;
  }

  function renderSongMap() {
    const layer = $("#song-map-markers");
    const markers = practiceState.session?.markers || [];
    layer.innerHTML = markers.map((marker) => `
      <button class="song-map-marker" type="button" data-marker-id="${app.escapeHtml(marker.id)}" style="left:${markerPercent(marker)}%" title="${app.escapeHtml(marker.label)} · ${app.formatTime(marker.time)}">
        <span>${app.escapeHtml(marker.label)}</span>
      </button>`).join("");
    $$(".song-map-marker", layer).forEach((button) => button.addEventListener("click", (event) => {
      event.stopPropagation();
      seekToMarker(button.dataset.markerId);
    }));
    const empty = $("#song-map-empty");
    empty.classList.toggle("hidden", Boolean(practiceState.waveform));
    if (!practiceState.waveform) empty.textContent = "Loading full-song waveform…";
    drawWaveform();
    updateWaveformPlayhead();
    updateCueStrip();
  }

  function drawWaveform() {
    const canvas = $("#song-waveform");
    const peaks = practiceState.waveform?.peaks;
    if (!canvas || !peaks?.length) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * ratio));
    canvas.height = Math.max(1, Math.round(rect.height * ratio));
    const context = canvas.getContext("2d");
    context.scale(ratio, ratio);
    context.clearRect(0, 0, rect.width, rect.height);
    const styles = getComputedStyle(document.documentElement);
    context.fillStyle = styles.getPropertyValue("--orange").trim() || "#f05a2a";
    const center = rect.height / 2;
    const stride = Math.max(1, Math.floor(peaks.length / rect.width));
    const barWidth = Math.max(1, rect.width / Math.ceil(peaks.length / stride));
    for (let index = 0, x = 0; index < peaks.length; index += stride, x += barWidth) {
      let peak = 0;
      for (let sample = index; sample < Math.min(peaks.length, index + stride); sample += 1) peak = Math.max(peak, peaks[sample]);
      const height = Math.max(1, peak * (center - 5));
      context.globalAlpha = .32 + peak * .52;
      context.fillRect(x, center - height, Math.max(1, barWidth - .5), height * 2);
    }
    context.globalAlpha = 1;
    const beats = practiceState.session?.auto_map?.beats || [];
    const duration = practiceState.audio?.duration || practiceState.waveform?.duration;
    if (beats.length && duration > 0) {
      beats.forEach((beat, index) => {
        const x = beat / duration * rect.width;
        context.fillStyle = index % 4 === 0 ? "rgba(243,239,231,.28)" : "rgba(243,239,231,.08)";
        context.fillRect(x, index % 4 === 0 ? rect.height - 16 : rect.height - 8, 1, index % 4 === 0 ? 16 : 8);
      });
    }
  }

  function updateWaveformPlayhead() {
    const duration = practiceState.audio?.duration || practiceState.waveform?.duration;
    const percent = duration > 0 ? Math.max(0, Math.min(100, practiceState.audio.currentTime / duration * 100)) : 0;
    $("#waveform-playhead").style.left = `${percent}%`;
  }

  function updateCueStrip() {
    const audio = practiceState.audio;
    const markers = practiceState.session?.markers || [];
    if (!audio || !markers.length) {
      $("#cue-current-title").textContent = "Uncharted";
      $("#cue-current-note").textContent = "Add or auto-map sections to follow the chart.";
      $("#cue-bar-label").textContent = "BAR —";
      $("#cue-section-progress").style.width = "0%";
      $("#cue-next").disabled = true;
      return;
    }
    let index = 0;
    for (let candidate = 0; candidate < markers.length; candidate += 1) {
      if (markers[candidate].time <= audio.currentTime + .08) index = candidate;
      else break;
    }
    const current = markers[index];
    const next = markers[index + 1];
    const end = next?.time || audio.duration || current.time + 1;
    const sectionRatio = Math.max(0, Math.min(1, (audio.currentTime - current.time) / Math.max(.1, end - current.time)));
    const bpm = settings().bpm;
    const baseBar = current.bar || Math.floor(current.time * bpm / 240) + 1;
    const bar = baseBar + Math.max(0, Math.floor((audio.currentTime - current.time) * bpm / 240));
    $("#cue-current-title").textContent = current.label;
    $("#cue-current-note").textContent = current.note || current.kind;
    $("#cue-bar-label").textContent = `BAR ${String(bar).padStart(3, "0")}${current.bars ? ` / ${baseBar + current.bars - 1}` : ""}`;
    $("#cue-section-progress").style.width = `${sectionRatio * 100}%`;
    $("#cue-next").disabled = !next;
    $("#cue-next-title").textContent = next?.label || "End";
    $("#cue-next-time").textContent = next ? `in ${app.formatTime(Math.max(0, next.time - audio.currentTime))}` : "—";
    $("#cue-next").dataset.markerId = next?.id || "";
  }

  async function loadWaveform(jobId, excluded = [], mixId = "") {
    practiceState.waveform = null;
    const waveformKey = `${jobId}:${mixId || [...excluded].sort().join(",")}`;
    practiceState.waveformJobId = waveformKey;
    renderSongMap();
    try {
      const query = new URLSearchParams({ points: "1600" });
      if (excluded.length) query.set("exclude", [...excluded].sort().join(","));
      if (mixId) query.set("mix_id", mixId);
      const waveform = await app.api(`/api/jobs/${jobId}/waveform/roformer?${query}`);
      if (practiceState.waveformJobId !== waveformKey) return;
      practiceState.waveform = waveform;
      renderSongMap();
    } catch {
      if (practiceState.waveformJobId !== waveformKey) return;
      const empty = $("#song-map-empty");
      empty.textContent = "Waveform unavailable · tap the timeline to seek";
      empty.classList.remove("hidden");
    }
  }

  function renderMarkers() {
    const list = $("#marker-list");
    const markers = practiceState.session?.markers || [];
    const bpm = settings().bpm;
    const duration = practiceState.audio?.duration || practiceState.waveform?.duration || 0;
    $("#chart-bpm").textContent = bpm;
    $("#chart-bars").textContent = practiceState.session?.auto_map?.beats?.length
      ? Math.ceil(practiceState.session.auto_map.beats.length / 4)
      : duration ? Math.ceil(duration * bpm / 240) : "—";
    $("#chart-sections").textContent = markers.filter((marker) => ["intro", "verse", "prechorus", "chorus", "bridge", "solo", "outro", "section"].includes(marker.kind)).length;
    if (!markers.length) {
      list.innerHTML = '<div class="empty-library">Play the track and tap a section button when the music changes.</div>';
      renderSongMap();
      app.updateChallengeProgress?.(practiceState.session);
      return;
    }
    const glyphs = { intro: "IN", verse: "V", prechorus: "PC", chorus: "CH", bridge: "BR", solo: "S", outro: "OUT", section: "§", fill: "↗", hit: "●", stop: "𝄽", push: "&", ride: "R", hat: "HH", halftime: "½", build: "<" };
    list.innerHTML = markers.map((marker) => {
      const bar = marker.bar || Math.floor(marker.time * bpm / 240) + 1;
      return `
      <div class="marker-row" data-marker-row="${app.escapeHtml(marker.id)}">
        <button type="button" data-seek-marker="${app.escapeHtml(marker.id)}"><b>${String(bar).padStart(3, "0")}</b><small>${app.formatTime(marker.time)}</small></button>
        <span class="marker-kind"><b>${glyphs[marker.kind] || "•"}</b>${app.escapeHtml(marker.kind)}</span>
        <span class="marker-copy"><strong>${app.escapeHtml(marker.label)}${marker.bars ? ` <i>${marker.bars} BARS</i>` : ""}</strong>${marker.note ? `<small>${app.escapeHtml(marker.note)}</small>` : ""}</span>
        <span class="marker-dynamics ${app.escapeHtml(marker.dynamics || "")}">${marker.dynamics === "high" ? "ƒ" : marker.dynamics === "low" ? "p" : marker.dynamics ? "mf" : ""}</span>
        <span class="marker-actions"><button type="button" data-loop-marker="${app.escapeHtml(marker.id)}" title="Loop this section">↻</button><button type="button" data-edit-marker="${app.escapeHtml(marker.id)}" title="Edit this chart item">✎</button></span>
      </div>`;
    }).join("");
    $$('[data-seek-marker]', list).forEach((button) => button.addEventListener("click", () => seekToMarker(button.dataset.seekMarker)));
    $$('[data-edit-marker]', list).forEach((button) => button.addEventListener("click", () => openMarkerEditor(button.dataset.editMarker)));
    $$('[data-loop-marker]', list).forEach((button) => button.addEventListener("click", () => loopMarker(button.dataset.loopMarker)));
    renderSongMap();
    app.updateChallengeProgress?.(practiceState.session);
  }

  function seekToMarker(id) {
    const marker = practiceState.session?.markers.find((item) => item.id === id);
    if (!marker || !practiceState.audio) return;
    practiceState.audio.currentTime = marker.time;
    setPanel("listen");
  }

  function markerById(id) {
    return practiceState.session?.markers.find((item) => item.id === id);
  }

  function loopMarker(id) {
    const markers = practiceState.session?.markers || [];
    const index = markers.findIndex((item) => item.id === id);
    if (index < 0 || !practiceState.audio) return;
    const start = markers[index].time;
    const end = markers[index + 1]?.time || practiceState.audio.duration;
    if (!(end > start)) return app.toast("This section needs a valid end point");
    app.setLoopRange?.(start, end);
    setPanel("practice");
    app.toast(`Looping ${markers[index].label} · ${app.formatTime(start)}–${app.formatTime(end)}`);
  }

  function openMarkerEditor(id) {
    const marker = markerById(id);
    if (!marker) return;
    $("#edit-marker-id").value = marker.id;
    $("#edit-marker-label").value = marker.label;
    $("#edit-marker-kind").value = marker.kind;
    $("#edit-marker-time").value = marker.time;
    $("#edit-marker-bar").value = marker.bar || "";
    $("#edit-marker-bars").value = marker.bars || "";
    $("#edit-marker-dynamics").value = marker.dynamics || "";
    $("#edit-marker-note").value = marker.note || "";
    $("#marker-editor").showModal();
  }

  function saveMarkerEdit(event) {
    event.preventDefault();
    const marker = markerById($("#edit-marker-id").value);
    if (!marker) return;
    marker.label = $("#edit-marker-label").value.trim();
    marker.kind = $("#edit-marker-kind").value;
    marker.time = Number($("#edit-marker-time").value);
    marker.note = $("#edit-marker-note").value.trim();
    marker.bar = Number($("#edit-marker-bar").value) || null;
    marker.bars = Number($("#edit-marker-bars").value) || null;
    marker.dynamics = $("#edit-marker-dynamics").value || null;
    marker.confidence = 1;
    practiceState.session.markers.sort((a, b) => a.time - b.time);
    $("#marker-editor").close(); renderMarkers(); scheduleSave();
    app.toast(`${marker.label} updated`);
  }

  function deleteEditedMarker() {
    const id = $("#edit-marker-id").value;
    const marker = markerById(id);
    if (!marker || !window.confirm(`Delete ${marker.label} from this chart?`)) return;
    practiceState.session.markers = practiceState.session.markers.filter((item) => item.id !== id);
    $("#marker-editor").close(); renderMarkers(); scheduleSave();
  }

  function chartText() {
    const title = practiceState.job?.track?.title || "GrooveSlate chart";
    const header = `${title}\n${settings().bpm} BPM · 4/4\n`;
    return header + (practiceState.session?.markers || []).map((marker) => {
      const bar = marker.bar || Math.floor(marker.time * settings().bpm / 240) + 1;
      return `BAR ${String(bar).padStart(3, "0")}  ${marker.label.toUpperCase()}${marker.bars ? ` · ${marker.bars} bars` : ""}${marker.note ? ` — ${marker.note}` : ""}`;
    }).join("\n");
  }

  async function copyChart() {
    const value = chartText();
    try { await navigator.clipboard.writeText(value); app.toast("Drum chart copied"); }
    catch { window.prompt("Copy drum chart:", value); }
  }

  function addMarker(label, kind, note = "") {
    if (!practiceState.audio || !practiceState.session) return;
    const marker = {
      id: markerId(),
      time: Math.round(practiceState.audio.currentTime * 100) / 100,
      label: label.trim(),
      note: note.trim(),
      kind,
    };
    if (!marker.label) return;
    practiceState.session.markers.push(marker);
    practiceState.session.markers.sort((a, b) => a.time - b.time);
    renderMarkers();
    scheduleSave();
    app.toast(`${marker.label} marked at ${app.formatTime(marker.time)}`);
  }

  async function autoMapSong() {
    const existing = practiceState.session?.markers?.length || 0;
    if (existing && !window.confirm("Replace the current chart with an automatically analyzed first draft?")) return;
    const button = $("#auto-map-song");
    button.disabled = true; $("span", button).textContent = "Listening to the form…";
    $("#chart-status").classList.add("analyzing");
    try {
      practiceState.session = await app.api(`/api/jobs/${practiceState.job.id}/practice/auto-map`, { method: "POST" });
      renderSettings(); renderMarkers(); renderSongMap();
      app.refreshPracticeLibrary();
      app.toast(`Draft chart built: ${practiceState.session.markers.length} sections at ${settings().bpm} BPM`);
    } catch (error) { app.toast(error.message); }
    finally {
      button.disabled = false; $("span", button).textContent = "Auto-map song";
      $("#chart-status").classList.remove("analyzing");
    }
  }

  function renderSettings() {
    const value = settings();
    $("#practice-bpm").value = value.bpm;
    $("#count-in-bars").value = value.count_in_bars;
    $("#metronome-enabled").checked = value.metronome;
    $("#backing-volume").value = value.backing_volume;
    $("#score-sync-enabled").checked = value.score_sync !== false;
    $("#trainer-start").value = String(value.trainer_start ?? 0.6);
    $("#trainer-goal").value = String(value.trainer_goal ?? 1);
    $("#trainer-step").value = String(value.trainer_step ?? 0.05);
    $("#trainer-passes").value = String(value.trainer_passes ?? 2);
    if (practiceState.audio) practiceState.audio.volume = value.backing_volume;
    if (practiceState.scoreReady) setScoreStatus($("#score-load-status").textContent, true);
    renderPracticePrescription();
    renderDrillHistory();
  }

  function weakestSection() {
    const scored = (practiceState.session?.takes || []).find((take) => take.analysis?.sections?.length);
    if (!scored) return null;
    return scored.analysis.sections
      .filter((section) => Number.isFinite(section.pocket_score) && section.end > section.start)
      .sort((a, b) => a.pocket_score - b.pocket_score)[0] || null;
  }

  function renderPracticePrescription() {
    const copy = $("#practice-prescription");
    const weak = weakestSection();
    if (weak) {
      const bias = weak.timing_bias && weak.timing_bias !== "centered" ? `; you are ${weak.timing_bias}` : "";
      copy.innerHTML = `Suggested next: <button type="button" id="practice-weakest">${app.escapeHtml(weak.label)}</button> scored ${weak.pocket_score}. Loop it at ${Math.round((settings().trainer_start ?? .6) * 100)}%${bias}.`;
      $("#practice-weakest").addEventListener("click", () => {
        app.setLoopRange?.(weak.start, weak.end);
        app.toast(`${weak.label} loaded as your next drill`);
      });
      return;
    }
    copy.textContent = app.getLoopRange?.()
      ? "Your A/B loop is ready. GrooveSlate will repeat it and raise the tempo after clean passes."
      : "Set an A/B loop above, drag measures in Tabs, or loop a chart section to begin.";
  }

  function drillName(range) {
    const markers = practiceState.session?.markers || [];
    const marker = [...markers].reverse().find((item) => item.time <= range.start + .25);
    return marker?.label || `Loop ${app.formatTime(range.start)}–${app.formatTime(range.end)}`;
  }

  function renderDrillHistory() {
    const list = $("#drill-history");
    const drills = (practiceState.session?.drills || []).slice(-8).reverse();
    if (!drills.length) {
      list.innerHTML = "<span>No mastered loops yet. Completed drills appear here.</span>";
      return;
    }
    list.innerHTML = drills.map((drill, index) => `
      <button type="button" data-history-drill="${index}" title="Load this mastered loop">
        <b>✓ ${app.escapeHtml(drill.name)}</b>
        <small>${Math.round(drill.start_speed * 100)}→${Math.round(drill.goal_speed * 100)}% · ${new Date(drill.completed_at).toLocaleDateString()}</small>
      </button>`).join("");
    $$('[data-history-drill]', list).forEach((button) => button.addEventListener("click", () => {
      const drill = drills[Number(button.dataset.historyDrill)];
      app.setLoopRange?.(drill.start, drill.end);
      app.setPlaybackRate?.(drill.goal_speed);
      app.toast(`${drill.name} loaded at mastered tempo`);
    }));
  }

  function setTrainerProgress() {
    const trainer = practiceState.trainer;
    const start = Number(settings().trainer_start) || .6;
    const goal = Math.max(start, Number(settings().trainer_goal) || 1);
    const progress = goal === start ? 100 : (trainer.rate - start) / (goal - start) * 100;
    $("#trainer-progress-fill").style.width = `${Math.max(0, Math.min(100, progress))}%`;
    const stage = $("#trainer-stage");
    stage.classList.toggle("active", trainer.active);
    stage.textContent = trainer.active
      ? `${Math.round(trainer.rate * 100)}% · PASS ${trainer.passes + 1}/${settings().trainer_passes}`
      : trainer.completed ? "MASTERED" : "READY";
    $("#start-trainer").innerHTML = trainer.active ? "Stop drill <span>■</span>" : "Start guided drill <span>▶</span>";
  }

  async function toggleTrainer() {
    if (practiceState.trainer.active) {
      practiceState.trainer.active = false;
      practiceState.audio?.pause();
      setTrainerProgress();
      return;
    }
    const range = app.getLoopRange?.();
    if (!range) return app.toast("Set an A/B loop or choose a chart section first");
    const start = Number(settings().trainer_start) || .6;
    const goal = Number(settings().trainer_goal) || 1;
    if (goal < start) return app.toast("Trainer goal must be at least the starting speed");
    practiceState.trainer = { active: true, completed: false, passes: 0, rate: start };
    app.setPlaybackRate?.(start);
    practiceState.audio.currentTime = range.start;
    setTrainerProgress();
    try {
      await runCountIn();
      await practiceState.audio.play();
    } catch (error) {
      practiceState.trainer.active = false;
      setTrainerProgress();
      app.toast(error.message);
    }
  }

  function advanceTrainer() {
    const trainer = practiceState.trainer;
    if (!trainer.active) return;
    trainer.passes += 1;
    const passesNeeded = Number(settings().trainer_passes) || 2;
    if (trainer.passes >= passesNeeded) {
      trainer.passes = 0;
      const goal = Number(settings().trainer_goal) || 1;
      if (trainer.rate >= goal - .001) {
        trainer.active = false;
        trainer.completed = true;
        practiceState.audio.pause();
        const range = app.getLoopRange?.();
        if (range) {
          practiceState.session.drills = practiceState.session.drills || [];
          practiceState.session.drills.push({
            name: drillName(range), start: range.start, end: range.end,
            start_speed: Number(settings().trainer_start) || .6,
            goal_speed: goal, completed_at: new Date().toISOString(),
          });
          practiceState.session.drills = practiceState.session.drills.slice(-100);
          renderDrillHistory();
          scheduleSave();
        }
        app.toast(`Drill complete at ${Math.round(goal * 100)}% — record a full take next`);
      } else {
        trainer.rate = Math.min(goal, trainer.rate + (Number(settings().trainer_step) || .05));
        app.setPlaybackRate?.(trainer.rate);
        app.toast(`Clean set — moving to ${Math.round(trainer.rate * 100)}%`);
      }
    }
    setTrainerProgress();
  }

  function renderTakes() {
    const takes = practiceState.session?.takes || [];
    $("#takes-count").textContent = takes.length;
    const list = $("#takes-list");
    if (!takes.length) {
      list.innerHTML = "<p>No takes yet. The first one does not need to be perfect.</p>";
      app.updateChallengeProgress?.(practiceState.session);
      return;
    }
    const scored = takes.filter((take) => Number.isFinite(take.analysis?.pocket_score));
    const bestScore = scored.length ? Math.max(...scored.map((take) => take.analysis.pocket_score)) : null;
    list.innerHTML = takes.map((take, index) => {
      const analysis = take.analysis;
      const previous = takes[index + 1]?.analysis?.pocket_score;
      const delta = Number.isFinite(analysis?.pocket_score) && Number.isFinite(previous)
        ? analysis.pocket_score - previous : null;
      return `
      <article class="take-row">
        <button class="best-take ${take.best ? "active" : ""}" data-best-take="${take.id}" type="button" title="${take.best ? "Best take" : "Mark as best take"}">★</button>
        <div class="take-copy"><strong>${app.escapeHtml(take.name)}</strong><small>${new Date(take.created_at).toLocaleString()}${take.notes ? ` · ${app.escapeHtml(take.notes)}` : ""}</small>${analysis ? `<span class="take-score"><b>${analysis.pocket_score}</b> POCKET${delta === null ? "" : ` · ${delta >= 0 ? "+" : ""}${delta} VS PRIOR`}${analysis.pocket_score === bestScore ? " · TOP SCORE" : ""}</span>` : ""}</div>
        ${String(take.mime_type || "").startsWith("video/")
          ? `<video controls playsinline preload="metadata" src="${app.escapeHtml(take.audio_url)}"></video>`
          : `<audio controls preload="metadata" src="${app.escapeHtml(take.audio_url)}"></audio>`}
        <div class="take-actions">${take.publication ? `<button class="published-take" data-unpublish-take="${take.publication.id}" type="button" title="Published to Community Takes; click to make private">PUBLIC</button>` : `<button data-publish-take="${take.id}" type="button" title="Publish this take for other signed-in drummers to score">PUBLISH</button>`}${take.midi_url ? `<a href="${app.escapeHtml(take.midi_url)}" title="Download editable MIDI">MIDI</a>` : ""}<a href="${app.escapeHtml(take.download_url)}" title="Download take">AUDIO</a><button data-delete-take="${take.id}" type="button" title="Delete take">×</button></div>
        ${analysis ? `<details class="performance-detail"><summary>Performance map &amp; section analysis <span>${analysis.hit_count} hits · ${analysis.mean_offset_ms}ms mean grid error · ${analysis.timing_bias || "timing mapped"}</span></summary><canvas class="take-performance-map" data-take-map="${take.id}" tabindex="0" aria-label="Waveform-aligned MIDI hits"></canvas><div class="performance-stats"><span><b>${analysis.velocity.average ?? "—"}</b> AVG VELOCITY</span><span><b>${analysis.velocity.consistency ?? "—"}</b> DYNAMIC CONTROL</span><span><b>${analysis.signed_offset_ms == null ? "—" : `${analysis.signed_offset_ms > 0 ? "+" : ""}${analysis.signed_offset_ms}ms`}</b> ${analysis.timing_bias === "rushing" ? "EARLY / RUSH" : analysis.timing_bias === "dragging" ? "LATE / DRAG" : "TIMING CENTER"}</span><span><b>${analysis.timing_spread_ms ?? "—"}ms</b> TIMING SPREAD</span></div>${analysis.reference ? `<div class="reference-grade"><strong>${analysis.reference.accuracy}%</strong><span>SCORE ACCURACY</span><b>${analysis.reference.matched_hits} matched</b><b>${analysis.reference.missed_hits} missed</b><b>${analysis.reference.extra_hits} extra</b><small>${app.escapeHtml(analysis.reference.confidence || "authored score")} · ±${analysis.reference.tolerance_ms}ms</small></div>` : ""}<div class="section-scores">${analysis.sections.map((section) => `<button type="button" data-drill-start="${section.start}" data-drill-end="${section.end}" title="Practice this section"><b>${app.escapeHtml(section.label)}</b><i>${section.hits} hits · ${section.reference ? `${section.reference.missed_hits} missed` : section.timing_bias || "mapped"}</i><strong>${section.reference?.accuracy ?? section.pocket_score ?? "—"}</strong></button>`).join("")}</div><p class="analysis-note">Pocket measures timing against the configured sixteenth-note grid. When an authored drum score is selected, score accuracy also compares matching kit pieces and reports missed and extra hits. Click any section to drill it.</p></details>` : ""}
      </article>`;
    }).join("");
    $$(".take-row audio, .take-row video", list).forEach((player) => player.addEventListener("play", () => {
      practiceState.audio?.pause();
      $$(".take-row audio, .take-row video", list).forEach((other) => { if (other !== player) other.pause(); });
    }));
    $$('[data-best-take]', list).forEach((button) => button.addEventListener("click", () => updateTake(button.dataset.bestTake, { best: true })));
    $$('[data-publish-take]', list).forEach((button) => button.addEventListener("click", () => publishTake(button.dataset.publishTake)));
    $$('[data-unpublish-take]', list).forEach((button) => button.addEventListener("click", () => unpublishTake(button.dataset.unpublishTake)));
    $$('[data-delete-take]', list).forEach((button) => button.addEventListener("click", async () => {
      if (!window.confirm("Delete this recorded take?")) return;
      try {
        practiceState.session = await app.api(`/api/jobs/${practiceState.job.id}/practice/takes/${button.dataset.deleteTake}`, { method: "DELETE" });
        renderTakes();
        app.refreshPracticeLibrary();
      } catch (error) { app.toast(error.message); }
    }));
    $$('[data-take-map]', list).forEach((canvas) => loadTakePerformance(canvas));
    $$('[data-drill-start]', list).forEach((button) => button.addEventListener("click", () => {
      app.setLoopRange?.(Number(button.dataset.drillStart), Number(button.dataset.drillEnd));
      setPanel("practice");
      app.toast("Weak section loaded into Guided Drill");
    }));
    renderPracticePrescription();
    app.updateChallengeProgress?.(practiceState.session);
  }

  async function publishTake(takeId) {
    if (!window.confirm("Publish this finished take to Community Takes? Other signed-in users will be able to hear and score it.")) return;
    try {
      await app.api(`/api/jobs/${practiceState.job.id}/practice/takes/${takeId}/publish`, { method: "POST" });
      practiceState.session = await app.api(`/api/jobs/${practiceState.job.id}/practice`);
      renderTakes(); app.refreshCommunity?.(); app.toast("Take published — scoring is now open");
    } catch (error) { app.toast(error.message); }
  }

  async function unpublishTake(publicationId) {
    if (!window.confirm("Make this take private again? Existing scores will be removed.")) return;
    try {
      await app.api(`/api/community/${publicationId}`, { method: "DELETE" });
      practiceState.session = await app.api(`/api/jobs/${practiceState.job.id}/practice`);
      renderTakes(); app.refreshCommunity?.(); app.toast("Take is private again");
    } catch (error) { app.toast(error.message); }
  }

  async function loadTakePerformance(canvas) {
    const take = practiceState.session.takes.find((item) => item.id === canvas.dataset.takeMap);
    if (!take?.events_url) return;
    try {
      if (!take._events) take._events = (await app.api(take.events_url)).events;
      drawTakePerformance(canvas, take);
      canvas.closest("details")?.addEventListener("toggle", (event) => {
        if (event.currentTarget.open) window.requestAnimationFrame(() => drawTakePerformance(canvas, take));
      });
      canvas.addEventListener("click", (event) => {
        const player = canvas.closest(".take-row").querySelector("audio, video");
        const rect = canvas.getBoundingClientRect();
        player.currentTime = Math.max(0, Math.min(take.duration, (event.clientX - rect.left) / rect.width * take.duration));
      });
    } catch { canvas.setAttribute("aria-label", "MIDI performance map unavailable"); }
  }

  function drawTakePerformance(canvas, take) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(rect.width * ratio); canvas.height = Math.round(112 * ratio);
    const context = canvas.getContext("2d"); context.scale(ratio, ratio);
    const width = rect.width; const height = 112;
    context.fillStyle = "rgba(255,255,255,.025)"; context.fillRect(0, 0, width, height);
    const peaks = practiceState.waveform?.peaks || [];
    context.fillStyle = "rgba(255,255,255,.12)";
    for (let x = 0; x < width && peaks.length; x += 2) {
      const peak = peaks[Math.min(peaks.length - 1, Math.floor(x / width * peaks.length))];
      context.fillRect(x, height / 2 - peak * 30, 1, Math.max(1, peak * 60));
    }
    const colors = { kick: "#f05a2a", snare: "#f7d154", "hi-hat": "#6dd6bd", tom: "#8ba7ff", crash: "#e68cff", ride: "#c3a5ff", other: "#a6a39f" };
    const family = (note) => ([35,36].includes(note) ? "kick" : [31,34,37,38,39,40].includes(note) ? "snare" : [22,26,42,44,46].includes(note) ? "hi-hat" : [41,43,45,47,48,50].includes(note) ? "tom" : [49,52,55,57].includes(note) ? "crash" : [51,53,59].includes(note) ? "ride" : "other");
    for (const marker of practiceState.session.markers || []) {
      const x = marker.time / take.duration * width;
      context.fillStyle = "rgba(240,90,42,.32)"; context.fillRect(x, 0, 1, height);
      context.fillStyle = "rgba(255,255,255,.55)"; context.font = "9px DM Mono"; context.fillText(marker.label.toUpperCase(), Math.min(width - 55, x + 4), 11);
    }
    for (const event of take._events.filter((item) => item.kind === "note")) {
      const x = event.time_ms / 1000 / take.duration * width;
      const piece = family(event.note); const lane = { crash: 0, ride: 1, "hi-hat": 2, tom: 3, snare: 4, kick: 5, other: 3 }[piece];
      const y = 22 + lane * 14;
      context.fillStyle = colors[piece]; context.globalAlpha = .35 + event.velocity / 127 * .65;
      context.fillRect(x, y, 2, 5 + event.velocity / 127 * 7);
    }
    context.globalAlpha = 1;
  }

  async function updateTake(takeId, update) {
    try {
      practiceState.session = await app.api(`/api/jobs/${practiceState.job.id}/practice/takes/${takeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });
      renderTakes();
      app.refreshPracticeLibrary();
      app.toast("Best take updated");
    } catch (error) { app.toast(error.message); }
  }

  async function loadPractice(job) {
    if (practiceState.job?.id === job.id && practiceState.session) return;
    practiceState.job = job;
    practiceState.audio = app.getPracticeAudio();
    try {
      practiceState.session = await app.api(`/api/jobs/${job.id}/practice`);
      const linkedOffset = Number(new URLSearchParams(window.location.search).get("offset"));
      if (Number.isFinite(linkedOffset) && linkedOffset >= -120 && linkedOffset <= 120
          && new URLSearchParams(window.location.search).has("offset")) {
        practiceState.session.settings.score_offset_seconds = linkedOffset;
      }
      studio.classList.remove("hidden");
      renderMarkers();
      renderSettings();
      renderTakes();
      bindAudio();
      loadWaveform(job.id);
      if ("mediaSession" in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: job.track.title,
          artist: job.track.folder?.split("/")[0] || "GrooveSlate practice",
          album: "GrooveSlate Practice Studio",
        });
      }
    } catch (error) {
      studio.classList.add("hidden");
      app.toast(error.message);
    }
  }

  function bindAudio() {
    const audio = practiceState.audio;
    if (!audio || audio._workbenchBound) return;
    audio._workbenchBound = true;
    audio.addEventListener("loadedmetadata", renderSongMap);
    audio.addEventListener("timeupdate", () => {
      $("#marker-playhead").textContent = app.formatTime(audio.currentTime);
      const markers = practiceState.session?.markers || [];
      let active = null;
      for (const marker of markers) {
        if (marker.time <= audio.currentTime + 0.1) active = marker.id;
        else break;
      }
      $$(".song-map-marker").forEach((button) => button.classList.toggle("active", button.dataset.markerId === active));
      updateWaveformPlayhead();
      updateCueStrip();
      sendScoreClock();
    });
    audio.addEventListener("play", () => {
      requestWakeLock();
      if (settings().metronome && !practiceState.recorder) startMetronome();
      runScoreClock();
    });
    audio.addEventListener("pause", () => {
      stopMetronome(); releaseWakeLock();
      window.cancelAnimationFrame(practiceState.scoreClockFrame);
      sendScoreClock(true);
    });
    audio.addEventListener("seeked", () => sendScoreClock(true));
    audio.addEventListener("ratechange", () => sendScoreClock(true));
    audio.addEventListener("ended", () => { if (practiceState.recorder?.state === "recording") stopRecording(); });
  }

  async function requestWakeLock() {
    if (!navigator.wakeLock || practiceState.wakeLock) return;
    try {
      practiceState.wakeLock = await navigator.wakeLock.request("screen");
      practiceState.wakeLock.addEventListener("release", () => { practiceState.wakeLock = null; });
    } catch {
      // Screen wake lock is a convenience and should never block practice.
    }
  }

  function releaseWakeLock() {
    if (!practiceState.wakeLock) return;
    practiceState.wakeLock.release().catch(() => {});
    practiceState.wakeLock = null;
  }

  async function ensureAudioContext() {
    if (!practiceState.audioContext) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) throw new Error("This browser does not support the recording studio");
      const context = new AudioContext({ latencyHint: 0.001 });
      practiceState.audioContext = context;
      practiceState.mixDestination = context.createMediaStreamDestination();
      practiceState.backingGain = context.createGain();
      practiceState.mediaSource = context.createMediaElementSource(practiceState.audio);
      practiceState.mediaSource.connect(practiceState.backingGain);
      practiceState.backingGain.connect(context.destination);
      practiceState.backingGain.connect(practiceState.mixDestination);
      practiceState.backingGain.gain.value = 1;
    }
    await practiceState.audioContext.resume();
    return practiceState.audioContext;
  }

  function connectToDrumOutputs(node) {
    node.connect(practiceState.audioContext.destination);
    if (practiceState.recorder?.state === "recording") node.connect(practiceState.mixDestination);
  }

  function noiseBuffer(duration = 1) {
    const context = practiceState.audioContext;
    const buffer = context.createBuffer(1, context.sampleRate * duration, context.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < channel.length; index += 1) channel[index] = Math.random() * 2 - 1;
    return buffer;
  }

  async function ensureDrumSamples() {
    if (practiceState.drumSamples.size) return practiceState.drumSamples;
    if (practiceState.samplePromise) return practiceState.samplePromise;
    practiceState.samplePromise = (async () => {
      const context = await ensureAudioContext();
      const files = {
        "kick-soft": ["AcousticBassDrum/LV1.wav", "AcousticBassDrum/LV2.wav"],
        "kick-mid": ["AcousticBassDrum/MV1.wav", "AcousticBassDrum/MV2.wav"],
        "kick-hard": ["AcousticBassDrum/HV1.wav", "AcousticBassDrum/HV2.wav", "AcousticBassDrum/HV3.wav", "AcousticBassDrum/HV4.wav"],
        // HV1 is the exact rock snare heard on the first onscreen-pad hit.
        // A single source guarantees soft notes are literally quieter versions
        // of the same recording instead of a different round-robin timbre.
        "snare-hard": ["AcousticSnare/HV1.wav"],
        rim: ["SideStick/01.wav", "SideStick/02.wav", "SideStick/03.wav", "SideStick/04.wav"],
        "closed-hat": ["ClosedHiHat/01.wav", "ClosedHiHat/02.wav", "ClosedHiHat/03.wav", "ClosedHiHat/04.wav", "ClosedHiHat/05.wav", "ClosedHiHat/06.wav", "ClosedHiHat/07.wav"],
        "pedal-hat": ["PedalHiHat/01.wav"],
        "open-hat": ["OpenHiHat/01.wav", "OpenHiHat/02.wav", "OpenHiHat/03.wav", "OpenHiHat/04.wav"],
        "floor-tom": ["LowTom/01.wav", "LowTom/02.wav"],
        "mid-tom": ["MidTom/01.wav", "MidTom/02.wav", "MidTom/03.wav"],
        "high-tom": ["HighTom/01.wav", "HighTom/02.wav", "HighTom/03.wav"],
        crash: ["CrashCymbal1/01.wav", "CrashCymbal1/02.wav", "CrashCymbal2/01.wav"],
        ride: ["RideCymbal1/MV1.wav", "RideCymbal1/MV2.wav", "RideCymbal1/MV3.wav", "RideCymbal1/HV1.wav", "RideCymbal1/HV2.wav"],
        "ride-alt": ["RideCymbal2/MV1.wav", "RideCymbal2/MV2.wav", "RideCymbal2/MV3.wav", "RideCymbal2/HV1.wav", "RideCymbal2/HV2.wav"],
        bell: ["RideBell/01.wav", "RideBell/02.wav", "RideBell/03.wav", "RideBell/04.wav"],
      };
      const entries = Object.entries(files).flatMap(([name, paths]) => paths.map((path, index) => [`${name}:${index}`, path]));
      const loaded = await Promise.all(entries.map(async ([key, path]) => {
        const response = await fetch(`/drum-kit/studio/${path}`);
        if (!response.ok) throw new Error("The sampled drum kit could not be loaded");
        return [key, await context.decodeAudioData(await response.arrayBuffer())];
      }));
      loaded.forEach(([name, buffer]) => practiceState.drumSamples.set(name, buffer));
      practiceState.sampleGroups.clear();
      loaded.forEach(([key, buffer]) => {
        const group = key.slice(0, key.lastIndexOf(":"));
        if (!practiceState.sampleGroups.has(group)) practiceState.sampleGroups.set(group, []);
        practiceState.sampleGroups.get(group).push(buffer);
      });
      return practiceState.drumSamples;
    })().catch((error) => {
      practiceState.samplePromise = null;
      throw error;
    });
    return practiceState.samplePromise;
  }

  function sampleForNote(note) {
    const override = practiceState.midiOverrides.get(note);
    if (override) return instrumentDefinition(override);
    if ([35, 36].includes(note)) return ["kick", 1, "kick"];
    if (note === 37) return ["rim", 1, "snare"];
    // Many e-drum modules use 40 for the snare head or a second snare zone,
    // despite General MIDI calling it "electric snare". Keep every normal
    // snare zone on the same unpitched acoustic rock snare as the onscreen pad.
    if ([31, 34, 38, 40].includes(note)) return ["snare", 1, "snare"];
    if (note === 44) return ["pedal-hat", 1, "hat"];
    if (note === 42) return ["closed-hat", 1, "hat"];
    if (note === 46) return [practiceState.hiHatPedal > 80 ? "closed-hat" : "open-hat", 1, "hat"];
    if ([49, 52, 55, 57].includes(note)) return ["crash", 1, "cymbal"];
    if (note === 53) return ["bell", 1, "cymbal"];
    if ([51, 59].includes(note)) return ["ride", 1, "cymbal"];
    if ([48, 50].includes(note)) return ["high-tom", note === 50 ? 1.12 : .94];
    if ([45, 47].includes(note)) return ["mid-tom", note === 47 ? 1.04 : .9];
    if ([41, 43].includes(note)) return ["floor-tom", note === 43 ? 1.12 : .94];
    return null;
  }

  function instrumentDefinition(instrument) {
    const definitions = {
      kick: ["kick", 1, "kick"], snare: ["snare", 1, "snare"], rim: ["rim", 1, "snare"],
      "closed-hat": ["closed-hat", 1, "hat"], "open-hat": ["open-hat", 1, "hat"],
      crash: ["crash", 1, "cymbal"], ride: ["ride", 1, "cymbal"], bell: ["bell", 1, "cymbal"],
      "high-tom": ["high-tom", 1, "tom"], "mid-tom": ["mid-tom", 1, "tom"], "floor-tom": ["floor-tom", 1, "tom"],
    };
    return definitions[instrument] || null;
  }

  function selectSample(name, velocity) {
    let group = name;
    if (name === "kick") group = velocity < 57 ? "kick-soft" : velocity < 90 ? "kick-mid" : "kick-hard";
    // The low-velocity FreePats snare layer has a much thinner electronic
    // character. Preserve touch through gain, not an abrupt sample-family swap.
    if (name === "snare") group = "snare-hard";
    let options = practiceState.sampleGroups.get(group) || [];
    if (name === "ride") options = [...options, ...(practiceState.sampleGroups.get("ride-alt") || [])];
    if (!options.length) return null;
    const next = practiceState.sampleCounters.get(group) || 0;
    practiceState.sampleCounters.set(group, next + 1);
    return options[next % options.length];
  }

  function choke(group, release = .012) {
    const previous = practiceState.chokeSources.get(group);
    if (!previous) return;
    const now = practiceState.audioContext.currentTime;
    previous.gain.gain.cancelScheduledValues(now);
    previous.gain.gain.setTargetAtTime(0, now, release);
    previous.source.stop(now + release * 6);
    practiceState.chokeSources.delete(group);
  }

  function playSample(note, velocity) {
    const definition = sampleForNote(note);
    if (!definition) return false;
    try {
      const [name, playbackRate, group] = definition;
      const buffer = selectSample(name, velocity);
      if (!buffer) return false;
      if (group === "hat") choke("hat");
      const source = practiceState.audioContext.createBufferSource();
      const gain = practiceState.audioContext.createGain();
      source.buffer = buffer;
      source.playbackRate.value = playbackRate;
      const floor = name === "snare" ? .14 : .06;
      const curve = name === "snare" ? .56 : .72;
      gain.gain.value = Math.max(floor, Math.min(1, (velocity / 127) ** curve));
      source.connect(gain); connectToDrumOutputs(gain); source.start(practiceState.audioContext.currentTime);
      if (name === "open-hat") practiceState.chokeSources.set("hat", { source, gain });
      return true;
    } catch {
      return false;
    }
  }

  function playDrum(note, velocity = 100) {
    const context = practiceState.audioContext;
    if (!context || !practiceState.sampleGroups.size) return false;
    const now = context.currentTime;
    const strength = Math.max(0.08, Math.min(1, velocity / 127));
    const sampled = playSample(note, velocity);
    if (!sampled && [35, 36].includes(note)) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.setValueAtTime(note === 36 ? 92 : 76, now);
      oscillator.frequency.exponentialRampToValueAtTime(42, now + .16);
      gain.gain.setValueAtTime(strength * 1.05, now);
      gain.gain.exponentialRampToValueAtTime(.001, now + .42);
      oscillator.connect(gain); connectToDrumOutputs(gain); oscillator.start(now); oscillator.stop(now + .45);
    } else if (!sampled && [38, 40, 37].includes(note)) {
      const noise = context.createBufferSource();
      const filter = context.createBiquadFilter();
      const gain = context.createGain();
      noise.buffer = noiseBuffer(.35); filter.type = "bandpass"; filter.frequency.value = 1900; filter.Q.value = .6;
      gain.gain.setValueAtTime(strength * .72, now); gain.gain.exponentialRampToValueAtTime(.001, now + .24);
      noise.connect(filter).connect(gain); connectToDrumOutputs(gain); noise.start(now); noise.stop(now + .28);
      const body = context.createOscillator(); const bodyGain = context.createGain();
      body.frequency.value = 185; bodyGain.gain.setValueAtTime(strength * .32, now); bodyGain.gain.exponentialRampToValueAtTime(.001, now + .13);
      body.connect(bodyGain); connectToDrumOutputs(bodyGain); body.start(now); body.stop(now + .15);
    } else if (!sampled && [41, 43, 45, 47, 48, 50].includes(note)) {
      const frequencies = { 41: 82, 43: 98, 45: 118, 47: 142, 48: 168, 50: 196 };
      const oscillator = context.createOscillator(); const gain = context.createGain();
      oscillator.frequency.setValueAtTime(frequencies[note], now); oscillator.frequency.exponentialRampToValueAtTime(frequencies[note] * .72, now + .3);
      gain.gain.setValueAtTime(strength * .75, now); gain.gain.exponentialRampToValueAtTime(.001, now + .55);
      oscillator.connect(gain); connectToDrumOutputs(gain); oscillator.start(now); oscillator.stop(now + .58);
    } else if (!sampled) {
      const open = [46, 49, 51, 52, 55, 57, 59].includes(note);
      const noise = context.createBufferSource(); const high = context.createBiquadFilter(); const gain = context.createGain();
      noise.buffer = noiseBuffer(open ? 2.2 : .18); high.type = "highpass"; high.frequency.value = [49, 52, 55, 57].includes(note) ? 4200 : 6500;
      gain.gain.setValueAtTime(strength * (open ? .42 : .3), now); gain.gain.exponentialRampToValueAtTime(.001, now + (open ? 1.8 : .12));
      noise.connect(high).connect(gain); connectToDrumOutputs(gain); noise.start(now); noise.stop(now + (open ? 2 : .16));
    }
    const pad = $(`[data-drum-note="${note}"]`);
    if (pad) { pad.classList.add("hit"); window.setTimeout(() => pad.classList.remove("hit"), 85); }
    return true;
  }

  function click(accent = false) {
    const context = practiceState.audioContext;
    if (!context) return;
    const oscillator = context.createOscillator(); const gain = context.createGain(); const now = context.currentTime;
    oscillator.frequency.value = accent ? 1320 : 920;
    gain.gain.setValueAtTime(.16, now); gain.gain.exponentialRampToValueAtTime(.001, now + .05);
    oscillator.connect(gain).connect(context.destination); oscillator.start(now); oscillator.stop(now + .06);
  }

  function startMetronome() {
    stopMetronome();
    let beat = 0;
    click(true);
    practiceState.metronomeTimer = window.setInterval(() => { beat += 1; click(beat % 4 === 0); }, 60_000 / settings().bpm);
  }

  function stopMetronome() {
    window.clearInterval(practiceState.metronomeTimer);
    practiceState.metronomeTimer = null;
  }

  async function runCountIn() {
    await ensureAudioContext();
    const beats = settings().count_in_bars * 4;
    if (!beats) return;
    const display = $("#countdown-display span");
    for (let beat = 0; beat < beats; beat += 1) {
      const remaining = beats - beat;
      display.textContent = remaining;
      click(beat % 4 === 0);
      await new Promise((resolve) => window.setTimeout(resolve, 60_000 / settings().bpm));
    }
    display.textContent = "GO";
    window.setTimeout(() => { if (!practiceState.recorder) display.textContent = "READY"; }, 600);
  }

  async function enableAudioInput() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Audio recording is not supported in this browser");
    practiceState.micStream?.getTracks().forEach((track) => track.stop());
    const deviceId = $("#audio-input-device").value;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
        latency: 0,
      },
      video: false,
    });
    practiceState.micStream = stream;
    const context = await ensureAudioContext();
    practiceState.micSource?.disconnect();
    practiceState.micSource = context.createMediaStreamSource(stream);
    practiceState.micSource.connect(practiceState.mixDestination);
    practiceState.analyser = context.createAnalyser();
    practiceState.analyser.fftSize = 256;
    practiceState.micSource.connect(practiceState.analyser);
    monitorLevel();
    await populateInputs();
    const track = stream.getAudioTracks()[0];
    $("#audio-input-status").textContent = `Audio ready · ${track.label || "default input"}`;
  }

  async function enableCamera() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera recording is not supported in this browser");
    practiceState.cameraStream?.getTracks().forEach((track) => track.stop());
    practiceState.cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: false,
    });
    const preview = $("#camera-preview");
    preview.srcObject = practiceState.cameraStream;
    preview.classList.remove("hidden");
    await preview.play().catch(() => {});
  }

  function disableCamera() {
    practiceState.cameraStream?.getTracks().forEach((track) => track.stop());
    practiceState.cameraStream = null;
    const preview = $("#camera-preview");
    preview.pause();
    preview.srcObject = null;
    preview.classList.add("hidden");
  }

  async function populateInputs() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const current = $("#audio-input-device").value;
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "audioinput");
    $("#audio-input-device").innerHTML = '<option value="">Default input</option>' + devices.map((device, index) => `<option value="${app.escapeHtml(device.deviceId)}">${app.escapeHtml(device.label || `Audio input ${index + 1}`)}</option>`).join("");
    if (devices.some((device) => device.deviceId === current)) $("#audio-input-device").value = current;
  }

  function monitorLevel() {
    window.cancelAnimationFrame(practiceState.levelFrame);
    if (!practiceState.analyser) return;
    const values = new Uint8Array(practiceState.analyser.frequencyBinCount);
    const draw = () => {
      practiceState.analyser.getByteTimeDomainData(values);
      let peak = 0;
      for (const value of values) peak = Math.max(peak, Math.abs(value - 128));
      $("#record-level-fill").style.width = `${Math.min(100, peak / 58 * 100)}%`;
      practiceState.levelFrame = window.requestAnimationFrame(draw);
    };
    draw();
  }

  async function connectMidi() {
    if (!navigator.requestMIDIAccess) throw new Error("Web MIDI needs Chrome or Edge on a secure connection");
    await ensureAudioContext();
    $("#midi-input-status").textContent = "Loading sampled Studio kit…";
    await ensureDrumSamples();
    practiceState.midiAccess = await navigator.requestMIDIAccess();
    const bind = () => {
      const inputs = [...practiceState.midiAccess.inputs.values()];
      inputs.forEach((input) => { input.onmidimessage = onMidiMessage; });
      const latency = Math.round(((practiceState.audioContext.baseLatency || 0) + (practiceState.audioContext.outputLatency || 0)) * 1000);
      $("#midi-input-status").textContent = inputs.length
        ? `MIDI ready · ${inputs.map((input) => input.name).join(", ")}${latency ? ` · ~${latency}ms audio path` : " · low-latency mode"}`
        : "MIDI access granted · connect or wake your e-kit";
    };
    practiceState.midiAccess.onstatechange = bind;
    bind();
  }

  function onMidiMessage(event) {
    const [status, note, velocity] = event.data;
    if ((status & 0xf0) === 0xb0 && note === 4) {
      practiceState.hiHatPedal = velocity;
      captureMidi({ kind: "cc", control: note, value: velocity, channel: status & 0x0f });
    }
    if ((status & 0xf0) === 0x90 && velocity > 0) {
      if (practiceState.snareCalibration) captureSnareCalibration(note);
      if (practiceState.midiLearnTarget) learnMidiNote(note);
      playDrum(note, velocity);
      captureMidi({ kind: "note", note, velocity, channel: status & 0x0f });
      const definition = sampleForNote(note);
      window.requestAnimationFrame(() => {
        $("#midi-last-hit").textContent = `Last MIDI hit: ${definition?.[0] || "unmapped"} · note ${note} · velocity ${velocity}`;
      });
    }
  }

  function midiMapSummary() {
    const summary = $("#midi-map-summary");
    if (!summary) return;
    const mappings = [...practiceState.midiOverrides.entries()];
    summary.textContent = mappings.length ? mappings.map(([note, name]) => `${note}→${name}`).join(" · ") : "Factory General MIDI map";
  }

  function learnMidiNote(note) {
    const instrument = practiceState.midiLearnTarget;
    practiceState.midiLearnTarget = null;
    practiceState.midiOverrides.set(note, instrument);
    try { localStorage.setItem("grooveslate-midi-map", JSON.stringify(Object.fromEntries(practiceState.midiOverrides))); } catch {}
    $("#arm-midi-learn").classList.remove("active");
    $("#arm-midi-learn").textContent = "Learn next hit";
    midiMapSummary();
    app.toast(`MIDI note ${note} is now ${instrument}`);
  }

  function saveMidiMap() {
    try { localStorage.setItem("grooveslate-midi-map", JSON.stringify(Object.fromEntries(practiceState.midiOverrides))); } catch {}
    midiMapSummary();
  }

  function captureSnareCalibration(note) {
    practiceState.snareCalibration.notes.add(note);
    practiceState.midiOverrides.set(note, "snare");
    saveMidiMap();
    $("#calibrate-snare").textContent = `Listening… notes ${[...practiceState.snareCalibration.notes].join(", ")}`;
  }

  function finishSnareCalibration() {
    const calibration = practiceState.snareCalibration;
    if (!calibration) return;
    window.clearTimeout(calibration.timer);
    practiceState.snareCalibration = null;
    $("#calibrate-snare").classList.remove("active");
    $("#calibrate-snare").textContent = "Calibrate snare";
    if (calibration.notes.size) app.toast(`Snare calibrated: MIDI note${calibration.notes.size === 1 ? "" : "s"} ${[...calibration.notes].join(", ")}`);
    else app.toast("No snare hits received — try calibration again");
  }

  function captureMidi(event) {
    if (practiceState.recorder?.state !== "recording" || !practiceState.audio) return;
    practiceState.midiEvents.push({ ...event, time_ms: Math.round(practiceState.audio.currentTime * 1000 * 100) / 100 });
  }

  async function triggerPad(note, velocity = 108) {
    await ensureAudioContext();
    await ensureDrumSamples();
    playDrum(note, velocity);
    captureMidi({ kind: "note", note, velocity, channel: 9 });
  }

  function supportedMimeType(withVideo = false) {
    const types = withVideo
      ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"]
      : ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"];
    return types
      .find((type) => window.MediaRecorder?.isTypeSupported(type)) || "";
  }

  async function recordTake() {
    if (practiceState.recorder?.state === "recording") return stopRecording();
    if (!window.MediaRecorder) return app.toast("This browser cannot record audio");
    const mode = $("#record-mode").value;
    try {
      $("#record-take").disabled = true;
      $("#record-status").textContent = "Preparing inputs…";
      await ensureAudioContext();
      if (["audio", "both"].includes(mode) && !practiceState.micStream) await enableAudioInput();
      if (["midi", "both"].includes(mode) && !practiceState.midiAccess) await connectMidi();
      const withVideo = $("#record-camera").checked;
      if (withVideo && !practiceState.cameraStream) await enableCamera();
      if (practiceState.micSource) {
        practiceState.micSource.disconnect();
        if (["audio", "both"].includes(mode)) practiceState.micSource.connect(practiceState.mixDestination);
        if (practiceState.analyser) practiceState.micSource.connect(practiceState.analyser);
      }
      practiceState.audio.pause(); practiceState.audio.currentTime = 0;
      $("#record-status").textContent = "Count-in…";
      await runCountIn();
      const mimeType = supportedMimeType(withVideo);
      practiceState.chunks = [];
      practiceState.midiEvents = [];
      const recordingStream = withVideo
        ? new MediaStream([
            ...practiceState.mixDestination.stream.getAudioTracks(),
            ...practiceState.cameraStream.getVideoTracks(),
          ])
        : practiceState.mixDestination.stream;
      practiceState.recorder = new MediaRecorder(recordingStream, mimeType ? {
        mimeType, audioBitsPerSecond: 192000, videoBitsPerSecond: 5_000_000,
      } : undefined);
      practiceState.recorder.ondataavailable = (event) => { if (event.data.size) practiceState.chunks.push(event.data); };
      practiceState.recorder.onstop = uploadTake;
      practiceState.recorder.start(250);
      practiceState.recordingStarted = performance.now();
      practiceState.recordingTimer = window.setInterval(updateRecordClock, 250);
      $("#record-take").classList.add("recording");
      $("#record-take span").textContent = "Stop & save take";
      $("#record-status").textContent = withVideo
        ? "Recording camera + backing + performance"
        : mode === "midi" ? "Recording backing + MIDI kit" : "Recording backing + drum input";
      $("#record-take").disabled = false;
      await practiceState.audio.play();
      if (settings().metronome) startMetronome();
    } catch (error) {
      $("#record-take").disabled = false;
      $("#record-status").textContent = "Could not start recording";
      app.toast(error.message);
    }
  }

  function updateRecordClock() {
    $("#record-clock").textContent = app.formatTime((performance.now() - practiceState.recordingStarted) / 1000);
  }

  function stopRecording() {
    if (practiceState.recorder?.state !== "recording") return;
    practiceState.audio.pause();
    stopMetronome();
    window.clearInterval(practiceState.recordingTimer);
    practiceState.recorder.stop();
    $("#record-take").disabled = true;
    $("#record-status").textContent = "Saving your take…";
  }

  async function uploadTake() {
    const recorder = practiceState.recorder;
    const duration = (performance.now() - practiceState.recordingStarted) / 1000;
    const mimeType = recorder.mimeType || "audio/webm";
    const blob = new Blob(practiceState.chunks, { type: mimeType });
    const form = new FormData();
    const video = mimeType.startsWith("video/");
    form.append("file", blob, video ? (mimeType.includes("mp4") ? "take.mp4" : "take.webm") : (mimeType.includes("mp4") ? "take.m4a" : "take.webm"));
    form.append("name", $("#take-name").value.trim() || `Take ${(practiceState.session.takes?.length || 0) + 1}`);
    form.append("notes", $("#take-notes").value.trim());
    form.append("duration", String(duration));
    form.append("midi_events", JSON.stringify(practiceState.midiEvents));
    const reference = practiceState.scoreReference?.hits || [];
    form.append("reference_events", JSON.stringify(reference.map((hit) => ({
      note: Number(hit.note),
      time_ms: Math.max(0, (Number(hit.time) + scoreOffset()) * 1000),
    }))));
    form.append("reference_confidence", practiceState.scoreReference?.confidence || "");
    try {
      practiceState.session = await app.api(`/api/jobs/${practiceState.job.id}/practice/takes`, { method: "POST", body: form });
      renderTakes();
      app.refreshPracticeLibrary();
      $("#take-name").value = ""; $("#take-notes").value = "";
      $("#record-status").textContent = "Take saved — listen back below";
      app.toast("Take saved to your practice library");
    } catch (error) {
      $("#record-status").textContent = "Take could not be saved";
      app.toast(error.message);
    } finally {
      practiceState.recorder = null;
      practiceState.chunks = [];
      practiceState.midiEvents = [];
      $("#record-take").disabled = false;
      $("#record-take").classList.remove("recording");
      $("#record-take span").textContent = "Record full take";
      $("#record-clock").textContent = "0:00";
    }
  }

  async function uploadExistingTake(file) {
    if (!file) return;
    const form = new FormData();
    form.append("file", file, file.name);
    form.append("name", $("#take-name").value.trim() || file.name.replace(/\.[^.]+$/, ""));
    form.append("notes", $("#take-notes").value.trim());
    form.append("duration", "0");
    form.append("midi_events", "[]");
    $("#record-status").textContent = `Uploading ${file.name}…`;
    try {
      practiceState.session = await app.api(`/api/jobs/${practiceState.job.id}/practice/takes`, { method: "POST", body: form });
      renderTakes(); app.refreshPracticeLibrary();
      $("#take-name").value = ""; $("#take-notes").value = "";
      $("#record-status").textContent = "Uploaded take saved privately";
      app.toast("Take uploaded — publish it when you are ready for scores");
    } catch (error) {
      $("#record-status").textContent = "Take upload failed"; app.toast(error.message);
    } finally { $("#take-upload").value = ""; }
  }

  $$("[data-workbench]").forEach((button) => button.addEventListener("click", () => setPanel(button.dataset.workbench)));
  $$("[data-next-workbench]").forEach((button) => button.addEventListener("click", () => setPanel(button.dataset.nextWorkbench)));
  $$("[data-marker-kind]").forEach((button) => button.addEventListener("click", () => addMarker(button.dataset.markerLabel, button.dataset.markerKind, button.dataset.markerNote || "")));
  $("#auto-map-song").addEventListener("click", autoMapSong);
  $("#copy-chart").addEventListener("click", copyChart);
  $("#print-chart").addEventListener("click", () => window.print());
  $("#marker-editor-form").addEventListener("submit", saveMarkerEdit);
  $("#close-marker-editor").addEventListener("click", () => $("#marker-editor").close());
  $("#editor-delete-marker").addEventListener("click", deleteEditedMarker);
  $("#marker-form").addEventListener("submit", (event) => {
    event.preventDefault();
    addMarker($("#marker-label").value, practiceState.markerKind, $("#marker-note").value);
    $("#marker-label").value = ""; $("#marker-note").value = "";
  });
  ["#practice-bpm", "#count-in-bars", "#metronome-enabled", "#backing-volume", "#score-sync-enabled",
    "#trainer-start", "#trainer-goal", "#trainer-step", "#trainer-passes"].forEach((selector) => {
    $(selector).addEventListener("change", () => {
      practiceState.session.settings = {
        ...practiceState.session.settings,
        bpm: Number($("#practice-bpm").value),
        count_in_bars: Number($("#count-in-bars").value),
        metronome: $("#metronome-enabled").checked,
        backing_volume: Number($("#backing-volume").value),
        score_sync: $("#score-sync-enabled").checked,
        score_offset_seconds: scoreOffset(),
        trainer_start: Number($("#trainer-start").value),
        trainer_goal: Number($("#trainer-goal").value),
        trainer_step: Number($("#trainer-step").value),
        trainer_passes: Number($("#trainer-passes").value),
      };
      practiceState.audio.volume = practiceState.session.settings.backing_volume;
      renderPracticePrescription();
      sendScoreClock(true);
      scheduleSave();
    });
  });
  $("#start-trainer").addEventListener("click", toggleTrainer);
  document.addEventListener("drumless:loop-pass", advanceTrainer);
  document.addEventListener("drumless:loop-changed", () => {
    renderPracticePrescription();
    sendScoreLoop();
  });
  document.addEventListener("drumless:rate-changed", () => sendScoreClock(true));
  $("#tap-tempo").addEventListener("click", () => {
    const now = performance.now();
    practiceState.tapTimes = practiceState.tapTimes.filter((time) => now - time < 2500);
    practiceState.tapTimes.push(now);
    if (practiceState.tapTimes.length > 1) {
      const gaps = practiceState.tapTimes.slice(1).map((time, index) => time - practiceState.tapTimes[index]);
      $("#practice-bpm").value = Math.max(30, Math.min(300, Math.round(60_000 / (gaps.reduce((a, b) => a + b) / gaps.length))));
      $("#practice-bpm").dispatchEvent(new Event("change"));
    }
  });
  $("#count-in-play").addEventListener("click", async () => {
    try { practiceState.audio.pause(); await runCountIn(); await practiceState.audio.play(); }
    catch (error) { app.toast(error.message); }
  });
  $("#refresh-inputs").addEventListener("click", () => enableAudioInput().catch((error) => app.toast(error.message)));
  $("#audio-input-device").addEventListener("change", () => { if (practiceState.micStream) enableAudioInput().catch((error) => app.toast(error.message)); });
  $("#connect-midi").addEventListener("click", () => connectMidi().catch((error) => app.toast(error.message)));
  $("#record-camera").addEventListener("change", (event) => {
    if (event.currentTarget.checked) enableCamera().catch((error) => {
      event.currentTarget.checked = false;
      app.toast(error.message);
    });
    else disableCamera();
  });
  $("#arm-midi-learn").addEventListener("click", () => {
    if (practiceState.midiLearnTarget) {
      practiceState.midiLearnTarget = null;
      $("#arm-midi-learn").classList.remove("active");
      $("#arm-midi-learn").textContent = "Learn next hit";
      return;
    }
    practiceState.midiLearnTarget = $("#midi-learn-target").value;
    $("#arm-midi-learn").classList.add("active");
    $("#arm-midi-learn").textContent = `Hit ${$("#midi-learn-target").selectedOptions[0].textContent} now…`;
  });
  $("#calibrate-snare").addEventListener("click", () => {
    if (practiceState.snareCalibration) return finishSnareCalibration();
    const calibration = { notes: new Set(), timer: null };
    practiceState.snareCalibration = calibration;
    calibration.timer = window.setTimeout(finishSnareCalibration, 7000);
    $("#calibrate-snare").classList.add("active");
    $("#calibrate-snare").textContent = "Play head soft → loud…";
    app.toast("For 7 seconds, play only snare-head strokes from soft to loud");
  });
  $("#reset-midi-map").addEventListener("click", () => {
    practiceState.midiOverrides.clear(); practiceState.midiLearnTarget = null;
    finishSnareCalibration();
    try { localStorage.removeItem("grooveslate-midi-map"); } catch {}
    $("#arm-midi-learn").classList.remove("active"); $("#arm-midi-learn").textContent = "Learn next hit";
    midiMapSummary(); app.toast("Factory MIDI map restored");
  });
  $$("[data-drum-note]").forEach((button) => button.addEventListener("pointerdown", () => triggerPad(Number(button.dataset.drumNote)).catch((error) => app.toast(error.message))));
  $("#record-take").addEventListener("click", recordTake);
  $("#take-upload").addEventListener("change", (event) => uploadExistingTake(event.target.files[0]));
  $("#song-map").addEventListener("pointerdown", (event) => {
    if (event.target.closest(".song-map-marker") || !practiceState.audio) return;
    const map = event.currentTarget;
    const seek = (pointerEvent) => {
      const rect = map.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (pointerEvent.clientX - rect.left) / rect.width));
      const duration = practiceState.audio.duration || practiceState.waveform?.duration;
      if (duration > 0) practiceState.audio.currentTime = ratio * duration;
    };
    seek(event);
    map.setPointerCapture?.(event.pointerId);
    const move = (moveEvent) => seek(moveEvent);
    const up = () => {
      map.removeEventListener("pointermove", move);
      map.removeEventListener("pointerup", up);
      map.removeEventListener("pointercancel", up);
    };
    map.addEventListener("pointermove", move);
    map.addEventListener("pointerup", up);
    map.addEventListener("pointercancel", up);
  });
  $("#cue-next").addEventListener("click", (event) => {
    if (event.currentTarget.dataset.markerId) seekToMarker(event.currentTarget.dataset.markerId);
  });
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(drawWaveform, 100);
  });

  const secureRecording = window.isSecureContext || ["localhost", "127.0.0.1"].includes(window.location.hostname);
  if (!secureRecording) {
    $("#secure-recording-warning").classList.remove("hidden");
    ["#record-take", "#refresh-inputs", "#connect-midi", "#record-camera"].forEach((selector) => { $(selector).disabled = true; });
    $("#record-status").textContent = "Open GrooveSlate over HTTPS to record";
  }

  document.addEventListener("drumless:practice-job", (event) => loadPractice(event.detail));
  document.addEventListener("drumless:open-score", () => setPanel("score"));
  document.addEventListener("drumless:mix-changed", (event) => {
    if (practiceState.job?.id === event.detail.jobId && event.detail.model === "roformer") {
      loadWaveform(event.detail.jobId, event.detail.excluded || [], event.detail.mixId || "");
    }
  });
  document.addEventListener("drumless:clear-job", () => {
    if (practiceState.recorder?.state === "recording") stopRecording();
    studio.classList.add("hidden");
    releaseWakeLock();
    disableCamera();
    window.cancelAnimationFrame(practiceState.scoreClockFrame);
    practiceState.scoreReady = false;
    practiceState.scoreReference = null;
    practiceState.job = null; practiceState.session = null; practiceState.waveform = null; practiceState.waveformJobId = null;
  });
  $("#reload-band-score").addEventListener("click", () => loadBandScore(true));
  $("#band-score-frame").addEventListener("load", () => {
    setScoreStatus("TABFORGE LOADED · CHOOSE A FULL SCORE");
    postToScore("grooveslate:hello", { version: 1 });
  });
  $("#align-score-now").addEventListener("click", () => {
    if (!practiceState.scoreReady) return app.toast("Open a full score first");
    postToScore("grooveslate:position-request", { requestId: "align" });
  });
  $("#practice-score-part").addEventListener("click", () => {
    const stem = app.muteStemForScorePart?.(practiceState.scoreTrack);
    if (stem) app.toast(`${stem} removed so you can play the selected score part`);
    else app.toast("This separation does not have a matching broad stem");
  });
  $("#nudge-score-back").addEventListener("click", () => saveScoreAlignment(scoreOffset() - .1));
  $("#nudge-score-forward").addEventListener("click", () => saveScoreAlignment(scoreOffset() + .1));
  $("#reset-score-alignment").addEventListener("click", () => saveScoreAlignment(0));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && practiceState.audio && !practiceState.audio.paused) requestWakeLock();
  });
  midiMapSummary();
})();
