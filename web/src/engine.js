/**
 * Chromatic pitch engine.
 *
 * Detection is the McLeod Pitch Method via pitchy. What keeps the needle
 * still is the tracker: quiet and unclear frames are ignored, a short run of
 * pitches is reduced to its median (vibrato collapses to its center), and a
 * reading far from that center has to repeat before the note changes.
 */
import { PitchDetector } from "pitchy";

export const BUFFER_SIZE = 8192;
export const DEFAULTS = {
  a4: 440,
  tolerance: 5,
  steadiness: 72,
  spell: "sharp",
};

const MIN_HZ = 27;
const MAX_HZ = 5000;
const CLARITY_LOCK = 0.9;
const CLARITY_HOLD = 0.86;
const RMS_MIN = 0.0025;
const IN_TUNE_LEAVE = 1.5;

const SHARP_LETTERS = ["C", "C", "D", "D", "E", "F", "F", "G", "G", "A", "A", "B"];
const SHARP_ACC = ["", "♯", "", "♯", "", "", "♯", "", "♯", "", "♯", ""];
const FLAT_LETTERS = ["C", "D", "D", "E", "E", "F", "G", "G", "A", "A", "B", "B"];
const FLAT_ACC = ["", "♭", "", "♭", "", "", "♭", "", "♭", "", "♭", ""];

const detectors = new Map();
let scratch = new Float32Array(0);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** How sticky the tracker is. `steadiness` is 0 (quick) … 100 (still). */
export function timingFor(steadiness) {
  const t = clamp(steadiness, 0, 100) / 100;
  return {
    window: Math.round(3 + t * 8),
    confirm: Math.round(2 + t * 4),
    alpha: 0.55 - t * 0.3,
    holdMs: Math.round(240 + t * 480),
    jumpSemitones: 1.5,
    hyst: 0.045 + t * 0.025,
  };
}

export function midiToHz(midi, a4 = DEFAULTS.a4) {
  return a4 * 2 ** ((midi - 69) / 12);
}

export function hzToMidi(hz, a4 = DEFAULTS.a4) {
  return 69 + 12 * Math.log2(hz / a4);
}

export function spellNote(midi, spell = "sharp") {
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  const flats = spell === "flat";
  const letter = (flats ? FLAT_LETTERS : SHARP_LETTERS)[pc];
  const accidental = (flats ? FLAT_ACC : SHARP_ACC)[pc];
  return {
    midi,
    letter,
    accidental,
    octave,
    name: `${letter}${accidental}${octave}`,
  };
}

export function describeHz(hz, a4 = DEFAULTS.a4, spell = "sharp") {
  if (!Number.isFinite(hz) || hz <= 0) return null;
  const midiFloat = hzToMidi(hz, a4);
  const midi = Math.round(midiFloat);
  if (midi < 0 || midi > 127) return null;
  return {
    ...spellNote(midi, spell),
    midiFloat,
    cents: (midiFloat - midi) * 100,
    hz,
  };
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * @param {Float32Array|number[]} input
 * @param {number} sampleRate
 * @returns {{ hz: number|null, clarity: number, rms: number }}
 */
export function analyze(input, sampleRate) {
  const n = input.length;
  let detector = detectors.get(n);
  if (!detector) {
    detector = PitchDetector.forFloat32Array(n);
    // Above ~0.92, high notes with harmonics lock an octave low.
    detector.clarityThreshold = 0.9;
    detectors.set(n, detector);
  }

  let sum = 0;
  for (let i = 0; i < n; i++) sum += input[i];
  const mean = sum / n;

  if (scratch.length !== n) scratch = new Float32Array(n);
  const buf = scratch;
  let square = 0;
  for (let i = 0; i < n; i++) {
    const x = input[i] - mean;
    buf[i] = x;
    square += x * x;
  }
  const rms = Math.sqrt(square / n);
  const [hz, clarity] = detector.findPitch(buf, sampleRate);
  return {
    hz: hz > 0 ? hz : null,
    clarity,
    rms,
  };
}

export function createTracker(options = {}) {
  let a4 = DEFAULTS.a4;
  let tolerance = DEFAULTS.tolerance;
  let steadiness = DEFAULTS.steadiness;
  let spell = DEFAULTS.spell;

  let samples = [];
  let pending = null;
  let smoothHz = null;
  let latchedMidi = null;
  let lastGoodAt = 0;
  let holding = false;
  let inTune = false;
  let rms = 0;

  function toMidi(hz) {
    return hzToMidi(hz, a4);
  }

  function configure(next = {}) {
    if (next.a4 != null) a4 = clamp(Math.round(next.a4), 415, 466);
    if (next.tolerance != null) tolerance = clamp(Math.round(next.tolerance), 1, 12);
    if (next.steadiness != null) steadiness = clamp(Math.round(next.steadiness), 0, 100);
    if (next.spell === "flat" || next.spell === "sharp") spell = next.spell;
    if (smoothHz != null) {
      latchedMidi = Math.round(toMidi(smoothHz));
      settleLatch(timingFor(steadiness).hyst);
      syncInTune();
    }
  }

  function settleLatch(hyst) {
    if (smoothHz == null || latchedMidi == null) return;
    let offset = toMidi(smoothHz) - latchedMidi;
    while (offset > 0.5 + hyst) {
      latchedMidi += 1;
      offset = toMidi(smoothHz) - latchedMidi;
    }
    while (offset < -(0.5 + hyst)) {
      latchedMidi -= 1;
      offset = toMidi(smoothHz) - latchedMidi;
    }
  }

  function syncInTune() {
    if (smoothHz == null || latchedMidi == null) {
      inTune = false;
      return;
    }
    const cents = (toMidi(smoothHz) - latchedMidi) * 100;
    const abs = Math.abs(cents);
    if (inTune) {
      if (abs > tolerance + IN_TUNE_LEAVE) inTune = false;
    } else if (abs <= tolerance) {
      inTune = true;
    }
  }

  function resetPitch() {
    samples = [];
    pending = null;
    smoothHz = null;
    latchedMidi = null;
    holding = false;
    inTune = false;
  }

  function idle() {
    return {
      active: false,
      holding: false,
      letter: "—",
      accidental: "",
      octave: null,
      name: "—",
      cents: 0,
      hz: null,
      inTune: false,
      status: "idle",
      targetHz: a4,
      targetName: "A4",
      rms,
    };
  }

  function render() {
    if (smoothHz == null || latchedMidi == null) return idle();
    const named = spellNote(latchedMidi, spell);
    const cents = (toMidi(smoothHz) - latchedMidi) * 100;
    let status = "sharp";
    if (inTune) status = "in-tune";
    else if (cents < 0) status = "flat";
    return {
      active: true,
      holding,
      ...named,
      cents,
      hz: smoothHz,
      inTune,
      status,
      targetHz: midiToHz(latchedMidi, a4),
      targetName: named.name,
      rms,
    };
  }

  /**
   * @param {{ hz: number|null, clarity: number, rms: number, now?: number }} frame
   */
  function push(frame) {
    const now = frame.now ?? 0;
    rms = Number.isFinite(frame.rms) ? frame.rms : 0;
    const cfg = timingFor(steadiness);
    const hz = frame.hz;
    const clarity = frame.clarity ?? 0;
    const locked = smoothHz != null;
    const clearEnough = clarity >= (locked ? CLARITY_HOLD : CLARITY_LOCK);
    const voiced =
      Number.isFinite(hz) &&
      hz >= MIN_HZ &&
      hz <= MAX_HZ &&
      clearEnough &&
      rms >= RMS_MIN;

    if (!voiced) {
      pending = null;
      if (smoothHz != null && now - lastGoodAt < cfg.holdMs) {
        holding = true;
        return render();
      }
      resetPitch();
      return render();
    }

    lastGoodAt = now;
    holding = false;
    const center = median(samples);

    if (center == null) {
      samples = [hz];
      smoothHz = hz;
      latchedMidi = Math.round(toMidi(hz));
      pending = null;
    } else {
      const jump = Math.abs(toMidi(hz) - toMidi(center));
      if (jump <= cfg.jumpSemitones) {
        pending = null;
        samples.push(hz);
        while (samples.length > cfg.window) samples.shift();
        const med = median(samples);
        const mixed = Math.exp(Math.log(smoothHz) * (1 - cfg.alpha) + Math.log(med) * cfg.alpha);
        smoothHz = mixed;
        settleLatch(cfg.hyst);
      } else if (pending && Math.abs(toMidi(hz) - toMidi(pending.hz)) <= 0.45 && clarity >= CLARITY_LOCK) {
        pending.count += 1;
        pending.hz = hz;
        if (pending.count >= cfg.confirm) {
          samples = [hz];
          smoothHz = hz;
          latchedMidi = Math.round(toMidi(hz));
          pending = null;
          inTune = false;
        }
      } else if (clarity >= CLARITY_LOCK) {
        pending = { hz, count: 1 };
      }
    }

    syncInTune();
    return render();
  }

  configure(options);

  return {
    configure,
    push,
    current: render,
    reset() {
      resetPitch();
      rms = 0;
    },
  };
}
