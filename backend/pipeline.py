"""Recordings finished on the server, and their notes saved there.

The browser used to do everything after Stop itself: transcribe the last few
minutes, wait for someone to press Generate, poll the notes job and save the
result. Closing the tab at any point in that lost the rest - and with a rate
limit in the way, "the rest" could be half an hour of waiting.

Now Stop hands the recording over. The app sends what it already has (the text
transcribed live during the lecture) and uploads the audio it has not got to
yet, which is normally just the last few minutes. From there it is the
server's job: transcribe that audio, write the notes, save the note. The tab
can close as soon as the upload is done; the note is in the library when
anyone looks next.

Everything lives in MongoDB, not in memory, so a restart carries on where it
stopped:

  note_jobs   one per handover: status, the transcript so far, how far the
              audio has got, and which note it will be saved as
  job_audio   the uploaded chunks, deleted as each one is transcribed

The note's id is chosen when the job is made, and saving it is an upsert on
that id, so a job that is run twice after a crash still makes one note.

A free Render instance sleeps after fifteen minutes with no requests, which
used to mean the tab's polling was what kept a long job alive. While any job is
unfinished the server now asks itself for /api/health every few minutes.
"""
import asyncio
import logging
import re
import time
import uuid
from datetime import datetime, timedelta, timezone

import httpx
from pymongo.errors import PyMongoError

import db
import languages
import summarizer
import transcription
from config import settings
from models import NoteCreate, SummarizeResponse
from window_cache import WindowCache

logger = logging.getLogger(__name__)

RECEIVING, RUNNING, DONE, FAILED, CANCELLED = "receiving", "running", "done", "failed", "cancelled"
ACTIVE = [RECEIVING, RUNNING]

# Stands in for audio that could not be transcribed, as the client already
# writes it, so the summary and the reader can see a stretch is missing.
GAP = "[...]"

# Pauses between attempts at a chunk every provider refused. Quotas are mostly
# per minute, then per day; the last one repeats until the job's deadline.
RETRY_WAITS = (30, 60, 120, 300, 600, 900)

_CITATIONS = re.compile(r"\[p\. (\d{1,4})(?:–(\d{1,4}))?\]")

_tasks: dict[str, asyncio.Task] = {}
# Progress of the jobs running in this process. Kept in memory: a summary
# reports after every window, and none of that is worth a database write.
_progress: dict[str, dict] = {}
_slots: asyncio.Semaphore | None = None


def _sleep(seconds: float):
    """Separate so tests can skip the waiting."""
    return asyncio.sleep(seconds)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _expiry() -> datetime:
    return datetime.now(timezone.utc) + timedelta(days=settings.NOTE_JOB_KEEP_DAYS)


def _jobs():
    return db.get_db().note_jobs


def _audio():
    return db.get_db().job_audio


def _slot() -> asyncio.Semaphore:
    global _slots
    if _slots is None:
        _slots = asyncio.Semaphore(settings.PIPELINE_CONCURRENCY)
    return _slots


async def _set(job_id: str, **fields) -> None:
    await _jobs().update_one({"id": job_id}, {"$set": {**fields, "updated_at": _now()}})


# ── What the app sees ─────────────────────────────────────────────────────────

def public(job: dict, *, with_transcript: bool = False) -> dict:
    audio = job.get("audio") or {}
    body = {
        "id": job["id"],
        "status": job["status"],
        "progress": _progress.get(job["id"]) or job.get("progress") or {"stage": job["status"], "done": 0, "total": 0},
        "audio": {
            "received": audio.get("received", 0),
            "total": audio.get("total"),
            "done": audio.get("done", 0),
        },
        # Only once it exists: before that it is just the id it will have.
        "note_id": job.get("note_id") if job["status"] == DONE else None,
        "title": job.get("title"),
        "error": job.get("error"),
        "degraded": bool(job.get("degraded")),
        "degraded_reason": job.get("degraded_reason"),
        "gaps": job.get("gaps", 0),
        "duration": job.get("duration"),
        "seen": bool(job.get("seen")),
        "created_at": job.get("created_at"),
        "updated_at": job.get("updated_at"),
    }
    if with_transcript:
        body["transcript"] = job.get("transcript", "")
    return body


async def get(job_id: str, user_id: str) -> dict | None:
    return await _jobs().find_one({"id": job_id, "user_id": user_id}, {"_id": 0})


async def recent(user_id: str) -> list[dict]:
    """Jobs still going, and finished ones nobody has looked at yet, newest first."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
    cursor = _jobs().find(
        {"user_id": user_id, "$or": [{"status": {"$in": ACTIVE}}, {"seen": False}]},
        {"_id": 0, "transcript": 0, "slides": 0, "context": 0},
    ).sort("created_at", -1)
    jobs = [job async for job in cursor]
    return [job for job in jobs if job["status"] in ACTIVE or (job.get("updated_at") or "") >= cutoff][:10]


async def active_count(user_id: str) -> int:
    return await _jobs().count_documents({"user_id": user_id, "status": {"$in": ACTIVE}})


# ── Making and feeding a job ──────────────────────────────────────────────────

async def create(user_id: str, req) -> dict:
    """A new job from a NoteJobCreate. With `audio`, it waits for chunks and a seal."""
    now = _now()
    job = {
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "status": RECEIVING if req.audio else RUNNING,
        "language": languages.normalize(req.language),
        "detected": languages.normalize(req.detected) if req.detected else "",
        "transcript": req.transcript,
        "context": req.context[-2000:],
        "slides": [page.model_dump() for page in req.slides],
        "deck": req.deck.model_dump() if req.deck else None,
        # Chosen now, so saving is an upsert and a rerun never makes a second note.
        "note_id": req.note_id or str(uuid.uuid4()),
        "source": req.source,
        "duration": req.duration,
        "audio": {"received": 0, "bytes": 0, "total": None if req.audio else 0, "done": 0},
        "gaps": 0,
        "seen": False,
        "progress": {"stage": RECEIVING if req.audio else "writing", "done": 0, "total": 0},
        "last_upload_at": time.time(),
        "created_at": now,
        "updated_at": now,
    }
    await _jobs().insert_one(dict(job))
    if not req.audio:
        kick(job["id"])
    return job


class JobError(ValueError):
    """A request this job cannot take, in words fit for the app."""


async def add_chunk(job: dict, index: int, data: bytes, mime_type: str) -> dict:
    """Keep one uploaded chunk. Chunks come in order; sending one again is harmless."""
    if job["status"] != RECEIVING:
        raise JobError("This recording has already been handed over.")
    audio = job["audio"]
    if index > audio["received"]:
        raise JobError(f"Chunk {audio['received'] + 1} has to arrive before chunk {index + 1}.")
    if index >= settings.NOTE_JOB_MAX_CHUNKS:
        raise JobError("That recording has more audio than one job can take.")
    if audio["bytes"] + len(data) > settings.NOTE_JOB_MAX_AUDIO_BYTES:
        raise JobError("That recording has more audio than one job can take.")

    key = {"job_id": job["id"], "index": index}
    await _audio().update_one(
        key,
        {"$set": {**key, "user_id": job["user_id"], "data": data, "type": mime_type,
                  "created_at": datetime.now(timezone.utc)}},
        upsert=True,
    )
    if index == audio["received"]:
        audio = {**audio, "received": index + 1, "bytes": audio["bytes"] + len(data)}
        await _set(job["id"], audio=audio, last_upload_at=time.time(),
                   progress={"stage": RECEIVING, "done": index + 1, "total": 0})
    return {**job, "audio": audio}


async def seal(job: dict, chunks: int, *, abandoned: bool = False) -> dict:
    """No more audio is coming: `chunks` were sent. Start the work."""
    if job["status"] != RECEIVING:
        return job
    audio = job["audio"]
    if chunks > audio["received"]:
        raise JobError(f"Only {audio['received']} of {chunks} chunks arrived. Send the rest first.")
    audio = {**audio, "total": chunks}
    # Given up on by the app part-way: whatever never arrived is a stretch missing.
    gaps = job.get("gaps", 0) + (1 if abandoned else 0)
    await _set(job["id"], status=RUNNING, audio=audio, gaps=gaps, sealed_at=time.time(),
               progress={"stage": "transcribing", "done": audio["done"], "total": chunks})
    kick(job["id"])
    return {**job, "status": RUNNING, "audio": audio, "gaps": gaps}


async def cancel(job: dict) -> dict:
    task = _tasks.get(job["id"])
    if task and not task.done():
        task.cancel()
    await _set(job["id"], status=CANCELLED, expires_at=_expiry())
    await _audio().delete_many({"job_id": job["id"]})
    return {**job, "status": CANCELLED}


async def mark_seen(job: dict) -> None:
    await _set(job["id"], seen=True)


# ── Doing the work ────────────────────────────────────────────────────────────

def kick(job_id: str) -> None:
    """Run the job in this process, unless it already is."""
    task = _tasks.get(job_id)
    if task and not task.done():
        return
    _tasks[job_id] = asyncio.create_task(_run(job_id))


async def _run(job_id: str) -> None:
    try:
        async with _slot():
            # A paused or unreachable database is waited out: the job is safe in
            # it, and picks up where it stopped once it answers again.
            for attempt in range(5):
                try:
                    await _work(job_id)
                    return
                except PyMongoError as exc:
                    logger.warning("Job %s lost the database (%s); retrying", job_id, exc)
                    await _sleep(60 * (attempt + 1))
            logger.error("Job %s gave up on the database; it resumes on the next sweep", job_id)
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001 - reported to the app, never raised into the loop
        logger.exception("Job %s failed", job_id)
        try:
            await _set(job_id, status=FAILED, expires_at=_expiry(),
                       error="Something went wrong while finishing this recording. Its transcript is kept.")
        except Exception:  # noqa: BLE001
            logger.exception("Could not record the failure of job %s", job_id)
    finally:
        _tasks.pop(job_id, None)
        _progress.pop(job_id, None)


async def _transcribe(job_id: str, chunk: dict, language: str, context: str,
                      deadline: float, index: int, total: int) -> tuple[str | None, str]:
    """(text, language heard) for one chunk, or (None, "") once it is not worth asking again."""
    attempt = 0
    while True:
        try:
            result = await transcription.transcribe(
                bytes(chunk["data"]), chunk["type"], language=language, context=context[-2000:],
            )
            return (result.get("text") or "").strip(), result.get("language") or ""
        except transcription.AudioError as exc:
            logger.warning("Job %s chunk %d is not usable audio: %s", job_id, index + 1, exc)
            return None, ""
        except Exception as exc:  # noqa: BLE001 - every provider refused; wait it out
            wait = RETRY_WAITS[min(attempt, len(RETRY_WAITS) - 1)]
            if time.time() + wait > deadline:
                logger.error("Job %s chunk %d left out after %d attempts: %s", job_id, index + 1, attempt + 1, exc)
                return None, ""
            logger.warning("Job %s chunk %d failed (%s); trying again in %ds", job_id, index + 1, exc, wait)
            _progress[job_id] = {
                "stage": "waiting", "done": index, "total": total,
                "retry_at": datetime.fromtimestamp(time.time() + wait, timezone.utc).isoformat(),
            }
            attempt += 1
            await _sleep(wait)


def cited_pages(sections: dict) -> list[int]:
    """Every slide page the notes cite, as the app works it out (lib/notes.js)."""
    pages: set[int] = set()
    for items in sections.values():
        for item in items if isinstance(items, list) else []:
            for match in _CITATIONS.finditer(str(item)):
                first = int(match.group(1))
                last = int(match.group(2) or first)
                pages.update(range(first, min(last, first + 5) + 1))
    return sorted(pages)


async def _work(job_id: str) -> None:
    job = await _jobs().find_one({"id": job_id}, {"_id": 0})
    if not job or job["status"] != RUNNING:
        return

    audio = job["audio"]
    total = audio.get("total") or 0
    transcript = job.get("transcript", "")
    context = job.get("context", "")
    detected = job.get("detected", "")
    gaps = job.get("gaps", 0)
    deadline = job.get("sealed_at", time.time()) + settings.NOTE_JOB_AUDIO_RETRY_FOR

    # ── The audio the app did not get to ──
    for index in range(audio.get("done", 0), total):
        _progress[job_id] = {"stage": "transcribing", "done": index, "total": total}
        chunk = await _audio().find_one({"job_id": job_id, "index": index}, {"_id": 0})
        language = detected or job["language"]
        text, heard = (None, "")
        if chunk:
            text, heard = await _transcribe(job_id, chunk, language, context, deadline, index, total)
        if text is None:
            gaps += 1
            transcript = f"{transcript} {GAP}".strip()
        elif text:
            transcript = f"{transcript} {text}".strip()
            context = text
        heard = languages.normalize(heard) if heard else ""
        if not detected and heard and heard != languages.AUTO:
            detected = heard
        audio = {**audio, "done": index + 1}
        # Text first, then the audio goes: a crash between the two redoes nothing.
        await _set(job_id, transcript=transcript, context=context, detected=detected, gaps=gaps, audio=audio)
        await _audio().delete_many({"job_id": job_id, "index": index})

    spoken = transcript.replace(GAP, "").strip()
    if not spoken:
        await _set(
            job_id, status=FAILED, expires_at=_expiry(),
            error=(
                "None of the recording could be transcribed: every service refused it. "
                "The audio is still kept on the device you recorded on."
                if gaps else "No speech was detected in that recording."
            ),
        )
        return

    # ── The notes ──
    transcript = transcript[: settings.MAX_TRANSCRIPT_CHARS]
    language = job["language"] if job["language"] != languages.AUTO else (detected or languages.AUTO)
    _progress[job_id] = {"stage": "writing", "done": 0, "total": 0}
    await _set(job_id, progress={"stage": "writing", "done": 0, "total": 0})

    def report(stage: str, done: int, total_windows: int) -> None:
        _progress[job_id] = {"stage": stage, "done": done, "total": total_windows}

    try:
        result = await summarizer.summarize(
            transcript, language, slides=job.get("slides") or [], report=report, cache=WindowCache(job["user_id"]),
        )
    except Exception:  # noqa: BLE001 - the transcript is saved whatever happens to the summary
        logger.exception("Summary for job %s failed; saving local notes", job_id)
        result = summarizer.fallback_summary(transcript, language)
        result["degraded_reason"] = "unavailable"
    result = SummarizeResponse(**result).model_dump()

    degraded_reason = result.get("degraded_reason")
    if gaps and not degraded_reason:
        degraded_reason = "audio_gap"
    degraded = bool(result.get("degraded")) or bool(gaps)

    # ── Saved, without anyone having to be there ──
    deck = job.get("deck")
    if deck:
        deck = {**deck, "cited": cited_pages(result["sections"])}
    note = NoteCreate(
        title=result["title"],
        raw_transcript=transcript,
        sections=result["sections"],
        labels=result["labels"],
        type=result["type"],
        language=result.get("language") or detected or job["language"],
        source=job.get("source") or "voice",
        duration=job.get("duration"),
        degraded=degraded,
        slides=deck,
    ).model_dump()
    note_id, user_id, now = job["note_id"], job["user_id"], _now()
    notes = db.get_db().notes
    if await notes.find_one({"id": note_id, "user_id": user_id}, {"_id": 0, "id": 1}):
        # Regenerating: the same note, its tags and its creation date kept.
        note.pop("tags", None)
        await notes.update_one({"id": note_id, "user_id": user_id}, {"$set": {**note, "updated_at": now}})
    else:
        await notes.insert_one({"id": note_id, "user_id": user_id, **note, "created_at": now, "updated_at": now})

    await _set(
        job_id, status=DONE, title=note["title"], degraded=degraded, degraded_reason=degraded_reason,
        progress={"stage": "done", "done": 0, "total": 0}, expires_at=_expiry(),
        # The note holds these now.
        transcript="", context="", slides=[],
    )
    logger.info("Job %s saved note %s (%d chunk(s) transcribed here, %d gap(s))", job_id, note_id, total, gaps)


# ── Keeping it going ──────────────────────────────────────────────────────────

async def resume() -> int:
    """Restart jobs this process is not running, and seal ones the app walked away from.

    Run at boot and on every sweep. Returns how many jobs are unfinished.
    """
    cursor = _jobs().find({"status": {"$in": ACTIVE}}, {"_id": 0, "transcript": 0, "slides": 0, "context": 0})
    jobs = [job async for job in cursor]
    for job in jobs:
        if job["status"] == RUNNING:
            kick(job["id"])
        elif time.time() - job.get("last_upload_at", 0) > settings.NOTE_JOB_RECEIVE_TIMEOUT:
            # The tab closed before the upload finished. Notes from what arrived
            # beat no notes; the rest of the audio is still on that device.
            logger.warning("Job %s stopped receiving audio; finishing with what arrived", job["id"])
            await seal(job, job["audio"]["received"], abandoned=True)
    return len(jobs)


async def _keep_awake() -> None:
    url = settings.KEEPALIVE_URL
    if not url:
        return
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            await client.head(f"{url.rstrip('/')}/api/health")
    except httpx.HTTPError as exc:
        logger.warning("Keep-alive ping failed: %s", exc)


async def maintain() -> None:
    """For the life of the process: resume, seal abandoned uploads, stay awake while there is work."""
    while True:
        try:
            if await resume():
                await _keep_awake()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - next sweep tries again
            logger.warning("Job sweep failed: %s", exc)
        await asyncio.sleep(settings.PIPELINE_SWEEP_SECONDS)


def reset() -> None:
    """For tests: cancel and forget everything running here."""
    global _slots
    for task in _tasks.values():
        if not task.done():
            task.cancel()
    _tasks.clear()
    _progress.clear()
    _slots = None
