"""Lumina Note API.

Run from this directory:  uvicorn server:app
or from the repo root:    uvicorn backend.server:app
"""
import sys
from pathlib import Path

# Make the sibling modules importable under both start commands above.
sys.path.insert(0, str(Path(__file__).parent))

import logging  # noqa: E402
import re  # noqa: E402
import uuid  # noqa: E402
from contextlib import asynccontextmanager  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

from fastapi import APIRouter, Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile, status  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402
from pymongo.errors import PyMongoError  # noqa: E402
from starlette.middleware.cors import CORSMiddleware  # noqa: E402

import db  # noqa: E402
import gemini  # noqa: E402
import languages  # noqa: E402
import ratelimit  # noqa: E402
import summarizer  # noqa: E402
import transcription  # noqa: E402
from auth import User, current_user, issue_access_token, upsert_user, verify_google_credential  # noqa: E402
from config import settings  # noqa: E402
from models import (  # noqa: E402
    AuthResponse,
    GoogleAuthRequest,
    NoteCreate,
    NoteResponse,
    NotesPage,
    NoteUpdate,
    SummarizeRequest,
    SummarizeResponse,
    TranscribeResponse,
    UserOut,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("lumina")


@asynccontextmanager
async def lifespan(_: FastAPI):
    missing = [
        name
        for name, value in (
            ("MONGO_URL", settings.MONGO_URL),
            ("GEMINI_API_KEY", settings.GEMINI_API_KEY),
            ("GOOGLE_CLIENT_ID", settings.GOOGLE_CLIENT_ID),
        )
        if not value
    ]
    if missing:
        logger.warning("Starting with unset configuration: %s", ", ".join(missing))
    if settings.JWT_SECRET_IS_EPHEMERAL:
        logger.warning(
            "JWT_SECRET is unset - a random one was generated, so every restart "
            "will sign everyone out. Set JWT_SECRET in production."
        )

    if settings.MONGO_URL:
        await db.ensure_indexes()
        await db.adopt_legacy_notes(settings.LEGACY_OWNER_EMAIL)

    yield

    await gemini.close_http_client()
    await db.close()


app = FastAPI(
    title="Lumina Note API",
    version=settings.APP_VERSION,
    lifespan=lifespan,
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
)
api = APIRouter(prefix="/api")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _client_ip(request: Request) -> str:
    """Caller IP, honouring the proxy header the host platform sets.

    Without this every request behind the load balancer shares one bucket and
    a handful of sign-ins would lock out everyone else.
    """
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


# ── Public ────────────────────────────────────────────────────────────────────

async def _status() -> dict:
    database_ok = await db.ping() if settings.MONGO_URL else False
    return {
        "ok": True,
        "version": settings.APP_VERSION,
        "database": "up" if database_ok else "down",
        "ai": "configured" if settings.ai_configured else "missing_api_key",
        "auth": "configured" if settings.auth_configured else "missing_client_id",
        "ready": database_ok and settings.ai_configured and settings.auth_configured,
    }


@api.get("/health")
async def health():
    """Liveness. Always 200 while the process is up, so a missing API key
    cannot make the platform cycle an otherwise healthy container."""
    return await _status()


@api.get("/health/ready")
async def health_ready():
    """Readiness: 503 until the database and both API credentials are usable."""
    body = await _status()
    return JSONResponse(status_code=200 if body["ready"] else 503, content=body)


@app.head("/api/health")
async def health_head():
    return JSONResponse(content=None)


@api.get("/config")
async def public_config():
    """What the frontend needs to know before anyone signs in."""
    return {
        "google_client_id": settings.GOOGLE_CLIENT_ID,
        "auth_required": True,
        "max_audio_bytes": settings.MAX_AUDIO_BYTES,
        "max_transcript_chars": settings.MAX_TRANSCRIPT_CHARS,
        "languages": [
            {"code": code, "name": name, "native": native, "locale": locale}
            for code, (name, native, locale) in languages.LANGUAGES.items()
        ],
    }


# ── Auth ──────────────────────────────────────────────────────────────────────

@api.post("/auth/google", response_model=AuthResponse)
async def sign_in_with_google(payload: GoogleAuthRequest, request: Request):
    ratelimit.check(f"auth:{_client_ip(request)}", 20, 60)

    claims = await verify_google_credential(payload.credential)
    user = await upsert_user(claims)
    token, expires_in = issue_access_token(user)
    logger.info("Signed in: %s", user.email)
    return AuthResponse(
        access_token=token,
        expires_in=expires_in,
        user=UserOut(**user.public()),
    )


@api.get("/auth/me", response_model=UserOut)
async def whoami(user: User = Depends(current_user)):
    return UserOut(**user.public())


# ── Transcription ─────────────────────────────────────────────────────────────

@api.post("/transcribe", response_model=TranscribeResponse)
async def transcribe_audio(
    file: UploadFile = File(...),
    language: str = Form("auto"),
    context: str = Form(""),
    user: User = Depends(current_user),
):
    """Speech to text for one audio chunk, with language auto-detection."""
    ratelimit.check(f"ai:{user.id}", *settings.RATE_LIMIT_AI)

    if not settings.ai_configured:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Transcription is unavailable: the server has no Gemini API key.",
        )

    data = await file.read()
    try:
        result = await transcription.transcribe(
            data,
            file.content_type or "",
            language=language,
            context=context[:2000],
        )
    except transcription.AudioError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except gemini.GeminiError as exc:
        detail = (
            "The transcription service is out of quota for now. Please try again later."
            if exc.quota
            else "Transcription failed. Your recording was not lost - please try again."
        )
        logger.error("Transcription failed for %s: %s", user.email, exc)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=detail) from exc

    logger.info(
        "Transcribed %d bytes for %s (%s, %d chunk(s))",
        len(data), user.email, result["language"], result["chunks"],
    )
    return TranscribeResponse(**result)


# ── Summarization ─────────────────────────────────────────────────────────────

@api.post("/notes/summarize", response_model=SummarizeResponse)
async def summarize_transcript(req: SummarizeRequest, user: User = Depends(current_user)):
    ratelimit.check(f"ai:{user.id}", *settings.RATE_LIMIT_AI)

    result = await summarizer.summarize(req.transcript, req.language)
    if result.get("degraded"):
        logger.warning(
            "Returned degraded notes to %s (%s)", user.email, result.get("degraded_reason")
        )
    return SummarizeResponse(**result)


# ── Notes (scoped to the signed-in user) ──────────────────────────────────────

@api.post("/notes", response_model=NoteResponse, status_code=status.HTTP_201_CREATED)
async def create_note(note: NoteCreate, user: User = Depends(current_user)):
    ratelimit.check(f"write:{user.id}", *settings.RATE_LIMIT_WRITE)

    doc = {
        "id": str(uuid.uuid4()),
        "user_id": user.id,
        **note.model_dump(),
        "created_at": _now(),
        "updated_at": _now(),
    }
    # insert_one stamps _id onto the mapping it is given, so hand it a copy.
    await db.get_db().notes.insert_one(dict(doc))
    return NoteResponse(**doc)


@api.get("/notes", response_model=NotesPage)
async def list_notes(
    search: str | None = Query(None, max_length=200),
    tag: str | None = Query(None, max_length=40),
    limit: int = Query(30, ge=1, le=settings.MAX_NOTES_PAGE),
    offset: int = Query(0, ge=0),
    user: User = Depends(current_user),
):
    query: dict = {"user_id": user.id}
    if search and search.strip():
        # Regex rather than $text so partial words match while typing; escaped
        # so a stray "(" in the search box cannot blow up the query.
        pattern = re.escape(search.strip())
        query["$or"] = [
            {"title": {"$regex": pattern, "$options": "i"}},
            {"raw_transcript": {"$regex": pattern, "$options": "i"}},
            {"tags": {"$regex": pattern, "$options": "i"}},
        ]
    if tag:
        query["tags"] = tag.strip().lower()

    notes_collection = db.get_db().notes
    total = await notes_collection.count_documents(query)
    cursor = (
        notes_collection.find(query, {"_id": 0})
        .sort("created_at", -1)
        .skip(offset)
        .limit(limit)
    )
    items = [NoteResponse(**doc) async for doc in cursor]
    return NotesPage(items=items, total=total, limit=limit, offset=offset)


@api.get("/notes/{note_id}", response_model=NoteResponse)
async def get_note(note_id: str, user: User = Depends(current_user)):
    note = await db.get_db().notes.find_one({"id": note_id, "user_id": user.id}, {"_id": 0})
    if not note:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Note not found")
    return NoteResponse(**note)


@api.patch("/notes/{note_id}", response_model=NoteResponse)
async def update_note(note_id: str, req: NoteUpdate, user: User = Depends(current_user)):
    ratelimit.check(f"write:{user.id}", *settings.RATE_LIMIT_WRITE)

    changes = {k: v for k, v in req.model_dump(exclude_unset=True).items() if v is not None}
    if not changes:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Nothing to update")
    changes["updated_at"] = _now()

    note = await db.get_db().notes.find_one_and_update(
        {"id": note_id, "user_id": user.id},
        {"$set": changes},
        projection={"_id": 0},
        return_document=True,
    )
    if not note:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Note not found")
    return NoteResponse(**note)


@api.delete("/notes/{note_id}", status_code=status.HTTP_200_OK)
async def delete_note(note_id: str, user: User = Depends(current_user)):
    ratelimit.check(f"write:{user.id}", *settings.RATE_LIMIT_WRITE)

    result = await db.get_db().notes.delete_one({"id": note_id, "user_id": user.id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Note not found")
    return {"message": "Note deleted", "id": note_id}


@api.get("/tags", response_model=list[str])
async def list_tags(user: User = Depends(current_user)):
    pipeline = [
        {"$match": {"user_id": user.id}},
        {"$unwind": "$tags"},
        {"$group": {"_id": "$tags"}},
        {"$sort": {"_id": 1}},
        {"$limit": 200},
    ]
    tags = await db.get_db().notes.aggregate(pipeline).to_list(200)
    return [t["_id"] for t in tags]


# ── App wiring ────────────────────────────────────────────────────────────────

app.include_router(api)


# Registered before CORS so that CORS ends up the outer layer: a 500 produced
# here still carries the headers the browser needs to let the app read it.
@app.middleware("http")
async def catch_unhandled_errors(request: Request, call_next):
    try:
        return await call_next(request)
    except PyMongoError:
        # A free-tier cluster that has been idle is paused and takes a minute or
        # so to come back. That is worth saying plainly instead of "went wrong".
        logger.exception("Database error on %s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=503,
            content={
                "detail": (
                    "The database is not responding. If it has been idle for a while it "
                    "may be waking up - try again in a minute."
                )
            },
            headers={"Retry-After": "30"},
        )
    except Exception:  # noqa: BLE001 - never leak a stack trace to the client
        logger.exception("Unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=500,
            content={"detail": "Something went wrong on our side. Please try again."},
        )


app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)
