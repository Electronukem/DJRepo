#!/usr/bin/env python3
"""DJRepo: turn a GitHub repository into an EDM set with a light show.

The server clones the repository, runs graphify (https://github.com/Graphify-Labs/graphify)
over the code, and reads the recent commit history. The browser gets a compact "scene" that
web/app.js turns into a beat-synced light show and web/dj.js turns into a DJ set.

    python server.py            # then open http://127.0.0.1:8777
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import threading
import webbrowser
from collections import Counter, defaultdict
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import cover
import gigs
import voice
from common import CACHE_DIR, INSTALL_HINT, JOBS, ROOT, WEB_DIR, BuildError, Job, graphify_command, rmtree, start_job, \
    stream, summarize_graph

SCENE_VERSION = 1
MAX_COMMITS = 400          # one commit drops per bar or two, so this is a long set
DEFAULT_MAX_NODES = 1500   # past this the light show stops being smooth
NODES_PER_COMMIT = 10

CLONE_TIMEOUT = 15 * 60
GRAPHIFY_TIMEOUT = 30 * 60

# Public repositories only: never let git or a credential manager stop to ask for a password.
GIT_ENV = {
    **os.environ,
    "GIT_TERMINAL_PROMPT": "0",
    "GCM_INTERACTIVE": "never",
    "GIT_LFS_SKIP_SMUDGE": "1",
}

_URL = re.compile(
    r"^(?:(?:https?://)?(?:www\.)?github\.com/)?"
    r"(?P<owner>[A-Za-z0-9][A-Za-z0-9-]{0,38})/(?P<repo>[A-Za-z0-9._-]{1,100})"
    r"(?:/tree/(?P<branch>[^/?#\s]+))?(?:[/?#].*)?$"
)


# ---------------------------------------------------------------------------
# Input


def parse_github_url(text: str) -> tuple[str, str, str | None]:
    """Accept https://github.com/owner/repo[.git][/tree/branch] or plain owner/repo."""
    match = _URL.match(text.strip())
    if not match:
        raise ValueError("That doesn't look like a GitHub repository link (github.com/owner/repo).")
    owner, repo, branch = match["owner"], match["repo"], match["branch"]
    if repo.endswith(".git"):
        repo = repo[:-4]
    if repo in {"", ".", ".."}:
        raise ValueError("That link is missing the repository name.")
    if branch and (branch.startswith("-") or not re.fullmatch(r"[A-Za-z0-9._-]+", branch)):
        raise ValueError(f"'{branch}' isn't a branch name I can use.")
    return owner, repo, branch


# ---------------------------------------------------------------------------
# Repository pipeline: clone -> history -> graphify -> scene


def build_scene(job: Job, owner: str, repo: str, branch: str | None, refresh: bool, max_nodes: int) -> dict:
    slug = f"{owner}__{repo}" + (f"__{branch}" if branch else "")
    work = CACHE_DIR / slug
    scene_file = work / "scene.json"

    if refresh and work.exists():
        job.update("Clearing the saved copy")
        rmtree(work)

    if scene_file.exists():
        try:
            scene = json.loads(scene_file.read_text("utf-8"))
            if scene.get("version") == SCENE_VERSION and scene.get("max_nodes") == max_nodes:
                job.update("Found this set from last time")
                return scene
        except (OSError, ValueError):
            pass

    work.mkdir(parents=True, exist_ok=True)
    repo_dir = work / "repo"
    clone(job, owner, repo, branch, repo_dir, work / "cloned.ok")
    commits = read_history(job, repo_dir)
    graph_file = run_graphify(job, repo_dir, work / "graphify")

    job.update("Setting up the decks")
    try:
        graph = json.loads(graph_file.read_text("utf-8"))
    except (OSError, ValueError) as exc:
        raise BuildError(f"graphify wrote a graph I couldn't read ({exc}).") from exc

    scene = make_scene(graph, commits, repo_dir, max_nodes)
    if not scene["nodes"]:
        raise BuildError("graphify didn't find any code it could map in this repository.")
    scene.update(
        version=SCENE_VERSION,
        max_nodes=max_nodes,
        repo={
            "owner": owner,
            "name": repo,
            "branch": branch,
            "url": f"https://github.com/{owner}/{repo}" + (f"/tree/{branch}" if branch else ""),
        },
    )
    scene_file.write_text(json.dumps(scene, separators=(",", ":")), "utf-8")
    return scene


def clone(job: Job, owner: str, repo: str, branch: str | None, dest: Path, marker: Path) -> None:
    if marker.exists() and (dest / ".git").exists():
        job.update("Using the saved copy of the repository")
        return
    if dest.exists():
        rmtree(dest)

    job.update(f"Cloning {owner}/{repo}")
    # Enough history to replay, and no old file contents: the graph only needs today's files,
    # and the replay only needs to know which files each commit touched.
    cmd = [
        "git", "-c", "credential.helper=", "-c", "core.longpaths=true",
        "clone", "--depth", str(MAX_COMMITS + 1), "--filter=blob:none", "--no-tags", "--progress",
    ]
    if branch:
        cmd += ["--branch", branch]
    cmd += [f"https://github.com/{owner}/{repo}.git", str(dest)]

    code, lines = stream(job, cmd, timeout=CLONE_TIMEOUT, env=GIT_ENV)
    if code != 0:
        text = "\n".join(lines)
        lowered = text.lower()
        if "clone succeeded, but checkout failed" in lowered and (dest / ".git").exists():
            job.update(line="Some files can't exist on this system; carrying on with the rest.")
        elif branch and "remote branch" in lowered:
            raise BuildError(f"There's no branch called '{branch}' in {owner}/{repo}.")
        elif any(s in lowered for s in ("not found", "could not read username", "authentication")):
            raise BuildError(f"Couldn't find {owner}/{repo} on GitHub. Is it public, and is the name right?")
        else:
            raise BuildError("git couldn't clone the repository:\n" + "\n".join(lines[-6:]))
    marker.write_text("ok", "utf-8")


def read_history(job: Job, repo_dir: Path) -> list[dict]:
    """The most recent commits, oldest first, with the files each one touched."""
    job.update("Reading the commit history")
    cmd = [
        "git", "-C", str(repo_dir), "-c", "core.quotepath=false",
        "log", f"-n{MAX_COMMITS}", "--no-renames", "--name-only",
        "--format=%x1e%H%x1f%aI%x1f%aN%x1f%s",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, env=GIT_ENV, timeout=300)
    except (OSError, subprocess.TimeoutExpired):
        result = None
    if result is None or result.returncode != 0:
        job.update(line="Couldn't read the history; the set will lean on the graph alone.")
        return []

    commits = []
    for record in result.stdout.decode("utf-8", "replace").split("\x1e")[1:]:
        head, _, body = record.partition("\n")
        fields = head.split("\x1f")
        if len(fields) < 4:
            continue
        sha, date, author, subject = fields[:4]
        files = [line.strip() for line in body.splitlines() if line.strip()]
        commits.append({"hash": sha, "date": date, "author": author, "subject": subject, "files": files})
    commits.reverse()  # replay the story forwards
    return commits


def run_graphify(job: Job, repo_dir: Path, out_dir: Path) -> Path:
    produced = [out_dir / "graphify-out" / "graph.json", out_dir / "graph.json"]
    for path in produced:
        if path.exists():
            job.update("Using the graph graphify made last time")
            return path

    base = graphify_command()
    if base is None:
        raise BuildError(f"graphify isn't installed. Run `{INSTALL_HINT}`, then start this app again.")

    out_dir.mkdir(parents=True, exist_ok=True)
    env = {
        **GIT_ENV,
        "GRAPHIFY_BACKEND": "none",  # code only: parsed locally, no LLM and no API key
        "PYTHONIOENCODING": "utf-8",
        "PYTHONUTF8": "1",
        "NO_COLOR": "1",
    }

    job.update("Mapping the code with graphify")
    code, lines = stream(
        job, base + ["extract", str(repo_dir), "--code-only", "--out", str(out_dir)],
        timeout=GRAPHIFY_TIMEOUT, cwd=out_dir, env=env,
    )
    found = next((p for p in produced if p.exists()), None)

    if found is None:
        # Older graphify releases only build code graphs through `update`, which writes next to the code.
        job.update("Trying graphify's code-only update instead")
        code, more = stream(job, base + ["update", str(repo_dir)], timeout=GRAPHIFY_TIMEOUT, cwd=out_dir, env=env)
        lines += more
        found = next((p for p in [repo_dir / "graphify-out" / "graph.json"] if p.exists()), None)

    if found is None:
        tail = "\n".join(lines[-8:]) or f"(exit code {code})"
        raise BuildError("graphify couldn't build a graph for this repository:\n" + tail)
    if code != 0:
        job.update(line="graphify finished with warnings; using what it produced.")
    return found


def make_scene(graph: dict, commits: list[dict], repo_dir: Path, max_nodes: int) -> dict:
    root = str(repo_dir.resolve()).replace("\\", "/").rstrip("/").lower()
    g = summarize_graph(
        graph, max_nodes,
        file_of=lambda n: _relpath(n.get("source_file"), root),
        fallback_group=lambda f: f.split("/", 1)[0] if "/" in f else "(root)",
    )
    nodes = [
        {"l": g["labels"][new], "f": g["files"][new], "c": g["comm"][new], "d": g["degree"][old],
         "k": _kind(g["labels"][new], g["files"][new])}
        for new, old in enumerate(g["keep"])
    ]
    return {
        "nodes": nodes,
        "links": g["links"],
        "communities": g["communities"],
        "commits": map_commits(commits, g["files"], [g["degree"][old] for old in g["keep"]]),
        "stats": _stats(graph, g["raw_nodes"], g["pair_count"], commits, root),
        "trimmed": len(g["raw_nodes"]) > max_nodes,
    }


def map_commits(commits: list[dict], files: list[str], degree: list[int]) -> list[dict]:
    """Point each commit at the graph nodes living in the files it touched."""
    by_file: dict[str, list[int]] = defaultdict(list)
    for i, f in enumerate(files):
        if f:
            by_file[f.lower()].append(i)
    for members in by_file.values():
        members.sort(key=lambda i: -degree[i])
    known = list(by_file)
    cache: dict[str, list[int]] = {}

    def lookup(path: str) -> list[int]:
        p = path.lower()
        if p not in cache:
            hit = by_file.get(p)
            if hit is None:  # graphify may record paths against a different base
                suffixes = [k for k in known if k.endswith("/" + p) or p.endswith("/" + k)]
                hit = by_file[max(suffixes, key=len)] if suffixes else []
            cache[p] = hit
        return cache[p]

    replay = []
    for commit in commits:
        groups = [g for g in map(lookup, commit["files"]) if g]
        picked: list[int] = []
        depth = 0
        while len(picked) < NODES_PER_COMMIT and any(depth < len(g) for g in groups):
            for g in groups:  # one node per file first, then go deeper
                if depth < len(g) and len(picked) < NODES_PER_COMMIT:
                    picked.append(g[depth])
            depth += 1
        replay.append({
            "h": commit["hash"][:7],
            "t": commit["date"],
            "a": commit["author"][:60],
            "m": commit["subject"][:160],
            "f": len(commit["files"]),
            "n": picked,
        })
    return replay


def _stats(graph: dict, raw_nodes: list[dict], link_count: int, commits: list[dict], root: str) -> dict:
    files = {_relpath(n.get("source_file"), root) for n in raw_nodes} - {""}
    languages = Counter(Path(f).suffix.lower().lstrip(".") for f in files)
    languages.pop("", None)

    hours = [0] * 24
    weekdays = [0] * 7
    for commit in commits:
        try:
            when = datetime.fromisoformat(commit["date"])
        except ValueError:
            continue
        hours[when.hour] += 1  # the author's own local time, which is what says something about the work
        weekdays[when.weekday()] += 1

    meta = graph.get("graph") if isinstance(graph.get("graph"), dict) else {}
    return {
        "nodes_total": len(raw_nodes),
        "links_total": link_count,
        "files": len(files),
        "languages": dict(languages.most_common(12)),
        "hours": hours,
        "weekdays": weekdays,
        "commits": len(commits),
        "contributors": len({c["author"] for c in commits}),
        "first": commits[0]["date"] if commits else None,
        "last": commits[-1]["date"] if commits else None,
        "graphify_version": meta.get("graphify_version"),
    }


def _relpath(path, root: str) -> str:
    if not path:
        return ""
    p = str(path).replace("\\", "/")
    if p.lower().startswith(root + "/"):
        p = p[len(root) + 1:]
    while p.startswith("./"):
        p = p[2:]
    return p


def _kind(label: str, file: str) -> str:
    if label == file or label == file.rsplit("/", 1)[-1]:
        return "file"
    return "fn" if label.endswith(")") else "sym"


# ---------------------------------------------------------------------------
# HTTP


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def log_message(self, *_args) -> None:
        pass

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self) -> None:
        path = self.path.partition("?")[0]
        if path == "/api/health":
            self._json({
                "graphify": graphify_command() is not None,
                "git": shutil.which("git") is not None,
                "install": INSTALL_HINT,
                "keys": gigs.keys(),
            })
        elif path.startswith("/api/job/"):
            job = JOBS.get(path.rsplit("/", 1)[-1])
            if job:
                self._json(job.snapshot())
            else:
                self._json({"error": "No such job."}, 404)
        else:
            super().do_GET()

    def do_POST(self) -> None:
        if self.path == "/api/voice":
            self._voice()
            return
        # Requiring JSON means other websites can't quietly trigger work from a browser tab.
        if "application/json" not in self.headers.get("Content-Type", ""):
            self._json({"error": "Expected JSON."}, 415)
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length > 100_000:
            self._json({"error": "Too large."}, 413)
            return
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(body, dict):
                raise ValueError("Expected a JSON object.")
        except ValueError as exc:
            self._json({"error": str(exc)}, 400)
            return

        if self.path == "/api/gigs":
            self._gigs(body)
            return
        if self.path == "/api/pitch":
            self._pitch(body)
            return
        if self.path == "/api/cover":
            self._cover(body)
            return
        if self.path != "/api/build":
            self._json({"error": "Not found."}, 404)
            return
        try:
            owner, repo, branch = parse_github_url(str(body.get("url", "")))
        except ValueError as exc:
            self._json({"error": str(exc)}, 400)
            return
        refresh = bool(body.get("refresh"))
        max_nodes = self.server.max_nodes
        job = start_job(("repo", owner.lower(), repo.lower(), branch or ""),
                        lambda job: build_scene(job, owner, repo, branch, refresh, max_nodes))
        self._json({"job": job.id})

    def _gigs(self, body: dict) -> None:
        """Upcoming electronic events near a point or in a city."""
        try:
            lat = float(body["lat"]) if body.get("lat") is not None else None
            lon = float(body["lon"]) if body.get("lon") is not None else None
            if lat is not None and not (-90 <= lat <= 90 and -180 <= (lon or 0) <= 180):
                raise ValueError
            events, place = gigs.find_gigs(str(body.get("city") or "")[:80], lat, lon, int(body.get("radius") or 50),
                                           str(body.get("unit") or "miles"))
        except (TypeError, ValueError):
            self._json({"error": "That location didn't make sense."}, 400)
            return
        except BuildError as exc:
            self._json({"error": str(exc)}, 502)
            return
        self._json({"events": events, "place": place})

    def _pitch(self, body: dict) -> None:
        """Research an event and write a booking email for it, in the background."""
        event, profile, clips = body.get("event"), body.get("profile"), body.get("clips")
        if not (isinstance(event, dict) and isinstance(profile, dict) and isinstance(clips, dict) and event.get("id")):
            self._json({"error": "Expected an event, a profile and the clips."}, 400)
            return
        if not str(profile.get("name") or "").strip():
            self._json({"error": "Add your name first, so the email can be signed."}, 400)
            return
        fingerprint = json.dumps([profile, sorted(clips)], sort_keys=True)
        job = start_job(("pitch", str(event["id"]), fingerprint), lambda job: gigs.pitch(job, event, profile, clips))
        self._json({"job": job.id})

    def _cover(self, body: dict) -> None:
        """Cover art for a repo's clip in a genre, painted by Muse Image (cached after the first time)."""
        repo, genre = str(body.get("repo") or "")[:200], str(body.get("genre") or "")
        try:
            image = cover.paint(repo, genre)
        except BuildError as exc:
            self._json({"error": str(exc)}, 400 if genre not in cover.LOOKS else 502)
            return
        self.send_response(200)
        self.send_header("Content-Type", cover.mime(image))
        self.send_header("Content-Length", str(len(image)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(image)

    def _voice(self) -> None:
        """A push-to-talk recording, written down by Muse Voice Transcribe."""
        # audio/wav, like JSON, isn't a type a plain cross-site form can send, so other sites can't post here.
        if self.headers.get("Content-Type", "").split(";")[0].strip().lower() != "audio/wav":
            self._json({"error": "Expected a WAV recording."}, 415)
            return
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= voice.MAX_BYTES:
            self._json({"error": "That recording is too long. Hold the button just while you speak."}, 413)
            return
        try:
            text = voice.transcribe(self.rfile.read(length))
        except BuildError as exc:
            self._json({"error": str(exc)}, 502)
            return
        self._json({"text": text})

    def _json(self, payload: dict, status: int = 200) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def load_env(path: Path) -> None:
    """KEY=value lines from a .env file, for anything not already set in the environment."""
    try:
        lines = path.read_text("utf-8").splitlines()
    except OSError:
        return
    for line in lines:
        key, sep, value = line.strip().partition("=")
        if sep and key and not key.startswith("#"):
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def main() -> None:
    load_env(ROOT / ".env")
    parser = argparse.ArgumentParser(description="Turn a GitHub repository into an EDM set with a light show.")
    parser.add_argument("--port", type=int, default=8777)
    parser.add_argument("--host", default="127.0.0.1",
                        help="address to listen on (default 127.0.0.1, this machine only; the Docker image uses 0.0.0.0)")
    parser.add_argument("--max-nodes", type=int, default=DEFAULT_MAX_NODES,
                        help=f"largest graph to animate (default {DEFAULT_MAX_NODES})")
    parser.add_argument("--no-browser", action="store_true", help="don't open a browser tab")
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.max_nodes = max(50, args.max_nodes)
    url = f"http://127.0.0.1:{args.port}/"
    print(f"DJRepo is running at {url}  (Ctrl+C to stop)")
    if graphify_command() is None:
        print(f"  graphify isn't installed yet. Run:  {INSTALL_HINT}")
    if shutil.which("git") is None:
        print("  git isn't on PATH; it's needed to clone repositories.")
    missing = [k for k, ok in (("TICKETMASTER_API_KEY", gigs.keys()["events"]), ("MODEL_API_KEY", gigs.keys()["meta"])) if not ok]
    if missing:
        print(f"  The gig finder needs {' and '.join(missing)} in .env (see .env.example).")
    if not args.no_browser:
        threading.Timer(0.6, webbrowser.open, (url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nSet over.")


if __name__ == "__main__":
    main()
