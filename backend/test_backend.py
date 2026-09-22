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
import groq  # noqa: E402
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


# -- groq: second provider ------------------------------------------------------

def test_split_for_window_keeps_short_transcripts_whole():
    assert summarizer.split_for_window("One. Two. Three.", 18_000) == ["One. Two. Three."]


def test_split_for_window_cuts_on_sentence_boundaries_within_budget():
    transcript = " ".join(f"Phrase numero {i}." for i in range(400))
    windows = summarizer.split_for_window(transcript, 1_000)

    assert len(windows) > 1
    assert all(len(w) <= 1_000 for w in windows)
    # Nothing dropped, and no sentence cut in half.
    assert "".join(w.replace(" ", "") for w in windows) == transcript.replace(" ", "")
    assert all(w.endswith(".") for w in windows)


def test_merge_results_concatenates_windows_and_drops_repeats():
    merged = summarizer.merge_results([
        {"title": "Cours", "type": "LECTURE", "language": "fr",
         "sections": {"overview": ["Un point"], "key_concepts": ["Concept A"]},
         "labels": {"overview": "Vue d'ensemble"}},
        {"title": "Autre", "type": "LECTURE", "language": "fr",
         # "Un point." repeats across the boundary; punctuation must not hide it.
         "sections": {"overview": ["Un point."], "key_concepts": ["Concept B"]},
         "labels": {"key_concepts": "Concepts"}},
    ])

    assert merged["sections"]["overview"] == ["Un point"]
    assert merged["sections"]["key_concepts"] == ["Concept A", "Concept B"]
    assert merged["title"] == "Cours"          # the first window names the notes
    assert merged["type"] == "LECTURE"
    assert merged["labels"]["overview"] == "Vue d'ensemble"
    assert merged["labels"]["key_concepts"] == "Concepts"


def test_merge_results_ignores_windows_that_produced_nothing():
    merged = summarizer.merge_results([
        {"title": "T", "type": "OTHER", "language": "fr", "sections": {}, "labels": {}},
        {"title": "Real", "type": "LECTURE", "language": "fr",
         "sections": {"overview": ["Something"]}, "labels": {}},
    ])
    assert merged["title"] == "Real"
    assert merged["sections"] == {"overview": ["Something"]}


def test_merge_results_of_nothing_is_empty():
    assert summarizer.merge_results([]) == {}
    assert summarizer.merge_results([{"sections": {}}]) == {}


def test_language_normalize_accepts_the_names_providers_report():
    # Groq's Whisper answers "french", not "fr"; a chat model sometimes does too.
    assert languages.normalize("french") == "fr"
    assert languages.normalize("English") == "en"
    assert languages.normalize("Deutsch") == "de"
    assert languages.normalize("fr-FR") == "fr"
    assert languages.normalize("not a language") == languages.AUTO
    assert languages.normalize(None) == languages.AUTO


async def test_groq_generate_asks_for_json_and_carries_the_system_prompt(monkeypatch):
    seen = {}

    def handler(request):
        seen.update(json.loads(request.content))
        return httpx.Response(200, json={"choices": [
            {"message": {"content": '{"title":"T"}'}, "finish_reason": "stop"}]})

    monkeypatch.setattr(groq.settings, "GROQ_API_KEY", "test-key")
    monkeypatch.setattr(groq, "_client", httpx.AsyncClient(transport=httpx.MockTransport(handler)))

    out = await groq.generate("Return JSON please", models=["m"], system_instruction="be terse")

    assert out == '{"title":"T"}'
    assert seen["response_format"] == {"type": "json_object"}
    assert seen["messages"][0] == {"role": "system", "content": "be terse"}
    assert seen["messages"][1]["content"] == "Return JSON please"


async def test_groq_walks_to_the_next_model_on_a_size_refusal(monkeypatch):
    # 413 means this request will never fit that model, so retrying it is
    # pointless - but another model has its own budget.
    tried = []

    def handler(request):
        model = json.loads(request.content)["model"]
        tried.append(model)
        if model == "small":
            return httpx.Response(413, json={"error": {"message": "too large"}})
        return httpx.Response(200, json={"choices": [
            {"message": {"content": "{}"}, "finish_reason": "stop"}]})

    monkeypatch.setattr(groq.settings, "GROQ_API_KEY", "test-key")
    monkeypatch.setattr(groq.asyncio, "sleep", _no_sleep)
    monkeypatch.setattr(groq, "_client", httpx.AsyncClient(transport=httpx.MockTransport(handler)))

    await groq.generate("p", models=["small", "big"])
    assert tried == ["small", "big"]  # one attempt at the first, not GROQ_MAX_ATTEMPTS


async def test_groq_transcribe_reports_text_and_language(monkeypatch):
    def handler(request):
        assert b"verbose_json" in request.content  # the plain format omits language
        return httpx.Response(200, json={"text": " Bonjour ", "language": "french"})

    monkeypatch.setattr(groq.settings, "GROQ_API_KEY", "test-key")
    monkeypatch.setattr(groq, "_client", httpx.AsyncClient(transport=httpx.MockTransport(handler)))

    result = await groq.transcribe(b"RIFFfake", models=["whisper"], language="fr")
    assert result == {"text": "Bonjour", "language": "french"}


# -- the fallback path under failure --------------------------------------------
# All of this only runs when something is already broken, so it needs tests more
# than the happy path does.

NOTES_JSON = '{"title":"T","type":"LECTURE","language":"fr","sections":{"overview":["%s"]},"labels":{}}'


def _long_transcript(windows=3):
    return " ".join(f"Phrase de remplissage numero {i}." for i in range(windows * 700))


async def _gemini_is_down(*_a, **_k):
    raise gemini.GeminiError("forced outage", quota=True)


async def test_groq_salvages_the_windows_that_worked(monkeypatch):
    # Losing one window is a gap; throwing away the rest to return a local
    # extraction instead would be worse.
    calls = {"n": 0}

    async def flaky(prompt, **_k):
        calls["n"] += 1
        if calls["n"] == 2:
            raise groq.GroqError("rate limited", status_code=429, quota=True)
        return NOTES_JSON % f"Point {calls['n']}"

    monkeypatch.setattr(summarizer, "generate", _gemini_is_down)
    monkeypatch.setattr(summarizer.settings, "GROQ_API_KEY", "k")
    monkeypatch.setattr(summarizer.settings, "GROQ_WINDOW_CHARS", 8_000)
    monkeypatch.setattr(groq, "generate", flaky)

    result = await summarizer.summarize(_long_transcript(), "fr")

    assert result["sections"]["overview"]          # kept what succeeded
    assert result["degraded"] is True              # but says it is incomplete
    assert result["degraded_reason"] == "partial"
    assert "Point 1" in result["sections"]["overview"]


async def test_a_window_refused_as_too_large_is_halved_not_dropped(monkeypatch):
    # 413 is about this window's size, so retrying it unchanged is pointless -
    # but the passage is not lost either.
    seen: list[int] = []

    async def picky(prompt, **_k):
        # The prompt carries scaffolding too; the window is what varies.
        seen.append(len(prompt))
        if len(prompt) > 9_000:
            raise groq.GroqError("too large", status_code=413)
        return NOTES_JSON % "Rescued"

    monkeypatch.setattr(summarizer, "generate", _gemini_is_down)
    monkeypatch.setattr(summarizer.settings, "GROQ_API_KEY", "k")
    monkeypatch.setattr(summarizer.settings, "GROQ_WINDOW_CHARS", 40_000)
    monkeypatch.setattr(groq, "generate", picky)

    result = await summarizer.summarize(_long_transcript(), "fr")

    assert result["sections"]["overview"] == ["Rescued"]
    assert result["degraded"] is False             # nothing was actually lost
    assert max(seen) > 9_000 and min(seen) <= 9_000  # it really did shrink


async def test_halving_stops_at_the_floor_instead_of_spinning(monkeypatch):
    async def always_too_large(prompt, **_k):
        raise groq.GroqError("too large", status_code=413)

    monkeypatch.setattr(summarizer, "generate", _gemini_is_down)
    monkeypatch.setattr(summarizer.settings, "GROQ_API_KEY", "k")
    monkeypatch.setattr(summarizer.settings, "GROQ_WINDOW_CHARS", 20_000)
    monkeypatch.setattr(summarizer.settings, "MIN_WINDOW_CHARS", 2_500)
    monkeypatch.setattr(groq, "generate", always_too_large)

    result = await summarizer.summarize(_long_transcript(), "fr")

    # Gives up and hands back the local extraction rather than looping forever.
    assert result["degraded"] is True
    assert result["degraded_reason"] in {"quota", "unavailable"}


async def test_groq_is_skipped_entirely_when_no_key_is_set(monkeypatch):
    called = {"groq": False}

    async def should_not_run(*_a, **_k):
        called["groq"] = True
        return NOTES_JSON % "nope"

    monkeypatch.setattr(summarizer, "generate", _gemini_is_down)
    monkeypatch.setattr(summarizer.settings, "GROQ_API_KEY", "")
    monkeypatch.setattr(groq, "generate", should_not_run)

    result = await summarizer.summarize("Court transcript. Deux phrases.", "fr")

    assert called["groq"] is False
    assert result["degraded"] is True
    assert result["degraded_reason"] == "quota"


async def test_merge_puts_sections_back_in_the_plan_order():
    # Window one mentioned the exam in passing; that must not outrank the overview.
    merged = summarizer.merge_results([
        {"title": "T", "type": "LECTURE", "language": "fr",
         "sections": {"exam_notes": ["A"], "homework": ["B"]}, "labels": {}},
        {"title": "T", "type": "LECTURE", "language": "fr",
         "sections": {"overview": ["C"], "key_concepts": ["D"]}, "labels": {}},
    ])
    plan = summarizer.SECTION_PLANS["LECTURE"]
    order = [plan.index(k) for k in merged["sections"]]
    assert order == sorted(order)
    assert list(merged["sections"])[0] == "overview"


def test_bullet_cleanup_keeps_bold_but_drops_list_markers():
    # The bug this pins down: a [-*] marker pattern eats one star off "**Terme**"
    # and leaves a stray asterisk to render literally in the notes.
    cleaned = summarizer._clean_bullets([
        "**Chaine de pensee** : une strategie de prompt",
        "- un vrai tiret",
        "* une vraie puce",
        "1. un vrai numero",
        "**Gras** en tete et *italique* au milieu",
    ])
    assert cleaned == [
        "**Chaine de pensee** : une strategie de prompt",
        "un vrai tiret",
        "une vraie puce",
        "un vrai numero",
        "**Gras** en tete et *italique* au milieu",
    ]
