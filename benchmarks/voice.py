"""Benchmarks voice commands: twelve commands, each spoken by two voices, sent to Meta's Muse Voice
Transcribe the way DJRepo sends them, under three conditions a DJ meets:

  clean   the command as spoken
  quiet   a laptop mic far away: the recording at 2% of full volume, then turned up the way the
          browser does it before sending (web/voice.js), hiss and all
  music   the set playing underneath: a 124 BPM kick, bass and hats at -12 dB under the voice,
          about what a mic hears from the speakers while the music is ducked

A command counts as right only if the transcript would make the set do the right thing, using the
same rules, in the same order, as runVoice in web/app.js. Needs MODEL_API_KEY in .env; costs about a
cent (two and a half minutes of audio at $0.18 an hour).

  python benchmarks/voice.py            # all three conditions
  python benchmarks/voice.py clean      # just one

Results go to benchmarks/results/voice.json.
"""
from __future__ import annotations

import array
import json
import math
import random
import re
import statistics
import sys
import time
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))

import voice  # noqa: E402  (after the path, so it runs from anywhere)
from server import load_env  # noqa: E402

RATE = 16000
CONDITIONS = ("clean", "quiet", "music")

# runVoice in web/app.js, in its order: the first rule that matches is what the set does.
GENRES = [("drum and bass", "dnb"), ("drum n bass", "dnb"), ("drum & bass", "dnb"), ("dnb", "dnb"), ("jungle", "dnb"),
          ("big room", "bigroom"), ("bigroom", "bigroom"), ("techno", "techno"), ("trance", "trance"), ("house", "house")]
SPOKEN_LEADS = {"super saw": "supersaw", "supersolid": "supersaw", "super solid": "supersaw", "8 bit": "chip",
                "eight bit": "chip"}
LEADS = {"pluck": "pluck", "supersaw": "supersaw", "fm bell": "bell", "bell": "bell", "8-bit": "chip", "chip": "chip",
         "acid": "acid"}


def spoken_repo(words: str) -> str | None:
    """spokenRepo in web/app.js: "facebook react" is facebook/react."""
    w = re.sub(r"['’]", "", words)
    w = re.sub(r"\s+dot\s+", ".", re.sub(r"\s+dash\s+", "-", re.sub(r"\s+slash\s+", "/", w))).strip()
    if "/" in w:
        owner, *rest = w.split("/")
        return re.sub(r"\s+", "", owner) + "/" + re.sub(r"\s+", "-", "/".join(rest).strip())
    parts = w.split()
    if len(parts) >= 3:  # a word Muse Voice wrote twice; a repo named for its owner ("neovim neovim") stays
        parts = [part for i, part in enumerate(parts) if i == 0 or part != parts[i - 1]]
    return f"{parts[0]}/{'-'.join(parts[1:])}" if len(parts) >= 2 else None


def does(text: str) -> str:
    """What the set would do on hearing this."""
    said = " " + re.sub(r"\s+", " ", re.sub(r"[“”\"!?,]|\.(?=\s|$)", " ", text.lower())).strip() + " "
    bring = re.search(r"\b(?:bring in|bring on|add|battle|versus|vs)\s+(.+?)\s*$", said)
    if bring:
        return f"bring {spoken_repo(bring.group(1))}"
    rules = [("drop", r"\b(drop|sync|let it go|hit it|send it)\b"), ("unmute", r"\b(unmute|sound on|bring it back)\b"),
             ("mute", r"\b(mute|silence|kill it|sound off)\b"), ("louder", r"\b(louder|turn it up|volume up|pump it up)\b"),
             ("quieter", r"\b(quieter|softer|turn it down|volume down)\b")]
    for name, rule in rules:
        if re.search(rule, said):
            return name
    for words, genre in GENRES:
        if f" {words} " in said:
            return f"genre {genre}"
    for words, lead in {**SPOKEN_LEADS, **LEADS}.items():
        if f" {words} " in said:
            return f"lead {lead}"
    lights = re.search(r"\b(?:lights|flashes|strobe) (off|on)\b", said)
    if lights:
        return f"lights {lights.group(1)}"
    return "nothing"


def read(path: Path) -> list[float]:
    with wave.open(str(path)) as w:
        assert w.getframerate() == RATE and w.getnchannels() == 1 and w.getsampwidth() == 2, path
        return [v / 32768 for v in array.array("h", w.readframes(w.getnframes()))]


def to_wav(samples: list[float]) -> bytes:
    pcm = array.array("h", (max(-32768, min(32767, round(v * 32767))) for v in samples)).tobytes()
    return (b"RIFF" + (36 + len(pcm)).to_bytes(4, "little") + b"WAVEfmt " + (16).to_bytes(4, "little")
            + (1).to_bytes(2, "little") + (1).to_bytes(2, "little") + RATE.to_bytes(4, "little")
            + (RATE * 2).to_bytes(4, "little") + (2).to_bytes(2, "little") + (16).to_bytes(2, "little")
            + b"data" + len(pcm).to_bytes(4, "little") + pcm)


def quiet(samples: list[float]) -> list[float]:
    """At 2% of full volume through a 16-bit mic, then turned up as web/voice.js does (to 0.7, at most 30x)."""
    peak = max(map(abs, samples)) or 1
    far = [round(v * 0.02 / peak * 32767) / 32767 for v in samples]
    gain = max(1, min(30, 0.7 / (max(map(abs, far)) or 1)))
    return [v * gain for v in far]


def beat(n: int, seed: int = 7) -> list[float]:
    """A 124 BPM four-on-the-floor loop: kick on the beat, bass and an open hat off it."""
    noise = random.Random(seed)
    step = 60 / 124
    out = []
    for i in range(n):
        t = i / RATE
        b = t % step
        off = (t + step / 2) % step
        kick = math.sin(2 * math.pi * (50 * b + 400 * (1 - math.exp(-b * 30)) / 30)) * math.exp(-b * 9)
        bass = (2 * ((55 * t) % 1) - 1) * 0.5 * math.exp(-off * 6)
        hat = (noise.random() * 2 - 1) * 0.3 * math.exp(-off * 40)
        out.append(kick + bass + hat)
    return out


def with_music(samples: list[float]) -> list[float]:
    def rms(xs):
        return math.sqrt(sum(v * v for v in xs) / len(xs))
    spoken = [v for v in samples if abs(v) > 0.02] or samples
    music = beat(len(samples))
    level = rms(spoken) * 10 ** (-12 / 20) / rms(music)
    mixed = [v + m * level for v, m in zip(samples, music)]
    peak = max(map(abs, mixed))
    return [v / peak * 0.9 for v in mixed] if peak > 0.9 else mixed


def run(conditions) -> dict:
    commands = json.loads((HERE / "voice" / "commands.json").read_text("utf-8"))
    rows = []
    for condition in conditions:
        for command in commands:
            for clip in sorted((HERE / "voice" / "clips").glob(f"{command['id']}-*.wav")):
                samples = read(clip)
                samples = {"clean": lambda s: s, "quiet": quiet, "music": with_music}[condition](samples)
                started = time.perf_counter()
                try:
                    heard = voice.transcribe(to_wav(samples))
                except Exception as exc:  # noqa: BLE001  (a failed call is a wrong answer, and the run goes on)
                    heard = f"[error: {exc}]"
                seconds = time.perf_counter() - started
                result = does(heard)
                rows.append({"condition": condition, "clip": clip.name, "said": command["say"], "heard": heard,
                             "does": result, "right": result == command["does"], "seconds": round(seconds, 2)})
                mark = "ok  " if rows[-1]["right"] else "MISS"
                print(f"{mark} {condition:5} {clip.stem:14} {seconds:4.2f} s  “{heard}” → {result}")
    summary = {}
    for condition in conditions:
        mine = [r for r in rows if r["condition"] == condition]
        times = sorted(r["seconds"] for r in mine)
        summary[condition] = {"right": sum(r["right"] for r in mine), "of": len(mine),
                              "accuracy": round(sum(r["right"] for r in mine) / len(mine), 3),
                              "median_s": round(statistics.median(times), 2),
                              "p95_s": round(times[min(len(times) - 1, math.ceil(0.95 * len(times)) - 1)], 2)}
    return {"model": voice.MODEL, "ran": time.strftime("%Y-%m-%d"), "summary": summary, "rows": rows}


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")  # the quotes and arrows, on a Windows console too
    load_env(ROOT / ".env")
    conditions = [c for c in sys.argv[1:] if c in CONDITIONS] or list(CONDITIONS)
    results = run(conditions)
    out = HERE / "results" / "voice.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(results, indent=1, ensure_ascii=False) + "\n", "utf-8", newline="\n")
    print("\n| Condition | Right | Accuracy | Median | p95 |\n| --- | --- | --- | --- | --- |")
    for condition, s in results["summary"].items():
        print(f"| {condition} | {s['right']} of {s['of']} | {s['accuracy']:.0%} | {s['median_s']:.2f} s | {s['p95_s']:.2f} s |")


if __name__ == "__main__":
    main()
