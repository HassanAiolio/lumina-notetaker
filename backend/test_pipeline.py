"""Recordings handed to the server at Stop: finished, written up and saved there.

What matters: a note is saved without the app being there, the audio the app
did not get to is transcribed in order, nothing is lost to a refusing provider
or a restart, and one account never touches another's recording.
"""
import asyncio
import time

import pytest

import pipeline
import server
import transcription
from test_api import ALICE, BOB, as_user, client, fake_db, make_note  # noqa: F401 - fixtures

NOTES = {
    "title": "Cours 2",
    "type": "LECTURE",
    "language": "fr",
    "sections": {"overview": ["Descente de gradient [p. 3]", "Pas d'apprentissage [p. 5–6]"]},
    "labels": {"overview": "Vue d'ensemble"},
}


@pytest.fixture(autouse=True)
def no_waiting(monkeypatch):
    async def instant(_seconds):
        await asyncio.sleep(0)

    monkeypatch.setattr(pipeline, "_sleep", instant)


@pytest.fixture
def summarize(monkeypatch):
    seen = {}

    async def fake(transcript, language, slides=None, report=None, cache=None):
        seen.update(transcript=transcript, language=language, slides=slides, cache=cache)
        if report:
            report("writing", 1, 2)
        return dict(NOTES)

    monkeypatch.setattr(pipeline.summarizer, "summarize", fake)
    return seen


def chunks_say(monkeypatch, replies):
    """Fake transcription: each reply is text, or an exception to raise, in order."""
    calls = []

    async def fake(data, mime_type, language="auto", context=""):
        calls.append({"data": data, "type": mime_type, "language": language, "context": context})
        reply = replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return {"text": reply, "language": "fr", "duration": None, "chunks": 1}

    monkeypatch.setattr(pipeline.transcription, "transcribe", fake)
    return calls


def wait_for(client, job_id, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        body = client.get(f"/api/notes/jobs/{job_id}").json()
        if body["status"] not in pipeline.ACTIVE:
            return body
        time.sleep(0.02)
    raise AssertionError("the job never finished")


def upload(client, job_id, index, data=b"ID3audio", content_type="audio/mpeg"):
    return client.put(f"/api/notes/jobs/{job_id}/audio/{index}", content=data, headers={"Content-Type": content_type})


# ── Typed transcripts and regenerating ────────────────────────────────────────

def test_notes_are_saved_without_the_app_collecting_them(client, fake_db, summarize):
    started = client.post("/api/notes/jobs", json={
        "transcript": "Bonjour à tous.", "language": "fr", "source": "text",
        "slides": [{"page": 3, "text": "Gradient"}],
        "deck": {"name": "cours2.pdf", "pages": 12, "hash": "abc"},
    })
    assert started.status_code == 202, started.text
    assert started.json()["note_id"] is None   # not until it exists

    done = wait_for(client, started.json()["id"])
    assert done["status"] == "done"
    assert done["title"] == "Cours 2"

    [note] = fake_db.notes.docs
    assert note["id"] == done["note_id"] and note["user_id"] == ALICE.id
    assert note["raw_transcript"] == "Bonjour à tous."
    assert note["source"] == "text"
    assert note["slides"]["cited"] == [3, 5, 6]
    assert summarize["slides"] == [{"page": 3, "text": "Gradient"}]
    assert summarize["cache"].user_id == ALICE.id
    # The note holds the transcript now; the job does not keep a second copy.
    assert fake_db.note_jobs.docs[0]["transcript"] == ""
    assert client.get(f"/api/notes/{note['id']}").status_code == 200


def test_regenerating_rewrites_the_same_note_and_keeps_its_tags(client, fake_db, summarize):
    note = make_note(client, tags=["ml"])
    job = client.post("/api/notes/jobs", json={"transcript": "Encore.", "note_id": note["id"]}).json()
    wait_for(client, job["id"])

    [saved] = fake_db.notes.docs
    assert saved["id"] == note["id"]
    assert saved["title"] == "Cours 2"
    assert saved["tags"] == ["ml"]
    assert saved["created_at"] == note["created_at"]


def test_a_job_cannot_rewrite_someone_elses_note(client, summarize):
    note = make_note(client)
    as_user(BOB)
    response = client.post("/api/notes/jobs", json={"transcript": "Encore.", "note_id": note["id"]})
    assert response.status_code == 404


def test_a_summary_that_crashes_still_saves_the_transcript(client, fake_db, monkeypatch):
    async def broken(*args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(pipeline.summarizer, "summarize", broken)
    job = client.post("/api/notes/jobs", json={"transcript": "Une phrase importante. Une autre."}).json()
    done = wait_for(client, job["id"])
    assert done["status"] == "done"
    assert done["degraded"] is True and done["degraded_reason"] == "unavailable"
    assert fake_db.notes.docs[0]["raw_transcript"] == "Une phrase importante. Une autre."


def test_an_empty_transcript_with_no_audio_is_refused(client):
    assert client.post("/api/notes/jobs", json={"transcript": "  "}).status_code == 422


# ── Audio the app had not got to ──────────────────────────────────────────────

def test_the_rest_of_a_recording_is_transcribed_in_order_and_saved(client, fake_db, summarize, monkeypatch):
    calls = chunks_say(monkeypatch, ["Deuxième partie.", "Troisième partie."])
    job = client.post("/api/notes/jobs", json={
        "transcript": "Première partie.", "context": "Première partie.", "detected": "fr",
        "language": "auto", "audio": True, "duration": 1800,
        "slides": [{"page": 3, "text": "Gradient"}, {"page": 4, "text": ""}],
        "deck": {"name": "cours2.pdf", "pages": 12, "hash": "abc"},
    }).json()
    assert job["status"] == "receiving"

    assert upload(client, job["id"], 0, b"one").status_code == 204
    assert upload(client, job["id"], 0, b"one").status_code == 204   # a resend is harmless
    assert upload(client, job["id"], 1, b"two").status_code == 204
    sealed = client.post(f"/api/notes/jobs/{job['id']}/seal", json={"chunks": 2})
    assert sealed.status_code == 200 and sealed.json()["status"] == "running"

    done = wait_for(client, job["id"])
    assert done["status"] == "done" and done["degraded"] is False
    assert [c["data"] for c in calls] == [b"one", b"two"]
    assert [c["context"] for c in calls] == ["Première partie.", "Deuxième partie."]
    assert calls[0]["language"] == "fr"            # what the live run heard, not "auto"
    assert summarize["language"] == "fr"
    note = fake_db.notes.docs[0]
    assert note["raw_transcript"] == "Première partie. Deuxième partie. Troisième partie."
    assert note["duration"] == 1800 and note["source"] == "voice"
    assert fake_db.job_audio.docs == []             # each chunk goes once it is text
    # The slides attached to the recording guide its notes, and the note says which pages they cite.
    assert summarize["slides"] == [{"page": 3, "text": "Gradient"}]
    assert note["slides"] == {"name": "cours2.pdf", "pages": 12, "hash": "abc", "cited": [3, 5, 6]}


def test_chunks_have_to_arrive_in_order_and_all_of_them(client, monkeypatch):
    job = client.post("/api/notes/jobs", json={"audio": True}).json()
    assert upload(client, job["id"], 1).status_code == 409
    assert upload(client, job["id"], 0, content_type="text/plain").status_code == 400
    assert upload(client, job["id"], 0, data=b"").status_code == 400
    assert upload(client, job["id"], 0).status_code == 204
    short = client.post(f"/api/notes/jobs/{job['id']}/seal", json={"chunks": 2})
    assert short.status_code == 409 and "Only 1 of 2" in short.json()["detail"]

    chunks_say(monkeypatch, ["Bonjour."])
    monkeypatch.setattr(pipeline.summarizer, "summarize", lambda *a, **k: asyncio.sleep(0, NOTES))
    client.post(f"/api/notes/jobs/{job['id']}/seal", json={"chunks": 1})
    assert upload(client, job["id"], 1).status_code == 409   # handed over: nothing more taken


def test_a_refusing_provider_is_waited_out(client, fake_db, summarize, monkeypatch):
    calls = chunks_say(monkeypatch, [RuntimeError("quota"), RuntimeError("quota"), "Enfin."])
    job = client.post("/api/notes/jobs", json={"audio": True}).json()
    upload(client, job["id"], 0)
    client.post(f"/api/notes/jobs/{job['id']}/seal", json={"chunks": 1})
    done = wait_for(client, job["id"])
    assert done["status"] == "done" and done["gaps"] == 0
    assert len(calls) == 3
    assert fake_db.notes.docs[0]["raw_transcript"] == "Enfin."


def test_a_chunk_refused_past_the_deadline_is_left_out_and_marked(client, fake_db, summarize, monkeypatch):
    monkeypatch.setattr(pipeline.settings, "NOTE_JOB_AUDIO_RETRY_FOR", 0)
    chunks_say(monkeypatch, [RuntimeError("quota"), "La suite."])
    job = client.post("/api/notes/jobs", json={"transcript": "Le début.", "audio": True}).json()
    upload(client, job["id"], 0)
    upload(client, job["id"], 1)
    client.post(f"/api/notes/jobs/{job['id']}/seal", json={"chunks": 2})
    done = wait_for(client, job["id"])
    assert done["status"] == "done"
    assert done["gaps"] == 1 and done["degraded"] is True and done["degraded_reason"] == "audio_gap"
    assert fake_db.notes.docs[0]["raw_transcript"] == "Le début. [...] La suite."


def test_audio_that_cannot_be_used_is_a_gap_not_a_retry(client, fake_db, summarize, monkeypatch):
    calls = chunks_say(monkeypatch, [transcription.AudioError("garbled"), "Ensuite."])
    job = client.post("/api/notes/jobs", json={"audio": True}).json()
    upload(client, job["id"], 0)
    upload(client, job["id"], 1)
    client.post(f"/api/notes/jobs/{job['id']}/seal", json={"chunks": 2})
    assert wait_for(client, job["id"])["gaps"] == 1
    assert len(calls) == 2


def test_a_recording_with_no_speech_fails_and_says_why(client, fake_db, summarize, monkeypatch):
    chunks_say(monkeypatch, [""])
    job = client.post("/api/notes/jobs", json={"audio": True}).json()
    upload(client, job["id"], 0)
    client.post(f"/api/notes/jobs/{job['id']}/seal", json={"chunks": 1})
    failed = wait_for(client, job["id"])
    assert failed["status"] == "failed" and "No speech" in failed["error"]
    assert fake_db.notes.docs == []


def test_cancelling_drops_the_audio(client, fake_db):
    job = client.post("/api/notes/jobs", json={"transcript": "Début.", "audio": True}).json()
    upload(client, job["id"], 0)
    cancelled = client.post(f"/api/notes/jobs/{job['id']}/cancel").json()
    assert cancelled["status"] == "cancelled"
    assert fake_db.job_audio.docs == []
    # Its text can still be taken back.
    assert client.get(f"/api/notes/jobs/{job['id']}?transcript=true").json()["transcript"] == "Début."


# ── Whose it is, and how many ─────────────────────────────────────────────────

def test_a_recording_is_private_to_whoever_handed_it_over(client, summarize):
    job = client.post("/api/notes/jobs", json={"transcript": "Début.", "audio": True}).json()
    as_user(BOB)
    assert client.get(f"/api/notes/jobs/{job['id']}").status_code == 404
    assert upload(client, job["id"], 0).status_code == 404
    assert client.post(f"/api/notes/jobs/{job['id']}/seal", json={"chunks": 0}).status_code == 404
    assert client.post(f"/api/notes/jobs/{job['id']}/cancel").status_code == 404
    assert client.get("/api/notes/jobs").json() == []


def test_one_person_cannot_pile_up_recordings(client, monkeypatch):
    monkeypatch.setattr(server.settings, "NOTE_JOB_MAX_ACTIVE", 1)
    assert client.post("/api/notes/jobs", json={"audio": True}).status_code == 202
    assert client.post("/api/notes/jobs", json={"audio": True}).status_code == 429
    as_user(BOB)
    assert client.post("/api/notes/jobs", json={"audio": True}).status_code == 202


def test_finished_jobs_are_listed_until_seen(client, summarize):
    job = client.post("/api/notes/jobs", json={"transcript": "Bonjour."}).json()
    wait_for(client, job["id"])
    listed = client.get("/api/notes/jobs").json()
    assert [j["id"] for j in listed] == [job["id"]]
    assert listed[0]["note_id"]
    assert client.post(f"/api/notes/jobs/{job['id']}/seen").status_code == 204
    assert client.get("/api/notes/jobs").json() == []


# ── Restarts and walking away ─────────────────────────────────────────────────

def _stored_job(**overrides):
    return {
        "id": "job-1", "user_id": ALICE.id, "status": "running", "language": "fr", "detected": "fr",
        "transcript": "Avant le redémarrage.", "context": "Avant le redémarrage.", "slides": [], "deck": None,
        "note_id": "note-1", "source": "voice", "duration": None,
        "audio": {"received": 1, "bytes": 3, "total": 1, "done": 0}, "gaps": 0, "seen": False,
        "progress": {"stage": "transcribing", "done": 0, "total": 1},
        "last_upload_at": time.time(), "sealed_at": time.time(),
        "created_at": "2026-11-17T10:00:00+00:00", "updated_at": "2026-11-17T10:00:00+00:00",
        **overrides,
    }


async def _settle():
    while pipeline._tasks:
        await asyncio.gather(*list(pipeline._tasks.values()))


async def test_a_job_interrupted_by_a_restart_carries_on(fake_db, summarize, monkeypatch):
    chunks_say(monkeypatch, ["Après."])
    fake_db.note_jobs.docs.append(_stored_job())
    fake_db.job_audio.docs.append({"job_id": "job-1", "index": 0, "data": b"abc", "type": "audio/mpeg"})

    assert await pipeline.resume() == 1
    await _settle()
    [note] = fake_db.notes.docs
    assert note["id"] == "note-1"
    assert note["raw_transcript"] == "Avant le redémarrage. Après."

    # Run again (say the status write was lost): still one note.
    fake_db.note_jobs.docs[0]["status"] = "running"
    fake_db.note_jobs.docs[0]["transcript"] = "Avant le redémarrage. Après."
    await pipeline.resume()
    await _settle()
    assert len(fake_db.notes.docs) == 1


async def test_an_upload_the_app_walked_away_from_is_finished_with_what_arrived(fake_db, summarize, monkeypatch):
    chunks_say(monkeypatch, ["Reçu."])
    fake_db.note_jobs.docs.append(_stored_job(
        status="receiving", audio={"received": 1, "bytes": 3, "total": None, "done": 0},
        last_upload_at=time.time() - pipeline.settings.NOTE_JOB_RECEIVE_TIMEOUT - 5,
    ))
    fake_db.job_audio.docs.append({"job_id": "job-1", "index": 0, "data": b"abc", "type": "audio/mpeg"})

    await pipeline.resume()
    await _settle()
    job = fake_db.note_jobs.docs[0]
    assert job["status"] == "done"
    assert job["gaps"] == 1 and job["degraded_reason"] == "audio_gap"   # whatever never arrived
    assert fake_db.notes.docs[0]["raw_transcript"] == "Avant le redémarrage. Reçu."


async def test_an_upload_still_going_is_left_alone(fake_db):
    fake_db.note_jobs.docs.append(_stored_job(status="receiving", audio={"received": 1, "bytes": 3, "total": None, "done": 0}))
    await pipeline.resume()
    assert fake_db.note_jobs.docs[0]["status"] == "receiving"


async def test_the_server_keeps_itself_awake_only_while_there_is_work(fake_db, monkeypatch):
    pinged = []
    monkeypatch.setattr(pipeline, "_keep_awake", lambda: pinged.append(1) or asyncio.sleep(0))
    monkeypatch.setattr(pipeline.settings, "PIPELINE_SWEEP_SECONDS", 0.01)

    sweeper = asyncio.create_task(pipeline.maintain())
    await asyncio.sleep(0.05)
    assert pinged == []
    fake_db.note_jobs.docs.append(_stored_job(status="receiving"))
    await asyncio.sleep(0.05)
    sweeper.cancel()
    assert pinged


def test_cited_pages_match_the_app():
    sections = {"a": ["x [p. 2]", "y [p. 4–20]"], "b": "not a list"}
    assert pipeline.cited_pages(sections) == [2, 4, 5, 6, 7, 8, 9]
