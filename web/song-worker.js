// Listens to a song: finds its tempo and beats, where its bars start, its key, and its shape, and
// turns it into a graph the light show can draw. It runs in a Web Worker, so a song added mid-set
// never stalls the music. The song never leaves the browser.
//
// In:  { samples: Float32Array (mono), rate }
// Out: { ok, analysis } or { ok: false, error }. See analyse() for the analysis.

'use strict';

const MAX_BEATS = 900;  // one star per beat, as many as a battle shows of a repo

self.onmessage = ({ data }) => {
  try {
    self.postMessage({ ok: true, analysis: analyse(data.samples, data.rate) });
  } catch (err) {
    self.postMessage({ ok: false, error: String((err && err.message) || err) });
  }
};

function analyse(x, rate) {
  const duration = x.length / rate;
  const onset = onsets(x, rate);
  // The beat grid from each onset envelope; keep the one the music supports most strongly.
  const grids = onset.envs.map((env) => {
    try {
      return findBeat({ env, fps: onset.fps });
    } catch {
      return null;
    }
  }).filter(Boolean);
  if (!grids.length) throw new Error('no steady beat');
  const grid = grids.reduce((a, b) => (b.confidence > a.confidence ? b : a));
  const beatLen = grid.period / onset.fps;
  const firstBeat = grid.phase / onset.fps + onset.delay;

  // What each beat sounds like, from the first beat to the end.
  const beats = [];
  for (let t = firstBeat; t + beatLen <= duration; t += beatLen) beats.push(t);
  const feats = beatFeatures(x, rate, beats, beatLen);

  // Bars start where the harmony changes most.
  const down = downbeat(feats);
  const barLen = beatLen * 4;
  let first = beats[down] ?? firstBeat;
  first -= Math.floor(first / barLen) * barLen;
  const skip = Math.round((first - firstBeat) / beatLen);  // beats before the first downbeat we keep
  const bars = Math.min(Math.floor((duration - first) / barLen), Math.floor(MAX_BEATS / 4));
  if (bars < 8) throw new Error('not enough of a steady beat');

  // Per-beat features, lined up with the bars.
  const n = bars * 4;
  const at = (i) => feats[Math.min(feats.length - 1, Math.max(0, i + skip))];
  const rows = Array.from({ length: n }, (_, i) => at(i));

  const key = findKey(rows);
  const clusters = cluster(rows);
  const links = linkRepeats(rows);
  const loud = normalise(rows.map((r) => r.rms));
  const lows = normalise(rows.map((r) => r.low));
  const highs = normalise(rows.map((r) => r.high));

  return {
    duration,
    bpm: 60 / beatLen,
    beatLen,
    barLen,
    first,
    bars,
    startBar: loudestStretch(loud.map((v, i) => 0.6 * v + 0.4 * highs[i]), bars),
    key: key.key,
    mode: key.mode,
    confidence: grid.confidence,
    clusters: clusters.k,
    nodes: rows.map((r, i) => ({ t: first + i * beatLen, c: clusters.of[i], e: loud[i], low: lows[i], high: highs[i] })),
    links,
  };
}

// ---------------------------------------------------------------------------
// The spectrum

function fftPlan(n) {
  const levels = Math.round(Math.log2(n));
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r = (r << 1) | ((i >>> b) & 1);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  const win = new Float64Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return { n, rev, cos, sin, win, re: new Float64Array(n), im: new Float64Array(n) };
}

// The magnitude spectrum of the windowed frame of x starting at `start`, into `mag` (n/2 bins).
function spectrum(plan, x, start, mag) {
  const { n, rev, cos, sin, win, re, im } = plan;
  for (let i = 0; i < n; i++) {
    re[rev[i]] = (x[start + i] || 0) * win[i];
    im[rev[i]] = 0;
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const a = i + j;
        const b = a + half;
        const tr = re[b] * cos[k] + im[b] * sin[k];
        const ti = im[b] * cos[k] - re[b] * sin[k];
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
  for (let k = 0; k < n / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
}

// ---------------------------------------------------------------------------
// The beat

// How much new sound starts in each short frame (spectral flux), with the steady level taken out.
function onsets(x, rate) {
  const n = 512;
  const hop = 128;
  const plan = fftPlan(n);
  const frames = Math.max(0, Math.floor((x.length - n) / hop));
  const mag = new Float64Array(n / 2);
  const prev = new Float64Array(n / 2);
  // The kick is what dance music hangs on, but it lives in a handful of low bins while a snare or a
  // hat (and every echo of them) lights up hundreds. One envelope weights the lows so the kick counts
  // as much as everything else; the other only nudges them, for music whose kick isn't on the beat
  // (two-step drum & bass). findBeat tries both.
  const lowTop = Math.round(200 / (rate / n));
  const weights = [(n / 2 - lowTop) / lowTop, (n / 2 - lowTop) / lowTop / 8];
  const raw = weights.map(() => new Float64Array(frames));
  for (let f = 0; f < frames; f++) {
    spectrum(plan, x, f * hop, mag);
    for (let k = 1; k < n / 2; k++) {
      const v = Math.log1p(100 * mag[k]);
      const d = v - prev[k];
      prev[k] = v;
      if (d > 0) weights.forEach((w, j) => { raw[j][f] += k <= lowTop ? d * w : d; });
    }
  }
  const fps = rate / hop;
  return { envs: raw.map((env) => steady(env, fps)), fps, delay: n / 2 / rate };
}

// Onset strength with the steady level taken out, scaled to the strong hits (not the single loudest).
function steady(env, fps) {
  const frames = env.length;
  const w = Math.round(fps * 0.25);
  const sums = new Float64Array(frames + 1);
  for (let i = 0; i < frames; i++) sums[i + 1] = sums[i] + env[i];
  const out = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    const lo = Math.max(0, i - w);
    const hi = Math.min(frames, i + w + 1);
    out[i] = Math.max(0, env[i] - (sums[hi] - sums[lo]) / (hi - lo));
  }
  const top = Float64Array.from(out).sort()[Math.floor(frames * 0.98)] || 1;
  for (let i = 0; i < frames; i++) out[i] = Math.min(1, out[i] / top);
  return out;
}

// The onset strength between frames, for fractional positions.
function sample(env, p) {
  const i = Math.floor(p);
  if (i < 0 || i + 1 >= env.length) return 0;
  const u = p - i;
  return env[i] * (1 - u) + env[i + 1] * u;
}

// The beat period and phase (in frames): autocorrelation for a first guess, a fine comb search
// around it, then a least-squares fit to the onsets across the whole song, so the grid doesn't
// drift by the end.
function findBeat(o) {
  const { env, fps } = o;
  const minLag = Math.floor((fps * 60) / 190);
  const maxLag = Math.ceil((fps * 60) / 68);
  const ac = new Float64Array(maxLag * 2 + 3);
  for (let lag = minLag - 1; lag < ac.length; lag++) {
    let s = 0;
    for (let i = 0; i + lag < env.length; i++) s += env[i] * env[i + lag];
    ac[lag] = s / Math.max(1, env.length - lag);
  }
  let best = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * fps) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 126) / 0.85) ** 2);  // dance music sits near 126
    const score = (ac[lag] + 0.5 * ac[2 * lag]) * prior;
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  let period = best + parabola(ac[best - 1], ac[best], ac[best + 1]);

  // The period and phase whose beats land on the most onset.
  const comb = (p) => {
    let bestPhase = 0;
    let top = -Infinity;
    for (let phase = 0; phase < p; phase += 0.5) {
      let s = 0;
      for (let t = phase; t < env.length; t += p) s += sample(env, t);
      if (s > top) {
        top = s;
        bestPhase = phase;
      }
    }
    return { phase: bestPhase, score: top };
  };

  // Echoes and syncopation make related tempos look strong too: a dotted-eighth delay reads as
  // 4/3 of the beat, half-time drum & bass as half of it. The real beat is the grid where the hits
  // land hardest on average, so a relative that's clearly stronger wins.
  const bpmOf = (p) => (60 * fps) / p;
  const prior = (p) => Math.exp(-0.5 * (Math.log2(bpmOf(p) / 126) / 0.85) ** 2);
  const strength = (p) => (comb(p).score / (env.length / p)) * prior(p);
  let top = strength(period);
  for (const f of [3 / 4, 4 / 3, 1 / 2, 2, 2 / 3, 3 / 2]) {
    const p = period * f;
    if (bpmOf(p) < 68 || bpmOf(p) > 190) continue;
    const s = strength(p);
    if (s > top * 1.15) {  // only when clearly stronger: the autocorrelation is usually right
      top = s;
      period = p;
    }
  }
  // Half-time drum & bass that still reads as ~87: take the double if the half lag is strong too.
  if (bpmOf(period) < 96 && ac[Math.round(period / 2)] > 0.45 * ac[Math.round(period)]) period /= 2;
  let fine = { period, ...comb(period) };
  for (let k = -40; k <= 40; k++) {
    const p = period * (1 + k * 0.0005);
    const c = comb(p);
    if (c.score > fine.score) fine = { period: p, ...c };
  }
  ({ period } = fine);
  let { phase } = fine;

  // Least squares on the onset peaks nearest each beat, over more and more of the song.
  const total = Math.floor((env.length - phase) / period);
  for (let upto = 32; ; upto *= 2) {
    const fit = fitGrid(env, period, phase, Math.min(upto, total));
    if (fit) ({ period, phase } = fit);
    if (upto >= total) break;
  }
  for (let pass = 0; pass < 2; pass++) {
    const fit = fitGrid(env, period, phase, total);
    if (fit) ({ period, phase } = fit);
  }
  phase = ((phase % period) + period) % period;

  // How sure: onset on the beats against onset everywhere.
  let on = 0;
  let count = 0;
  for (let t = phase; t < env.length; t += period, count++) on += sample(env, t);
  let mean = 0;
  for (let i = 0; i < env.length; i++) mean += env[i];
  mean /= Math.max(1, env.length);
  const confidence = count ? on / count / Math.max(1e-6, mean) : 0;
  if (confidence < 1.4) throw new Error('no steady beat');
  return { period, phase, confidence };
}

function fitGrid(env, period, phase, beats) {
  const radius = Math.max(2, Math.round(period * 0.15));
  let sw = 0;
  let sk = 0;
  let st = 0;
  let skk = 0;
  let skt = 0;
  for (let k = 0; k < beats; k++) {
    const c = Math.round(phase + k * period);
    let m = -1;
    for (let i = Math.max(1, c - radius); i <= Math.min(env.length - 2, c + radius); i++) {
      if (m < 0 || env[i] > env[m]) m = i;
    }
    if (m < 0 || env[m] < 0.08) continue;
    const peak = m + parabola(env[m - 1], env[m], env[m + 1]);
    const w = env[m];
    sw += w;
    sk += w * k;
    st += w * peak;
    skk += w * k * k;
    skt += w * k * peak;
  }
  const det = sw * skk - sk * sk;
  if (sw <= 0 || det <= 1e-9) return null;
  const p = (sw * skt - sk * st) / det;
  if (!(p > period * 0.9 && p < period * 1.1)) return null;
  return { period: p, phase: (st - p * sk) / sw };
}

function parabola(a, b, c) {
  const d = a - 2 * b + c;
  return d ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d)) : 0;
}

// ---------------------------------------------------------------------------
// What each beat sounds like

function beatFeatures(x, rate, beats, beatLen) {
  const n = 2048;
  const hop = 1024;
  const plan = fftPlan(n);
  const mag = new Float64Array(n / 2);
  const binHz = rate / n;
  const pitch = new Int8Array(n / 2).fill(-1);
  for (let k = 1; k < n / 2; k++) {
    const f = k * binHz;
    if (f >= 60 && f <= 4000) pitch[k] = (((Math.round(12 * Math.log2(f / 440)) + 69) % 12) + 12) % 12;
  }
  const lowTop = Math.round(150 / binHz);
  const midTop = Math.round(2000 / binHz);
  return beats.map((t) => {
    const from = Math.floor(t * rate);
    const to = Math.min(x.length, Math.floor((t + beatLen) * rate));
    const chroma = new Float64Array(12);
    let low = 0;
    let mid = 0;
    let high = 0;
    let frames = 0;
    for (let s = from; s + n <= to + n / 2 && s + n <= x.length; s += hop, frames++) {
      spectrum(plan, x, s, mag);
      for (let k = 1; k < n / 2; k++) {
        const e = mag[k] * mag[k];
        if (k < lowTop) low += e;
        else if (k < midTop) mid += e;
        else high += e;
        if (pitch[k] >= 0) chroma[pitch[k]] += mag[k];
      }
    }
    let sq = 0;
    for (let i = from; i < to; i += 4) sq += x[i] * x[i];
    const total = chroma.reduce((a, b) => a + b, 0) || 1;
    const f = Math.max(1, frames);
    return {
      chroma: Array.from(chroma, (v) => v / total),
      low: Math.log1p(low / f),
      mid: Math.log1p(mid / f),
      high: Math.log1p(high / f),
      rms: Math.sqrt(sq / Math.max(1, (to - from) / 4)),
    };
  });
}

// Which of the four beats starts a bar: the one where the harmony changes most. (Not the bass
// energy: a two-step kick on the "and" of three changes it more than any downbeat.)
function downbeat(feats) {
  const score = [0, 0, 0, 0];
  for (let i = 1; i < feats.length; i++) {
    const a = feats[i - 1];
    const b = feats[i];
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let k = 0; k < 12; k++) {
      dot += a.chroma[k] * b.chroma[k];
      na += a.chroma[k] ** 2;
      nb += b.chroma[k] ** 2;
    }
    const change = 1 - dot / Math.sqrt(na * nb || 1);
    score[i % 4] += change;
  }
  return score.indexOf(Math.max(...score));
}

// The key, by matching the song's overall pitch profile to Krumhansl and Kessler's.
function findKey(rows) {
  const major = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const minor = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const total = new Array(12).fill(0);
  for (const r of rows) for (let k = 0; k < 12; k++) total[k] += r.chroma[k];
  let best = { key: 0, mode: 'aeolian', r: -Infinity };
  for (const [profile, mode] of [[major, 'ionian'], [minor, 'aeolian']]) {
    for (let key = 0; key < 12; key++) {
      const r = correlate(total, profile.map((_, i) => profile[(i - key + 12) % 12]));
      if (r > best.r) best = { key, mode, r };
    }
  }
  return best;
}

function correlate(a, b) {
  const ma = a.reduce((s, v) => s + v, 0) / a.length;
  const mb = b.reduce((s, v) => s + v, 0) / b.length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * db || 1);
}

// ---------------------------------------------------------------------------
// The shape of the song

// One vector per beat: its harmony and its timbre, smoothed over a bar so sections hold together.
function vectors(rows) {
  const timbre = ['low', 'mid', 'high', 'rms'].map((key) => standardise(rows.map((r) => r[key])));
  const raw = rows.map((r, i) => [...r.chroma.map((v) => v * 3), ...timbre.map((t) => t[i] * 0.6)]);
  return raw.map((_, i) => {
    const out = new Array(raw[0].length).fill(0);
    let n = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(raw.length - 1, i + 1); j++, n++) {
      for (let d = 0; d < out.length; d++) out[d] += raw[j][d];
    }
    return out.map((v) => v / n);
  });
}

// k-means over the beats; the clusters are numbered in the order they first appear.
function cluster(rows) {
  const v = vectors(rows);
  const k = Math.max(4, Math.min(9, Math.round(rows.length / 64)));
  const rand = mulberry(7);
  const centres = [v[Math.floor(rand() * v.length)].slice()];
  while (centres.length < k) {  // k-means++
    const d = v.map((p) => Math.min(...centres.map((c) => dist(p, c))));
    const sum = d.reduce((a, b) => a + b, 0);
    let r = rand() * sum;
    let i = 0;
    while (i < d.length - 1 && (r -= d[i]) > 0) i++;
    centres.push(v[i].slice());
  }
  let of = new Array(v.length).fill(0);
  for (let iter = 0; iter < 20; iter++) {
    of = v.map((p) => {
      let best = 0;
      for (let c = 1; c < k; c++) if (dist(p, centres[c]) < dist(p, centres[best])) best = c;
      return best;
    });
    for (let c = 0; c < k; c++) {
      const members = v.filter((_, i) => of[i] === c);
      if (!members.length) continue;
      centres[c] = centres[c].map((_, d) => members.reduce((s, m) => s + m[d], 0) / members.length);
    }
  }
  const order = [];
  for (const c of of) if (!order.includes(c)) order.push(c);
  const rename = new Map(order.map((c, i) => [c, i]));
  return { k: order.length, of: of.map((c) => rename.get(c)) };
}

// Each beat links to the next, and passages that come back link to where they were heard before,
// so repeats pull together in the layout.
function linkRepeats(rows) {
  const v = vectors(rows);
  const n = v.length;
  const links = [];
  for (let i = 0; i + 1 < n; i++) links.push([i, i + 1]);
  const bar = (i) => [...v[i], ...v[Math.min(n - 1, i + 1)], ...v[Math.min(n - 1, i + 2)], ...v[Math.min(n - 1, i + 3)]];
  const bars = Array.from({ length: n }, (_, i) => (i % 2 ? null : unit(bar(i))));
  const best = [];
  for (let i = 0; i < n; i += 2) {
    let top = -1;
    let at = -1;
    for (let j = 0; j < n; j += 2) {
      if (Math.abs(i - j) < 16) continue;
      let s = 0;
      for (let d = 0; d < bars[i].length; d++) s += bars[i][d] * bars[j][d];
      if (s > top) {
        top = s;
        at = j;
      }
    }
    if (at >= 0) best.push({ i, j: at, s: top });
  }
  const sims = best.map((b) => b.s).sort((a, b) => a - b);
  const cut = Math.max(0.8, sims[Math.floor(sims.length * 0.7)] ?? 1);
  const seen = new Set();
  for (const { i, j, s } of best) {
    const key = i < j ? `${i}:${j}` : `${j}:${i}`;
    if (s >= cut && !seen.has(key)) {
      seen.add(key);
      links.push([i, j]);
    }
  }
  return links;
}

// The bar where the most intense eight-bar stretch begins (on a four-bar line): where the song comes
// in. Intensity is loudness and brightness together, since a mastered song is nearly as loud all
// the way through but opens up in its drops.
function loudestStretch(loud, bars) {
  const barLoud = Array.from({ length: bars }, (_, b) => (loud[b * 4] + loud[b * 4 + 1] + loud[b * 4 + 2] + loud[b * 4 + 3]) / 4);
  const span = Math.min(8, bars);
  let top = -1;
  const means = [];
  for (let b = 0; b + span <= bars; b += 4) {
    const m = barLoud.slice(b, b + span).reduce((a, v) => a + v, 0) / span;
    means.push([b, m]);
    top = Math.max(top, m);
  }
  const found = means.find(([b, m]) => m >= top * 0.97 && b <= bars * 0.75);
  return found ? found[0] : 0;
}

// ---------------------------------------------------------------------------
// Small helpers

function dist(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return s;
}

function unit(v) {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

function standardise(xs) {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) || 1;
  return xs.map((x) => (x - m) / sd);
}

function normalise(xs) {
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  return xs.map((x) => (hi > lo ? (x - lo) / (hi - lo) : 0.5));
}

function mulberry(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
