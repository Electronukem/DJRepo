"""Cover art for a pitch's clip: what goes to Muse Image, and the cache. No network: the API is stubbed."""
import base64
import io
import json

import pytest

import cover
from common import BuildError

WEBP = b"RIFF\x10\x00\x00\x00WEBPVP8 " + b"\0" * 8


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setattr(cover, "COVERS", tmp_path / "covers")
    monkeypatch.setenv("MODEL_API_KEY", "test-key")
    calls = []

    def fake_urlopen(req, timeout):
        calls.append({"url": req.full_url, "headers": dict(req.header_items()), "body": json.loads(req.data)})
        return Response(json.dumps({"data": [{"b64_json": base64.b64encode(WEBP).decode()}], "output_format": "webp"}).encode())

    monkeypatch.setattr(cover.urllib.request, "urlopen", fake_urlopen)
    return calls


def test_paints_a_cover_with_muse_image_and_keeps_it(api):
    assert cover.paint("electronukem/DJRepo", "techno") == WEBP
    assert api[0]["url"] == "https://api.meta.ai/v1/images/generations"
    assert api[0]["headers"]["Authorization"] == "Bearer test-key"
    assert api[0]["body"]["model"] == "muse-image-1.0"
    assert api[0]["body"]["n"] == 1
    assert "techno" in api[0]["body"]["prompt"] and "No text" in api[0]["body"]["prompt"]
    assert cover.paint("Electronukem/djrepo", "techno") == WEBP  # the same repo, any case: from the cache
    assert len(api) == 1
    cover.paint("electronukem/DJRepo", "house")  # another genre is another cover
    assert len(api) == 2
    assert cover.mime(WEBP) == "image/webp"


def test_every_genre_has_a_look():
    for genre in ["house", "techno", "trance", "bigroom", "dnb"]:
        assert cover.LOOKS[genre] and "No text" in cover.prompt(genre)


def test_only_known_genres(api):
    with pytest.raises(BuildError, match="genre"):
        cover.paint("a/b", "a prompt of your own")
    assert not api


def test_needs_a_key(tmp_path, monkeypatch):
    monkeypatch.setattr(cover, "COVERS", tmp_path / "covers")
    monkeypatch.delenv("MODEL_API_KEY", raising=False)
    with pytest.raises(BuildError, match="MODEL_API_KEY"):
        cover.paint("a/b", "house")


def test_something_that_isnt_an_image_is_refused(tmp_path, monkeypatch):
    monkeypatch.setattr(cover, "COVERS", tmp_path / "covers")
    monkeypatch.setenv("MODEL_API_KEY", "test-key")
    monkeypatch.setattr(cover.urllib.request, "urlopen", lambda req, timeout: Response(
        json.dumps({"data": [{"b64_json": base64.b64encode(b"<html>nope</html>").decode()}]}).encode()))
    with pytest.raises(BuildError, match="wasn't an image"):
        cover.paint("a/b", "house")
    assert not (tmp_path / "covers").exists() or not any((tmp_path / "covers").iterdir())
