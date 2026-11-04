// A song in the battle. Drop in an audio file and it becomes a deck: song-worker.js listens to it
// (tempo, beats, bars, key, and which passages sound alike), and this turns what it heard into a
// scene the light show can draw, where every beat is a star, beats that sound alike share a colour,
// and passages that repeat are linked. The song plays as it is, never stretched; dj.js brings the
// repo to its tempo and key when the two sync. Nothing is uploaded: the file stays in the browser.
// Shares the page's global scope with dj.js (NOTE_NAMES, GENRES via genres.js).

'use strict';

const SONG_RATE = 11025;  // plenty to hear the beat and the harmony
const SONG_FILE = /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|webm|aiff?)$/i;
const SOUND_NAMES = 'ABCDEFGHI';

function isSongFile(file) {
  return Boolean(file) && (/^audio\//.test(file.type || '') || SONG_FILE.test(file.name || ''));
}

function songTitle(name) {
  return String(name || '').replace(/\.[^.]+$/, '').replace(/_+/g, ' ').trim().slice(0, 80) || 'Your song';
}

function clock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// The file to a scene. `report` hears each step, for the cooking banner.
async function loadSongScene(file, report = () => {}) {
  if (!isSongFile(file)) throw new Error(`${file.name} doesn't look like a song. Try an MP3, WAV, M4A, OGG or FLAC.`);
  if (file.size > 250e6) throw new Error('That file is over 250 MB. Try an MP3 of it.');
  const title = songTitle(file.name);
  report('Reading the file');
  let buffer;
  try {
    buffer = await new OfflineAudioContext(2, 44100, 44100).decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new Error(`Couldn't play ${file.name}. Try an MP3, WAV, M4A or OGG.`);
  }
  if (buffer.duration < 30) throw new Error(`${title} is under 30 seconds: too short to battle.`);
  report('Listening for the beat');
  const { samples, rms } = mixDown(buffer);
  const heard = await listen(samples);
  report('Mapping the song');
  return songScene(title, buffer, heard, rms);
}

// Mono at SONG_RATE for listening, and how loud the song is overall.
function mixDown(buffer) {
  const factor = Math.max(1, Math.round(buffer.sampleRate / SONG_RATE));
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const length = Math.floor(buffer.length / factor);
  const samples = new Float32Array(length);
  let sq = 0;
  for (let i = 0; i < length; i++) {
    let v = 0;
    for (let j = 0; j < factor; j++) {
      for (const ch of channels) v += ch[i * factor + j];
    }
    v /= factor * channels.length;
    samples[i] = v;
    sq += v * v;
  }
  return { samples, rms: Math.sqrt(sq / Math.max(1, length)) };
}

function listen(samples) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('song-worker.js');
    worker.onmessage = ({ data }) => {
      worker.terminate();
      if (data.ok) resolve(data.analysis);
      else reject(new Error(data.error === 'no steady beat' || data.error === 'not enough of a steady beat'
        ? "Couldn't find a steady beat in that song. Something with a clear kick works best."
        : `Couldn't listen to that song (${data.error}).`));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(`Couldn't listen to that song (${event.message || 'the listener crashed'}).`));
    };
    worker.postMessage({ samples, rate: SONG_RATE }, [samples.buffer]);
  });
}

// What the listener heard, as a scene: the same shape as a repository's, so the show draws it the same way.
function songScene(title, buffer, a, rms) {
  const degree = new Array(a.nodes.length).fill(0);
  for (const [s, t] of a.links) {
    degree[s]++;
    degree[t]++;
  }
  const nodes = a.nodes.map((b, i) => ({
    l: clock(b.t), f: `Sound ${SOUND_NAMES[b.c]}`, c: b.c, d: degree[i] + Math.round(5 * b.e * b.e), k: 'beat',
  }));
  const sizes = new Array(a.clusters).fill(0);
  for (const b of a.nodes) sizes[b.c]++;
  const commits = Array.from({ length: a.bars }, (_, bar) => {
    const beats = [0, 1, 2, 3].map((k) => bar * 4 + k);
    const tally = new Map();
    for (const i of beats) tally.set(a.nodes[i].c, (tally.get(a.nodes[i].c) || 0) + 1);
    const sound = [...tally].sort((x, y) => y[1] - x[1])[0][0];
    return { h: `bar ${bar + 1}`, t: null, a: title, m: `${clock(a.first + bar * a.barLen)} · Sound ${SOUND_NAMES[sound]}`, f: 4, n: beats };
  });
  return {
    song: {
      title, buffer, bpm: a.bpm, barLen: a.barLen, first: a.first, bars: a.bars, startBar: a.startBar,
      key: a.key, mode: a.mode, gain: Math.min(2, 0.17 / Math.max(rms, 1e-4)),
      kicks: a.nodes.map((b) => b.low), snaps: a.nodes.map((b) => b.high),
    },
    title,
    repo: { owner: '', name: title, url: null },
    nodes,
    links: a.links,
    communities: sizes.map((size, i) => ({ name: `Sound ${SOUND_NAMES[i]}`, size })),
    commits,
    stats: { nodes_total: nodes.length, links_total: a.links.length },
    trimmed: false,
  };
}

// A song's set: its own tempo and key, and a genre that only colours its graph.
function songSet(scene) {
  const s = scene.song;
  const minor = s.mode !== 'ionian';
  const modeName = minor ? 'minor' : 'major';
  const genre = s.bpm >= 160 ? 'dnb' : s.bpm >= 134 ? 'trance' : minor && s.bpm >= 124 ? 'techno' : s.bpm >= 126 ? 'bigroom' : 'house';
  const bpm = Math.round(s.bpm);
  const keyName = `${NOTE_NAMES[s.key]} ${modeName}`;
  return {
    genre, choice: 'song', key: s.key, mode: s.mode, modeName, bpm: s.bpm, progression: [0, 0, 0, 0],
    lead: 'pluck', codeLead: 'pluck', topExt: null, reverb: 2.2, density: 0.45, swing: 0, song: s,
    reasons: [
      `${s.title} is in ${keyName} at ${s.bpm.toFixed(1)} BPM: found by listening to it, right here in your browser.`,
      'It plays as it is, never stretched or re-pitched. When you sync, the repo comes to its tempo and key.',
      `Each beat is a star. Beats that sound alike share a colour (${scene.communities.length} sounds), and passages that come back are linked, so the song's shape pulls together.`,
      `It comes in at its loudest stretch, ${clock(s.first + s.startBar * s.barLen)} in, and loops from there.`,
    ],
    label: `${keyName} · ${bpm} BPM · your song`,
  };
}
