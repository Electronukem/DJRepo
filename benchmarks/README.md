# Benchmarks

Two benchmarks cover the two things DJRepo has to hear: what a song is doing, and what the DJ said.

| Benchmark | Measures | Result | Runs |
| --- | --- | --- | --- |
| [`listener.mjs`](listener.mjs) | The song listener (`web/song-worker.js`): tempo, bar line and key on tracks where the answer is known | 5 of 5 tempos within 0.001 BPM, every bar line within 12 ms, keys 3 of 5 exact and 5 of 5 exact or relative | In CI on every push: `node benchmarks/listener.mjs` |
| [`voice.py`](voice.py) | Voice commands through Meta's Muse Voice Transcribe: whether the transcript makes the set do the right thing, and how long it takes | 71 of 72 right (99%), median 0.85 s per command | By hand, with `MODEL_API_KEY` in `.env`: `python benchmarks/voice.py` (about a cent) |

## Voice commands (Muse Voice Transcribe)

Twelve commands ("drop it", "bring in facebook react", "switch to techno", "supersaw lead"...), each
spoken by two voices (Windows' built-in David and Zira; the clips are in [`voice/clips`](voice/clips),
made by [`voice/make-clips.ps1`](voice/make-clips.ps1)), sent to `muse-voice-transcribe-1.0` exactly
the way DJRepo sends them: push to talk, 16 kHz mono WAV, through `voice.transcribe`. Three conditions:

- **clean:** the command as spoken.
- **quiet:** a laptop mic far away. The recording drops to 2% of full volume through a 16-bit mic,
  then is turned up the way `web/voice.js` does before sending it, hiss and all.
- **music:** the set playing underneath: a 124 BPM kick, bass and hats at -12 dB under the voice.

A command only counts if the transcript would make the set do the right thing, using the same rules
as `runVoice` in `web/app.js`. A transcript that's nearly right but triggers nothing counts as a miss.

Latest run ([`results/voice.json`](results/voice.json) has every transcript):

| Condition | Right | Accuracy | Median | p95 |
| --- | --- | --- | --- | --- |
| clean | 24 of 24 | 100% | 0.82 s | 0.93 s |
| quiet | 24 of 24 | 100% | 0.83 s | 0.96 s |
| music | 23 of 24 | 96% | 0.86 s | 1.00 s |
| **all** | **71 of 72** | **99%** | **0.85 s** | **0.95 s** |

**What the benchmark changed.** The first run got 62 of 72 (86%). Nine of the ten misses were words
Muse Voice heard right but wrote down differently from what DJRepo listened for:

| Muse Voice wrote | Was | Fix in `web/app.js` |
| --- | --- | --- |
| "Supersolid", "super solid" (6 of 6 times) | "supersaw" | Spoken lead aliases, like the genre ones ("drum n bass") |
| "Torvald's Linux" | torvalds/linux | Apostrophes are dropped from spoken repo names |
| "Facebook Facebook React" (on the quiet mic) | facebook/react | A doubled word is collapsed (a repo named for its owner, like neovim/neovim, is kept) |

The tenth, "Turvold's Linux" with the music underneath, was a real mishearing, and it's the one miss
left ("Turvald Linux").

**Echo cancellation.** Testing the full browser path in Chrome with a quiet test mic found one more
problem, outside this benchmark: with echo cancellation and noise suppression on, the browser took a
quiet voice for an echo of the music and Muse Voice got no words at all. DJRepo now records with both
off (auto gain stays on), and the same quiet "drop it" comes back word for word.

## The song listener

Five tracks, each with a trap real songs set: a dotted-eighth echo that looks like a faster tempo,
two-step drum & bass that looks like half time, and silence before the first beat.

| Track | Tempo (true → heard) | Bar line off by | Key |
| --- | --- | --- | --- |
| House | 124 → 124.001 | 12 ms | A minor: right |
| Techno, dotted-eighth echo | 131 → 131.001 | 12 ms | D minor → F major (its relative major) |
| Drum & bass, two-step | 174 → 174.001 | 9 ms | F minor: right |
| Trance | 138 → 138.000 | 12 ms | G major: right |
| Big room, heavy echo | 128 → 128.000 | 12 ms | C major → A minor (its relative minor) |

It fails CI if any tempo is off by more than 0.05 BPM or any bar line by more than 25 ms.
