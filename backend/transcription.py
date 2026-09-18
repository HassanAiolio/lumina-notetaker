"""Speech-to-text through Gemini, with automatic language detection."""
import base64
import io
import logging
import re
import wave

import languages
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


def split_wav(data: bytes, chunk_seconds: int) -> list[bytes]:
    """Split a WAV into standalone WAV chunks. Returns [data] when it fits."""
    info = wav_info(data)
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


async def _transcribe_one(
    data: bytes, mime_type: str, language: str, context: str
) -> tuple[str, str]:
    parts = [
        {"text": _prompt(language, context)},
        {"inline_data": {"mime_type": mime_type, "data": base64.b64encode(data).decode("ascii")}},
    ]
    raw = await generate(
        parts,
        models=settings.GEMINI_AUDIO_MODELS,
        json_output=True,
        temperature=0.0,
        max_output_tokens=16384,
    )

    parsed = parse_json_object(raw)
    text = parsed.get("text")
    if not isinstance(text, str):
        # Some responses come back as bare text despite the JSON request.
        text = raw if not parsed else ""
    text = text.strip()

    if _NO_SPEECH.match(text):
        text = ""

    detected = languages.normalize(parsed.get("language"))
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
        split_wav(data, settings.AUDIO_CHUNK_SECONDS)
        if resolved_mime == "audio/wav"
        else [data]
    )

    pieces: list[str] = []
    detected_language = languages.AUTO
    running_context = context

    for index, chunk in enumerate(chunks):
        try:
            text, chunk_language = await _transcribe_one(
                chunk,
                resolved_mime,
                # Once we know the language, pin it so later chunks agree.
                detected_language if detected_language != languages.AUTO else language,
                running_context,
            )
        except GeminiError as exc:
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
