"""Languages the app speaks, plus a cheap offline detector for fallbacks."""
import re

# BCP-47 code -> (English name, native name, Web Speech locale)
LANGUAGES: dict[str, tuple[str, str, str]] = {
    "en": ("English", "English", "en-US"),
    "fr": ("French", "Français", "fr-FR"),
    "es": ("Spanish", "Español", "es-ES"),
    "de": ("German", "Deutsch", "de-DE"),
    "it": ("Italian", "Italiano", "it-IT"),
    "pt": ("Portuguese", "Português", "pt-PT"),
    "nl": ("Dutch", "Nederlands", "nl-NL"),
    "ar": ("Arabic", "العربية", "ar-SA"),
    "zh": ("Chinese", "中文", "zh-CN"),
    "ja": ("Japanese", "日本語", "ja-JP"),
    "ko": ("Korean", "한국어", "ko-KR"),
    "ru": ("Russian", "Русский", "ru-RU"),
    "hi": ("Hindi", "हिन्दी", "hi-IN"),
    "tr": ("Turkish", "Türkçe", "tr-TR"),
    "pl": ("Polish", "Polski", "pl-PL"),
    "sv": ("Swedish", "Svenska", "sv-SE"),
}

AUTO = "auto"


# Both spellings of every language we know, so a provider that reports a name
# instead of a code still lands on the right one.
_BY_NAME: dict[str, str] = {
    name.lower(): code
    for code, names in LANGUAGES.items()
    for name in names
}


def normalize(code: str | None) -> str:
    """Map anything a client or a model reports onto a code we know, or 'auto'.

    Not every source speaks BCP-47. Whisper reports a language by its English
    name ("french"), and a chat model asked for a code will sometimes answer
    with the name anyway, so both spellings are accepted - otherwise a
    perfectly good detection is thrown away and the text has to be sniffed.
    """
    if not code:
        return AUTO
    code = code.strip().lower().replace("_", "-")
    if code in (AUTO, ""):
        return AUTO
    base = code.split("-")[0]
    if base in LANGUAGES:
        return base
    return _BY_NAME.get(code, AUTO)


def english_name(code: str) -> str:
    entry = LANGUAGES.get(normalize(code))
    return entry[0] if entry else "the same language as the transcript"


def native_name(code: str) -> str:
    entry = LANGUAGES.get(normalize(code))
    return entry[1] if entry else code


# Stop words that are distinctive enough to separate these languages on a few
# sentences. Only used when the model could not tell us the language itself.
_MARKERS: dict[str, set[str]] = {
    "fr": {"le", "la", "les", "des", "une", "est", "que", "qui", "pour", "pas", "nous",
           "vous", "avec", "dans", "sur", "mais", "plus", "être", "faire", "donc", "cette"},
    "en": {"the", "and", "is", "are", "that", "this", "with", "for", "you", "have",
           "was", "will", "not", "they", "from", "what", "about", "would", "there"},
    "es": {"el", "la", "los", "las", "una", "que", "para", "con", "por", "pero",
           "como", "está", "son", "muy", "hay", "este", "todo", "porque"},
    "de": {"der", "die", "das", "und", "ist", "nicht", "mit", "auch", "für", "von",
           "sich", "ein", "eine", "aber", "wir", "wenn", "dass", "haben"},
    "it": {"il", "la", "che", "di", "per", "con", "non", "una", "sono", "come",
           "questo", "anche", "più", "essere", "della", "nella"},
    "pt": {"o", "a", "os", "as", "que", "para", "com", "não", "uma", "por",
           "mais", "como", "está", "muito", "isso", "também"},
    "nl": {"de", "het", "een", "en", "van", "is", "dat", "niet", "voor", "met",
           "ook", "maar", "worden", "zijn"},
}

_WORD_RE = re.compile(r"[^\W\d_]+", re.UNICODE)


def detect(text: str) -> str:
    """Rough language guess from stop words and script. Returns 'auto' if unsure."""
    if not text or not text.strip():
        return AUTO

    sample = text[:4000]

    # Scripts are unambiguous, so check them before the word statistics.
    for code, pattern in (
        # Kana before Han: Japanese mixes kanji with kana, so a Han-first check
        # would label every Japanese sentence as Chinese.
        ("ja", r"[\u3040-\u30ff]"),
        ("zh", r"[\u4e00-\u9fff]"),
        ("ko", r"[\uac00-\ud7af]"),
        ("ar", r"[\u0600-\u06ff]"),
        ("ru", r"[\u0400-\u04ff]"),
        ("hi", r"[\u0900-\u097f]"),
    ):
        if len(re.findall(pattern, sample)) >= 4:
            return code

    words = [w.lower() for w in _WORD_RE.findall(sample)]
    if len(words) < 8:
        return AUTO

    scores = {code: sum(1 for w in words if w in markers) for code, markers in _MARKERS.items()}
    best = max(scores, key=lambda c: scores[c])
    runner_up = sorted(scores.values())[-2] if len(scores) > 1 else 0

    # Demand a real margin: a couple of shared short words should not decide it.
    if scores[best] >= 3 and scores[best] > runner_up:
        return best
    return AUTO
