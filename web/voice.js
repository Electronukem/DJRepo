// Push to talk. Hold V (or the mic button), say what you want, let go: the recording becomes the
// WAV Muse Voice Transcribe wants (16 kHz, mono, 16-bit) and goes through the DJRepo server, which
// holds the key, to Meta's Model API. It comes back as text. Shared by the show and the control deck.

'use strict';

const VOICE_RATE = 16000;
const talk = { stream: null, recorder: null, chunks: [], started: 0 };

async function talkStart() {
  if (talk.recorder) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    throw new Error("This browser can't record from a microphone.");
  }
  if (!talk.stream) {
    try {
      talk.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      throw new Error('Allow the microphone for this page to use voice commands.');
    }
  }
  talk.chunks = [];
  talk.recorder = new MediaRecorder(talk.stream);
  talk.recorder.ondataavailable = (e) => {
    if (e.data.size) talk.chunks.push(e.data);
  };
  talk.recorder.start();
  talk.started = performance.now();
}

function talking() {
  return Boolean(talk.recorder);
}

// Stop recording and write it down. Resolves to the words ('' if it was too short to be speech).
async function talkStop() {
  const recorder = talk.recorder;
  if (!recorder) return '';
  talk.recorder = null;
  const stopped = new Promise((resolve) => {
    recorder.onstop = resolve;
  });
  recorder.stop();
  await stopped;
  if (performance.now() - talk.started < 350) return '';
  const wav = await toVoiceWav(new Blob(talk.chunks, { type: recorder.mimeType }));
  const res = await fetch('/api/voice', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Muse Voice Transcribe couldn't write that down.");
  return String(data.text || '').trim();
}

// Whatever the browser recorded, as 16 kHz mono 16-bit PCM WAV.
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
  for (let i = 0; i < frames; i++) {
    let v = 0;
    for (const ch of channels) v += ch[i];
    v = Math.max(-1, Math.min(1, v / channels.length));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Blob([view], { type: 'audio/wav' });
}
