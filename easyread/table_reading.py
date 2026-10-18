"""D1 reading evidence only: no cells, translation, or automatic fallback jobs.

Coordinates are normalized to the visible PDF page. Stored shape validation is
not source verification; consumers must call verify_source against the PDF.
"""
from __future__ import annotations

import hashlib
import json
import math
import re

from . import table_policy


def _hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(",", ":")).encode()).hexdigest()


def _box(value):
    return (isinstance(value, list) and len(value) == 4 and
            all(type(n) in (int, float) and math.isfinite(n) and 0 <= n <= 1 for n in value) and
            value[0] < value[2] and value[1] < value[3])


def _contains(outer, inner):
    return outer[0] <= inner[0] < inner[2] <= outer[2] and outer[1] <= inner[1] < inner[3] <= outer[3]


def shape_problem(block):
    r = block.get("table_reading")
    bad = "Invalid table_reading source evidence"
    if not isinstance(r, dict) or set(r) != {"version", "status", "source", "source_hash"}:
        return bad
    if type(r["version"]) is not int or r["version"] != 1 or r["status"] != "source_verified":
        return bad
    s = r["source"]
    if not isinstance(s, dict) or set(s) != {"page", "box", "segments", "pdf_sha256", "num", "caption_en"}:
        return bad
    if (block.get("type") != "table" or type(s["page"]) is not int or s["page"] < 1 or
            s["page"] != block.get("page") or s["num"] != block.get("num") or
            s["caption_en"] != block.get("caption_en") or not isinstance(s["caption_en"], str) or
            not isinstance(s["num"], str) or not s["num"] or not _box(s["box"]) or
            not isinstance(s["pdf_sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", s["pdf_sha256"])):
        return bad
    if not isinstance(s["segments"], list) or not s["segments"]:
        return bad
    ids = set()
    for seg in s["segments"]:
        if (not isinstance(seg, dict) or set(seg) != {"id", "en", "box"} or
                not isinstance(seg["en"], str) or not seg["en"].strip() or
                not _box(seg["box"]) or not _contains(s["box"], seg["box"])):
            return bad
        expected = "s-" + _hash([seg["en"], seg["box"]])
        if seg["id"] != expected or expected in ids:
            return bad
        ids.add(expected)
    if r["source_hash"] != _hash(s):
        return bad
    return None


def _extract(page, block, digest):
    from .table_extract import _CAPTION, _CONTINUED, _NOTE, _lines, _crop, _visible_page, UnreliableTable
    if not table_policy.enabled():
        raise UnreliableTable(table_policy.DISABLED)

    def reject():
        raise UnreliableTable("Reading source region or glyph ownership is ambiguous")

    if block.get("table_spans") or block.get("table_segments"):
        reject()
    page = _visible_page(page)
    lines = _lines(page)
    captions = [l for l in lines if (m := _CAPTION.match(l["text"])) and m.group(1) == block.get("num")]
    if len(captions) != 1 or captions[0]["text"] != block.get("caption_en"):
        reject()
    cap = captions[0]
    match = _CAPTION.match(cap["text"])
    # Follow the extractor's explicit-caption requirement, never body prose.
    label = cap["text"][match.end():].lstrip()
    if _CONTINUED.search(cap["text"]) or not label.startswith((".", ":", "\u2013", "\u2014")):
        reject()
    end = min([l["top"] for l in lines if l["top"] > cap["bottom"] + 2 and
               (_NOTE.match(l["text"]) or _CAPTION.match(l["text"]))] + [page.bbox[3] - 18])
    nearby = [t for t in page.find_tables() if 0 <= t.bbox[1] - cap["bottom"] < 40]
    if any(t.bbox[3] > end for t in nearby):
        reject()
    candidates = nearby
    if not candidates:
        candidates = _crop(page, (page.bbox[0], cap["bottom"] + 2, page.bbox[2], end)).find_tables(
            {"vertical_strategy": "text", "horizontal_strategy": "text", "min_words_vertical": 3,
             "text_x_tolerance": 2, "text_y_tolerance": 2})
        candidates = [t for t in candidates if 0 <= t.bbox[1] - cap["bottom"] < 40]
    if len(candidates) != 1:
        reject()
    box = candidates[0].bbox
    if box[3] >= page.bbox[3] - 30:
        reject()
    chars = [c for c in page.chars if c["text"].strip() and c["top"] < box[3] and c["bottom"] > box[1]]
    if not chars or any(not (box[0] <= c["x0"] < c["x1"] <= box[2] and
                            box[1] <= c["top"] < c["bottom"] <= box[3]) for c in chars):
        reject()
    # D1 accepts plain, uniformly sized source text only. Math and unusual
    # encodings stay in the PDF; no visual/OCR guess is made here.
    if (any(any(ord(ch) < 32 or ord(ch) > 126 for ch in c["text"]) or
            re.search(r"symbol|math", c.get("fontname", ""), re.I) for c in chars) or
            max(c["size"] for c in chars) > min(c["size"] for c in chars) * 1.05):
        reject()
    def norm(b):
        return [(b[0]-page.bbox[0])/page.width, (b[1]-page.bbox[1])/page.height,
                (b[2]-page.bbox[0])/page.width, (b[3]-page.bbox[1])/page.height]
    segments = []
    selected = []
    for line in lines:
        if box[1] <= line["top"] and line["bottom"] <= box[3]:
            if re.search(r"[$\\_^=<>+*/{}]", line["text"]):
                reject()
            words = line["words"]
            b = norm([min(w["x0"] for w in words), line["top"], max(w["x1"] for w in words), line["bottom"]])
            seg = {"en": line["text"], "box": b}
            seg["id"] = "s-" + _hash([seg["en"], b])
            segments.append(seg)
            selected.extend(c for c in chars if line["top"] <= c["top"] and c["bottom"] <= line["bottom"])
    from collections import Counter
    if (Counter(map(id, selected)) != Counter(map(id, chars)) or
            Counter(ch for s in segments for ch in s["en"] if not ch.isspace()) !=
            Counter(ch for c in chars for ch in c["text"] if not ch.isspace())):
        reject()
    source = {"page": block["page"], "num": block["num"], "caption_en": block["caption_en"],
              "box": norm(box), "segments": segments, "pdf_sha256": digest}
    result = {"version": 1, "status": "source_verified", "source": source, "source_hash": _hash(source)}
    if shape_problem({**block, "table_reading": result}):
        reject()
    return result


def recognize_source(ws, block):
    """Read one immutable PDF snapshot; return evidence without modifying block."""
    import io
    import pdfplumber
    from .table_extract import UnreliableTable
    if not table_policy.enabled():
        raise UnreliableTable(table_policy.DISABLED)
    data = ws.source_pdf.read_bytes()
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        page = block.get("page")
        if type(page) is not int or not 1 <= page <= len(pdf.pages):
            raise UnreliableTable("Invalid reading source page")
        if page < len(pdf.pages) and re.search(
                r"Table\s+" + re.escape(str(block.get("num", ""))) + r"\b[^\n]{0,100}\bcontinued\b",
                pdf.pages[page].extract_text() or "", re.I):
            raise UnreliableTable("Reading table continues on the following page")
        return _extract(pdf.pages[page - 1], block, hashlib.sha256(data).hexdigest())


def verify_source(ws, block):
    """Reject stale/tampered evidence, including a recomputed stored hash."""
    from .table_extract import UnreliableTable
    if shape_problem(block) or recognize_source(ws, block) != block["table_reading"]:
        raise UnreliableTable("Reading source changed or is invalid")
