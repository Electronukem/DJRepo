// The DJ. The genre, key and tempo come from the repository or the chosen genre (deriveSet);
// the arrangement cycles through grooves, build-ups, drops and breakdowns; and the lead line
// comes from the light show (app.js asks for a note whenever light lands on a node, and that
// node's colour, height and position decide what is heard). Everything is synthesised with Web
// Audio. All timing is in performance.now() seconds so visuals and sound share one clock; the
// DJ converts to AudioContext time when it schedules, and records every drum hit so the
// visuals can hit with it.

'use strict';

const SCALES = {
  ionian:     [0, 2, 4, 5, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  dorian:     [0, 2, 3, 5, 7, 9, 10],
  aeolian:    [0, 2, 3, 5, 7, 8, 10],
  phrygian:   [0, 1, 3, 5, 7, 8, 10],
};
const MINOR = new Set(['dorian', 'aeolian', 'phrygian']);
const PENTA = { minor: [0, 3, 5, 7, 10], major: [0, 2, 4, 7, 9] };

// Chord progressions as scale degrees, one chord per bar.
const PROGRESSIONS = {
  minor: [[0, 5, 2, 6], [0, 5, 3, 4], [0, 3, 5, 6], [5, 6, 0, 0], [0, 6, 5, 6]],
  major: [[0, 4, 5, 3], [5, 3, 0, 4], [0, 5, 3, 4], [3, 4, 5, 5]],
  techno: [[0, 0, 0, 0], [0, 0, 5, 5], [0, 0, 6, 6], [0, 0, 0, 5]],
};

// The arrangement, in eight-bar phrases (drops last sixteen). After the intro it loops.
const SECTIONS = {
  intro:  { label: 'Intro', bars: 8, energy: 0.35 },
  groove: { label: 'Groove', bars: 8, energy: 0.6 },
  build:  { label: 'Build-up', bars: 8, energy: 0.7 },
  drop:   { label: 'Drop', bars: 16, energy: 1 },
  break:  { label: 'Breakdown', bars: 8, energy: 0.3 },
};
const CYCLE = ['groove', 'build', 'drop', 'break', 'build', 'drop'];

// level: the default volume. trim: loudness calibration so every channel at the same level
// sits at a similar loudness. duck: how much the kick pumps it (sidechain). reverb/echo: sends.
const CHANNELS = [
  { id: 'kick', name: 'Kick', group: 'drums', level: 0.9, trim: 1, reverb: 0.05 },
  { id: 'clap', name: 'Clap & snare', group: 'drums', level: 0.75, trim: 0.9, reverb: 0.5, echo: 0.1 },
  { id: 'hats', name: 'Hi-hats', group: 'drums', level: 0.6, trim: 1.75, reverb: 0.15 },
  { id: 'perc', name: 'Percussion', group: 'drums', level: 0.55, trim: 1.2, reverb: 0.3, echo: 0.2 },
  { id: 'bass', name: 'Bass', group: 'synths', level: 0.8, trim: 1, duck: 1, reverb: 0 },
  { id: 'chords', name: 'Chords', group: 'synths', level: 0.6, trim: 1.2, duck: 1, reverb: 0.6, echo: 0.35 },
  { id: 'pad', name: 'Pad', group: 'synths', level: 0.5, trim: 0.6, duck: 1, reverb: 1 },
  { id: 'arp', name: 'Arpeggio', group: 'synths', level: 0.45, trim: 1.5, duck: 1, reverb: 0.5, echo: 0.6 },
  { id: 'lead', name: 'Lead (the graph)', group: 'synths', level: 0.7, trim: 3.2, duck: 0.5, reverb: 0.6, echo: 0.7 },
  { id: 'fx', name: 'Risers & impacts', group: 'fx', level: 0.6, trim: 0.8, reverb: 0.8 },
];
const CHANNEL = Object.fromEntries(CHANNELS.map((c) => [c.id, c]));

// gain: loudness calibration between the lead sounds.
const LEADS = {
  pluck: { name: 'Pluck', gain: 1 },
  supersaw: { name: 'Supersaw', gain: 0.85 },
  bell: { name: 'FM bell', gain: 0.7 },
  chip: { name: '8-bit', gain: 2.6 },
  acid: { name: 'Acid', gain: 2.3 },
};

// What the code is written in picks the lead synth.
const LANGUAGE_LEADS = {
  bell:     ['py', 'pyi', 'ipynb', 'rb', 'r', 'jl', 'lua', 'pl', 'php', 'ex', 'exs', 'erl', 'hs', 'clj', 'ml', 'elm'],
  pluck:    ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'vue', 'svelte', 'astro', 'html', 'css', 'scss', 'sass', 'less', 'dart'],
  supersaw: ['c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh', 'rs', 'go', 'java', 'kt', 'kts', 'cs', 'swift', 'scala', 'zig', 'm', 'mm', 'sol'],
};
const FAMILY_OF_LEAD = { bell: 'scripting', pluck: 'web', supersaw: 'systems' };

const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const LOOKAHEAD = 0.25;      // seconds of music scheduled ahead
const MAX_LEAD_VOICES = 24;
const VELOCITY = { x: 1, o: 0.7, '.': 0.4 };
const BASS_GAIN = { offbeat: 0.8, rolling: 1, acid: 1.1, sub: 0.8, reese: 0.55 };  // loudness calibration

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const lane = (pattern, s) => (pattern ? VELOCITY[pattern[s]] || 0 : 0);

function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function sectionEnergy(section, progress) {
  return section === 'build' ? 0.5 + 0.5 * progress : SECTIONS[section].energy;
}

// What the repository sounds like. `choice` is a genre id, or 'repo' to let the repository pick;
// `leadChoice` is a lead id, or 'auto' to let the code's language pick.
function deriveSet(scene, choice = 'repo', leadChoice = 'auto') {
  const { stats, repo } = scene;
  const seed = hashString(`${repo.owner}/${repo.name}`.toLowerCase());
  const reasons = [];

  const total = sum(stats.hours);
  const daylight = total ? sum(stats.hours.slice(7, 19)) / total : 0.6;
  const night = total ? (sum(stats.hours.slice(0, 6)) + sum(stats.hours.slice(21))) / total : 0;
  const spanDays = stats.first && stats.last
    ? Math.max(1, (Date.parse(stats.last) - Date.parse(stats.first)) / 864e5) : 1;
  const perWeek = stats.commits ? (stats.commits / spanDays) * 7 : 0;
  const weekly = perWeek < 10 ? perWeek.toFixed(1) : String(Math.round(perWeek));

  // What the code is written in.
  const tally = { bell: 0, pluck: 0, supersaw: 0, chip: 0 };
  for (const [ext, count] of Object.entries(stats.languages || {})) {
    const lead = Object.keys(LANGUAGE_LEADS).find((k) => LANGUAGE_LEADS[k].includes(ext)) || 'chip';
    tally[lead] += count;
  }
  const codeLead = Object.keys(tally).reduce((a, b) => (tally[b] > tally[a] ? b : a), 'chip');
  const family = FAMILY_OF_LEAD[codeLead] || 'other';
  const topExt = Object.keys(stats.languages || {})[0];

  let genre = choice;
  if (!GENRES[genre] || genre === 'repo') {
    if (perWeek >= 35) {
      genre = 'dnb';
      reasons.push(`About ${weekly} commits a week is a fast-moving repo, so the set is drum & bass.`);
    } else if (night >= 0.4) {
      genre = 'techno';
      reasons.push(`${Math.round(night * 100)}% of the commits landed between 9pm and 6am, so the set is techno: a warehouse at 3am.`);
    } else if (family === 'web') {
      genre = 'bigroom';
      reasons.push(`Most of the code is .${topExt}, the language of the front end, so the set is big room: built for the main stage.`);
    } else if (family === 'systems') {
      genre = 'trance';
      reasons.push(`Most of the code is .${topExt}, close to the metal, so the set is trance: long builds, huge drops.`);
    } else {
      genre = 'house';
      reasons.push(`Most of the code is ${topExt ? `.${topExt}` : 'in its own mix of languages'}, so the set is house: warm and bouncy.`);
    }
  } else {
    reasons.push(`You picked ${GENRES[genre].name}: ${GENRES[genre].feel}.`);
  }
  const g = GENRES[genre];

  const [lo, hi] = g.bpm;
  const bpm = Math.round(lo + (hi - lo) * clamp(Math.log10(1 + perWeek) / 2, 0, 1));
  reasons.push(stats.commits
    ? `About ${weekly} commits a week sets the tempo at ${bpm} BPM, within ${g.name}'s ${lo}–${hi}.`
    : `${bpm} BPM, the middle of ${g.name}'s range.`);

  const mode = genre === 'techno' ? (daylight < 0.4 ? 'phrygian' : 'aeolian')
    : daylight >= 0.62 ? 'ionian' : daylight >= 0.48 ? 'dorian' : 'aeolian';
  const modeName = mode === 'ionian' ? 'major' : mode === 'aeolian' ? 'minor' : mode;
  reasons.push(total
    ? `${Math.round(daylight * 100)}% of the commits were made between 7am and 7pm, so it's in ${modeName}: `
      + (MINOR.has(mode) ? 'moody and hypnotic.' : 'euphoric, hands in the air.')
    : `There were no commit times to read, so it's in ${modeName}.`);

  const options = PROGRESSIONS[genre === 'techno' ? 'techno' : MINOR.has(mode) ? 'minor' : 'major'];
  const progression = options[(seed >>> 4) % options.length];
  const key = seed % 12;

  const lead = LEADS[leadChoice] ? leadChoice : codeLead;
  reasons.push(LEADS[leadChoice]
    ? `You picked the ${LEADS[lead].name} lead.`
    : `The lead synth is ${LEADS[lead].name}${topExt ? `, to suit the .${topExt} code` : ''}.`);

  const reverb = 1.4 + 1.8 * clamp(Math.log10(Math.max(10, stats.nodes_total)) / 4, 0, 1);
  reasons.push(`${stats.nodes_total.toLocaleString()} pieces of code, so the room rings for ${reverb.toFixed(1)} seconds.`);
  const avgDegree = stats.nodes_total ? (2 * stats.links_total) / stats.nodes_total : 2;
  const density = clamp(0.3 + avgDegree / 10, 0.3, 0.8);
  reasons.push(`Each of the ${scene.communities.length} clusters of related code has its own colour, and each colour is a note. `
    + 'When light reaches a star, the lead plays it: height on screen picks the octave and left–right is where you hear it.');

  return {
    genre, choice, key, mode, bpm, progression, lead, codeLead, topExt, reverb, density, reasons,
    swing: g.swing || 0,
    label: `${NOTE_NAMES[key]} ${modeName} · ${bpm} BPM · ${g.name}`,
  };
}

// The mix the set suggests: everything on, with the arpeggio only where the genre wants one.
function defaultMix(set) {
  return Object.fromEntries(CHANNELS.map((c) => [c.id, { on: c.id !== 'arp' || GENRES[set.genre].arpOn, level: c.level }]));
}

class DJ {
  constructor() {
    this.ctx = null;
    this.set = null;
    this.genre = null;
    this.timer = null;
    this.deck = null;       // this set's channels and filters; replaced (and faded out) on every configure
    this.offset = null;     // AudioContext time minus performance time
    this.volume = 0.8;
    this.muted = false;
    this.mix = {};
    this.leadSound = 'pluck';
    this.leadVoices = 0;
    this.hits = [];         // drum hits as { type, t, v }, oldest first, for the visuals
    this.phrases = [];
    this.onBar = null;      // (bar, time, info) => void, called a little ahead of each bar
  }

  // Must run inside a user gesture: browsers only allow sound after one.
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.buildMaster();
      if (this.set) this.buildDeck();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  now() {
    return performance.now() / 1000;
  }

  // `opening` is 'intro' to start from the top, or 'drop' to come in with a short build-up and a drop.
  configure(set, mix = defaultMix(set), opening = 'intro') {
    this.stop();
    this.set = set;
    this.genre = GENRES[set.genre];
    this.beat = 60 / set.bpm;
    this.sixteenth = this.beat / 4;
    this.barLen = this.beat * 4;
    this.key = 33 + ((set.key + 3) % 12);  // the bass root, A1–A♭2
    this.leadSound = set.lead;
    this.start = this.now() + 0.3;
    this.nextStep = 0;
    if (opening === 'drop') {
      this.phrases = [{ section: 'build', start: 0, bars: 4 }, { section: 'drop', start: 4, bars: SECTIONS.drop.bars }];
      this.cycle = CYCLE.indexOf('break');
    } else {
      this.phrases = [{ section: 'intro', start: 0, bars: SECTIONS.intro.bars }];
      this.cycle = 0;
    }
    this.hits = [];
    this.setMix(mix);
    if (this.ctx) {
      this.reverb.buffer = this.impulse(set.reverb);
      this.delay.delayTime.value = this.beat * 0.75;  // a dotted eighth
      this.buildDeck();
    }
    this.timer = setInterval(() => this.tick(), 25);
    this.tick();
  }

  // Stop the set and fade out whatever is still ringing, so a new key never clashes with the old.
  stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (!this.deck) return;
    const { out } = this.deck;
    const t = this.ctx.currentTime;
    out.gain.cancelScheduledValues(t);
    out.gain.setValueAtTime(out.gain.value, t);
    out.gain.setTargetAtTime(0, t, 0.12);
    setTimeout(() => out.disconnect(), 1500);
    this.deck = null;
  }

  setMix(mix) {
    for (const c of CHANNELS) this.setChannel(c.id, mix[c.id] || { on: false, level: c.level });
  }

  setChannel(id, state) {
    this.mix[id] = { on: Boolean(state.on), level: clamp(Number(state.level) || 0, 0, 1) };
    const bus = this.deck && this.deck.buses[id];
    if (bus) {
      const t = this.ctx.currentTime;
      bus.gain.cancelScheduledValues(t);
      bus.gain.setTargetAtTime(this.mix[id].on ? this.mix[id].level : 0, t, 0.05);
    }
  }

  setVolume(v) {
    this.volume = v;
    this.applyLevel();
  }

  setMuted(m) {
    this.muted = m;
    this.applyLevel();
  }

  applyLevel() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, t, 0.05);
  }

  // ---- the arrangement ----

  phraseAt(bar) {
    bar = Math.max(0, bar);
    let last = this.phrases[this.phrases.length - 1];
    while (last.start + last.bars <= bar) {
      const section = CYCLE[this.cycle % CYCLE.length];
      this.cycle++;
      last = { section, start: last.start + last.bars, bars: SECTIONS[section].bars };
      this.phrases.push(last);
      if (this.phrases.length > 24) this.phrases.shift();
    }
    for (let k = this.phrases.length - 1; k >= 0; k--) {
      if (this.phrases[k].start <= bar) return this.phrases[k];
    }
    return this.phrases[0];
  }

  // Cut to a short build-up from the next bar, then drop. False if a drop is already on its way.
  requestDrop() {
    if (!this.set) return false;
    const bar = Math.ceil(this.nextStep / 16);  // the first bar not scheduled yet
    const p = this.phraseAt(bar);
    if (p.section === 'drop' || p.section === 'build') return false;
    this.phrases = this.phrases.filter((x) => x.start < bar);
    const current = this.phrases[this.phrases.length - 1];
    if (current) current.bars = bar - current.start;
    this.phrases.push({ section: 'build', start: bar, bars: 4 }, { section: 'drop', start: bar + 4, bars: SECTIONS.drop.bars });
    this.cycle = CYCLE.indexOf('break');
    return true;
  }

  // Where the set is at time t, for the visuals.
  position(t) {
    if (!this.set) return null;
    const beats = (t - this.start) / this.beat;
    const barF = beats / 4;
    const bar = Math.floor(barF);
    const p = this.phraseAt(bar);
    const progress = clamp((barF - p.start) / p.bars, 0, 1);
    const next = this.phraseAt(p.start + p.bars);
    return {
      beats, barF, bar, beatInBar: beats - bar * 4,
      section: p.section, phraseBar: bar - p.start, bars: p.bars, progress,
      next: next.section, barsLeft: p.start + p.bars - Math.max(0, bar),
      energy: sectionEnergy(p.section, progress),
    };
  }

  hit(type, t, v) {
    this.hits.push({ type, t, v });
    if (this.hits.length > 400) {
      const old = this.now() - 4;
      this.hits = this.hits.filter((h) => h.t > old);
    }
  }

  // The latest hit of one of `types` at or before t.
  lastHit(types, t) {
    for (let k = this.hits.length - 1; k >= 0; k--) {
      const h = this.hits[k];
      if (h.t <= t && types.includes(h.type)) return h;
    }
    return null;
  }

  hitsBetween(from, to) {
    return this.hits.filter((h) => h.t > from && h.t <= to);
  }

  // ---- time & harmony ----

  tick() {
    this.syncClock();
    const horizon = this.now() + LOOKAHEAD;
    while (this.stepTime(this.nextStep) < horizon) {
      const i = this.nextStep++;
      this.step(i, this.stepTime(i));
    }
  }

  // Sixteenth note i, with the genre's swing on the off-sixteenths.
  stepTime(i) {
    return this.start + i * this.sixteenth + (i % 2 ? this.set.swing * this.sixteenth : 0);
  }

  barAt(t) {
    return Math.floor((t - this.start) / this.barLen);
  }

  // The next grid line at or after t, in beats (0.25 = sixteenths).
  quantize(t, division = 0.25) {
    const grid = this.beat * division;
    return this.start + Math.ceil((t - this.start) / grid - 1e-6) * grid;
  }

  chord(bar) {
    const { mode, progression } = this.set;
    const steps = SCALES[mode];
    const len = progression.length;
    const degree = progression[((bar % len) + len) % len];
    const tone = (k) => steps[(degree + k) % 7] + 12 * Math.floor((degree + k) / 7);
    const tones = [tone(0), tone(2), tone(4), tone(6)];  // root, third, fifth, seventh
    // Melody notes: the triad plus the pentatonic notes that don't rub a semitone against it.
    const triad = tones.slice(0, 3).map((x) => x % 12);
    const rubs = (p) => !triad.includes(p) && triad.some((c) => [1, 11].includes((p - c + 12) % 12));
    const penta = PENTA[MINOR.has(mode) ? 'minor' : 'major'];
    const palette = [...new Set([...triad, ...penta])].filter((p) => !rubs(p)).sort((a, b) => a - b);
    // Scale steps above the chord root, for bass lines.
    const above = (k) => steps[(degree + k) % 7] + 12 * Math.floor((degree + k) / 7) - tones[0];
    return { degree, tones, palette, above };
  }

  // tone 0–1 chooses the note, height 0 (bottom) – 1 (top) the octave, weight 0–1 how much of a hub it is.
  pitch(tone, height, weight, t) {
    const { palette } = this.chord(this.barAt(t));
    const pc = palette[Math.min(palette.length - 1, Math.floor(clamp(tone, 0, 0.999) * palette.length))];
    let octave = height < 0.33 ? 0 : height < 0.7 ? 1 : 2;
    if (weight > 0.6) octave -= 1;  // hubs speak lower
    let midi = this.key + 24 + pc + 12 * Math.max(0, octave);
    while (midi > 93) midi -= 12;
    return midi;
  }

  // One sixteenth: drums, bass and arpeggio. Bar-long parts start on step 0.
  step(i, t) {
    const s = i % 16;
    const bar = Math.floor(i / 16);
    const p = this.phraseAt(bar);
    const sec = p.section;
    const pb = bar - p.start;
    const prog = (pb + s / 16) / p.bars;
    const lastBar = pb === p.bars - 1;
    const g = this.genre;
    const d = g.drums;
    const sound = this.ready();

    if (s === 0) this.startBar(bar, t, p, sound);

    // Kick: everywhere but the breakdown, and out for the last stretch of a build-up.
    const kickOn = sec === 'drop' || sec === 'groove' || sec === 'intro' || (sec === 'build' && prog < 0.75);
    const kv = kickOn ? lane(d.kick, s) : 0;
    if (kv) {
      this.hit('kick', t, kv);
      if (sound) {
        this.kick(t, kv);
        if (this.mix.kick.on) this.pump(t, kv);
      }
    }

    // Claps on the backbeat; a snare roll that speeds up through the build-up, then one beat of silence.
    if (sec === 'drop' || sec === 'groove') {
      const v = lane(d.clap, s);
      if (v) {
        this.hit('clap', t, v);
        if (sound) (g.snare ? this.snare(t, v, 1) : this.clap(t, v));
      }
    } else if (sec === 'build') {
      const every = prog < 0.5 ? 4 : prog < 0.75 ? 2 : 1;
      const gap = lastBar && s >= 12;
      if (!gap && s % every === 0) {
        const v = 0.3 + 0.7 * prog;
        this.hit('roll', t, v);
        if (sound) this.snare(t, v * 0.8, 1 + prog);
      }
    }

    // Hats and percussion.
    const hats = sec === 'drop' || sec === 'groove' || (sec === 'intro' && pb >= 2) || (sec === 'build' && prog < 0.5)
      || (sec === 'break' && pb >= 4);
    if (hats && sound) {
      const scale = sec === 'drop' ? 1 : sec === 'break' ? 0.4 : 0.75;
      const c = lane(d.hatC, s);
      if (c) this.hat(t, c * scale, false);
      const o = sec === 'drop' || sec === 'groove' ? lane(d.hatO, s) : 0;
      if (o) this.hat(t, o * scale, true);
    }
    const percOn = sec === 'drop' || sec === 'groove' || (sec === 'intro' && pb >= 4);
    const pv = percOn ? lane(d.perc, s) : 0;
    if (pv && sound) this.perc(t, pv, g.perc);

    // Bass.
    const bassOn = sec === 'drop' || sec === 'groove' || (sec === 'intro' && pb >= 4) || (sec === 'build' && prog < 0.5);
    const bv = bassOn ? lane(g.bass.pattern, s) : 0;
    if (bv && sound) this.bassStep(t, bar, s, bv, sec);

    // Arpeggio.
    const arpOn = sec === 'drop' || sec === 'groove' || sec === 'build' || sec === 'break';
    const av = arpOn ? lane(g.arp, s) : 0;
    if (av && sound && !(sec === 'build' && lastBar && s >= 12)) this.arpStep(t, bar, s, av, sec, prog);
  }

  startBar(bar, t, p, sound) {
    const sec = p.section;
    const pb = bar - p.start;
    const chord = this.chord(bar);
    if (pb === 0) {
      if (sec === 'drop') this.hit('impact', t, 1);
      else if (sec === 'groove') this.hit('crash', t, 0.6);
    } else if (sec === 'drop' && pb === 8) {
      this.hit('crash', t, 0.7);
    }
    if (sound) {
      if (pb === 0) this.phraseFx(t, p);
      if (sec === 'drop' && pb === 8) this.crash(t, 0.7);
      if (sec !== 'intro') this.chordBar(t, bar, chord, sec, (pb + 0) / p.bars);
      if (sec !== 'groove') this.padBar(t, chord, sec, pb / p.bars);
    }
    if (this.onBar) this.onBar(bar, t, { section: sec, phraseBar: pb, bars: p.bars, chord });
  }

  // Filter moves, risers and impacts at the top of each phrase.
  phraseFx(t, p) {
    const at = this.toAudio(t);
    const { hp, lp } = this.deck;
    const len = p.bars * this.barLen;
    hp.frequency.cancelScheduledValues(at);
    lp.frequency.cancelScheduledValues(at);
    hp.frequency.setValueAtTime(20, at);
    lp.frequency.setValueAtTime(20000, at);
    switch (p.section) {
      case 'intro':  // the DJ slowly opens the filter
        lp.frequency.setValueAtTime(420, at);
        lp.frequency.exponentialRampToValueAtTime(20000, at + len);
        break;
      case 'build': {
        const gap = at + len - this.beat;
        hp.frequency.setValueAtTime(20, at + len * 0.5);
        hp.frequency.exponentialRampToValueAtTime(420, gap);
        this.riser(t, len - this.beat);
        break;
      }
      case 'drop':
        this.impact(t);
        break;
      case 'break':
        this.downlifter(t, this.barLen * 2);
        break;
      default:
        this.crash(t, 0.6);
    }
  }

  // ---- mixing ----

  syncClock() {
    if (!this.ctx || this.ctx.state !== 'running') return;
    let offset = null;
    if (this.ctx.getOutputTimestamp) {
      const ts = this.ctx.getOutputTimestamp();
      if (ts.performanceTime > 0) offset = ts.contextTime - ts.performanceTime / 1000;
    }
    if (offset === null) offset = this.ctx.currentTime - performance.now() / 1000;
    if (this.offset === null || Math.abs(offset - this.offset) > 0.03) this.offset = offset;
  }

  toAudio(t) {
    return t + (this.offset ?? 0);
  }

  ready() {
    return Boolean(this.ctx && this.deck && !this.muted && this.ctx.state === 'running');
  }

  buildMaster() {
    const ctx = this.ctx;
    this.bus = ctx.createGain();
    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -16;
    glue.ratio.value = 3;
    glue.attack.value = 0.01;
    glue.release.value = 0.2;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -4;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.1;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.72;
    this.spectrumData = new Uint8Array(this.analyser.frequencyBinCount);
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.bus.connect(glue).connect(limiter).connect(this.analyser).connect(this.master).connect(ctx.destination);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(2.4);
    this.revSend = ctx.createGain();
    this.revSend.gain.value = 0.5;
    const revOut = ctx.createGain();
    revOut.gain.value = 0.6;
    this.revSend.connect(this.reverb).connect(revOut).connect(this.bus);

    this.delay = ctx.createDelay(2);
    this.delay.delayTime.value = 0.35;
    this.delaySend = ctx.createGain();
    this.delaySend.gain.value = 0.3;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.38;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 3200;
    const cut = ctx.createBiquadFilter();
    cut.type = 'highpass';
    cut.frequency.value = 300;  // keep echoes out of the low end
    this.delaySend.connect(cut).connect(this.delay);
    this.delay.connect(tone).connect(feedback).connect(this.delay);
    tone.connect(this.bus);
    tone.connect(this.revSend);

    // A soft clipper for the kick: rounder and louder than a plain sine.
    this.drive = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      this.drive[i] = Math.tanh(2.2 * x) / Math.tanh(2.2);
    }
  }

  // One channel per part, so each can be switched and balanced on its own, plus the DJ's filters.
  buildDeck() {
    const ctx = this.ctx;
    const out = ctx.createGain();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 20;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 20000;
    const mixIn = ctx.createGain();
    mixIn.connect(hp).connect(lp).connect(out).connect(this.bus);
    const duck = ctx.createGain();
    duck.connect(mixIn);
    const lightDuck = ctx.createGain();  // the lead pumps, but only a little
    lightDuck.connect(mixIn);

    const buses = {};
    const inputs = {};
    for (const c of CHANNELS) {
      const bus = ctx.createGain();
      const state = this.mix[c.id];
      bus.gain.value = state && state.on ? state.level : 0;
      bus.connect(c.duck === 1 ? duck : c.duck ? lightDuck : mixIn);
      if (c.reverb) {
        const rev = ctx.createGain();
        rev.gain.value = c.reverb;
        bus.connect(rev).connect(this.revSend);
      }
      if (c.echo) {
        const echo = ctx.createGain();
        echo.gain.value = c.echo;
        bus.connect(echo).connect(this.delaySend);
      }
      buses[c.id] = bus;
      inputs[c.id] = bus;
    }
    const shaper = ctx.createWaveShaper();
    shaper.curve = this.drive;
    shaper.connect(buses.kick);
    inputs.kick = shaper;
    this.deck = { out, hp, lp, duck, lightDuck, buses, inputs };
  }

  spectrum() {
    if (!this.analyser) return null;
    this.analyser.getByteFrequencyData(this.spectrumData);
    return this.spectrumData;
  }

  impulse(seconds) {
    const ctx = this.ctx;
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      let smooth = 0;
      for (let i = 0; i < length; i++) {
        smooth += 0.5 * ((Math.random() * 2 - 1) - smooth);
        data[i] = smooth * Math.pow(1 - i / length, 3);
      }
    }
    return buffer;
  }

  noise() {
    if (!this.noiseBuffer) {
      const length = this.ctx.sampleRate * 2;
      this.noiseBuffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    }
    return this.noiseBuffer;
  }

  // ---- building blocks ----

  // A gain that rises to `peak` over `attack` and dies away over `decay`, into `dest`.
  envelope(dest, at, peak, attack, decay) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(peak, at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
    g.connect(dest);
    return g;
  }

  osc(type, freq, dest, at, stopAt, detune = 0) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    o.detune.value = detune;
    o.connect(dest);
    o.start(at);
    o.stop(stopAt);
    return o;
  }

  noiseSource(dest, at, stopAt) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise();
    src.loop = true;
    src.connect(dest);
    src.start(at, Math.random() * 1.5);
    src.stop(stopAt);
    return src;
  }

  filter(type, freq, q, dest) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    f.connect(dest);
    return f;
  }

  // When the last source stops, let go of the voice's own nodes.
  release(source, ...nodes) {
    source.onended = () => {
      for (const n of nodes) n.disconnect();
    };
  }

  // Sidechain: everything melodic ducks under the kick and swells back.
  pump(t, v) {
    const at = this.toAudio(t);
    const depth = (this.genre.pump ?? 0.6) * v;
    for (const [node, amount] of [[this.deck.duck, 1], [this.deck.lightDuck, 0.4]]) {
      node.gain.setTargetAtTime(1 - depth * amount, at, 0.004);
      node.gain.setTargetAtTime(1, at + 0.03, this.beat * 0.16);
    }
  }

  // ---- drums ----

  kick(t, v) {
    const at = this.toAudio(t);
    const style = {
      punchy: { from: 165, to: 50, sweep: 0.06, decay: 0.42, click: 0.35 },
      rumble: { from: 150, to: 44, sweep: 0.08, decay: 0.55, click: 0.3, rumble: true },
      tight:  { from: 190, to: 52, sweep: 0.045, decay: 0.32, click: 0.45 },
      big:    { from: 210, to: 46, sweep: 0.075, decay: 0.6, click: 0.5 },
    }[this.genre.kick];
    const input = this.deck.inputs.kick;
    const peak = 0.95 * v * CHANNEL.kick.trim;
    const amp = this.ctx.createGain();
    amp.gain.setValueAtTime(0.0001, at);
    amp.gain.linearRampToValueAtTime(peak, at + 0.003);
    amp.gain.setValueAtTime(peak, at + 0.03);
    amp.gain.exponentialRampToValueAtTime(0.0001, at + style.decay);
    amp.connect(input);
    const body = this.osc('sine', style.from, amp, at, at + style.decay + 0.05);
    body.frequency.setValueAtTime(style.from, at);
    body.frequency.exponentialRampToValueAtTime(style.to, at + style.sweep);
    body.frequency.exponentialRampToValueAtTime(style.to * 0.82, at + style.decay);
    this.release(body, amp);

    const click = this.envelope(input, at, style.click * v, 0.001, 0.012);
    const hp = this.filter('highpass', 1800, 0.7, click);
    this.release(this.noiseSource(hp, at, at + 0.03), hp, click);

    if (style.rumble) {  // the techno rumble: a dark, distorted tail under the next beat
      const tail = this.envelope(input, at + 0.05, 0.22 * v, 0.06, this.beat * 0.75);
      const lp = this.filter('lowpass', 140, 1.5, tail);
      this.release(this.osc('triangle', style.to * 0.95, lp, at + 0.05, at + this.beat), lp, tail);
    }
  }

  clap(t, v) {
    const at = this.toAudio(t);
    const g = this.ctx.createGain();
    const peak = 3 * v * CHANNEL.clap.trim;
    g.gain.setValueAtTime(0.0001, at);
    for (let k = 0; k < 3; k++) {  // a clap is a few hands, a few milliseconds apart
      const s = at + k * 0.011;
      g.gain.setValueAtTime(peak, s);
      g.gain.exponentialRampToValueAtTime(peak * 0.12, s + 0.009);
    }
    g.gain.setValueAtTime(peak * 0.8, at + 0.033);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.033 + 0.22);
    g.connect(this.deck.inputs.clap);
    const band = this.filter('bandpass', 1150, 0.9, g);
    this.release(this.noiseSource(band, at, at + 0.3), band, g);
  }

  snare(t, v, tone = 1) {
    const at = this.toAudio(t);
    const input = this.deck.inputs.clap;
    const peak = v * CHANNEL.clap.trim;
    const n = this.envelope(input, at, peak, 0.001, 0.16);
    const hp = this.filter('highpass', 900 * tone, 0.7, n);
    this.release(this.noiseSource(hp, at, at + 0.2), hp, n);
    const b = this.envelope(input, at, peak * 0.7, 0.001, 0.08);
    const body = this.osc('triangle', 210 * tone, b, at, at + 0.1);
    body.frequency.exponentialRampToValueAtTime(165 * tone, at + 0.06);
    this.release(body, b);
  }

  hat(t, v, open) {
    const at = this.toAudio(t);
    const g = this.envelope(this.deck.inputs.hats, at, 0.4 * v * CHANNEL.hats.trim, 0.001, open ? 0.22 : 0.035);
    const band = this.filter('bandpass', 10500, 0.7, g);
    const hp = this.filter('highpass', 7200, 0.7, band);
    this.release(this.noiseSource(hp, at, at + (open ? 0.3 : 0.06)), hp, band, g);
  }

  perc(t, v, kind) {
    const at = this.toAudio(t);
    const input = this.deck.inputs.perc;
    const peak = 0.5 * v * CHANNEL.perc.trim;
    if (kind === 'conga') {
      const g = this.envelope(input, at, peak, 0.002, 0.18);
      const o = this.osc('sine', 380, g, at, at + 0.22);
      o.frequency.exponentialRampToValueAtTime(300, at + 0.08);
      this.release(o, g);
    } else if (kind === 'rim') {
      const g = this.envelope(input, at, peak * 2.2, 0.001, 0.035);
      this.release(this.osc('triangle', 1750, g, at, at + 0.05), g);
    } else if (kind === 'ride') {
      const g = this.envelope(input, at, peak * 1.2, 0.001, 0.45);
      const band = this.filter('bandpass', 8200, 2.5, g);
      this.release(this.noiseSource(band, at, at + 0.5), band, g);
    } else if (kind === 'ghost') {
      this.snareGhost(at, v);
    } else {  // shaker
      const g = this.envelope(input, at, peak * 2, 0.012, 0.06);
      const band = this.filter('bandpass', 6500, 1.2, g);
      this.release(this.noiseSource(band, at, at + 0.1), band, g);
    }
  }

  snareGhost(at, v) {
    const g = this.envelope(this.deck.inputs.perc, at, 0.6 * v * CHANNEL.perc.trim, 0.001, 0.07);
    const hp = this.filter('highpass', 1400, 0.7, g);
    this.release(this.noiseSource(hp, at, at + 0.1), hp, g);
  }

  crash(t, v) {
    const at = this.toAudio(t);
    const g = this.envelope(this.deck.inputs.fx, at, 0.3 * v * CHANNEL.fx.trim, 0.002, 1.8);
    const hp = this.filter('highpass', 4800, 0.7, g);
    this.release(this.noiseSource(hp, at, at + 1.9), hp, g);
  }

  // ---- fx ----

  riser(t, dur) {
    const at = this.toAudio(t);
    const end = at + dur;
    const input = this.deck.inputs.fx;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.42 * CHANNEL.fx.trim, end);
    g.gain.setTargetAtTime(0.0001, end, 0.02);
    g.connect(input);
    const band = this.filter('bandpass', 300, 1.6, g);
    band.frequency.setValueAtTime(300, at);
    band.frequency.exponentialRampToValueAtTime(9000, end);
    this.release(this.noiseSource(band, at, end + 0.1), band, g);

    // An upward sweep under the noise.
    const tone = this.ctx.createGain();
    tone.gain.setValueAtTime(0.0001, at);
    tone.gain.exponentialRampToValueAtTime(0.09 * CHANNEL.fx.trim, end);
    tone.gain.setTargetAtTime(0.0001, end, 0.02);
    tone.connect(input);
    const lp = this.filter('lowpass', 2600, 1, tone);
    const saw = this.osc('sawtooth', mtof(this.key + 36), lp, at, end + 0.1);
    saw.frequency.exponentialRampToValueAtTime(mtof(this.key + 60), end);
    this.release(saw, lp, tone);
  }

  impact(t) {
    const at = this.toAudio(t);
    const input = this.deck.inputs.fx;
    const boom = this.envelope(input, at, 0.9 * CHANNEL.fx.trim, 0.003, 1.4);
    const o = this.osc('sine', 75, boom, at, at + 1.5);
    o.frequency.exponentialRampToValueAtTime(30, at + 1.2);
    this.release(o, boom);
    this.crash(t, 1.3);
  }

  downlifter(t, dur) {
    const at = this.toAudio(t);
    const g = this.envelope(this.deck.inputs.fx, at, 0.35 * CHANNEL.fx.trim, 0.01, dur);
    const band = this.filter('bandpass', 6000, 1.4, g);
    band.frequency.exponentialRampToValueAtTime(220, at + dur);
    this.release(this.noiseSource(band, at, at + dur + 0.1), band, g);
  }

  // ---- bass ----

  bassStep(t, bar, s, v, sec) {
    const chord = this.chord(bar);
    const style = this.genre.bass.style;
    let midi = this.key + chord.tones[0];
    if (style === 'acid') midi += 12 + chord.above(this.genre.bass.notes[s] || 0);
    if (style === 'offbeat' && this.genre.bass.pattern[s] === 'o') midi += 12;
    const steps = style === 'reese' ? 8 : style === 'offbeat' || style === 'sub' ? 1.6 : 0.9;
    const dark = sec === 'intro' ? 0.35 : sec === 'groove' ? 0.75 : 1;
    this.bass(this.toAudio(t), midi, v, steps * this.sixteenth, style, dark, bar);
  }

  bass(at, midi, v, len, style, dark, bar) {
    const ctx = this.ctx;
    const f = mtof(midi);
    const end = at + len;
    const amp = ctx.createGain();
    const peak = 0.5 * v * CHANNEL.bass.trim * BASS_GAIN[style];
    amp.gain.setValueAtTime(0.0001, at);
    amp.gain.linearRampToValueAtTime(peak, at + 0.004);
    amp.gain.setValueAtTime(peak, end - 0.02);
    amp.gain.exponentialRampToValueAtTime(0.0001, end + 0.04);
    amp.connect(this.deck.inputs.bass);

    const lp = this.filter('lowpass', 400, 1, amp);
    const oscs = [];
    switch (style) {
      case 'offbeat':
        lp.Q.value = 4;
        lp.frequency.setValueAtTime(260 + 1700 * v * dark, at);
        lp.frequency.exponentialRampToValueAtTime(220, end);
        oscs.push(this.osc('sawtooth', f, lp, at, end + 0.05), this.osc('square', f / 2, lp, at, end + 0.05));
        break;
      case 'rolling':
        lp.Q.value = 2;
        lp.frequency.setValueAtTime(400 + 1200 * dark, at);
        lp.frequency.exponentialRampToValueAtTime(260, at + 0.12);
        oscs.push(this.osc('sawtooth', f, lp, at, end + 0.05));
        break;
      case 'acid': {
        // The cutoff wanders over each four bars; accents squelch.
        lp.Q.value = 13;
        const phase = (((bar % 4) + 4) % 4) / 4;
        const base = (240 + 1100 * (0.5 - 0.5 * Math.cos(phase * Math.PI * 2))) * dark;
        lp.frequency.setValueAtTime(base + (v > 0.9 ? 2600 : 900) * dark, at);
        lp.frequency.exponentialRampToValueAtTime(Math.max(120, base), at + 0.14);
        oscs.push(this.osc('sawtooth', f, lp, at, end + 0.05));
        break;
      }
      case 'reese': {
        lp.Q.value = 3;
        lp.frequency.value = 320 * dark + 60;
        const wob = ctx.createOscillator();
        wob.frequency.value = 2 / this.beat;  // wobbles in eighth notes
        const depth = ctx.createGain();
        depth.gain.value = 230 * dark;
        wob.connect(depth).connect(lp.frequency);
        wob.start(at);
        wob.stop(end + 0.05);
        oscs.push(this.osc('sawtooth', f, lp, at, end + 0.05, -16), this.osc('sawtooth', f, lp, at, end + 0.05, 16),
          this.osc('sine', f, amp, at, end + 0.05));
        break;
      }
      default:  // sub
        lp.frequency.value = 600;
        oscs.push(this.osc('sine', f, lp, at, end + 0.05), this.osc('triangle', f * 2, lp, at, end + 0.05));
    }
    this.release(oscs[0], lp, amp);
  }

  // ---- chords, pads and arpeggios ----

  // One chord per bar, gated in the genre's rhythm (held long in build-ups and breakdowns).
  chordBar(t, bar, chord, sec, prog) {
    const ctx = this.ctx;
    const at = this.toAudio(t);
    const style = this.genre.chords.style;
    const held = sec === 'build' || sec === 'break' || style === 'pad';
    const end = at + this.barLen;
    const level = { groove: 0.55, build: 0.4 + 0.5 * prog, drop: 1, break: 0.5 }[sec] * 0.32 * CHANNEL.chords.trim
      * (style === 'pad' ? 0.45 : 1);
    const cutoff = { groove: 1300, build: 500 + 6000 * prog * prog, drop: 6500, break: 1800 }[sec];

    const gate = ctx.createGain();
    gate.gain.setValueAtTime(0.0001, at);
    if (held) {
      gate.gain.linearRampToValueAtTime(level, at + (sec === 'break' ? this.barLen * 0.4 : 0.02));
      gate.gain.setValueAtTime(level, end - 0.05);
      gate.gain.setTargetAtTime(0.0001, end, sec === 'break' ? 0.6 : 0.08);
    } else {
      const pattern = this.genre.chords.pattern;
      const long = style === 'hook' ? 1.8 : style === 'gate' ? 0.85 : 1.1;
      for (let k = 0; k < 16; k++) {
        if (pattern[k] === '-') continue;
        const s = this.toAudio(this.stepTime(bar * 16 + k));
        gate.gain.setValueAtTime(0.0001, s);
        gate.gain.linearRampToValueAtTime(level, s + 0.004);
        gate.gain.exponentialRampToValueAtTime(level * 0.35, s + this.sixteenth * long * 0.7);
        gate.gain.exponentialRampToValueAtTime(0.0001, s + this.sixteenth * long);
      }
    }
    gate.connect(this.deck.inputs.chords);

    const root = this.key + 24 + (style === 'hook' ? 12 : 0);
    const [r, third, fifth, seventh] = chord.tones;
    const notes = style === 'dub' ? [r, third, fifth, seventh] : [r, third, fifth, r + 12];
    if (style === 'hook') notes.push(fifth + 12);
    const spread = style === 'gate' || style === 'hook' ? [-14, -6, 0, 6, 14] : style === 'stab' ? [-5, 5] : [-8, 8];
    const type = style === 'stab' ? 'square' : 'sawtooth';
    const stopAt = end + (held ? 2 : 0.3);
    const scale = ctx.createGain();  // the same loudness however many oscillators make the chord
    scale.gain.value = 1 / Math.sqrt(notes.length * spread.length);
    scale.connect(gate);
    const lp = this.filter('lowpass', cutoff, style === 'dub' ? 5 : 0.8, scale);
    const oscs = [];
    for (const n of notes) {
      for (const cents of spread) oscs.push(this.osc(type, mtof(root + n), lp, at, stopAt, cents));
    }
    this.release(oscs[0], lp, scale, gate);
  }

  padBar(t, chord, sec, prog) {
    const ctx = this.ctx;
    const at = this.toAudio(t);
    const len = this.barLen;
    const level = { intro: 0.6, build: 0.5 + 0.3 * prog, drop: 0.3, break: 0.9 }[sec] * 0.2 * CHANNEL.pad.trim;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(level, at + len * 0.45);
    g.gain.setValueAtTime(level, at + len);
    g.gain.exponentialRampToValueAtTime(0.0001, at + len * 1.9);
    g.connect(this.deck.inputs.pad);
    const lp = this.filter('lowpass', sec === 'build' ? 900 + 3000 * prog : 1500, 0.7, g);
    const root = this.key + 24;
    const [r, third, fifth] = chord.tones;
    const stopAt = at + len * 2;
    const oscs = [];
    for (const n of [r - 12, r, third, fifth, r + 12]) {
      oscs.push(this.osc('sawtooth', mtof(root + n), lp, at, stopAt, -9), this.osc('sawtooth', mtof(root + n), lp, at, stopAt, 9));
    }
    this.release(oscs[0], lp, g);
  }

  arpStep(t, bar, s, v, sec, prog) {
    const chord = this.chord(bar);
    const [r, third, fifth] = chord.tones;
    const run = [r, third, fifth, r + 12, fifth + 12, r + 12, fifth, third];  // up and back down
    const midi = this.key + 36 + run[(bar * 16 + s) % run.length];
    const cutoff = { groove: 1600, build: 700 + 5500 * prog * prog, drop: 5200, break: 1100 }[sec];
    const level = { groove: 0.6, build: 0.5 + 0.5 * prog, drop: 0.9, break: 0.45 }[sec];
    const at = this.toAudio(t);
    const g = this.envelope(this.deck.inputs.arp, at, 0.2 * v * level * CHANNEL.arp.trim, 0.003, this.sixteenth * 1.6);
    const lp = this.filter('lowpass', cutoff, 2, g);
    lp.frequency.setValueAtTime(cutoff * 1.8, at);
    lp.frequency.exponentialRampToValueAtTime(cutoff, at + 0.08);
    const f = mtof(midi);
    const o = this.osc('square', f, lp, at, at + this.sixteenth * 1.8);
    this.osc('sawtooth', f, lp, at, at + this.sixteenth * 1.8, 7);
    this.release(o, lp, g);
  }

  // ---- the lead: one note from the graph ----

  // velocity 0–1, pan −1 (left) – 1 (right).
  lead(midi, t, velocity = 0.6, pan = 0) {
    if (!this.ready() || !this.mix.lead?.on || this.leadVoices >= MAX_LEAD_VOICES) return;
    const ctx = this.ctx;
    if (this.toAudio(t) < ctx.currentTime - 0.02) return;
    const at = Math.max(this.toAudio(t), ctx.currentTime);
    const out = ctx.createGain();
    out.gain.value = 0.22 * velocity * CHANNEL.lead.trim * (LEADS[this.leadSound]?.gain ?? 1);
    const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (panner) {
      panner.pan.value = clamp(pan, -1, 1);
      out.connect(panner).connect(this.deck.inputs.lead);
    } else {
      out.connect(this.deck.inputs.lead);
    }
    const source = this.leadVoice(this.leadSound, out, mtof(midi), at);
    this.leadVoices++;
    source.onended = () => {
      this.leadVoices--;
      out.disconnect();
      if (panner) panner.disconnect();
    };
  }

  // Builds the sound into `out`; returns the source that stops last.
  leadVoice(kind, out, f, at) {
    const ctx = this.ctx;
    switch (kind) {
      case 'supersaw': {
        const g = this.envelope(out, at, 0.5, 0.006, 0.55);
        const lp = this.filter('lowpass', 5200, 0.7, g);
        let last;
        for (const cents of [-18, -8, 0, 8, 18]) last = this.osc('sawtooth', f, lp, at, at + 0.62, cents);
        this.osc('sawtooth', f * 2, lp, at, at + 0.62, 4);
        return last;
      }
      case 'bell': {  // two-operator FM
        const g = this.envelope(out, at, 1, 0.002, 1.3);
        const carrier = this.osc('sine', f, g, at, at + 1.35);
        const mod = ctx.createOscillator();
        mod.frequency.value = f * 3.5;
        const index = ctx.createGain();
        index.gain.setValueAtTime(f * 2.2, at);
        index.gain.exponentialRampToValueAtTime(f * 0.05, at + 0.9);
        mod.connect(index).connect(carrier.frequency);
        mod.start(at);
        mod.stop(at + 1.35);
        return carrier;
      }
      case 'chip': {
        const g = this.envelope(out, at, 0.45, 0.002, 0.26);
        const o = this.osc('square', f, g, at, at + 0.3);
        o.frequency.setValueAtTime(f * 2, at);  // a little blip up front
        o.frequency.setValueAtTime(f, at + 0.03);
        return o;
      }
      case 'acid': {
        const g = this.envelope(out, at, 0.6, 0.003, 0.32);
        const lp = this.filter('lowpass', 3800, 12, g);
        lp.frequency.exponentialRampToValueAtTime(380, at + 0.25);
        return this.osc('sawtooth', f, lp, at, at + 0.36);
      }
      default: {  // pluck
        const g = this.envelope(out, at, 0.7, 0.002, 0.4);
        const lp = this.filter('lowpass', 4200, 1.5, g);
        lp.frequency.exponentialRampToValueAtTime(500, at + 0.3);
        this.osc('square', f, lp, at, at + 0.45, -6);
        return this.osc('sawtooth', f, lp, at, at + 0.45, 6);
      }
    }
  }
}
