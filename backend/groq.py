"""Groq as a second provider, for when Gemini is out of quota or down.

Two independent jobs, both the same shape as the Gemini client: walk a list of
models, retry the transient failures, give up with an error the caller can tell
apart from a real one.

  generate()   chat completions, for structured notes
  transcribe() Whisper, for speech to text

Worth knowing: Groq sits behind Cloudflare, which answers a bare urllib request
with "error code: 1010" and no explanation. httpx gets through, so this module
uses the same pooled client style as the rest of the app rather than the
standard library.
"""
import asyncio
import json
import logging
import random
import re

import httpx

from config import settings

logger = logging.getLogger(__name__)

API_ROOT = "https://api.groq.com/openai/v1"
RETRYABLE_STATUS = {408, 409, 429, 500, 502, 503, 504}


class GroqError(RuntimeError):
    """Every Groq model/attempt failed. Mirrors GeminiError so callers can
    treat a provider being unavailable the same way whichever one it was."""

    def __init__(self, message: str, *, status_code: int | None = None, quota: bool = False):
        super().__init__(message)
        self.status_code = status_code
        self.quota = quota


_client: httpx.AsyncClient | None = None


def get_http_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(settings.GROQ_TIMEOUT, connect=15.0),
            limits=httpx.Limits(max_connections=10, max_keepalive_connections=5),
        )
    return _client


async def close_http_client() -> None:
    global _client
    if _client is not None and not _client.is_closed:
        await _client.aclose()
    _client = None


def _auth() -> dict:
    return {"Authorization": f"Bearer {settings.GROQ_API_KEY}"}


# "Please retry in 27.584225593s" - Groq puts the wait in the message as well as
# the header, and the header is not always there on a token-per-minute refusal.
_RETRY_IN = re.compile(r"retry in ([0-9.]+)\s*s", re.IGNORECASE)


def _retry_delay(response: httpx.Response | None, attempt: int) -> float:
    """How long to wait before trying again.

    A rate limit is not guesswork: the service says when it will accept the
    next request, and waiting that long turns a failed window into a slow one.
    Exponential backoff is only the fallback for when it does not say.
    """
    if response is not None:
        advertised = response.headers.get("retry-after")
        if not advertised:
            found = _RETRY_IN.search(response.text[:500])
            advertised = found.group(1) if found else None
        if advertised:
            try:
                return min(float(advertised) + 0.5, settings.GROQ_MAX_RETRY_WAIT)
            except ValueError:
                pass
    return min(2 ** (attempt - 1), 8) + random.uniform(0, 0.5)


async def _attempt(models: list[str], send, what: str):
    """Try `send(model)` across models, retrying the transient failures.

    `send` returns the parsed result, or raises GroqError to move on.
    """
    if not settings.GROQ_API_KEY:
        raise GroqError("GROQ_API_KEY is not configured")

    client = get_http_client()
    last_error: GroqError | None = None

    for model in models:
        for attempt in range(1, settings.GROQ_MAX_ATTEMPTS + 1):
            response = None
            try:
                response = await send(client, model)
            except httpx.TimeoutException:
                last_error = GroqError(f"{model} timed out after {settings.GROQ_TIMEOUT}s")
            except httpx.HTTPError as exc:
                last_error = GroqError(f"Network error calling {model}: {exc}")
            else:
                if response.status_code == 200:
                    return response
                body = response.text[:500]
                quota = response.status_code == 429 or "rate_limit" in body.lower()
                last_error = GroqError(
                    f"{model} returned HTTP {response.status_code}",
                    status_code=response.status_code,
                    quota=quota,
                )
                logger.warning("Groq %s %s HTTP %d: %s", what, model, response.status_code, body)
                if response.status_code not in RETRYABLE_STATUS:
                    break  # bad request or unknown model; a different model may still work

            if attempt < settings.GROQ_MAX_ATTEMPTS:
                delay = _retry_delay(response, attempt)
                logger.info("Groq %s retrying in %.1fs", model, delay)
                await asyncio.sleep(delay)

        logger.info("Falling back from Groq model %s", model)

    raise last_error or GroqError(f"All Groq models failed for {what}")


async def generate(
    prompt: str,
    *,
    models: list[str] | None = None,
    system_instruction: str | None = None,
    temperature: float = 0.3,
    max_output_tokens: int = 8192,
    json_output: bool = True,
) -> str:
    """Structured text from a Groq chat model."""
    messages = []
    if system_instruction:
        messages.append({"role": "system", "content": system_instruction})
    messages.append({"role": "user", "content": prompt})

    payload: dict = {
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_output_tokens,
    }
    if json_output:
        # The OpenAI-compatible JSON mode refuses a prompt that never says
        # "json"; ours does, in the "Return exactly this JSON shape" line.
        payload["response_format"] = {"type": "json_object"}

    async def send(client, model):
        return await client.post(
            f"{API_ROOT}/chat/completions",
            json={**payload, "model": model},
            headers={**_auth(), "Content-Type": "application/json"},
        )

    response = await _attempt(models or settings.GROQ_TEXT_MODELS, send, "generate")
    data = response.json()
    choices = data.get("choices") or []
    if not choices:
        raise GroqError("Groq returned no choices")

    message = choices[0].get("message") or {}
    text = (message.get("content") or "").strip()
    if not text:
        raise GroqError(f"Groq returned an empty response (finish={choices[0].get('finish_reason')})")
    if choices[0].get("finish_reason") == "length":
        logger.warning("Groq hit the output token ceiling; response may be truncated")
    return text


async def transcribe(
    data: bytes,
    *,
    filename: str = "audio.wav",
    language: str | None = None,
    prompt: str = "",
    models: list[str] | None = None,
) -> dict:
    """Speech to text through Groq's Whisper, as {"text", "language"}.

    Unlike the Gemini path this is a dedicated transcription endpoint rather
    than a prompted chat model, so it takes the audio as a file upload and
    reports the language itself. verbose_json is what carries that language
    back; the default response format would only give the text.
    """
    async def send(client, model):
        form = {
            "model": (None, model),
            "response_format": (None, "verbose_json"),
            "temperature": (None, "0"),
        }
        if language:
            form["language"] = (None, language)
        if prompt:
            # Whisper takes a short vocabulary hint, not an instruction.
            form["prompt"] = (None, prompt[:800])
        return await client.post(
            f"{API_ROOT}/audio/transcriptions",
            files={**form, "file": (filename, data, "application/octet-stream")},
            headers=_auth(),
        )

    response = await _attempt(models or settings.GROQ_AUDIO_MODELS, send, "transcribe")
    try:
        parsed = response.json()
    except json.JSONDecodeError as exc:
        raise GroqError("Groq returned a transcription that was not JSON") from exc

    return {
        "text": (parsed.get("text") or "").strip(),
        "language": (parsed.get("language") or "").strip().lower(),
    }
