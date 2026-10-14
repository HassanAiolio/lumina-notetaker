"""Notes already written for stretches of a transcript, so a rerun only redoes the gaps.

A long lecture is summarized window by window. When a rate limit leaves some
windows out, regenerating used to start again from the top and spend the
quota a second time on the windows that had worked. Each finished window is
kept here instead, keyed by its text, and a rerun takes it from here.

They are kept only while a run is incomplete. Once every window is written the
entries are dropped, so asking for the notes again on a complete set writes
fresh ones rather than handing back the same. A TTL index clears whatever
nobody came back for.

A failure here never fails a summary: the cache only saves work.
"""
import hashlib
import logging
from datetime import datetime, timezone

import db

logger = logging.getLogger(__name__)

# Part of every key: bump it when the prompt changes enough that notes written
# under the old one should not be reused.
PROMPT_VERSION = "1"


def window_key(window: str, language: str, slides: list[dict]) -> str:
    """The same text, asked for in the same language with the same slides, is the same window."""
    digest = hashlib.sha256()
    for piece in (PROMPT_VERSION, language, *(f"{s['page']}:{s['text']}" for s in slides), window):
        digest.update(piece.encode())
        digest.update(b"\0")
    return digest.hexdigest()


class WindowCache:
    def __init__(self, user_id: str):
        self.user_id = user_id

    key = staticmethod(window_key)

    def _collection(self):
        return db.get_db().window_notes

    async def get(self, key: str) -> dict | None:
        try:
            doc = await self._collection().find_one({"user_id": self.user_id, "key": key}, {"_id": 0, "part": 1})
        except Exception as exc:  # noqa: BLE001 - see the module docstring
            logger.warning("Window cache read failed: %s", exc)
            return None
        return doc["part"] if doc else None

    async def put(self, key: str, part: dict) -> None:
        try:
            await self._collection().update_one(
                {"user_id": self.user_id, "key": key},
                {"$set": {"user_id": self.user_id, "key": key, "part": part, "created_at": datetime.now(timezone.utc)}},
                upsert=True,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Window cache write failed: %s", exc)

    async def forget(self, keys: list[str]) -> None:
        if not keys:
            return
        try:
            await self._collection().delete_many({"user_id": self.user_id, "key": {"$in": keys}})
        except Exception as exc:  # noqa: BLE001
            logger.warning("Window cache cleanup failed: %s", exc)
