"""Read-only reader projection. Never expose unverified reading translations.

Hash the actual PDF on every projection, but reuse successful geometry checks
for identical PDF bytes and identical source evidence. No stored flag grants
access. The bounded in-memory cache contains verification keys, not paper data.
"""
from __future__ import annotations

import copy
from collections import OrderedDict
from threading import Lock

from . import table_reading, table_translate, table_policy

_verified = OrderedDict()
_lock = Lock()
_LIMIT = 64
_FIELDS = ("table_reading", "table_reading_zh", "table_reading_cache", "table_reading_preview")
_previews = OrderedDict()


def _digest(ws):
    return table_translate.pdf_hash(ws)


def reader_paper(ws, paper=None):
    """Return (safe independent paper copy, content version) for every reader.

    A version reflects the sanitized output, so changing just the source PDF
    revokes previously visible translations through the existing polling route.
    Failures hide optional evidence only; saved matrices and caches are intact.
    """
    result = copy.deepcopy(ws.load("paper") if paper is None else paper)
    if not isinstance(result, dict):
        return result, table_translate._hash(result)
    blocks = [b for b in result.get("blocks", []) if isinstance(b, dict) and
              b.get("type") == "table" and any(k in b for k in _FIELDS)]
    if not blocks:
        return result, table_translate._hash(result)
    if not table_policy.enabled():
        # Preserve saved data, legacy matrices and notes. Only hide optional
        # evidence in this read-only projection; no digest/parser/cache lookup.
        for block in blocks:
            for field in _FIELDS:
                block.pop(field, None)
        return result, table_translate._hash(result)
    try:
        digest = _digest(ws)
    except (OSError, ValueError):
        digest = None
    for block in blocks:
        # Caller/stored image data never grants access to a preview.
        block.pop("table_reading_preview", None)
        try:
            if digest is None or table_reading.shape_problem(block):
                raise ValueError("Reading evidence unavailable")
            reading = block["table_reading"]
            if reading["source"]["pdf_sha256"] != digest:
                raise ValueError("Reading PDF changed")
            # Include all identity fields consulted by the source recognizer.
            key = table_translate._hash({"pdf": digest, "reading": reading,
                "identity": {k: block.get(k) for k in
                             ("type", "page", "num", "caption_en", "table_spans", "table_segments")}})
            with _lock:
                hit = key in _verified
            if not hit:
                table_reading.verify_source(ws, block)
                if _digest(ws) != digest:
                    raise ValueError("PDF changed during verification")
                with _lock:
                    _verified[key] = True
                    _verified.move_to_end(key)
                    while len(_verified) > _LIMIT:
                        _verified.popitem(last=False)
            values = block.get("table_reading_zh")
            table_translate._reading_values(reading, values)
            cache = block.get("table_reading_cache")
            if (not isinstance(cache, dict) or type(cache.get("version")) is not int or
                    cache["version"] != table_translate.READING_VERSION or cache.get("target") != "zh-TW" or
                    cache.get("translation_hash") != table_translate._hash(values)):
                raise ValueError("Reading translation cache invalid")
            if block.get("table_status") == "fallback":
                from . import pdfwork
                import hashlib
                with _lock:
                    preview = _previews.get(key)
                if preview is None:
                    snapshot = ws.source_pdf.read_bytes()
                    if hashlib.sha256(snapshot).hexdigest() != digest:
                        raise ValueError("PDF changed before rendering")
                    preview = pdfwork.reading_preview(snapshot, reading["source"]["page"], reading["source"]["box"])
                    with _lock:
                        _previews[key] = preview
                        _previews.move_to_end(key)
                        while len(_previews) > 8:
                            _previews.popitem(last=False)
                block["table_reading_preview"] = preview
        except Exception:  # Malformed PDFs/evidence must not break the reader.
            for field in _FIELDS:
                block.pop(field, None)
    # Also protects cache hits and multiple-block projections against a source
    # replacement while this response is being assembled.
    try:
        unchanged = digest is not None and _digest(ws) == digest
    except (OSError, ValueError):
        unchanged = False
    if not unchanged:
        for block in blocks:
            for field in _FIELDS:
                block.pop(field, None)
    return result, table_translate._hash(result)
