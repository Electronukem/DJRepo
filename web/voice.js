// Push to talk. Hold V (or the mic button), say what you want, let go: the recording becomes the
// WAV Muse Voice Transcribe wants (16 kHz, mono, 16-bit) and goes through the DJRepo server, which
// holds the key, to Meta's Model API. It comes back as text. Shared by the show and the control deck.
//
// The microphone is open only while you hold the button. Left open, it counts as a call, and
// Windows turns every other sound down while one is going.

'use strict';

const VOICE_RATE = 16000;
const SILENT_PEAK = 0.01;  // a recording quieter than this is a mic that isn't hearing anything
const VOICE_LEVEL = 0.012;  // a mic level above this, while you hold, is you talking
const TAIL_MS = 250;  // keep recording this long after you let go, so the last word isn't clipped
const talk = { stream: null, recorder: null, chunks: [], started: 0, held: false, meter: null, meterCtx: null, loudest: 0, sampler: null };

// How loud the mic is right now (0 to about 0.5 for speech), so the page can show it's hearing you.
function talkLevel() {
  const m = talk.meter;
  if (!m) return 0;
  m.analyser.getFloatTimeDomainData(m.data);
  let sq = 0;
  for (const v of m.data) sq += v * v;
  return Math.sqrt(sq / m.data.length);
}

function startMeter(stream) {
  try {
    talk.meterCtx = talk.meterCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (talk.meterCtx.state === 'suspended') talk.meterCtx.resume().catch(() => {});
    const source = talk.meterCtx.createMediaStreamSource(stream);
    const analyser = talk.meterCtx.createAnalyser();
    analyser.fftSize = 1024;
    const mute = talk.meterCtx.createGain();  // the browser only runs a meter that leads somewhere
    mute.gain.value = 0;
    source.connect(analyser).connect(mute).connect(talk.meterCtx.destination);
    talk.meter = { source, analyser, data: new Float32Array(analyser.fftSize) };
  } catch {
    talk.meter = null;  // no meter is fine; it's only there to show the mic is working
  }
}

function stopMeter() {
  if (talk.meter) talk.meter.source.disconnect();
  talk.meter = null;
}

// Whether the button is held right now (even if the mic is still opening).
function talkHeld() {
  return talk.held;
}

// Press: open the mic and record. Resolves true once recording, or false if the button was let go
// while the mic was still opening (then it's closed again straight away).
async function talkStart() {
  if (talk.held) return Boolean(talk.recorder);
  if (talk.recorder) return false;  // the last one is still finishing (its tail): this press waits its turn
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    throw new Error("This browser can't record from a microphone.");
  }
  talk.held = true;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    talk.held = false;
    throw new Error('Allow the microphone for this page to use voice commands.');
  }
  if (!talk.held) {  // let go before the mic opened
    closeMic(stream);
    return false;
  }
  talk.stream = stream;
  talk.chunks = [];
  startMeter(stream);
  talk.loudest = 0;
  talk.sampler = setInterval(() => {
    talk.loudest = Math.max(talk.loudest, talkLevel());
  }, 40);
  talk.recorder = new MediaRecorder(stream);
  talk.recorder.ondataavailable = (e) => {
    if (e.data.size) talk.chunks.push(e.data);
  };
  talk.recorder.start();
  talk.started = performance.now();
  return true;
}

function closeMic(stream) {
  if (stream) for (const track of stream.getTracks()) track.stop();
}

// Let go: stop, close the mic, and write it down. Resolves to the words, or '' if it was too short
// to be speech (a tap rather than a hold). Throws, saying what went wrong, if the mic recorded
// silence or no words were heard.
async function talkStop() {
  if (!talk.held) return '';
  talk.held = false;
  const recorder = talk.recorder;
  const stream = talk.stream;
  if (!recorder) return '';  // the mic never opened; talkStart closes it if it does
  await new Promise((resolve) => setTimeout(resolve, TAIL_MS));  // the end of the last word
  talk.recorder = null;
  talk.stream = null;
  clearInterval(talk.sampler);
  talk.loudest = Math.max(talk.loudest, talkLevel());
  stopMeter();
  const stopped = new Promise((resolve) => {
    recorder.onstop = resolve;
  });
  recorder.stop();
  await stopped;
  closeMic(stream);
  const seconds = (performance.now() - talk.started) / 1000;
  if (seconds < 0.6) return '';
  const { wav, peak } = await toVoiceWav(new Blob(talk.chunks, { type: recorder.mimeType }));
  if (peak < SILENT_PEAK || talk.loudest < VOICE_LEVEL) {
    throw new Error(`The mic didn't pick up your voice in that ${seconds.toFixed(1)} s. Check which microphone the browser is `
      + 'using (the mic icon in the address bar), and that Windows lets it use the mic (Settings → Privacy → Microphone).');
  }
  const res = await fetch('/api/voice', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Muse Voice Transcribe couldn't write that down.");
  const text = String(data.text || '').trim();
  if (!text) {
    throw new Error(`Muse Voice heard sound but no words in that ${seconds.toFixed(1)} s. Wait for “Speak now”, then say the `
      + 'command clearly, and let go after you finish.');
  }
  return text;
}

// Whatever the browser recorded, as 16 kHz mono 16-bit PCM WAV, and how loud it got.
async function toVoiceWav(blob) {
  const audio = await new OfflineAudioContext(1, VOICE_RATE, VOICE_RATE).decodeAudioData(await blob.arrayBuffer());
  const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c));
  const frames = audio.length;
  const view = new DataView(new ArrayBuffer(44 + frames * 2));
  const text = (offset, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + frames * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, audio.sampleRate, true);
  view.setUint32(28, audio.sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, frames * 2, true);
  let peak = 0;
  for (let i = 0; i < frames; i++) {
    let v = 0;
    for (const ch of channels) v += ch[i];
    v = Math.max(-1, Math.min(1, v / channels.length));
    peak = Math.max(peak, Math.abs(v));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return { wav: new Blob([view], { type: 'audio/wav' }), peak };
}
