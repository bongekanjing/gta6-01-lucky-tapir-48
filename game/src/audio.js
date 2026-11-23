// Sound: every effect is synthesised with WebAudio at play time, so the game ships no audio file.
// Guns, impacts and horns are short shaped noise and oscillator bursts with a filter; engines and
// sirens are continuous voices faded by distance. A small generated chord loop sits under the city
// as the music. Nothing is created until the first real gesture (Chrome's autoplay rule).

import { clamp, dist2 } from './util.js';

const NOTE = { C: 261.63, D: 293.66, E: 329.63, F: 349.23, G: 392.0, A: 440.0, B: 493.88 };

export function createAudio() {
  let ctx = null;
  let master = null;
  let sfxBus = null;
  let musicBus = null;
  let noiseBuffer = null;
  let started = false;
  let musicTimer = 0;
  let musicStep = 0;
  let listener = { x: 0, y: 0 };
  const voices = new Map();
  let muted = false;

  /** Build the context and the buses. Safe to call again after a suspend. */
  function ensure() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume();
      return true;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 3.2;
    master.connect(comp);
    comp.connect(ctx.destination);
    sfxBus = ctx.createGain();
    sfxBus.gain.value = 0.85;
    sfxBus.connect(master);
    musicBus = ctx.createGain();
    musicBus.gain.value = 0.22;
    musicBus.connect(master);

    // One second of white noise, reused by every noisy effect.
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i += 1) {
      const white = Math.random() * 2 - 1;
      last = last * 0.82 + white * 0.18;
      d[i] = last;
    }
    started = true;
    return true;
  }

  function noiseSource(offset = 0) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = true;
    src.loopStart = offset;
    return src;
  }

  /** Distance attenuation from the listener, in [0, 1]. */
  function gainAt(x, y) {
    if (x === undefined) return 1;
    const d = Math.sqrt(dist2(x, y, listener.x, listener.y));
    return clamp(1 - d / 900, 0, 1) ** 1.4;
  }

  /** A short enveloped tone. */
  function tone(freq, dur, opts = {}) {
    const t0 = ctx.currentTime + (opts.delay ?? 0);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = opts.type ?? 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (opts.slide !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.slide), t0 + dur);
    const vol = opts.volume ?? 0.2;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + (opts.attack ?? 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    let node = osc;
    if (opts.filter) {
      const f = ctx.createBiquadFilter();
      f.type = opts.filter;
      f.frequency.value = opts.filterFreq ?? 1200;
      node.connect(f);
      f.connect(g);
    } else {
      node.connect(g);
    }
    g.connect(sfxBus);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** A filtered noise burst. */
  function burst(dur, opts = {}) {
    const t0 = ctx.currentTime + (opts.delay ?? 0);
    const src = noiseSource(opts.offset ?? 0);
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter();
    f.type = opts.filter ?? 'bandpass';
    f.frequency.setValueAtTime(opts.freq ?? 900, t0);
    if (opts.freqTo) f.frequency.exponentialRampToValueAtTime(Math.max(60, opts.freqTo), t0 + dur);
    f.Q.value = opts.q ?? 0.8;
    const vol = opts.volume ?? 0.2;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + (opts.attack ?? 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f);
    f.connect(g);
    g.connect(sfxBus);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  const sounds = {
    pistol(x, y, v = 1) {
      const g = gainAt(x, y) * v;
      if (g < 0.02) return;
      burst(0.16, { volume: 0.5 * g, freq: 1700, freqTo: 240, q: 0.6, filter: 'bandpass' });
      tone(150, 0.14, { type: 'triangle', volume: 0.4 * g, slide: 60 });
      burst(0.4, { volume: 0.12 * g, freq: 700, freqTo: 300, filter: 'lowpass', delay: 0.02 });
    },
    smg(x, y, v = 1) {
      const g = gainAt(x, y) * v;
      if (g < 0.02) return;
      burst(0.09, { volume: 0.34 * g, freq: 2100, freqTo: 500, q: 0.7 });
      tone(120, 0.07, { type: 'square', volume: 0.16 * g, slide: 70 });
    },
    punch(x, y, v = 1) {
      const g = gainAt(x, y) * v;
      burst(0.09, { volume: 0.4 * g, freq: 320, freqTo: 90, filter: 'lowpass', q: 1 });
      tone(90, 0.08, { type: 'sine', volume: 0.28 * g, slide: 50 });
    },
    whoosh(x, y, v = 1) {
      burst(0.14, { volume: 0.12 * gainAt(x, y) * v, freq: 700, freqTo: 2200, q: 1.4 });
    },
    dryfire(v = 1) {
      burst(0.04, { volume: 0.12 * v, freq: 3200, q: 3 });
    },
    crash(x, y, v = 1) {
      const g = gainAt(x, y) * v;
      burst(0.5, { volume: 0.42 * g, freq: 420, freqTo: 80, filter: 'lowpass', q: 0.8 });
      for (let i = 0; i < 3; i += 1) burst(0.22, { volume: 0.16 * g, freq: 1800 + i * 900, q: 2.5, delay: i * 0.03 });
      tone(70, 0.3, { type: 'sine', volume: 0.26 * g, slide: 40 });
    },
    thud(x, y, v = 1) {
      const g = gainAt(x, y) * v;
      tone(64, 0.16, { type: 'sine', volume: 0.3 * g, slide: 38 });
      burst(0.1, { volume: 0.16 * g, freq: 200, filter: 'lowpass' });
    },
    horn(x, y, v = 1) {
      const g = gainAt(x, y) * v;
      if (g < 0.04) return;
      const t0 = ctx.currentTime;
      for (const fq of [370, 466]) {
        const osc = ctx.createOscillator();
        const gg = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.value = fq;
        gg.gain.setValueAtTime(0.0001, t0);
        gg.gain.exponentialRampToValueAtTime(0.09 * g, t0 + 0.02);
        gg.gain.setValueAtTime(0.09 * g, t0 + 0.28);
        gg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.4);
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 1500;
        osc.connect(f);
        f.connect(gg);
        gg.connect(sfxBus);
        osc.start(t0);
        osc.stop(t0 + 0.42);
      }
    },
    step(x, y, v = 1) {
      const g = gainAt(x, y) * v;
      burst(0.05, { volume: 0.11 * g, freq: 900 + Math.random() * 300, q: 1.6, offset: Math.random() * 0.9 });
    },
    explosion(x, y, v = 1) {
      const g = gainAt(x, y) * v;
      burst(1.1, { volume: 0.7 * g, freq: 380, freqTo: 50, filter: 'lowpass', q: 0.7 });
      burst(0.5, { volume: 0.3 * g, freq: 1400, freqTo: 300, q: 0.5, delay: 0.03 });
      tone(56, 0.9, { type: 'sine', volume: 0.5 * g, slide: 26 });
    },
    pickup(v = 1) {
      tone(NOTE.E * 2, 0.11, { type: 'triangle', volume: 0.16 * v });
      tone(NOTE.A * 2, 0.14, { type: 'triangle', volume: 0.14 * v, delay: 0.07 });
    },
    cash(v = 1) {
      tone(NOTE.G * 2, 0.1, { type: 'square', volume: 0.1 * v });
      tone(NOTE.B * 2, 0.16, { type: 'square', volume: 0.09 * v, delay: 0.08 });
      tone(NOTE.E * 3, 0.24, { type: 'triangle', volume: 0.12 * v, delay: 0.16 });
    },
    mission(v = 1) {
      [NOTE.C, NOTE.E, NOTE.G, NOTE.C * 2].forEach((f, i) => tone(f, 0.5, { type: 'triangle', volume: 0.14 * v, delay: i * 0.11, attack: 0.02 }));
    },
    fail(v = 1) {
      [NOTE.E, NOTE.C * 0.75, NOTE.A * 0.6].forEach((f, i) => tone(f, 0.5, { type: 'sawtooth', volume: 0.1 * v, delay: i * 0.15, filter: 'lowpass', filterFreq: 900 }));
    },
    click(v = 1) {
      burst(0.03, { volume: 0.14 * v, freq: 2400, q: 4 });
    },
    sirenWhoop(v = 1) {
      tone(760, 0.5, { type: 'sine', volume: 0.06 * v, slide: 1250 });
    },
    wanted(v = 1) {
      tone(220, 0.5, { type: 'sawtooth', volume: 0.14 * v, slide: 110, filter: 'lowpass', filterFreq: 600 });
    },
  };

  function play(name, opts = {}) {
    if (!started || muted) return;
    if (ctx.state === 'suspended') ctx.resume();
    const fn = sounds[name];
    if (fn) fn(opts.x, opts.y, opts.volume ?? 1);
  }

  // ---------------------------------------------------------------- continuous voices
  /** An engine note for one car: a saw pair plus filtered noise, gain by distance and throttle. */
  function engineVoice(id) {
    let v = voices.get(id);
    if (v) return v;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 60;
    const sub = ctx.createOscillator();
    sub.type = 'square';
    sub.frequency.value = 30;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 420;
    f.Q.value = 2.2;
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    const dist = ctx.createGain();
    dist.gain.value = 0;
    osc.connect(f);
    sub.connect(f);
    f.connect(g);
    g.connect(dist);
    dist.connect(sfxBus);
    osc.start();
    sub.start();
    v = { osc, sub, f, g, dist, level: 0 };
    voices.set(id, v);
    return v;
  }

  /** Update the player's car engine: pitch from speed, volume from throttle. */
  function carLoop(car, dt) {
    if (!started || muted || !car) return;
    const v = engineVoice('player');
    const sp = Math.abs(car.speed);
    const pitch = 52 + Math.min(1, sp / 430) * 150;
    v.osc.frequency.setTargetAtTime(pitch, ctx.currentTime, 0.06);
    v.sub.frequency.setTargetAtTime(pitch * 0.5, ctx.currentTime, 0.06);
    v.f.frequency.setTargetAtTime(300 + Math.min(1, sp / 430) * 1100, ctx.currentTime, 0.08);
    const target = car.wrecked ? 0 : 0.055 + Math.min(1, sp / 300) * 0.05;
    v.dist.gain.setTargetAtTime(target, ctx.currentTime, 0.08);
    void dt;
  }

  /** Silence the engine voice (player left the car). */
  function silenceEngine() {
    const v = voices.get('player');
    if (v && ctx) v.dist.gain.setTargetAtTime(0, ctx.currentTime, 0.12);
  }

  /** A police siren voice per cruiser, panned and faded by distance. */
  function siren(car, dt, d) {
    if (!started || muted) return;
    const v = engineVoice(`siren${car.id}`);
    const t = ctx.currentTime;
    const on = car.unit && car.health > 0;
    const near = clamp(1 - d / 1200, 0, 1) ** 2;
    v.dist.gain.setTargetAtTime(on ? 0.045 * near : 0, t, 0.12);
    // A two-tone whoop, per unit offset so a group does not phase into one note.
    const phase = ((car.lightPhase ?? 0) % 1.6) / 1.6;
    const note = phase < 0.5 ? 780 + phase * 520 : 1420 - (phase - 0.5) * 520;
    v.osc.frequency.setTargetAtTime(note, t, 0.02);
    v.sub.frequency.setTargetAtTime(note * 0.5, t, 0.02);
    v.f.frequency.setTargetAtTime(1800, t, 0.1);
    v.g.gain.setTargetAtTime(0.5, t, 0.1);
    void dt;
  }

  function stopVoices() {
    for (const [id, v] of voices) {
      try {
        v.dist.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
        v.osc.stop(ctx.currentTime + 0.2);
        v.sub.stop(ctx.currentTime + 0.2);
      } catch {
        // Already stopped.
      }
      voices.delete(id);
    }
  }

  // ---------------------------------------------------------------- music
  // A slow, warm chord bed: an electric-piano-ish tone per chord with a soft pad, a bossa-ish
  // bass and a brushed click, over a four-chord loop. Low volume; it should read as place, not as
  // a soundtrack demanding attention.
  const PROGRESSION = [
    { root: NOTE.C / 2, notes: [NOTE.E, NOTE.G, NOTE.B, NOTE.D * 2], bass: NOTE.C / 4 },
    { root: NOTE.A / 2, notes: [NOTE.C * 2, NOTE.E * 2, NOTE.G * 2], bass: NOTE.A / 4 },
    { root: NOTE.F / 2, notes: [NOTE.A, NOTE.C * 2, NOTE.E * 2, NOTE.G * 2], bass: NOTE.F / 4 },
    { root: NOTE.G / 2, notes: [NOTE.B, NOTE.D * 2, NOTE.F * 2], bass: NOTE.G / 4 },
  ];
  const BAR = 4.8;

  function musicTick(dt) {
    if (!started || muted) return;
    musicTimer -= dt;
    if (musicTimer > 0) return;
    const chord = PROGRESSION[musicStep % PROGRESSION.length];
    musicTimer = BAR;
    musicStep += 1;
    const t0 = ctx.currentTime;
    // Chord stab.
    chord.notes.forEach((f, i) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = i === 0 ? 'triangle' : 'sine';
      osc.frequency.value = f * (i === 3 ? 1.003 : 1);
      g.gain.setValueAtTime(0.0001, t0 + i * 0.02);
      g.gain.exponentialRampToValueAtTime(0.05, t0 + 0.12 + i * 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + BAR * 0.9);
      osc.connect(g);
      g.connect(musicBus);
      osc.start(t0);
      osc.stop(t0 + BAR);
    });
    // Bass, plucked at the top of the bar and again halfway.
    [0, BAR / 2].forEach((when, i) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = chord.bass * (i === 1 ? 1.5 : 1);
      const tt = t0 + when;
      g.gain.setValueAtTime(0.0001, tt);
      g.gain.exponentialRampToValueAtTime(0.11, tt + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.9);
      osc.connect(g);
      g.connect(musicBus);
      osc.start(tt);
      osc.stop(tt + 1);
    });
    // A soft brushed hat on the off-beats.
    for (let i = 0; i < 4; i += 1) {
      const tt = t0 + i * (BAR / 4) + BAR / 8;
      const src = noiseSource(Math.random() * 0.8);
      const f = ctx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = 5200;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, tt);
      g.gain.exponentialRampToValueAtTime(0.02, tt + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.16);
      src.connect(f);
      f.connect(g);
      g.connect(musicBus);
      src.start(tt);
      src.stop(tt + 0.2);
    }
  }

  return {
    ensure,
    play,
    carLoop,
    siren,
    silenceEngine,
    stopVoices,
    musicTick,
    setListener(x, y) {
      listener.x = x;
      listener.y = y;
    },
    /** Music and effects on/off (the pause menu and the mute key). */
    toggleMute() {
      muted = !muted;
      if (master) master.gain.setTargetAtTime(muted ? 0 : 0.9, ctx.currentTime, 0.05);
      return muted;
    },
    get muted() {
      return muted;
    },
    setMusic(level) {
      if (musicBus) musicBus.gain.setTargetAtTime(level, ctx.currentTime, 0.3);
    },
    get ready() {
      return started;
    },
    resetMusic() {
      musicTimer = 0;
      musicStep = 0;
    },
  };
}
