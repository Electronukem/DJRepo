// The DJ. Each repository is a deck with its own genre, key and tempo (deriveSet). With one deck
// the set cycles through grooves, build-ups, drops and breakdowns. With two, the decks battle:
// they take eight-bar rounds, each in its own genre and tempo. Asked to drop, they sync up, trading
// bars, then half bars, beats and eighths while their tempos and keys meet in the middle, and come
// together in one mashup drop (drums from one deck, bass and chords from the other) before
// splitting up to battle again. A new deck can join mid-set (challenge): the deck that stays
// builds up, and the newcomer drops in and takes the next round.
//
// The timeline is built a bar at a time, and every bar carries its own tempo and whose groove it
// is. The lead line comes from the light show: app.js asks for a note whenever light lands on a
// node. Everything is synthesised with Web Audio. All timing is in performance.now() seconds so
// visuals and sound share one clock; the DJ converts to AudioContext time when it schedules, and
// records every drum hit (and which deck played it) so the visuals can hit with it.

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

// The battle: rounds of eight bars. When the decks sync, they trade turns of these many
// sixteenths in each bar, faster and faster, before the build-up that merges them.
const ROUND_BARS = 8;
const TRADE = [16, 16, 16, 16, 8, 8, 4, 2];

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

// The bass root for a key: A1–A♭2.
function keyMidi(sound) {
  return 33 + ((sound.key + 3) % 12);
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
    genre, choice, key, mode, modeName, bpm, progression, lead, codeLead, topExt, reverb, density, reasons,
    swing: g.swing || 0,
    label: `${NOTE_NAMES[key]} ${modeName} · ${bpm} BPM · ${g.name}`,
  };
}

// The mix the decks suggest: everything on, with the arpeggio only where a genre wants one.
function defaultMix(sets) {
  const arp = sets.some((s) => GENRES[s.genre].arpOn);
  return Object.fromEntries(CHANNELS.map((c) => [c.id, { on: c.id !== 'arp' || arp, level: c.level }]));
}

// A deck's sound: its genre's patterns in its own key, mode and tempo.
function deckSound(set, id) {
  const g = GENRES[set.genre];
  return {
    id, bpm: set.bpm, key: set.key, mode: set.mode, progression: set.progression, swing: g.swing || 0,
    lead: set.lead, reverb: set.reverb, drums: g.drums, kick: g.kick, perc: g.perc, snare: Boolean(g.snare),
    pump: g.pump, bass: g.bass, chords: g.chords, arp: g.arp,
  };
}

// The mashup two decks make together: deck A's key and chords, the tempo halfway between them, and
// each part's patterns from whichever deck `parts` says (0 = A, 1 = B).
function mashSound(a, b, parts) {
  const from = (part) => (parts[part] === 1 ? b : a);
  const drums = from('drums');
  return {
    id: 'mix', bpm: Math.round((a.bpm + b.bpm) / 2), key: a.key, mode: a.mode, progression: a.progression,
    swing: drums.swing, lead: null, reverb: Math.max(a.reverb, b.reverb), drums: drums.drums, kick: drums.kick,
    perc: drums.perc, snare: drums.snare, pump: Math.max(a.pump, b.pump), bass: from('bass').bass,
    chords: from('chords').chords, arp: from('chords').arp,
  };
}

class DJ {
  constructor() {
    this.ctx = null;
    this.decks = [];        // one sound per repository
    this.mash = null;       // what two decks sound like together
    this.mashParts = { drums: 0, bass: 1, chords: 1 };
    this.timer = null;
    this.desk = null;       // the channels and filters; replaced (and faded out) on every configure
    this.offset = null;     // AudioContext time minus performance time
    this.volume = 0.8;
    this.muted = false;
    this.mix = {};
    this.leadVoices = 0;
    this.hits = [];         // drum hits as { type, t, v, deck }, oldest first, for the visuals
    this.phrases = [];
    this.queue = [];        // phrases asked for (a drop, a sync), played before the set carries on
    this.bars = [];         // the timeline, a bar at a time
    this.round = 0;
    this.roundOffset = 0;   // which deck a battle's odd rounds belong to
    this.onBar = null;      // (bar, time, info) => void, called a little ahead of each bar
  }

  // Must run inside a user gesture: browsers only allow sound after one.
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.buildMaster();
      if (this.decks.length) this.buildDesk();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  now() {
    return performance.now() / 1000;
  }

  // One set (a solo set) or two (a battle). `opening` is 'intro' to start from the top, or 'drop'
  // to come in with a short build-up and a drop.
  configure(sets, mix = defaultMix(sets), opening = 'intro') {
    this.stop();
    this.decks = sets.map((set, i) => deckSound(set, i));
    this.battle = this.decks.length > 1;
    this.remix();
    this.start = this.now() + 0.3;
    this.nextStep = 0;
    this.bars = [];
    this.queue = [];
    this.cycle = 0;
    this.round = 0;
    this.roundOffset = 0;
    const stage = this.battle ? 'battle' : 'solo';
    if (opening === 'drop' && !this.battle) {
      this.phrases = [{ section: 'build', stage, deck: 0, start: 0, bars: 4 }, { section: 'drop', stage, deck: 0, start: 4, bars: 16 }];
      this.cycle = CYCLE.indexOf('break');
    } else {
      this.phrases = [{ section: 'intro', stage, deck: 0, start: 0, bars: this.battle ? 4 : SECTIONS.intro.bars }];
    }
    this.hits = [];
    this.setMix(mix);
    if (this.ctx) {
      this.reverb.buffer = this.impulse(Math.max(...this.decks.map((d) => d.reverb)));
      this.buildDesk();
    }
    this.timer = setInterval(() => this.tick(), 25);
    this.tick();
  }

  // Stop the set and fade out whatever is still ringing, so a new key never clashes with the old.
  stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (!this.desk) return;
    const { out } = this.desk;
    const t = this.ctx.currentTime;
    out.gain.cancelScheduledValues(t);
    out.gain.setValueAtTime(out.gain.value, t);
    out.gain.setTargetAtTime(0, t, 0.12);
    setTimeout(() => out.disconnect(), 1500);
    this.desk = null;
  }

  // Change one deck's set mid-battle; it's heard from the next bar.
  setDeck(i, set) {
    this.decks[i] = deckSound(set, i);
    this.remix();
    this.replan();
  }

  setLead(i, lead) {
    if (this.decks[i]) this.decks[i].lead = lead;
  }

  // A new contender takes deck `slot`: beside a solo deck (1), or in place of the deck it knocks
  // out. From the next bar the deck that stays builds up for four bars, then the newcomer drops
  // in at full strength and takes round one. Returns the bars where the build-up and the drop start.
  challenge(set, slot) {
    this.decks[slot] = deckSound(set, slot);
    this.battle = true;
    this.remix();
    this.round = 1;
    this.roundOffset = slot;  // round one is the newcomer's, round two the champion's, and so on
    const bar = Math.ceil(this.nextStep / 16);  // the first bar not scheduled yet
    this.cut(bar, [
      { section: 'build', stage: 'challenge', deck: 1 - slot, bars: 4 },
      { section: 'drop', stage: 'battle', deck: slot, bars: ROUND_BARS, round: 1, entrance: true },
    ]);
    return { bar, drop: bar + 4 };
  }

  // Which deck the mashup takes its drums, bass and chords from.
  setMash(parts) {
    this.mashParts = { ...this.mashParts, ...parts };
    this.remix();
    this.replan();
  }

  remix() {
    const [a, b] = this.decks;
    this.mash = b ? mashSound(a, b, this.mashParts) : null;
    this.keyShift = b ? ((a.key - b.key + 18) % 12) - 6 : 0;  // how far B moves to meet A's key
  }

  // Forget bars that haven't been played yet, so they're rebuilt from the current plan.
  replan() {
    const scheduled = Math.ceil(this.nextStep / 16);
    this.bars = this.bars.filter((b) => b.index < scheduled);
  }

  setMix(mix) {
    for (const c of CHANNELS) this.setChannel(c.id, mix[c.id] || { on: false, level: c.level });
  }

  setChannel(id, state) {
    this.mix[id] = { on: Boolean(state.on), level: clamp(Number(state.level) || 0, 0, 1) };
    const bus = this.desk && this.desk.buses[id];
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

  // Dip the whole mix under the announcer's voice, or bring it back up.
  duck(on) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const g = this.voiceDuck.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.setTargetAtTime(on ? 0.35 : 1, t, on ? 0.06 : 0.4);
  }

  // ---- the arrangement ----

  phraseAt(bar) {
    bar = Math.max(0, bar);
    let last = this.phrases[this.phrases.length - 1];
    while (last.start + last.bars <= bar) {
      last = { ...this.nextPhrase(last), start: last.start + last.bars };
      this.phrases.push(last);
      if (this.phrases.length > 32) this.phrases.shift();
    }
    for (let k = this.phrases.length - 1; k >= 0; k--) {
      if (this.phrases[k].start <= bar) return this.phrases[k];
    }
    return this.phrases[0];
  }

  nextPhrase() {
    if (this.queue.length) return this.queue.shift();
    if (!this.battle) {
      const section = CYCLE[this.cycle++ % CYCLE.length];
      return { section, stage: 'solo', deck: 0, bars: SECTIONS[section].bars };
    }
    this.round++;
    return { section: 'drop', stage: 'battle', deck: (this.round - 1 + this.roundOffset) % 2, bars: ROUND_BARS, round: this.round };
  }

  // Solo: a short build-up and a drop. Battle: sync the decks and merge them into one drop.
  // Returns 'drop', 'sync', or false if one is already on its way.
  requestDrop() {
    if (!this.decks.length) return false;
    const bar = Math.ceil(this.nextStep / 16);  // the first bar not scheduled yet
    const p = this.phraseAt(bar);
    if (p.stage === 'challenge' || (p.entrance && p.start === bar)) return false;  // a newcomer is on its way in
    if (!this.battle) {
      if (p.section === 'drop' || p.section === 'build') return false;
      this.cut(bar, [{ section: 'build', stage: 'solo', deck: 0, bars: 4 }, { section: 'drop', stage: 'solo', deck: 0, bars: 16 }]);
      this.cycle = CYCLE.indexOf('break');
      return 'drop';
    }
    if (p.stage === 'sync' || (p.stage === 'merged' && p.section !== 'break')) return false;
    const together = [
      { section: 'build', stage: p.stage === 'merged' ? 'merged' : 'sync', deck: 'mix', bars: 4 },
      { section: 'drop', stage: 'merged', deck: 'mix', bars: 16 },
      { section: 'break', stage: 'merged', deck: 'mix', bars: 8 },
    ];
    // From a battle, they first trade turns, the other deck answering first.
    const trade = { section: 'drop', stage: 'sync', deck: p.deck === 0 ? 1 : 0, bars: TRADE.length };
    this.cut(bar, p.stage === 'merged' ? together : [trade, ...together]);
    return p.stage === 'merged' ? 'drop' : 'sync';
  }

  // Replace everything from `bar` on with `plan`; the set carries on as usual afterwards.
  cut(bar, plan) {
    this.phrases = this.phrases.filter((x) => x.start < bar);
    const current = this.phrases[this.phrases.length - 1];
    if (current) current.bars = bar - current.start;
    let start = bar;
    for (const p of plan) {
      this.phrases.push({ ...p, start });
      start += p.bars;
    }
    this.queue = [];
    this.replan();
  }

  // The timeline: each bar's start, tempo, and whose groove and harmony it plays.
  barRecord(index) {
    index = Math.max(0, index);
    while (!this.bars.length || this.bars[this.bars.length - 1].index < index) {
      const last = this.bars[this.bars.length - 1];
      this.bars.push(this.makeBar(last ? last.index + 1 : 0, last));
    }
    if (this.bars.length > 128) this.bars.splice(0, this.bars.length - 128);
    return this.bars[Math.max(0, index - this.bars[0].index)];
  }

  makeBar(index, prev) {
    const p = this.phraseAt(index);
    const pb = index - p.start;
    const [a, b] = this.decks;
    let harmony = a;
    let turns = null;
    let split = 0;
    let bpm = a.bpm;
    if (p.stage === 'battle' || p.stage === 'challenge') {
      harmony = this.decks[p.deck] || a;
      bpm = harmony.bpm;
    } else if (p.stage === 'sync' && p.section === 'drop') {
      // Trading: B walks to A's key over the first four bars while both tempos glide to the middle.
      const u = pb / Math.max(1, p.bars - 1);
      const shift = Math.round(this.keyShift * Math.min(1, pb / 4));
      const moved = shift ? { ...b, key: (b.key + shift + 12) % 12 } : b;
      const sides = p.deck === 1 ? [moved, a] : [a, moved];
      split = TRADE[Math.min(pb, TRADE.length - 1)];
      if (split >= 16) {
        harmony = sides[pb % 2];
        split = 0;
        bpm = harmony.bpm + (this.mash.bpm - harmony.bpm) * u;
      } else {
        turns = sides;
        harmony = this.mash;
        bpm = this.mash.bpm;
      }
    } else if (p.stage !== 'solo') {
      harmony = this.mash;
      bpm = this.mash.bpm;
    }
    const beat = 60 / bpm;
    return {
      index, pb, phrase: p, harmony, turns, split, bpm, beat,
      start: prev ? prev.start + prev.len : this.start,
      len: beat * 4,
      sixteenth: beat / 4,
      beats0: prev ? prev.beats0 + 4 : 0,
      swing: harmony.swing,
      deck: turns ? turns[0].id : harmony.id,
    };
  }

  // Whose groove sixteenth s of a bar is.
  rhythm(bar, s) {
    return bar.turns ? bar.turns[Math.floor((bar.pb * 16 + s) / bar.split) % 2] : bar.harmony;
  }

  barAtTime(t) {
    let last = this.barRecord(this.bars.length ? this.bars[this.bars.length - 1].index : 0);
    for (let guard = 0; last.start + last.len <= t && guard < 64; guard++) last = this.barRecord(last.index + 1);
    for (let k = this.bars.length - 1; k >= 0; k--) {
      if (this.bars[k].start <= t) return this.bars[k];
    }
    return this.bars[0];
  }

  beatAt(t) {
    return this.decks.length ? this.barAtTime(t).beat : 0.5;
  }

  // Where the set is at time t, for the visuals.
  position(t) {
    if (!this.decks.length) return null;
    const bar = this.barAtTime(t);
    const inBar = clamp((t - bar.start) / bar.len, -1, 0.9999);
    const p = bar.phrase;
    const barF = bar.index + inBar;
    const progress = clamp((barF - p.start) / p.bars, 0, 1);
    const next = this.phraseAt(p.start + p.bars);
    return {
      beats: bar.beats0 + inBar * 4, barF, bar: bar.index, beatInBar: inBar * 4,
      section: p.section, stage: p.stage, round: p.round || 0, phraseBar: bar.pb, bars: p.bars, progress,
      next: next.section, nextStage: next.stage, nextDeck: next.deck,
      barsLeft: p.start + p.bars - bar.index,
      energy: sectionEnergy(p.section, progress),
      deck: this.rhythm(bar, clamp(Math.floor(inBar * 16), 0, 15)).id,
      bpm: bar.bpm,
      sync: this.togetherness(p, progress),
    };
  }

  // How far the two decks have come together: 0 battling, 1 one big drop.
  togetherness(p, progress) {
    if (p.stage === 'sync') return p.section === 'build' ? 0.75 + 0.25 * progress : 0.75 * progress;
    return p.stage === 'merged' ? 1 : 0;
  }

  hit(type, t, v, deck) {
    this.hits.push({ type, t, v, deck });
    if (this.hits.length > 400) {
      const old = this.now() - 4;
      this.hits = this.hits.filter((h) => h.t > old);
    }
  }

  // The latest hit of one of `types` at or before t, from `deck` (or both decks together) if given.
  lastHit(types, t, deck) {
    for (let k = this.hits.length - 1; k >= 0; k--) {
      const h = this.hits[k];
      if (h.t <= t && types.includes(h.type) && (deck === undefined || h.deck === deck || h.deck === 'mix')) return h;
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

  // Sixteenth note i, with the bar's swing on the off-sixteenths.
  stepTime(i) {
    const bar = this.barRecord(Math.floor(i / 16));
    const s = i % 16;
    return bar.start + (s + (s % 2 ? bar.swing : 0)) * bar.sixteenth;
  }

  // The next grid line at or after t, in beats (0.25 = sixteenths).
  quantize(t, division = 0.25) {
    const bar = this.barAtTime(t);
    const grid = bar.beat * division;
    const q = bar.start + Math.ceil((t - bar.start) / grid - 1e-6) * grid;
    return Math.min(q, bar.start + bar.len);
  }

  // A number for each sixteenth of the set, for keeping one note per sixteenth.
  gridIndex(t) {
    const bar = this.barAtTime(t);
    return bar.index * 16 + Math.round((t - bar.start) / bar.sixteenth);
  }

  chord(bar) {
    const { mode, progression } = bar.harmony;
    const steps = SCALES[mode];
    const len = progression.length;
    const degree = progression[((bar.index % len) + len) % len];
    const tone = (k) => steps[(degree + k) % 7] + 12 * Math.floor((degree + k) / 7);
    const tones = [tone(0), tone(2), tone(4), tone(6)];  // root, third, fifth, seventh
    // Melody notes: the triad plus the pentatonic notes that don't rub a semitone against it.
    const triad = tones.slice(0, 3).map((x) => x % 12);
    const rubs = (p) => !triad.includes(p) && triad.some((c) => [1, 11].includes((p - c + 12) % 12));
    const penta = PENTA[MINOR.has(mode) ? 'minor' : 'major'];
    const palette = [...new Set([...triad, ...penta])].filter((p) => !rubs(p)).sort((a, b) => a - b);
    // Scale steps above the chord root, for bass lines.
    const above = (k) => steps[(degree + k) % 7] + 12 * Math.floor((degree + k) / 7) - tones[0];
    return { degree, tones, palette, above, root: keyMidi(bar.harmony) };
  }

  // tone 0–1 chooses the note, height 0 (bottom) – 1 (top) the octave, weight 0–1 how much of a hub it is.
  pitch(tone, height, weight, t) {
    const { palette, root } = this.chord(this.barAtTime(t));
    const pc = palette[Math.min(palette.length - 1, Math.floor(clamp(tone, 0, 0.999) * palette.length))];
    let octave = height < 0.33 ? 0 : height < 0.7 ? 1 : 2;
    if (weight > 0.6) octave -= 1;  // hubs speak lower
    let midi = root + 24 + pc + 12 * Math.max(0, octave);
    while (midi > 93) midi -= 12;
    return midi;
  }

  // One sixteenth: drums, bass and arpeggio, in the groove of whichever deck has it. Bar-long
  // parts start on step 0.
  step(i, t) {
    const s = i % 16;
    const bar = this.barRecord(Math.floor(i / 16));
    const p = bar.phrase;
    const sec = p.section;
    const pb = bar.pb;
    const prog = (pb + s / 16) / p.bars;
    const lastBar = pb === p.bars - 1;
    const r = this.rhythm(bar, s);
    const d = r.drums;
    const fill = p.stage === 'battle' && sec === 'drop' && lastBar;  // handing over to the other deck
    const sound = this.ready();

    if (s === 0) this.startBar(bar, t, sound, fill);

    // Kick: everywhere but the breakdown, out for the last stretch of a build-up and the last beat of a round.
    const kickOn = (sec === 'drop' && !(fill && s >= 12)) || sec === 'groove' || sec === 'intro' || (sec === 'build' && prog < 0.75);
    const kv = kickOn ? lane(d.kick, s) : 0;
    if (kv) {
      this.hit('kick', t, kv, r.id);
      if (sound) {
        this.kick(t, kv, r, bar.beat);
        if (this.mix.kick.on) this.pump(t, kv, r, bar.beat);
      }
    }

    // Claps on the backbeat; a snare roll that speeds up through a build-up (then one beat of
    // silence), and a quick one at the end of each battle round.
    if (fill && s >= 8) {
      const v = 0.5 + s / 32;
      this.hit('roll', t, v, r.id);
      if (sound) this.snare(t, v * 0.8, 1 + (s - 8) / 16);
    } else if (sec === 'drop' || sec === 'groove') {
      const v = lane(d.clap, s);
      if (v) {
        this.hit('clap', t, v, r.id);
        if (sound) (r.snare ? this.snare(t, v, 1) : this.clap(t, v));
      }
    } else if (sec === 'build') {
      const every = prog < 0.5 ? 4 : prog < 0.75 ? 2 : 1;
      const gap = lastBar && s >= 12;
      if (!gap && s % every === 0) {
        const v = 0.3 + 0.7 * prog;
        this.hit('roll', t, v, r.id);
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
    const percOn = sec === 'drop' || sec === 'groove' || (sec === 'intro' && pb >= 2);
    const pv = percOn ? lane(d.perc, s) : 0;
    if (pv && sound) this.perc(t, pv, r.perc);

    // Bass.
    const bassOn = (sec === 'drop' && !(fill && s >= 12)) || sec === 'groove' || (sec === 'intro' && pb >= (this.battle ? 2 : 4))
      || (sec === 'build' && prog < 0.5);
    const bv = bassOn ? lane(r.bass.pattern, s) : 0;
    if (bv && sound) this.bassStep(t, bar, s, bv, sec, r);

    // Arpeggio.
    const arpOn = sec === 'drop' || sec === 'groove' || sec === 'build' || sec === 'break';
    const av = arpOn ? lane(r.arp, s) : 0;
    if (av && sound && !(sec === 'build' && lastBar && s >= 12)) this.arpStep(t, bar, s, av, sec, prog);
  }

  startBar(bar, t, sound, fill) {
    const p = bar.phrase;
    const sec = p.section;
    const pb = bar.pb;
    const chord = this.chord(bar);
    if (pb === 0) {
      // A battle round's impact is lighter than the drop the decks make together, or a newcomer's entrance.
      if (sec === 'drop') this.hit('impact', t, p.stage === 'battle' && !p.entrance ? 0.5 : 1, bar.deck);
      else if (sec === 'groove') this.hit('crash', t, 0.6, bar.deck);
    } else if (sec === 'drop' && pb === 8) {
      this.hit('crash', t, 0.7, bar.deck);
    }
    if (sound) {
      const at = this.toAudio(t);
      this.delay.delayTime.setTargetAtTime(Math.min(1.9, bar.beat * 0.75), at, 0.05);  // a dotted eighth
      if (pb === 0) this.phraseFx(t, bar);
      if (fill) this.riser(t, bar.len - bar.beat, chord.root);
      if (sec === 'drop' && pb === 8) this.crash(t, 0.7);
      if (sec !== 'intro') this.chordBar(t, bar, chord, sec, pb / p.bars);
      if (sec !== 'groove') this.padBar(t, bar, chord, sec, pb / p.bars);
    }
    if (this.onBar) {
      this.onBar(bar.index, t, {
        section: sec, stage: p.stage, phraseBar: pb, bars: p.bars, chord, deck: bar.deck, bpm: bar.bpm,
        turns: bar.turns ? bar.turns.map((x) => x.id) : null, split: bar.split,
      });
    }
  }

  // Filter moves, risers and impacts at the top of each phrase.
  phraseFx(t, bar) {
    const p = bar.phrase;
    const at = this.toAudio(t);
    const { hp, lp } = this.desk;
    const len = p.bars * bar.len;
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
        const gap = at + len - bar.beat;
        hp.frequency.setValueAtTime(20, at + len * 0.5);
        hp.frequency.exponentialRampToValueAtTime(420, gap);
        this.riser(t, len - bar.beat, keyMidi(bar.harmony));
        break;
      }
      case 'drop':
        this.impact(t, p.stage === 'battle' && !p.entrance ? 0.6 : 1);
        break;
      case 'break':
        this.downlifter(t, bar.len * 2);
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
    return Boolean(this.ctx && this.desk && !this.muted && this.ctx.state === 'running');
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
    this.voiceDuck = ctx.createGain();
    this.bus.connect(glue).connect(limiter).connect(this.voiceDuck).connect(this.analyser).connect(this.master)
      .connect(ctx.destination);

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
  buildDesk() {
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
    this.desk = { out, hp, lp, duck, lightDuck, buses, inputs };
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
  pump(t, v, r, beat) {
    const at = this.toAudio(t);
    const depth = (r.pump ?? 0.6) * v;
    for (const [node, amount] of [[this.desk.duck, 1], [this.desk.lightDuck, 0.4]]) {
      node.gain.setTargetAtTime(1 - depth * amount, at, 0.004);
      node.gain.setTargetAtTime(1, at + 0.03, beat * 0.16);
    }
  }

  // ---- drums ----

  kick(t, v, r, beat) {
    const at = this.toAudio(t);
    const style = {
      punchy: { from: 165, to: 50, sweep: 0.06, decay: 0.42, click: 0.35 },
      rumble: { from: 150, to: 44, sweep: 0.08, decay: 0.55, click: 0.3, rumble: true },
      tight:  { from: 190, to: 52, sweep: 0.045, decay: 0.32, click: 0.45 },
      big:    { from: 210, to: 46, sweep: 0.075, decay: 0.6, click: 0.5 },
    }[r.kick];
    const input = this.desk.inputs.kick;
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
      const tail = this.envelope(input, at + 0.05, 0.22 * v, 0.06, beat * 0.75);
      const lp = this.filter('lowpass', 140, 1.5, tail);
      this.release(this.osc('triangle', style.to * 0.95, lp, at + 0.05, at + beat), lp, tail);
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
    g.connect(this.desk.inputs.clap);
    const band = this.filter('bandpass', 1150, 0.9, g);
    this.release(this.noiseSource(band, at, at + 0.3), band, g);
  }

  snare(t, v, tone = 1) {
    const at = this.toAudio(t);
    const input = this.desk.inputs.clap;
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
    const g = this.envelope(this.desk.inputs.hats, at, 0.4 * v * CHANNEL.hats.trim, 0.001, open ? 0.22 : 0.035);
    const band = this.filter('bandpass', 10500, 0.7, g);
    const hp = this.filter('highpass', 7200, 0.7, band);
    this.release(this.noiseSource(hp, at, at + (open ? 0.3 : 0.06)), hp, band, g);
  }

  perc(t, v, kind) {
    const at = this.toAudio(t);
    const input = this.desk.inputs.perc;
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
      const g = this.envelope(input, at, 0.6 * v * CHANNEL.perc.trim, 0.001, 0.07);
      const hp = this.filter('highpass', 1400, 0.7, g);
      this.release(this.noiseSource(hp, at, at + 0.1), hp, g);
    } else {  // shaker
      const g = this.envelope(input, at, peak * 2, 0.012, 0.06);
      const band = this.filter('bandpass', 6500, 1.2, g);
      this.release(this.noiseSource(band, at, at + 0.1), band, g);
    }
  }

  crash(t, v) {
    const at = this.toAudio(t);
    const g = this.envelope(this.desk.inputs.fx, at, 0.3 * v * CHANNEL.fx.trim, 0.002, 1.8);
    const hp = this.filter('highpass', 4800, 0.7, g);
    this.release(this.noiseSource(hp, at, at + 1.9), hp, g);
  }

  // ---- fx ----

  riser(t, dur, root) {
    const at = this.toAudio(t);
    const end = at + dur;
    const input = this.desk.inputs.fx;
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
    const saw = this.osc('sawtooth', mtof(root + 36), lp, at, end + 0.1);
    saw.frequency.exponentialRampToValueAtTime(mtof(root + 60), end);
    this.release(saw, lp, tone);
  }

  impact(t, v = 1) {
    const at = this.toAudio(t);
    const input = this.desk.inputs.fx;
    const boom = this.envelope(input, at, 0.9 * v * CHANNEL.fx.trim, 0.003, 1.4);
    const o = this.osc('sine', 75, boom, at, at + 1.5);
    o.frequency.exponentialRampToValueAtTime(30, at + 1.2);
    this.release(o, boom);
    this.crash(t, 1.3 * v);
  }

  downlifter(t, dur) {
    const at = this.toAudio(t);
    const g = this.envelope(this.desk.inputs.fx, at, 0.35 * CHANNEL.fx.trim, 0.01, dur);
    const band = this.filter('bandpass', 6000, 1.4, g);
    band.frequency.exponentialRampToValueAtTime(220, at + dur);
    this.release(this.noiseSource(band, at, at + dur + 0.1), band, g);
  }

  // ---- bass ----

  // The bass line in deck r's style, on the bar's harmony.
  bassStep(t, bar, s, v, sec, r) {
    const chord = this.chord(bar);
    const style = r.bass.style;
    let midi = chord.root + chord.tones[0];
    if (style === 'acid') midi += 12 + chord.above(r.bass.notes[s] || 0);
    if (style === 'offbeat' && r.bass.pattern[s] === 'o') midi += 12;
    const steps = style === 'reese' ? 8 : style === 'offbeat' || style === 'sub' ? 1.6 : 0.9;
    const dark = sec === 'intro' ? 0.35 : sec === 'groove' ? 0.75 : 1;
    // A long reese note mustn't ring into the other deck's turn.
    const room = bar.turns ? bar.split - ((bar.pb * 16 + s) % bar.split) : 16 - s;
    this.bass(this.toAudio(t), midi, v, Math.min(steps, room) * bar.sixteenth, style, dark, bar);
  }

  bass(at, midi, v, len, style, dark, bar) {
    const ctx = this.ctx;
    const f = mtof(midi);
    const end = at + len;
    const amp = ctx.createGain();
    const peak = 0.5 * v * CHANNEL.bass.trim * BASS_GAIN[style];
    amp.gain.setValueAtTime(0.0001, at);
    amp.gain.linearRampToValueAtTime(peak, at + 0.004);
    amp.gain.setValueAtTime(peak, Math.max(at + 0.005, end - 0.02));
    amp.gain.exponentialRampToValueAtTime(0.0001, end + 0.04);
    amp.connect(this.desk.inputs.bass);

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
        const phase = (((bar.index % 4) + 4) % 4) / 4;
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
        wob.frequency.value = 2 / bar.beat;  // wobbles in eighth notes
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

  // One chord per bar, gated in the harmony deck's rhythm (held long in build-ups and breakdowns).
  chordBar(t, bar, chord, sec, prog) {
    const ctx = this.ctx;
    const at = this.toAudio(t);
    const { chords } = bar.harmony;
    const style = chords.style;
    const held = sec === 'build' || sec === 'break' || style === 'pad';
    const end = at + bar.len;
    const level = { groove: 0.55, build: 0.4 + 0.5 * prog, drop: 1, break: 0.5 }[sec] * 0.32 * CHANNEL.chords.trim
      * (style === 'pad' ? 0.45 : 1);
    const cutoff = { groove: 1300, build: 500 + 6000 * prog * prog, drop: 6500, break: 1800 }[sec];

    const gate = ctx.createGain();
    gate.gain.setValueAtTime(0.0001, at);
    if (held) {
      gate.gain.linearRampToValueAtTime(level, at + (sec === 'break' ? bar.len * 0.4 : 0.02));
      gate.gain.setValueAtTime(level, end - 0.05);
      gate.gain.setTargetAtTime(0.0001, end, sec === 'break' ? 0.6 : 0.08);
    } else {
      const long = style === 'hook' ? 1.8 : style === 'gate' ? 0.85 : 1.1;
      for (let k = 0; k < 16; k++) {
        if (chords.pattern[k] === '-') continue;
        const s = this.toAudio(this.stepTime(bar.index * 16 + k));
        gate.gain.setValueAtTime(0.0001, s);
        gate.gain.linearRampToValueAtTime(level, s + 0.004);
        gate.gain.exponentialRampToValueAtTime(level * 0.35, s + bar.sixteenth * long * 0.7);
        gate.gain.exponentialRampToValueAtTime(0.0001, s + bar.sixteenth * long);
      }
    }
    gate.connect(this.desk.inputs.chords);

    const root = chord.root + 24 + (style === 'hook' ? 12 : 0);
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

  padBar(t, bar, chord, sec, prog) {
    const ctx = this.ctx;
    const at = this.toAudio(t);
    const len = bar.len;
    const level = { intro: 0.6, build: 0.5 + 0.3 * prog, drop: 0.3, break: 0.9 }[sec] * 0.2 * CHANNEL.pad.trim;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(level, at + len * 0.45);
    g.gain.setValueAtTime(level, at + len);
    g.gain.exponentialRampToValueAtTime(0.0001, at + len * 1.9);
    g.connect(this.desk.inputs.pad);
    const lp = this.filter('lowpass', sec === 'build' ? 900 + 3000 * prog : 1500, 0.7, g);
    const root = chord.root + 24;
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
    const midi = chord.root + 36 + run[(bar.index * 16 + s) % run.length];
    const cutoff = { groove: 1600, build: 700 + 5500 * prog * prog, drop: 5200, break: 1100 }[sec];
    const level = { groove: 0.6, build: 0.5 + 0.5 * prog, drop: 0.9, break: 0.45 }[sec];
    const at = this.toAudio(t);
    const g = this.envelope(this.desk.inputs.arp, at, 0.2 * v * level * CHANNEL.arp.trim, 0.003, bar.sixteenth * 1.6);
    const lp = this.filter('lowpass', cutoff, 2, g);
    lp.frequency.setValueAtTime(cutoff * 1.8, at);
    lp.frequency.exponentialRampToValueAtTime(cutoff, at + 0.08);
    const f = mtof(midi);
    const o = this.osc('square', f, lp, at, at + bar.sixteenth * 1.8);
    this.osc('sawtooth', f, lp, at, at + bar.sixteenth * 1.8, 7);
    this.release(o, lp, g);
  }

  // ---- the lead: one note from a graph ----

  // velocity 0–1, pan −1 (left) – 1 (right); `deck` picks whose lead synth plays it.
  lead(midi, t, velocity = 0.6, pan = 0, deck = 0) {
    if (!this.ready() || !this.mix.lead?.on || this.leadVoices >= MAX_LEAD_VOICES) return;
    const ctx = this.ctx;
    if (this.toAudio(t) < ctx.currentTime - 0.02) return;
    const at = Math.max(this.toAudio(t), ctx.currentTime);
    const sound = (this.decks[deck] || this.decks[0]).lead;
    const out = ctx.createGain();
    out.gain.value = 0.22 * velocity * CHANNEL.lead.trim * (LEADS[sound]?.gain ?? 1);
    const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (panner) {
      panner.pan.value = clamp(pan, -1, 1);
      out.connect(panner).connect(this.desk.inputs.lead);
    } else {
      out.connect(this.desk.inputs.lead);
    }
    const source = this.leadVoice(sound, out, mtof(midi), at);
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
