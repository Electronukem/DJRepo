"""The gig finder's checks: that it only ever uses booking contacts it can show on a real page, that
template phrases get caught, and the plumbing around Ticketmaster and the pages it reads. No network:
pages are stubbed."""
import pytest

import gigs


# ---- searching -------------------------------------------------------------------------------

def test_geohash_matches_the_reference_example():
    assert gigs.geohash(57.64911, 10.40744, 11) == "u4pruydqqvj"  # Wikipedia's worked example
    assert gigs.geohash(42.3601, -71.0589, 7) == "drt2zp2"  # Boston, where the gig finder opens


@pytest.mark.parametrize("listing, genre", [
    ({"subGenre": "Techno"}, "techno"),
    ({"subGenre": "Drum & Bass"}, "dnb"),
    ({"subGenre": "Dubstep"}, "bigroom"),
    ({"subGenre": "House"}, "house"),
    ({"subGenre": "Trance"}, "trance"),
    ({"subGenre": "Undefined", "name": "Jungle Sundays"}, "dnb"),
    ({"subGenre": "Other"}, "house"),
])
def test_genre_from_the_listing(listing, genre):
    assert gigs.guess_genre(listing) == genre


def test_kids_events_are_filtered_by_name():
    assert gigs._FOR_KIDS.search("Lenny Pearce - Toddler Rave World Tour")
    assert not gigs._FOR_KIDS.search("Warehouse Techno Night")


def test_tracking_parameters_are_stripped_from_sources():
    assert gigs._clean_url("https://ra.co/events/2538849?utm_source=Instagram&utm_medium=cpa&id=7") == "https://ra.co/events/2538849?id=7"


# ---- reading pages -------------------------------------------------------------------------------

def cloudflare(email, key=0x42):
    return f"{key:02x}" + "".join(f"{ord(c) ^ key:02x}" for c in email)


def test_page_text_finds_mailto_cloudflare_and_obfuscated_addresses():
    page = gigs._Text()
    page.feed(f'<p>Contact <a href="mailto:Talent@Club.com?subject=x">us</a> or '
              f'<span data-cfemail="{cloudflare("booking@club.com")}">[email&#160;protected]</span></p>'
              '<script>var hidden = "x@y.com"</script>')
    text = gigs._deobfuscate(" ".join(page.parts))
    assert "Talent@Club.com" in text
    assert "booking@club.com" in text
    assert "x@y.com" not in text  # scripts aren't page text
    assert "bookings@venue.co.uk" in gigs._deobfuscate("bookings [at] venue (dot) co (dot) uk")


def test_cloudflare_decoding():
    assert gigs._cloudflare_email(cloudflare("demos@fabric.example", 0x17)) == "demos@fabric.example"


@pytest.mark.parametrize("host", ["localhost", "127.0.0.1", "10.0.0.5", "192.168.1.1", "not-a-real-host.invalid"])
def test_private_and_unknown_hosts_are_never_read(host):
    assert not gigs._public(host)


# ---- whose inbox is it ----------------------------------------------------------------------------

# From fabric London's FAQ (Nov 2026): the address that a naive check picked for a demo.
FABRIC_FAQ = ("Who deals with table booking, private hire and coach booking? For VIP table bookings please email: "
              "vip@fabriclondon.com For Private hire, please email: events@fabriclondon.com Please note: we do not "
              "allow stag nights. If you lose something at fabric, you can email cloakroom@fabriclondon.com")


def test_a_private_hire_inbox_is_ruled_out():
    assert gigs._inbox_fits(FABRIC_FAQ, "events@fabriclondon.com") is False
    assert gigs._inbox_fits(FABRIC_FAQ, "vip@fabriclondon.com") is False
    assert gigs._inbox_fits(FABRIC_FAQ, "cloakroom@fabriclondon.com") is False


def test_a_booking_inbox_is_recognised():
    assert gigs._inbox_fits("For DJ demos and bookings: talent@club.example", "talent@club.example") is True
    assert gigs._inbox_fits("Say hello: hi@club.example", "hi@club.example") is None


@pytest.fixture
def pages(monkeypatch):
    """Stub the web: a dict of url -> page text."""
    site = {}
    monkeypatch.setattr(gigs, "_read_page", lambda url: site.get(url, ""))
    return site


EVENT = {"venue": {"name": "Club Example"}, "promoter": ""}


def test_only_addresses_on_a_real_page_are_used(pages):
    pages["https://club.example/contact"] = "Bookings: bookings@club.example (Jo Smith)"
    facts = {"contacts": [
        {"email": "made.up@nowhere.example", "name": "Pat", "role": "x", "source_url": "https://nowhere.example"},
        {"email": "bookings@club.example", "name": "Jo Smith", "role": "booker", "source_url": "https://club.example/contact"},
    ]}
    contact, _ = gigs._confirm_contact(EVENT, facts, [], [])
    assert contact["email"] == "bookings@club.example"
    assert contact["name"] == "Jo Smith"


def test_a_name_no_page_mentions_is_dropped(pages):
    pages["https://club.example/contact"] = "Bookings: bookings@club.example"
    facts = {"contacts": [{"email": "bookings@club.example", "name": "Invented Person", "role": "booker",
                           "source_url": "https://club.example/contact"}]}
    contact, _ = gigs._confirm_contact(EVENT, facts, [], [])
    assert contact["email"] == "bookings@club.example"
    assert contact["name"] == ""


def test_an_address_nobody_can_show_is_never_used(pages):
    facts = {"contacts": [{"email": "guess@club.example", "name": "", "role": "x", "source_url": "https://club.example"}],
             "reader": "the booker"}
    contact, _ = gigs._confirm_contact(EVENT, facts, [], [])
    assert contact["email"] == ""
    assert contact["role"] == "the booker"


def test_the_fabric_case_leaves_the_address_blank(pages):
    pages["https://www.fabriclondon.com/faq"] = FABRIC_FAQ
    event = {"venue": {"name": "fabric"}, "promoter": ""}
    suggested = {"contacts": [{"email": "events@fabriclondon.com", "name": "", "role": "bookings",
                               "source_url": "https://www.fabriclondon.com/faq"}], "reader": "the venue's bookers"}
    contact, _ = gigs._confirm_contact(event, suggested, [], [])
    assert contact["email"] == ""
    assert "events@fabriclondon.com" in contact["ruled_out"]


def test_falls_back_to_a_booking_address_plainly_on_the_venues_own_page(pages):
    pages["https://club.example/contact"] = "Bookings and DJ demos: talent@club.example. Private hire: hire@club.example"
    contact, _ = gigs._confirm_contact(EVENT, {"contacts": [], "reader": "r"},
                                       [{"title": "Contact", "url": "https://club.example/contact"}], [])
    assert contact["email"] == "talent@club.example"


# ---- writing like a person ------------------------------------------------------------------------

def test_template_phrases_are_caught():
    smells = gigs._template_smells("I hope this email finds you well — I'm thrilled!!")
    assert '"hope this email finds you"' in smells
    assert '"thrilled"' in smells
    assert "dashes" in smells
    assert "exclamation marks" in smells


def test_a_plain_email_passes():
    assert gigs._template_smells("Hi Sam,\n\nSaw the Friday lineup. 35 second house clip attached.\n\nCheers,\nAlex") == []


def test_tidying_quotes_and_dashes():
    assert gigs._tidy("one — two–three “q”") == 'one, two-three "q"'


def test_errors_never_echo_the_request_url():
    import io
    import urllib.error
    err = urllib.error.HTTPError("https://api.example/?apikey=SECRET", 401, "Unauthorized", {}, io.BytesIO(b'{"error": {"message": "bad key"}}'))
    message = gigs._http_problem("Ticketmaster", err)
    assert "SECRET" not in message
    assert "bad key" in message
