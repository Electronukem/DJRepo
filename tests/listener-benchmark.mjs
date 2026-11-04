// Benchmarks the song listener (web/song-worker.js) on tracks where the answer is known: a tempo,
// where the bars start, and a key. Each track is built from kicks, snares, hats, bass and chords,
// with the traps real songs set: a dotted-eighth echo that looks like a faster tempo, two-step drum
// & bass that looks like half time, and silence before the first beat. Runs in plain Node (CI too):
//
//   node tests/listener-benchmark.mjs
//
// Exits non-zero if any track's tempo is off by more than 0.05 BPM or its bar line by more than 25 ms.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const RATE = 11025;
const worker = { self: {}, Float64Array, Int8Array, Uint32Array, Math, Array, Map, Set, Number, String, JSON, Object, Error, Infinity, NaN };
vm.createContext(worker);
vm.runInContext(readFileSync(new URL('../web/song-worker.js', import.meta.url), 'utf8'), worker);

const NOTE = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const SCALE = { ionian: [0, 2, 4, 5, 7, 9, 11], aeolian: [0, 2, 3, 5, 7, 8, 10] };

function noise(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 31 - 1;
  };
}

// A track: { bpm, bars, lead (seconds of silence first), key, mode, kicks, snares, echo }.
function track(t) {
  const beat = 60 / t.bpm;
  const sixteenth = beat / 4;
  const length = Math.ceil((t.lead + t.bars * beat * 4 + 2) * RATE);
  const out = new Float32Array(length);
  const rand = noise(t.bpm * 7 + t.bars);
  const add = (start, gain, fn, seconds) => {
    const from = Math.round(start * RATE);
    for (let i = 0; i < seconds * RATE && from + i < length; i++) out[from + i] += gain * fn(i / RATE);
  };
  const kick = (time) => {
    let phase = 0;
    add(time, 0.9, (x) => {
      phase += (2 * Math.PI * (45 + 100 * Math.exp(-x / 0.03))) / RATE;
      return Math.sin(phase) * Math.exp(-x / 0.12);
    }, 0.35);
  };
  const burst = (time, gain, decay) => {
    let last = 0;
    add(time, gain, (x) => {
      const n = rand();
      const hp = n - last;  // brighter
      last = n;
      return hp * Math.exp(-x / decay);
    }, decay * 5);
  };
  const tone = (time, midi, gain, seconds) => {
    const f = 440 * 2 ** ((midi - 69) / 12);
    add(time, gain, (x) => Math.sin(2 * Math.PI * f * x) * Math.min(1, x / 0.01) * Math.exp(-x / (seconds * 0.6)), seconds);
  };
  const steps = SCALE[t.mode];
  const progression = t.mode === 'ionian' ? [0, 4, 5, 3] : [0, 5, 2, 6];
  for (let bar = 0; bar < t.bars; bar++) {
    const start = t.lead + bar * beat * 4;
    const degree = progression[bar % 4];
    const chord = [0, 2, 4].map((k) => t.key + steps[(degree + k) % 7] + 12 * Math.floor((degree + k) / 7));
    for (const n of chord) tone(start, 60 + n, 0.07, beat * 4);  // a chord a bar, changing on the downbeat
    for (let s = 0; s < 16; s++) {
      const time = start + s * sixteenth;
      if (t.kicks.includes(s)) kick(time);
      if (t.snares.includes(s)) burst(time, 0.35, 0.05);
      if (s % 2 === 0) burst(time, s % 4 === 2 ? 0.12 : 0.05, 0.012);
      if (s % 4 === 2) tone(time, 36 + chord[0], 0.25, sixteenth * 1.5);  // offbeat bass
    }
    if (t.echo) {  // a dotted-eighth echo of the chord stab and the snare: the classic tempo trap
      for (const s of t.snares) burst(start + s * sixteenth + beat * 0.75, 0.2, 0.05);
      for (const n of chord) tone(start + beat * 0.75, 72 + n, 0.05, beat * 0.5);
    }
  }
  return out;
}

const FOUR = [0, 4, 8, 12];
const tracks = [
  { name: 'house', bpm: 124, bars: 48, lead: 0, key: 9, mode: 'aeolian', kicks: FOUR, snares: [4, 12] },
  { name: 'techno, dotted-eighth echo', bpm: 131, bars: 48, lead: 1.37, key: 2, mode: 'aeolian', kicks: FOUR, snares: [4, 12], echo: true },
  { name: 'drum & bass, two-step', bpm: 174, bars: 64, lead: 0.61, key: 5, mode: 'aeolian', kicks: [0, 10], snares: [4, 12] },
  { name: 'trance', bpm: 138, bars: 48, lead: 2.2, key: 7, mode: 'ionian', kicks: FOUR, snares: [4, 12] },
  { name: 'big room, heavy echo', bpm: 128, bars: 48, lead: 0.9, key: 0, mode: 'ionian', kicks: FOUR, snares: [4, 12], echo: true },
];

let failed = 0;
const rows = [];
for (const t of tracks) {
  const started = performance.now();
  let row;
  try {
    const heard = worker.analyse(track(t), RATE);
    const barLen = (240 / t.bpm);
    let off = ((heard.first - t.lead) % barLen + barLen) % barLen;
    if (off > barLen / 2) off -= barLen;
    const tempoErr = Math.abs(heard.bpm - t.bpm);
    const keyRight = heard.key === t.key && heard.mode === t.mode;
    const ok = tempoErr <= 0.05 && Math.abs(off) <= 0.025;
    if (!ok) failed++;
    row = {
      track: t.name, tempo: `${t.bpm} → ${heard.bpm.toFixed(3)}`, 'bar line': `${Math.round(off * 1000)} ms`,
      key: `${NOTE[t.key]} ${t.mode === 'ionian' ? 'major' : 'minor'}${keyRight ? '' : ` → ${NOTE[heard.key]} ${heard.mode === 'ionian' ? 'major' : 'minor'}`}`,
      'key right': keyRight ? 'yes' : 'no', ms: Math.round(performance.now() - started), pass: ok ? 'yes' : 'NO',
    };
  } catch (err) {
    failed++;
    row = { track: t.name, tempo: `error: ${err.message}`, pass: 'NO' };
  }
  rows.push(row);
}
console.table(rows);
console.log(failed ? `${failed} of ${tracks.length} tracks failed` : `all ${tracks.length} tracks within 0.05 BPM and 25 ms`);
process.exit(failed ? 1 : 0);
