"""Voice commands: a few seconds of the DJ's voice, written down by Meta's Muse Voice Transcribe
(through the Meta Model API), so "drop it" or "bring in facebook react" works hands-free. The browser
records and converts to the WAV the API wants (16 kHz mono 16-bit PCM); this adds the key and sends it.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
import uuid

from common import BuildError
from gigs import USER_AGENT, _http_problem

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
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            data = json.loads(res.read())
    except urllib.error.HTTPError as exc:
        raise BuildError(_http_problem("Muse Voice Transcribe", exc)) from exc
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        raise BuildError(f"Couldn't reach Muse Voice Transcribe ({exc}).") from exc
    return str(data.get("transcript") or "").strip()
