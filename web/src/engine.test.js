import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BUFFER_SIZE,
  analyze,
  createTracker,
  describeHz,
  midiToHz,
  timingFor,
} from "./engine.js";

function centsBetween(actual, expected) {
  return 1200 * Math.log2(actual / expected);
}

function renderTone(freq, sampleRate, length, harmonics = []) {
  const out = new Float32Array(length);
  const parts = [[1, 1], ...harmonics];
  let norm = 0;
  for (const [, amp] of parts) norm += amp * amp;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < length; i++) {
    let sample = 0;
    for (const [mult, amp] of parts) {
      sample += amp * Math.sin((2 * Math.PI * freq * mult * i) / sampleRate);
    }
    out[i] = sample / norm;
  }
  return out;
}

function noise(length, amp, seed) {
  const out = new Float32Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = ((state / 4294967296) * 2 - 1) * amp;
  }
  return out;
}

const HARMONICS = [
  [2, 0.55],
  [3, 0.32],
  [4, 0.18],
  [5, 0.1],
];

const PITCHES = [
  32.703, 41.203, 55, 65.406, 82.407, 110, 146.832, 196, 220, 261.626, 329.628, 369.994, 440,
  466.164, 523.251, 659.255, 880, 1174.66, 1567.98, 1760, 2093, 2637.02, 3520, 4186.01,
];

function frame(hz, extra = {}) {
  return {
    hz,
    clarity: 1,
    rms: 0.05,
    ...extra,
  };
}

describe("describeHz", () => {
  it("maps A440 to A4 at 0 cents", () => {
    const note = describeHz(440, 440, "sharp");
    assert.equal(note.name, "A4");
    assert.equal(note.letter, "A");
    assert.equal(note.accidental, "");
    assert.equal(note.octave, 4);
    assert.ok(Math.abs(note.cents) < 0.001);
  });

  it("follows a moved concert pitch", () => {
    const at432 = describeHz(432, 432, "sharp");
    assert.equal(at432.name, "A4");
    assert.ok(Math.abs(at432.cents) < 0.001);

    const sharpOf432 = describeHz(440, 432, "sharp");
    assert.equal(sharpOf432.name, "A4");
    assert.ok(Math.abs(sharpOf432.cents - 31.77) < 0.1);
  });

  it("spells accidentals with sharps or flats", () => {
    const hz = midiToHz(70, 440);
    assert.equal(describeHz(hz, 440, "sharp").name, "A♯4");
    assert.equal(describeHz(hz, 440, "flat").name, "B♭4");
  });

  it("rejects silence and nonsense", () => {
    assert.equal(describeHz(0), null);
    assert.equal(describeHz(-10), null);
    assert.equal(describeHz(Number.NaN), null);
  });
});

describe("analyze", () => {
  for (const sampleRate of [44100, 48000]) {
    it(`reads pure tones within 1.5 cents at ${sampleRate} Hz`, () => {
      for (const freq of PITCHES) {
        const { hz, clarity } = analyze(renderTone(freq, sampleRate, BUFFER_SIZE), sampleRate);
        assert.ok(hz, `no pitch for ${freq}`);
        const error = centsBetween(hz, freq);
        assert.ok(clarity > 0.95, `clarity ${clarity} for ${freq}`);
        assert.ok(Math.abs(error) < 1.5, `${freq} Hz → ${hz} Hz (${error.toFixed(2)}¢)`);
      }
    });

    it(`keeps the fundamental of a harmonic tone at ${sampleRate} Hz`, () => {
      for (const freq of PITCHES) {
        const { hz } = analyze(renderTone(freq, sampleRate, BUFFER_SIZE, HARMONICS), sampleRate);
        const error = centsBetween(hz, freq);
        assert.ok(
          Math.abs(error) < 4,
          `${freq} Hz → ${hz} Hz (${error.toFixed(2)}¢)`,
        );
      }
    });
  }

  it("survives a weak fundamental, DC offset, and clipping", () => {
    const weak = analyze(
      renderTone(110, 48000, BUFFER_SIZE, [
        [2, 5],
        [3, 3],
        [4, 2],
      ]),
      48000,
    );
    assert.ok(Math.abs(centsBetween(weak.hz, 110)) < 5);

    const shifted = renderTone(440, 48000, BUFFER_SIZE);
    for (let i = 0; i < shifted.length; i++) shifted[i] += 0.2;
    const dc = analyze(shifted, 48000);
    assert.ok(Math.abs(centsBetween(dc.hz, 440)) < 1);

    const clipped = renderTone(440, 48000, BUFFER_SIZE, HARMONICS);
    for (let i = 0; i < clipped.length; i++) clipped[i] = Math.tanh(3 * clipped[i]);
    const squashed = analyze(clipped, 48000);
    assert.ok(Math.abs(centsBetween(squashed.hz, 440)) < 1.5);
  });

  it("does not treat noise as a note", () => {
    for (const seed of [1, 2, 3, 9, 42]) {
      const { clarity, hz } = analyze(noise(BUFFER_SIZE, 0.08, seed), 48000);
      assert.ok(clarity < 0.86, `seed ${seed} clarity ${clarity} at ${hz} Hz`);
    }
  });

  it("stays fast enough to run on every animation frame", () => {
    const buf = renderTone(440, 48000, BUFFER_SIZE, HARMONICS);
    const start = performance.now();
    for (let i = 0; i < 20; i++) analyze(buf, 48000);
    const each = (performance.now() - start) / 20;
    assert.ok(each < 40, `${each.toFixed(1)} ms`);
  });
});

describe("tracker", () => {
  it("locks the first clear note and ignores a one-frame spike", () => {
    const tracker = createTracker();
    let view = null;
    for (let i = 0; i < 12; i++) {
      const hz = i === 6 ? 880 : 440;
      view = tracker.push(frame(hz, { now: i * 50 }));
    }
    assert.equal(view.name, "A4");
    assert.ok(Math.abs(view.cents) < 1);
    assert.equal(view.status, "in-tune");
    assert.ok(Math.abs(view.targetHz - 440) < 0.01);
  });

  it("centers vibrato instead of chasing it", () => {
    const tracker = createTracker();
    let view = null;
    for (let i = 0; i < 60; i++) {
      const wobble = Math.sin((i / 4.5) * 2 * Math.PI) * 35;
      const hz = 440 * 2 ** (wobble / 1200);
      view = tracker.push(frame(hz, { now: i * 45 }));
    }
    assert.equal(view.letter, "A");
    assert.equal(view.octave, 4);
    assert.ok(Math.abs(view.cents) < 8, `cents ${view.cents}`);
  });

  it("waits before believing a new note, then snaps to it", () => {
    const steadiness = 72;
    const tracker = createTracker({ steadiness });
    const confirm = timingFor(steadiness).confirm;
    for (let i = 0; i < 10; i++) tracker.push(frame(440, { now: i * 50 }));

    let view = null;
    for (let i = 0; i < confirm - 1; i++) {
      view = tracker.push(frame(659.255, { now: 1000 + i * 50 }));
      assert.equal(view.letter, "A", `switched early on frame ${i}`);
    }
    view = tracker.push(frame(659.255, { now: 1000 + confirm * 50 }));
    assert.equal(view.name, "E5");
    assert.ok(Math.abs(view.cents) < 2);
  });

  it("switches sooner when steadiness is turned down", () => {
    const tracker = createTracker({ steadiness: 0 });
    const confirm = timingFor(0).confirm;
    tracker.push(frame(440, { now: 0 }));
    let view = tracker.push(frame(440, { now: 40 }));
    assert.equal(view.name, "A4");
    for (let i = 0; i < confirm; i++) {
      view = tracker.push(frame(523.251, { now: 200 + i * 40 }));
    }
    assert.equal(view.name, "C5");
    assert.ok(confirm < timingFor(100).confirm);
  });

  it("holds through a short gap, then goes quiet", () => {
    const tracker = createTracker({ steadiness: 72 });
    const holdMs = timingFor(72).holdMs;
    for (let i = 0; i < 6; i++) tracker.push(frame(196, { now: i * 40 }));
    const held = tracker.push(frame(null, { clarity: 0, rms: 0, now: 400 }));
    assert.equal(held.holding, true);
    assert.equal(held.name, "G3");
    const gone = tracker.push(frame(null, { clarity: 0, rms: 0, now: 400 + holdMs + 30 }));
    assert.equal(gone.active, false);
    assert.equal(gone.status, "idle");
    assert.equal(gone.targetName, "A4");
  });

  it("rejects quiet and unclear frames", () => {
    const tracker = createTracker();
    const quiet = tracker.push(frame(440, { rms: 0.0001, now: 0 }));
    assert.equal(quiet.active, false);
    const muddy = tracker.push(frame(440, { clarity: 0.5, now: 50 }));
    assert.equal(muddy.active, false);
  });

  it("retunes the same sound when concert pitch changes", () => {
    const tracker = createTracker({ a4: 440 });
    for (let i = 0; i < 8; i++) tracker.push(frame(440, { now: i * 40 }));
    tracker.configure({ a4: 432 });
    const view = tracker.current();
    assert.equal(view.name, "A4");
    assert.ok(Math.abs(view.cents - 31.77) < 0.2, `cents ${view.cents}`);
    assert.equal(view.inTune, false);
  });

  it("widens and narrows the in-tune window without flicker at the edge", () => {
    const tracker = createTracker({ tolerance: 5 });
    const hz = 440 * 2 ** (4 / 1200);
    let view = null;
    for (let i = 0; i < 8; i++) view = tracker.push(frame(hz, { now: i * 40 }));
    assert.equal(view.inTune, true);

    const justOutside = 440 * 2 ** (6.2 / 1200);
    for (let i = 0; i < 8; i++) view = tracker.push(frame(justOutside, { now: 500 + i * 40 }));
    assert.equal(view.inTune, true, "should stay in tune until clearly outside");

    const outside = 440 * 2 ** (8 / 1200);
    for (let i = 0; i < 8; i++) view = tracker.push(frame(outside, { now: 1000 + i * 40 }));
    assert.equal(view.inTune, false);

    tracker.configure({ tolerance: 10 });
    view = tracker.current();
    assert.equal(view.inTune, true);
  });

  it("does not rename the note while it sits on the 50-cent boundary", () => {
    const tracker = createTracker({ steadiness: 80 });
    let view = null;
    for (let i = 0; i < 10; i++) {
      const cents = i % 2 === 0 ? 48 : 52;
      const hz = 440 * 2 ** (cents / 1200);
      view = tracker.push(frame(hz, { now: i * 40 }));
    }
    assert.equal(view.letter, "A");
    assert.ok(view.cents > 40 && view.cents < 60);
  });

  it("respells the latched note", () => {
    const tracker = createTracker();
    const bb = midiToHz(70, 440);
    let view = null;
    for (let i = 0; i < 4; i++) view = tracker.push(frame(bb, { now: i * 40 }));
    assert.equal(view.name, "A♯4");
    tracker.configure({ spell: "flat" });
    assert.equal(tracker.current().name, "B♭4");
  });
});
