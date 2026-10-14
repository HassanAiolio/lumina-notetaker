"""API tests with an in-memory stand-in for MongoDB.

The point of these is the ownership boundary: one account must never be able to
read, change or delete another account's notes.
"""
import asyncio
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent))

import db as db_module  # noqa: E402
import jobs  # noqa: E402
import ratelimit  # noqa: E402
import server  # noqa: E402
from auth import User, current_user, hash_api_token, reading_user  # noqa: E402


# ── A very small async Mongo stand-in ─────────────────────────────────────────

def _matches(doc: dict, query: dict) -> bool:
    for key, condition in query.items():
        if key == "$or":
            if not any(_matches(doc, sub) for sub in condition):
                return False
            continue
        value = doc.get(key)
        if isinstance(condition, dict):
            if "$regex" in condition:
                import re

                flags = re.IGNORECASE if "i" in condition.get("$options", "") else 0
                haystack = value if isinstance(value, str) else " ".join(map(str, value or []))
                if not re.search(condition["$regex"], haystack, flags):
                    return False
            if "$exists" in condition and (key in doc) != condition["$exists"]:
                return False
        elif isinstance(value, list):
            if condition not in value:
                return False
        elif value != condition:
            return False
    return True


class FakeCursor:
    def __init__(self, docs, keep_id=False):
        self._docs = docs
        # Aggregations put their grouping key in _id, so it must survive there.
        self._keep_id = keep_id

    def _clean(self, doc):
        return doc if self._keep_id else {k: v for k, v in doc.items() if k != "_id"}

    def sort(self, field, direction=1):
        self._docs = sorted(
            self._docs, key=lambda d: d.get(field) or "", reverse=direction == -1
        )
        return self

    def skip(self, count):
        self._docs = self._docs[count:]
        return self

    def limit(self, count):
        self._docs = self._docs[:count]
        return self

    def __aiter__(self):
        async def generator():
            for doc in self._docs:
                yield self._clean(doc)

        return generator()

    async def to_list(self, length=None):
        return [self._clean(doc) for doc in self._docs[:length]]


class FakeCollection:
    def __init__(self):
        self.docs: list[dict] = []

    async def create_index(self, *args, **kwargs):
        return "index"

    async def insert_one(self, doc):
        self.docs.append(dict(doc))
        return type("Result", (), {"inserted_id": doc.get("id")})()

    async def find_one(self, query, projection=None):
        for doc in self.docs:
            if _matches(doc, query):
                return {k: v for k, v in doc.items() if k != "_id"}
        return None

    def find(self, query, projection=None):
        hidden = {k for k, v in (projection or {}).items() if v == 0 and k != "_id"}
        docs = [{k: v for k, v in d.items() if k not in hidden} for d in self.docs if _matches(d, query)]
        return FakeCursor(docs)

    async def count_documents(self, query):
        return len([d for d in self.docs if _matches(d, query)])

    async def delete_one(self, query):
        for index, doc in enumerate(self.docs):
            if _matches(doc, query):
                self.docs.pop(index)
                return type("Result", (), {"deleted_count": 1})()
        return type("Result", (), {"deleted_count": 0})()

    async def find_one_and_update(self, query, update, projection=None, return_document=None):
        for doc in self.docs:
            if _matches(doc, query):
                doc.update(update.get("$set", {}))
                return {k: v for k, v in doc.items() if k != "_id"}
        return None

    async def delete_many(self, query):
        before = len(self.docs)
        self.docs = [d for d in self.docs if not _matches(d, query)]
        return type("Result", (), {"deleted_count": before - len(self.docs)})()

    async def update_one(self, query, update, upsert=False):
        for doc in self.docs:
            if _matches(doc, query):
                doc.update(update.get("$set", {}))
                return type("Result", (), {"modified_count": 1})()
        if upsert:
            new = {**update.get("$setOnInsert", {}), **update.get("$set", {})}
            self.docs.append(new)
        return type("Result", (), {"modified_count": 0})()

    def aggregate(self, pipeline):
        docs = self.docs
        for stage in pipeline:
            if "$match" in stage:
                docs = [d for d in docs if _matches(d, stage["$match"])]
            elif "$unwind" in stage:
                field = stage["$unwind"].lstrip("$")
                docs = [{**d, field: value} for d in docs for value in d.get(field, [])]
            elif "$group" in stage:
                field = stage["$group"]["_id"].lstrip("$")
                docs = [{"_id": value} for value in sorted({d.get(field) for d in docs})]
            elif "$sort" in stage:
                docs = sorted(docs, key=lambda d: d.get("_id") or "")
            elif "$limit" in stage:
                docs = docs[: stage["$limit"]]
        return FakeCursor(docs, keep_id=True)


class FakeDatabase:
    def __init__(self):
        self.notes = FakeCollection()
        self.users = FakeCollection()
        self.slide_pages = FakeCollection()
        self.api_tokens = FakeCollection()


# ── Fixtures ──────────────────────────────────────────────────────────────────

ALICE = User(id="user-alice", email="alice@example.com", name="Alice")
BOB = User(id="user-bob", email="bob@example.com", name="Bob")


@pytest.fixture
def fake_db(monkeypatch):
    database = FakeDatabase()
    monkeypatch.setattr(db_module, "get_db", lambda: database)
    monkeypatch.setattr(server.db, "get_db", lambda: database)
    ratelimit.reset()
    jobs.reset()
    return database


@pytest.fixture
def client(fake_db):
    as_user(ALICE)
    with TestClient(server.app) as test_client:
        yield test_client
    server.app.dependency_overrides.clear()


def as_user(user):
    server.app.dependency_overrides[current_user] = lambda: user
    server.app.dependency_overrides[reading_user] = lambda: user


def with_token(token):
    """From here on, requests are checked for real, carrying this token."""
    server.app.dependency_overrides.clear()
    return {"Authorization": f"Bearer {token}"}


def make_token(client, name="Claude"):
    response = client.post("/api/tokens", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


def make_note(client, **overrides):
    payload = {
        "title": "Sprint review",
        "raw_transcript": "We discussed the roadmap and the budget.",
        "sections": {"summary": ["Roadmap agreed"]},
        "labels": {"summary": "Summary"},
        "tags": ["work"],
        "type": "MEETING",
        "language": "en",
        **overrides,
    }
    response = client.post("/api/notes", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


# ── Public surface ────────────────────────────────────────────────────────────

def test_health_is_always_200(client):
    body = client.get("/api/health").json()
    assert body["ok"] is True
    assert "database" in body and "ai" in body


def test_config_lists_languages_including_french(client):
    body = client.get("/api/config").json()
    codes = {entry["code"] for entry in body["languages"]}
    assert {"fr", "en", "es", "de"} <= codes
    french = next(entry for entry in body["languages"] if entry["code"] == "fr")
    assert french["locale"] == "fr-FR"


def test_unauthenticated_requests_are_rejected():
    server.app.dependency_overrides.clear()
    with TestClient(server.app) as anonymous:
        for method, path in [
            ("get", "/api/notes"),
            ("get", "/api/tags"),
            ("get", "/api/auth/me"),
            ("get", "/api/notes/whatever"),
            ("delete", "/api/notes/whatever"),
        ]:
            assert getattr(anonymous, method)(path).status_code == 401, path
        assert anonymous.post(
            "/api/notes/summarize", json={"transcript": "hello"}
        ).status_code == 401


# ── Notes CRUD ────────────────────────────────────────────────────────────────

def test_create_and_read_back(client):
    created = make_note(client)
    assert created["id"]
    assert created["raw_transcript"].startswith("We discussed")
    assert created["labels"]["summary"] == "Summary"

    fetched = client.get(f"/api/notes/{created['id']}").json()
    assert fetched["id"] == created["id"]
    # The transcript is stored alongside the summary, not discarded.
    assert fetched["raw_transcript"] == created["raw_transcript"]


def test_list_is_paginated(client):
    for index in range(5):
        make_note(client, title=f"Note {index}")
    page = client.get("/api/notes", params={"limit": 2}).json()
    assert page["total"] == 5
    assert len(page["items"]) == 2
    second = client.get("/api/notes", params={"limit": 2, "offset": 2}).json()
    assert {n["id"] for n in second["items"]}.isdisjoint({n["id"] for n in page["items"]})


def test_search_and_tag_filter(client):
    make_note(client, title="Budget meeting", tags=["finance"], raw_transcript="Numbers for Q3.")
    make_note(client, title="Design review", tags=["design"], raw_transcript="Colours and spacing.")

    found = client.get("/api/notes", params={"search": "Budget"}).json()
    assert [n["title"] for n in found["items"]] == ["Budget meeting"]

    tagged = client.get("/api/notes", params={"tag": "design"}).json()
    assert [n["title"] for n in tagged["items"]] == ["Design review"]


def test_search_matches_the_transcript_not_just_the_title(client):
    make_note(client, title="Monday sync", raw_transcript="Marie will call the supplier.")
    found = client.get("/api/notes", params={"search": "supplier"}).json()
    assert [n["title"] for n in found["items"]] == ["Monday sync"]


def test_search_with_regex_metacharacters_is_safe(client):
    make_note(client, title="Q3 (draft)", raw_transcript="quarterly planning")
    response = client.get("/api/notes", params={"search": "Q3 (draft)"})
    assert response.status_code == 200
    assert response.json()["total"] == 1


def test_update_and_delete(client):
    note = make_note(client)
    updated = client.patch(f"/api/notes/{note['id']}", json={"title": "Renamed"}).json()
    assert updated["title"] == "Renamed"
    assert updated["updated_at"]

    assert client.delete(f"/api/notes/{note['id']}").status_code == 200
    assert client.get(f"/api/notes/{note['id']}").status_code == 404


def test_tags_are_normalized_and_listed(client):
    make_note(client, tags=["Work", "work", " PROJET "])
    assert client.get("/api/tags").json() == ["projet", "work"]


# ── Ownership: the part that must not regress ─────────────────────────────────

def test_notes_are_private_to_their_owner(client):
    alice_note = make_note(client, title="Alice private")

    as_user(BOB)
    assert client.get("/api/notes").json()["total"] == 0
    assert client.get("/api/tags").json() == []
    assert client.get(f"/api/notes/{alice_note['id']}").status_code == 404
    assert client.delete(f"/api/notes/{alice_note['id']}").status_code == 404
    assert client.patch(f"/api/notes/{alice_note['id']}", json={"title": "Hacked"}).status_code == 404

    as_user(ALICE)
    assert client.get(f"/api/notes/{alice_note['id']}").json()["title"] == "Alice private"


def test_each_account_sees_only_its_own_notes(client):
    make_note(client, title="Alice one")
    as_user(BOB)
    make_note(client, title="Bob one")

    bob_page = client.get("/api/notes").json()
    assert [n["title"] for n in bob_page["items"]] == ["Bob one"]

    as_user(ALICE)
    alice_page = client.get("/api/notes").json()
    assert [n["title"] for n in alice_page["items"]] == ["Alice one"]


# ── Validation ────────────────────────────────────────────────────────────────

def test_summarize_rejects_empty_transcript(client):
    assert client.post("/api/notes/summarize", json={"transcript": "   "}).status_code == 422


def test_patch_with_nothing_to_change_is_rejected(client):
    note = make_note(client)
    assert client.patch(f"/api/notes/{note['id']}", json={}).status_code == 400


def test_paused_database_reports_503_not_500(client, fake_db, monkeypatch):
    """A free-tier cluster asleep after idling should say so, not "went wrong"."""
    from pymongo.errors import ServerSelectionTimeoutError

    def explode(*args, **kwargs):
        raise ServerSelectionTimeoutError("cluster is paused")

    monkeypatch.setattr(fake_db.notes, "count_documents", explode)

    response = client.get("/api/notes")
    assert response.status_code == 503
    assert "waking up" in response.json()["detail"]
    assert response.headers.get("Retry-After") == "30"


def test_limit_is_capped(client):
    assert client.get("/api/notes", params={"limit": 5000}).status_code == 422


# ── Listing for the library view ──────────────────────────────────────────────

def test_brief_listing_leaves_out_the_transcript(client):
    note = make_note(client, raw_transcript="Deux heures de cours " * 50)
    full = client.get("/api/notes").json()["items"][0]
    brief = client.get("/api/notes", params={"brief": "true"}).json()["items"][0]
    assert full["raw_transcript"]
    assert brief["raw_transcript"] == ""
    assert brief["sections"] == full["sections"]  # previews still have what they need
    # Opening the note still gets everything.
    assert client.get(f"/api/notes/{note['id']}").json()["raw_transcript"]


def test_notes_can_be_filtered_by_type(client):
    make_note(client, title="Cours", type="LECTURE")
    make_note(client, title="Point", type="MEETING")
    page = client.get("/api/notes", params={"type": "lecture"}).json()
    assert [n["title"] for n in page["items"]] == ["Cours"]


def test_a_blank_rename_is_ignored(client):
    note = make_note(client, title="Thermodynamique")
    assert client.patch(f"/api/notes/{note['id']}", json={"title": "   "}).status_code == 400
    renamed = client.patch(f"/api/notes/{note['id']}", json={"title": "  Thermo, cours 3 "}).json()
    assert renamed["title"] == "Thermo, cours 3"


# ── Slides kept with a note ───────────────────────────────────────────────────

JPEG = b"\xff\xd8\xff\xe0" + b"0" * 2000


def test_a_note_keeps_the_pictures_of_the_pages_it_cites(client):
    note = make_note(client, slides={"name": "Cours 3.pdf", "pages": 40, "cited": [12, 3, 12], "hash": "abc"})
    assert note["slides"] == {"name": "Cours 3.pdf", "pages": 40, "cited": [3, 12], "hash": "abc"}

    put = client.put(f"/api/notes/{note['id']}/slides/12", content=JPEG, headers={"Content-Type": "image/jpeg"})
    assert put.status_code == 204
    got = client.get(f"/api/notes/{note['id']}/slides/12")
    assert got.status_code == 200
    assert got.content == JPEG
    assert got.headers["content-type"] == "image/jpeg"
    assert "immutable" in got.headers["cache-control"]
    assert client.get(f"/api/notes/{note['id']}/slides/13").status_code == 404


def test_slide_pictures_are_private_to_the_note_owner(client):
    note = make_note(client)
    client.put(f"/api/notes/{note['id']}/slides/1", content=JPEG, headers={"Content-Type": "image/jpeg"})

    as_user(BOB)
    assert client.get(f"/api/notes/{note['id']}/slides/1").status_code == 404
    assert client.put(
        f"/api/notes/{note['id']}/slides/2", content=JPEG, headers={"Content-Type": "image/jpeg"}
    ).status_code == 404


def test_only_images_of_a_sensible_size_are_kept(client):
    note = make_note(client)
    url = f"/api/notes/{note['id']}/slides/1"
    assert client.put(url, content=b"<svg/>", headers={"Content-Type": "image/svg+xml"}).status_code == 400
    big = b"0" * (server.settings.MAX_SLIDE_IMAGE_BYTES + 1)
    assert client.put(url, content=big, headers={"Content-Type": "image/jpeg"}).status_code == 413


def test_deleting_a_note_deletes_its_slide_pictures(client, fake_db):
    note = make_note(client)
    client.put(f"/api/notes/{note['id']}/slides/1", content=JPEG, headers={"Content-Type": "image/jpeg"})
    assert len(fake_db.slide_pages.docs) == 1
    client.delete(f"/api/notes/{note['id']}")
    assert fake_db.slide_pages.docs == []


def test_summarize_hands_the_slides_on(client, monkeypatch):
    seen = {}

    async def fake_summarize(transcript, language, slides=None):
        seen["slides"] = slides
        return {"title": "T", "type": "LECTURE", "language": "fr", "sections": {}, "labels": {}}

    monkeypatch.setattr(server.summarizer, "summarize", fake_summarize)
    response = client.post("/api/notes/summarize", json={
        "transcript": "Un cours.", "language": "fr",
        "slides": [{"page": 1, "text": "  Titre   du cours "}, {"page": 2, "text": ""}],
    })
    assert response.status_code == 200
    assert seen["slides"] == [{"page": 1, "text": "Titre du cours"}]  # blank pages dropped, text tidied


def test_regenerated_notes_rewrite_the_same_note(client):
    note = make_note(client)
    changes = {"sections": {"overview": ["Nouveau"]}, "type": "LECTURE", "language": "fr", "degraded": False,
               "raw_transcript": "Texte revu", "slides": {"name": "c.pdf", "pages": 3, "cited": [2]}}
    updated = client.patch(f"/api/notes/{note['id']}", json=changes).json()
    assert updated["sections"] == {"overview": ["Nouveau"]}
    assert updated["raw_transcript"] == "Texte revu"
    assert updated["slides"]["cited"] == [2]
    assert client.get("/api/notes").json()["total"] == 1


# ── Personal API tokens ───────────────────────────────────────────────────────

def test_an_api_token_is_shown_once_and_kept_only_as_a_hash(client, fake_db):
    created = make_token(client)
    assert created["token"].startswith("lum_")
    assert created["prefix"] == created["token"][:10]

    stored = fake_db.api_tokens.docs[0]
    assert stored["hash"] == hash_api_token(created["token"])
    assert created["token"] not in stored.values()

    listed = client.get("/api/tokens").json()
    assert [entry["id"] for entry in listed] == [created["id"]]
    assert "token" not in listed[0] and "hash" not in listed[0]


def test_an_api_token_reads_its_owners_notes_and_nothing_else(client, fake_db):
    mine = make_note(client, title="Mine")
    as_user(BOB)
    theirs = make_note(client, title="Theirs", tags=["private"])
    as_user(ALICE)
    token = make_token(client)["token"]

    headers = with_token(token)
    listing = client.get("/api/notes", headers=headers)
    assert listing.status_code == 200
    assert [note["title"] for note in listing.json()["items"]] == ["Mine"]
    assert client.get(f"/api/notes/{mine['id']}", headers=headers).status_code == 200
    assert client.get(f"/api/notes/{theirs['id']}", headers=headers).status_code == 404
    assert client.get("/api/tags", headers=headers).json() == ["work"]
    assert fake_db.api_tokens.docs[0]["last_used_at"]


def test_an_api_token_cannot_change_anything(client):
    note = make_note(client)
    token = make_token(client)
    headers = with_token(token["token"])

    for method, path, body in [
        ("post", "/api/notes", {"title": "x"}),
        ("patch", f"/api/notes/{note['id']}", {"title": "x"}),
        ("delete", f"/api/notes/{note['id']}", None),
        ("post", "/api/notes/summarize", {"transcript": "hello"}),
        ("post", "/api/tokens", {"name": "another"}),
        ("get", "/api/tokens", None),
        ("delete", f"/api/tokens/{token['id']}", None),
        ("get", "/api/auth/me", None),
    ]:
        kwargs = {"headers": headers, **({"json": body} if body is not None else {})}
        response = client.request(method.upper(), path, **kwargs)
        assert response.status_code == 403, (method, path, response.text)
        assert "read-only" in response.json()["detail"]


def test_a_revoked_or_unknown_token_is_refused(client):
    token = make_token(client)
    assert client.delete(f"/api/tokens/{token['id']}").status_code == 200
    assert client.get("/api/tokens").json() == []

    headers = with_token(token["token"])
    assert client.get("/api/notes", headers=headers).status_code == 401
    assert client.get("/api/notes", headers={"Authorization": "Bearer lum_nonsense"}).status_code == 401


def test_tokens_are_private_to_their_owner(client):
    token = make_token(client)
    as_user(BOB)
    assert client.get("/api/tokens").json() == []
    assert client.delete(f"/api/tokens/{token['id']}").status_code == 404


def test_tokens_need_a_name_and_are_capped(client, monkeypatch):
    assert client.post("/api/tokens", json={"name": "   "}).status_code == 422
    monkeypatch.setattr(server.settings, "MAX_API_TOKENS", 2)
    make_token(client, "one")
    make_token(client, "two")
    response = client.post("/api/tokens", json={"name": "three"})
    assert response.status_code == 400
    assert "Revoke one" in response.json()["detail"]


# ── Notes written as a background job ─────────────────────────────────────────

NOTES = {"title": "Cours 2", "type": "LECTURE", "language": "fr", "sections": {"overview": ["Descente de gradient"]}}


def wait_for_job(client, job_id, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        body = client.get(f"/api/notes/summarize/jobs/{job_id}").json()
        if body["status"] != "running":
            return body
        time.sleep(0.02)
    raise AssertionError("the job never finished")


def test_notes_are_written_in_the_background_and_collected(client, monkeypatch):
    seen = {}

    async def fake_summarize(transcript, language, slides=None, report=None):
        seen.update(transcript=transcript, slides=slides)
        report("writing", 1, 4)
        return NOTES

    monkeypatch.setattr(server.summarizer, "summarize", fake_summarize)
    started = client.post("/api/notes/summarize/jobs", json={
        "transcript": "Bonjour", "language": "fr", "slides": [{"page": 2, "text": "Gradient"}],
    })
    assert started.status_code == 202
    assert started.json()["status"] == "running"

    done = wait_for_job(client, started.json()["id"])
    assert done["status"] == "done"
    assert done["progress"] == {"stage": "writing", "done": 1, "total": 4}
    assert done["result"]["title"] == "Cours 2"
    assert done["result"]["sections"]["overview"] == ["Descente de gradient"]
    assert done["result"]["degraded"] is False
    assert seen == {"transcript": "Bonjour", "slides": [{"page": 2, "text": "Gradient"}]}


def test_a_job_belongs_to_whoever_started_it(client, monkeypatch):
    async def fake_summarize(transcript, language, slides=None, report=None):
        return NOTES

    monkeypatch.setattr(server.summarizer, "summarize", fake_summarize)
    job_id = client.post("/api/notes/summarize/jobs", json={"transcript": "Bonjour"}).json()["id"]
    wait_for_job(client, job_id)

    as_user(BOB)
    assert client.get(f"/api/notes/summarize/jobs/{job_id}").status_code == 404
    response = client.get("/api/notes/summarize/jobs/no-such-job")
    assert response.status_code == 404
    assert "restarted" in response.json()["detail"]


def test_a_failed_job_says_so_instead_of_hanging(client, monkeypatch):
    async def broken(transcript, language, slides=None, report=None):
        raise RuntimeError("boom")

    monkeypatch.setattr(server.summarizer, "summarize", broken)
    job_id = client.post("/api/notes/summarize/jobs", json={"transcript": "Bonjour"}).json()["id"]
    failed = wait_for_job(client, job_id)
    assert failed["status"] == "failed"
    assert "try again" in failed["error"]
    assert "boom" not in failed["error"]


def test_a_job_past_its_deadline_is_stopped(client, monkeypatch):
    async def endless(transcript, language, slides=None, report=None):
        await asyncio.sleep(60)

    monkeypatch.setattr(server.summarizer, "summarize", endless)
    monkeypatch.setattr(jobs.settings, "SUMMARY_JOB_DEADLINE", 0.05)
    job_id = client.post("/api/notes/summarize/jobs", json={"transcript": "Bonjour"}).json()["id"]
    stopped = wait_for_job(client, job_id)
    assert stopped["status"] == "failed"
    assert "took longer" in stopped["error"]


def test_one_person_cannot_pile_up_jobs(client, monkeypatch):
    async def endless(transcript, language, slides=None, report=None):
        await asyncio.sleep(60)

    monkeypatch.setattr(server.summarizer, "summarize", endless)
    monkeypatch.setattr(server.settings, "MAX_SUMMARY_JOBS", 1)
    assert client.post("/api/notes/summarize/jobs", json={"transcript": "Un"}).status_code == 202
    second = client.post("/api/notes/summarize/jobs", json={"transcript": "Deux"})
    assert second.status_code == 429
    assert "already being written" in second.json()["detail"]
    as_user(BOB)
    assert client.post("/api/notes/summarize/jobs", json={"transcript": "Trois"}).status_code == 202
