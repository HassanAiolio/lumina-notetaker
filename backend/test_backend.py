"""Unit tests for the parts that must not break: parsing, fallbacks, limits.

Run with:  cd backend && python -m pytest
Nothing here touches the network or the database.
"""
import base64
import io
import json
import math
import struct
import sys
import wave
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).parent))


async def _no_sleep(*_a, **_k):
    return None

import gemini  # noqa: E402
import languages  # noqa: E402
import ratelimit  # noqa: E402
import retranscribe  # noqa: E402
import summarizer  # noqa: E402
import transcription  # noqa: E402
from models import NoteCreate, NoteUpdate, SummarizeRequest  # noqa: E402


# ── Language detection ────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "text,expected",
    [
        ("Nous avons discute du budget pour le projet avec les equipes cette semaine", "fr"),
        ("The team discussed the budget for this project and what we will do next", "en"),
        ("El equipo hablo sobre el presupuesto para este proyecto con todos los socios", "es"),
        ("Das Team hat uber das Budget fur dieses Projekt gesprochen und nicht mehr", "de"),
        ("今日は会議で予算について話しました", "ja"),
        ("", languages.AUTO),
        ("ok", languages.AUTO),
    ],
)
def test_detect(text, expected):
    assert languages.detect(text) == expected


@pytest.mark.parametrize(
    "raw,expected",
    [("fr-FR", "fr"), ("FR", "fr"), ("en_US", "en"), ("auto", "auto"), ("", "auto"),
     (None, "auto"), ("klingon", "auto")],
)
def test_normalize_language(raw, expected):
    assert languages.normalize(raw) == expected


# ── JSON recovery ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "raw",
    [
        '{"title": "A"}',
        '```json\n{"title": "A"}\n```',
        '```\n{"title": "A"}\n```',
        'Here you go:\n{"title": "A"}\nHope that helps!',
        '{"title": "A",}',
        '[{"title": "A"}]',
    ],
)
def test_parse_json_object_recovers(raw):
    assert gemini.parse_json_object(raw)["title"] == "A"


def test_parse_json_object_gives_up_cleanly():
    assert gemini.parse_json_object("not json at all") == {}
    assert gemini.parse_json_object("") == {}


# ── Summary normalization ─────────────────────────────────────────────────────

def test_normalize_strips_placeholders_and_markers():
    result = summarizer.normalize_result(
        {
            "title": "  Sprint review  ",
            "type": "meeting",
            "language": "fr",
            "sections": {
                "Summary": ["- first point", "first point", "No decisions identified"],
                "action_items": ["1) call the vendor"],
                "empty_one": [],
            },
            "labels": {"summary": "Resume", "action_items": "Actions", "ghost": "x"},
        },
        requested_language="auto",
        transcript="whatever",
    )
    assert result["title"] == "Sprint review"
    assert result["type"] == "MEETING"
    assert result["language"] == "fr"
    assert result["sections"]["summary"] == ["first point"]
    assert result["sections"]["action_items"] == ["call the vendor"]
    assert "empty_one" not in result["sections"]
    assert "ghost" not in result["labels"]


def test_normalize_accepts_flat_shape():
    result = summarizer.normalize_result(
        {"title": "T", "summary": ["a"], "key_concepts": ["b"], "homework": ["c"]},
        requested_language="en",
        transcript="t",
    )
    assert result["type"] == "LECTURE"
    assert set(result["sections"]) == {"summary", "key_concepts", "homework"}


def test_normalize_survives_garbage():
    result = summarizer.normalize_result({}, requested_language="auto", transcript="Hello there world.")
    assert result["title"]
    assert result["sections"] == {}


def test_bullets_unwrap_dicts_and_dedupe():
    assert summarizer._clean_bullets(
        [{"text": "one"}, "one", "* two", 42, None, ""]
    ) == ["one", "two"]


@pytest.mark.parametrize(
    "bullet",
    ["No decisions identified", "None", "N/A", "Aucune tache", "Not applicable",
     "no follow-ups", "Keine Aufgaben"],
)
def test_placeholder_bullets_dropped(bullet):
    assert summarizer._clean_bullets([bullet]) == []


@pytest.mark.parametrize(
    "bullet",
    ["No budget was approved for Q3 because of the hiring freeze",
     "None of the vendors replied before Friday",
     "Decide on the vendor by Friday"],
)
def test_real_bullets_kept(bullet):
    assert summarizer._clean_bullets([bullet]) == [bullet]


# ── Offline fallback ──────────────────────────────────────────────────────────

def test_fallback_separates_actions_and_keeps_language():
    transcript = (
        "Bonjour tout le monde. Nous avons parle du budget de 5000 euros. "
        "Il faut contacter le fournisseur avant vendredi. Marie prepare le dossier complet."
    )
    result = summarizer.fallback_summary(transcript, "auto")
    assert result["degraded"] is True
    assert result["language"] == "fr"
    assert result["labels"]["summary"] == "Résumé"
    assert any("fournisseur" in item for item in result["sections"]["action_items"])
    assert result["title"]


def test_fallback_on_empty_transcript_does_not_explode():
    result = summarizer.fallback_summary("", "auto")
    assert result["sections"] == {}
    assert result["title"] == "Untitled note"


# ── Audio ─────────────────────────────────────────────────────────────────────

def make_wav(seconds: float, rate: int = 16000) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(
            b"".join(struct.pack("<h", int(3000 * math.sin(i / 20))) for i in range(int(seconds * rate)))
        )
    return buffer.getvalue()


def test_wav_info():
    duration, channels, width, rate = transcription.wav_info(make_wav(3))
    assert round(duration, 2) == 3.0
    assert (channels, width, rate) == (1, 2, 16000)


def test_wav_info_on_non_wav():
    assert transcription.wav_info(b"definitely not a wav file") is None


def test_split_wav_keeps_total_duration():
    chunks = transcription.split_wav(make_wav(10), 4)
    assert len(chunks) == 3
    assert round(sum(transcription.wav_info(c)[0] for c in chunks), 2) == 10.0
    # Every chunk must be a standalone, playable WAV.
    assert all(transcription.wav_info(c) is not None for c in chunks)


def test_split_wav_leaves_short_audio_alone():
    data = make_wav(5)
    assert transcription.split_wav(data, 240) == [data]


@pytest.mark.parametrize(
    "given,expected",
    [("audio/webm;codecs=opus", "audio/ogg"), ("audio/wav", "audio/wav"),
     ("AUDIO/MPEG", "audio/mp3"), ("audio/mp4", "audio/aac")],
)
def test_mime_normalization(given, expected):
    assert transcription.normalize_mime(given) == expected


@pytest.mark.parametrize("given", ["application/pdf", "", None, "text/plain"])
def test_mime_rejection(given):
    with pytest.raises(transcription.AudioError):
        transcription.normalize_mime(given)


@pytest.mark.parametrize(
    "text,is_silence",
    [("[no speech detected]", True), ("Silence.", True),
     ("No, we should not ship on Friday", False), ("Bonjour a tous", False)],
)
def test_no_speech_detection(text, is_silence):
    assert bool(transcription._NO_SPEECH.match(text)) is is_silence


@pytest.mark.asyncio
async def test_transcribe_rejects_empty_and_oversized():
    with pytest.raises(transcription.AudioError):
        await transcription.transcribe(b"", "audio/wav")
    with pytest.raises(transcription.AudioError):
        await transcription.transcribe(b"x" * 40_000_000, "audio/wav")


# ── Validation and limits ─────────────────────────────────────────────────────

def test_summarize_request_rejects_blank():
    with pytest.raises(ValueError):
        SummarizeRequest(transcript="   ")


def test_note_create_cleans_input():
    note = NoteCreate(title="  ", tags=["Work", "work", " PROJET ", ""], ignored="x")
    assert note.title == "Untitled note"
    assert note.tags == ["work", "projet"]


def test_note_update_leaves_unset_fields_alone():
    update = NoteUpdate(title="New")
    assert update.model_dump(exclude_unset=True) == {"title": "New"}


def test_rate_limit_allows_then_blocks():
    ratelimit.reset()
    for _ in range(3):
        ratelimit.check("user:test", 3, 60)
    with pytest.raises(Exception) as excinfo:
        ratelimit.check("user:test", 3, 60)
    assert excinfo.value.status_code == 429
    # A different key has its own budget.
    ratelimit.check("user:other", 3, 60)


# -- retranscribe: loop cleanup ------------------------------------------------
# This one deletes words from someone's transcript, so it gets pinned down.

def test_drop_loops_cuts_a_decoder_loop():
    parts = ["Bonjour.", "Ça démarre mal.", "Ça démarre mal.", "Ça démarre mal.",
             "Ça démarre mal.", "Ensuite."]
    cleaned, removed = retranscribe.drop_loops(parts)
    assert cleaned == ["Bonjour.", "Ça démarre mal.", "Ça démarre mal.", "Ensuite."]
    assert removed == 2


def test_drop_loops_leaves_real_repetition_alone():
    # People really do say things twice; only a longer run is the model stuttering.
    parts = ["OK.", "OK.", "Donc voilà.", "Pourquoi ?", "Pourquoi ?"]
    cleaned, removed = retranscribe.drop_loops(parts)
    assert cleaned == parts
    assert removed == 0


def test_drop_loops_only_collapses_adjacent_repeats():
    # The same phrase coming back later in the lecture is not a loop.
    parts = ["Un exemple.", "Autre chose.", "Un exemple.", "Encore autre chose.", "Un exemple."]
    cleaned, removed = retranscribe.drop_loops(parts)
    assert cleaned == parts
    assert removed == 0


def test_drop_loops_never_invents_or_reorders():
    parts = ["a", "b", "b", "b", "c", "c", "c", "c", "d"]
    cleaned, removed = retranscribe.drop_loops(parts)
    assert removed == len(parts) - len(cleaned)
    assert set(cleaned) <= set(parts)          # nothing new appeared
    assert [p for p in parts if p in cleaned][:1] == cleaned[:1]  # order preserved
    assert cleaned == ["a", "b", "b", "c", "c", "d"]


def test_drop_loops_handles_empty_input():
    assert retranscribe.drop_loops([]) == ([], 0)


# -- gemini: audio is streamed, never held whole --------------------------------
# Every upload goes through this splice, so a subtle bug here corrupts all audio.

def _wav_bytes(seconds=1, sample_rate=16000):
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(sample_rate)
        out.writeframes(b"\x01\x02" * (seconds * sample_rate))
    return buffer.getvalue()


class _Recorder(httpx.AsyncBaseTransport):
    """Captures what actually went on the wire, including how it was framed."""

    def __init__(self, status=200, text='{"text":"ok","language":"fr"}'):
        self.status, self.text, self.requests = status, text, []

    async def handle_async_request(self, request):
        chunks = [chunk async for chunk in request.stream]
        self.requests.append({
            "body": b"".join(chunks),
            "blocks": len(chunks),
            "content_length": request.headers.get("Content-Length"),
        })
        return httpx.Response(self.status, json={"candidates": [
            {"content": {"parts": [{"text": self.text}]}, "finishReason": "STOP"}]})


@pytest.fixture
def recorder(monkeypatch):
    transport = _Recorder()
    monkeypatch.setattr(gemini.settings, "GEMINI_API_KEY", "test-key")
    monkeypatch.setattr(gemini, "_client", httpx.AsyncClient(transport=transport))
    return transport


async def test_inline_audio_arrives_byte_exact(recorder):
    audio = _wav_bytes(3)
    await gemini.generate([{"text": "prompt"}], models=["m"], inline_audio=("audio/wav", audio))

    sent = recorder.requests[0]
    payload = json.loads(sent["body"])  # must still be valid JSON
    parts = payload["contents"][0]["parts"]
    inline = next(p for p in parts if "inline_data" in p)

    assert base64.b64decode(inline["inline_data"]["data"]) == audio
    assert inline["inline_data"]["mime_type"] == "audio/wav"
    assert any(p.get("text") == "prompt" for p in parts)
    assert gemini._AUDIO_SENTINEL not in sent["body"].decode("utf-8", "replace")


async def test_inline_audio_is_sent_in_blocks_not_one_buffer(recorder):
    await gemini.generate([{"text": "p"}], models=["m"],
                          inline_audio=("audio/wav", _wav_bytes(20)))
    # head + several encoded blocks + tail: proof it is not materialised whole.
    assert recorder.requests[0]["blocks"] > 3


@pytest.mark.parametrize("extra", [0, 1, 2])
async def test_content_length_matches_body_for_any_padding(recorder, extra):
    # base64 pads to a multiple of 4; the declared length must survive that.
    audio = _wav_bytes(1) + b"\x00" * extra
    await gemini.generate([{"text": "p"}], models=["m"], inline_audio=("audio/wav", audio))
    sent = recorder.requests[0]
    assert int(sent["content_length"]) == len(sent["body"])


async def test_audio_body_is_resent_on_retry(recorder, monkeypatch):
    # A generator consumed by the first attempt would leave the retry empty.
    monkeypatch.setattr(gemini.settings, "GEMINI_MAX_ATTEMPTS", 2)
    monkeypatch.setattr(gemini.asyncio, "sleep", _no_sleep)
    recorder.status = 503
    audio = _wav_bytes(2)

    with pytest.raises(gemini.GeminiError):
        await gemini.generate([{"text": "p"}], models=["m"], inline_audio=("audio/wav", audio))

    assert len(recorder.requests) == 2
    bodies = {r["body"] for r in recorder.requests}
    assert len(bodies) == 1  # identical, and neither one empty
    assert len(recorder.requests[1]["body"]) == len(recorder.requests[0]["body"])


async def test_requests_without_audio_are_unchanged(recorder):
    await gemini.generate([{"text": "just text"}], models=["m"])
    payload = json.loads(recorder.requests[0]["body"])
    assert payload["contents"][0]["parts"] == [{"text": "just text"}]


async def test_split_wav_trusts_caller_supplied_header():
    data = _wav_bytes(2)
    info = transcription.wav_info(data)
    assert transcription.split_wav(data, 240, info) == [data]
    # and still works when it has to read the header itself
    assert transcription.split_wav(data, 240) == [data]
