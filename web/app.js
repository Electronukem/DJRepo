// The light show: lays out graphify's graph with d3-force, then throws it around in time with
// the set. The camera punches in on every kick, pushes in through each build-up, smash-cuts out
// on the drop, and swaps close-ups and wide shots bar by bar. Commits drop on the bar as riffs,
// and light travelling along the graph's edges plays the lead. Shares the page's global scope
// with genres.js (GENRES, genreColour, genreSwatch) and dj.js (DJ, CHANNELS, LEADS, SECTIONS,
// deriveSet, defaultMix, clamp, hashString, ...), so top-level names here must not repeat those.

'use strict';

const $ = (sel) => document.querySelector(sel);
const TAU = Math.PI * 2;
const GOLDEN = 137.50776;
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const RECENT_KEY = 'djrepo.recent';
const SETTINGS_KEY = 'djrepo.settings';
const RTF = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const STAR_COUNT = 240;
const IDLE_POSITION = {
  section: 'intro', progress: 0, barF: 0, bar: 0, beats: 0, beatInBar: 0, phraseBar: 0, bars: 8,
  energy: 0.35, barsLeft: 8, next: 'groove',
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
// The show

class Show {
  constructor(scene, set) {
    this.scene = scene;
    this.set = set;
    this.repoGenre = deriveSet(scene).genre;  // what the repository picks, whatever is playing
    this.hueBase = hashString(`${scene.repo.owner}/${scene.repo.name}`) % 360;
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
    this.waves = [];
    this.pulses = [];
    this.labels = [];
    this.slots = new Set();
    this.focusNodes = null;
    this.commitIndex = 0;
    this.nextBeat = 0;
    this.tunnel = 0;
    this.dark = 0;
    this.env = { kick: 0, snare: 0, impact: 0 };
    this.stars = makeStars(STAR_COUNT);
    this.cam = { x: 0, y: 0, scale: 1, push: 0.55, zoom: 1, angle: 0, tilt: 0, sx: 0, sy: 0, focusMix: 0, fit: null };
    this.frames = 0;
    this.lastT = music.now();
    this.pos = music.position(music.now()) || IDLE_POSITION;
    // The first riff is scheduled before the first frame, and it needs screen positions.
    this.updateCamera(music.now(), 0, this.pos);
    this.project();
  }

  applyPalette(genre) {
    this.genre = genre;
    this.palette = paletteFor(this.scene, genre, this.hueBase);
    this.sprites = this.palette.map(glowSprite);
    this.hue = genre.bg;
  }

  // Recolour in place, crossfading from the old colours.
  setSet(set) {
    this.set = set;
    this.oldSprites = this.sprites;
    this.fadeFrom = music.now();
    this.applyPalette(GENRES[set.genre]);
    this.nextBeat = 0;
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

  frame(t, dt) {
    this.frames++;
    const pos = music.position(t) || IDLE_POSITION;
    this.pos = pos;
    this.react(t, pos);
    this.moveAnchors(t);
    if (this.nodes.length < 1200 || this.frames % 2 === 0) this.sim.tick();
    this.updateCamera(t, dt, pos);
    this.project();
    this.ambient(t, pos);
    this.updatePulses(t);
    this.updateGlow(t);
    this.drawStars(dt, pos);
    this.drawSpectrum();
    this.drawLasers(pos);
    this.draw(t, pos);
    this.drawWaves(t);
    this.drawOverlay(dt, pos);
    updateHud(pos);
  }

  // How hard the music is hitting right now: each envelope jumps on a hit and dies away.
  envelopes(t) {
    const beat = music.beat || 0.5;
    const k = music.lastHit(['kick'], t);
    const c = music.lastHit(['clap', 'roll'], t);
    const i = music.lastHit(['impact'], t);
    return {
      kick: k ? k.v * Math.exp(-(t - k.t) / (beat * 0.22)) : 0,
      snare: c ? c.v * Math.exp(-(t - c.t) / (beat * 0.12)) : 0,
      impact: i && t - i.t < 3 ? Math.exp(-(t - i.t) / 0.45) : 0,
    };
  }

  // Hits that have just sounded leave shockwaves behind.
  react(t, pos) {
    this.env = this.envelopes(t);
    for (const h of music.hitsBetween(this.lastT, t)) {
      if (h.type === 'kick' && (pos.section === 'drop' || pos.section === 'groove')) {
        this.waves.push({ kind: 'kick', at: h.t, v: h.v * (pos.section === 'drop' ? 1 : 0.5), c: this.colourAt(pos.beats) });
      } else if (h.type === 'roll') {
        this.waves.push({ kind: 'tunnel', at: h.t, v: h.v, c: this.tunnel++ % this.palette.length });
      } else if (h.type === 'impact') {
        this.waves.push({ kind: 'impact', at: h.t, v: 1, c: 0 });
      }
    }
    if (this.waves.length > 40) this.waves.splice(0, this.waves.length - 40);
    this.lastT = t;
  }

  colourAt(beats) {
    return ((Math.floor(beats) % this.palette.length) + this.palette.length) % this.palette.length;
  }

  updateCamera(t, dt, pos) {
    const cam = this.cam;
    if (!cam.fit || this.frames % 12 === 0) {
      let cx = 0;
      let cy = 0;
      for (const n of this.nodes) {
        cx += n.x;
        cy += n.y;
      }
      cx /= this.nodes.length;
      cy /= this.nodes.length;
      const dist = this.nodes.map((n) => Math.hypot(n.x - cx, n.y - cy)).sort((a, b) => a - b);
      const r = Math.max(40, dist[Math.floor(dist.length * 0.94)] || 0);
      const first = !cam.fit;
      cam.fit = { x: cx, y: cy, scale: (Math.min(view.w, view.h) * 0.44) / r };
      if (first) Object.assign(cam, { x: cx, y: cy, scale: cam.fit.scale });
    }
    const I = settings.intensity * (REDUCED ? 0.3 : 1);
    const { section, progress } = pos;
    const env = this.env;
    const gap = isGap(pos);

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
    cam.push += (push - cam.push) * (1 - Math.exp(-dt * rate));

    // In a drop's close-ups, and while the groove plays, look at the code the latest commit touched.
    const centre = this.focusNodes ? centroid(this.focusNodes) : null;
    const wantFocus = centre && ((section === 'drop' && pos.phraseBar % 2 === 1) || section === 'groove');
    const mixTarget = wantFocus ? (section === 'drop' ? 0.75 : 0.35) : 0;
    cam.focusMix += (mixTarget - cam.focusMix) * (1 - Math.exp(-dt * 4));
    const tx = cam.fit.x + ((centre ? centre.x : cam.fit.x) - cam.fit.x) * cam.focusMix;
    const ty = cam.fit.y + ((centre ? centre.y : cam.fit.y) - cam.fit.y) * cam.focusMix;
    const follow = 1 - Math.exp(-dt * 5);
    cam.x += (tx - cam.x) * follow;
    cam.y += (ty - cam.y) * follow;
    cam.scale += (cam.fit.scale - cam.scale) * (1 - Math.exp(-dt * 0.6));

    // Every kick punches in; the impact at the top of a drop punches hardest.
    const punchAmount = { intro: 0.05, groove: 0.1, build: 0.06 + 0.12 * progress, drop: 0.24, break: 0.02 }[section];
    const punch = 1 + I * (punchAmount * env.kick + (section === 'build' ? 0.07 : 0.03) * env.snare + 0.4 * env.impact);

    // A slow spin that winds up through a build-up, and a twist on every beat of a drop.
    const spin = REDUCED ? 0.01 : { intro: 0.03, groove: 0.05, build: 0.05 + 1.4 * progress ** 3 * I, drop: 0.08, break: 0.02 }[section];
    cam.angle += spin * dt;
    const side = Math.floor(pos.beats) % 2 ? 1 : -1;
    cam.tilt = REDUCED ? 0 : I * (section === 'drop' ? 0.06 : 0.015) * env.kick * side;

    const shake = REDUCED ? 0 : I * ((section === 'drop' ? 10 : 2) * env.kick + 28 * env.impact
      + (section === 'build' ? 4 * progress * env.snare : 0));
    cam.sx = shake * Math.sin(t * 97.3);
    cam.sy = shake * Math.cos(t * 83.1);
    cam.zoom = cam.scale * cam.push * punch;
  }

  project() {
    const { x: cx, y: cy, angle, tilt, zoom, sx, sy } = this.cam;
    const cos = Math.cos(angle + tilt) * zoom;
    const sin = Math.sin(angle + tilt) * zoom;
    const ox = view.w / 2 + sx;
    const oy = view.h / 2 + sy;
    for (const n of this.nodes) {
      const dx = n.x - cx;
      const dy = n.y - cy;
      n.sx = ox + dx * cos - dy * sin;
      n.sy = oy + dx * sin + dy * cos;
    }
  }

  // ---- events ----

  onBar(bar, t, info) {
    this.hue = (this.genre.bg + info.chord.degree * 22) % 360;
    const { section, phraseBar } = info;
    // A riff per bar in a drop, every other bar elsewhere, and only one as a build-up starts.
    if (section === 'build' ? phraseBar !== 0 : phraseBar % (section === 'drop' ? 1 : 2) !== 0) return;
    const commits = this.scene.commits;
    if (!commits.length) {
      this.playHubs(bar, t, section);
      return;
    }
    const number = (this.commitIndex % commits.length) + 1;
    this.commitIndex++;
    this.playCommit(commits[number - 1], bar, t, number, section);
  }

  // A commit drops: the code it touched fires as a riff on the bar, then ripples outward.
  playCommit(commit, bar, t, number, section) {
    const quiet = !commit.n.length;  // eg docs-only changes graphify doesn't map
    const touched = quiet ? [this.randomNode(), this.randomNode(), this.randomNode()] : commit.n.map((i) => this.nodes[i]);
    const rhythm = section === 'drop' ? this.genre.hook : section === 'break' ? [0, 6, 12] : [0, 4, 8, 12];
    const phrase = [...new Set(touched)].sort((a, b) => a.sx - b.sx).slice(0, rhythm.length);
    const intensity = Math.min(1, commit.f / 12);
    const velocity = { drop: 0.85, groove: 0.6, build: 0.6, intro: 0.5, break: 0.45 }[section];
    const hold = music.barLen * (section === 'drop' ? 1.4 : 2.4);
    phrase.forEach((n, k) => {
      const at = music.stepTime(bar * 16 + rhythm[k]);
      this.claimSlot(at);
      this.sound(n, at, (quiet ? 0.6 : 1) * velocity * (0.85 + 0.15 * intensity));
      this.flash(n, at, 1, 1.4);
      if (!quiet) {
        this.rings.push({ node: n, at });
        if (k < 4) this.labels.push({ node: n, at, until: at + hold });
      }
      this.emit(n, at + music.sixteenth * 2, section === 'drop' ? 2 : 1, true, 0);
    });
    if (!quiet) this.focusNodes = phrase;
    this.later(t, () => showCommitCaption(commit, number, this.scene.commits.length, section));
  }

  playHubs(bar, t, section) {
    const hubs = this.nodes.slice(0, 4).sort((a, b) => a.sx - b.sx);
    hubs.forEach((n, k) => {
      const at = music.stepTime(bar * 16 + k * 4);
      this.claimSlot(at);
      this.sound(n, at, section === 'drop' ? 0.75 : 0.5);
      this.flash(n, at, 1, 1.4);
      this.emit(n, at + music.sixteenth * 2, 2, true, 0);
    });
    this.focusNodes = hubs;
  }

  later(t, fn) {
    setTimeout(() => {
      if (world === this) fn();
    }, Math.max(0, (t - music.now()) * 1000));
  }

  // On some beats, light leaps from one node to a neighbour; more often the harder the set is hitting.
  ambient(t, pos) {
    if (t < this.nextBeat) return;
    const first = this.nextBeat === 0;
    this.nextBeat = music.quantize(t + 0.01, 1);
    if (first || Math.random() > this.set.density * (0.3 + 0.7 * pos.energy)) return;
    const n = this.randomNode();
    this.flash(n, t, 0.45, 1);
    this.emit(n, t, pos.section === 'drop' ? 2 : 1, Math.random() < 0.7, 0);
  }

  // Send light along `count` edges from a node. Arrivals land on the sixteenth-note grid,
  // so a sounding pulse plays exactly as it reaches its node.
  emit(from, at, count, sounding, hops) {
    const neighbours = this.adj[from.i];
    if (!neighbours.length || this.pulses.length > 110) return;
    for (let k = 0; k < count; k++) {
      const to = this.nodes[neighbours[(Math.random() * neighbours.length) | 0]];
      const end = music.quantize(at + music.beat * (0.5 + Math.random()), 0.25);
      const pulse = { from, to, start: at, end, hops, sounding: false, arrived: false };
      if (sounding && this.claimSlot(end)) {
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

  // At most one lead note per sixteenth keeps the riffs readable.
  claimSlot(t) {
    const key = Math.round((t - music.start) / music.sixteenth);
    if (this.slots.has(key)) return false;
    this.slots.add(key);
    if (this.slots.size > 256) {
      const past = Math.round((music.now() - music.start) / music.sixteenth);
      for (const s of this.slots) if (s < past) this.slots.delete(s);
    }
    return true;
  }

  // What the node looks like right now decides what it sounds like.
  sound(node, at, velocity) {
    const height = 1 - clamp(node.sy / view.h, 0, 1);
    const pan = clamp((node.sx / view.w) * 2 - 1, -1, 1) * 0.7;
    const midi = music.pitch(this.palette[node.c].tone, height, node.weight, at);
    music.lead(midi, at, velocity, pan);
  }

  flash(node, at, strength, duration) {
    this.flashes.push({ node, at, strength, duration });
  }

  updateGlow(t) {
    const burst = this.env.impact * 0.9;  // the whole graph lights up when the drop lands
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

  // ---- drawing ----

  // Stars rushing past: a gentle drift in a breakdown, warp speed into a drop.
  drawStars(dt, pos) {
    const I = settings.intensity;
    const { section, progress } = pos;
    let speed = { intro: 0.12, groove: 0.25, build: 0.25 + 2.6 * progress * progress, drop: 0.5 + 2 * this.env.kick, break: 0.07 }[section];
    if (isGap(pos)) speed = 3.4;
    speed *= (REDUCED ? 0.25 : 1) * (0.35 + 0.65 * I);
    const { w, h } = view;
    const cx = w / 2 + this.cam.sx;
    const cy = h / 2 + this.cam.sy;
    const f = Math.max(w, h) * 0.5;
    const trail = Math.min(0.35, 0.01 + speed * 0.07);
    const cos = Math.cos(this.cam.angle * 0.5);
    const sin = Math.sin(this.cam.angle * 0.5);
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
      g2.strokeStyle = this.palette[s.c % this.palette.length].star;
      g2.lineWidth = 0.6 + near * 2.2;
      g2.beginPath();
      g2.moveTo(x0, y0);
      g2.lineTo(x1, y1);
      g2.stroke();
    }
  }

  // Laser beams fan up from the floor in a drop, and start to creep in through a build-up.
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
    g2.globalCompositeOperation = 'lighter';
    [[w * 0.08, h + 10, 1], [w * 0.92, h + 10, -1]].forEach(([ox, oy, side], o) => {
      for (let k = 0; k < 5; k++) {
        const sweep = Math.sin((pos.beats * Math.PI) / 4 + k * 0.8 + o * 1.7);  // one sweep every eight beats
        const angle = -Math.PI / 2 + side * (0.22 + k * 0.17 + sweep * 0.32);
        const ex = ox + Math.cos(angle) * len;
        const ey = oy + Math.sin(angle) * len;
        g2.strokeStyle = this.palette[(k + o * 2) % this.palette.length].css;
        g2.beginPath();
        g2.moveTo(ox, oy);
        g2.lineTo(ex, ey);
        g2.globalAlpha = 0.07 * strength;
        g2.lineWidth = 12;
        g2.stroke();
        g2.globalAlpha = 0.5 * strength;
        g2.lineWidth = 1.4;
        g2.stroke();
      }
    });
  }

  draw(t, pos) {
    const beatGlow = this.env.kick * (0.35 + 0.65 * pos.energy);
    g2.globalCompositeOperation = 'lighter';

    g2.lineWidth = 0.7 + 0.9 * beatGlow;
    g2.globalAlpha = Math.min(1, 0.4 + 0.6 * beatGlow + this.env.impact);
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
      const fade = t > p.end ? 1 - (t - p.end) / 0.4 : 1;
      const sprite = this.sprites[p.from.c];
      for (let k = 0; k < 5; k++) {  // a comet tail
        const v = Math.max(0, e - k * 0.04);
        const x = p.from.sx + (p.to.sx - p.from.sx) * v;
        const y = p.from.sy + (p.to.sy - p.from.sy) * v;
        const size = (p.sounding ? 11 : 7) * (1 - k * 0.17);
        g2.globalAlpha = fade * (1 - k * 0.2) * (p.sounding ? 1 : 0.6);
        g2.drawImage(sprite, x - size, y - size, size * 2, size * 2);
      }
    }

    // While the genre changes, each node is drawn in both its old and new colour.
    const mix = this.oldSprites ? clamp((t - this.fadeFrom) / 1.5, 0, 1) : 1;
    if (mix >= 1) this.oldSprites = null;
    const zoom = this.cam.zoom;
    const swell = 1 + 0.5 * beatGlow + 0.6 * this.env.impact;
    for (const n of this.nodes) {
      const core = Math.max(1.2, n.r * zoom * 0.85);
      const size = core * (3.6 + n.glow * 7) * swell;
      const alpha = Math.min(1, 0.5 + 0.1 * Math.sin(t * 2 + n.twinkle) + n.glow * 0.6 + 0.25 * beatGlow);
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
      g2.globalAlpha = (1 - u) * 0.8;
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
      const alpha = 0.92 * Math.min(1, age / 0.08, (label.until - t) / 0.6);
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

  // Shockwaves from the kick, hexagons flying past in a snare roll, and a blast when the drop lands.
  drawWaves(t) {
    const { w, h } = view;
    const cx = w / 2 + this.cam.sx;
    const cy = h / 2 + this.cam.sy;
    const reach = Math.hypot(w, h) / 2;
    const I = settings.intensity;
    g2.globalCompositeOperation = 'lighter';
    this.waves = this.waves.filter((wave) => {
      const life = { kick: 0.55, tunnel: 0.75, impact: 1.5 }[wave.kind];
      const age = t - wave.at;
      if (age > life) return false;
      if (age < 0) return true;
      const u = age / life;
      g2.strokeStyle = this.palette[wave.c % this.palette.length].ring;
      g2.beginPath();
      if (wave.kind === 'tunnel') {
        const r = reach * 1.3 * u * u;
        const spin = this.cam.angle * 2 + wave.c * 0.3;
        for (let k = 0; k <= 6; k++) {
          const a = spin + (k * TAU) / 6;
          if (k) g2.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
          else g2.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
        }
        g2.globalAlpha = (1 - u) * 0.55 * wave.v * I;
        g2.lineWidth = 1 + 6 * u;
      } else if (wave.kind === 'impact') {
        g2.arc(cx, cy, 20 + Math.sqrt(u) * reach * 1.5, 0, TAU);
        g2.globalAlpha = (1 - u) * 0.9 * I;
        g2.lineWidth = 2 + 14 * (1 - u);
        g2.strokeStyle = '#ffffff';
      } else {
        g2.arc(cx, cy, 30 + u * reach * 0.95, 0, TAU);
        g2.globalAlpha = (1 - u) * 0.35 * wave.v * I;
        g2.lineWidth = 0.5 + 3 * (1 - u);
      }
      g2.stroke();
      return true;
    });
    g2.globalAlpha = 1;
  }

  // The mix, as a mirrored equaliser along the bottom edge, behind the graph.
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
      g2.fillStyle = this.palette[k % this.palette.length].css;
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
        g2.fillStyle = this.palette[this.colourAt(pos.beats)].css;
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
  return Array.from({ length: count }, () => resetStar({ c: (Math.random() * 18) | 0 }, Math.random()));
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
  if (world) world.cam.fit = null;
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
// The HUD: what section it is, the beat, and how long until the next one

function updateHud(pos) {
  const label = SECTIONS[pos.section].label;
  if (hud.section !== label) {
    hud.section = label;
    $('#section').textContent = label;
    document.body.dataset.section = pos.section;
  }
  const beat = Math.max(0, Math.floor(pos.beatInBar)) % 4;
  if (hud.beat !== beat) {
    hud.beat = beat;
    document.querySelectorAll('#beats span').forEach((dot, k) => dot.classList.toggle('on', k === beat));
  }
  $('#phrase-fill').style.transform = `scaleX(${pos.progress.toFixed(3)})`;
  const bars = pos.barsLeft;
  const next = pos.section === 'build' ? 'Drop' : SECTIONS[pos.next].label;
  const soon = pos.section === 'build' && bars <= 1 ? 'Drop incoming' : `${next} in ${bars} bar${bars === 1 ? '' : 's'}`;
  if (hud.soon !== soon) {
    hud.soon = soon;
    $('#countdown').textContent = soon;
  }
}

// ---------------------------------------------------------------------------
// Settings: the genre, the lead, the mix and the visuals, remembered in this browser

function loadSettings() {
  const fallback = { genre: 'repo', lead: 'auto', mix: {}, intensity: 0.85, flashes: !REDUCED };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
    return {
      genre: GENRES[saved.genre] ? saved.genre : 'repo',
      lead: LEADS[saved.lead] ? saved.lead : 'auto',
      mix: saved.mix && typeof saved.mix === 'object' ? saved.mix : {},
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

// The mix to play: the person's own changes on top of what the set suggests.
function mixFor(set) {
  const suggested = defaultMix(set);
  return Object.fromEntries(CHANNELS.map((c) => [c.id, { ...suggested[c.id], ...settings.mix[c.id] }]));
}

// ---------------------------------------------------------------------------
// The mixer panel

function buildMixer() {
  const chip = (label, swatch, onClick) => {
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
  };
  for (const [id, genre] of Object.entries(GENRES)) {
    const button = chip(genre.name, genreSwatch(genre), () => applyGenre(id));
    button.dataset.genre = id;
    $('#genres').append(button);
  }
  for (const id of ['auto', ...Object.keys(LEADS)]) {
    const button = chip(id === 'auto' ? 'From the code' : LEADS[id].name, null, () => applyLead(id));
    button.dataset.lead = id;
    $('#leads').append(button);
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
    if (world) music.setMix(mixFor(world.set));
    syncMixer();
  });
}

function changeChannel(id, patch) {
  music.setChannel(id, { ...music.mix[id], ...patch });
  settings.mix[id] = { ...music.mix[id] };
  saveSettings();
  syncMixer();
}

function applyGenre(id) {
  if (settings.genre === id && world) return;
  settings.genre = id;
  saveSettings();
  if (world) {
    const set = deriveSet(world.scene, id, settings.lead);
    world.setSet(set);
    music.configure(set, mixFor(set), 'drop');  // bring the new genre in with a drop
    showSet(set);
  }
  syncMixer();
}

function applyLead(id) {
  settings.lead = id;
  saveSettings();
  if (world) {
    world.set = deriveSet(world.scene, settings.genre, id);
    music.leadSound = world.set.lead;
    showSet(world.set);
  }
  syncMixer();
}

function describeChannel(id, set) {
  const g = GENRES[set.genre];
  switch (id) {
    case 'kick': return g.drums.kick === 'x---x---x---x---' ? 'four on the floor' : 'two-step: on 1 and the and of 3';
    case 'clap': return `${g.snare ? 'snare' : 'claps'} on 2 and 4, and the roll in build-ups`;
    case 'hats': return 'sixteenths, with open hats on the offbeat';
    case 'perc': return { conga: 'congas', ride: 'ride cymbal', shaker: 'shaker', rim: 'rimshots', ghost: 'ghost snares' }[g.perc];
    case 'bass': return `${{ offbeat: 'offbeat bass', rolling: 'rolling sixteenths', acid: 'acid line', sub: 'sub bass', reese: 'reese bass' }[g.bass.style]}, pumping with the kick`;
    case 'chords': return { stab: 'piano-style stabs', dub: 'dub stabs into the echo', gate: 'gated supersaws', hook: 'supersaw hook', pad: 'held chords' }[g.chords.style];
    case 'pad': return 'swells under the intro, build-ups and breakdowns';
    case 'arp': return 'up and down each chord';
    case 'lead': return `${LEADS[music.leadSound]?.name || 'Pluck'}: plays the stars as light reaches them`;
    default: return 'risers, impacts and crashes';
  }
}

// Reflect the current genre, lead and mix.
function syncMixer() {
  for (const button of document.querySelectorAll('[data-genre]')) {
    button.setAttribute('aria-pressed', String(button.dataset.genre === settings.genre));
    if (button.dataset.genre === 'repo') {
      button.lastChild.textContent = world ? `From your repo · ${GENRES[world.repoGenre].name}` : GENRES.repo.name;
    }
  }
  for (const button of document.querySelectorAll('[data-lead]')) {
    button.setAttribute('aria-pressed', String(button.dataset.lead === settings.lead));
    if (button.dataset.lead === 'auto') {
      button.lastChild.textContent = world ? `From the code · ${LEADS[world.set.codeLead].name}` : 'From the code';
    }
  }
  for (const channel of CHANNELS) {
    const row = document.querySelector(`.inst[data-channel="${channel.id}"]`);
    const state = music.mix[channel.id] || { on: false, level: channel.level };
    row.classList.toggle('off', !state.on);
    row.querySelector('.switch').checked = state.on;
    const level = row.querySelector('input[type=range]');
    if (document.activeElement !== level) level.value = String(state.level);
    row.querySelector('.inst-sub').textContent = world ? describeChannel(channel.id, world.set) : '';
  }
  renderAbout();
}

function renderAbout() {
  if (!world) return;
  const { scene, set } = world;
  const reasons = [...set.reasons];
  reasons.push('The set loops through a groove, a build-up, a drop, a breakdown, another build-up and another drop. '
    + 'Press D to skip to the next drop.');
  reasons.push(scene.commits.length
    ? `Your last ${scene.commits.length} commits drop in order: one per bar in a drop, every other bar elsewhere. `
      + 'The code each one touched fires as a riff, and the camera cuts to it.'
    : 'There are no commits to replay, so the biggest hubs take the riffs.');
  if (scene.trimmed) {
    reasons.push(`Showing the ${scene.nodes.length.toLocaleString()} most connected of ${scene.stats.nodes_total.toLocaleString()} pieces of code, to keep it smooth.`);
  }
  $('#reasons').replaceChildren(...reasons.map((r) => Object.assign(document.createElement('li'), { textContent: r })));
}

// ---------------------------------------------------------------------------
// Captions

function showCommitCaption(commit, number, total, section) {
  const caption = $('#caption');
  caption.classList.add('fading');
  setTimeout(() => {
    $('#caption-tag').textContent = section === 'drop' ? 'Dropping' : 'Now playing';
    $('#caption-msg').textContent = commit.m || '(no message)';
    $('#caption-meta').textContent = [commit.a, relativeTime(commit.t), `${commit.f} file${commit.f === 1 ? '' : 's'}`,
      `${number} of ${total}`].filter(Boolean).join('  ·  ');
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

async function waitForJob(id) {
  for (;;) {
    await sleep(700);
    const poll = await fetch(`/api/job/${id}`);
    if (!poll.ok) throw new Error('Lost track of the work. Is server.py still running?');
    const job = await poll.json();
    $('#step').textContent = job.step;
    $('#log').textContent = job.log.join('\n');
    if (job.state === 'done') return job.result;
    if (job.state === 'error') throw new Error(job.error);
  }
}

async function begin(scene) {
  if (typeof d3 === 'undefined') throw new Error("Couldn't load d3, which lays out the graph. Check your internet connection.");
  $('#step').textContent = 'Setting up the decks';
  $('#log').textContent = '';
  await sleep(50);  // let that message paint before the layout warms up

  const set = deriveSet(scene, settings.genre, settings.lead);
  music.configure(set, mixFor(set));
  world = new Show(scene, set);
  music.onBar = (bar, t, info) => world && world.onBar(bar, t, info);

  const name = $('#repo-name');
  name.replaceChildren(`${scene.repo.owner}/`, document.createElement('wbr'), scene.repo.name);  // wrap after the slash
  name.href = scene.repo.url;
  hud = {};
  showSet(set);
  $('#caption').classList.add('fading');
  showScreen('hud');
  wake();
}

function showSet(set) {
  $('#mood').textContent = set.label;
  syncMixer();
}

function leave() {
  music.stop();
  music.onBar = null;
  world = null;
  closePanels();
  delete document.body.dataset.section;
  showScreen('intro');
}

function dropNow() {
  if (!world) return;
  const button = $('#drop');
  const ok = music.requestDrop();
  button.classList.toggle('armed', ok);
  $('#countdown').textContent = ok ? 'Build-up from the next bar' : 'A drop is already on its way';
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
  if (health.offline) lines.push(["Can't reach the DJRepo server. Start it with ", code('python server.py'), '.']);
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

function loadRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY));
    return Array.isArray(list) ? list.filter((u) => typeof u === 'string') : [];
  } catch {
    return [];
  }
}

function remember(url) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([url, ...loadRecent().filter((u) => u !== url)].slice(0, 6)));
  } catch {
    // private windows can refuse storage; recents are only a convenience
  }
  renderRecent();
}

function renderRecent() {
  const list = loadRecent();
  const box = $('#recent');
  box.replaceChildren(...list.map((url) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = url.replace(/^(https?:\/\/)?(www\.)?github\.com\//, '');
    chip.addEventListener('click', () => {
      $('#repo-url').value = url;
      $('#repo-form').requestSubmit();
    });
    return chip;
  }));
  box.hidden = !list.length;
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
  const url = $('#repo-url').value.trim();
  if (!url) return;
  music.unlock();  // this click is what allows the page to make sound
  showError('');
  $('#step').textContent = 'Getting ready';
  $('#log').textContent = '';
  showScreen('progress');
  try {
    const { job } = await postJSON('/api/build', { url, refresh: $('#refresh').checked });
    const scene = await waitForJob(job);
    remember(url);
    await begin(scene);
  } catch (err) {
    fail(err);
  }
});

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
checkHealth();
