"""Versioned per-page selectable text, independent of legacy layout caches."""
from __future__ import annotations

from contextlib import closing
from pathlib import Path
import threading

from pypdfium2 import raw

from .pdfwork import open_pdf, _char_box
from .store import write_json_atomic

_LOCK = threading.Lock()


def page_file(root: Path, source: Path, number: int) -> Path:
    stat = source.stat()
    cache = root / "extract" / f"select-v2-{number:03d}.json"
    stamp = root / "extract" / f"select-v2-{number:03d}.stamp"
    identity = f"{source.resolve()}:{stat.st_size}:{stat.st_mtime_ns}"
    with _LOCK:
        if cache.exists() and stamp.exists() and stamp.read_text(encoding="utf-8") == identity:
            return cache
        with open_pdf(source) as doc:
            if not 1 <= number <= len(doc):
                raise ValueError("Invalid PDF page")
            with closing(doc[number - 1]) as page, closing(page.get_textpage()) as text:
                bounds, rotation = page.get_bbox(), page.get_rotation()
                rows, visible = [], False
                for index in range(text.count_chars()):
                    code = raw.FPDFText_GetUnicode(text, index)
                    if 0xD800 <= code <= 0xDBFF and index + 1 < text.count_chars():
                        low = raw.FPDFText_GetUnicode(text, index + 1)
                        if 0xDC00 <= low <= 0xDFFF:
                            code = 0x10000 + ((code - 0xD800) << 10) + low - 0xDC00
                    if not code or code > 0x10FFFF or 0xD800 <= code <= 0xDFFF:
                        continue
                    char = chr(code)
                    if char.isspace():
                        # PDFium synthesizes spaces/newlines without a glyph box.
                        # Keep them as text, not positioned selectable glyphs.
                        if visible:
                            rows.append([char, 0, 0, 0, 0])
                        continue
                    box = _char_box(text.get_charbox(index, loose=True), bounds, rotation)
                    visible = box is not None
                    if visible:
                        rows.append([char, *box])
        cache.parent.mkdir(parents=True, exist_ok=True)
        write_json_atomic(cache, rows)
        stamp.write_text(identity, encoding="utf-8")
        return cache
