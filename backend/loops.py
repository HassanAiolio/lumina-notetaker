"""Collapse the repetition loops speech models fall into.

A model transcribing audio sometimes stops following the recording and emits
the same word or phrase until it runs out of output tokens: "des des des ..."
for thirty thousand characters. retranscribe.drop_loops catches the Whisper
kind, where a whole segment comes back again and again; this catches the kind
that happens inside one reply, a word or a short phrase at a time.

The damage goes past that one chunk. A loop has no sentence punctuation, so the
summarizer cannot cut it into windows, and a single window of it is refused by
every provider as too large - taking the real speech on either side with it.
"""
import re

# Longest phrase, in words, that is checked for back-to-back repeats.
MAX_PHRASE_WORDS = 8
# A run this long is the model stuck, not a speaker. People do say "c'est c'est"
# or "euh euh euh", so a short stutter is left exactly as transcribed.
MIN_RUN = 4
# Copies kept of a collapsed run, so the text still reads as spoken.
KEEP = 2

_NOT_WORD = re.compile(r"[^\w']+")


def collapse_repeats(text: str) -> tuple[str, int]:
    """Cut every phrase repeated MIN_RUN+ times in a row down to KEEP copies.

    Returns (text, words_removed). Words are compared without case or
    punctuation, so "des, des. Des" is one run. Only exact back-to-back
    repeats are removed; nothing is reordered or rewritten, and text with no
    loop in it comes back unchanged, whitespace and all.
    """
    words = text.split()
    if len(words) < MIN_RUN:
        return text, 0

    keys = [_NOT_WORD.sub("", word.lower()) for word in words]
    kept: list[str] = []
    removed = 0
    i = 0
    while i < len(words):
        skipped = 0
        for size in range(1, MAX_PHRASE_WORDS + 1):
            if i + size * MIN_RUN > len(words):
                break
            phrase = keys[i:i + size]
            if not any(phrase):
                continue  # punctuation on its own is not a phrase
            runs = 1
            while keys[i + runs * size:i + (runs + 1) * size] == phrase:
                runs += 1
            if runs >= MIN_RUN:
                kept.extend(words[i:i + size * KEEP])
                skipped = runs * size
                removed += (runs - KEEP) * size
                break
        if skipped:
            i += skipped
        else:
            kept.append(words[i])
            i += 1

    if not removed:
        return text, 0
    return " ".join(kept), removed
