# DJRepo

Turn a GitHub repository into an EDM set with a light show.
[graphify](https://github.com/Graphify-Labs/graphify) maps the code into a graph, the repository's
history picks the genre, key and tempo, and your commits drop on the beat while the camera slams in
and out with the kick.

A sibling of [Mindfulness](https://github.com/Electronukem/Mindfulness), which does the same thing
calmly.

## Setup

You need Python 3.11+ and git.

```
python -m venv .venv
.venv\Scripts\pip install graphifyy
```

(The PyPI name is `graphifyy` with two y's. On macOS or Linux use `.venv/bin/pip`.) Code is parsed
locally, so no AI model or API key is needed.

## Run

```
python server.py
```

On Windows, double-click `start.bat` instead. It uses the project's `.venv` if there is one. A browser
tab opens at http://127.0.0.1:8777. Paste a public repository (`https://github.com/owner/repo`,
`owner/repo`, or a `/tree/<branch>` link) and press **Drop it**.

| Key | Does |
| --- | --- |
| D | Skip to the next drop (a four-bar build-up, then the drop) |
| X | Mixer: genre, lead synth, channels and visuals |
| F | Full screen |
| M | Mute |

The controls fade after a few seconds without mouse movement.

Options: `python server.py --port 9000 --max-nodes 800 --no-browser`

**Contains flashing lights** when a drop lands. Switch them off on the start screen or in the mixer.
If your system asks for reduced motion, they start off, the camera moves far less, and the lasers and
shake are off.

## The set

The set runs in phrases: an intro, then a loop of groove → build-up → drop → breakdown → build-up →
drop. Each phrase is eight bars, and drops are sixteen.

- **Intro.** Kick and hats with the filter slowly opening; the camera creeps in.
- **Groove.** The full beat with the chords filtered down. A commit drops every other bar.
- **Build-up.** A snare roll that speeds from quarters to sixteenths, a noise riser, a rising high-pass
  filter, and lasers starting to sweep. The kick drops out for the last stretch, then one beat of
  silence: the screen goes dark and the camera is pushed all the way in.
- **Drop.** An impact and a white flash, the camera smash-cuts out, and everything plays. Every kick
  punches the camera in and shakes it, shockwaves ring out, and lasers fan up from the floor. The
  camera alternates bar by bar between a wide shot and a close-up of the code the latest commit
  touched. A commit drops every bar.
- **Breakdown.** No drums. Pads swell, the camera drifts back out, and the stars slow to a crawl.

Every commit fires as a riff: the nodes for the files it touched play in the genre's hook rhythm, their
names glitch in, and the commit message shows as *Now playing* (*Dropping* in a drop). Between commits,
light travels along the graph's edges and plays the lead as it lands. Each cluster's colour picks the
note, height on screen picks the octave, and left–right is the stereo position.

## How the repository picks the music

| From the repository | Becomes |
| --- | --- |
| Commits per week | 35 or more is **drum & bass**; otherwise it sets the tempo within the genre's range |
| Time of day of the commits | Mostly after dark (9pm–6am) is **techno**. Daytime work is in a major key, later work in minor |
| Main language | Web code (JS/TS/CSS…) is **big room**, systems code (C, Rust, Go, Java…) is **trance**, everything else is **house** |
| Main language | The lead synth: FM bell (Python and similar), pluck (web), supersaw (systems), 8-bit (anything else) |
| Size of the graph | How long the reverb rings |
| How connected the code is | How often light leaps between nodes |
| Repository name | Key and chord progression |

**Why** in the controls lists the reasons for the repository on screen.

## The mixer

Press **X** or click **Mixer**. Choices are remembered in this browser.

- **Genre**: from your repo, house, techno, trance, big room, or drum & bass. Switching brings the new
  genre in with a build-up and a drop.
- **Lead synth**: the sound the graph plays (pluck, supersaw, FM bell, 8-bit or acid).
- **Channels**: kick, clap & snare, hi-hats, percussion, bass, chords, pad, arpeggio, the lead, and
  risers & impacts, each with an on/off switch and a volume. Bass, chords, pad and arpeggio pump
  under the kick (sidechain).
- **Visuals**: camera intensity (how hard it punches, pushes, spins and shakes) and flashing lights.

Everything is synthesised in the browser with Web Audio (no samples), and the channels are
level-matched so any mix stays balanced.

## Notes

- Results are cached in `.cache/`, so anything you've played before opens instantly from the chips on
  the start screen. Delete `.cache/` to reclaim disk space.
- Only public repositories work, because nothing asks for GitHub credentials.
- Very large graphs are trimmed to the most connected 1,500 nodes (`--max-nodes`).
- The page loads d3 from cdnjs and fonts from Google Fonts, so it needs an internet connection.
- The server listens only on 127.0.0.1.
