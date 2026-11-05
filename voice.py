"""Voice commands: a few seconds of the DJ's voice, written down by Meta's Muse Voice Transcribe
(through the Meta Model API), so "drop it" or "bring in facebook react" works hands-free. The browser
records and converts to the WAV the API wants (16 kHz mono 16-bit PCM); this adds the key and sends it.
"""
from __future__ import annotations

import array
import json
import math
import os
import time
import urllib.error
import urllib.request
import uuid

from common import CACHE_DIR, BuildError
from gigs import USER_AGENT, _http_problem

LOG = CACHE_DIR / "voice.log"  # numbers about each recording (never the audio), for working out why one failed


def describe(wav: bytes) -> dict:
    """How long and how loud a 16-bit PCM WAV is, for the log."""
    try:
        rate = int.from_bytes(wav[24:28], "little")
        channels = int.from_bytes(wav[22:24], "little") or 1
        data = wav.find(b"data")
        samples = array.array("h", wav[data + 8: data + 8 + (len(wav) - data - 8) // 2 * 2])
        if not samples:
            return {"seconds": 0}
        peak = max(abs(v) for v in samples) / 32768
        rms = math.sqrt(sum(v * v for v in samples) / len(samples)) / 32768
        return {"seconds": round(len(samples) / channels / rate, 2), "rate": rate, "peak": round(peak, 3), "rms": round(rms, 4)}
    except (ValueError, ZeroDivisionError):
        return {}


def log(entry: dict) -> None:
    try:
        LOG.parent.mkdir(parents=True, exist_ok=True)
        with LOG.open("a", encoding="utf-8") as f:
            f.write(json.dumps({"at": time.strftime("%H:%M:%S"), **entry}) + "\n")
    except OSError:
        pass  # the log is only a help

MODEL = "muse-voice-transcribe-1.0"
MAX_BYTES = 4_000_000  # about two minutes at 16 kHz; push-to-talk is a few seconds


def transcribe(wav: bytes) -> str:
    """The words in a WAV recording."""
    key = os.environ.get("MODEL_API_KEY")
    if not key:
        raise BuildError("Voice commands need MODEL_API_KEY in .env (from dev.meta.ai). Restart DJRepo after adding it.")
    if len(wav) < 44 or wav[:4] != b"RIFF" or wav[8:12] != b"WAVE":
        raise BuildError("That recording wasn't a WAV file.")
    settings = {"model": os.environ.get("META_VOICE_MODEL", MODEL), "audioEncoding": "WAV", "mode": "PUSH_TO_TALK",
                "languageBias": ["English"]}
    boundary = uuid.uuid4().hex
    body = b"".join([
        f'--{boundary}\r\nContent-Disposition: form-data; name="request"\r\nContent-Type: application/json\r\n\r\n'.encode(),
        json.dumps(settings).encode(), b"\r\n",
        f'--{boundary}\r\nContent-Disposition: form-data; name="audio"; filename="voice.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode(),
        wav, b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ])
    base = os.environ.get("META_API_BASE", "https://api.meta.ai/v1").rstrip("/")
    req = urllib.request.Request(f"{base}/asr/transcribe", data=body, method="POST", headers={
        "Authorization": f"Bearer {key}",
        "Content-Type": f"multipart/form-data; boundary={boundary}",
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
    })
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            data = json.loads(res.read())
    except urllib.error.HTTPError as exc:
        problem = _http_problem("Muse Voice Transcribe", exc)
        log({**describe(wav), "error": problem})
        raise BuildError(problem) from exc
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        log({**describe(wav), "error": str(exc)})
        raise BuildError(f"Couldn't reach Muse Voice Transcribe ({exc}).") from exc
    text = str(data.get("transcript") or "").strip()
    log({**describe(wav), "transcript": text, "audioDurationMs": data.get("audioDurationMs"),
         "secondsToAnswer": round(time.time() - started, 2)})
    return text
