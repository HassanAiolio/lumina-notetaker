"""Request and response schemas."""
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from config import settings


def clean_tag_list(value: list[str]) -> list[str]:
    """Lowercase, trim, de-duplicate and cap the tag list."""
    seen: list[str] = []
    for tag in value:
        tag = str(tag).strip().lower()[:40]
        if tag and tag not in seen:
            seen.append(tag)
    return seen[:20]


class GoogleAuthRequest(BaseModel):
    credential: str = Field(min_length=10, max_length=8192)


class UserOut(BaseModel):
    id: str
    email: str
    name: str = ""
    picture: str = ""


class AuthResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    user: UserOut


class SummarizeRequest(BaseModel):
    transcript: str
    language: str = "auto"

    @field_validator("transcript")
    @classmethod
    def transcript_not_empty(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Transcript cannot be empty")
        if len(value) > settings.MAX_TRANSCRIPT_CHARS:
            raise ValueError(
                f"Transcript is too long ({len(value)} characters); "
                f"the limit is {settings.MAX_TRANSCRIPT_CHARS}"
            )
        return value


class SummarizeResponse(BaseModel):
    title: str
    type: str = ""
    language: str = "auto"
    sections: dict[str, list[str]] = {}
    labels: dict[str, str] = {}
    # True when the AI was unreachable and the notes came from local extraction.
    degraded: bool = False
    degraded_reason: str | None = None


class TranscribeResponse(BaseModel):
    text: str
    language: str = "auto"
    duration: float | None = None
    chunks: int = 1


class NoteCreate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    title: str = "Untitled note"
    raw_transcript: str = ""
    sections: dict[str, list[str]] = {}
    labels: dict[str, str] = {}
    tags: list[str] = []
    type: str = ""
    language: str = "auto"
    source: str = "text"
    duration: float | None = None
    degraded: bool = False

    @field_validator("tags")
    @classmethod
    def clean_tags(cls, value: list[str]) -> list[str]:
        return clean_tag_list(value)

    @field_validator("title")
    @classmethod
    def clean_title(cls, value: str) -> str:
        return (value or "").strip()[:200] or "Untitled note"

    @field_validator("raw_transcript")
    @classmethod
    def limit_transcript(cls, value: str) -> str:
        return (value or "")[: settings.MAX_TRANSCRIPT_CHARS]


class NoteUpdate(BaseModel):
    """Every field optional: only what is sent gets written."""
    model_config = ConfigDict(extra="ignore")

    title: str | None = None
    tags: list[str] | None = None
    sections: dict[str, list[str]] | None = None
    labels: dict[str, str] | None = None

    @field_validator("tags")
    @classmethod
    def clean_tags(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        return clean_tag_list(value)


class NoteResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    title: str
    raw_transcript: str = ""
    sections: dict[str, Any] = {}
    labels: dict[str, str] = {}
    tags: list[str] = []
    type: str = ""
    language: str = "auto"
    source: str = "text"
    duration: float | None = None
    degraded: bool = False
    created_at: str
    updated_at: str | None = None

    # Kept so notes saved before the dynamic-sections rewrite still render.
    summary: list[str] = []
    key_decisions: list[str] = []
    action_items: list[str] = []


class NotesPage(BaseModel):
    items: list[NoteResponse]
    total: int
    limit: int
    offset: int
