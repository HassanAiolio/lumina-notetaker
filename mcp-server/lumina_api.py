"""The Lumina Note API, read with a personal token, and notes as text for Claude.

Kept apart from the MCP wiring so it can be tested without the MCP SDK.
"""
import os
import re

import httpx

# The API sleeps on a free host when idle and takes up to a minute to wake.
TIMEOUT_SECONDS = 90

NOTE_TYPES = ("LECTURE", "MEETING", "INTERVIEW", "BRAINSTORM", "OTHER")


class LuminaError(Exception):
    """A failure worth showing as is: it says what happened and what to do."""


def api_root(url: str) -> str:
    """The API's address, whether or not it was given with /api on the end."""
    url = (url or "").strip().rstrip("/")
    if not url:
        raise LuminaError(
            "LUMINA_API_URL is not set. Point it at the Lumina backend, "
            "for example https://your-backend.onrender.com"
        )
    return url if url.endswith("/api") else f"{url}/api"


class LuminaClient:
    def __init__(self, base_url: str, token: str, transport: httpx.AsyncBaseTransport | None = None):
        token = (token or "").strip()
        if not token:
            raise LuminaError(
                "LUMINA_TOKEN is not set. Create one in Lumina Note: account menu > API tokens."
            )
        if not token.startswith("lum_"):
            raise LuminaError("LUMINA_TOKEN does not look like a Lumina API token (they start with lum_).")
        self._root = api_root(base_url)
        self._http = httpx.AsyncClient(
            base_url=self._root,
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            timeout=TIMEOUT_SECONDS,
            transport=transport,
        )

    @classmethod
    def from_env(cls) -> "LuminaClient":
        return cls(os.environ.get("LUMINA_API_URL", ""), os.environ.get("LUMINA_TOKEN", ""))

    async def close(self) -> None:
        await self._http.aclose()

    async def _get(self, path: str, params: dict | None = None):
        try:
            response = await self._http.get(path, params={k: v for k, v in (params or {}).items() if v not in ("", None)})
        except httpx.TimeoutException as exc:
            raise LuminaError(
                "Lumina did not answer in time. If it has been idle it is probably waking up: "
                "try again in a minute."
            ) from exc
        except httpx.HTTPError as exc:
            raise LuminaError(f"Could not reach Lumina at {self._root}: {exc}") from exc

        if response.status_code == 401:
            raise LuminaError("Lumina refused the token. It may have been revoked: create a new one in the app.")
        if response.status_code == 404:
            raise LuminaError("No such note. Use search_notes to find its id.")
        if response.status_code == 429:
            raise LuminaError("Too many requests to Lumina in a short time. Wait a minute and try again.")
        if response.status_code >= 400:
            try:
                detail = response.json().get("detail")
            except ValueError:
                detail = None
            raise LuminaError(f"Lumina answered {response.status_code}: {detail or response.reason_phrase}")
        return response.json()

    async def search_notes(self, query: str = "", tag: str = "", note_type: str = "", limit: int = 20) -> dict:
        return await self._get(
            "/notes",
            {
                "search": query.strip(),
                "tag": tag.strip().lstrip("#").lower(),
                "type": note_type.strip().upper(),
                "limit": max(1, min(int(limit), 50)),
                # The list leaves the transcripts out; get_note has them.
                "brief": "true",
            },
        )

    async def get_note(self, note_id: str) -> dict:
        return await self._get(f"/notes/{note_id.strip()}")

    async def list_tags(self) -> list[str]:
        return await self._get("/tags")


# ── Notes as text ─────────────────────────────────────────────────────────────

LEGACY_SECTIONS = ("summary", "key_decisions", "action_items")


def section_entries(note: dict) -> list[tuple[str, list]]:
    """Sections in order, including notes saved before sections were dynamic."""
    sections = note.get("sections") or {key: note.get(key) for key in LEGACY_SECTIONS}
    return [(key, items) for key, items in sections.items() if isinstance(items, list) and items]


def section_label(key: str, labels: dict | None) -> str:
    label = (labels or {}).get(key)
    if isinstance(label, str) and label.strip():
        return label.strip()
    return re.sub(r"\b\w", lambda m: m.group(0).upper(), key.replace("_", " "))


def _day(iso: str | None) -> str:
    return (iso or "")[:10]


def _tags(note: dict) -> str:
    return " ".join(f"#{tag}" for tag in note.get("tags") or [])


def preview(note: dict) -> str:
    sections = note.get("sections") or {}
    for key in ("overview", "summary", "key_takeaways"):
        if isinstance(sections.get(key), list) and sections[key]:
            return str(sections[key][0])
    entries = section_entries(note)
    return str(entries[0][1][0]) if entries else ""


def search_results(page: dict) -> str:
    items = page.get("items") or []
    if not items:
        return "No notes match."
    lines = [f"{page.get('total', len(items))} note(s) match; showing {len(items)}, newest first.", ""]
    for note in items:
        meta = " · ".join(
            part for part in (_day(note.get("created_at")), (note.get("type") or "").lower(), _tags(note)) if part
        )
        lines.append(f"- **{note.get('title') or 'Untitled'}** (id: {note['id']}) {meta}")
        if lead := preview(note):
            lines.append(f"  {lead[:240]}")
    return "\n".join(lines)


def note_markdown(note: dict, include_transcript: bool = False) -> str:
    meta = [
        f"id: {note.get('id')}",
        f"date: {_day(note.get('created_at'))}" if note.get("created_at") else "",
        f"type: {note['type'].lower()}" if note.get("type") else "",
        f"language: {note['language']}" if note.get("language") not in (None, "", "auto") else "",
        f"tags: {_tags(note)}" if note.get("tags") else "",
        f"slides: {note['slides']['name']}" if (note.get("slides") or {}).get("name") else "",
    ]
    parts = [f"# {note.get('title') or 'Untitled note'}", "\n".join(line for line in meta if line)]
    for key, items in section_entries(note):
        bullets = "\n".join(f"- {item}" for item in items)
        parts.append(f"## {section_label(key, note.get('labels'))}\n{bullets}")

    transcript = (note.get("raw_transcript") or "").strip()
    if transcript and include_transcript:
        parts.append(f"## Transcript\n{transcript}")
    elif transcript:
        parts.append(
            f"(The transcript, {len(transcript):,} characters, is left out. "
            "Call get_note with include_transcript=true to read it.)"
        )
    return "\n\n".join(part for part in parts if part)


# The same cards the app's revision deck makes (frontend/src/lib/notes.js).
QUESTION = re.compile(r"^(.+?)\s+(?:→|->|=>)\s+(.+)$", re.S)
TERM_LEAD = re.compile(r"^\*\*(.+?)\*\*\s*[:—–-]\s*(.+)$", re.S)


def flashcards(note: dict) -> list[dict]:
    sections = note.get("sections") or {}
    cards = []
    for text in sections.get("review_questions") or []:
        if found := QUESTION.match(str(text)):
            cards.append({"kind": "question", "front": found[1].strip(), "back": found[2].strip()})
    for key in ("definitions", "key_concepts", "methods"):
        for text in sections.get(key) or []:
            if found := TERM_LEAD.match(str(text).strip()):
                cards.append({"kind": key, "front": found[1].strip(), "back": found[2].strip()})
    return cards


def flashcards_text(note: dict) -> str:
    cards = flashcards(note)
    if not cards:
        return f"\"{note.get('title')}\" has no review questions or defined terms to make cards from."
    lines = [f"{len(cards)} card(s) from \"{note.get('title')}\":", ""]
    for number, card in enumerate(cards, 1):
        lines.append(f"{number}. Q: {card['front']}\n   A: {card['back']}")
    return "\n".join(lines)
