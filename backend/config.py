"""Central configuration, loaded once from the environment."""
import os
import secrets
from pathlib import Path

from dotenv import load_dotenv

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")


def _csv(name: str, default: str = "") -> list[str]:
    raw = os.environ.get(name, default)
    return [item.strip() for item in raw.split(",") if item.strip()]


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


class Settings:
    # ── Database ──────────────────────────────────────────────────────────
    MONGO_URL: str = os.environ.get("MONGO_URL", "")
    DB_NAME: str = os.environ.get("DB_NAME", "lumina")

    # ── Google Gemini ─────────────────────────────────────────────────────
    GEMINI_API_KEY: str = os.environ.get("GEMINI_API_KEY", "")
    # Tried in order; the first one that answers wins. A quota error or an
    # outage on the primary model silently rolls over to the next.
    #
    # Every entry has to be a model the API still serves, and they have to be
    # genuinely different models: quota is counted per model, so a second entry
    # is only a fallback if it has its own budget. Google retires models without
    # much warning and a retired one answers 404, which turns the fallback into
    # a second failure rather than a rescue - the chain below replaced
    # gemini-2.0-flash and gemini-2.5-flash-lite after both started 404ing.
    # Check with: GET /v1beta/models?key=...
    GEMINI_TEXT_MODELS: list[str] = _csv(
        "GEMINI_TEXT_MODELS", "gemini-3.5-flash,gemini-2.5-flash,gemini-3.1-flash-lite"
    )
    GEMINI_AUDIO_MODELS: list[str] = _csv(
        "GEMINI_AUDIO_MODELS", "gemini-3.5-flash,gemini-2.5-flash,gemini-3.1-flash-lite"
    )
    GEMINI_TIMEOUT: int = _int("GEMINI_TIMEOUT", 120)
    GEMINI_MAX_ATTEMPTS: int = _int("GEMINI_MAX_ATTEMPTS", 3)

    # ── Auth ──────────────────────────────────────────────────────────────
    GOOGLE_CLIENT_ID: str = os.environ.get("GOOGLE_CLIENT_ID", "")
    # A generated fallback keeps local dev running; in production an unset
    # secret would invalidate every session on each restart, so we warn.
    JWT_SECRET: str = os.environ.get("JWT_SECRET") or secrets.token_urlsafe(48)
    JWT_SECRET_IS_EPHEMERAL: bool = not os.environ.get("JWT_SECRET")
    JWT_ALGORITHM: str = "HS256"
    JWT_TTL_DAYS: int = _int("JWT_TTL_DAYS", 30)
    # Optional allow-list. Empty means any Google account may sign in.
    ALLOWED_EMAILS: list[str] = [e.lower() for e in _csv("ALLOWED_EMAILS")]
    ALLOWED_EMAIL_DOMAINS: list[str] = [d.lower().lstrip("@") for d in _csv("ALLOWED_EMAIL_DOMAINS")]

    # ── HTTP ──────────────────────────────────────────────────────────────
    CORS_ORIGINS: list[str] = _csv("CORS_ORIGINS", "http://localhost:3000")

    # ── Limits ────────────────────────────────────────────────────────────
    # Three hours of speech is roughly 170k characters, and more in a language
    # that writes longer than English, so 200k used to sit right on top of what
    # the client can now record. 400k is ~100k tokens to summarize: a fraction
    # of the model's context window.
    MAX_TRANSCRIPT_CHARS: int = _int("MAX_TRANSCRIPT_CHARS", 400_000)
    MAX_AUDIO_BYTES: int = _int("MAX_AUDIO_BYTES", 26_214_400)  # 25 MiB
    # Audio longer than this in a single request is split before transcription.
    AUDIO_CHUNK_SECONDS: int = _int("AUDIO_CHUNK_SECONDS", 240)
    MAX_NOTES_PAGE: int = _int("MAX_NOTES_PAGE", 100)

    # Per-user sliding-window rate limits: (requests, window_seconds)
    RATE_LIMIT_AI: tuple[int, int] = (_int("RATE_LIMIT_AI_REQUESTS", 30), _int("RATE_LIMIT_AI_WINDOW", 60))
    RATE_LIMIT_WRITE: tuple[int, int] = (_int("RATE_LIMIT_WRITE_REQUESTS", 120), _int("RATE_LIMIT_WRITE_WINDOW", 60))

    APP_VERSION: str = os.environ.get("APP_VERSION", "2.0.0")

    # Notes saved before accounts existed have no owner. Set this to an email
    # address once and those notes are adopted by that account on next boot.
    LEGACY_OWNER_EMAIL: str = os.environ.get("LEGACY_OWNER_EMAIL", "").strip().lower()

    @property
    def auth_configured(self) -> bool:
        return bool(self.GOOGLE_CLIENT_ID)

    @property
    def ai_configured(self) -> bool:
        return bool(self.GEMINI_API_KEY)


settings = Settings()
