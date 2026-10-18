import { analyze, BUFFER_SIZE, createTracker, DEFAULTS } from "./engine.js";

const STORE_KEY = "universal-tuner-settings";

const app = document.querySelector("#app");
const start = document.querySelector("#start");
const startTitle = document.querySelector("#start-title");
const startSub = document.querySelector("#start-sub");
const readout = document.querySelector("#readout");
const letter = document.querySelector("#letter");
const aside = document.querySelector("#aside");
const accidental = document.querySelector("#accidental");
const octave = document.querySelector("#octave");
const centsNum = document.querySelector("#cents-num");
const detail = document.querySelector("#detail");
const thumb = document.querySelector("#thumb");
const zone = document.querySelector("#zone");
const live = document.querySelector("#live");
const statusLabel = document.querySelector("#status-label");
const a4Input = document.querySelector("#a4");
const a4Value = document.querySelector("#a4-value");
const windowInput = document.querySelector("#window");
const windowValue = document.querySelector("#window-value");
const steadyInput = document.querySelector("#steady");
const steadyValue = document.querySelector("#steady-value");
const spellButton = document.querySelector("#spell");
const hearButton = document.querySelector("#hear");
const hearNote = document.querySelector("#hear-note");

const tracker = createTracker();
const buffer = new Float32Array(BUFFER_SIZE);

let audioCtx = null;
let stream = null;
let analyser = null;
let listening = false;
let starting = false;
let hearing = false;
let resumeAt = 0;
let shownCents = 0;
let shownHz = null;
let shownNumber = null;
let lastAnnounced = "";
let lastAnnounceAt = 0;
let announcedNote = "";
let announcedInTune = false;
let tone = null;
let lastView = tracker.current();

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveSettings() {
  try {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        a4: Number(a4Input.value),
        tolerance: Number(windowInput.value),
        steadiness: Number(steadyInput.value),
        spell: spellButton.getAttribute("aria-pressed") === "true" ? "flat" : "sharp",
      }),
    );
  } catch {
    /* private mode */
  }
}

function steadyLabel(value) {
  if (value < 25) return "Quick";
  if (value < 50) return "Light";
  if (value < 80) return "Calm";
  return "Still";
}

function formatCents(value) {
  if (value > 0) return `+${value}`;
  if (value < 0) return `−${Math.abs(value)}`;
  return "0";
}

function formatHz(value) {
  return value >= 100 ? value.toFixed(1) : value.toFixed(2);
}

function centsPhrase(cents) {
  const amount = Math.abs(cents);
  const unit = amount === 1 ? "cent" : "cents";
  if (cents > 0) return `${amount} ${unit} sharp`;
  if (cents < 0) return `${amount} ${unit} flat`;
  return "";
}

function announcement(view, cents) {
  if (!view.active) return "";
  const offset = centsPhrase(cents);
  if (view.inTune) return offset ? `${view.name}, in tune, ${offset}` : `${view.name}, in tune`;
  return offset ? `${view.name}, ${offset}` : `${view.name}`;
}

function applySettingsFromInputs() {
  const spell = spellButton.getAttribute("aria-pressed") === "true" ? "flat" : "sharp";
  tracker.configure({
    a4: Number(a4Input.value),
    tolerance: Number(windowInput.value),
    steadiness: Number(steadyInput.value),
    spell,
  });
  a4Value.textContent = a4Input.value;
  windowValue.textContent = `±${windowInput.value}`;
  steadyValue.textContent = steadyLabel(Number(steadyInput.value));
  spellButton.textContent = spell === "flat" ? "♭" : "♯";
  spellButton.setAttribute(
    "aria-label",
    spell === "flat" ? "Using flat note names" : "Using sharp note names",
  );
  zone.style.width = `${Number(windowInput.value) * 2}%`;
  a4Input.setAttribute("aria-valuetext", `${a4Input.value} hertz`);
  windowInput.setAttribute("aria-valuetext", `plus or minus ${windowInput.value} cents`);
  steadyInput.setAttribute("aria-valuetext", steadyLabel(Number(steadyInput.value)));
  lastView = tracker.current();
  paint(lastView, true);
  if (tone) retuneTone(lastView.targetHz);
}

function paint(view, snap) {
  lastView = view;
  letter.textContent = view.letter;
  accidental.textContent = view.accidental;
  octave.textContent = view.octave == null ? "" : String(view.octave);
  aside.hidden = view.octave == null && !view.accidental;

  app.classList.toggle("is-live", view.active);
  app.classList.toggle("is-idle", !view.active);
  app.classList.toggle("is-holding", view.holding);
  app.classList.toggle("is-flat", view.active && view.status === "flat");
  app.classList.toggle("is-sharp", view.active && view.status === "sharp");
  app.classList.toggle("is-tune", view.active && view.status === "in-tune");

  if (!view.active) {
    centsNum.textContent = "";
    detail.textContent = "Play a note";
    shownNumber = null;
    shownHz = null;
  } else {
    if (shownHz == null || snap || Math.abs(view.hz - shownHz) >= 0.15) shownHz = view.hz;
    const rounded = Math.round(view.cents);
    if (shownNumber == null || snap || Math.abs(view.cents - shownNumber) >= 0.65) {
      shownNumber = rounded;
    }
    centsNum.textContent = formatCents(shownNumber);
    const word = view.status === "in-tune" ? "in tune" : view.status;
    detail.textContent = `${word} · ${formatHz(shownHz)} Hz`;
  }

  hearNote.textContent = view.targetName;
  hearButton.setAttribute("aria-label", hearing ? `Stop sounding ${view.targetName}` : `Hear ${view.targetName}`);

  const announce = announcement(view, view.active ? shownNumber : 0);
  const urgent = announce === "" || view.name !== announcedNote || Boolean(view.inTune) !== announcedInTune;
  if (announce !== lastAnnounced && (urgent || performance.now() - lastAnnounceAt >= 800)) {
    live.textContent = announce;
    lastAnnounced = announce;
    lastAnnounceAt = performance.now();
    announcedNote = view.name;
    announcedInTune = Boolean(view.inTune);
  }

  if (!view.active) shownCents = 0;
  else if (snap) shownCents = view.cents;
}

function context() {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}

function stopTone() {
  if (!tone) return;
  const { master, oscs, ctx } = tone;
  const now = ctx.currentTime;
  try {
    master.gain.cancelScheduledValues(now);
    const current = Math.max(master.gain.value, 0.0001);
    master.gain.setValueAtTime(current, now);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
    oscs.forEach((osc) => osc.stop(now + 0.06));
  } catch {
    /* already stopped */
  }
  tone = null;
  hearing = false;
  resumeAt = performance.now() + 180;
  hearButton.setAttribute("aria-pressed", "false");
  app.classList.remove("is-hearing");
}

function startTone(freq) {
  const ctx = context();
  if (ctx.state === "suspended") ctx.resume();
  stopTone();
  const now = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, now);
  master.gain.exponentialRampToValueAtTime(0.16, now + 0.02);
  master.connect(ctx.destination);

  const partials = [
    [1, 0.78],
    [2, freq < 170 ? 0.34 : 0.14],
    [3, freq < 170 ? 0.12 : 0.035],
  ];
  const oscs = partials.map(([mult, amp]) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq * mult;
    gain.gain.value = amp;
    osc.connect(gain).connect(master);
    osc.start(now);
    return osc;
  });
  tone = { master, oscs, ctx, partials };
  hearing = true;
  hearButton.setAttribute("aria-pressed", "true");
  app.classList.add("is-hearing");
}

function retuneTone(freq) {
  if (!tone) return;
  const now = tone.ctx.currentTime;
  tone.oscs.forEach((osc, index) => {
    osc.frequency.setTargetAtTime(freq * tone.partials[index][0], now, 0.02);
  });
}

function noteFromError(error) {
  if (error && (error.name === "NotAllowedError" || error.name === "PermissionDeniedError")) {
    return "The microphone is blocked. Allow it in the browser, then tap again.";
  }
  if (error && error.name === "NotFoundError") {
    return "No microphone was found.";
  }
  return "The microphone didn't start. Tap to try again.";
}

async function begin() {
  if (listening || starting) return;
  if (!window.isSecureContext) {
    startTitle.textContent = "Tap to tune";
    startSub.textContent = "Open this page over https so the microphone can be used.";
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    startTitle.textContent = "Tap to tune";
    startSub.textContent = "This browser has no microphone to use.";
    return;
  }

  starting = true;
  startSub.textContent = "Listening…";
  try {
    const ctx = context();
    if (ctx.state === "suspended") await ctx.resume();
    let nextStream;
    try {
      nextStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
    } catch {
      nextStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    stream = nextStream;
    const source = ctx.createMediaStreamSource(stream);
    const highpass = ctx.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = 12;
    highpass.Q.value = 0.707;
    analyser = ctx.createAnalyser();
    analyser.fftSize = BUFFER_SIZE;
    analyser.smoothingTimeConstant = 0;
    source.connect(highpass).connect(analyser);
    listening = true;
    app.classList.add("is-listening");
    start.hidden = true;
    readout.hidden = false;
    statusLabel.textContent = "Listening";
    paint(tracker.current(), true);
  } catch (error) {
    startTitle.textContent = "Tap to tune";
    startSub.textContent = noteFromError(error);
    statusLabel.textContent = "Microphone blocked";
  } finally {
    starting = false;
  }
}

function loop(now) {
  requestAnimationFrame(loop);

  if (listening && !hearing && now >= resumeAt && !document.hidden && analyser) {
    if (!loop.last || now - loop.last >= 45) {
      loop.last = now;
      analyser.getFloatTimeDomainData(buffer);
      const reading = analyze(buffer, audioCtx.sampleRate);
      const previous = `${lastView.name}:${lastView.status}`;
      const view = tracker.push({ ...reading, now });
      paint(view, `${view.name}:${view.status}` !== previous);
    }
  }

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const previousNow = loop.prev ?? now;
  loop.prev = now;
  const dt = Math.min(48, Math.max(8, now - previousNow));
  const target = lastView.active ? lastView.cents : 0;
  if (reduce || !lastView.active) shownCents = target;
  else {
    shownCents += (target - shownCents) * (1 - Math.exp(-dt / 90));
    if (Math.abs(shownCents - target) < 0.05) shownCents = target;
  }
  const clamped = Math.max(-50, Math.min(50, shownCents));
  thumb.style.left = `${clamped + 50}%`;
}

function boot() {
  const saved = loadSettings();
  a4Input.value = String(saved.a4 ?? DEFAULTS.a4);
  windowInput.value = String(saved.tolerance ?? DEFAULTS.tolerance);
  steadyInput.value = String(saved.steadiness ?? DEFAULTS.steadiness);
  spellButton.setAttribute("aria-pressed", saved.spell === "flat" ? "true" : "false");
  applySettingsFromInputs();

  for (const input of [a4Input, windowInput, steadyInput]) {
    input.addEventListener("input", () => {
      applySettingsFromInputs();
      saveSettings();
    });
  }

  spellButton.addEventListener("click", () => {
    const flats = spellButton.getAttribute("aria-pressed") === "true";
    spellButton.setAttribute("aria-pressed", flats ? "false" : "true");
    applySettingsFromInputs();
    saveSettings();
  });

  hearButton.addEventListener("click", async () => {
    if (hearing) {
      stopTone();
      paint(tracker.current(), false);
      return;
    }
    const ctx = context();
    if (ctx.state === "suspended") await ctx.resume();
    startTone(tracker.current().targetHz);
    paint(tracker.current(), false);
  });

  start.addEventListener("click", begin);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && audioCtx?.state === "suspended") audioCtx.resume();
  });

  requestAnimationFrame(loop);
}

boot();
