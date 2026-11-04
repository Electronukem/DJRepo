// The gig finder: real upcoming dance and electronic events near you on a map (Ticketmaster), and
// for each one a booking email researched and written by Meta's Muse Spark (see gigs.py), with a
// clip of your repo's set in the genre that suits the room. Pick a gig and the email is drafted
// straight away; one click opens it in your own mail app and saves the clip to attach. Nothing is
// ever sent for you.
// Shares the page's global scope with app.js ($, showScreen, postJSON, waitForJobs, ...) and
// sample.js (renderSample, sampleClips).

'use strict';

const PROFILE_KEY = 'djrepo.profile';
const PLACE_KEY = 'djrepo.gigplace';
const HOME = { city: 'Boston', lat: 42.3601, lon: -71.0589 };  // where the gig finder looks first
const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';  // darkened to match in style.css
const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

const gig = {
  scene: null,       // the repo the clips come from
  clips: null,       // what the clip would be in each genre
  events: [],
  selected: null,
  drafts: new Map(),   // event id -> { state: 'working' | 'ready' | 'error', step, result, error }
  samples: new Map(),  // genre -> Promise of { blob, url, seconds }
  map: null,
  layer: null,
  pins: new Map(),     // venue id -> marker
};

// ---------------------------------------------------------------------------
// Getting there from the start screen

async function openGigFinder() {
  const url = $('#repo-url').value.trim();
  if (!url) {
    showError('Paste the repo your sample should come from, then find a gig.');
    $('#repo-url').focus();
    return;
  }
  showError('');
  $('#step').textContent = 'Getting the sample ready';
  $('#log').textContent = '';
  showScreen('progress');
  try {
    const { job } = await postJSON('/api/build', { url, refresh: $('#refresh').checked });
    const [scene] = await waitForJobs([job], [shortUrl(url)]);
    if (gig.scene !== scene) gig.samples.clear();
    gig.scene = scene;
    gig.clips = sampleClips(scene);
    gig.drafts.clear();
    showScreen('gigs');
    $('#gig-repo').textContent = `${scene.repo.owner}/${scene.repo.name}`;
    setUpMap();
    checkKeys();
    const place = loadPlace() || { city: HOME.city };
    if (place.city && !$('#gig-city').value) $('#gig-city').value = place.city;
    if (!gig.events.length && health && health.keys && health.keys.events) search(place);
  } catch (err) {
    showScreen('intro');
    showError(err.message || String(err));
  }
}

function checkKeys() {
  const keys = (health && health.keys) || {};
  const lines = [];
  if (!keys.events) lines.push('To find gigs, add TICKETMASTER_API_KEY to .env (free at developer.ticketmaster.com) and restart DJRepo.');
  if (!keys.meta) lines.push('To write the emails, add MODEL_API_KEY to .env (from dev.meta.ai) and restart DJRepo.');
  $('#gig-keys').replaceChildren(...lines.map((text) => Object.assign(document.createElement('p'), { textContent: text })));
  $('#gig-keys').hidden = !lines.length;
}

// ---------------------------------------------------------------------------
// The map

function setUpMap() {
  if (gig.map) {
    setTimeout(() => gig.map.invalidateSize(), 50);
    return;
  }
  if (typeof L === 'undefined') {
    $('#gig-map').textContent = "Couldn't load the map. Check your internet connection.";
    return;
  }
  gig.map = L.map('gig-map', { zoomControl: true, worldCopyJump: true }).setView([HOME.lat, HOME.lon], 11);
  L.tileLayer(TILES, {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(gig.map);
  gig.layer = L.layerGroup().addTo(gig.map);
}

function pinIcon(count, selected) {
  return L.divIcon({
    className: '',
    html: `<span class="gig-pin${selected ? ' on' : ''}">${count > 1 ? count : ''}</span>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

function drawPins() {
  if (!gig.map) return;
  gig.layer.clearLayers();
  gig.pins.clear();
  const venues = new Map();
  for (const e of gig.events) {
    const key = e.venue.id || `${e.venue.lat},${e.venue.lon}`;
    if (!venues.has(key)) venues.set(key, []);
    venues.get(key).push(e);
  }
  const points = [];
  for (const [key, events] of venues) {
    const { lat, lon } = events[0].venue;
    const marker = L.marker([lat, lon], { icon: pinIcon(events.length, false), title: events[0].venue.name, riseOnHover: true });
    marker.on('click', () => selectGig(events[0]));
    marker.addTo(gig.layer);
    gig.pins.set(key, { marker, events });
    points.push([lat, lon]);
  }
  if (points.length) gig.map.fitBounds(points, { padding: [40, 40], maxZoom: 13 });
}

function venueKey(e) {
  return e.venue.id || `${e.venue.lat},${e.venue.lon}`;
}

// ---------------------------------------------------------------------------
// Finding gigs

function loadPlace() {
  try {
    return JSON.parse(localStorage.getItem(PLACE_KEY));
  } catch {
    return null;
  }
}

async function search(place) {
  const status = $('#gig-status');
  status.textContent = place.city ? `Looking for gigs in ${place.city}…` : 'Looking for gigs near you…';
  $('#gig-list').replaceChildren();
  try {
    const radius = Number($('#gig-radius').value);
    const { events, place: found } = await postJSON('/api/gigs', { ...place, radius });
    gig.events = events;
    try {
      localStorage.setItem(PLACE_KEY, JSON.stringify(place));
    } catch {
      // only a convenience
    }
    const where = found ? ` within ${radius} mi of ${found.split(',').slice(0, 3).join(',')}` : ` within ${radius} mi of you`;
    status.textContent = events.length
      ? `${events.length} upcoming dance and electronic event${events.length === 1 ? '' : 's'}${where}, soonest first.`
      : `No upcoming dance or electronic events${where}. Try a bigger radius or another city.`;
    renderList();
    drawPins();
  } catch (err) {
    status.textContent = err.message || String(err);
  }
}

function renderList() {
  $('#gig-list').replaceChildren(...gig.events.map((e) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'gig-item';
    item.dataset.id = e.id;
    item.setAttribute('aria-pressed', String(gig.selected === e));
    const when = Object.assign(document.createElement('span'), { className: 'gig-when', textContent: formatDate(e.date) });
    const what = Object.assign(document.createElement('span'), { className: 'gig-what', textContent: e.name });
    const where = Object.assign(document.createElement('span'), {
      className: 'gig-where',
      textContent: [e.venue.name, e.venue.city, e.subGenre && e.subGenre !== 'Undefined' ? e.subGenre : ''].filter(Boolean).join(' · '),
    });
    item.append(when, what, where);
    item.addEventListener('click', () => selectGig(e));
    return item;
  }));
}

function formatDate(iso) {
  if (!iso) return 'Date to be announced';
  const [y, m, d] = iso.split('-').map(Number);
  return DATE_FORMAT.format(new Date(y, m - 1, d));
}

// ---------------------------------------------------------------------------
// A gig, and its email

function selectGig(e) {
  gig.selected = e;
  for (const item of document.querySelectorAll('.gig-item')) item.setAttribute('aria-pressed', String(item.dataset.id === e.id));
  for (const [key, pin] of gig.pins) pin.marker.setIcon(pinIcon(pin.events.length, key === venueKey(e)));
  if (gig.map) gig.map.panTo([e.venue.lat, e.venue.lon], { animate: true });
  renderGig();
  draft(e);  // start straight away, so the email is ready by the time you've read about the night
  if (gig.scene) sample(guessGenre(e));  // and the clip, in the genre the listing suggests
  $('#gig-detail').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// The listing's own idea of the genre (Muse Spark has the final say once it's read up on the room).
function guessGenre(e) {
  const text = `${e.subGenre} ${e.genre} ${e.name}`.toLowerCase();
  const rules = [[['drum', 'jungle', 'dnb', 'd&b'], 'dnb'], [['techno', 'industrial'], 'techno'], [['trance', 'psy'], 'trance'],
    [['house', 'garage', 'disco'], 'house'], [['dubstep', 'edm', 'electro', 'big room', 'bass'], 'bigroom']];
  const hit = rules.find(([words]) => words.some((w) => text.includes(w)));
  return hit ? hit[1] : 'house';
}

function renderGig() {
  const e = gig.selected;
  const box = $('#gig-detail');
  box.hidden = !e;
  if (!e) return;
  $('#gig-image').hidden = !e.image;
  if (e.image) $('#gig-image').src = e.image;
  $('#gig-title').textContent = e.name;
  $('#gig-facts').textContent = [formatDate(e.date) + (e.time ? `, ${e.time.slice(0, 5)}` : ''),
    `${e.venue.name}, ${[e.venue.city, e.venue.state].filter(Boolean).join(', ')}`].join('  ·  ');
  $('#gig-more').textContent = [e.promoter && `Promoted by ${e.promoter}`, e.lineup.length && `With ${e.lineup.slice(0, 5).join(', ')}`]
    .filter(Boolean).join('. ');
  $('#gig-tickets').href = e.url || '#';
  $('#gig-tickets').hidden = !e.url;

  const d = gig.drafts.get(e.id);
  const state = !profile().name ? 'profile' : d ? d.state : 'idle';
  $('#draft-working').hidden = state !== 'working';
  $('#draft-error').hidden = state !== 'error' && state !== 'profile';
  $('#draft').hidden = state !== 'ready';
  if (state === 'working') $('#draft-step').textContent = d.step || 'Getting started';
  if (state === 'profile') $('#draft-error-text').textContent = 'Add your name under "You" first: it signs the email.';
  if (state === 'error') $('#draft-error-text').textContent = d.error;
  $('#draft-retry').hidden = state !== 'error';
  if (state === 'ready') showDraft(e, d.result);
}

async function draft(e, again = false) {
  const me = profile();
  if (!me.name || !gig.clips) return;
  const existing = gig.drafts.get(e.id);
  if (existing && !again && existing.state !== 'error') return;
  const d = { state: 'working', step: 'Getting started' };
  gig.drafts.set(e.id, d);
  renderGig();
  const current = () => gig.drafts.get(e.id) === d;
  try {
    const { job } = await postJSON('/api/pitch', { event: e, profile: me, clips: gig.clips });
    const results = await waitForJobs([job], [e.name], (steps) => {
      d.step = steps[0];
      if (gig.selected === e) $('#draft-step').textContent = d.step;
    }, current);
    if (!results) return;
    d.result = results[0];
    d.state = 'ready';
    sample(d.result.genre);  // render the clip while the email is read
  } catch (err) {
    if (!current()) return;
    d.state = 'error';
    d.error = err.message || String(err);
  }
  if (gig.selected === e) renderGig();
}

function showDraft(e, r) {
  $('#draft-to').value = r.to;
  $('#draft-subject').value = r.subject;
  $('#draft-body').value = r.body;
  const who = r.contact.name ? `${r.contact.name}${r.contact.role ? `, ${r.contact.role}` : ''}` : r.reader || r.contact.role;
  const found = r.contact.source && r.contact.source.startsWith('http') ? r.contact.source : null;
  $('#draft-who').replaceChildren(
    r.to ? `Goes to ${who || 'their bookings inbox'}. The address was found on ` : `Likely read by ${who || 'their booker'}. `,
    ...(r.to ? [found ? link(found, new URL(found).hostname) : 'a search result', '.'] : ['No booking address could be confirmed on a public page, so add one before you send.']),
  );
  $('#draft-how').textContent = r.submissions ? `How they say to get in touch: ${r.submissions}` : '';
  $('#draft-how').hidden = !r.submissions;
  // Addresses the research mentions that no page confirmed: offered, never filled in for you.
  const maybe = r.unconfirmed || [];
  $('#draft-maybe').hidden = !maybe.length;
  $('#draft-maybe').replaceChildren(...(maybe.length ? [
    Object.assign(document.createElement('p'), {
      textContent: `The research mentions ${maybe.join(' and ')}, but DJRepo couldn't find ${maybe.length > 1 ? 'them' : 'it'} on a page it could read. Check their site before you use ${maybe.length > 1 ? 'one' : 'it'}.`,
    }),
    ...maybe.map((address) => {
      const use = Object.assign(document.createElement('button'), { type: 'button', className: 'ghost', textContent: `Use ${address}` });
      use.addEventListener('click', () => {
        $('#draft-to').value = address;
        updateLinks();
      });
      return use;
    }),
  ] : []));
  $('#draft-genre').textContent = `${GENRES[r.genre].name} clip${r.why ? `: ${r.why}` : ''}`;
  $('#draft-sources').replaceChildren(...r.sources.map((s) => {
    const li = document.createElement('li');
    li.append(link(s.url, s.title));
    return li;
  }));
  updateLinks();
  const clip = gig.clips[r.genre];
  const note = `${GENRES[r.genre].name}, ${clip.bpm} BPM, about ${clip.seconds} seconds from ${clip.repo}.`;
  const player = $('#clip-player');
  const key = `${clip.repo}:${r.genre}`;
  if (player.dataset.key !== key) {
    player.removeAttribute('src');
    player.dataset.key = '';
    $('#clip-note').textContent = `Making the clip. ${note}`;
  }
  sample(r.genre).then((s) => {
    if (gig.selected !== e || player.dataset.key === key) return;
    player.src = s.url;
    player.dataset.key = key;
    $('#clip-note').textContent = note;
  }).catch(() => {
    if (gig.selected === e) $('#clip-note').textContent = "Couldn't make the clip in this browser.";
  });
}

function link(href, text) {
  return Object.assign(document.createElement('a'), { href, textContent: text, target: '_blank', rel: 'noopener' });
}

// The mail links follow whatever you edit.
function updateLinks() {
  const to = $('#draft-to').value.trim();
  const subject = $('#draft-subject').value;
  const body = $('#draft-body').value;
  const q = (s) => encodeURIComponent(s);
  const lines = (s) => q(s.replace(/\r?\n/g, '\r\n'));  // mailto bodies want CRLF line breaks
  $('#send-mail').href = `mailto:${q(to).replace(/%40/g, '@')}?subject=${q(subject)}&body=${lines(body)}`;
  $('#send-gmail').href = `https://mail.google.com/mail/?view=cm&fs=1&to=${q(to)}&su=${q(subject)}&body=${q(body)}`;
}

function sample(genre) {
  if (!gig.samples.has(genre)) {
    const scene = gig.scene;
    gig.samples.set(genre, renderSample(scene, genre).then((s) => ({ ...s, url: URL.createObjectURL(s.blob) })));
  }
  return gig.samples.get(genre);
}

// Save the clip, named for the DJ and the gig, so it's ready to attach.
async function saveClip() {
  const e = gig.selected;
  const r = e && gig.drafts.get(e.id)?.result;
  if (!r) return;
  const s = await sample(r.genre);
  const me = profile();
  const name = `${me.djName || me.name} - ${GENRES[r.genre].name} clip for ${e.venue.name}.${s.ext}`.replace(/[\\/:*?"<>|]+/g, '');
  const a = Object.assign(document.createElement('a'), { href: s.url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
}

// ---------------------------------------------------------------------------
// You: who signs the emails

function profile() {
  try {
    const saved = JSON.parse(localStorage.getItem(PROFILE_KEY)) || {};
    return { name: '', djName: '', city: '', links: '', about: '', mentionRepo: true, ...saved };
  } catch {
    return { name: '', djName: '', city: '', links: '', about: '', mentionRepo: true };
  }
}

function fillProfile() {
  const me = profile();
  for (const key of ['name', 'djName', 'city', 'links', 'about']) $(`#me-${key}`).value = me[key];
  $('#me-mentionRepo').checked = me.mentionRepo;
  $('#me').open = !me.name;
}

function saveProfile() {
  const me = Object.fromEntries(['name', 'djName', 'city', 'links', 'about'].map((k) => [k, $(`#me-${k}`).value.trim()]));
  me.mentionRepo = $('#me-mentionRepo').checked;
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(me));
  } catch {
    // private windows: it still works for this visit, just isn't remembered
  }
}

// ---------------------------------------------------------------------------
// Wiring

$('#find-gig').addEventListener('click', openGigFinder);
$('#gig-back').addEventListener('click', () => showScreen('intro'));
$('#gig-play').addEventListener('click', () => {
  if (!gig.scene) return;
  music.unlock();
  begin([gig.scene]).catch(fail);
});
$('#gig-search').addEventListener('submit', (event) => {
  event.preventDefault();
  const city = $('#gig-city').value.trim();
  if (city) search({ city });
});
$('#gig-near').addEventListener('click', () => {
  if (!navigator.geolocation) {
    $('#gig-status').textContent = "This browser can't share your location. Type a city instead.";
    return;
  }
  $('#gig-status').textContent = 'Finding where you are…';
  navigator.geolocation.getCurrentPosition(
    (p) => search({ lat: +p.coords.latitude.toFixed(3), lon: +p.coords.longitude.toFixed(3) }),
    () => {
      $('#gig-status').textContent = "Couldn't get your location. Type a city instead.";
    },
    { timeout: 10000, maximumAge: 600000 },
  );
});
$('#me').addEventListener('input', () => {
  saveProfile();
  if (gig.selected && !gig.drafts.get(gig.selected.id)) renderGig();
});
$('#me').addEventListener('change', () => {
  if (gig.selected && profile().name) draft(gig.selected);
});
for (const id of ['#draft-to', '#draft-subject', '#draft-body']) $(id).addEventListener('input', updateLinks);
$('#send-mail').addEventListener('click', saveClip);  // the clip saves as your mail app opens
$('#send-gmail').addEventListener('click', saveClip);
$('#save-clip').addEventListener('click', saveClip);
$('#draft-retry').addEventListener('click', () => gig.selected && draft(gig.selected, true));
$('#draft-redo').addEventListener('click', () => gig.selected && draft(gig.selected, true));
$('#copy-draft').addEventListener('click', async () => {
  const text = `To: ${$('#draft-to').value}\nSubject: ${$('#draft-subject').value}\n\n${$('#draft-body').value}`;
  try {
    await navigator.clipboard.writeText(text);
    $('#copy-draft').textContent = 'Copied';
    setTimeout(() => ($('#copy-draft').textContent = 'Copy'), 1500);
  } catch {
    $('#copy-draft').textContent = "Couldn't copy";
  }
});
fillProfile();
