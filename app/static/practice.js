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
    micSource: null,
    analyser: null,
    levelFrame: null,
    midiAccess: null,
    recorder: null,
    chunks: [],
    recordingStarted: 0,
    recordingTimer: null,
    metronomeTimer: null,
    tapTimes: [],
    markerKind: "section",
    waveform: null,
    waveformJobId: null,
    drumSamples: new Map(),
    samplePromise: null,
    sampleCounters: new Map(),
    chokeSources: new Map(),
    hiHatPedal: 127,
    wakeLock: null,
  };

  function setPanel(name) {
    $$("[data-workbench]").forEach((button) => button.classList.toggle("active", button.dataset.workbench === name));
    $$("[data-workbench-panel]").forEach((panel) => panel.classList.toggle("active", panel.dataset.workbenchPanel === name));
    if (name === "record") ensureDrumSamples().catch(() => {});
  }

  function settings() {
    return practiceState.session?.settings || { bpm: 120, count_in_bars: 2, metronome: false, backing_volume: 0.8 };
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
        body: JSON.stringify({ markers: practiceState.session.markers, settings: practiceState.session.settings }),
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
  }

  function updateWaveformPlayhead() {
    const duration = practiceState.audio?.duration || practiceState.waveform?.duration;
    const percent = duration > 0 ? Math.max(0, Math.min(100, practiceState.audio.currentTime / duration * 100)) : 0;
    $("#waveform-playhead").style.left = `${percent}%`;
  }

  async function loadWaveform(jobId) {
    practiceState.waveform = null;
    practiceState.waveformJobId = jobId;
    renderSongMap();
    try {
      const waveform = await app.api(`/api/jobs/${jobId}/waveform/roformer?points=1600`);
      if (practiceState.waveformJobId !== jobId) return;
      practiceState.waveform = waveform;
      renderSongMap();
    } catch {
      if (practiceState.waveformJobId !== jobId) return;
      const empty = $("#song-map-empty");
      empty.textContent = "Waveform unavailable · tap the timeline to seek";
      empty.classList.remove("hidden");
    }
  }

  function renderMarkers() {
    const list = $("#marker-list");
    const markers = practiceState.session?.markers || [];
    if (!markers.length) {
      list.innerHTML = '<div class="empty-library">Play the track and tap a section button when the music changes.</div>';
      renderSongMap();
      return;
    }
    list.innerHTML = markers.map((marker) => `
      <div class="marker-row" data-marker-row="${app.escapeHtml(marker.id)}">
        <button type="button" data-seek-marker="${app.escapeHtml(marker.id)}">${app.formatTime(marker.time)}</button>
        <span class="marker-kind">${app.escapeHtml(marker.kind)}</span>
        <span class="marker-copy"><strong>${app.escapeHtml(marker.label)}</strong>${marker.note ? `<small>${app.escapeHtml(marker.note)}</small>` : ""}</span>
        <button class="delete-marker" type="button" data-delete-marker="${app.escapeHtml(marker.id)}" aria-label="Delete ${app.escapeHtml(marker.label)}">×</button>
      </div>`).join("");
    $$('[data-seek-marker]', list).forEach((button) => button.addEventListener("click", () => seekToMarker(button.dataset.seekMarker)));
    $$('[data-delete-marker]', list).forEach((button) => button.addEventListener("click", () => {
      practiceState.session.markers = practiceState.session.markers.filter((marker) => marker.id !== button.dataset.deleteMarker);
      renderMarkers();
      scheduleSave();
    }));
    renderSongMap();
  }

  function seekToMarker(id) {
    const marker = practiceState.session?.markers.find((item) => item.id === id);
    if (!marker || !practiceState.audio) return;
    practiceState.audio.currentTime = marker.time;
    setPanel("listen");
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

  function renderSettings() {
    const value = settings();
    $("#practice-bpm").value = value.bpm;
    $("#count-in-bars").value = value.count_in_bars;
    $("#metronome-enabled").checked = value.metronome;
    $("#backing-volume").value = value.backing_volume;
    if (practiceState.audio) practiceState.audio.volume = value.backing_volume;
  }

  function renderTakes() {
    const takes = practiceState.session?.takes || [];
    $("#takes-count").textContent = takes.length;
    const list = $("#takes-list");
    if (!takes.length) {
      list.innerHTML = "<p>No takes yet. The first one does not need to be perfect.</p>";
      return;
    }
    list.innerHTML = takes.map((take) => `
      <article class="take-row">
        <button class="best-take ${take.best ? "active" : ""}" data-best-take="${take.id}" type="button" title="${take.best ? "Best take" : "Mark as best take"}">★</button>
        <div class="take-copy"><strong>${app.escapeHtml(take.name)}</strong><small>${new Date(take.created_at).toLocaleString()}${take.notes ? ` · ${app.escapeHtml(take.notes)}` : ""}</small></div>
        <audio controls preload="metadata" src="${app.escapeHtml(take.audio_url)}"></audio>
        <div class="take-actions"><a href="${app.escapeHtml(take.download_url)}" title="Download take">↓</a><button data-delete-take="${take.id}" type="button" title="Delete take">×</button></div>
      </article>`).join("");
    $$(".take-row audio", list).forEach((player) => player.addEventListener("play", () => {
      practiceState.audio?.pause();
      $$(".take-row audio", list).forEach((other) => { if (other !== player) other.pause(); });
    }));
    $$('[data-best-take]', list).forEach((button) => button.addEventListener("click", () => updateTake(button.dataset.bestTake, { best: true })));
    $$('[data-delete-take]', list).forEach((button) => button.addEventListener("click", async () => {
      if (!window.confirm("Delete this recorded take?")) return;
      try {
        practiceState.session = await app.api(`/api/jobs/${practiceState.job.id}/practice/takes/${button.dataset.deleteTake}`, { method: "DELETE" });
        renderTakes();
        app.refreshPracticeLibrary();
      } catch (error) { app.toast(error.message); }
    }));
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
      studio.classList.remove("hidden");
      renderMarkers();
      renderSettings();
      renderTakes();
      bindAudio();
      loadWaveform(job.id);
      if ("mediaSession" in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: job.track.title,
          artist: job.track.folder?.split("/")[0] || "Drumless practice",
          album: "Drumless Practice Studio",
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
    });
    audio.addEventListener("play", () => {
      requestWakeLock();
      if (settings().metronome && !practiceState.recorder) startMetronome();
    });
    audio.addEventListener("pause", () => { stopMetronome(); releaseWakeLock(); });
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
      const context = new AudioContext({ latencyHint: "interactive" });
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
    node.connect(practiceState.mixDestination);
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
        "snare-soft": ["AcousticSnare/LV1.wav", "AcousticSnare/LV2.wav"],
        "snare-hard": ["AcousticSnare/HV1.wav", "AcousticSnare/HV2.wav", "AcousticSnare/HV3.wav", "AcousticSnare/HV4.wav", "AcousticSnare/HV5.wav", "AcousticSnare/HV6.wav", "AcousticSnare/HV7.wav"],
        rim: ["SideStick/01.wav", "SideStick/02.wav", "SideStick/03.wav", "SideStick/04.wav"],
        "closed-hat": ["ClosedHiHat/01.wav", "ClosedHiHat/02.wav", "ClosedHiHat/03.wav", "ClosedHiHat/04.wav", "ClosedHiHat/05.wav", "ClosedHiHat/06.wav", "ClosedHiHat/07.wav"],
        "pedal-hat": ["PedalHiHat/01.wav"],
        "open-hat": ["OpenHiHat/01.wav", "OpenHiHat/02.wav", "OpenHiHat/03.wav", "OpenHiHat/04.wav"],
        "floor-tom": ["LowTom/01.wav", "LowTom/02.wav"],
        "mid-tom": ["MidTom/01.wav", "MidTom/02.wav", "MidTom/03.wav"],
        "high-tom": ["HighTom/01.wav", "HighTom/02.wav", "HighTom/03.wav"],
        crash: ["CrashCymbal1/01.wav", "CrashCymbal1/02.wav", "CrashCymbal2/01.wav"],
        ride: ["RideCymbal1/MV1.wav", "RideCymbal1/MV2.wav", "RideCymbal1/MV3.wav", "RideCymbal1/HV1.wav", "RideCymbal1/HV2.wav"],
        bell: ["RideBell/01.wav", "RideBell/02.wav", "RideBell/03.wav", "RideBell/04.wav"],
      };
      const entries = Object.entries(files).flatMap(([name, paths]) => paths.map((path, index) => [`${name}:${index}`, path]));
      const loaded = await Promise.all(entries.map(async ([key, path]) => {
        const response = await fetch(`/drum-kit/studio/${path}`);
        if (!response.ok) throw new Error("The sampled drum kit could not be loaded");
        return [key, await context.decodeAudioData(await response.arrayBuffer())];
      }));
      loaded.forEach(([name, buffer]) => practiceState.drumSamples.set(name, buffer));
      return practiceState.drumSamples;
    })().catch((error) => {
      practiceState.samplePromise = null;
      throw error;
    });
    return practiceState.samplePromise;
  }

  function sampleForNote(note) {
    if ([35, 36].includes(note)) return ["kick", 1, "kick"];
    if (note === 37) return ["rim", 1, "snare"];
    if ([38, 40].includes(note)) return ["snare", note === 40 ? 1.04 : 1, "snare"];
    if (note === 44) return ["pedal-hat", 1, "hat"];
    if (note === 42) return ["closed-hat", 1, "hat"];
    if (note === 46) return [practiceState.hiHatPedal > 80 ? "closed-hat" : "open-hat", 1, "hat"];
    if ([49, 52, 55, 57].includes(note)) return ["crash", 2 ** ((note - 49) / 24)];
    if (note === 53) return ["bell", 1, "cymbal"];
    if ([51, 59].includes(note)) return ["ride", 2 ** ((note - 51) / 24), "cymbal"];
    if ([48, 50].includes(note)) return ["high-tom", note === 50 ? 1.12 : .94];
    if ([45, 47].includes(note)) return ["mid-tom", note === 47 ? 1.04 : .9];
    if ([41, 43].includes(note)) return ["floor-tom", note === 43 ? 1.12 : .94];
    return null;
  }

  function selectSample(name, velocity) {
    let group = name;
    if (name === "kick") group = velocity < 57 ? "kick-soft" : velocity < 90 ? "kick-mid" : "kick-hard";
    if (name === "snare") group = velocity < 70 ? "snare-soft" : "snare-hard";
    const prefix = `${group}:`;
    const options = [...practiceState.drumSamples.entries()].filter(([key]) => key.startsWith(prefix));
    if (!options.length) return null;
    const next = practiceState.sampleCounters.get(group) || 0;
    practiceState.sampleCounters.set(group, next + 1);
    return options[next % options.length][1];
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

  async function playSample(note, velocity) {
    const definition = sampleForNote(note);
    if (!definition) return false;
    try {
      await ensureDrumSamples();
      const [name, playbackRate, group] = definition;
      const buffer = selectSample(name, velocity);
      if (!buffer) return false;
      if (group === "hat") choke("hat");
      const source = practiceState.audioContext.createBufferSource();
      const gain = practiceState.audioContext.createGain();
      source.buffer = buffer;
      source.playbackRate.value = playbackRate;
      gain.gain.value = Math.max(.06, Math.min(1, (velocity / 127) ** .72));
      source.connect(gain); connectToDrumOutputs(gain); source.start();
      if (name === "open-hat") practiceState.chokeSources.set("hat", { source, gain });
      return true;
    } catch {
      return false;
    }
  }

  async function playDrum(note, velocity = 100) {
    const context = await ensureAudioContext();
    const now = context.currentTime;
    const strength = Math.max(0.08, Math.min(1, velocity / 127));
    const sampled = await playSample(note, velocity);
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
    if ((status & 0xf0) === 0xb0 && note === 4) practiceState.hiHatPedal = velocity;
    if ((status & 0xf0) === 0x90 && velocity > 0) playDrum(note, velocity);
  }

  function supportedMimeType() {
    return ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"]
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
      if (practiceState.micSource) {
        practiceState.micSource.disconnect();
        if (["audio", "both"].includes(mode)) practiceState.micSource.connect(practiceState.mixDestination);
        if (practiceState.analyser) practiceState.micSource.connect(practiceState.analyser);
      }
      practiceState.audio.pause(); practiceState.audio.currentTime = 0;
      $("#record-status").textContent = "Count-in…";
      await runCountIn();
      const mimeType = supportedMimeType();
      practiceState.chunks = [];
      practiceState.recorder = new MediaRecorder(practiceState.mixDestination.stream, mimeType ? { mimeType, audioBitsPerSecond: 192000 } : undefined);
      practiceState.recorder.ondataavailable = (event) => { if (event.data.size) practiceState.chunks.push(event.data); };
      practiceState.recorder.onstop = uploadTake;
      practiceState.recorder.start(250);
      practiceState.recordingStarted = performance.now();
      practiceState.recordingTimer = window.setInterval(updateRecordClock, 250);
      $("#record-take").classList.add("recording");
      $("#record-take span").textContent = "Stop & save take";
      $("#record-status").textContent = mode === "midi" ? "Recording backing + MIDI kit" : "Recording backing + drum input";
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
    form.append("file", blob, mimeType.includes("mp4") ? "take.m4a" : "take.webm");
    form.append("name", $("#take-name").value.trim() || `Take ${(practiceState.session.takes?.length || 0) + 1}`);
    form.append("notes", $("#take-notes").value.trim());
    form.append("duration", String(duration));
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
      $("#record-take").disabled = false;
      $("#record-take").classList.remove("recording");
      $("#record-take span").textContent = "Record full take";
      $("#record-clock").textContent = "0:00";
    }
  }

  $$("[data-workbench]").forEach((button) => button.addEventListener("click", () => setPanel(button.dataset.workbench)));
  $$("[data-next-workbench]").forEach((button) => button.addEventListener("click", () => setPanel(button.dataset.nextWorkbench)));
  $$("[data-marker-kind]").forEach((button) => button.addEventListener("click", () => addMarker(button.dataset.markerLabel, button.dataset.markerKind)));
  $("#marker-form").addEventListener("submit", (event) => {
    event.preventDefault();
    addMarker($("#marker-label").value, practiceState.markerKind, $("#marker-note").value);
    $("#marker-label").value = ""; $("#marker-note").value = "";
  });
  ["#practice-bpm", "#count-in-bars", "#metronome-enabled", "#backing-volume"].forEach((selector) => {
    $(selector).addEventListener("change", () => {
      practiceState.session.settings = {
        bpm: Number($("#practice-bpm").value),
        count_in_bars: Number($("#count-in-bars").value),
        metronome: $("#metronome-enabled").checked,
        backing_volume: Number($("#backing-volume").value),
      };
      practiceState.audio.volume = practiceState.session.settings.backing_volume;
      scheduleSave();
    });
  });
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
  $$("[data-drum-note]").forEach((button) => button.addEventListener("pointerdown", () => playDrum(Number(button.dataset.drumNote), 108).catch((error) => app.toast(error.message))));
  $("#record-take").addEventListener("click", recordTake);
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
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(drawWaveform, 100);
  });

  const secureRecording = window.isSecureContext || ["localhost", "127.0.0.1"].includes(window.location.hostname);
  if (!secureRecording) {
    $("#secure-recording-warning").classList.remove("hidden");
    ["#record-take", "#refresh-inputs", "#connect-midi"].forEach((selector) => { $(selector).disabled = true; });
    $("#record-status").textContent = "Open Drumless over HTTPS to record";
  }

  document.addEventListener("drumless:practice-job", (event) => loadPractice(event.detail));
  document.addEventListener("drumless:clear-job", () => {
    if (practiceState.recorder?.state === "recording") stopRecording();
    studio.classList.add("hidden");
    releaseWakeLock();
    practiceState.job = null; practiceState.session = null; practiceState.waveform = null; practiceState.waveformJobId = null;
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && practiceState.audio && !practiceState.audio.paused) requestWakeLock();
  });
})();
