"""MongoDB access: a single shared client plus index management."""
import logging

from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase

from config import settings

logger = logging.getLogger(__name__)

_client: AsyncIOMotorClient | None = None


def get_client() -> AsyncIOMotorClient:
    global _client
    if _client is None:
        if not settings.MONGO_URL:
            raise RuntimeError("MONGO_URL is not configured")
        _client = AsyncIOMotorClient(
            settings.MONGO_URL,
            serverSelectionTimeoutMS=8000,
            connectTimeoutMS=8000,
            retryWrites=True,
        )
    return _client


def get_db() -> AsyncIOMotorDatabase:
    return get_client()[settings.DB_NAME]


async def ping() -> bool:
    """True when the database answers. Never raises."""
    try:
        await get_client().admin.command("ping")
        return True
    except Exception as exc:  # noqa: BLE001 - health probe must not raise
        logger.warning("MongoDB ping failed: %s", exc)
        return False


async def ensure_indexes() -> None:
    """Create the indexes every query path relies on. Safe to call repeatedly.

    Never raises: an unreachable or misconfigured database must leave the API
    running and reporting itself unhealthy, not crash-loop the container.
    """
    try:
        db = get_db()
        await db.notes.create_index([("user_id", 1), ("created_at", -1)], name="user_created")
        await db.notes.create_index([("user_id", 1), ("tags", 1)], name="user_tags")
        await db.notes.create_index([("id", 1)], name="note_id", unique=True)
        # Free-text search across the fields the search box hits.
        await db.notes.create_index(
            [("title", "text"), ("raw_transcript", "text")], name="note_text"
        )
        await db.users.create_index([("id", 1)], name="user_id_unique", unique=True)
        await db.users.create_index([("email", 1)], name="user_email_unique", unique=True)
        logger.info("MongoDB indexes ensured")
    except Exception as exc:  # noqa: BLE001 - a missing index must not block boot
        logger.error("Could not ensure indexes: %s", exc)


async def close() -> None:
    global _client
    if _client is not None:
        _client.close()
        _client = None


async def adopt_legacy_notes(owner_email: str) -> int:
    """Give ownerless notes (saved before accounts existed) to one account.

    No-op unless LEGACY_OWNER_EMAIL is set and that user has signed in at
    least once, so it cannot invent an owner out of thin air.
    """
    if not owner_email:
        return 0

    try:
        database = get_db()
        owner = await database.users.find_one({"email": owner_email}, {"_id": 0, "id": 1})
        if not owner:
            logger.info(
                "LEGACY_OWNER_EMAIL=%s has not signed in yet; leaving legacy notes untouched",
                owner_email,
            )
            return 0

        result = await database.notes.update_many(
            {"$or": [{"user_id": {"$exists": False}}, {"user_id": None}]},
            {"$set": {"user_id": owner["id"]}},
        )
        if result.modified_count:
            logger.info("Adopted %d legacy note(s) into %s", result.modified_count, owner_email)
        return result.modified_count
    except Exception as exc:  # noqa: BLE001 - a failed migration must not block boot
        logger.error("Could not adopt legacy notes: %s", exc)
        return 0
