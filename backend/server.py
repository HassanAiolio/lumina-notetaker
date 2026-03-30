from fastapi import FastAPI, APIRouter, HTTPException, Query
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from fastapi.responses import JSONResponse
import os
import logging
import httpx
from pathlib import Path
from pydantic import BaseModel, ConfigDict
from typing import List, Optional
import uuid
import json as json_lib
from datetime import datetime, timezone

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

GEMINI_API_KEY = os.environ.get('GEMINI_API_KEY', '')
GEMINI_URL = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={GEMINI_API_KEY}"

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

app = FastAPI()
api_router = APIRouter(prefix="/api")


# ── Pydantic models ───────────────────────────────────────────────────────────

class NoteCreate(BaseModel):
    title: str
    raw_transcript: str
    summary: List[str] = []
    key_decisions: List[str] = []
    action_items: List[str] = []
    tags: List[str] = []
    sections: dict = {}
    type: str = ""

class NoteResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    title: str
    raw_transcript: str
    summary: List[str] = []
    key_decisions: List[str] = []
    action_items: List[str] = []
    tags: List[str] = []
    sections: dict = {}
    type: str = ""
    created_at: str

class SummarizeRequest(BaseModel):
    transcript: str

class SummarizeResponse(BaseModel):
    title: str
    type: str = ""
    sections: dict = {}

class TagUpdateRequest(BaseModel):
    tags: List[str]


# ── Helpers ───────────────────────────────────────────────────────────────────

async def call_gemini(prompt: str) -> str:
    # No response_schema — it forces a {title, type, sections} shape that
    # conflicts with the parser. Let Gemini return its natural flat JSON
    # and we reshape it in parse_ai_response.
    payload = {
        "contents": [
            {
                "parts": [{"text": prompt}]
            }
        ],
        "generationConfig": {
            "response_mime_type": "application/json"
        }
    }

    async with httpx.AsyncClient(timeout=30) as http:
        response = await http.post(GEMINI_URL, json=payload)

    if response.status_code != 200:
        logger.error(f"Gemini API error {response.status_code}: {response.text}")
        raise HTTPException(status_code=502, detail=f"Gemini API error: {response.status_code}")

    data = response.json()

    try:
        return data["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError):
        logger.error(f"Unexpected Gemini response shape: {data}")
        raise HTTPException(status_code=502, detail="Unexpected response from Gemini API")


def parse_ai_response(text: str) -> dict:
    """
    Gemini returns a flat JSON like:
      {"title": "...", "summary": [...], "key_decisions": [...], "action_items": [...]}

    We accept whatever shape it returns and build dynamic sections from it.
    Placeholder values like "No key decisions identified" are filtered out.
    """
    PLACEHOLDER_PHRASES = [
        "no key", "none identified", "no decisions", "no action",
        "not applicable", "n/a", "none", "no items"
    ]

    try:
        clean = text.strip()
        if clean.startswith("```"):
            clean = clean.split("```")[1]
            if clean.startswith("json"):
                clean = clean[4:]
        clean = clean.strip()

        parsed = json_lib.loads(clean)

        title = parsed.pop("title", "Untitled Note")
        content_type = parsed.pop("type", "")

        # Build sections from whatever list-valued keys remain
        sections = {}
        for k, v in parsed.items():
            if not isinstance(v, list) or len(v) == 0:
                continue
            # Filter out placeholder strings
            real_items = [
                item for item in v
                if isinstance(item, str) and not any(
                    phrase in item.lower() for phrase in PLACEHOLDER_PHRASES
                )
            ]
            if real_items:
                sections[k] = real_items

        # Infer content type from section names if Gemini didn't provide it
        if not content_type:
            keys = set(sections.keys())
            if keys & {"homework", "key_concepts", "overview", "important_details"}:
                content_type = "LECTURE"
            elif keys & {"action_items", "decisions", "follow_ups"}:
                content_type = "MEETING"
            else:
                content_type = "OTHER"

        logger.info(f"Parsed sections: {list(sections.keys())} | type: {content_type}")

        return {
            "title": title,
            "type": content_type,
            "sections": sections,
        }
    except Exception as e:
        logger.error(f"Failed to parse AI response: {e}\nRaw: {text}")
        return {"title": "Untitled Note", "type": "", "sections": {}}


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/api/health", response_class=JSONResponse)
async def health():
    return {"ok": True}

@app.head("/api/health")
async def health_head():
    # Return empty body, same headers as GET
    return JSONResponse(content=None)

@api_router.post("/notes/summarize", response_model=SummarizeResponse)
async def summarize_transcript(req: SummarizeRequest):
    if not req.transcript.strip():
        raise HTTPException(status_code=400, detail="Transcript cannot be empty")

    if not GEMINI_API_KEY:
        raise HTTPException(status_code=500, detail="GEMINI_API_KEY not configured in .env")

    prompt = f"""You are an expert note-taker. Analyze the transcript below and produce structured notes.

Detect the content type: MEETING, LECTURE, BRAINSTORM, INTERVIEW, or OTHER.

For a LECTURE produce these keys: overview, key_concepts, important_details, homework
For a MEETING produce these keys: summary, decisions, action_items, follow_ups
For a BRAINSTORM produce these keys: ideas, most_promising, next_steps
For OTHER produce these keys: summary, key_takeaways, action_items

Rules:
- Each key maps to an array of bullet point strings
- Always include "title" (string) and "type" (string)
- Be generous with bullets — extract specific names, numbers, dates, percentages
- If a section has no real content, omit it entirely
- Never write placeholder text like "No decisions identified"

Transcript:
{req.transcript}"""

    try:
        raw_response = await call_gemini(prompt)
        logger.info(f"Raw Gemini response: {raw_response}")
        parsed = parse_ai_response(raw_response)
        return SummarizeResponse(
            title=parsed["title"] or "Untitled Note",
            type=parsed.get("type", ""),
            sections=parsed.get("sections", {})
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Summarization error: {e}")
        raise HTTPException(status_code=500, detail=f"AI summarization failed: {str(e)}")


@api_router.post("/notes", response_model=NoteResponse)
async def create_note(note: NoteCreate):
    doc = {
        "id": str(uuid.uuid4()),
        "title": note.title,
        "raw_transcript": note.raw_transcript,
        "summary": note.summary,
        "key_decisions": note.key_decisions,
        "action_items": note.action_items,
        "tags": note.tags,
        "sections": note.sections,
        "type": note.type,
        "created_at": datetime.now(timezone.utc).isoformat()
    }
    await db.notes.insert_one(doc)
    return NoteResponse(**{k: v for k, v in doc.items() if k != "_id"})


@api_router.get("/notes", response_model=List[NoteResponse])
async def get_notes(
    search: Optional[str] = Query(None),
    tag: Optional[str] = Query(None)
):
    query = {}
    if search:
        query["$or"] = [
            {"title": {"$regex": search, "$options": "i"}},
            {"raw_transcript": {"$regex": search, "$options": "i"}}
        ]
    if tag:
        query["tags"] = tag

    notes = await db.notes.find(query, {"_id": 0}).sort("created_at", -1).to_list(100)
    return [NoteResponse(**n) for n in notes]


@api_router.get("/notes/{note_id}", response_model=NoteResponse)
async def get_note(note_id: str):
    note = await db.notes.find_one({"id": note_id}, {"_id": 0})
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    return NoteResponse(**note)


@api_router.delete("/notes/{note_id}")
async def delete_note(note_id: str):
    result = await db.notes.delete_one({"id": note_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Note not found")
    return {"message": "Note deleted"}


@api_router.patch("/notes/{note_id}/tags", response_model=NoteResponse)
async def update_tags(note_id: str, req: TagUpdateRequest):
    result = await db.notes.find_one_and_update(
        {"id": note_id},
        {"$set": {"tags": req.tags}},
        return_document=True
    )
    if not result:
        raise HTTPException(status_code=404, detail="Note not found")
    return NoteResponse(**{k: v for k, v in result.items() if k != "_id"})


@api_router.get("/tags", response_model=List[str])
async def get_all_tags():
    pipeline = [
        {"$unwind": "$tags"},
        {"$group": {"_id": "$tags"}},
        {"$sort": {"_id": 1}}
    ]
    tags = await db.notes.aggregate(pipeline).to_list(100)
    return [t["_id"] for t in tags]


# ── App setup ─────────────────────────────────────────────────────────────────

app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()