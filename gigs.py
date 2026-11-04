"""The gig finder: real upcoming electronic events near you, and a pitch email for each one.

Events come from Ticketmaster's Discovery API. The pitch is researched and written with Meta's
models through the Meta Model API (https://dev.meta.ai): Muse Spark searches the web for the venue,
the night and its promoter (search grounding), pulls out the facts worth using, and writes the email
in the DJ's own voice. Every booking address and name it uses is checked against a real page first,
and anything that can't be confirmed is left out rather than guessed.

Keys come from the environment, or from a .env file next to server.py:
    TICKETMASTER_API_KEY   free from https://developer.ticketmaster.com
    MODEL_API_KEY          from https://dev.meta.ai
"""
from __future__ import annotations

import ipaddress
import json
import os
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser

from common import BuildError, Job

TM_EVENTS = "https://app.ticketmaster.com/discovery/v2/events.json"
DANCE_ELECTRONIC = "KnvZfZ7vAvF"  # Ticketmaster's Dance/Electronic genre
USER_AGENT = "DJRepo/1.0 (gig finder)"
GENRES = ["house", "techno", "trance", "bigroom", "dnb"]
GENRE_NAMES = {"house": "house", "techno": "techno", "trance": "trance", "bigroom": "big room", "dnb": "drum & bass"}
MAX_PAGES = 6        # pages fetched to confirm a booking contact
# Ticketmaster files some things under Dance/Electronic that aren't nights a DJ could play.
NOT_DJ_NIGHTS = {"r&b", "pop", "jazz", "dance band", "children's music", "comedy", "classical", "country"}
_FOR_KIDS = re.compile(r"\b(toddlers?|kids?|children'?s?|family|baby|babies)\b", re.I)
PAGE_LIMIT = 1_500_000

_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
_AT = re.compile(r"\s*[\[\(\{]\s*at\s*[\]\)\}]\s*", re.I)
_DOT = re.compile(r"\s*[\[\(\{]\s*dot\s*[\]\)\}]\s*", re.I)
_NOT_EMAIL = re.compile(r"\.(png|jpe?g|gif|webp|svg|css|js)$|@(sentry|wixpress|example)\.|^(no-?reply|privacy|abuse|webmaster)@", re.I)
_BOOKING = re.compile(r"book|talent|music|promo|artist|gig|program|entertain|demo", re.I)
# What the words just before an address say it's for. A club's events@ is often private hire.
_WRONG_INBOX = re.compile(r"hire|\bvip\b|table|\bjobs?\b|staff|position|vacanc|lost|cloakroom|access|wheelchair|press|media|"
                          r"gdpr|data|privacy|refund|ticket|guest ?list|birthday|wedding|corporate|merch|store|order", re.I)
_DJ_INBOX = re.compile(r"\bdjs?\b|demo|artist|talent|promot|submission|line-?up|programming|perform|play at|agent", re.I)

# Things that make an email read like a template. The writer is told to avoid them, and is asked
# to try again once if it doesn't.
STOCK = [
    "hope this email finds you", "hope this finds you", "i'm reaching out", "i am reaching out", "wanted to reach out",
    "i came across", "love the opportunity", "passionate", "elevate", "vibrant", "curated", "curate", "unique blend",
    "on a journey", "seamless", "delve", "resonate", "thrilled", "look forward to hearing", "best regards",
    "amazing venue", "incredible lineup", "electrifying", "unforgettable", "testament", "tapestry", "in today's",
    "i would be honored", "don't hesitate", "synergy", "leverage",
]


def keys() -> dict:
    return {"events": bool(os.environ.get("TICKETMASTER_API_KEY")), "meta": bool(os.environ.get("MODEL_API_KEY"))}


# ---------------------------------------------------------------------------
# Events


def find_gigs(city: str = "", lat: float | None = None, lon: float | None = None, radius: int = 50,
              unit: str = "miles") -> tuple[list[dict], str]:
    """Upcoming dance and electronic events within `radius` of a point or a city, soonest first,
    and the name of the place searched."""
    key = os.environ.get("TICKETMASTER_API_KEY")
    if not key:
        raise BuildError("Add TICKETMASTER_API_KEY to .env (it's free at developer.ticketmaster.com), then restart DJRepo.")
    place = ""
    if (lat is None or lon is None) and city:
        # Ticketmaster's own city filter matches the name anywhere (London, Ontario as well as London)
        # and ignores the radius, so find the place first.
        lat, lon, place = geocode(city)
    params = {
        "apikey": key,
        "locale": "*",  # every language's listings, not just English ones
        "genreId": DANCE_ELECTRONIC,
        "includeFamily": "no",  # no toddler raves
        "size": "100",
        "sort": "date,asc",
        "startDateTime": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "radius": str(max(5, min(int(radius), 300))),
        "unit": "km" if unit == "km" else "miles",
    }
    if lat is None or lon is None:
        raise BuildError("Say where to look: a city, or use your location.")
    params["geoPoint"] = geohash(lat, lon, 7)
    try:
        data = json.loads(_get(f"{TM_EVENTS}?{urllib.parse.urlencode(params)}", timeout=20))
    except urllib.error.HTTPError as exc:
        raise BuildError(_http_problem("Ticketmaster", exc)) from exc
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        raise BuildError(f"Couldn't reach Ticketmaster ({exc}).") from exc
    events = (data.get("_embedded") or {}).get("events") or []
    gigs = [g for g in map(_slim_event, events)
            if g and g["subGenre"].lower() not in NOT_DJ_NIGHTS and not _FOR_KIDS.search(g["name"])]
    return gigs, place


_PLACES: dict[str, tuple[float, float, str]] = {}


def geocode(city: str) -> tuple[float, float, str]:
    """A place's coordinates and full name, from OpenStreetMap's Nominatim (remembered, as its usage
    policy asks)."""
    key = city.strip().lower()
    if key not in _PLACES:
        url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode({"q": city, "format": "json", "limit": 1})
        try:
            found = json.loads(_get(url, timeout=15))
        except (urllib.error.URLError, TimeoutError, ValueError) as exc:
            raise BuildError(f"Couldn't look up {city} ({exc}). Try again, or use your location.") from exc
        if not found:
            raise BuildError(f"Couldn't find a place called {city}. Try adding the country.")
        _PLACES[key] = (float(found[0]["lat"]), float(found[0]["lon"]), found[0].get("display_name", city))
    return _PLACES[key]


def _slim_event(e: dict) -> dict | None:
    venue = ((e.get("_embedded") or {}).get("venues") or [{}])[0]
    loc = venue.get("location") or {}
    try:
        lat, lon = float(loc["latitude"]), float(loc["longitude"])
    except (KeyError, TypeError, ValueError):
        return None
    classes = e.get("classifications") or [{}]
    cls = next((c for c in classes if c.get("primary")), classes[0])
    start = (e.get("dates") or {}).get("start") or {}
    promoters = [e.get("promoter") or {}, *(e.get("promoters") or [])]
    promoter = next((p.get("name") for p in promoters if p.get("name")), "")
    lineup = [a.get("name") for a in (e.get("_embedded") or {}).get("attractions") or [] if a.get("name")]
    images = sorted((i for i in e.get("images") or [] if i.get("ratio") == "16_9" and i.get("width", 0) >= 500),
                    key=lambda i: i.get("width", 0))
    name_of = lambda d: (d or {}).get("name") or ""  # noqa: E731
    return {
        "id": e.get("id"),
        "name": e.get("name") or "Untitled event",
        "url": e.get("url"),
        "date": start.get("localDate"),
        "time": start.get("localTime") if isinstance(start.get("localTime"), str) else None,
        "genre": name_of(cls.get("genre")),
        "subGenre": name_of(cls.get("subGenre")),
        "promoter": promoter,
        "lineup": lineup[:10],
        "info": (e.get("info") or e.get("pleaseNote") or "")[:600],
        "image": images[0]["url"] if images else None,
        "venue": {
            "id": venue.get("id"),
            "name": venue.get("name") or "Unknown venue",
            "address": ((venue.get("address") or {}).get("line1")) or "",
            "city": name_of(venue.get("city")),
            "state": (venue.get("state") or {}).get("stateCode") or name_of(venue.get("state")),
            "country": (venue.get("country") or {}).get("countryCode") or "",
            "lat": lat,
            "lon": lon,
            "url": venue.get("url"),
        },
    }


_BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz"


def geohash(lat: float, lon: float, precision: int = 7) -> str:
    """The geohash Ticketmaster's geoPoint wants."""
    lat_range, lon_range = [-90.0, 90.0], [-180.0, 180.0]
    out, bit, ch, even = [], 0, 0, True
    while len(out) < precision:
        rng, value = (lon_range, lon) if even else (lat_range, lat)
        mid = (rng[0] + rng[1]) / 2
        if value > mid:
            ch |= 16 >> bit
            rng[0] = mid
        else:
            rng[1] = mid
        even = not even
        if bit < 4:
            bit += 1
        else:
            out.append(_BASE32[ch])
            bit, ch = 0, 0
    return "".join(out)


# ---------------------------------------------------------------------------
# The pitch


def pitch(job: Job, event: dict, profile: dict, clips: dict) -> dict:
    """Research one event and write a booking email for it. Runs as a background job."""
    if not os.environ.get("MODEL_API_KEY"):
        raise BuildError("Add MODEL_API_KEY to .env (from dev.meta.ai), then restart DJRepo.")
    venue = event.get("venue") or {}

    job.update(f"Looking into {venue.get('name', 'the venue')}")
    notes, citations, results = _research(event)

    job.update("Reading what turned up")
    facts = _extract(event, notes, results)

    job.update("Checking who reads the booking email")
    contact, checked = _confirm_contact(event, facts, citations, results)

    job.update("Writing the email")
    genre = facts.get("genre") if facts.get("genre") in GENRES else guess_genre(event)
    clip = clips.get(genre) or {}
    email = _write(event, facts, contact, profile, {**clip, "genre": genre})

    # Addresses the research mentions but no page confirmed: shown to the person to check, never used for them.
    mentioned = [c.get("email", "").strip() for c in facts.get("contacts") or []] + _EMAIL.findall(facts.get("submissions") or "")
    ruled_out = set(contact.pop("ruled_out", []))
    unconfirmed = [] if contact.get("email") else [e for e in dict.fromkeys(mentioned)
                                                    if _EMAIL.fullmatch(e) and not _NOT_EMAIL.search(e) and e.lower() not in ruled_out]

    return {
        "eventId": event.get("id"),
        "to": contact.get("email", ""),
        "contact": contact,
        "unconfirmed": unconfirmed[:3],
        "subject": email["subject"],
        "body": email["body"],
        "genre": genre,
        "why": facts.get("genre_reason", ""),
        "reader": facts.get("reader", ""),
        "submissions": facts.get("submissions", ""),
        "sources": [{"title": s["title"], "url": _clean_url(s["url"])}
                    for s in _dedupe([*citations, *[{"title": r["title"], "url": r["url"]} for r in results]])[:8]],
        "checked": checked,
    }


def guess_genre(event: dict) -> str:
    text = f"{event.get('subGenre', '')} {event.get('genre', '')} {event.get('name', '')}".lower()
    for words, genre in [(("drum", "jungle", "dnb", "d&b"), "dnb"), (("techno", "industrial"), "techno"),
                         (("trance", "psy"), "trance"), (("house", "garage", "disco"), "house"),
                         (("dubstep", "edm", "electro", "big room", "bass"), "bigroom")]:
        if any(w in text for w in words):
            return genre
    return "house"


def _research(event: dict) -> tuple[str, list[dict], list[dict]]:
    """Muse Spark searches the web for the venue, the night and the promoter."""
    venue = event.get("venue") or {}
    where = ", ".join(x for x in [venue.get("city"), venue.get("state"), venue.get("country")] if x)
    lineup = ", ".join(event.get("lineup") or [])
    prompt = f"""I'm a DJ deciding whether and how to pitch for a set connected to this event. Research it on the web.

Event: {event.get('name')} on {event.get('date')}{f" at {event.get('time')}" if event.get('time') else ''}
Venue: {venue.get('name')}, {venue.get('address')}, {where}
Promoter: {event.get('promoter') or 'not listed'}
Lineup: {lineup or 'not listed'}
Ticket page: {event.get('url')}

Find out:
1. What kind of room the venue is: size, sound, the nights and residents it's known for, and the music it leans towards.
2. What this particular night is about, and who is behind it.
3. Who books DJs here (the venue's talent buyer, or the promoter's), and how they take submissions. Look for a booking or demo email address on the venue's or promoter's own website or their official social pages.

Report only what sources say, with the source next to each fact. Prefer this year's sources, and flag anything that may be out of date (residents and regular nights change). If something isn't findable, say so. Never guess an email address or a person's name."""
    tool = {"type": "web_search", "search_context_size": "medium"}  # "high" roughly doubled the wait
    if venue.get("country"):
        tool["user_location"] = {"type": "approximate", "country": venue["country"], **({"city": venue["city"]} if venue.get("city") else {})}
    resp = _meta("/responses", {"model": _model(), "input": prompt, "tools": [tool], "include": ["web_search_call.results"],
                                "reasoning": {"effort": "low"}})

    texts, citations, results = [], [], []
    for item in resp.get("output") or []:
        if item.get("type") == "web_search_call":
            for r in item.get("results") or []:
                if r.get("url"):
                    results.append({"title": r.get("title") or r["url"], "url": r["url"], "snippet": (r.get("snippet") or "")[:600]})
        elif item.get("type") == "message":
            for block in item.get("content") or []:
                if block.get("type") == "output_text":
                    texts.append(block.get("text") or "")
                    for a in block.get("annotations") or []:
                        if a.get("type") == "url_citation" and a.get("url"):
                            citations.append({"title": a.get("title") or a["url"], "url": a["url"]})
    if not texts and isinstance(resp.get("output_text"), str):
        texts.append(resp["output_text"])
    return "\n".join(texts).strip(), _dedupe(citations), _dedupe(results)[:20]


FACTS_SCHEMA = {
    "type": "object",
    "properties": {
        "venue_summary": {"type": "string", "description": "One or two sentences on the room, from the sources only."},
        "night_summary": {"type": "string", "description": "One or two sentences on this night and who runs it, from the sources only."},
        "detail": {"type": "string", "description": "One specific, current detail a regular would know (a resident, a recent booking, the soundsystem, the room), or empty if none is sourced. Skip anything the notes say may be out of date."},
        "contacts": {
            "type": "array",
            "description": "Booking contacts exactly as they appear in the sources. Never construct or guess an address.",
            "items": {
                "type": "object",
                "properties": {
                    "email": {"type": "string"},
                    "name": {"type": "string", "description": "The person's name only if a source names them as handling bookings, else empty."},
                    "role": {"type": "string"},
                    "source_url": {"type": "string"},
                },
                "required": ["email", "name", "role", "source_url"],
                "additionalProperties": False,
            },
        },
        "reader": {"type": "string", "description": "Who most likely reads a booking email here, as a role (e.g. 'the promoter's talent buyer')."},
        "submissions": {"type": "string", "description": "How the venue or promoter says DJs should get in touch, in their words, including if they say they don't take unsolicited demos. Empty if no source says."},
        "genre": {"type": "string", "enum": GENRES},
        "genre_reason": {"type": "string", "description": "Half a sentence on why that genre fits the room."},
        "ask": {"type": "string", "description": "The most realistic thing to ask for: a support or opening slot on this date, a warm-up set, or a future date."},
    },
    "required": ["venue_summary", "night_summary", "detail", "contacts", "reader", "submissions", "genre", "genre_reason", "ask"],
    "additionalProperties": False,
}


def _extract(event: dict, notes: str, results: list[dict]) -> dict:
    snippets = "\n".join(f"- {r['title']} ({r['url']}): {r['snippet']}" for r in results[:12])
    messages = [
        {"role": "system", "content": "You pull facts for a DJ's booking pitch out of research notes and search results. "
                                      "Use only what the notes or results actually say. Leave a field empty rather than guess. "
                                      "Genre must be the closest of: house, techno, trance, bigroom (big room / festival EDM), dnb (drum & bass)."},
        {"role": "user", "content": f"Event: {json.dumps(_event_brief(event))}\n\nResearch notes:\n{notes or '(none)'}\n\nSearch results:\n{snippets or '(none)'}"},
    ]
    facts = _meta_json(messages, "PitchFacts", FACTS_SCHEMA, effort="low")
    facts["contacts"] = [c for c in facts.get("contacts") or [] if isinstance(c, dict)]
    return facts


def _confirm_contact(event: dict, facts: dict, citations: list[dict], results: list[dict]) -> tuple[dict, list[str]]:
    """Keep a booking address (and a name) only if it's really on a page. Returns it, and the pages read."""
    venue = event.get("venue") or {}
    words = {w for w in re.findall(r"[a-z0-9]{4,}", f"{venue.get('name', '')} {event.get('promoter', '')}".lower())}
    candidates = [c for c in facts.get("contacts") or [] if _EMAIL.fullmatch((c.get("email") or "").strip())]

    # Read the pages the contacts came from first, then the venue's and promoter's own sites.
    urls = [c.get("source_url") for c in candidates] + [x["url"] for x in citations] + [r["url"] for r in results]
    ranked = sorted(_dedupe([{"url": u} for u in urls if u]), key=lambda x: -sum(w in x["url"].lower() for w in words))
    texts: dict[str, str] = {}
    for item in ranked:
        if len(texts) >= MAX_PAGES:
            break
        text = _read_page(item["url"])
        if text:
            texts[item["url"]] = text
    snippets = " ".join(r["snippet"] for r in results)

    snippets = _deobfuscate(snippets)

    # Where an address appears, and whether the words there say it's for DJs and bookings.
    def on_page(email: str) -> tuple[str | None, bool | None]:
        for url, text in [*texts.items(), ("search result", snippets)]:
            if email.lower() in text.lower():
                return url, _inbox_fits(text, email)
        return None, None

    ruled_out = []  # on a page, but for something else (private hire, jobs...)
    for c in sorted(candidates, key=lambda c: -bool(_BOOKING.search(c["email"]))):
        email = c["email"].strip()
        where, fits = on_page(email)
        if where and fits is False:
            ruled_out.append(email.lower())
        elif where:
            name = (c.get("name") or "").strip()
            named = name and any(name.lower() in t.lower() for t in [*texts.values(), snippets])
            return {"email": email, "name": name if named else "", "role": c.get("role") or "", "source": where}, list(texts)

    # Nothing the model found checks out: fall back to an address the venue's or promoter's own pages
    # plainly give for bookings.
    for url, text in texts.items():
        if not any(w in url.lower() for w in words):
            continue
        for email in dict.fromkeys(_EMAIL.findall(text)):
            if _NOT_EMAIL.search(email):
                continue
            fits = _inbox_fits(text, email)
            if fits or (fits is None and _BOOKING.search(email.split("@")[0])):
                return {"email": email, "name": "", "role": "bookings", "source": url}, list(texts)
            if fits is False:
                ruled_out.append(email.lower())
    return {"email": "", "name": "", "role": facts.get("reader") or "", "source": "", "ruled_out": ruled_out}, list(texts)


def _inbox_fits(text: str, email: str) -> bool | None:
    """Whether the words just before an address say it's for DJs and bookings (True), for something
    else such as private hire or jobs (False), or don't say (None)."""
    low, e = text.lower(), email.lower()
    verdict = None
    for m in re.finditer(re.escape(e), low):
        lead = low[max(0, m.start() - 90):m.start()]
        if _WRONG_INBOX.search(lead):
            verdict = False
        elif _DJ_INBOX.search(lead) or re.search(r"\bbook", lead):
            return True
    return verdict


WRITER = """You write short booking emails for a working DJ, in their own voice. The reader is a busy promoter or talent buyer who gets dozens of these a week and deletes anything that reads like a template.

How it should read:
- Like the DJ typed it themselves in a couple of minutes: plain, friendly, direct. Use contractions. Short sentences; the odd fragment is fine.
- 70 to 130 words in the body before the sign-off.
- Open with why you're writing, tied to this night or this room. Use one concrete detail that shows you know the place, and only a detail from the facts given.
- Say what you'd play in that room in everyday words, and that a short clip is attached (say the genre and roughly how long it is).
- One small, clear ask. No pressure, no follow-up threats.
- If the facts say how they want DJs to get in touch (say, a link to a full mix and a short bio), make this email that submission: include what they ask for where the profile has it, and don't ask whether you may submit. Never suggest they invited the email, and don't put email addresses in the body.
- Greet the reader by first name only if a name is given. Otherwise "Hi" or "Hi <venue or promoter> team".
- Sign off with the DJ's name and links exactly as given, nothing else.

Never:
- Invent anything about the DJ: no gigs, residencies, numbers or press that aren't in the profile.
- Use em dashes, en dashes, bullet points, headings, emoji, or more than one exclamation mark.
- Use stock phrases such as: "I hope this email finds you well", "I'm reaching out", "I came across", "I'd love the opportunity", "passionate", "elevate", "vibrant", "curated", "unique blend", "take the crowd on a journey", "seamless", "delve", "resonate", "thrilled", "look forward to hearing from you", "Best regards".
- Flatter in general terms ("amazing venue", "incredible lineup").

Subject: short and specific, the way a person types one, under 60 characters. Lowercase is fine."""

EMAIL_SCHEMA = {
    "type": "object",
    "properties": {"subject": {"type": "string"}, "body": {"type": "string"}},
    "required": ["subject", "body"],
    "additionalProperties": False,
}


def _write(event: dict, facts: dict, contact: dict, profile: dict, clip: dict) -> dict:
    who = {k: str(profile.get(k) or "").strip()[:400] for k in ("name", "djName", "city", "links", "about")}
    clip_words = f"{GENRE_NAMES.get(clip.get('genre'), 'house')}, about {round(clip.get('seconds') or 35)} seconds"
    if clip.get("bpm"):
        clip_words += f", {clip['bpm']} BPM"
    made = ""
    if profile.get("mentionRepo") and clip.get("repo"):
        made = (f"\nThe clip was generated with DJRepo from the code and commit history of the GitHub repo {clip['repo']}. "
                "Mention that in one short, plain sentence of fact. Don't comment on it or joke about it.")
    brief = {
        "event": _event_brief(event),
        "facts": {k: facts.get(k, "") for k in ("venue_summary", "night_summary", "detail", "ask", "submissions")},
        "reader": {"name": contact.get("name", ""), "role": contact.get("role") or facts.get("reader", "")},
        "dj": who,
        "clip": clip_words,
    }
    messages = [
        {"role": "system", "content": WRITER + made},
        {"role": "user", "content": json.dumps(brief, ensure_ascii=False)},
    ]
    email = _meta_json(messages, "BookingEmail", EMAIL_SCHEMA)
    problems = _template_smells(f"{email.get('subject', '')}\n{email.get('body', '')}")
    if problems:  # one more go, told exactly what gave it away
        messages += [
            {"role": "assistant", "content": json.dumps(email)},
            {"role": "user", "content": "Rewrite it. These make it read like a template: " + "; ".join(problems)
                                        + ". Keep everything true, and keep it short."},
        ]
        email = _meta_json(messages, "BookingEmail", EMAIL_SCHEMA)
    return {"subject": _tidy(email.get("subject", ""))[:90], "body": _tidy(email.get("body", ""))}


def _template_smells(text: str) -> list[str]:
    low = text.lower()
    found = [f'"{p}"' for p in STOCK if p in low]
    if "—" in text or "–" in text:
        found.append("dashes")
    if text.count("!") > 1:
        found.append("exclamation marks")
    if re.search(r"^\s*[-*•]\s", text, re.M):
        found.append("bullet points")
    return found


def _tidy(text: str) -> str:
    text = text.replace(" — ", ", ").replace("—", ", ").replace("–", "-")
    text = text.replace("“", '"').replace("”", '"').replace("‘", "'").replace("’", "'")
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _event_brief(event: dict) -> dict:
    venue = event.get("venue") or {}
    return {
        "name": event.get("name"), "date": event.get("date"), "time": event.get("time"),
        "venue": venue.get("name"), "city": venue.get("city"), "promoter": event.get("promoter"),
        "lineup": event.get("lineup"), "genre": event.get("subGenre") or event.get("genre"), "info": event.get("info"),
    }


# ---------------------------------------------------------------------------
# The Meta Model API


def _model() -> str:
    return os.environ.get("META_MODEL", "muse-spark-1.3")


def _meta(path: str, body: dict) -> dict:
    base = os.environ.get("META_API_BASE", "https://api.meta.ai/v1").rstrip("/")
    req = urllib.request.Request(
        base + path, data=json.dumps(body).encode("utf-8"), method="POST",
        headers={"Authorization": f"Bearer {os.environ.get('MODEL_API_KEY', '')}", "Content-Type": "application/json",
                 "User-Agent": USER_AGENT},
    )
    try:
        with urllib.request.urlopen(req, timeout=150) as res:
            return json.loads(res.read())
    except urllib.error.HTTPError as exc:
        raise BuildError(_http_problem("The Meta Model API", exc)) from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise BuildError(f"Couldn't reach the Meta Model API ({exc}).") from exc
    except ValueError as exc:
        raise BuildError("The Meta Model API sent back something that wasn't JSON.") from exc


def _meta_json(messages: list[dict], name: str, schema: dict, effort: str = "medium") -> dict:
    resp = _meta("/chat/completions", {
        "model": _model(),
        "messages": messages,
        "reasoning_effort": effort,  # Muse Spark reasons first; less of it is much quicker
        "response_format": {"type": "json_schema", "json_schema": {"name": name, "strict": True, "schema": schema}},
    })
    try:
        content = resp["choices"][0]["message"]["content"]
        if isinstance(content, list):  # some servers return content blocks
            content = "".join(b.get("text", "") for b in content if isinstance(b, dict))
        data = json.loads(content)
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        raise BuildError("Muse Spark's answer didn't come back in the expected shape. Try again.") from exc
    if not isinstance(data, dict):
        raise BuildError("Muse Spark's answer didn't come back in the expected shape. Try again.")
    return data


def _http_problem(service: str, exc: urllib.error.HTTPError) -> str:
    """The service's own explanation of an error, if it gave one. Never includes the request URL,
    which can carry a key."""
    detail = ""
    try:
        body = json.loads(exc.read(2000).decode("utf-8", "replace"))
        if isinstance(body, dict):
            err = body.get("error")
            if isinstance(err, dict):
                detail = err.get("message") or ""
            elif isinstance(err, str):
                detail = err
            else:
                detail = body.get("message") or (body.get("fault") or {}).get("faultstring") or ""
    except (ValueError, OSError, AttributeError):
        pass
    if exc.code in (401, 403):
        return f"{service} turned the key down ({exc.code}). Check it in .env." + (f" {detail}" if detail else "")
    if exc.code == 429:
        return f"{service} says too many requests for now. Wait a minute and try again."
    return f"{service} answered {exc.code}." + (f" {str(detail)[:300]}" if detail else "")


# ---------------------------------------------------------------------------
# Reading pages, to confirm a contact


class _Text(HTMLParser):
    """Visible text plus email addresses from links, including Cloudflare-protected ones."""

    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "noscript", "svg"):
            self.skip += 1
        for key, value in attrs:
            if not value:
                continue
            if key == "href" and value.lower().startswith("mailto:"):
                self.parts.append(" " + urllib.parse.unquote(value[7:].split("?")[0]) + " ")
            elif key == "data-cfemail" or (key == "href" and "/cdn-cgi/l/email-protection#" in value):
                self.parts.append(" " + _cloudflare_email(value.rsplit("#", 1)[-1]) + " ")

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript", "svg") and self.skip:
            self.skip -= 1

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def _cloudflare_email(code: str) -> str:
    try:
        key = int(code[:2], 16)
        return "".join(chr(int(code[i:i + 2], 16) ^ key) for i in range(2, len(code), 2))
    except ValueError:
        return ""


def _deobfuscate(text: str) -> str:
    return _DOT.sub(".", _AT.sub("@", text))


def _read_page(url: str) -> str:
    """A public web page's text, or '' if it can't (or shouldn't) be read."""
    try:
        raw = _get(url, timeout=10, limit=PAGE_LIMIT, public_only=True)
    except Exception:  # any page that won't load is simply skipped
        return ""
    parser = _Text()
    try:
        parser.feed(raw.decode("utf-8", "replace"))
    except Exception:
        return ""
    return _deobfuscate(re.sub(r"\s+", " ", " ".join(parser.parts)))


def _public(host: str) -> bool:
    """True if every address the host resolves to is on the public internet."""
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return False
    return bool(infos) and all(ipaddress.ip_address(i[4][0].split("%")[0]).is_global for i in infos)


class _PublicRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parts = urllib.parse.urlsplit(newurl)
        if parts.scheme not in ("http", "https") or not _public(parts.hostname or ""):
            raise urllib.error.URLError("redirect to a non-public address")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_opener = urllib.request.build_opener(_PublicRedirects)


def _get(url: str, timeout: float, limit: int = 8_000_000, public_only: bool = False) -> bytes:
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise urllib.error.URLError("not a web address")
    if public_only and not _public(parts.hostname or ""):
        raise urllib.error.URLError("not a public address")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/json;q=0.9,*/*;q=0.5"})
    with _opener.open(req, timeout=timeout) as res:
        return res.read(limit)


def _clean_url(url: str) -> str:
    """The address without tracking parameters (utm_ and the like)."""
    parts = urllib.parse.urlsplit(url)
    query = [(k, v) for k, v in urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
             if not k.lower().startswith(("utm_", "fbclid", "gclid"))]
    return urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(query)))


def _dedupe(items: list[dict]) -> list[dict]:
    seen, out = set(), []
    for item in items:
        key = item["url"].split("#")[0].rstrip("/").lower()
        if key not in seen:
            seen.add(key)
            out.append(item)
    return out
