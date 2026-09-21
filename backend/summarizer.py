"""Turn a raw transcript into structured notes, in the transcript's own language."""
import logging
import re

import languages
from gemini import GeminiError, generate, parse_json_object

logger = logging.getLogger(__name__)

# Stable machine keys per content type. The model also returns a localized
# label for each key so the UI can show "Points cles" without us losing the
# key that everything else (filtering, export, old notes) is built on.
# A plan is a menu, not a checklist: the model is told to drop any section it
# has nothing real for, so a long list costs nothing when it does not apply.
# LECTURE is the richest because notes from a course are revised from later,
# where a meeting summary is mostly read once - a definition given in passing or
# an aside about what the exam covers is exactly what is worth keeping, and
# "important_details" on its own was too vague a bucket to catch either.
SECTION_PLANS: dict[str, list[str]] = {
    "MEETING": ["summary", "decisions", "action_items", "follow_ups"],
    "LECTURE": [
        "overview",
        "key_concepts",
        "definitions",
        "examples",
        "important_details",
        "exam_notes",
        "open_questions",
        "homework",
    ],
    "BRAINSTORM": ["ideas", "most_promising", "next_steps"],
    "INTERVIEW": ["summary", "key_points", "quotes", "follow_ups"],
    "OTHER": ["summary", "key_takeaways", "action_items"],
}

# What each type looks like, so a seminar full of discussion is not filed as a
# meeting just because people talked over each other.
TYPE_CUES: dict[str, str] = {
    "MEETING": "several people coordinating - decisions taken, work assigned, dates agreed",
    "LECTURE": "someone teaching or presenting material meant to be learned and revised later",
    "BRAINSTORM": "ideas being generated and weighed, with nothing settled yet",
    "INTERVIEW": "one side asking questions, the other answering at length",
    "OTHER": "anything else, including one person dictating notes to themselves",
}

ALL_KNOWN_KEYS = {key for plan in SECTION_PLANS.values() for key in plan}

# Models still slip in "No decisions identified" style filler even when told not
# to. A bullet matches here when it is a bare negation, a negation of one of the
# section nouns, or a negation closed by a word like "identified"/"mentionnee".
PLACEHOLDER_PATTERNS = re.compile(
    r"""^\s*(?:
        (?:none|n/?a|not\s+applicable|nothing|aucun[e]?|rien|keine?|nada|nessun[oa])[\s.]*$
      | (?:no|aucun[e]?|pas\s+de|kein[e]?|sin|ning[uú]n[oa]?)\s+
        (?:key\s+|specific\s+)?
        (?:decisions?|actions?|action\s+items?|items?|takeaways?|follow[\s-]?ups?|homework|
           notes?|concepts?|ideas?|points?|quotes?|definitions?|examples?|questions?|
           formulas?|formulae|d[eé]cisions?|t[aâ]ches?|d[eé]finitions?|exemples?|
           id[eé]es?|devoirs?|formules?|aufgaben|entscheidungen|beispiele?)
        [\s.]*$
      | (?:no|none|aucun[e]?|pas\s+de|kein[e]?|ning[uú]n[oa]?)\b[\w\s'’-]{0,45}?\s*
        (?:identified|mentioned|found|discussed|provided|required|specified|noted|available|
           identifi[eé]e?s?|mentionn[eé]e?s?|relev[eé]e?s?|signal[eé]e?s?|
           [eé]voqu[eé]e?s?|identificad[oa]s?|genannt|erw[aä]hnt)
        [\s.]*$
    )""",
    re.IGNORECASE | re.VERBOSE,
)

SYSTEM_INSTRUCTION = (
    "You are a meticulous multilingual note-taker. You always reply with a single "
    "JSON object and nothing else."
)

TRIPLE_QUOTE = '"""'


def _language_clause(language: str) -> str:
    if language == languages.AUTO:
        return (
            "Detect the language of the transcript. Write the title, every bullet "
            "and every section label in that same language - never translate."
        )
    name = languages.english_name(language)
    return (
        f"The transcript is in {name}. Write the title, every bullet and every "
        f"section label in {name} - never translate to another language."
    )


def build_prompt(transcript: str, language: str) -> str:
    cues = "\n".join(f"- {kind}: {cue}" for kind, cue in TYPE_CUES.items())
    plans = "\n".join(f"- {kind}: {', '.join(keys)}" for kind, keys in SECTION_PLANS.items())
    return f"""Analyse the transcript below and produce structured notes.

{_language_clause(language)}

Step 1 - classify the transcript as one of:
{cues}

Step 2 - use the section keys for that type, in the order listed:
{plans}

Return exactly this JSON shape:
{{
  "title": "a short, specific title for these notes",
  "type": "MEETING | LECTURE | BRAINSTORM | INTERVIEW | OTHER",
  "language": "the BCP-47 code of the language you wrote in, e.g. fr, en, es",
  "sections": {{ "<section_key>": ["bullet", "bullet"] }},
  "labels": {{ "<section_key>": "the section name written in the transcript language" }}
}}

Rules:
- Keep the section KEYS exactly as listed above, in English snake_case. Only the
  bullets, the title and the values in "labels" are in the transcript language.
- Be specific: keep names, numbers, dates, amounts and percentages. Write
  technical terms, symbols and formulas exactly as they were said.
- Write only what the transcript supports. Never add background knowledge, a
  definition or a conclusion that was not said. Where the transcript reads
  [inaudible] or is plainly garbled, leave that point out rather than guess at
  it.
- Scale the notes to the material: roughly one bullet per 200 to 400 words of
  transcript, spread over the sections that have content. An hour of teaching
  should leave someone enough to revise from, not a five-line abstract.
- Within a section, keep the order in which things came up.
- In a LECTURE, exam_notes holds only what the speaker actually flagged as
  assessed, examinable or important to remember, and open_questions only what
  was left unresolved or deferred. Leave both out if nothing was said.
- Omit a section entirely when it has no real content. Never emit filler such as
  "No decisions identified".
- Keep each bullet to one clear idea, with no leading dash or number.
- If the transcript is too short or unintelligible, still return valid JSON with
  whatever can honestly be extracted.

Transcript:
{TRIPLE_QUOTE}
{transcript}
{TRIPLE_QUOTE}"""


def _clean_bullets(raw: object) -> list[str]:
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list):
        return []

    cleaned: list[str] = []
    seen: set[str] = set()
    for item in raw:
        if isinstance(item, dict):
            # Some responses wrap bullets as {"text": ...} / {"item": ...}
            item = next(
                (item[k] for k in ("text", "item", "content", "value") if isinstance(item.get(k), str)),
                "",
            )
        if not isinstance(item, str):
            continue
        text = re.sub(r"^\s*(?:[-*•]|\d+[.)])\s*", "", item).strip()
        if not text or PLACEHOLDER_PATTERNS.match(text):
            continue
        key = text.lower()
        if key in seen:
            continue
        seen.add(key)
        cleaned.append(text)
    return cleaned


def _infer_type(section_keys: set[str]) -> str:
    best_type, best_overlap = "OTHER", 0
    for kind, plan in SECTION_PLANS.items():
        overlap = len(section_keys & set(plan))
        if overlap > best_overlap:
            best_type, best_overlap = kind, overlap
    return best_type


def normalize_result(parsed: dict, *, requested_language: str, transcript: str) -> dict:
    """Coerce whatever the model returned into the shape the API promises."""
    title = parsed.get("title")
    title = title.strip() if isinstance(title, str) and title.strip() else ""

    raw_sections = parsed.get("sections")
    if not isinstance(raw_sections, dict):
        # Older/looser responses put the sections at the top level.
        raw_sections = {
            k: v
            for k, v in parsed.items()
            if k not in {"title", "type", "language", "labels"} and isinstance(v, list)
        }

    sections: dict[str, list[str]] = {}
    for key, value in raw_sections.items():
        if not isinstance(key, str):
            continue
        bullets = _clean_bullets(value)
        if bullets:
            sections[re.sub(r"\s+", "_", key.strip().lower())] = bullets

    raw_labels = parsed.get("labels")
    labels = {}
    if isinstance(raw_labels, dict):
        labels = {
            re.sub(r"\s+", "_", str(k).strip().lower()): str(v).strip()
            for k, v in raw_labels.items()
            if isinstance(v, str) and v.strip() and re.sub(r"\s+", "_", str(k).strip().lower()) in sections
        }

    content_type = parsed.get("type")
    content_type = content_type.strip().upper() if isinstance(content_type, str) else ""
    if content_type not in SECTION_PLANS:
        content_type = _infer_type(set(sections))

    language = languages.normalize(parsed.get("language"))
    if language == languages.AUTO:
        if requested_language != languages.AUTO:
            language = requested_language
        else:
            bullet_text = " ".join(b for bullets in sections.values() for b in bullets)
            language = languages.detect(bullet_text or transcript)

    if not title:
        title = _fallback_title(transcript)

    return {
        "title": title[:200],
        "type": content_type,
        "language": language,
        "sections": sections,
        "labels": labels,
    }


# -- Offline fallback ---------------------------------------------------------

_SENTENCE_RE = re.compile(r"(?<=[.!?。！？])\s+|\n+")

# Verbs that usually mark a commitment, across the languages we support best.
_ACTION_HINTS = re.compile(
    r"\b(will|should|must|need to|let's|todo|to-do|action|deadline"
    r"|doit|doivent|il faut|va falloir|on va|je vais|nous allons|a faire|echeance"
    r"|debe|vamos a|hay que|tenemos que"
    r"|muss|mussen|wir werden|sollte)\b",
    re.IGNORECASE,
)


def _fallback_title(transcript: str) -> str:
    first = next((s.strip() for s in _SENTENCE_RE.split(transcript) if s.strip()), "")
    if not first:
        return "Untitled note"
    words = first.split()
    title = " ".join(words[:9])
    return (title + "…") if len(words) > 9 else title


_FALLBACK_LABELS: dict[str, dict[str, str]] = {
    "en": {"summary": "Summary", "action_items": "Action Items"},
    "fr": {"summary": "Résumé", "action_items": "Actions à mener"},
    "es": {"summary": "Resumen", "action_items": "Acciones"},
    "de": {"summary": "Zusammenfassung", "action_items": "Aufgaben"},
    "it": {"summary": "Riepilogo", "action_items": "Azioni"},
    "pt": {"summary": "Resumo", "action_items": "Ações"},
    "nl": {"summary": "Samenvatting", "action_items": "Acties"},
}


def fallback_summary(transcript: str, requested_language: str) -> dict:
    """Structure the transcript locally when every AI attempt failed.

    The result is deliberately modest - it is a safety net so a recording is
    never lost, not a replacement for the model.
    """
    sentences = [s.strip() for s in _SENTENCE_RE.split(transcript) if len(s.strip()) > 15]
    language = requested_language
    if language == languages.AUTO:
        language = languages.detect(transcript)

    actions = [s for s in sentences if _ACTION_HINTS.search(s)][:10]
    summary = [s for s in sentences if s not in actions][:8]
    if not summary and sentences:
        summary = sentences[:8]

    sections: dict[str, list[str]] = {}
    if summary:
        sections["summary"] = summary
    if actions:
        sections["action_items"] = actions

    labels = _FALLBACK_LABELS.get(language, _FALLBACK_LABELS["en"])
    return {
        "title": _fallback_title(transcript),
        "type": "OTHER",
        "language": language,
        "sections": sections,
        "labels": {k: v for k, v in labels.items() if k in sections},
        "degraded": True,
    }


# -- Entry point --------------------------------------------------------------

async def summarize(transcript: str, language: str = languages.AUTO) -> dict:
    """Structured notes for `transcript`.

    Always returns a usable result: if Gemini is unreachable or unparseable we
    fall back to a local extraction and flag the result as degraded.
    """
    language = languages.normalize(language)
    prompt = build_prompt(transcript, language)

    try:
        raw = await generate(
            [{"text": prompt}],
            json_output=True,
            system_instruction=SYSTEM_INSTRUCTION,
            temperature=0.25,
        )
    except GeminiError as exc:
        logger.error("Summarization fell back to local extraction: %s", exc)
        result = fallback_summary(transcript, language)
        result["degraded_reason"] = "quota" if exc.quota else "unavailable"
        return result

    parsed = parse_json_object(raw)
    if not parsed:
        logger.error("Summarization produced unparseable output, using local extraction")
        result = fallback_summary(transcript, language)
        result["degraded_reason"] = "unparseable"
        return result

    result = normalize_result(parsed, requested_language=language, transcript=transcript)
    if not result["sections"]:
        logger.warning("Model returned no usable sections, using local extraction")
        fallback = fallback_summary(transcript, language)
        fallback["title"] = result["title"] or fallback["title"]
        fallback["degraded_reason"] = "empty"
        return fallback

    result["degraded"] = False
    return result
