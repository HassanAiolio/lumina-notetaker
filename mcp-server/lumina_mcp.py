# /// script
# requires-python = ">=3.10"
# dependencies = ["mcp>=2,<3", "httpx>=0.27"]
# ///
"""Lumina Note as an MCP server, so Claude can search and read your notes.

Read-only, over stdio. It needs two environment variables:
  LUMINA_API_URL  the backend, e.g. https://your-backend.onrender.com
  LUMINA_TOKEN    a personal token from the app (account menu > API tokens)

Run with:  uv run mcp-server/lumina_mcp.py
     or:   python mcp-server/lumina_mcp.py   (after pip install -r mcp-server/requirements.txt)
"""
import logging
import sys
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from mcp.server.mcpserver import MCPServer  # noqa: E402
from mcp.server.mcpserver.exceptions import ToolError  # noqa: E402
from mcp.types import ToolAnnotations  # noqa: E402

from lumina_api import (  # noqa: E402
    NOTE_TYPES,
    LuminaClient,
    LuminaError,
    flashcards_text,
    note_markdown,
    search_results,
)

mcp = MCPServer(
    "lumina-notes",
    instructions=(
        "The user's lecture and meeting notes from Lumina Note. Search first to find a "
        "note's id, then read it. Notes cite slide pages as [p. 12]. Bullets may hold "
        "LaTeX between $...$. Everything here is read-only."
    ),
)

# httpx logs every request at INFO, which buries the server's own messages.
logging.getLogger("httpx").setLevel(logging.WARNING)

_client: LuminaClient | None = None

# Every tool only reads, which lets clients run them without asking first.
READ_ONLY = ToolAnnotations(read_only_hint=True, open_world_hint=False)


def client() -> LuminaClient:
    # Made on first use, so a missing setting is reported by the tool call
    # that needed it rather than by a server that fails to start.
    global _client
    if _client is None:
        _client = LuminaClient.from_env()
    return _client


@contextmanager
def explained():
    """Let Claude see why a call failed. Any other exception is reported only as
    a failure, with its details kept in the server's log."""
    try:
        yield
    except LuminaError as exc:
        raise ToolError(str(exc)) from exc


@mcp.tool(annotations=READ_ONLY)
async def search_notes(query: str = "", tag: str = "", note_type: str = "", limit: int = 20) -> str:
    """Find notes, newest first. All filters are optional; with none, lists the latest notes.

    Args:
        query: words to look for in titles, transcripts and tags
        tag: only notes with this tag (see list_tags)
        note_type: only notes of this type: LECTURE, MEETING, INTERVIEW, BRAINSTORM or OTHER
        limit: how many to return, 1 to 50
    """
    if note_type and note_type.strip().upper() not in NOTE_TYPES:
        return f"Unknown note type {note_type!r}. Use one of: {', '.join(NOTE_TYPES)}."
    with explained():
        return search_results(await client().search_notes(query, tag, note_type, limit))


@mcp.tool(annotations=READ_ONLY)
async def get_note(note_id: str, include_transcript: bool = False) -> str:
    """Read one note in full as Markdown: every section, its tags and its slide deck.

    Args:
        note_id: the id from search_notes
        include_transcript: also return the raw transcript, which can be very long
    """
    with explained():
        return note_markdown(await client().get_note(note_id), include_transcript)


@mcp.tool(annotations=READ_ONLY)
async def list_tags() -> str:
    """Every tag used on the user's notes."""
    with explained():
        tags = await client().list_tags()
    return ", ".join(tags) if tags else "No tags yet."


@mcp.tool(annotations=READ_ONLY)
async def get_flashcards(note_id: str) -> str:
    """Question and answer cards from a note's review questions and defined terms, for quizzing.

    Args:
        note_id: the id from search_notes
    """
    with explained():
        return flashcards_text(await client().get_note(note_id))


if __name__ == "__main__":
    mcp.run()
