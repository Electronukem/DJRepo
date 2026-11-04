// Genres set both the sound and the look: a tempo range, the drum, bass and chord patterns,
// and a neon colour gradient for the clusters. "From your repo" lets the repository pick one
// (see deriveSet in dj.js).
//
// Patterns are 16 steps (sixteenth notes) per bar: '-' rest, '.' soft, 'o' medium, 'x' full.

'use strict';

const GENRES = {
  repo: { name: 'From your repo' },

  house: {
    name: 'House', bpm: [122, 126], swing: 0.1, pump: 0.6, bg: 300, kick: 'punchy',
    feel: 'warm and bouncy',
    stops: [[300, 95, 64], [330, 95, 64], [12, 95, 62], [42, 95, 60]],
    drums: {
      kick: 'x---x---x---x---',
      clap: '----x-------x---',
      hatC: '-.-.-.-.-.-.-.-.',
      hatO: '--x---x---x---x-',
      perc: '---o---.--o--.-.',
    },
    perc: 'conga',
    bass: { style: 'offbeat', pattern: '--x---x---x--ox-' },
    chords: { style: 'stab', pattern: 'x--x--x---x-x---' },
    arp: 'x-x-x-x-x-x-x-x-',
    hook: [0, 3, 6, 10, 12, 14],
    arpOn: false,
  },

  techno: {
    name: 'Techno', bpm: [128, 134], swing: 0, pump: 0.75, bg: 205, kick: 'rumble',
    feel: 'dark and driving',
    stops: [[182, 95, 56], [200, 70, 70], [210, 15, 88], [352, 95, 60]],
    drums: {
      kick: 'x---x---x---x---',
      clap: '----o-------o---',
      hatC: '..x...x...x...x.',
      hatO: '----------------',
      perc: '--o---o---o---o-',
    },
    perc: 'ride',
    // Acid line: scale steps above the chord root (7 is the octave).
    bass: { style: 'acid', pattern: 'x.ox.x.ox.xo.x.o', notes: [0, 0, 7, 0, 0, 4, 0, 7, 0, 0, 2, 0, 7, 0, 4, 0] },
    chords: { style: 'dub', pattern: '---x------x-----' },
    arp: 'x-xx-x-xx-x-x-xx',
    hook: [0, 2, 4, 7, 10, 12],
    arpOn: false,
  },

  trance: {
    name: 'Trance', bpm: [134, 140], swing: 0, pump: 0.7, bg: 238, kick: 'tight',
    feel: 'soaring',
    stops: [[195, 95, 62], [225, 90, 68], [262, 90, 72], [176, 95, 60]],
    drums: {
      kick: 'x---x---x---x---',
      clap: '----x-------x---',
      hatC: '-.-.-.-.-.-.-.-.',
      hatO: '--x---x---x---x-',
      perc: '.o.o.o.o.o.o.o.o',
    },
    perc: 'shaker',
    bass: { style: 'rolling', pattern: '-xxx-xxx-xxx-xxx' },
    chords: { style: 'gate', pattern: 'xx-x-xx-xx-x-xx-' },
    arp: 'xxxxxxxxxxxxxxxx',
    hook: [0, 3, 6, 8, 11, 14],
    arpOn: true,
  },

  bigroom: {
    name: 'Big room', bpm: [126, 128], swing: 0, pump: 0.8, bg: 275, kick: 'big',
    feel: 'built for the main stage',
    stops: [[95, 100, 55], [58, 100, 56], [322, 100, 64], [280, 95, 68]],
    drums: {
      kick: 'x---x---x---x---',
      clap: '----x-------x---',
      hatC: '-.-.-.-.-.-.-.-.',
      hatO: '--x---x---x---x-',
      perc: '-------o-------o',
    },
    perc: 'rim',
    bass: { style: 'sub', pattern: '--x---x---x---x-' },
    chords: { style: 'hook', pattern: 'x--x--x-x--x--x-' },
    arp: 'x-x-x-x-x-x-x-x-',
    hook: [0, 3, 6, 8, 11, 14],
    arpOn: true,
  },

  dnb: {
    name: 'Drum & bass', bpm: [172, 176], swing: 0.04, pump: 0.45, bg: 18, kick: 'tight',
    feel: 'fast and rolling',
    stops: [[14, 100, 60], [36, 100, 58], [282, 90, 66], [140, 90, 56]],
    drums: {
      kick: 'x---------x-----',
      clap: '----x-------x---',
      hatC: 'o-.-o-.-o-.-o-.o',
      hatO: '--------------x-',
      perc: '-------.-.----.-',
    },
    perc: 'ghost',
    snare: true,  // a snare, not a clap
    bass: { style: 'reese', pattern: 'x-------x-------' },
    chords: { style: 'pad', pattern: 'x---------------' },
    arp: 'x--x--x--x--x-x-',
    hook: [0, 3, 6, 10, 13],
    arpOn: false,
  },
};

// A colour partway (0–1) along a genre's gradient, as { h, s, l }.
function genreColour(stops, x) {
  const pos = Math.min(0.9999, Math.max(0, x)) * (stops.length - 1);
  const i = Math.floor(pos);
  const f = pos - i;
  const [h1, s1, l1] = stops[i];
  const [h2, s2, l2] = stops[Math.min(i + 1, stops.length - 1)];
  const dh = ((h2 - h1 + 540) % 360) - 180;  // the short way round the colour wheel
  return { h: (h1 + dh * f + 360) % 360, s: s1 + (s2 - s1) * f, l: l1 + (l2 - l1) * f };
}

// For the genre picker: a CSS gradient that previews it.
function genreSwatch(genre) {
  if (!genre.stops) return 'conic-gradient(from 90deg, #ff3fa4, #ffd23f, #3fff8b, #3fd2ff, #a43fff, #ff3fa4)';
  return `linear-gradient(135deg, ${genre.stops.map(([h, s, l]) => `hsl(${h} ${s}% ${l}%)`).join(', ')})`;
}
