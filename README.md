<div align="center">

# DJRepo

**Your GitHub repo, played as a live EDM set with a light show.**<br>
Battle two repos, or your code against a song. Bring in challengers mid-set. Then let Meta's Muse Spark find you a real gig.

[![Built with Meta Muse Spark and Muse Voice](https://img.shields.io/badge/Built%20with-Meta%20Muse%20Spark%20%C2%B7%20Muse%20Voice-0866FF)](#built-with-meta)
[![Search grounding](https://img.shields.io/badge/Meta%20Model%20API-search%20grounding%20%C2%B7%20structured%20output-4d94ff)](#built-with-meta)
[![CI](https://github.com/Electronukem/DJRepo/actions/workflows/ci.yml/badge.svg)](https://github.com/Electronukem/DJRepo/actions/workflows/ci.yml)
[![Live demo](https://img.shields.io/badge/live%20demo-no%20install-ff3fa4)](https://electronukem.github.io/DJRepo/)
[![Demo video](https://img.shields.io/badge/demo%20video-YouTube-ff0000)](https://youtu.be/KD7RH4Gqm4Y)
![MIT license](https://img.shields.io/badge/license-MIT-3fd2ff)

### [▶ Play the live demo](https://electronukem.github.io/DJRepo/) · [🎬 Watch the 3-minute demo](https://youtu.be/KD7RH4Gqm4Y)

<img src="docs/screenshots/new-contender.webp" alt="A song called Meta Global AI Hackathon 2026 slams into the set under a full-screen 'A NEW CONTENDER HAS ARRIVED' title card" width="100%">

</div>

**Why it matters.** Independent DJs spend hours digging into venues, finding out who books them, and
writing cold pitches that mostly go unread. DJRepo does that research with Meta's Muse Spark, checks
the booking contact against real pages, and hands you a pitch in your own voice, with a clip of your
set attached, in about two minutes. And it makes code something you can hear and see: your commit
history, played as a set.

## Watch it

<a href="https://youtu.be/KD7RH4Gqm4Y"><img src="https://img.youtube.com/vi/KD7RH4Gqm4Y/maxresdefault.jpg" alt="DJRepo demo video on YouTube: a repo battles a song, a voice command drops the set, and Muse Spark drafts a gig pitch" width="100%"></a>

[The 3-minute demo on YouTube](https://youtu.be/KD7RH4Gqm4Y): a repo battling a song, a drop by voice
with Muse Voice Transcribe, and Muse Spark finding a real gig in Boston and drafting the pitch.

## Try it

**In your browser:** the [live demo](https://electronukem.github.io/DJRepo/) plays five pre-built
repos (two of them Meta's: `meta-llama/llama` and `facebookresearch/segment-anything`), battles,
and song battles, with a demo song made by DJRepo. Nothing to install.

**Everything, on your machine:** any public repo, plus the gig finder.

```sh
docker compose up --build
```

Open **http://localhost:8777**, paste a public repo, and press **Drop it**. Turn it up. The set and
the light show need no keys. The gig finder needs two ([Keys](#keys)).

## The 60-second tour

1. **Drop it.** [graphify](https://github.com/Graphify-Labs/graphify) maps the repo's code into a
   constellation, and its history picks the genre, key and tempo. Commits fire as riffs on the beat
   while the camera slams in and out with the kick.
2. **Battle.** Two repos take eight-bar rounds in their own genres and throw punches on every kick.
   Press **D** and they sync up: they trade bars, their tempos meet, and they land in one mashup drop.
3. **Battle a song.** Drop in an MP3 instead of a second repo, and your code fights it. DJRepo
   listens to the song in your browser, finds its tempo, bars and key, and draws it as a graph of its
   own: every beat a star, sounds that match in the same colour, and repeats linked together.
4. **A new contender.** Press **A** mid-set and paste another repo, or drop in a song. The music never
   stops: *"Meta is cooking"* while it loads, then the room builds up, a title card slams in, and the
   newcomer crashes onto the stage on the drop. Winner stays on.
5. **Talk to the decks.** Hold **V** (or the mic button) and say "drop it", "techno", "louder" or
   "bring in facebook react". Meta's **Muse Voice Transcribe** writes it down in about a second, the
   decks do it, and the screen shows what it heard. The music dips while you talk.
6. **The control deck.** Press **C** to move every control to a second window, so the show stays
   full screen and clean on the big screen while you DJ from your laptop.
7. **Find a gig.** Real upcoming dance and electronic nights on a map (it opens on Boston). Pick one
   and **Muse Spark** researches the room, the night and who books it, then drafts a booking email
   in your voice with a clip of your set attached. It works mid-set too: press **G** (or **Find a gig** in the
   controls) and the music keeps playing underneath while you look.

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/battle.webp" alt="A repo battling a song: the song's graph lights up beat by beat, each star labelled with its time in the song"></td>
    <td width="50%"><img src="docs/screenshots/find-a-gig.webp" alt="The gig finder: 100 real upcoming events around Boston on a dark map"></td>
  </tr>
  <tr>
    <td align="center"><b>Battle a song:</b> every beat of it is a star</td>
    <td align="center"><b>Find a gig:</b> real nights around Boston</td>
  </tr>
</table>

## What you see

![Wireframe of DJRepo's three windows: the show, the control deck and the gig finder](docs/wireframe.svg)

## Built with Meta

DJRepo uses two Meta models through the [Meta Model API](https://dev.meta.ai): **Muse Spark**
(`muse-spark-1.3`) for the gig finder, and **Muse Voice Transcribe** (`muse-voice-transcribe-1.0`) for
voice commands. Each step uses a different part of the platform:

| Step | Meta Model API | What it does |
| --- | --- | --- |
| **Research** | Muse Spark: Responses API + `web_search` (search grounding), `reasoning.effort: low` | Looks into the venue, the night, the promoter and how they take bookings, with citations |
| **Facts** | Muse Spark: Chat Completions + strict `json_schema` | Pulls out the room, the night, a current detail a regular would know, the booking contact and the genre that fits |
| **Write** | Muse Spark: Chat Completions, `reasoning_effort: medium` | Writes 70–130 words in the DJ's own voice, then rewrites once if any template phrase slips in |
| **Voice** | Muse Voice Transcribe: `asr/transcribe`, push to talk | Turns "drop it" or "bring in facebook react" into an action on the decks in about a second |

Then DJRepo renders a clip of your repo's set in the genre Muse Spark picked (a four-bar build-up
into a sixteen-bar drop, MP3), and **Email them** opens the draft in your own mail app with the clip
saved to attach.

**Honest by design.** A booking address is only used if it's really on a page DJRepo read. When
fabric's FAQ listed `events@` for *private hire*, it was ruled out. Names are only used if a source
names them. Claims about the DJ come only from their profile. If a venue says how it takes demos,
the draft follows it. Nothing is ever sent for you: you read it, attach the clip, and press send.

## How it works

![Tech stack: the browser, the DJRepo server, and the services it calls, with Meta's Muse Spark highlighted](docs/tech-stack.svg)

Everything musical happens in the browser: there are no samples, and every kick, chord and riser is
synthesised with Web Audio. The Python server clones the repo, runs graphify, and hands the browser
a compact *scene*: the trimmed graph, the commit history to replay, and stats about how the code was
written.

### How the repository picks the music

| From the repository | Becomes |
| --- | --- |
| Commits per week | 35 or more is **drum & bass**; otherwise it sets the tempo within the genre's range |
| Time of day of the commits | Mostly after dark (9pm–6am) is **techno**. Daytime work is in a major key, later work in minor |
| Main language | Web code (JS/TS/CSS…) is **big room**, systems code (C, Rust, Go, Java…) is **trance**, everything else is **house** |
| Main language | The lead synth: FM bell (Python and similar), pluck (web), supersaw (systems), 8-bit (anything else) |
| Size of the graph | How long the reverb rings |
| How connected the code is | How often light leaps between nodes |
| Repository name | Key and chord progression |

Every commit fires as a riff: the code it touched plays in the genre's hook rhythm, its names
glitch onto the screen, and the commit message shows as *Now playing*. Between commits, light
travels along the graph's edges and plays the lead as it lands. Each cluster's colour picks the
note, its height on screen the octave, and left to right is where you hear it. **Why** in the
controls lists the reasons for the repo on screen.

<details>
<summary><b>The set, phrase by phrase</b></summary>

The set runs in phrases: an intro, then a loop of groove → build-up → drop → breakdown → build-up →
drop. Each phrase is eight bars, and drops are sixteen.

- **Intro.** Kick and hats with the filter slowly opening; the camera creeps in.
- **Groove.** The full beat with the chords filtered down. A commit drops every other bar.
- **Build-up.** A snare roll that speeds from quarters to sixteenths, a noise riser, a rising high-pass
  filter, and lasers starting to sweep. The kick drops out, then one beat of silence: the screen goes
  dark and the camera is pushed all the way in.
- **Drop.** An impact and a white flash, the camera smash-cuts out, and everything plays. Every kick
  punches the camera in, shockwaves ring out, and lasers fan up from the floor. The camera alternates
  bar by bar between a wide shot and a close-up of the code the latest commit touched.
- **Breakdown.** No drums. Pads swell, the camera drifts back out, and the stars slow to a crawl.

</details>

<details>
<summary><b>Battles, syncs and the mashup drop</b></summary>

With two repos, each is a deck with its own genre, key and tempo, and its graph takes a corner.

- **Rounds.** Eight bars each, in each deck's own genre: house against drum & bass, say. Their tempos
  meet in the middle, to within 3% of each other (house at 124 and drum & bass at 172 play 146 and
  150), so the hand-over between rounds doesn't lurch. Against a song, the repo comes to the song's
  tempo instead. The deck that's playing leans in; the other backs off and dims.
- **Punches.** Every kick and clap throws a comet at the other graph and knocks it back. The meter at
  the top swings toward whoever is landing more.
- **Sync (D).** The decks trade a bar each, then half bars, beats and eighth notes, while their tempos
  glide to meet and the second deck moves into the first deck's key. The graphs circle in.
- **One drop.** The graphs spiral together and land as one double constellation in a sixteen-bar
  mashup drop: drums from one repo, bass and chords from the other (pick who brings what under
  **Mashup** in the mixer). Lightning jumps between them on every kick.

</details>

<details>
<summary><b>Battling a song</b></summary>

Pick **♪ or a song** next to the second repo box, or drop an audio file anywhere on the page (MP3,
WAV, M4A, OGG or FLAC). It's decoded and listened to in a Web Worker in your browser, and never
uploaded.

- **Listening.** The listener finds the onsets, then the tempo (and checks it isn't an echo or
  half-time in disguise), then fits a beat grid to the whole song so it doesn't drift. Bars start
  where the harmony changes, and the key comes from the song's pitch profile.
- **Its graph.** Every beat is a star. Beats that sound alike (harmony and timbre, over a bar)
  cluster into "sounds", each with its own colour, and passages that come back link to where they
  were heard before, so the song's shape pulls together.
- **In the battle.** The song plays as it is: never stretched, never re-pitched. It comes in at its
  most intense stretch, and each bar of the recording lands on DJRepo's bar grid. Its own beats throw
  the punches, and the caption shows where you are in it.
- **Together.** Press **D** and the repo comes to the song's tempo and key. They trade turns, chopped
  down to eighth notes, and then drop together: the song with the repo's drums on top and its graph
  on lead.

A new song added mid-set takes over from a song that's already playing, so it's always code against
a song.

</details>

<details>
<summary><b>A new contender, step by step</b></summary>

- While the repo loads, the set carries on, and a banner and the announcer say **"Meta is cooking"**.
  The new graph's layout is settled a few milliseconds at a time, so the music never stutters.
- When it's ready, the deck that stays builds up for four bars under a full-screen **A NEW CONTENDER
  HAS ARRIVED** card, with the music dipping under the voice. The name is revealed halfway through.
- On the drop the screen flashes white and the newcomer flies in huge from its side of the stage and
  takes round one. A solo set becomes a battle. In a battle, whoever is behind on the meter is knocked
  out and spins away.

The voice is the browser's own speech (Edge's "Natural" voices sound best). Switch it off under
**Announcer** in the mixer.

</details>

<details>
<summary><b>The mixer</b></summary>

- **Genre** from your repo, or house, techno, trance, big room or drum & bass, per deck.
- **Mashup**: which repo brings the drums, the bass, and the chords to the drop you make together.
- **Lead synth**: pluck, supersaw, FM bell, 8-bit or acid.
- **Channels**: kick, clap & snare, hi-hats, percussion, bass, chords, pad, arpeggio, the lead, and
  risers & impacts, each with a switch and a level. Everything melodic pumps under the kick.
- **Visuals**: camera intensity and flashing lights. **Announcer**: the voice on or off.

</details>

## Proof it works

**At a glance** (details below):

| What | Measured |
| --- | --- |
| Song tempo accuracy | 5 of 5 benchmark tracks within 0.001 BPM (100%) |
| Bar-line accuracy | within 12 ms on every benchmark track |
| Key detection | 3 of 5 exact (60%); 5 of 5 exact or the relative key (100%) |
| Song analysis time | about 0.5 s per song in the browser, about 1 s in Node |
| Voice command transcription (Muse Voice) | 4 of 4 spoken test commands correct (100%), 0.7–1.1 s each |
| Pitch draft time (Muse Spark) | 177 s before tuning `reasoning_effort`, 122 s after (31% faster) |
| Template phrases in final drafts | 0, in every live run checked |
| Live music while building a repo or rendering a clip | worst scheduler delay 41–114 ms, inside its 250 ms lookahead: no dropouts |
| Automated tests | 42 passing, plus the listener benchmark, in CI on every push |


**The song listener**, benchmarked on tracks where the answer is known, each with a trap real songs
set: a dotted-eighth echo that looks like a faster tempo, two-step drum & bass that looks like half
time, and silence before the first beat. It runs in CI on every push
([`tests/listener-benchmark.mjs`](tests/listener-benchmark.mjs)):

| Track | Tempo (true → heard) | Bar line off by | Key |
| --- | --- | --- | --- |
| House | 124 → 124.001 | 12 ms | A minor: right |
| Techno, dotted-eighth echo | 131 → 131.001 | 12 ms | D minor → F major (its relative major) |
| Drum & bass, two-step | 174 → 174.001 | 9 ms | F minor: right |
| Trance | 138 → 138.000 | 12 ms | G major: right |
| Big room, heavy echo | 128 → 128.000 | 12 ms | C major → A minor (its relative minor) |

Every tempo is within 0.001 BPM and every bar line within 12 ms. Keys are exact on three of five,
and the other two land on the relative key, which has the same notes, so the repo's lead still
plays in tune. On full sets DJRepo renders itself (house, techno, drum & bass), measured in Chrome:
tempo within 0.003 BPM, bar lines within 6 ms, and all three keys right. A song takes about half a
second to analyse.

**Voice commands:** Muse Voice Transcribe wrote down all four spoken test commands correctly ("drop
it", "bring in Facebook React", "switch to techno", "turn it up"), in about a second each. In Chrome,
a test microphone said "drop it" and the set built up into a drop.

**The gig finder, server and voice**, with 42 tests ([`tests/`](tests/)), including:

- A booking address is used only if it's on a page DJRepo read. A name is used only if a page names
  that person.
- The real fabric London case: its FAQ lists `events@` for *private hire*, and the check rules it out.
- Template phrases ("I hope this email finds you well", em dashes, a pile of exclamation marks) are
  caught, and the draft is rewritten.
- It never reads private or local addresses, and API errors never echo the request URL (which can
  carry a key).

**Muse Spark in live runs:** a full pitch (research, facts, writing) took 177 s before tuning
`reasoning_effort` and 122 s after. On fabric, the research found the club's real demo policy
("email a 30 minute long demo mix along with some biographical information"), and no template
phrases made it into the final drafts.

## What it costs to run

The set, the light show, songs and the live demo cost nothing: everything musical runs in your
browser, and the Ticketmaster Discovery API is free (5,000 calls a day). Only the two Meta models are
billed, pay-as-you-go through the [Meta Model API](https://dev.meta.ai/docs/pricing-rate-limits):

| Model | Meta's price | Per use in DJRepo |
| --- | --- | --- |
| Muse Spark (`muse-spark-1.3`) | $1.25 per 1M input tokens, $4.25 per 1M output tokens, plus $2.50 per 1,000 web searches | One pitch is three calls (research, facts, writing), four if the writing needs a second pass. We estimate a few cents per pitch, depending on how much the research reads (we haven't metered tokens per pitch). |
| Muse Voice Transcribe (`muse-voice-transcribe-1.0`) | $0.18 per hour of audio | A 3-second command costs about $0.00015, so 1,000 commands cost about 15 cents. |

Each pitch is only made when you pick a gig, and repeated picks reuse the draft, so nothing is spent
in the background.

## Controls

| Key | Does |
| --- | --- |
| **D** | Skip to the next drop. In a battle: sync the decks into one drop |
| **A** | Bring in another repo, or a song, while the set plays |
| **G** | Find a gig while the set keeps playing (Esc goes back to it) |
| **V** | Hold to talk: "drop it", "sync", "techno", "louder", "mute", "supersaw", "bring in facebook react" |
| **C** | Put the controls in a window of their own |
| **X** | Mixer |
| **F** | Full screen |
| **M** | Mute |

**Contains flashing lights** when a drop lands. Switch them off on the start screen or in the mixer.
If your system asks for reduced motion, they start off, and the camera moves far less.

## Keys

The set and the light show need no keys. The gig finder needs two, in a `.env` file next to
`server.py` (copy [`.env.example`](.env.example)):

| Key | What for | Where |
| --- | --- | --- |
| `TICKETMASTER_API_KEY` | Real upcoming events | Free, at [developer.ticketmaster.com](https://developer.ticketmaster.com) (Discovery API) |
| `MODEL_API_KEY` | Muse Spark research and writing, and voice commands | [dev.meta.ai](https://dev.meta.ai) |

Docker Compose reads `.env` when the container starts; keys are never copied into the image. A draft
takes two or three minutes (most of it is the web search), and starts the moment you pick a gig, so
it's usually ready by the time you've read about the night. Muse Spark is billed pay-as-you-go by Meta:
each email is three calls, or four if the writing needs a second pass.

## Run without Docker

You need Python 3.11+ and git.

- **Windows:** double-click `start.bat`.
- **macOS or Linux:** run `./start.sh`.

The first run creates a `.venv` and installs graphify into it (the PyPI name is `graphifyy`, with two
y's), which takes a minute. A browser tab opens at http://127.0.0.1:8777. Options:
`server.py --port 9000 --max-nodes 800 --host 127.0.0.1 --no-browser`

## What's where

| File | What it is |
| --- | --- |
| [`server.py`](server.py) | The local server: clones the repo, runs graphify, builds the scene, and serves the API |
| [`gigs.py`](gigs.py) | The gig finder: Ticketmaster events, Muse Spark research and writing, contact checking |
| [`common.py`](common.py) | Background jobs, subprocesses, and trimming a graph down to a scene |
| [`web/app.js`](web/app.js) | The light show, the HUD, a new contender's entrance, and the link to the control deck |
| [`web/dj.js`](web/dj.js) | The DJ: a Web Audio sequencer and every synth, drum and effect |
| [`web/genres.js`](web/genres.js) | The five genres: tempos, patterns and colours |
| [`web/deck.html`](web/deck.html), [`web/deck.js`](web/deck.js) | The control deck window |
| [`web/gigs.js`](web/gigs.js), [`web/sample.js`](web/sample.js) | The gig finder screen, and the offline clip renderer |
| [`web/song.js`](web/song.js), [`web/song-worker.js`](web/song-worker.js) | A song as a deck: decoding it, and the listener that finds its beat, key and shape |
| [`voice.py`](voice.py), [`web/voice.js`](web/voice.js) | Voice commands: recording, and Muse Voice Transcribe |
| [`Dockerfile`](Dockerfile), [`docker-compose.yml`](docker-compose.yml) | One-command setup |
| [`tests/`](tests/) | The gig finder's and server's tests (`python -m pytest`), and the listener benchmark (`node tests/listener-benchmark.mjs`) |
| [`demo/`](demo/), [`.github/workflows/`](.github/workflows/) | The live demo's pre-built repos and demo song, and the CI and Pages workflows |

## Notes

- Only public repositories work, because nothing asks for GitHub credentials.
- Songs stay in your browser. The listener works best on music with a steady beat and a clear kick.
- Results are cached in `.cache/` (a Docker volume, in Docker), so anything you've played before
  opens instantly from the chips on the start screen.
- Very large graphs are trimmed to their 1,500 most connected nodes, and 900 each in a battle.
- The page loads d3, Leaflet and lamejs from cdnjs, map tiles and place search from OpenStreetMap,
  and fonts from Google Fonts, so it needs an internet connection.
- The server listens only on this machine (127.0.0.1). The Docker setup publishes it to localhost only.

## License

[MIT](LICENSE). Remix it.
