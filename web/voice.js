// Push to talk. Hold V (or the mic button), say what you want, let go: the recording becomes the
// WAV Muse Voice Transcribe wants (16 kHz, mono, 16-bit) and goes through the DJRepo server, which
// holds the key, to Meta's Model API. It comes back as text. Shared by the show and the control deck.
//
// The microphone is open only while you hold the button. Left open, it counts as a call, and
// Windows turns every other sound down while one is going.

'use strict';

const VOICE_RATE = 16000;
const SILENT_PEAK = 0.002;  // a recording quieter than this is a mic that isn't hearing anything at all
const QUIET_PEAK = 0.03;  // below this, a recording with no words is most likely the wrong (or a muted) mic
const LOUDEST = 0.7;  // quiet recordings are turned up to this peak before Muse Voice hears them...
const MAX_GAIN = 30;  // ...by at most this much, so room hiss doesn't become a roar
const TAIL_MS = 250;  // keep recording this long after you let go, so the last word isn't clipped
const MIC_KEY = 'djrepo.mic';  // which microphone to use, remembered in this browser
const talk = { stream: null, recorder: null, chunks: [], started: 0, held: false, meter: null, meterCtx: null, label: '' };

function chosenMic() {
  try {
    return localStorage.getItem(MIC_KEY) || '';
  } catch {
    return '';
  }
}

function chooseMic(deviceId) {
  try {
    if (deviceId) localStorage.setItem(MIC_KEY, deviceId);
    else localStorage.removeItem(MIC_KEY);
  } catch {
    // only a convenience
  }
}

// The microphones on this computer: [{ id, name }]. Names only show once the page may use the mic.
async function listMics() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications')
    .map((d, i) => ({ id: d.deviceId, name: d.label || `Microphone ${i + 1}` }));
}

async function openMic() {
  // No echo cancellation or noise suppression: with the music playing, they take quiet speech for
  // echo or noise and leave Muse Voice nothing (tested: a quiet "drop it" came back as no words with
  // them on, and word for word with them off). Muse Voice copes with the ducked music underneath.
  const processing = { echoCancellation: false, noiseSuppression: false, autoGainControl: true };
  const id = chosenMic();
  if (id) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { ...processing, deviceId: { exact: id } } });
    } catch {
      chooseMic('');  // that mic has gone (unplugged): fall back to the default one
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio: processing });
}

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
    stream = await openMic();
  } catch {
    talk.held = false;
    throw new Error('Allow the microphone for this page to use voice commands.');
  }
  if (!talk.held) {  // let go before the mic opened
    closeMic(stream);
    return false;
  }
  talk.stream = stream;
  talk.label = stream.getAudioTracks()[0]?.label || 'the microphone';
  talk.chunks = [];
  startMeter(stream);
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
  const wrongMic = () => new Error(`“${talk.label}” didn't pick up your voice in that ${seconds.toFixed(1)} s (the loudest `
    + `it got was ${percent(peak)} of full volume). Pick the mic you're speaking into under Voice in the mixer (X), and `
    + 'check it isn\'t muted.');
  if (peak < SILENT_PEAK) throw wrongMic();
  const res = await fetch('/api/voice', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Muse Voice Transcribe couldn't write that down.");
  const text = String(data.text || '').trim();
  if (!text && peak < QUIET_PEAK) throw wrongMic();
  if (!text) {
    throw new Error(`Muse Voice heard sound but no words in that ${seconds.toFixed(1)} s. Wait for “Speak now”, then say the `
      + 'command clearly, and let go after you finish.');
  }
  return text;
}

function percent(level) {
  return level < 0.01 ? `${(level * 100).toFixed(1)}%` : `${Math.round(level * 100)}%`;
}

// Whatever the browser recorded, as 16 kHz mono 16-bit PCM WAV (turned up if it came in quiet),
// and how loud it was as recorded.
async function toVoiceWav(blob) {
  const audio = await new OfflineAudioContext(1, VOICE_RATE, VOICE_RATE).decodeAudioData(await blob.arrayBuffer());
  const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c));
  const frames = audio.length;
  const mono = new Float32Array(frames);
  let peak = 0;
  for (let i = 0; i < frames; i++) {
    let v = 0;
    for (const ch of channels) v += ch[i];
    mono[i] = v / channels.length;
    peak = Math.max(peak, Math.abs(mono[i]));
  }
  const gain = peak > 0 ? Math.max(1, Math.min(MAX_GAIN, LOUDEST / peak)) : 1;
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
  for (let i = 0; i < frames; i++) {
    const v = Math.max(-1, Math.min(1, mono[i] * gain));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return { wav: new Blob([view], { type: 'audio/wav' }), peak };
}
