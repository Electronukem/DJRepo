// The light show: lays out each repository's graphify graph with d3-force, then throws them
// around in time with the set. With one repo, the camera punches in on every kick, pushes in
// through each build-up, smash-cuts out on the drop, and swaps close-ups and wide shots bar by bar.
// With two, the graphs face off: each kick throws a punch at the other graph, and the deck that's
// playing leans in while the other backs off. Asked to sync, they circle closer and closer as they
// trade turns, spiral together through the build-up, and land as one graph in one big drop.
// Commits drop on the bar as riffs, and light travelling along the edges plays the lead.
// Shares the page's global scope with genres.js (GENRES, genreColour, genreSwatch) and dj.js
// (DJ, CHANNELS, LEADS, SECTIONS, deriveSet, defaultMix, clamp, hashString, ...), so top-level
// names here must not repeat those.

'use strict';

const $ = (sel) => document.querySelector(sel);
const TAU = Math.PI * 2;
const GOLDEN = 137.50776;
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const RECENT_KEY = 'djrepo.recent';
const SETTINGS_KEY = 'djrepo.settings';
const RTF = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const STAR_COUNT = 240;
const BATTLE_NODES = 900;  // per graph, so two stay smooth
const MASH_PARTS = [['drums', 'Drums'], ['bass', 'Bass'], ['chords', 'Chords & arpeggio']];
const IDLE_POSITION = {
  section: 'intro', stage: 'solo', round: 0, progress: 0, barF: 0, bar: 0, beats: 0, beatInBar: 0, phraseBar: 0,
  bars: 8, energy: 0.35, barsLeft: 8, next: 'groove', nextStage: 'solo', nextDeck: 0, deck: 0, bpm: 120, sync: 0,
};

const music = new DJ();
const sky = $('#sky');
const g2 = sky.getContext('2d');
const view = { w: 0, h: 0, dpr: 1 };
const settings = loadSettings();
let health = null;
let world = null;
let backdropHue = 280;
let lastFrame = performance.now() / 1000;
let idleTimer = null;
let hud = {};

// ---------------------------------------------------------------------------
// One repository's graph

class Graph {
  constructor(show, scene, set, index) {
    this.show = show;
    this.scene = scene;
    this.set = set;
    this.index = index;
    this.name = `${scene.repo.owner}/${scene.repo.name}`;
    this.short = scene.repo.name;
    this.repoGenre = deriveSet(scene).genre;  // what the repository picks, whatever is playing
    this.hueBase = (hashString(this.name) + index * 151) % 360;
    this.applyPalette(GENRES[set.genre]);

    const maxDegree = scene.nodes.reduce((m, n) => Math.max(m, n.d), 1);
    this.nodes = scene.nodes.map((n, i) => ({
      ...n,
      i,
      l: n.l.length > 36 ? `${n.l.slice(0, 35)}…` : n.l,
      r: 1.8 + Math.min(8, Math.sqrt(n.d)),
      weight: Math.log1p(n.d) / Math.log1p(maxDegree),
      twinkle: Math.random() * TAU,
      sx: 0, sy: 0, glow: 0,
    }));
    this.adj = this.nodes.map(() => []);
    for (const [s, t] of scene.links) {
      this.adj[s].push(t);
      this.adj[t].push(s);
    }
    let total = 0;
    this.cumulative = this.nodes.map((n) => (total += Math.sqrt(n.d + 1)));

    this.layoutAnchors();
    const sizes = scene.communities.map((c) => c.size);
    for (const n of this.nodes) {
      const a = this.anchors[n.c];
      const spread = 5 * Math.sqrt(sizes[n.c] || 1);
      n.x = a.x + gaussian() * spread;
      n.y = a.y + gaussian() * spread;
    }

    this.links = scene.links.map(([source, target]) => ({ source, target }));
    this.sim = d3.forceSimulation(this.nodes)
      .force('link', d3.forceLink(this.links).distance((l) => 10 + l.source.r + l.target.r))
      .force('charge', d3.forceManyBody().strength((n) => -8 - n.r * 3).distanceMax(240).theta(0.95))
      .force('home', () => this.pullHome())
      .velocityDecay(0.45)
      .alphaDecay(0.025)
      .alphaTarget(0.05)  // never settles, so it keeps moving
      .stop();
    const warmup = this.nodes.length > 1000 ? 90 : 160;
    for (let i = 0; i < warmup; i++) this.sim.tick();

    this.linksBy = this.palette.map(() => []);
    for (const l of this.links) this.linksBy[l.source.c].push(l);

    this.flashes = [];
    this.rings = [];
    this.pulses = [];
    this.labels = [];
    this.focusNodes = null;
    this.commitIndex = 0;
    this.recoil = 0;  // knocked back by the other deck's punches
    this.env = { kick: 0, snare: 0, impact: 0 };
    this.fit = null;
    this.v = {
      ox: view.w / 2, oy: view.h / 2, radius: Math.min(view.w, view.h) * 0.44, alpha: 1, push: 0.55,
      x: 0, y: 0, scale: 1, zoom: 1, angle: index ? Math.PI : 0, tilt: 0, focusMix: 0,
    };
  }

  applyPalette(genre) {
    this.genre = genre;
    this.palette = paletteFor(this.scene, genre, this.hueBase);
    this.sprites = this.palette.map(glowSprite);
  }

  // Recolour in place, crossfading from the old colours.
  setSet(set) {
    this.set = set;
    this.oldSprites = this.sprites;
    this.fadeFrom = music.now();
    this.applyPalette(GENRES[set.genre]);
  }

  // Each cluster orbits its own wandering point.
  layoutAnchors() {
    const n = this.nodes.length;
    const k = Math.max(1, this.palette.length);
    const spacing = 9 * Math.sqrt(n / k) + 24;
    this.anchors = this.palette.map((_, i) => {
      const angle = (i * GOLDEN * Math.PI) / 180;
      const radius = spacing * Math.sqrt(i + 0.35);
      return {
        bx: Math.cos(angle) * radius,
        by: Math.sin(angle) * radius,
        amp: spacing * 0.35,
        w1: 0.05 + Math.random() * 0.05,
        w2: 0.05 + Math.random() * 0.05,
        p1: Math.random() * TAU,
        p2: Math.random() * TAU,
        x: 0,
        y: 0,
      };
    });
    this.moveAnchors(music.now());
  }

  moveAnchors(t) {
    const pace = REDUCED ? 0.4 : 1;
    for (const a of this.anchors) {
      a.x = a.bx + Math.sin(t * a.w1 * pace + a.p1) * a.amp;
      a.y = a.by + Math.cos(t * a.w2 * pace + a.p2) * a.amp;
    }
  }

  pullHome() {
    for (const n of this.nodes) {
      const a = this.anchors[n.c];
      n.vx += (a.x - n.x) * 0.01;
      n.vy += (a.y - n.y) * 0.01;
    }
  }

  // The graph's middle and size in its own coordinates, for framing it.
  measure() {
    let cx = 0;
    let cy = 0;
    for (const n of this.nodes) {
      cx += n.x;
      cy += n.y;
    }
    cx /= this.nodes.length;
    cy /= this.nodes.length;
    const dist = this.nodes.map((n) => Math.hypot(n.x - cx, n.y - cy)).sort((a, b) => a - b);
    this.fit = { x: cx, y: cy, r: Math.max(40, dist[Math.floor(dist.length * 0.94)] || 0) };
  }

  project(shakeX, shakeY) {
    const { x: cx, y: cy, angle, tilt, zoom, ox, oy } = this.v;
    const cos = Math.cos(angle + tilt) * zoom;
    const sin = Math.sin(angle + tilt) * zoom;
    for (const n of this.nodes) {
      const dx = n.x - cx;
      const dy = n.y - cy;
      n.sx = ox + shakeX + dx * cos - dy * sin;
      n.sy = oy + shakeY + dx * sin + dy * cos;
    }
  }

  // ---- riffs ----

  nextCommit(bar, t, section, allow = () => true) {
    const commits = this.scene.commits;
    if (!commits.length) {
      this.playHubs(bar, section, allow);
      return;
    }
    const number = (this.commitIndex % commits.length) + 1;
    this.commitIndex++;
    this.playCommit(commits[number - 1], bar, t, number, section, allow);
  }

  // A commit drops: the code it touched fires as a riff on the bar, then ripples outward.
  // `allow` says which sixteenths are this deck's to play (all of them, unless the decks are trading).
  playCommit(commit, bar, t, number, section, allow) {
    const quiet = !commit.n.length;  // eg docs-only changes graphify doesn't map
    const touched = quiet ? [this.randomNode(), this.randomNode(), this.randomNode()] : commit.n.map((i) => this.nodes[i]).filter(Boolean);
    const rhythm = turnSteps(section === 'drop' ? this.genre.hook : section === 'break' ? [0, 6, 12] : [0, 4, 8, 12], allow);
    if (!rhythm.length || !touched.length) return;
    const phrase = [...new Set(touched)].sort((a, b) => a.sx - b.sx).slice(0, rhythm.length);
    const intensity = Math.min(1, commit.f / 12);
    const velocity = { drop: 0.85, groove: 0.6, build: 0.6, intro: 0.5, break: 0.45 }[section];
    const hold = music.beatAt(t) * 4 * (section === 'drop' ? 1.4 : 2.4);
    phrase.forEach((n, k) => {
      const at = music.stepTime(bar * 16 + rhythm[k]);
      this.show.claimSlot(at);
      this.sound(n, at, (quiet ? 0.6 : 1) * velocity * (0.85 + 0.15 * intensity));
      this.flash(n, at, 1, 1.4);
      if (!quiet) {
        this.rings.push({ node: n, at });
        if (k < 4) this.labels.push({ node: n, at, until: at + hold });
      }
      this.emit(n, at + music.beatAt(at) / 2, section === 'drop' ? 2 : 1, true, 0);
    });
    if (!quiet) this.focusNodes = phrase;
    this.show.later(t, () => showCommitCaption(this, commit, number, section));
  }

  playHubs(bar, section, allow) {
    const rhythm = turnSteps([0, 4, 8, 12], allow);
    const hubs = this.nodes.slice(0, rhythm.length).sort((a, b) => a.sx - b.sx);
    hubs.forEach((n, k) => {
      const at = music.stepTime(bar * 16 + rhythm[k]);
      this.show.claimSlot(at);
      this.sound(n, at, section === 'drop' ? 0.75 : 0.5);
      this.flash(n, at, 1, 1.4);
      this.emit(n, at + music.beatAt(at) / 2, 2, true, 0);
    });
    if (hubs.length) this.focusNodes = hubs;
  }

  // Send light along `count` edges from a node. Arrivals land on the sixteenth-note grid,
  // so a sounding pulse plays exactly as it reaches its node.
  emit(from, at, count, sounding, hops) {
    const neighbours = this.adj[from.i];
    if (!neighbours.length || this.pulses.length > 90) return;
    for (let k = 0; k < count; k++) {
      const to = this.nodes[neighbours[(Math.random() * neighbours.length) | 0]];
      const end = music.quantize(at + music.beatAt(at) * (0.5 + Math.random()), 0.25);
      const pulse = { from, to, start: at, end, hops, sounding: false, arrived: false };
      if (sounding && this.show.claimSlot(end)) {
        pulse.sounding = true;
        this.sound(to, end, 0.3 + 0.2 * Math.random());
        this.flash(to, end, 0.8, 1.2);
      } else {
        this.flash(to, end, 0.35, 0.9);
      }
      this.pulses.push(pulse);
    }
  }

  updatePulses(t) {
    this.pulses = this.pulses.filter((p) => {
      if (!p.arrived && t >= p.end) {
        p.arrived = true;
        if (p.hops < 2 && Math.random() < 0.35) this.emit(p.to, p.end, 1, Math.random() < 0.5, p.hops + 1);
      }
      return t < p.end + 0.4;
    });
  }

  // What the node looks like right now decides what it sounds like; this deck's lead synth plays it.
  sound(node, at, velocity) {
    const height = 1 - clamp(node.sy / view.h, 0, 1);
    const pan = clamp((node.sx / view.w) * 2 - 1, -1, 1) * 0.7;
    const midi = music.pitch(this.palette[node.c].tone, height, node.weight, at);
    music.lead(midi, at, velocity, pan, this.index);
  }

  flash(node, at, strength, duration) {
    this.flashes.push({ node, at, strength, duration });
  }

  updateGlow(t) {
    const burst = this.env.impact * 0.9;  // the whole graph lights up when a drop lands
    for (const n of this.nodes) n.glow = burst;
    this.flashes = this.flashes.filter((f) => {
      const age = t - f.at;
      if (age > f.duration) return false;
      if (age >= 0) {
        const env = age < 0.03 ? age / 0.03 : Math.exp((-(age - 0.03) * 3.5) / f.duration);
        f.node.glow = Math.max(f.node.glow, f.strength * env);
      }
      return true;
    });
  }

  randomNode() {
    const total = this.cumulative[this.cumulative.length - 1];
    const x = Math.random() * total;
    let lo = 0;
    let hi = this.cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cumulative[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return this.nodes[lo];
  }

  draw(t, pos) {
    const fade = this.v.alpha;
    const beatGlow = this.env.kick * (0.35 + 0.65 * pos.energy);
    g2.globalCompositeOperation = 'lighter';

    g2.lineWidth = 0.7 + 0.9 * beatGlow;
    g2.globalAlpha = Math.min(1, 0.4 + 0.6 * beatGlow + this.env.impact) * fade;
    this.linksBy.forEach((list, c) => {
      if (!list.length) return;
      g2.strokeStyle = this.palette[c].edge;
      g2.beginPath();
      for (const l of list) {
        g2.moveTo(l.source.sx, l.source.sy);
        g2.lineTo(l.target.sx, l.target.sy);
      }
      g2.stroke();
    });

    for (const p of this.pulses) {
      if (t < p.start) continue;
      const u = clamp((t - p.start) / (p.end - p.start), 0, 1);
      const e = u * u * (3 - 2 * u);
      const out = t > p.end ? 1 - (t - p.end) / 0.4 : 1;
      const sprite = this.sprites[p.from.c];
      for (let k = 0; k < 5; k++) {  // a comet tail
        const v = Math.max(0, e - k * 0.04);
        const x = p.from.sx + (p.to.sx - p.from.sx) * v;
        const y = p.from.sy + (p.to.sy - p.from.sy) * v;
        const size = (p.sounding ? 11 : 7) * (1 - k * 0.17);
        g2.globalAlpha = out * (1 - k * 0.2) * (p.sounding ? 1 : 0.6) * fade;
        g2.drawImage(sprite, x - size, y - size, size * 2, size * 2);
      }
    }

    // While the genre changes, each node is drawn in both its old and new colour.
    const mix = this.oldSprites ? clamp((t - this.fadeFrom) / 1.5, 0, 1) : 1;
    if (mix >= 1) this.oldSprites = null;
    const zoom = this.v.zoom;
    const swell = 1 + 0.5 * beatGlow + 0.6 * this.env.impact;
    for (const n of this.nodes) {
      const core = clamp(n.r * zoom * 0.85, 1.2, 8);  // close-ups don't drown in glow
      const size = core * (3.6 + n.glow * 7) * swell;
      const alpha = Math.min(1, 0.5 + 0.1 * Math.sin(t * 2 + n.twinkle) + n.glow * 0.6 + 0.25 * beatGlow) * fade;
      if (this.oldSprites) {
        g2.globalAlpha = alpha * (1 - mix);
        g2.drawImage(this.oldSprites[n.c], n.sx - size, n.sy - size, size * 2, size * 2);
      }
      g2.globalAlpha = alpha * mix;
      g2.drawImage(this.sprites[n.c], n.sx - size, n.sy - size, size * 2, size * 2);
    }

    g2.lineWidth = 1.6;
    this.rings = this.rings.filter((ring) => {
      const age = t - ring.at;
      if (age > 1.4) return false;
      if (age < 0) return true;
      const u = age / 1.4;
      g2.globalAlpha = (1 - u) * 0.8 * Math.max(0.5, fade);
      g2.strokeStyle = this.palette[ring.node.c].ring;
      g2.beginPath();
      g2.arc(ring.node.sx, ring.node.sy, 6 + Math.sqrt(u) * 90, 0, TAU);
      g2.stroke();
      return true;
    });

    g2.globalCompositeOperation = 'source-over';
    g2.font = '500 12px "JetBrains Mono", ui-monospace, monospace';
    g2.textAlign = 'left';
    g2.textBaseline = 'middle';
    const placed = [];
    this.labels = this.labels.filter((label) => {
      if (t > label.until) return false;
      if (t < label.at) return true;
      const x = label.node.sx + 12;
      const y = label.node.sy - 12;
      if (placed.some((p) => Math.abs(p.x - x) < 120 && Math.abs(p.y - y) < 16)) return true;
      placed.push({ x, y });
      const age = t - label.at;
      const alpha = 0.92 * Math.min(1, age / 0.08, (label.until - t) / 0.6) * Math.max(0.6, fade);
      if (age < 0.18 && !REDUCED) {  // it glitches in, splitting into two colours
        const jitter = (1 - age / 0.18) * 6;
        g2.globalAlpha = alpha * 0.7;
        g2.fillStyle = this.palette[(label.node.c + 2) % this.palette.length].label;
        g2.fillText(label.node.l, x - jitter, y);
        g2.fillStyle = this.palette[(label.node.c + 1) % this.palette.length].label;
        g2.fillText(label.node.l, x + jitter, y + 1);
      }
      g2.globalAlpha = alpha;
      g2.fillStyle = this.palette[label.node.c].label;
      g2.fillText(label.node.l, x, y);
      return true;
    });
    g2.globalAlpha = 1;
  }
}

// The sixteenths of `steps` that `allow` says are this deck's; if none are, its first few.
function turnSteps(steps, allow) {
  const mine = steps.filter(allow);
  return mine.length ? mine : Array.from({ length: 16 }, (_, s) => s).filter(allow).filter((s) => s % 2 === 0).slice(0, 3);
}

// ---------------------------------------------------------------------------
// The stage: one graph, or two in a battle

class Show {
  constructor(scenes, sets) {
    this.graphs = scenes.map((scene, i) => new Graph(this, scene, sets[i], i));
    this.battle = this.graphs.length > 1;
    this.slots = new Set();
    this.waves = [];
    this.attacks = [];
    this.arcs = [];
    this.tunnel = 0;
    this.dark = 0;
    this.balance = 0;  // the tug of war: positive while deck A is winning
    this.angle = 0;
    this.orbit = 0;
    this.sx = 0;
    this.sy = 0;
    this.env = { kick: 0, snare: 0, impact: 0 };
    this.stars = makeStars(STAR_COUNT);
    this.frames = 0;
    this.nextBeat = 0;
    this.lastT = music.now();
    this.pos = music.position(music.now()) || IDLE_POSITION;
    this.pal = this.graphs[0].palette;
    this.hue = this.graphs[0].genre.bg;
    this.layout(music.now(), 0, this.pos, true);
    for (const g of this.graphs) g.project(0, 0);
  }

  frame(t, dt) {
    this.frames++;
    const pos = music.position(t) || IDLE_POSITION;
    this.pos = pos;
    this.pal = typeof pos.deck === 'number' ? this.graphs[pos.deck].palette : this.blendedPalette();
    this.react(t, pos);
    for (const g of this.graphs) {
      g.moveAnchors(t);
      // Two graphs take turns to settle, frame by frame, so the pair costs about the same as one.
      const turn = this.battle ? this.frames % 2 === g.index : g.nodes.length < 1200 || this.frames % 2 === 0;
      if (turn) g.sim.tick();
      g.recoil *= Math.exp(-dt * 5);
    }
    this.layout(t, dt, pos);
    for (const g of this.graphs) g.project(this.sx, this.sy);
    this.ambient(t, pos);
    for (const g of this.graphs) {
      g.updatePulses(t);
      g.updateGlow(t);
    }
    this.updateAttacks(t);
    this.balance *= Math.exp(-dt * 0.04);

    this.drawStars(dt, pos);
    this.drawSpectrum();
    this.drawLasers(pos);
    this.drawDivider(t, pos);
    // The deck on the attack is drawn on top.
    for (const g of [...this.graphs].sort((a, b) => a.v.alpha - b.v.alpha)) g.draw(t, pos);
    this.drawAttacks(t);
    this.drawArcs(t);
    this.drawWaves(t);
    this.drawOverlay(dt, pos);
    updateHud(pos);
  }

  blendedPalette() {
    if (!this.battle) return this.graphs[0].palette;
    const [a, b] = this.graphs.map((g) => g.palette);
    return Array.from({ length: Math.max(a.length, b.length) * 2 }, (_, k) => (k % 2 ? b : a)[(k >> 1) % (k % 2 ? b : a).length]);
  }

  // Hits that have just sounded throw punches and leave shockwaves behind.
  react(t, pos) {
    this.env = envelopes(t);
    for (const g of this.graphs) g.env = this.battle ? envelopes(t, g.index) : this.env;
    for (const h of music.hitsBetween(this.lastT, t)) {
      const g = typeof h.deck === 'number' ? this.graphs[h.deck] : null;
      const fighting = Boolean(this.battle && g && pos.stage !== 'merged' && pos.section !== 'build');
      if (h.type === 'kick') {
        if (fighting) this.attack(g, h, 1);
        if (pos.section === 'drop' || pos.section === 'groove') {
          this.waves.push({ kind: 'kick', at: h.t, v: h.v * (pos.section === 'drop' ? 1 : 0.5), c: this.colourAt(pos.beats), from: fighting ? g : null });
        }
        if (this.battle && h.deck === 'mix' && pos.section === 'drop') this.fuse(h.t, 4);
      } else if (h.type === 'clap' && fighting) {
        this.attack(g, h, 0.6);
      } else if (h.type === 'roll') {
        this.waves.push({ kind: 'tunnel', at: h.t, v: h.v, c: this.tunnel++ % this.pal.length, from: null });
        if (this.battle && pos.stage !== 'battle') this.fuse(h.t, 1);  // sparks jump between them as they close in
      } else if (h.type === 'impact') {
        this.waves.push({ kind: 'impact', at: h.t, v: h.v, c: 0, from: fighting ? g : null });
      }
    }
    if (this.waves.length > 40) this.waves.splice(0, this.waves.length - 40);
    this.lastT = t;
  }

  colourAt(beats) {
    return ((Math.floor(beats) % this.pal.length) + this.pal.length) % this.pal.length;
  }

  // A punch: light thrown from one graph lands on the other and knocks it back.
  attack(from, h, strength) {
    if (this.attacks.length > 24) return;
    const to = this.graphs[1 - from.index];
    this.attacks.push({
      from, to, a: from.randomNode(), b: to.randomNode(), start: h.t, end: h.t + music.beatAt(h.t) * 0.5,
      v: h.v * strength, bend: Math.random() < 0.5 ? -1 : 1, landed: false,
    });
  }

  updateAttacks(t) {
    this.attacks = this.attacks.filter((k) => {
      if (!k.landed && t >= k.end) {
        k.landed = true;
        k.to.recoil = Math.min(1.5, k.to.recoil + 0.45 * k.v);
        k.to.flash(k.b, t, 1, 0.8);
        k.to.rings.push({ node: k.b, at: t });
        this.balance = clamp(this.balance + (k.from.index === 0 ? 0.035 : -0.035) * k.v, -1, 1);
      }
      return t < k.end + 0.3;
    });
  }

  // Lightning between the two graphs.
  fuse(t, count) {
    for (let k = 0; k < count && this.arcs.length < 24; k++) {
      this.arcs.push({ a: this.graphs[0].randomNode(), b: this.graphs[1].randomNode(), at: t, seed: Math.random() * 1000 });
    }
  }

  // Where each graph sits, how big and bright it is, and how the camera moves on it.
  layout(t, dt, pos, snap = false) {
    const I = settings.intensity * (REDUCED ? 0.3 : 1);
    const { w, h } = view;
    const { section, progress, stage } = pos;
    const gap = isGap(pos);
    const together = smooth(pos.sync);

    // Where each section wants the camera: creeping in through the intro, pushing hard into a
    // build-up, wide and close on alternate bars of a drop, drifting out in a breakdown.
    let push;
    let rate;
    switch (section) {
      case 'intro':
        push = 0.55 + 0.45 * smooth(progress);
        rate = 1.2;
        break;
      case 'groove':
        push = 1 + 0.1 * Math.sin((pos.barF * Math.PI) / 2);
        rate = 2;
        break;
      case 'build':
        push = gap ? 2.8 : 1 + 1.2 * progress * progress;
        rate = gap ? 10 : 3;
        break;
      case 'drop':
        push = pos.phraseBar % 2 === 1 ? 1.6 : 0.86;
        rate = pos.phraseBar === 0 && pos.beatInBar < 1 ? 18 : 7;  // the smash cut out
        break;
      default:
        push = 0.95 - 0.3 * progress;
        rate = 0.8;
    }
    push = 1 + (push - 1) * (0.35 + 0.65 * I);

    // A slow spin that winds up through a build-up, and screen shake on the hits.
    const spin = REDUCED ? 0.01 : { intro: 0.03, groove: 0.05, build: 0.05 + 1.4 * progress ** 3 * I, drop: 0.08, break: 0.02 }[section];
    this.angle += spin * dt;
    this.orbit = together > 0 ? this.orbit + spin * 1.5 * together * dt : 0;  // the pair turns about each other
    const shake = REDUCED ? 0 : I * ((section === 'drop' ? (stage === 'battle' ? 5 : 10) : 2) * this.env.kick + 28 * this.env.impact
      + (section === 'build' ? 4 * progress * this.env.snare : 0));
    this.sx = shake * Math.sin(t * 97.3);
    this.sy = shake * Math.cos(t * 83.1);

    const wide = w >= h;
    const soloRadius = Math.min(w, h) * 0.44;
    const battleRadius = wide ? Math.min(w * 0.21, h * 0.34) : Math.min(w * 0.4, h * 0.19);
    const punchAmount = { intro: 0.05, groove: 0.1, build: 0.06 + 0.12 * progress, drop: 0.24, break: 0.02 }[section];
    const side0 = Math.floor(pos.beats) % 2 ? 1 : -1;

    for (const g of this.graphs) {
      const v = g.v;
      if (!g.fit || this.frames % 12 === g.index * 6) g.measure();
      let ox = w / 2;
      let oy = h / 2;
      let radius = soloRadius;
      let alpha = 1;
      let gpush = push;
      if (this.battle) {
        // Two corners, closing in and circling each other as they sync, until they share one stage.
        const side = g.index ? 1 : -1;
        const active = pos.deck === g.index || pos.deck === 'mix';
        // Together, they interlock as one double constellation that keeps turning, rather than
        // stacking into a single blown-out blob.
        const apart = 1 - together;
        const orbit = together * Math.PI * 1.5 + this.orbit;
        const [ax, ay] = wide ? [1, 0] : [0, 1];
        const dx = ax * Math.cos(orbit) - ay * Math.sin(orbit);
        const dy = ax * Math.sin(orbit) + ay * Math.cos(orbit);
        const reach = (wide ? w : h) * 0.24 * apart + soloRadius * 0.36 * together + g.recoil * 26 * I * apart;
        ox = w / 2 + side * reach * dx;
        oy = h / 2 + side * reach * dy + (wide ? h * 0.04 * apart : 0);
        radius = battleRadius + (soloRadius * 0.72 - battleRadius) * together;
        alpha = (0.38 + 0.62 * Math.max(active ? 1 : 0, together)) * (1 - 0.22 * together);
        if (stage === 'battle' && section === 'drop') gpush = active ? (pos.phraseBar % 2 ? 1.3 : 1.12) : 0.8;
        else if (stage === 'battle') gpush = active ? push : 0.7;
        else if (stage === 'sync' && section === 'drop') gpush = active ? 1.2 : 0.92;
      }
      const k = snap ? 1 : 1 - Math.exp(-dt * rate);
      const glide = snap ? 1 : 1 - Math.exp(-dt * 6);
      v.push += (gpush - v.push) * k;
      v.ox += (ox - v.ox) * glide;
      v.oy += (oy - v.oy) * glide;
      v.radius += (radius - v.radius) * glide;
      v.alpha += (alpha - v.alpha) * (snap ? 1 : 1 - Math.exp(-dt * 8));

      // In a battle the graphs turn opposite ways; as they sync they turn as one.
      const turn = this.battle && g.index ? together * 2 - 1 : 1;
      v.angle += spin * turn * dt;
      if (this.battle && g.index && together > 0) {
        v.angle += angleBetween(this.graphs[0].v.angle, v.angle) * (snap ? 1 : 1 - Math.exp(-dt * 3 * together));
      }

      // In a drop's close-ups, and while the groove plays, look at the code the latest commit touched.
      const centre = g.focusNodes ? centroid(g.focusNodes) : null;
      const wantFocus = centre && ((section === 'drop' && pos.phraseBar % 2 === 1) || section === 'groove');
      const mixTarget = wantFocus ? (section === 'drop' ? (this.battle && together < 1 ? 0.4 : 0.75) : 0.35) : 0;
      v.focusMix += (mixTarget - v.focusMix) * (snap ? 1 : 1 - Math.exp(-dt * 4));
      const tx = g.fit.x + ((centre ? centre.x : g.fit.x) - g.fit.x) * v.focusMix;
      const ty = g.fit.y + ((centre ? centre.y : g.fit.y) - g.fit.y) * v.focusMix;
      const follow = snap ? 1 : 1 - Math.exp(-dt * 5);
      v.x += (tx - v.x) * follow;
      v.y += (ty - v.y) * follow;
      v.scale = v.radius / g.fit.r;

      // Every kick punches in; the impact at the top of a drop punches hardest.
      const env = g.env;
      const punch = 1 + I * (punchAmount * env.kick + (section === 'build' ? 0.07 : 0.03) * env.snare + 0.4 * env.impact);
      v.tilt = REDUCED ? 0 : I * (section === 'drop' ? 0.06 : 0.015) * env.kick * side0 * (g.index ? -1 : 1);
      v.zoom = v.scale * v.push * punch;
    }
  }

  // ---- events ----

  onBar(bar, t, info) {
    const lead = typeof info.deck === 'number' ? this.graphs[info.deck] : null;
    this.hue = ((lead ? lead.genre.bg : this.mixedHue()) + info.chord.degree * 22) % 360;
    const { section, phraseBar } = info;
    if (info.turns) {
      // Trading turns: each deck's riff lands on its own sixteenths.
      const turnOf = (s) => info.turns[Math.floor((phraseBar * 16 + s) / info.split) % 2];
      for (const g of this.graphs) g.nextCommit(bar, t, section, (s) => turnOf(s) === g.index);
      return;
    }
    // A riff per bar in a drop, every other bar elsewhere, and only one as a build-up starts.
    if (section === 'build' ? phraseBar !== 0 : phraseBar % (section === 'drop' ? 1 : 2) !== 0) return;
    (lead || this.graphs[bar % this.graphs.length]).nextCommit(bar, t, section);
  }

  mixedHue() {
    const [a, b] = this.graphs.map((g) => g.genre.bg);
    return b === undefined ? a : (a + (((b - a + 540) % 360) - 180) / 2 + 360) % 360;
  }

  later(t, fn) {
    setTimeout(() => {
      if (world === this) fn();
    }, Math.max(0, (t - music.now()) * 1000));
  }

  // On some beats, light leaps from one node to a neighbour in whichever graph is playing.
  ambient(t, pos) {
    if (t < this.nextBeat) return;
    const first = this.nextBeat === 0;
    this.nextBeat = music.quantize(t + 0.01, 1);
    const pool = typeof pos.deck === 'number' ? [this.graphs[pos.deck]] : this.graphs;
    const g = pool[(Math.random() * pool.length) | 0];
    if (first || Math.random() > g.set.density * (0.3 + 0.7 * pos.energy)) return;
    const n = g.randomNode();
    g.flash(n, t, 0.45, 1);
    g.emit(n, t, pos.section === 'drop' ? 2 : 1, Math.random() < 0.7, 0);
  }

  // At most one lead note per sixteenth keeps the riffs readable.
  claimSlot(t) {
    const key = music.gridIndex(t);
    if (this.slots.has(key)) return false;
    this.slots.add(key);
    if (this.slots.size > 256) {
      const past = music.gridIndex(music.now());
      for (const s of this.slots) if (s < past) this.slots.delete(s);
    }
    return true;
  }

  // ---- drawing ----

  // Stars rushing past: a gentle drift in a breakdown, warp speed into a drop.
  drawStars(dt, pos) {
    const I = settings.intensity;
    const { section, progress } = pos;
    let speed = { intro: 0.12, groove: 0.25, build: 0.25 + 2.6 * progress * progress, drop: 0.5 + 2 * this.env.kick, break: 0.07 }[section];
    if (isGap(pos)) speed = 3.4;
    speed *= (REDUCED ? 0.25 : 1) * (0.35 + 0.65 * I);
    const { w, h } = view;
    const cx = w / 2 + this.sx;
    const cy = h / 2 + this.sy;
    const f = Math.max(w, h) * 0.5;
    const trail = Math.min(0.35, 0.01 + speed * 0.07);
    const cos = Math.cos(this.angle * 0.5);
    const sin = Math.sin(this.angle * 0.5);
    g2.globalCompositeOperation = 'lighter';
    g2.lineCap = 'round';
    for (const s of this.stars) {
      s.z -= dt * speed;
      const x = s.x * cos - s.y * sin;
      const y = s.x * sin + s.y * cos;
      const x1 = cx + (x / s.z) * f;
      const y1 = cy + (y / s.z) * f;
      if (s.z < 0.04 || x1 < -50 || x1 > w + 50 || y1 < -50 || y1 > h + 50) {
        resetStar(s);
        continue;
      }
      const x0 = cx + (x / (s.z + trail)) * f;
      const y0 = cy + (y / (s.z + trail)) * f;
      const near = 1 - s.z;
      g2.globalAlpha = Math.min(1, 0.15 + near * 0.85);
      g2.strokeStyle = this.pal[s.c % this.pal.length].star;
      g2.lineWidth = 0.6 + near * 2.2;
      g2.beginPath();
      g2.moveTo(x0, y0);
      g2.lineTo(x1, y1);
      g2.stroke();
    }
  }

  // Laser beams fan up from the floor in a drop (from the playing deck's corner in a battle),
  // and start to creep in through a build-up.
  drawLasers(pos) {
    if (REDUCED) return;
    const I = settings.intensity;
    let strength = 0;
    if (pos.section === 'drop') strength = 0.55 + 0.45 * this.env.kick;
    else if (pos.section === 'build') strength = 0.45 * pos.progress * pos.progress;
    strength *= I;
    if (strength < 0.02) return;
    const { w, h } = view;
    const len = Math.hypot(w, h);
    let corners = [[w * 0.08, h + 10, 1, 0], [w * 0.92, h + 10, -1, 1]];
    if (this.battle && typeof pos.deck === 'number') corners = [corners[pos.deck]];
    g2.globalCompositeOperation = 'lighter';
    for (const [ox, oy, side, o] of corners) {
      const pal = this.battle ? this.graphs[o].palette : this.pal;
      for (let k = 0; k < 5; k++) {
        const sweep = Math.sin((pos.beats * Math.PI) / 4 + k * 0.8 + o * 1.7);  // one sweep every eight beats
        const angle = -Math.PI / 2 + side * (0.22 + k * 0.17 + sweep * 0.32);
        g2.strokeStyle = pal[(k + o * 2) % pal.length].css;
        g2.beginPath();
        g2.moveTo(ox, oy);
        g2.lineTo(ox + Math.cos(angle) * len, oy + Math.sin(angle) * len);
        g2.globalAlpha = 0.07 * strength;
        g2.lineWidth = 12;
        g2.stroke();
        g2.globalAlpha = 0.5 * strength;
        g2.lineWidth = 1.4;
        g2.stroke();
      }
    }
  }

  // A crackling line between the two corners, with VS on it. It fades as they sync.
  drawDivider(t, pos) {
    if (!this.battle) return;
    const apart = 1 - smooth(pos.sync);
    if (apart < 0.02) return;
    const [a, b] = this.graphs.map((g) => g.v);
    const mx = (a.ox + b.ox) / 2 + this.sx;
    const my = (a.oy + b.oy) / 2 + this.sy;
    let ax = b.ox - a.ox;
    let ay = b.oy - a.oy;
    const d = Math.hypot(ax, ay) || 1;
    ax /= d;
    ay /= d;
    const nx = -ay;  // along the line
    const ny = ax;
    const reach = Math.hypot(view.w, view.h) / 2;
    const kick = Math.max(this.graphs[0].env.kick, this.graphs[1].env.kick);
    const seed = Math.floor(pos.beats * 2);
    g2.globalCompositeOperation = 'lighter';
    for (const [width, alpha, colour] of [[7, 0.12, this.graphs[0].palette[0].css], [1.6, 0.6, '#ffffff']]) {
      g2.beginPath();
      for (let k = -12; k <= 12; k++) {
        const along = (k / 12) * reach;
        const jag = (noise1(seed * 31 + k) - 0.5) * (10 + 26 * kick);
        const x = mx + nx * along + ax * jag;
        const y = my + ny * along + ay * jag;
        if (k === -12) g2.moveTo(x, y);
        else g2.lineTo(x, y);
      }
      g2.strokeStyle = colour;
      g2.lineWidth = width;
      g2.globalAlpha = alpha * apart * (0.4 + 0.6 * kick);
      g2.stroke();
    }
    g2.globalCompositeOperation = 'source-over';
    const size = 40 + 16 * kick;
    g2.font = `800 ${size.toFixed(0)}px Unbounded, "Space Grotesk", sans-serif`;
    g2.textAlign = 'center';
    g2.textBaseline = 'middle';
    g2.globalAlpha = apart * (0.55 + 0.45 * kick);
    g2.lineWidth = 6;
    g2.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    g2.strokeText('VS', mx, my);
    g2.fillStyle = '#ffffff';
    g2.fillText('VS', mx, my);
    g2.globalAlpha = 1;
  }

  drawAttacks(t) {
    g2.globalCompositeOperation = 'lighter';
    for (const k of this.attacks) {
      if (t < k.start || k.landed) continue;
      const u = clamp((t - k.start) / (k.end - k.start), 0, 1);
      const x0 = k.a.sx;
      const y0 = k.a.sy;
      const x2 = k.b.sx;
      const y2 = k.b.sy;
      const d = Math.hypot(x2 - x0, y2 - y0);
      const cx = (x0 + x2) / 2 - ((y2 - y0) / (d || 1)) * d * 0.3 * k.bend;
      const cy = (y0 + y2) / 2 + ((x2 - x0) / (d || 1)) * d * 0.3 * k.bend;
      const sprite = k.from.sprites[k.a.c];
      for (let j = 0; j < 7; j++) {  // a curving comet with a long tail
        const s = Math.max(0, u - j * 0.035);
        const x = (1 - s) * (1 - s) * x0 + 2 * (1 - s) * s * cx + s * s * x2;
        const y = (1 - s) * (1 - s) * y0 + 2 * (1 - s) * s * cy + s * s * y2;
        const size = (12 + 6 * k.v) * (1 - j * 0.12);
        g2.globalAlpha = (1 - j * 0.13) * Math.min(1, 0.4 + k.v);
        g2.drawImage(sprite, x - size, y - size, size * 2, size * 2);
      }
    }
    g2.globalAlpha = 1;
  }

  drawArcs(t) {
    g2.globalCompositeOperation = 'lighter';
    this.arcs = this.arcs.filter((arc) => {
      const age = t - arc.at;
      if (age > 0.25) return false;
      if (age < 0) return true;
      const x0 = arc.a.sx;
      const y0 = arc.a.sy;
      const x1 = arc.b.sx;
      const y1 = arc.b.sy;
      const d = Math.hypot(x1 - x0, y1 - y0) || 1;
      const nx = -(y1 - y0) / d;
      const ny = (x1 - x0) / d;
      g2.beginPath();
      for (let k = 0; k <= 8; k++) {
        const u = k / 8;
        const jag = k === 0 || k === 8 ? 0 : (noise1(arc.seed + k) - 0.5) * Math.min(80, d * 0.18);
        const x = x0 + (x1 - x0) * u + nx * jag;
        const y = y0 + (y1 - y0) * u + ny * jag;
        if (k) g2.lineTo(x, y);
        else g2.moveTo(x, y);
      }
      g2.strokeStyle = '#ffffff';
      g2.globalAlpha = (1 - age / 0.25) * 0.75 * settings.intensity;
      g2.lineWidth = 1.4;
      g2.stroke();
      return true;
    });
    g2.globalAlpha = 1;
  }

  // Shockwaves from the kick, hexagons flying past in a snare roll, and a blast when a drop lands.
  drawWaves(t) {
    const { w, h } = view;
    const reach = Math.hypot(w, h) / 2;
    const I = settings.intensity;
    g2.globalCompositeOperation = 'lighter';
    this.waves = this.waves.filter((wave) => {
      const life = { kick: 0.55, tunnel: 0.75, impact: 1.5 }[wave.kind];
      const age = t - wave.at;
      if (age > life) return false;
      if (age < 0) return true;
      const u = age / life;
      const pal = wave.from ? wave.from.palette : this.pal;
      const cx = (wave.from ? wave.from.v.ox : w / 2) + this.sx;
      const cy = (wave.from ? wave.from.v.oy : h / 2) + this.sy;
      const scale = wave.from ? 0.55 : 1;  // a deck's own shockwave stays mostly on its side
      g2.strokeStyle = pal[wave.c % pal.length].ring;
      g2.beginPath();
      if (wave.kind === 'tunnel') {
        const r = reach * 1.3 * u * u;
        const spin = this.angle * 2 + wave.c * 0.3;
        for (let k = 0; k <= 6; k++) {
          const a = spin + (k * TAU) / 6;
          if (k) g2.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
          else g2.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
        }
        g2.globalAlpha = (1 - u) * 0.55 * wave.v * I;
        g2.lineWidth = 1 + 6 * u;
      } else if (wave.kind === 'impact') {
        g2.arc(cx, cy, 20 + Math.sqrt(u) * reach * 1.5 * scale, 0, TAU);
        g2.globalAlpha = (1 - u) * 0.9 * wave.v * I;
        g2.lineWidth = 2 + 14 * (1 - u);
        g2.strokeStyle = '#ffffff';
      } else {
        g2.arc(cx, cy, 30 + u * reach * 0.95 * scale, 0, TAU);
        g2.globalAlpha = (1 - u) * 0.35 * wave.v * I;
        g2.lineWidth = 0.5 + 3 * (1 - u);
      }
      g2.stroke();
      return true;
    });
    g2.globalAlpha = 1;
  }

  // The mix, as a mirrored equaliser along the bottom edge, behind the graphs.
  drawSpectrum() {
    const data = music.spectrum();
    if (!data) return;
    const { w, h } = view;
    const half = 28;
    const bw = w / (half * 2);
    const bins = data.length * 0.6;
    g2.globalCompositeOperation = 'lighter';
    for (let k = 0; k < half; k++) {
      const v = data[Math.floor(1 + Math.pow(k / half, 2.2) * bins)] / 255;
      const height = v * v * h * 0.14;
      if (height < 1) continue;
      g2.globalAlpha = 0.1 + 0.24 * v;
      g2.fillStyle = this.pal[k % this.pal.length].css;
      g2.fillRect(w / 2 + k * bw + 1, h - height, bw - 2, height);
      g2.fillRect(w / 2 - (k + 1) * bw + 1, h - height, bw - 2, height);
    }
    g2.globalAlpha = 1;
  }

  // The gap before a drop goes dark; the drop itself lands with a flash.
  drawOverlay(dt, pos) {
    const { w, h } = view;
    g2.globalCompositeOperation = 'source-over';
    const darkTarget = isGap(pos) ? 0.82 * clamp((pos.beatInBar - 3) * 4, 0, 1) * Math.max(0.4, settings.intensity) : 0;
    this.dark = darkTarget > this.dark ? darkTarget : this.dark * Math.exp(-dt * 14);
    if (this.dark > 0.01) {
      g2.globalAlpha = this.dark;
      g2.fillStyle = '#000';
      g2.fillRect(0, 0, w, h);
    }
    if (settings.flashes && !REDUCED) {
      if (this.env.impact > 0.01) {
        g2.globalAlpha = 0.75 * this.env.impact * settings.intensity;
        g2.fillStyle = '#fff';
        g2.fillRect(0, 0, w, h);
      }
      if (pos.section === 'drop' && this.env.snare > 0.01) {
        g2.globalAlpha = 0.09 * this.env.snare * settings.intensity;
        g2.fillStyle = this.pal[this.colourAt(pos.beats)].css;
        g2.fillRect(0, 0, w, h);
      }
    }
    const vignette = g2.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.hypot(w, h) * 0.6);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.55)');
    g2.globalAlpha = 1;
    g2.fillStyle = vignette;
    g2.fillRect(0, 0, w, h);
  }
}

// How hard the music is hitting at t (from one deck, if given): each envelope jumps on a hit and dies away.
function envelopes(t, deck) {
  const beat = music.beatAt(t);
  const k = music.lastHit(['kick'], t, deck);
  const c = music.lastHit(['clap', 'roll'], t, deck);
  const i = music.lastHit(['impact'], t, deck);
  return {
    kick: k ? k.v * Math.exp(-(t - k.t) / (beat * 0.22)) : 0,
    snare: c ? c.v * Math.exp(-(t - c.t) / (beat * 0.12)) : 0,
    impact: i && t - i.t < 3 ? i.v * Math.exp(-(t - i.t) / 0.45) : 0,
  };
}

// The last beat of a build-up: silence, darkness, then the drop.
function isGap(pos) {
  return pos.section === 'build' && pos.phraseBar === pos.bars - 1 && pos.beatInBar >= 3;
}

function centroid(nodes) {
  let x = 0;
  let y = 0;
  for (const n of nodes) {
    x += n.x;
    y += n.y;
  }
  return { x: x / nodes.length, y: y / nodes.length };
}

function smooth(u) {
  return u * u * (3 - 2 * u);
}

// The short way from angle b to angle a.
function angleBetween(a, b) {
  return ((((a - b) % TAU) + TAU * 1.5) % TAU) - Math.PI;
}

// A repeatable random number in [0, 1) for each n, so lightning keeps its shape for a moment.
function noise1(n) {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

// A battle keeps each graph to its most connected nodes, so two stay smooth.
function trimScene(scene, max) {
  if (scene.nodes.length <= max) return scene;
  const keep = (i) => i < max;
  return {
    ...scene,
    nodes: scene.nodes.slice(0, max),
    links: scene.links.filter(([s, t]) => keep(s) && keep(t)),
    commits: scene.commits.map((c) => ({ ...c, n: c.n.filter(keep) })),
    trimmed: true,
  };
}

// ---------------------------------------------------------------------------
// Drawing helpers

// One colour per cluster. `tone` (0–1) is the colour's place in the gradient, which is also
// the note it plays, so similar colours sound alike.
function paletteFor(scene, genre, hueBase) {
  return scene.communities.map((_, i) => {
    const tone = ((hueBase / 360) + i * 0.381966) % 1;
    const { h, s, l } = genreColour(genre.stops, tone);
    return colour(h, s, l, tone);
  });
}

function colour(h, s, l, tone) {
  const light = (dl) => Math.min(96, l + dl);
  return {
    h, s, l, tone,
    edge: `hsla(${h}, ${s - 10}%, ${light(4)}%, 0.2)`,
    ring: `hsl(${h}, ${s}%, ${light(14)}%)`,
    label: `hsl(${h}, ${s}%, ${light(24)}%)`,
    star: `hsl(${h}, ${Math.max(0, s - 40)}%, ${light(26)}%)`,
    css: `hsl(${h}, ${s}%, ${l}%)`,
  };
}

function glowSprite(c) {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, `hsla(${c.h}, ${Math.min(100, c.s + 10)}%, ${Math.min(96, c.l + 30)}%, 1)`);
  grad.addColorStop(0.13, `hsla(${c.h}, ${c.s}%, ${Math.min(95, c.l + 10)}%, 0.95)`);
  grad.addColorStop(0.3, `hsla(${c.h}, ${c.s}%, ${c.l}%, 0.32)`);
  grad.addColorStop(1, `hsla(${c.h}, ${c.s}%, ${c.l - 10}%, 0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return canvas;
}

function makeStars(count) {
  return Array.from({ length: count }, () => resetStar({ c: (Math.random() * 36) | 0 }, Math.random()));
}

function resetStar(s, z = 1) {
  s.x = Math.random() * 2 - 1;
  s.y = Math.random() * 2 - 1;
  s.z = 0.15 + z * 0.85;
  return s;
}

function drawBackdrop(hue, pulse) {
  const { w, h } = view;
  const grad = g2.createRadialGradient(w * 0.5, h * 0.45, 0, w * 0.5, h * 0.5, Math.hypot(w, h) * 0.62);
  grad.addColorStop(0, `hsl(${hue}, 60%, ${6 + 7 * pulse}%)`);
  grad.addColorStop(1, `hsl(${(hue + 30) % 360}, 70%, ${1.5 + 1.5 * pulse}%)`);
  g2.globalCompositeOperation = 'source-over';
  g2.globalAlpha = 1;
  g2.fillStyle = grad;
  g2.fillRect(0, 0, w, h);
}

function resize() {
  view.dpr = Math.min(window.devicePixelRatio || 1, 2);
  view.w = window.innerWidth;
  view.h = window.innerHeight;
  sky.width = Math.round(view.w * view.dpr);
  sky.height = Math.round(view.h * view.dpr);
  g2.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
}

function frame(ms) {
  const t = ms / 1000;  // same clock as performance.now(), which dj.js schedules against
  const dt = Math.min(0.1, Math.max(0, t - lastFrame));
  lastFrame = t;
  backdropHue = approachHue(backdropHue, world ? world.hue : 280, dt * 0.8);
  const pulse = world ? world.env.kick * world.pos.energy * settings.intensity + world.env.impact : 0;
  drawBackdrop(backdropHue, Math.min(1, pulse));
  if (world) world.frame(t, dt);
  requestAnimationFrame(frame);
}

function approachHue(from, to, k) {
  const diff = ((to - from + 540) % 360) - 180;
  return (from + diff * Math.min(1, k) + 360) % 360;
}

function gaussian() {
  return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(TAU * Math.random());
}

// ---------------------------------------------------------------------------
// The HUD: what section it is, the beat, the tempo, and in a battle who's winning

function sectionLabel(pos) {
  if (pos.stage === 'battle') return pos.section === 'intro' ? 'Intro' : `Round ${pos.round}`;
  if (pos.stage === 'sync') return pos.section === 'build' ? 'Build-up' : 'Syncing';
  return SECTIONS[pos.section].label;
}

function countdownText(pos) {
  const n = pos.barsLeft;
  const bars = `${n} bar${n === 1 ? '' : 's'}`;
  if (pos.section === 'build') return n <= 1 ? 'Drop incoming' : `Drop in ${bars}`;
  if (pos.stage === 'battle') return `${world.graphs[pos.nextDeck]?.short || 'Next'} in ${bars} · D to sync`;
  if (pos.stage === 'sync') return `Together in ${bars}`;
  if (pos.stage === 'merged' && pos.nextStage === 'battle') return `Back to battle in ${bars}`;
  return `${SECTIONS[pos.next].label} in ${bars}`;
}

function updateHud(pos) {
  const label = sectionLabel(pos);
  if (hud.section !== label) {
    hud.section = label;
    $('#section').textContent = label;
    document.body.dataset.section = pos.section;
    document.body.dataset.stage = pos.stage;
  }
  const deck = String(pos.deck);
  if (hud.deck !== deck) {
    hud.deck = deck;
    document.body.dataset.deck = deck;
  }
  const beat = Math.max(0, Math.floor(pos.beatInBar)) % 4;
  if (hud.beat !== beat) {
    hud.beat = beat;
    document.querySelectorAll('#beats span').forEach((dot, k) => dot.classList.toggle('on', k === beat));
  }
  $('#phrase-fill').style.transform = `scaleX(${pos.progress.toFixed(3)})`;
  const soon = countdownText(pos);
  if (hud.soon !== soon) {
    hud.soon = soon;
    $('#countdown').textContent = soon;
  }
  const bpm = `${Math.round(pos.bpm)} BPM`;
  if (hud.bpm !== bpm) {
    hud.bpm = bpm;
    $('#bpm').textContent = bpm;
  }
  if (world.battle) {
    $('#meter-a').style.width = `${(50 + 50 * world.balance).toFixed(1)}%`;
    $('#vs').classList.toggle('synced', pos.stage === 'merged');
  }
}

// ---------------------------------------------------------------------------
// Settings: the genres, the lead, the mashup, the mix and the visuals, remembered in this browser

function loadSettings() {
  const fallback = {
    genre: 'repo', genreB: 'repo', lead: 'auto', mix: {}, mash: { drums: 0, bass: 1, chords: 1 },
    intensity: 0.85, flashes: !REDUCED,
  };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
    const mash = { ...fallback.mash };
    for (const [part] of MASH_PARTS) if ([0, 1].includes(saved.mash?.[part])) mash[part] = saved.mash[part];
    return {
      genre: GENRES[saved.genre] ? saved.genre : 'repo',
      genreB: GENRES[saved.genreB] ? saved.genreB : 'repo',
      lead: LEADS[saved.lead] ? saved.lead : 'auto',
      mix: saved.mix && typeof saved.mix === 'object' ? saved.mix : {},
      mash,
      intensity: Number.isFinite(saved.intensity) ? clamp(saved.intensity, 0, 1) : fallback.intensity,
      flashes: typeof saved.flashes === 'boolean' ? saved.flashes : fallback.flashes,
    };
  } catch {
    return fallback;
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // storage can be unavailable (private windows); the choices still apply for this visit
  }
}

const genreChoice = (deck) => (deck ? settings.genreB : settings.genre);

// The mix to play: the person's own changes on top of what the sets suggest.
function mixFor(sets) {
  const suggested = defaultMix(sets);
  return Object.fromEntries(CHANNELS.map((c) => [c.id, { ...suggested[c.id], ...settings.mix[c.id] }]));
}

// ---------------------------------------------------------------------------
// The mixer panel

function chip(label, swatch, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'genre-chip';
  if (swatch) {
    const dot = document.createElement('span');
    dot.className = 'swatch';
    dot.style.background = swatch;
    button.append(dot);
  }
  button.append(Object.assign(document.createElement('span'), { textContent: label }));
  button.addEventListener('click', onClick);
  return button;
}

function buildMixer() {
  for (const [deck, box] of [[0, '#genres'], [1, '#genres-b']]) {
    for (const [id, genre] of Object.entries(GENRES)) {
      const button = chip(genre.name, genreSwatch(genre), () => applyGenre(id, deck));
      button.dataset.genre = id;
      button.dataset.deck = String(deck);
      $(box).append(button);
    }
  }
  for (const id of ['auto', ...Object.keys(LEADS)]) {
    const button = chip(id === 'auto' ? 'From the code' : LEADS[id].name, null, () => applyLead(id));
    button.dataset.lead = id;
    $('#leads').append(button);
  }
  for (const [part, name] of MASH_PARTS) {
    const row = document.createElement('div');
    row.className = 'mash-row';
    const group = document.createElement('div');
    group.className = 'chips';
    for (const from of [0, 1]) {
      const button = chip('', null, () => applyMash(part, from));
      button.dataset.part = part;
      button.dataset.from = String(from);
      group.append(button);
    }
    row.append(Object.assign(document.createElement('span'), { className: 'mash-name', textContent: name }), group);
    $('#mash-rows').append(row);
  }

  for (const channel of CHANNELS) {
    const row = document.createElement('div');
    row.className = 'inst';
    row.dataset.channel = channel.id;
    const toggle = document.createElement('label');
    toggle.className = 'inst-toggle';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'switch';
    box.addEventListener('change', () => changeChannel(channel.id, { on: box.checked }));
    toggle.append(box, Object.assign(document.createElement('span'), { className: 'inst-name', textContent: channel.name }));
    const level = document.createElement('input');
    level.type = 'range';
    level.min = '0';
    level.max = '1';
    level.step = '0.01';
    level.setAttribute('aria-label', `${channel.name} volume`);
    level.addEventListener('input', () => changeChannel(channel.id, { level: Number(level.value), on: true }));
    row.append(toggle, level, Object.assign(document.createElement('p'), { className: 'inst-sub' }));
    $(`#${channel.group}`).append(row);
  }

  const intensity = $('#intensity');
  intensity.value = String(settings.intensity);
  intensity.addEventListener('input', () => {
    settings.intensity = Number(intensity.value);
    saveSettings();
  });
  for (const box of [$('#flashes'), $('#flashes-start')]) {
    box.checked = settings.flashes;
    box.addEventListener('change', () => {
      settings.flashes = box.checked;
      $('#flashes').checked = $('#flashes-start').checked = settings.flashes;
      saveSettings();
    });
  }

  $('#reset-mix').addEventListener('click', () => {
    settings.mix = {};
    saveSettings();
    if (world) music.setMix(mixFor(world.graphs.map((g) => g.set)));
    syncMixer();
  });
}

function changeChannel(id, patch) {
  music.setChannel(id, { ...music.mix[id], ...patch });
  settings.mix[id] = { ...music.mix[id] };
  saveSettings();
  syncMixer();
}

function applyGenre(id, deck = 0) {
  if (genreChoice(deck) === id && world) return;
  settings[deck ? 'genreB' : 'genre'] = id;
  saveSettings();
  const g = world && world.graphs[deck];
  if (g) {
    const set = deriveSet(g.scene, id, settings.lead);
    g.setSet(set);
    if (world.battle) music.setDeck(deck, set);  // heard from the next bar
    else music.configure([set], mixFor([set]), 'drop');  // bring the new genre in with a drop
    showSets();
  }
  syncMixer();
}

function applyLead(id) {
  settings.lead = id;
  saveSettings();
  if (world) {
    for (const g of world.graphs) {
      g.set = deriveSet(g.scene, genreChoice(g.index), id);
      music.setLead(g.index, g.set.lead);
    }
    showSets();
  }
  syncMixer();
}

function applyMash(part, from) {
  settings.mash[part] = from;
  saveSettings();
  music.setMash(settings.mash);
  syncMixer();
}

function describeChannel(id, set) {
  const g = GENRES[set.genre];
  switch (id) {
    case 'kick': return g.drums.kick === 'x---x---x---x---' ? 'four on the floor' : 'two-step: on 1 and the and of 3';
    case 'clap': return `${g.snare ? 'snare' : 'claps'} on 2 and 4, and the rolls`;
    case 'hats': return 'sixteenths, with open hats on the offbeat';
    case 'perc': return { conga: 'congas', ride: 'ride cymbal', shaker: 'shaker', rim: 'rimshots', ghost: 'ghost snares' }[g.perc];
    case 'bass': return `${{ offbeat: 'offbeat bass', rolling: 'rolling sixteenths', acid: 'acid line', sub: 'sub bass', reese: 'reese bass' }[g.bass.style]}, pumping with the kick`;
    case 'chords': return { stab: 'piano-style stabs', dub: 'dub stabs into the echo', gate: 'gated supersaws', hook: 'supersaw hook', pad: 'held chords' }[g.chords.style];
    case 'pad': return 'swells under the intro, build-ups and breakdowns';
    case 'arp': return 'up and down each chord';
    case 'lead': return `${LEADS[set.lead]?.name || 'Pluck'}: plays the nodes as light reaches them`;
    default: return 'risers, impacts and crashes';
  }
}

// Reflect the current genres, lead, mashup and mix.
function syncMixer() {
  const battle = Boolean(world && world.battle);
  $('#genres-b').hidden = !battle;
  $('#genres-b-label').hidden = !battle;
  $('#genres-a-label').hidden = !battle;
  $('#mashup').hidden = !battle;
  if (battle) {
    $('#genres-a-label').textContent = `A · ${world.graphs[0].short}`;
    $('#genres-b-label').textContent = `B · ${world.graphs[1].short}`;
  }
  for (const button of document.querySelectorAll('[data-genre]')) {
    const deck = Number(button.dataset.deck);
    button.setAttribute('aria-pressed', String(button.dataset.genre === genreChoice(deck)));
    if (button.dataset.genre === 'repo') {
      const g = world && world.graphs[deck];
      button.lastChild.textContent = g ? `From the repo · ${GENRES[g.repoGenre].name}` : GENRES.repo.name;
    }
  }
  for (const button of document.querySelectorAll('[data-lead]')) {
    button.setAttribute('aria-pressed', String(button.dataset.lead === settings.lead));
    if (button.dataset.lead === 'auto') {
      const leads = world ? [...new Set(world.graphs.map((g) => LEADS[g.set.codeLead].name))] : [];
      button.lastChild.textContent = leads.length ? `From the code · ${leads.join(' / ')}` : 'From the code';
    }
  }
  for (const button of document.querySelectorAll('[data-part]')) {
    const from = Number(button.dataset.from);
    button.setAttribute('aria-pressed', String(settings.mash[button.dataset.part] === from));
    if (battle) button.lastChild.textContent = world.graphs[from].short;
  }
  for (const channel of CHANNELS) {
    const row = document.querySelector(`.inst[data-channel="${channel.id}"]`);
    const state = music.mix[channel.id] || { on: false, level: channel.level };
    row.classList.toggle('off', !state.on);
    row.querySelector('.switch').checked = state.on;
    const level = row.querySelector('input[type=range]');
    if (document.activeElement !== level) level.value = String(state.level);
    const words = world ? [...new Set(world.graphs.map((g) => describeChannel(channel.id, g.set)))] : [];
    row.querySelector('.inst-sub').textContent = words.length > 1 ? `A: ${words[0]} · B: ${words[1]}` : words[0] || '';
  }
  renderAbout();
}

function renderAbout() {
  if (!world) return;
  const items = [];
  const add = (text, head = false) => items.push(Object.assign(document.createElement('li'), { textContent: text, className: head ? 'about-head' : '' }));
  if (world.battle) {
    const [a, b] = world.graphs;
    const mash = music.mash;
    const from = (part) => world.graphs[settings.mash[part]].short;
    add('The battle', true);
    add(`${a.short} plays ${GENRES[a.set.genre].name} at ${a.set.bpm} BPM; ${b.short} answers with ${GENRES[b.set.genre].name} at ${b.set.bpm} BPM. `
      + 'They take eight-bar rounds, every kick and clap throws a punch at the other graph, and the meter shows who is winning.');
    add(`Press D to sync: they trade bars, then half bars, beats and eighths while their tempos meet at ${mash.bpm} BPM and `
      + `${b.short} moves into ${a.short}'s key. Then a build-up pulls the two graphs into one drop: drums from ${from('drums')}, `
      + `bass from ${from('bass')}, chords from ${from('chords')}. Afterwards they split up and battle on.`);
  }
  for (const g of world.graphs) {
    if (world.battle) add(g.name, true);
    for (const reason of g.set.reasons) add(reason);
  }
  if (!world.battle) {
    add('The set loops through a groove, a build-up, a drop, a breakdown, another build-up and another drop. '
      + 'Press D to skip to the next drop.');
  }
  for (const g of world.graphs) {
    const prefix = world.battle ? `${g.short}: ` : '';
    add(g.scene.commits.length
      ? `${prefix}the last ${g.scene.commits.length} commits drop in order, one per bar in a drop. The code each one touched fires as a riff, and the camera cuts to it.`
      : `${prefix}there are no commits to replay, so the biggest hubs take the riffs.`);
    if (g.scene.trimmed) {
      add(`${prefix}showing the ${g.nodes.length.toLocaleString()} most connected of ${g.scene.stats.nodes_total.toLocaleString()} pieces of code, to keep it smooth.`);
    }
  }
  $('#reasons').replaceChildren(...items);
}

// ---------------------------------------------------------------------------
// Captions

function showCommitCaption(graph, commit, number, section) {
  const caption = $('#caption');
  caption.classList.add('fading');
  setTimeout(() => {
    const doing = section === 'drop' ? 'Dropping' : 'Now playing';
    $('#caption-tag').textContent = world && world.battle ? `${graph.short} · ${doing}` : doing;
    caption.dataset.deck = String(graph.index);
    $('#caption-msg').textContent = commit.m || '(no message)';
    $('#caption-meta').textContent = [commit.a, relativeTime(commit.t), `${commit.f} file${commit.f === 1 ? '' : 's'}`,
      `${number} of ${graph.scene.commits.length}`].filter(Boolean).join('  ·  ');
    caption.classList.remove('fading');
  }, 180);
}

// ---------------------------------------------------------------------------
// Screens

function showScreen(name) {
  $('#intro').hidden = name !== 'intro';
  $('#progress').hidden = name !== 'progress';
  $('#hud').hidden = name !== 'hud';
  document.body.classList.remove('idle');
}

function showError(message) {
  const box = $('#error');
  box.textContent = message;
  box.hidden = !message;
}

async function postJSON(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'The server turned that request down.');
  return data;
}

// Wait for every repository's job, showing each one's progress.
async function waitForJobs(ids, names) {
  const results = new Array(ids.length).fill(null);
  for (;;) {
    await sleep(700);
    const steps = [];
    const logs = [];
    for (let k = 0; k < ids.length; k++) {
      if (results[k]) {
        steps.push(`${names[k]}: ready`);
        continue;
      }
      const poll = await fetch(`/api/job/${ids[k]}`);
      if (!poll.ok) throw new Error('Lost track of the work. Is server.py still running?');
      const job = await poll.json();
      if (job.state === 'error') throw new Error(ids.length > 1 ? `${names[k]}: ${job.error}` : job.error);
      if (job.state === 'done') results[k] = job.result;
      steps.push(ids.length > 1 ? `${names[k]}: ${job.step}` : job.step);
      logs.push(...job.log.slice(-(ids.length > 1 ? 6 : 12)));
    }
    $('#step').textContent = steps.join('\n');
    $('#log').textContent = logs.join('\n');
    if (results.every(Boolean)) return results;
  }
}

async function begin(scenes) {
  if (typeof d3 === 'undefined') throw new Error("Couldn't load d3, which lays out the graph. Check your internet connection.");
  $('#step').textContent = 'Setting up the decks';
  $('#log').textContent = '';
  await sleep(50);  // let that message paint before the layout warms up

  if (scenes.length > 1) scenes = scenes.map((s) => trimScene(s, BATTLE_NODES));
  const sets = scenes.map((scene, i) => deriveSet(scene, genreChoice(i), settings.lead));
  music.mashParts = { ...settings.mash };
  music.configure(sets, mixFor(sets));
  world = new Show(scenes, sets);
  music.onBar = (bar, t, info) => world && world.onBar(bar, t, info);

  const battle = world.battle;
  document.body.classList.toggle('battle', battle);
  for (const [k, sel] of [[0, '#repo-name'], [1, '#repo-name-b']]) {
    const g = world.graphs[k];
    if (!g) continue;
    $(sel).replaceChildren(`${g.scene.repo.owner}/`, document.createElement('wbr'), g.scene.repo.name);  // wrap after the slash
    $(sel).href = g.scene.repo.url;
  }
  $('.deck-b').hidden = !battle;
  $('#vs').hidden = !battle;
  $('#drop').textContent = battle ? 'Sync' : 'Drop';
  $('#drop').title = battle ? 'Sync the decks into one drop (D)' : 'Skip to the next drop (D)';
  hud = {};
  showSets();
  $('#caption').classList.add('fading');
  showScreen('hud');
  wake();
}

function showSets() {
  $('#mood').textContent = world.graphs[0].set.label;
  if (world.graphs[1]) $('#mood-b').textContent = world.graphs[1].set.label;
  syncMixer();
}

function leave() {
  music.stop();
  music.onBar = null;
  world = null;
  closePanels();
  document.body.classList.remove('battle');
  for (const key of ['section', 'stage', 'deck']) delete document.body.dataset[key];
  showScreen('intro');
}

function dropNow() {
  if (!world) return;
  const button = $('#drop');
  const result = music.requestDrop();
  button.classList.toggle('armed', Boolean(result));
  $('#countdown').textContent = result === 'sync' ? 'Syncing up from the next bar'
    : result ? 'Build-up from the next bar'
      : world.battle ? 'Already coming together' : 'A drop is already on its way';
  hud.soon = null;
  setTimeout(() => button.classList.remove('armed'), 1600);
}

function relativeTime(iso) {
  const then = Date.parse(iso);
  if (!then) return '';
  const secs = (then - Date.now()) / 1000;
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [unit, size] of units) {
    if (Math.abs(secs) >= size) return RTF.format(Math.round(secs / size), unit);
  }
  return 'just now';
}

// ---------------------------------------------------------------------------
// The start screen

async function checkHealth() {
  try {
    health = await (await fetch('/api/health')).json();
  } catch {
    health = { offline: true };
  }
  const code = (text) => Object.assign(document.createElement('code'), { textContent: text });
  const lines = [];
  if (health.offline) lines.push(["Can't reach the DJRepo server. Start it with ", code('start.bat'), ' (or ', code('./start.sh'), ').']);
  else if (!health.graphify) lines.push(["graphify isn't installed yet. In a terminal, run ", code(health.install), ', then restart this app.']);
  else if (!health.git) lines.push(["git isn't installed (or isn't on PATH). It's needed to fetch repositories."]);
  const notice = $('#notice');
  notice.replaceChildren(...lines.map((parts) => {
    const p = document.createElement('p');
    p.append(...parts);
    return p;
  }));
  notice.hidden = !lines.length;
}

const shortUrl = (url) => url.replace(/^(https?:\/\/)?(www\.)?github\.com\//, '').replace(/\/$/, '');

function loadRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY));
    if (!Array.isArray(list)) return [];
    return list.map((e) => (typeof e === 'string' ? { a: e } : e)).filter((e) => e && typeof e.a === 'string');
  } catch {
    return [];
  }
}

function remember(entry) {
  const same = (e) => e.a === entry.a && (e.b || '') === (entry.b || '');
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([entry, ...loadRecent().filter((e) => !same(e))].slice(0, 8)));
  } catch {
    // private windows can refuse storage; recents are only a convenience
  }
  renderRecent();
}

function renderRecent() {
  const list = loadRecent();
  const box = $('#recent');
  box.replaceChildren(...list.map((entry) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = entry.b ? 'chip pair' : 'chip';
    button.textContent = entry.b ? `${shortUrl(entry.a)}  vs  ${shortUrl(entry.b)}` : shortUrl(entry.a);
    button.addEventListener('click', () => {
      $('#repo-url').value = entry.a;
      $('#repo-url-b').value = entry.b || '';
      updateGoButton();
      $('#repo-form').requestSubmit();
    });
    return button;
  }));
  box.hidden = !list.length;
}

function updateGoButton() {
  $('#go').textContent = $('#repo-url-b').value.trim() ? 'Battle' : 'Drop it';
}

function fail(err) {
  world = null;
  music.stop();
  showScreen('intro');
  showError(err.message || String(err));
}

// ---------------------------------------------------------------------------
// Panels, idling and keys

const PANELS = { about: ['#about-panel', '#about'], mixer: ['#mixer', '#mixer-toggle'] };

function togglePanel(which) {
  const [panel, button] = PANELS[which];
  const opening = $(panel).hidden;
  closePanels();
  if (opening) {
    $(panel).hidden = false;
    $(button).setAttribute('aria-expanded', 'true');
    syncMixer();
  }
  wake();
}

function closePanels() {
  for (const [panel, button] of Object.values(PANELS)) {
    $(panel).hidden = true;
    $(button).setAttribute('aria-expanded', 'false');
  }
}

function wake() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const open = Object.values(PANELS).some(([panel]) => !$(panel).hidden);
    if (world && !open) document.body.classList.add('idle');
  }, 3500);
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen().catch(() => {});
}

function toggleSound() {
  music.setMuted(!music.muted);
  const button = $('#sound');
  button.setAttribute('aria-pressed', String(!music.muted));
  button.classList.toggle('muted', music.muted);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Wiring

$('#repo-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const urls = [$('#repo-url').value.trim(), $('#repo-url-b').value.trim()].filter(Boolean);
  if (!urls.length) return;
  music.unlock();  // this click is what allows the page to make sound
  showError('');
  $('#step').textContent = 'Getting ready';
  $('#log').textContent = '';
  showScreen('progress');
  try {
    const refresh = $('#refresh').checked;
    const jobs = await Promise.all(urls.map((url) => postJSON('/api/build', { url, refresh })));
    const scenes = await waitForJobs(jobs.map((j) => j.job), urls.map(shortUrl));
    remember(urls[1] ? { a: urls[0], b: urls[1] } : { a: urls[0] });
    await begin(scenes);
  } catch (err) {
    fail(err);
  }
});
$('#repo-url-b').addEventListener('input', updateGoButton);

$('#sound').addEventListener('click', toggleSound);
$('#volume').addEventListener('input', (e) => music.setVolume(Number(e.target.value)));
$('#fullscreen').addEventListener('click', toggleFullscreen);
$('#drop').addEventListener('click', dropNow);
$('#again').addEventListener('click', leave);
$('#about').addEventListener('click', () => togglePanel('about'));
$('#mixer-toggle').addEventListener('click', () => togglePanel('mixer'));

for (const type of ['pointermove', 'pointerdown', 'keydown', 'touchstart']) {
  window.addEventListener(type, wake, { passive: true });
}
window.addEventListener('pointerdown', () => music.unlock());
window.addEventListener('keydown', (e) => {
  if (!world || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Escape') closePanels();
  if (e.target instanceof HTMLInputElement && e.target.type === 'text') return;
  const key = e.key.toLowerCase();
  if (key === 'f') toggleFullscreen();
  if (key === 'm') toggleSound();
  if (key === 'x') togglePanel('mixer');
  if (key === 'd') dropNow();
});
window.addEventListener('resize', resize);

resize();
buildMixer();
requestAnimationFrame(frame);
renderRecent();
updateGoButton();
checkHealth();
