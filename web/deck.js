// The control deck: DJRepo's controls in a window of their own, so the show can stay full screen
// and clean while you DJ from here. It holds no music itself. It mirrors what the show window
// publishes over a BroadcastChannel and sends back what you press (see "The control deck" in app.js).
// Shares the page's global scope with genres.js (GENRES, genreSwatch) and dj.js (CHANNELS, LEADS).

'use strict';

const $ = (sel) => document.querySelector(sel);
const MASH_PARTS = [['drums', 'Drums'], ['bass', 'Bass'], ['chords', 'Chords & arpeggio']];
const link = 'BroadcastChannel' in window ? new BroadcastChannel('djrepo-deck') : null;

let state = null;      // the latest from the show
let heard = 0;         // when the show last said anything
let noticeUntil = 0;   // a notice holds the countdown line for a moment

const send = (name, ...args) => link && link.postMessage({ type: 'cmd', name, args });

// ---------------------------------------------------------------------------
// Building the controls

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

function build() {
  for (const [deck, box] of [[0, '#d-genres-a'], [1, '#d-genres-b']]) {
    for (const [id, genre] of Object.entries(GENRES)) {
      const button = chip(genre.name, genreSwatch(genre), () => send('genre', id, deck));
      button.dataset.genre = id;
      button.dataset.deck = String(deck);
      $(box).append(button);
    }
  }
  for (const id of ['auto', ...Object.keys(LEADS)]) {
    const button = chip(id === 'auto' ? 'From the code' : LEADS[id].name, null, () => send('lead', id));
    button.dataset.lead = id;
    $('#d-leads').append(button);
  }
  for (const [part, name] of MASH_PARTS) {
    const row = document.createElement('div');
    row.className = 'mash-row';
    const group = document.createElement('div');
    group.className = 'chips';
    for (const from of [0, 1]) {
      const button = chip('', null, () => send('mash', part, from));
      button.dataset.part = part;
      button.dataset.from = String(from);
      group.append(button);
    }
    row.append(Object.assign(document.createElement('span'), { className: 'mash-name', textContent: name }), group);
    $('#d-mash-rows').append(row);
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
    const level = document.createElement('input');
    level.type = 'range';
    level.min = '0';
    level.max = '1';
    level.step = '0.01';
    level.setAttribute('aria-label', `${channel.name} volume`);
    box.addEventListener('change', () => send('channel', channel.id, { on: box.checked, level: Number(level.value) }));
    level.addEventListener('input', () => send('channel', channel.id, { on: true, level: Number(level.value) }));
    toggle.append(box, Object.assign(document.createElement('span'), { className: 'inst-name', textContent: channel.name }));
    row.append(toggle, level, Object.assign(document.createElement('p'), { className: 'inst-sub' }));
    $(`#d-${channel.group}`).append(row);
  }

  $('#d-drop').addEventListener('click', () => send('drop'));
  $('#d-sound').addEventListener('click', () => send('sound'));
  $('#d-volume').addEventListener('input', (e) => send('volume', Number(e.target.value)));
  $('#d-intensity').addEventListener('input', (e) => send('intensity', Number(e.target.value)));
  $('#d-flashes').addEventListener('change', (e) => send('flashes', e.target.checked));
  $('#d-announcer').addEventListener('change', (e) => send('announcer', e.target.checked));
  $('#d-reset').addEventListener('click', () => send('reset'));
  $('#d-cooking-close').addEventListener('click', () => send('stopCooking'));
  $('#d-add-song').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file && state && state.playing && !state.busy) send('addSong', file);
  });
  $('#d-add-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const url = $('#d-add-url').value.trim();
    if (!url || !state || state.busy) return;
    send('add', url);
    $('#d-add-url').value = '';
    $('#d-add-url').blur();
  });
}

// ---------------------------------------------------------------------------
// Showing what the show says

// Set an input's value, unless it's the one being dragged right now.
function setValue(input, value) {
  if (document.activeElement !== input) input.value = String(value);
}

function render() {
  const s = state;
  const playing = Boolean(s && s.playing);
  const battle = playing && s.battle;
  const [a, b] = playing ? s.decks : [];
  document.body.classList.toggle('battle', battle);
  document.body.classList.toggle('idle-show', !playing);

  for (const [sel, d] of [['#d-name-a', a], ['#d-name-b', b]]) {
    $(sel).textContent = d ? (d.waiting ? '???' : d.song ? `♪ ${d.short}` : d.short) : sel === '#d-name-a' ? 'DJRepo' : '';
    $(sel).title = d && !d.waiting ? d.name : '';
  }
  $('#d-name-b').hidden = !battle;
  $('#d-vs').hidden = !battle;
  $('#d-mood').textContent = !playing ? 'Start a set in the DJRepo window.'
    : [a, b].filter(Boolean).map((d) => (d.waiting ? 'A new contender' : d.label)).join('   vs   ');
  if (!playing) {
    $('#d-section').textContent = 'Not playing';
    $('#d-soon').textContent = '';
    $('#d-bpm').textContent = '';
  }

  const drop = $('#d-drop');
  drop.textContent = battle ? 'Sync' : 'Drop';
  drop.title = battle ? 'Sync the decks into one drop (D)' : 'Skip to the next drop (D)';
  drop.disabled = !playing;

  if (s) {
    $('#d-sound').classList.toggle('muted', s.muted);
    $('#d-sound').setAttribute('aria-pressed', String(!s.muted));
    setValue($('#d-volume'), s.volume);
    setValue($('#d-intensity'), s.settings.intensity);
    $('#d-flashes').checked = s.settings.flashes;
    $('#d-announcer').checked = s.settings.announcer;
  }

  // Bringing in a challenger.
  $('#d-add-note').textContent = playing ? s.addNote : 'Once a set is playing, add a repo here and it joins mid-set.';
  $('#d-add-go').disabled = !playing || s.busy;
  const cooking = playing && s.cooking;
  $('#d-cooking').hidden = !cooking;
  if (cooking) {
    $('#d-cooking').classList.toggle('burnt', cooking.failed);
    $('#d-cooking-title').textContent = cooking.title;
    $('#d-cooking-step').textContent = cooking.step;
  }

  // The mixer. A song plays as it is, so it has no genre to pick or parts to trade.
  for (const sel of ['#d-genres-b', '#d-genres-b-label', '#d-genres-a-label', '#d-mashup']) $(sel).hidden = !battle;
  const song = playing ? s.decks.findIndex((d) => d.song) : -1;
  $('#d-genres-a').hidden = song === 0;
  if (song === 1) $('#d-genres-b').hidden = true;
  if (battle) {
    const name = (d) => (d.song ? `${d.short} (a song plays as it is)` : d.short);
    $('#d-genres-a-label').textContent = `A · ${name(a)}`;
    $('#d-genres-b-label').textContent = `B · ${name(b)}`;
  }
  $('#d-mash-rows').hidden = battle && song >= 0;
  $('#d-mash-song').hidden = !(battle && song >= 0);
  if (battle && song >= 0) {
    $('#d-mash-song').textContent = `${s.decks[song].short} plays as it is, with ${s.decks[1 - song].short}'s drums on top and its graph on lead.`;
  }
  if (!s) return;
  for (const button of document.querySelectorAll('[data-genre]')) {
    const deck = Number(button.dataset.deck);
    const choice = deck ? s.settings.genreB : s.settings.genre;
    button.setAttribute('aria-pressed', String(button.dataset.genre === choice));
    if (button.dataset.genre === 'repo') {
      const d = playing && s.decks[deck];
      button.lastChild.textContent = d ? `From the repo · ${GENRES[d.repoGenre].name}` : GENRES.repo.name;
    }
  }
  for (const button of document.querySelectorAll('[data-lead]')) {
    button.setAttribute('aria-pressed', String(button.dataset.lead === s.settings.lead));
    if (button.dataset.lead === 'auto') {
      const leads = playing ? [...new Set(s.decks.map((d) => LEADS[d.codeLead].name))] : [];
      button.lastChild.textContent = leads.length ? `From the code · ${leads.join(' / ')}` : 'From the code';
    }
  }
  for (const button of document.querySelectorAll('[data-part]')) {
    const from = Number(button.dataset.from);
    button.setAttribute('aria-pressed', String(s.settings.mash[button.dataset.part] === from));
    if (battle) button.lastChild.textContent = s.decks[from].short;
  }
  for (const channel of CHANNELS) {
    const row = document.querySelector(`.inst[data-channel="${channel.id}"]`);
    const mix = s.mix[channel.id] || { on: false, level: channel.level };
    row.classList.toggle('off', !mix.on);
    row.querySelector('.switch').checked = mix.on;
    setValue(row.querySelector('input[type=range]'), mix.level);
    row.querySelector('.inst-sub').textContent = (playing && s.notes[channel.id]) || '';
  }
}

function showPosition(pos) {
  document.body.dataset.section = pos.section;
  document.body.dataset.deck = String(pos.deck);
  $('#d-section').textContent = pos.label;
  if (Date.now() > noticeUntil) $('#d-soon').textContent = pos.soon;
  $('#d-bpm').textContent = pos.bpm;
  $('#d-phrase-fill').style.transform = `scaleX(${pos.progress.toFixed(3)})`;
  document.querySelectorAll('#d-beats span').forEach((dot, k) => dot.classList.toggle('on', k === pos.beat));
  $('#d-meter-a').style.width = `${(50 + 50 * pos.balance).toFixed(1)}%`;
}

function showNotice(text) {
  noticeUntil = Date.now() + 2500;
  $('#d-soon').textContent = text;
}

// ---------------------------------------------------------------------------
// Wiring

build();
render();

if (link) {
  link.addEventListener('message', ({ data }) => {
    if (!data || typeof data !== 'object') return;
    heard = Date.now();
    if (data.type === 'state') {
      state = data.state;
      render();
    } else if (data.type === 'pos' && state && state.playing) {
      showPosition(data.pos);
    } else if (data.type === 'notice') {
      showNotice(data.text);
    }
  });
  link.postMessage({ type: 'hello' });
  setInterval(() => link.postMessage({ type: 'ping' }), 2000);
  window.addEventListener('pagehide', () => link.postMessage({ type: 'bye' }));
} else {
  $('#d-offline').textContent = "This browser can't link two windows (no BroadcastChannel). Use the controls in the show window.";
}

// Say so when the show window has gone quiet (closed, or reloading).
setInterval(() => {
  const lost = Date.now() - heard > 5000;
  $('#d-offline').hidden = !lost;
  if (lost && state) {
    state = null;
    render();
  }
}, 1000);

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target instanceof HTMLInputElement && e.target.type === 'text') return;
  const key = e.key.toLowerCase();
  if (key === 'd') send('drop');
  if (key === 'm') send('sound');
  if (key === 'a') {
    e.preventDefault();
    $('#d-add-url').focus();
  }
});
