"""Voice commands: what goes to Muse Voice Transcribe, and what comes back. No network: the API is stubbed."""
import io
import json
import struct

import pytest

import voice
from common import BuildError


def wav(seconds=0.5, rate=16000):
    frames = int(seconds * rate)
    header = b"RIFF" + struct.pack("<I", 36 + frames * 2) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
    return header + b"data" + struct.pack("<I", frames * 2) + b"\0\0" * frames


@pytest.fixture(autouse=True)
def private_log(tmp_path, monkeypatch):
    monkeypatch.setattr(voice, "LOG", tmp_path / "voice.log")
    return tmp_path / "voice.log"


def test_the_log_has_numbers_about_a_recording_never_the_audio():
    loud = wav(1.0)[:-4] + struct.pack("<hh", 16384, -16384)
    info = voice.describe(loud)
    assert info == {"seconds": 1.0, "rate": 16000, "peak": 0.5, "rms": 0.0056}
    assert voice.describe(b"not a wav") == {}


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_sends_a_push_to_talk_request_and_returns_the_words(monkeypatch):
    monkeypatch.setenv("MODEL_API_KEY", "test-key")
    sent = {}

    def fake_urlopen(req, timeout):
        sent["url"], sent["headers"], sent["body"] = req.full_url, dict(req.header_items()), req.data
        return Response(json.dumps({"transcript": " drop it. ", "sessionId": "s1", "turns": []}).encode())

    monkeypatch.setattr(voice.urllib.request, "urlopen", fake_urlopen)
    assert voice.transcribe(wav()) == "drop it."
    assert sent["url"] == "https://api.meta.ai/v1/asr/transcribe"
    assert sent["headers"]["Authorization"] == "Bearer test-key"
    assert sent["headers"]["Content-type"].startswith("multipart/form-data; boundary=")
    assert b'"model": "muse-voice-transcribe-1.0"' in sent["body"]
    assert b'"mode": "PUSH_TO_TALK"' in sent["body"]
    assert b'name="audio"; filename="voice.wav"' in sent["body"]


def test_needs_a_key(monkeypatch):
    monkeypatch.delenv("MODEL_API_KEY", raising=False)
    with pytest.raises(BuildError, match="MODEL_API_KEY"):
        voice.transcribe(wav())


def test_only_wav_goes_out(monkeypatch):
    monkeypatch.setenv("MODEL_API_KEY", "test-key")
    with pytest.raises(BuildError, match="WAV"):
        voice.transcribe(b"OggS" + b"\0" * 100)
