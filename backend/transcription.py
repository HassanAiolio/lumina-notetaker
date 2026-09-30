"""Speech-to-text through Gemini, with automatic language detection."""
import io
import json
import logging
import re
import wave

import groq
import languages
import loops
from config import settings
from gemini import GeminiError, generate, parse_json_object

logger = logging.getLogger(__name__)

# Gemini documents wav/mp3/aiff/aac/ogg/flac. The browser containers are mapped
# onto the closest documented type; the client normally converts to WAV first,
# so these are only the fallback path.
MIME_ALIASES = {
    "audio/wav": "audio/wav",
    "audio/x-wav": "audio/wav",
    "audio/wave": "audio/wav",
    "audio/vnd.wave": "audio/wav",
    "audio/mpeg": "audio/mp3",
    "audio/mp3": "audio/mp3",
    "audio/aac": "audio/aac",
    "audio/flac": "audio/flac",
    "audio/x-flac": "audio/flac",
    "audio/ogg": "audio/ogg",
    "audio/opus": "audio/ogg",
    "audio/aiff": "audio/aiff",
    "audio/x-aiff": "audio/aiff",
    "audio/webm": "audio/ogg",
    "audio/mp4": "audio/aac",
    "audio/x-m4a": "audio/aac",
    "video/webm": "audio/ogg",
    "video/mp4": "audio/aac",
}

# Things models say instead of admitting the clip is silent.
_NO_SPEECH = re.compile(
    r"^\s*[\[\(\"']?\s*(no\s+(?:speech|audio|sound|discernible\s+speech)"
    r"|silence|inaudible|unintelligible|empty\s+audio|aucun\s+(?:son|discours|audio)"
    r"|pas\s+de\s+(?:parole|son))\b.{0,40}$",
    re.IGNORECASE | re.DOTALL,
)


class AudioError(ValueError):
    """The uploaded audio cannot be processed."""


def normalize_mime(mime_type: str | None) -> str:
    """Map a browser mime type onto one Gemini accepts, or raise."""
    if not mime_type:
        raise AudioError("Missing audio content type")
    base = mime_type.split(";")[0].strip().lower()
    resolved = MIME_ALIASES.get(base)
    if not resolved:
        raise AudioError(f"Unsupported audio format: {base}")
    return resolved


def wav_info(data: bytes) -> tuple[float, int, int, int] | None:
    """(duration_s, channels, sample_width, frame_rate) for a WAV, else None."""
    try:
        with wave.open(io.BytesIO(data), "rb") as wav:
            frames = wav.getnframes()
            rate = wav.getframerate() or 1
            return frames / rate, wav.getnchannels(), wav.getsampwidth(), rate
    except (wave.Error, EOFError, OSError):
        return None


def split_wav(data: bytes, chunk_seconds: int, info: tuple | None = None) -> list[bytes]:
    """Split a WAV into standalone WAV chunks. Returns [data] when it fits.

    `info` is taken from the caller when it has already read the header:
    wave.open needs a file object, and io.BytesIO copies, so probing the same
    upload twice costs a second full copy of the recording for nothing.
    """
    info = info if info is not None else wav_info(data)
    if info is None:
        return [data]
    duration, channels, width, rate = info
    if duration <= chunk_seconds:
        return [data]

    with wave.open(io.BytesIO(data), "rb") as wav:
        frames_per_chunk = int(chunk_seconds * rate)
        chunks: list[bytes] = []
        while True:
            frames = wav.readframes(frames_per_chunk)
            if not frames:
                break
            buffer = io.BytesIO()
            with wave.open(buffer, "wb") as out:
                out.setnchannels(channels)
                out.setsampwidth(width)
                out.setframerate(rate)
                out.writeframes(frames)
            chunks.append(buffer.getvalue())
    logger.info("Split %.1fs of audio into %d chunks", duration, len(chunks))
    return chunks


def _prompt(language: str, context: str) -> str:
    if language == languages.AUTO:
        language_clause = (
            "Detect the spoken language yourself and transcribe in that language, "
            "using its own script. Do not translate."
        )
    else:
        language_clause = (
            f"The audio is expected to be in {languages.english_name(language)}. "
            "Transcribe in that language, using its own script. Do not translate. "
            "If the speaker is clearly using another language, transcribe what you "
            "actually hear and report that language instead."
        )

    context_clause = ""
    if context:
        context_clause = (
            "\n\nThis clip continues an earlier one. Use the tail of the previous "
            "transcript only to keep spelling and names consistent - do not repeat "
            f"any of it in your output:\n\"\"\"\n{context[-1200:]}\n\"\"\""
        )

    return f"""Transcribe this audio recording verbatim.

{language_clause}

Rules:
- Write what is said, with sentence punctuation and capitalisation.
- Keep names, numbers, dates and amounts exactly as spoken.
- Do not summarise, translate, comment or add speaker labels.
- Mark genuinely unclear words as [inaudible].
- If there is no intelligible speech at all, return an empty string for "text".
{context_clause}

Reply with JSON only:
{{"text": "the transcription", "language": "BCP-47 code, e.g. fr"}}"""


async def _transcribe_one_groq(
    data: bytes, mime_type: str, language: str, context: str
) -> tuple[str, str]:
    """Whisper on Groq, for when every Gemini model has failed.

    This is a dedicated transcription endpoint, not a prompted chat model, so
    the careful instructions in _prompt do not apply. What it does take is a
    short vocabulary hint, and the tail of the previous chunk is exactly that:
    it keeps names and spellings consistent across a chunk boundary the same
    way the Gemini path's context does.
    """
    extension = {"audio/wav": "wav", "audio/mp3": "mp3", "audio/ogg": "ogg",
                 "audio/flac": "flac", "audio/aac": "m4a", "audio/aiff": "aiff"}
    result = await groq.transcribe(
        data,
        filename=f"chunk.{extension.get(mime_type, 'wav')}",
        language=None if language == languages.AUTO else language,
        prompt=context[-400:],
    )

    # Whisper loops too, on a quiet stretch at temperature 0.
    text, removed = loops.collapse_repeats(result["text"].strip())
    if removed:
        logger.warning("Whisper looped (%d repeated words cut)", removed)
    if _NO_SPEECH.match(text):
        text = ""

    detected = languages.normalize(result["language"])
    if detected == languages.AUTO and text:
        detected = languages.detect(text)
    return text, detected


_REPLY_HEAD = re.compile(r'^\s*\[?\s*\{\s*"text"\s*:\s*"', re.DOTALL)
_REPLY_TAIL = re.compile(
    r'"\s*(?:,\s*"language"\s*:\s*"[^"]*"\s*)?\}\s*\]?\s*$', re.DOTALL
)
_REPLY_LANGUAGE = re.compile(r'"language"\s*:\s*"([^"]+)"')


def _salvage_text(raw: str) -> str:
    """The transcript out of a reply that is JSON-shaped but will not parse.

    A reply that loops until the token ceiling stops mid-string, and one with
    an unescaped quote in the speech is invalid too. Either used to go into
    the transcript whole, wrapper and all: '{"text": "c'est aussi ...'.
    Replies that were never JSON - bare text - come back as they are.
    """
    head = _REPLY_HEAD.match(raw)
    if not head:
        return raw
    body = _REPLY_TAIL.sub("", raw[head.end():])
    return body.replace('\\"', '"').replace("\\n", " ").replace("\\\\", "\\")


def _read_reply(raw: str) -> tuple[str, str | None]:
    """(text, language) from a transcription reply, in any shape it comes in."""
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        parsed = None
    if isinstance(parsed, str):
        return parsed, None
    if not isinstance(parsed, (dict, list)):
        parsed = parse_json_object(raw)

    if isinstance(parsed, list):
        # JSON mode sometimes answers with a list of segments. Taking only the
        # first, as parse_json_object does, would drop the rest of the chunk.
        items = [item for item in parsed if isinstance(item, dict)]
        text = " ".join(
            item["text"].strip() for item in items if isinstance(item.get("text"), str)
        )
        language = next((item["language"] for item in items if item.get("language")), None)
        return text, language

    if parsed:
        text = parsed.get("text")
        return (text if isinstance(text, str) else ""), parsed.get("language")

    found = _REPLY_LANGUAGE.search(raw)
    return _salvage_text(raw), found.group(1) if found else None


def _is_looping(text: str, removed: int) -> bool:
    """Did a reply spend a real part of itself repeating one phrase?"""
    return removed >= 30 or (removed >= 10 and removed * 5 >= len(text.split()) + removed)


async def _transcribe_one(
    data: bytes, mime_type: str, language: str, context: str
) -> tuple[str, str]:
    # Two ways a reply loses words: it loops, or it runs out of output tokens
    # and stops mid-transcript. Neither is reproducible - asked again, the
    # model usually transcribes the same audio cleanly - so either gets one
    # more try, and the better reply is kept: complete over cut off, then less
    # repetitive. Loops are collapsed whichever wins, so one never reaches the
    # summarizer.
    best: tuple[bool, int, str, str | None] | None = None
    for attempt in range(2):
        raw, finish = await generate(
            [{"text": _prompt(language, context)}],
            models=settings.GEMINI_AUDIO_MODELS,
            json_output=True,
            # The model's default. Gemini 3 is documented to loop below 1.0,
            # and 0.0 is where the "des des des ..." transcripts came from.
            temperature=None,
            # Four minutes of speech is a couple of thousand tokens. The old
            # 16384 only ever mattered to a loop, which it let run for minutes.
            max_output_tokens=8192,
            # Handed over raw: the client base64s it straight into the request
            # stream, so a recording is never held encoded and serialized at once.
            inline_audio=(mime_type, data),
            # Thinking counts against the output ceiling; on 2.5 Flash it
            # varied from 1,400 to 5,300 tokens on the same chunk, enough to
            # cut a transcript short. Verbatim transcription needs none.
            minimal_thinking=True,
            with_finish=True,
        )
        text, reply_language = _read_reply(raw)
        text, removed = loops.collapse_repeats(text.strip())
        truncated = finish == "MAX_TOKENS"
        # Tuples compare in order: complete before cut off, then fewer repeats.
        if best is None or (truncated, removed) < best[:2]:
            best = (truncated, removed, text, reply_language)
        looping = _is_looping(text, removed)
        if not looping and not truncated:
            break
        logger.warning(
            "Transcription %s (%d repeated words cut, attempt %d)",
            "was cut off at the token limit" if truncated else "looped",
            removed,
            attempt + 1,
        )

    _, _, text, reply_language = best
    if _NO_SPEECH.match(text):
        text = ""

    detected = languages.normalize(reply_language)
    if detected == languages.AUTO and text:
        detected = languages.detect(text)
    return text, detected


async def transcribe(
    data: bytes,
    mime_type: str,
    language: str = languages.AUTO,
    context: str = "",
) -> dict:
    """Transcribe an audio upload.

    Long WAV uploads are split so a single request never exceeds what the model
    accepts. Each chunk after the first is given the tail of the previous
    transcript so names stay spelled consistently.
    """
    if not data:
        raise AudioError("Empty audio upload")
    if len(data) > settings.MAX_AUDIO_BYTES:
        raise AudioError(
            f"Audio is too large ({len(data) // 1_048_576} MB). "
            f"The limit is {settings.MAX_AUDIO_BYTES // 1_048_576} MB per request."
        )

    resolved_mime = normalize_mime(mime_type)
    language = languages.normalize(language)

    info = wav_info(data) if resolved_mime == "audio/wav" else None
    duration = info[0] if info else None

    chunks = (
        split_wav(data, settings.AUDIO_CHUNK_SECONDS, info)
        if resolved_mime == "audio/wav"
        else [data]
    )

    pieces: list[str] = []
    detected_language = languages.AUTO
    running_context = context
    # Sticky: once Gemini has exhausted every model, stop asking it again.
    use_groq = False

    for index, chunk in enumerate(chunks):
        # Once we know the language, pin it so later chunks agree.
        chunk_lang = detected_language if detected_language != languages.AUTO else language
        try:
            if not use_groq:
                try:
                    text, chunk_language = await _transcribe_one(
                        chunk, resolved_mime, chunk_lang, running_context,
                    )
                except GeminiError as gemini_error:
                    if not settings.groq_configured:
                        raise
                    # Getting here means every Gemini model and attempt just
                    # failed. That does not come back mid-recording, and an
                    # hour of audio is fifteen more chunks that would each pay
                    # the whole timeout and retry cost again before giving up.
                    logger.warning(
                        "Gemini unavailable at chunk %d (%s); using Groq Whisper "
                        "for the rest of this recording", index + 1, gemini_error,
                    )
                    use_groq = True

            if use_groq:
                text, chunk_language = await _transcribe_one_groq(
                    chunk, resolved_mime, chunk_lang, running_context,
                )
        except (GeminiError, groq.GroqError) as exc:
            if not pieces:
                raise
            # Partial audio is better than none: keep what we have and say so.
            logger.error("Chunk %d/%d failed, returning partial transcript: %s",
                         index + 1, len(chunks), exc)
            pieces.append("[...]")
            break

        if text:
            pieces.append(text)
            running_context = text
        if detected_language == languages.AUTO and chunk_language != languages.AUTO:
            detected_language = chunk_language

    transcript = " ".join(p for p in pieces if p).strip()
    if detected_language == languages.AUTO:
        detected_language = languages.detect(transcript)

    return {
        "text": transcript,
        "language": detected_language,
        "duration": duration,
        "chunks": len(chunks),
    }
