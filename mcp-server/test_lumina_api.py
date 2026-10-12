"""The MCP server's API client and text, against a fake Lumina API."""
import httpx
import pytest

from lumina_api import (
    LuminaClient,
    LuminaError,
    api_root,
    flashcards,
    flashcards_text,
    note_markdown,
    search_results,
)

NOTE = {
    "id": "n1",
    "title": "Entropie",
    "type": "LECTURE",
    "language": "fr",
    "created_at": "2026-10-12T09:30:00+00:00",
    "tags": ["thermo"],
    "labels": {"overview": "Vue d'ensemble"},
    "sections": {
        "overview": ["L'entropie mesure le désordre [p. 4]."],
        "definitions": ["**Entropie** : $S = k_B \\ln \\Omega$"],
        "review_questions": ["Unité de S ? → J/K", "Pas une question"],
    },
    "raw_transcript": "Bonjour. On commence.",
    "slides": {"name": "cours3.pdf"},
}


def fake_api(seen):
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.headers.get("authorization") != "Bearer lum_good":
            return httpx.Response(401, json={"detail": "Unknown or revoked API token"})
        if request.url.path == "/api/notes":
            return httpx.Response(200, json={"items": [NOTE], "total": 1, "limit": 20, "offset": 0})
        if request.url.path == "/api/notes/n1":
            return httpx.Response(200, json=NOTE)
        if request.url.path == "/api/tags":
            return httpx.Response(200, json=["thermo"])
        if request.url.path == "/api/notes/slow":
            raise httpx.ReadTimeout("slow", request=request)
        return httpx.Response(404, json={"detail": "Note not found"})

    return httpx.MockTransport(handler)


def make_client(seen, token="lum_good"):
    return LuminaClient("https://lumina.example.com", token, transport=fake_api(seen))


def test_the_api_address_takes_either_form():
    assert api_root("https://x.onrender.com") == "https://x.onrender.com/api"
    assert api_root("https://x.onrender.com/api/") == "https://x.onrender.com/api"
    with pytest.raises(LuminaError, match="LUMINA_API_URL"):
        api_root("")


def test_a_missing_or_malformed_token_is_explained():
    with pytest.raises(LuminaError, match="LUMINA_TOKEN is not set"):
        LuminaClient("https://x", "")
    with pytest.raises(LuminaError, match="start with lum_"):
        LuminaClient("https://x", "eyJhbGciOi.session.jwt")


async def test_search_sends_the_filters_and_asks_for_the_brief_list():
    seen = []
    page = await make_client(seen).search_notes("entropie", "#Thermo", "lecture", 500)
    assert page["total"] == 1
    params = seen[0].url.params
    assert params["search"] == "entropie"
    assert params["tag"] == "thermo"
    assert params["type"] == "LECTURE"
    assert params["limit"] == "50"
    assert params["brief"] == "true"


async def test_empty_filters_are_not_sent():
    seen = []
    await make_client(seen).search_notes()
    assert set(seen[0].url.params.keys()) == {"limit", "brief"}


async def test_errors_say_what_to_do():
    seen = []
    with pytest.raises(LuminaError, match="revoked"):
        await make_client(seen, token="lum_revoked").list_tags()
    with pytest.raises(LuminaError, match="search_notes"):
        await make_client(seen).get_note("missing")
    with pytest.raises(LuminaError, match="waking up"):
        await make_client(seen).get_note("slow")


async def test_reads_a_note_and_the_tags():
    seen = []
    lumina = make_client(seen)
    assert (await lumina.get_note("n1"))["title"] == "Entropie"
    assert await lumina.list_tags() == ["thermo"]


def test_search_results_name_each_note_with_its_id():
    text = search_results({"items": [NOTE], "total": 3})
    assert text.startswith("3 note(s) match; showing 1")
    assert "**Entropie** (id: n1) 2026-10-12 · lecture · #thermo" in text
    assert "L'entropie mesure" in text
    assert search_results({"items": [], "total": 0}) == "No notes match."


def test_a_note_reads_as_markdown_with_the_transcript_on_request():
    text = note_markdown(NOTE)
    assert text.startswith("# Entropie\n\nid: n1\ndate: 2026-10-12\ntype: lecture\nlanguage: fr\ntags: #thermo")
    assert "## Vue d'ensemble\n- L'entropie" in text
    assert "## Definitions\n- **Entropie**" in text
    assert "Bonjour" not in text and "21 characters" in text
    assert "## Transcript\nBonjour. On commence." in note_markdown(NOTE, include_transcript=True)


def test_old_notes_with_fixed_sections_still_read():
    text = note_markdown({"id": "old", "title": "Old", "summary": ["Done"], "action_items": ["Ship"]})
    assert "## Summary\n- Done" in text and "## Action Items\n- Ship" in text


def test_flashcards_match_the_apps_revision_deck():
    cards = flashcards(NOTE)
    assert cards == [
        {"kind": "question", "front": "Unité de S ?", "back": "J/K"},
        {"kind": "definitions", "front": "Entropie", "back": "$S = k_B \\ln \\Omega$"},
    ]
    assert "1. Q: Unité de S ?\n   A: J/K" in flashcards_text(NOTE)
    assert "no review questions" in flashcards_text({"title": "Empty", "sections": {}})
