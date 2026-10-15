// Procedural sound (Web Audio) and voice announcements (Web Speech).
// Everything is synthesised: no audio files to download. Audio starts only
// after a user gesture, as browsers require.
import { state } from './store.js';

let ctx = null;
let master = null;
let engine = null;

function ac() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export function unlockAudio() {
  ac();
}

function noiseBuffer(c, seconds = 2) {
  const buf = c.createBuffer(1, c.sampleRate * seconds, c.sampleRate);
  const data = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    // Brown noise: integrated white noise, rumbly like engines and wind.
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    data[i] = last * 3.5;
  }
  return buf;
}

function tone(freq, start, dur, type = 'sine', gain = 0.25) {
  const c = ac();
  if (!c) return;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0, c.currentTime + start);
  g.gain.linearRampToValueAtTime(gain, c.currentTime + start + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + start + dur);
  o.connect(g).connect(master);
  o.start(c.currentTime + start);
  o.stop(c.currentTime + start + dur + 0.05);
}

/** One-shot effects. */
export function sfx(kind) {
  if (!state.settings.sound || !ac()) return;
  switch (kind) {
    case 'seatbelt-on':
    case 'seatbelt-off':
    case 'chime':
      // The classic two-tone cabin chime (high-low).
      tone(1046.5, 0, 1.4, 'sine', 0.22);
      tone(830.6, 0.55, 1.6, 'sine', 0.22);
      break;
    case 'pa':
      tone(659.3, 0, 0.9, 'sine', 0.18);
      break;
    case 'beep':
      tone(1800, 0, 0.12, 'square', 0.08);
      break;
    case 'error':
      tone(220, 0, 0.25, 'sawtooth', 0.1);
      tone(196, 0.25, 0.35, 'sawtooth', 0.1);
      break;
    case 'stamp': {
      const c = ctx;
      const src = c.createBufferSource();
      src.buffer = noiseBuffer(c, 0.25);
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 400;
      const g = c.createGain();
      g.gain.setValueAtTime(0.9, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.22);
      src.connect(f).connect(g).connect(master);
      src.start();
      break;
    }
    case 'horn': {
      // Ship's whistle: one prolonged blast, two detuned low reeds.
      for (const f of [110, 112.5, 220]) tone(f, 0, 4.5, 'sawtooth', f > 200 ? 0.03 : 0.07);
      break;
    }
    case 'takeoff':
    case 'touchdown': {
      const c = ctx;
      const src = c.createBufferSource();
      src.buffer = noiseBuffer(c, 4);
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = kind === 'takeoff' ? 900 : 500;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, c.currentTime);
      g.gain.exponentialRampToValueAtTime(kind === 'takeoff' ? 0.8 : 0.5, c.currentTime + 0.6);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 3.8);
      src.connect(f).connect(g).connect(master);
      src.start();
      break;
    }
    case 'ignition': {
      tone(55, 0, 0.6, 'sawtooth', 0.12);
      tone(82, 0.35, 0.8, 'sawtooth', 0.1);
      break;
    }
    case 'success':
      tone(523.3, 0, 0.18, 'triangle', 0.15);
      tone(659.3, 0.12, 0.18, 'triangle', 0.15);
      tone(784, 0.24, 0.3, 'triangle', 0.15);
      break;
    default:
  }
}

/** Continuous engine sound whose pitch tracks speed. kind: car|bike|jet|ship|none */
export function engineSound(kind, speedMs = 0, extra = 0) {
  if (!state.settings.sound || kind === 'none' || !ac()) {
    if (engine) stopEngine();
    return;
  }
  if (!engine || engine.kind !== kind) {
    stopEngine();
    const c = ctx;
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(c, 3);
    src.loop = true;
    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    const osc = c.createOscillator();
    osc.type = kind === 'ship' ? 'sine' : 'sawtooth';
    const og = c.createGain();
    const g = c.createGain();
    g.gain.value = 0;
    src.connect(filter).connect(g);
    osc.connect(og).connect(g);
    g.connect(master);
    src.start();
    osc.start();
    engine = { kind, src, filter, osc, og, g };
  }
  const t = ctx.currentTime;
  const e = engine;
  if (kind === 'car') {
    const rpm = 800 + ((speedMs * 3.6) % 45) * 60 + speedMs * 25;
    e.osc.frequency.setTargetAtTime(rpm / 30, t, 0.2);
    e.og.gain.setTargetAtTime(0.025, t, 0.3);
    e.filter.frequency.setTargetAtTime(300 + speedMs * 25, t, 0.3);
    e.g.gain.setTargetAtTime(0.25, t, 0.3);
  } else if (kind === 'jet') {
    e.osc.frequency.setTargetAtTime(90 + extra * 0.4, t, 0.5);
    e.og.gain.setTargetAtTime(0.004, t, 0.5);
    e.filter.frequency.setTargetAtTime(350 + Math.min(1, speedMs / 120) * 600, t, 1);
    e.g.gain.setTargetAtTime(0.32, t, 1);
  } else if (kind === 'ship') {
    e.osc.frequency.setTargetAtTime(38, t, 1);
    e.og.gain.setTargetAtTime(0.06, t, 1);
    e.filter.frequency.setTargetAtTime(160, t, 1);
    e.g.gain.setTargetAtTime(0.35, t, 1);
  } else if (kind === 'bike') {
    e.og.gain.setTargetAtTime(0, t, 0.3);
    e.filter.frequency.setTargetAtTime(200 + speedMs * 60, t, 0.5);
    e.g.gain.setTargetAtTime(Math.min(0.12, speedMs * 0.012), t, 0.5);
  }
}

export function stopEngine() {
  if (!engine) return;
  const e = engine;
  engine = null;
  try {
    e.g.gain.setTargetAtTime(0, ctx.currentTime, 0.2);
    setTimeout(() => {
      e.src.stop();
      e.osc.stop();
    }, 600);
  } catch {
    // already stopped
  }
}

// ── Voice ─────────────────────────────────────────────────────────────────
const queue = [];
let speaking = false;

function pickVoice(kind) {
  const voices = window.speechSynthesis?.getVoices() || [];
  const en = voices.filter((v) => /^en[-_]/i.test(v.lang));
  if (!en.length) return null;
  const pref =
    kind === 'pilot' ? /Daniel|George|Male|Google UK English Male|Arthur/i : /Samantha|Karen|Female|Google UK English Female|Serena|Moira/i;
  return en.find((v) => pref.test(v.name)) || en[0];
}

/** Speak an announcement. kind: 'nav' | 'pilot' | 'crew' | 'captain'. */
export function speak(text, { kind = 'nav', priority = 0 } = {}) {
  if (!state.settings.voice || !('speechSynthesis' in window)) return;
  if (priority >= 2) queue.length = 0;
  if (queue.length > 3) queue.shift();
  queue.push({ text, kind });
  pump();
}

function pump() {
  if (speaking || !queue.length) return;
  const { text, kind } = queue.shift();
  const u = new SpeechSynthesisUtterance(text);
  const v = pickVoice(kind);
  if (v) u.voice = v;
  u.rate = kind === 'nav' ? 1.05 : 0.97;
  u.pitch = kind === 'pilot' ? 0.85 : 1.05;
  speaking = true;
  const done = () => {
    speaking = false;
    pump();
  };
  u.onend = done;
  u.onerror = done;
  if (kind === 'pilot' || kind === 'crew') sfx('pa');
  setTimeout(() => window.speechSynthesis.speak(u), kind === 'pilot' || kind === 'crew' ? 700 : 0);
}

export function hushVoice() {
  queue.length = 0;
  try {
    window.speechSynthesis?.cancel();
  } catch {
    // ignore
  }
  speaking = false;
}
