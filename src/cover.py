"""Cover art for the clip in a gig pitch, painted by Meta's Muse Image (through the Meta Model API).
Mixes go out with artwork, so the clip does too: the browser writes it into the MP3's tag, and the
promoter's player shows it. One cover per repo and genre, kept in .cache/covers ($0.01 each).
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import urllib.error
import urllib.request

from common import CACHE_DIR, BuildError
from gigs import USER_AGENT, _http_problem

MODEL = "muse-image-1.0"
COVERS = CACHE_DIR / "covers"

# What a night of each genre looks like, in the light show's colour for it.
LOOKS = {
    "house": "warm magenta and amber light in a packed basement club at 2 a.m., glints from a mirror ball",
    "techno": "cold cyan strobes cutting through haze in a concrete warehouse, stark and minimal",
    "trance": "violet and electric-blue laser fans over an open-air festival crowd at dusk",
    "bigroom": "purple and gold pyrotechnics and confetti over a festival main stage, arms in the air",
    "dnb": "hot orange and red light, smoke and motion blur in a dark, packed rave",
}


def prompt(genre: str) -> str:
    return (f"Square cover art for a DJ's {genre_name(genre)} mix: {LOOKS[genre]}. A glowing constellation of connected "
            "nodes, like a graph of code, hangs over the crowd. Photographic, cinematic, high contrast. "
            "No text, no letters, no logos.")


def genre_name(genre: str) -> str:
    return {"bigroom": "big room", "dnb": "drum & bass"}.get(genre, genre)


def paint(repo: str, genre: str) -> bytes:
    """The cover for a repo's clip in a genre, as WebP: from the cache, or painted now (10-20 s)."""
    if genre not in LOOKS:
        raise BuildError("There's no cover for that genre.")
    text = prompt(genre)
    path = COVERS / f"{genre}-{hashlib.sha1(f'{repo.lower()}|{text}'.encode()).hexdigest()[:16]}.webp"
    try:
        return path.read_bytes()
    except OSError:
        pass
    key = os.environ.get("MODEL_API_KEY")
    if not key:
        raise BuildError("Cover art needs MODEL_API_KEY in .env (from dev.meta.ai).")
    base = os.environ.get("META_API_BASE", "https://api.meta.ai/v1").rstrip("/")
    req = urllib.request.Request(f"{base}/images/generations", method="POST",
                                 data=json.dumps({"model": os.environ.get("META_IMAGE_MODEL", MODEL), "prompt": text, "n": 1}).encode(),
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json",
                                          "Accept": "application/json", "User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            data = json.loads(res.read())
        image = base64.b64decode(data["data"][0]["b64_json"])
    except urllib.error.HTTPError as exc:
        raise BuildError(_http_problem("Muse Image", exc)) from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise BuildError(f"Couldn't reach Muse Image ({exc}).") from exc
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise BuildError("Muse Image sent back something that wasn't an image.") from exc
    if not image.startswith(b"RIFF") and not image.startswith(b"\x89PNG") and not image.startswith(b"\xff\xd8"):
        raise BuildError("Muse Image sent back something that wasn't an image.")
    try:
        COVERS.mkdir(parents=True, exist_ok=True)
        path.write_bytes(image)
    except OSError:
        pass  # the cache is only a saving
    return image


def mime(image: bytes) -> str:
    if image.startswith(b"\x89PNG"):
        return "image/png"
    if image.startswith(b"\xff\xd8"):
        return "image/jpeg"
    return "image/webp"
