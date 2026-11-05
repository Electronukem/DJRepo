"""The voice benchmark's command rules (a copy of runVoice in web/app.js), on transcripts Muse Voice
Transcribe really returned in benchmark runs. No network."""
import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("voice_benchmark", Path(__file__).parent.parent / "benchmarks" / "voice.py")
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)


@pytest.mark.parametrize("heard, does", [
    ("drop it.", "drop"),
    ("Bring in Facebook React", "bring facebook/react"),
    ("bring in Facebook Facebook React.", "bring facebook/react"),
    ("bring in Torvald's Linux", "bring torvalds/linux"),
    ("bring in facebook research slash segment anything", "bring facebookresearch/segment-anything"),
    ("bring in neovim neovim", "bring neovim/neovim"),
    ("bring it back back.", "unmute"),
    ("mute it,", "mute"),
    ("Turn it up. up.", "louder"),
    ("turn it down.", "quieter"),
    ("drum and bass bass.", "genre dnb"),
    ("Play some trance,", "genre trance"),
    ("Supersolid.", "lead supersaw"),
    ("super solid.", "lead supersaw"),
    ("lights off.", "lights off"),
    ("what a night", "nothing"),
])
def test_a_transcript_does_what_the_set_would(heard, does):
    assert bench.does(heard) == does


def test_every_command_has_a_clip_from_each_voice():
    import json
    commands = json.loads((bench.HERE / "voice" / "commands.json").read_text("utf-8"))
    for command in commands:
        clips = sorted(p.stem for p in (bench.HERE / "voice" / "clips").glob(f"{command['id']}-*.wav"))
        assert clips == [f"{command['id']}-david", f"{command['id']}-zira"]
        assert bench.does(command["say"]) == command["does"]
