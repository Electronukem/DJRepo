// A clip of the set to send with a pitch: the repo's set in whichever genre suits the room, a
// four-bar build-up into a sixteen-bar drop, rendered offline and saved as an MP3 small enough to
// attach (about 1 MB; a WAV if the encoder can't load). It's the same DJ as the live set, pointed at an OfflineAudioContext with a clock
// moved by hand. With no light show to play the lead, the commits play it: each one's code fires
// in the genre's hook rhythm, as it does on stage.
// Shares the page's global scope with genres.js (GENRES) and dj.js (DJ, deriveSet, defaultMix, ...).

'use strict';

const SAMPLE_RATE = 44100;
const SAMPLE_BARS = 20;     // the build-up and the drop
const SAMPLE_TAIL = 2.5;    // seconds left for the last crash to ring out
const SAMPLE_GENRES = ['house', 'techno', 'trance', 'bigroom', 'dnb'];
const LAME_URL = 'https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js';
const MP3_KBPS = 192;

class StudioDJ extends DJ {
  constructor(seconds) {
    super();
    this.clock = 0;
    this.ctx = new OfflineAudioContext(2, Math.ceil(seconds * SAMPLE_RATE), SAMPLE_RATE);
    this.offset = 0;  // the clock is the audio clock
    this.buildMaster();
  }

  now() {
    return this.clock;
  }

  syncClock() {}

  ready() {
    return Boolean(this.desk);
  }

  // Everything is scheduled before rendering starts, so no voice has ended yet to free its slot.
  lead(...args) {
    this.leadVoices = 0;
    super.lead(...args);
  }
}

// Where the music stops and the tail begins, for a set.
function sampleEnd(set) {
  return 0.3 + (SAMPLE_BARS * 4 * 60) / set.bpm;
}

// What the clip would be in each genre, for the pitch to describe.
function sampleClips(scene) {
  const repo = `${scene.repo.owner}/${scene.repo.name}`;
  return Object.fromEntries(SAMPLE_GENRES.map((genre) => {
    const set = deriveSet(scene, genre, 'auto');
    return [genre, { bpm: set.bpm, seconds: Math.round(sampleEnd(set)), repo }];
  }));
}

// Render the clip. Resolves to { blob, ext, seconds, set }.
async function renderSample(scene, genre) {
  const set = deriveSet(scene, genre, 'auto');
  const end = sampleEnd(set);
  const seconds = end + SAMPLE_TAIL;
  const dj = new StudioDJ(seconds);
  dj.configure([set], defaultMix([set]), 'drop');
  clearInterval(dj.timer);  // the clock is moved by hand below, not by a timer
  dj.timer = null;
  dj.onBar = commitRiffs(scene, set, dj);
  // A couple of seconds of music at a time, so a set playing live never waits on the clip.
  for (let n = 0, clock = 0; clock + LOOKAHEAD < end; clock += 0.05, n++) {
    dj.clock = clock;
    dj.tick();
    if (n % 40 === 39) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  dj.crash(end, 1);
  const at = dj.toAudio(end);
  dj.master.gain.setValueAtTime(dj.master.gain.value, at);
  dj.master.gain.linearRampToValueAtTime(0, seconds - 0.05);
  const buffer = await dj.ctx.startRendering();
  try {
    return { blob: await mp3Blob(buffer), ext: 'mp3', seconds: Math.round(seconds), set };
  } catch {
    return { blob: wavBlob(buffer), ext: 'wav', seconds: Math.round(seconds), set };
  }
}

function loadLame() {
  if (window.lamejs) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = Object.assign(document.createElement('script'), { src: LAME_URL, onload: resolve, onerror: reject });
    document.head.append(script);
  });
}

// MP3, a slice at a time so the page stays responsive while it encodes.
async function mp3Blob(buffer) {
  await loadLame();
  const pcm = (data) => {
    const out = new Int16Array(data.length);
    for (let i = 0; i < data.length; i++) {
      const x = Math.max(-1, Math.min(1, data[i]));
      out[i] = x < 0 ? x * 0x8000 : x * 0x7fff;
    }
    return out;
  };
  const left = pcm(buffer.getChannelData(0));
  const right = pcm(buffer.getChannelData(buffer.numberOfChannels > 1 ? 1 : 0));
  const encoder = new lamejs.Mp3Encoder(2, buffer.sampleRate, MP3_KBPS);
  const parts = [];
  const block = 1152 * 10;  // small slices: a set may be playing live on the same page
  for (let i = 0; i < left.length; i += block) {
    const chunk = encoder.encodeBuffer(left.subarray(i, i + block), right.subarray(i, i + block));
    if (chunk.length) parts.push(new Uint8Array(chunk));
    await new Promise((r) => setTimeout(r, 0));
  }
  const end = encoder.flush();
  if (end.length) parts.push(new Uint8Array(end));
  return new Blob(parts, { type: 'audio/mpeg' });
}

// The lead line: the latest commits, one riff a bar in the drop and every other bar in the build-up.
function commitRiffs(scene, set, dj) {
  const nodes = scene.nodes;
  const maxDegree = nodes.reduce((m, n) => Math.max(m, n.d), 1);
  const hueBase = hashString(`${scene.repo.owner}/${scene.repo.name}`) % 360;  // as the light show colours deck A
  const tone = (n) => ((hueBase / 360) + n.c * 0.381966) % 1;
  const spot = (i, salt) => (hashString(`${i}:${salt}`) % 1000) / 1000;  // where the node would sit on screen
  const commits = scene.commits.filter((c) => c.n.length).slice(-64);
  const hubs = nodes.map((_, i) => i).slice(0, 8);
  let next = 0;
  return (bar, t, info) => {
    const { section, phraseBar } = info;
    if (section === 'build' ? phraseBar % 2 : section !== 'drop') return;
    const picked = commits.length ? commits[next++ % commits.length].n : hubs;
    const rhythm = section === 'drop' ? GENRES[set.genre].hook : [0, 4, 8, 12];
    rhythm.forEach((s, k) => {
      const i = picked[k % picked.length];
      const n = nodes[i];
      if (!n) return;
      const at = dj.stepTime(bar * 16 + s);
      const midi = dj.pitch(tone(n), 0.1 + 0.8 * spot(i, 'y'), Math.log1p(n.d) / Math.log1p(maxDegree), at);
      dj.lead(midi, at, section === 'drop' ? 0.8 : 0.55, (spot(i, 'x') * 2 - 1) * 0.7, 0);
    });
  };
}

// 16-bit PCM, which every mail client and music app can open.
function wavBlob(buffer) {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const bytes = frames * channels * 2;
  const view = new DataView(new ArrayBuffer(44 + bytes));
  const text = (offset, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + bytes, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, bytes, true);
  const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const x = Math.max(-1, Math.min(1, data[c][i]));
      view.setInt16(offset, x < 0 ? x * 0x8000 : x * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([view], { type: 'audio/wav' });
}
