"""API tests with an in-memory stand-in for MongoDB.

The point of these is the ownership boundary: one account must never be able to
read, change or delete another account's notes.
"""
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent))

import db as db_module  # noqa: E402
import ratelimit  # noqa: E402
import server  # noqa: E402
from auth import User, current_user  # noqa: E402


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
        return FakeCursor([d for d in self.docs if _matches(d, query)])

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


# ── Fixtures ──────────────────────────────────────────────────────────────────

ALICE = User(id="user-alice", email="alice@example.com", name="Alice")
BOB = User(id="user-bob", email="bob@example.com", name="Bob")


@pytest.fixture
def fake_db(monkeypatch):
    database = FakeDatabase()
    monkeypatch.setattr(db_module, "get_db", lambda: database)
    monkeypatch.setattr(server.db, "get_db", lambda: database)
    ratelimit.reset()
    return database


@pytest.fixture
def client(fake_db):
    server.app.dependency_overrides[current_user] = lambda: ALICE
    with TestClient(server.app) as test_client:
        yield test_client
    server.app.dependency_overrides.clear()


def as_user(user):
    server.app.dependency_overrides[current_user] = lambda: user


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
