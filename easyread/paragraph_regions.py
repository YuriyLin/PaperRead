"""Recover body words missing from a paragraph's approximate layout box.

Only long prose matches count: a shared axis label or isolated technical term
must not become a body-text mask. Word rectangles keep column gutters and
intervening graphics free, even when PDF extraction interleaves the columns.
"""
from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", unicodedata.normalize("NFKC", text).lower())


def matched_body_words(words: list[dict], paragraphs: list[str]) -> list[dict]:
    """Match original prose to complete PDF words, without guessing a tail box."""
    if not paragraphs or not words:
        return []
    stream, spans, offset = [], [], 0
    for word in words:
        text = _norm(word.get("text", ""))
        stream.append(text)
        spans.append((offset, offset + len(text)))
        offset += len(text)
    matcher = SequenceMatcher(None, "", "".join(stream), autojunk=False)
    selected = set()
    for paragraph in paragraphs:
        # TeX rarely has the same spelling/order as the rendered PDF glyphs.
        matcher.set_seq1(_norm(re.sub(r"\$[^$]*\$", " ", paragraph)))
        for match in matcher.get_matching_blocks():
            if match.size < 24:
                continue
            end = match.b + match.size
            whole = [i for i, (a, b) in enumerate(spans) if match.b <= a < b <= end]
            if len(whole) >= 3:
                selected.update(whole)
    return [word for i, word in enumerate(words) if i in selected]
