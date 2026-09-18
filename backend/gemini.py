"""A resilient Gemini client: retries, model fallback, tolerant JSON parsing."""
import asyncio
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


async def generate(
    parts: list[dict],
    *,
    models: list[str] | None = None,
    json_output: bool = True,
    system_instruction: str | None = None,
    temperature: float = 0.3,
    max_output_tokens: int = 8192,
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
    if system_instruction:
        payload["systemInstruction"] = {"parts": [{"text": system_instruction}]}

    client = get_http_client()
    last_error: GeminiError | None = None

    for model in model_list:
        url = f"{API_ROOT}/{model}:generateContent"
        for attempt in range(1, settings.GEMINI_MAX_ATTEMPTS + 1):
            try:
                response = await client.post(
                    url,
                    json=payload,
                    headers={
                        "x-goog-api-key": settings.GEMINI_API_KEY,
                        "Content-Type": "application/json",
                    },
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
