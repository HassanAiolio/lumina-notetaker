"""A resilient Gemini client: retries, model fallback, tolerant JSON parsing."""
import asyncio
import base64
import json
import logging
import random
import re

import httpx

from config import settings

logger = logging.getLogger(__name__)

API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models"

# Status codes worth trying again: rate limits and transient server faults.
RETRYABLE_STATUS = {408, 409, 429, 500, 502, 503, 504}


class GeminiError(RuntimeError):
    """Every Gemini model/attempt failed."""

    def __init__(self, message: str, *, status_code: int | None = None, quota: bool = False):
        super().__init__(message)
        self.status_code = status_code
        self.quota = quota


_client: httpx.AsyncClient | None = None


def get_http_client() -> httpx.AsyncClient:
    """One pooled client for the process — reconnecting per call is slow."""
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(settings.GEMINI_TIMEOUT, connect=15.0),
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
        )
    return _client


async def close_http_client() -> None:
    global _client
    if _client is not None and not _client.is_closed:
        await _client.aclose()
    _client = None


def _extract_text(data: dict) -> str:
    candidates = data.get("candidates") or []
    if not candidates:
        reason = (data.get("promptFeedback") or {}).get("blockReason")
        raise GeminiError(f"Gemini returned no candidates (blockReason={reason})")

    candidate = candidates[0]
    finish = candidate.get("finishReason")
    parts = (candidate.get("content") or {}).get("parts") or []
    text = "".join(part.get("text", "") for part in parts).strip()

    if not text:
        raise GeminiError(f"Gemini returned an empty response (finishReason={finish})")
    if finish == "MAX_TOKENS":
        logger.warning("Gemini hit the output token ceiling; response may be truncated")
    return text


# Spliced out of the serialized request and replaced by the encoded audio, so
# the body is never held whole. Chosen to be something no prompt would contain.
_AUDIO_SENTINEL = "\x00__lumina_inline_audio__\x00"


# Encoded a block at a time. A multiple of 3 so each block is a whole number of
# base64 groups and the pieces concatenate into exactly what one call would give.
_B64_BLOCK = 3 * 64 * 1024


async def _audio_body(head: bytes, audio: bytes, tail: bytes):
    """Stream the request, encoding the recording as it goes.

    A fresh generator per attempt, because a retry has to send the body again.
    """
    yield head
    for start in range(0, len(audio), _B64_BLOCK):
        yield base64.b64encode(audio[start:start + _B64_BLOCK])
    yield tail


def _streaming_body(payload: dict, audio: bytes) -> tuple[bytes, bytes, int]:
    """Serialize `payload` around `audio`, without ever holding the whole body.

    Sending this as `json=payload` costs several copies of a large recording:
    the base64 string, the dict holding it, json.dumps' output, and that
    string's encoding. For a 7 MB upload it came to ~34 MB of peak heap per
    request, which is what puts a 512 MB instance over the line part-way
    through a long lecture.

    Serializing around a sentinel keeps json.dumps working on a small object,
    and the audio is encoded block by block straight into the socket. Base64 is
    pure ASCII, so it needs no escaping and splices into a JSON string as-is.
    """
    template = json.dumps(payload)
    marker = json.dumps(_AUDIO_SENTINEL)  # quoted exactly as it appears in the body
    head, separator, tail = template.partition(marker)
    if not separator:
        raise GeminiError("Could not place the audio in the request body")

    head_bytes = head.encode() + b'"'
    tail_bytes = b'"' + tail.encode()
    # 4 characters per 3 bytes, rounded up; no padding ambiguity to account for.
    encoded_length = 4 * ((len(audio) + 2) // 3)
    return head_bytes, tail_bytes, len(head_bytes) + encoded_length + len(tail_bytes)


async def generate(
    parts: list[dict],
    *,
    models: list[str] | None = None,
    json_output: bool = True,
    system_instruction: str | None = None,
    temperature: float = 0.3,
    max_output_tokens: int = 8192,
    inline_audio: tuple[str, bytes] | None = None,
) -> str:
    """Call Gemini with `parts`, walking the model list until one answers.

    Each model gets `GEMINI_MAX_ATTEMPTS` tries with jittered exponential
    backoff before we move on to the next one.
    """
    if not settings.GEMINI_API_KEY:
        raise GeminiError("GEMINI_API_KEY is not configured")

    model_list = models or settings.GEMINI_TEXT_MODELS
    generation_config: dict = {
        "temperature": temperature,
        "maxOutputTokens": max_output_tokens,
    }
    if json_output:
        generation_config["responseMimeType"] = "application/json"

    payload: dict = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": generation_config,
        # The defaults block a lot of ordinary meeting talk; notes are not a
        # generative-content surface, so we only keep the highest thresholds.
        "safetySettings": [
            {"category": c, "threshold": "BLOCK_ONLY_HIGH"}
            for c in (
                "HARM_CATEGORY_HARASSMENT",
                "HARM_CATEGORY_HATE_SPEECH",
                "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                "HARM_CATEGORY_DANGEROUS_CONTENT",
            )
        ],
    }
    if inline_audio is not None:
        mime_type, audio_bytes = inline_audio
        parts.append({"inline_data": {"mime_type": mime_type, "data": _AUDIO_SENTINEL}})
    if system_instruction:
        payload["systemInstruction"] = {"parts": [{"text": system_instruction}]}

    # Built once, outside the retry loop: re-encoding a recording on every
    # attempt would multiply the cost of a rate-limited model.
    body_head = body_tail = b""
    body_length = 0
    streaming = inline_audio is not None
    if streaming:
        body_head, body_tail, body_length = _streaming_body(payload, audio_bytes)
        del inline_audio

    client = get_http_client()
    last_error: GeminiError | None = None

    for model in model_list:
        url = f"{API_ROOT}/{model}:generateContent"
        for attempt in range(1, settings.GEMINI_MAX_ATTEMPTS + 1):
            try:
                headers = {
                    "x-goog-api-key": settings.GEMINI_API_KEY,
                    "Content-Type": "application/json",
                }
                if not streaming:
                    response = await client.post(url, json=payload, headers=headers)
                else:
                    headers["Content-Length"] = str(body_length)
                    response = await client.post(
                        url,
                        content=_audio_body(body_head, audio_bytes, body_tail),
                        headers=headers,
                    )
            except httpx.TimeoutException as exc:
                last_error = GeminiError(f"{model} timed out after {settings.GEMINI_TIMEOUT}s")
                logger.warning("Gemini %s attempt %d timed out: %s", model, attempt, exc)
            except httpx.HTTPError as exc:
                last_error = GeminiError(f"Network error calling {model}: {exc}")
                logger.warning("Gemini %s attempt %d network error: %s", model, attempt, exc)
            else:
                if response.status_code == 200:
                    try:
                        return _extract_text(response.json())
                    except GeminiError as exc:
                        last_error = exc
                        logger.warning("Gemini %s attempt %d: %s", model, attempt, exc)
                else:
                    body = response.text[:500]
                    quota = response.status_code == 429 or "quota" in body.lower()
                    last_error = GeminiError(
                        f"{model} returned HTTP {response.status_code}",
                        status_code=response.status_code,
                        quota=quota,
                    )
                    logger.warning("Gemini %s HTTP %d: %s", model, response.status_code, body)
                    if response.status_code not in RETRYABLE_STATUS:
                        # Bad key, bad request, unknown model: retrying is
                        # pointless, but a different model may still work.
                        break

            if attempt < settings.GEMINI_MAX_ATTEMPTS:
                delay = min(2 ** (attempt - 1), 8) + random.uniform(0, 0.5)
                await asyncio.sleep(delay)

        logger.info("Falling back from Gemini model %s", model)

    raise last_error or GeminiError("All Gemini models failed")


# ── JSON parsing ──────────────────────────────────────────────────────────────

_FENCE_RE = re.compile(r"^```[a-zA-Z]*\s*|\s*```$", re.MULTILINE)
_TRAILING_COMMA_RE = re.compile(r",(\s*[}\]])")


def parse_json_object(text: str) -> dict:
    """Best-effort JSON object out of a model response.

    Handles code fences, leading prose and trailing commas. Returns {} when
    nothing usable can be recovered — callers decide what to do about it.
    """
    if not text:
        return {}

    candidate = _FENCE_RE.sub("", text.strip()).strip()

    for attempt in (candidate, _TRAILING_COMMA_RE.sub(r"\1", candidate)):
        try:
            parsed = json.loads(attempt)
            if isinstance(parsed, dict):
                return parsed
            if isinstance(parsed, list) and parsed and isinstance(parsed[0], dict):
                return parsed[0]
        except json.JSONDecodeError:
            pass

    # Last resort: slice out the outermost {...} and retry.
    start, end = candidate.find("{"), candidate.rfind("}")
    if start != -1 and end > start:
        sliced = _TRAILING_COMMA_RE.sub(r"\1", candidate[start : end + 1])
        try:
            parsed = json.loads(sliced)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass

    logger.error("Could not parse JSON from model output: %s", text[:800])
    return {}
