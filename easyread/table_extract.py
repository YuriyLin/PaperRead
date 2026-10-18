"""Conservative, local PDF table extraction. No model is used to invent structure.

Only single-page rectangular tables with a nearby Table caption are accepted.
Every visible glyph must belong to exactly one cell; merged cells and uncertain
headers are rejected. Footnotes and sources are kept as ordered source strings.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

from . import tables, table_policy

VERSION = 1
_CAPTION = re.compile(r"^Table\s+([A-Za-z]?\d+(?:[.\-]\d+)*)(?=$|\s|[:.\u2013\u2014])", re.I)
_NOTE = re.compile(r"^(?:(?:Notes?|Sources?)\s*[:.]|Standard errors?\b|\*|†|‡)", re.I)
_CONTINUED = re.compile(r"\bcontinu(?:ed|ation)\b", re.I)


class UnreliableTable(ValueError):
    pass


@dataclass
class PageTables:
    sources: list[dict]
    issues: list[str]
    unresolved: list[dict] = field(default_factory=list)


def caption_number(block):
    caption = block.get("caption_en")
    match = _CAPTION.match(caption) if isinstance(caption, str) else None
    return match.group(1) if match else ""


def _inside(char, box):
    x, y = (char["x0"] + char["x1"]) / 2, (char["top"] + char["bottom"]) / 2
    return box[0] <= x < box[2] and box[1] <= y < box[3]


def _lines(page):
    lines = []
    for word in sorted(page.extract_words(x_tolerance=2, y_tolerance=2), key=lambda w: (w["top"], w["x0"])):
        line = next((ln for ln in reversed(lines) if abs(ln["top"] - word["top"]) < 3), None)
        if line is None:
            line = {"top": word["top"], "bottom": word["bottom"], "words": []}
            lines.append(line)
        line["bottom"] = max(line["bottom"], word["bottom"])
        line["words"].append(word)
    for line in lines:
        line["words"].sort(key=lambda w: w["x0"])
        line["text"] = " ".join(w["text"] for w in line["words"])
    return sorted(lines, key=lambda ln: ln["top"])


def _matrix(page, table, method):
    if not table_policy.enabled():
        raise UnreliableTable(table_policy.DISABLED)
    rows = table.rows
    if len(rows) < 2 or len(rows[0].cells) < 2:
        raise UnreliableTable("Insufficient rows or columns")
    width = len(rows[0].cells)
    if any(len(row.cells) != width or any(cell is None for cell in row.cells) for row in rows):
        raise UnreliableTable("Merged or irregular cells")
    # A larger cell spanning other rows/columns must never be flattened.
    for row in rows:
        if any(abs(cell[1] - row.bbox[1]) > 1 or abs(cell[3] - row.bbox[3]) > 1 for cell in row.cells):
            raise UnreliableTable("Row spans")
        if any(abs(cell[0] - rows[0].cells[i][0]) > 1 or abs(cell[2] - rows[0].cells[i][2]) > 1
               for i, cell in enumerate(row.cells)):
            raise UnreliableTable("Column spans")
    chars = [c for c in page.chars if c["text"].strip() and _inside(c, table.bbox)]
    if method == "text" and any(c["text"].strip() and
                              _inside(c, (page.bbox[0], table.bbox[1], page.bbox[2], table.bbox[3])) and
                              not _inside(c, table.bbox) for c in page.chars):
        raise UnreliableTable("Borderless extraction may omit an outside column")
    cells = [cell for row in rows for cell in row.cells]
    if not chars or any(sum(_inside(c, cell) for cell in cells) != 1 for c in chars):
        raise UnreliableTable("Glyph coverage mismatch")
    if method == "text":
        # Implied grid lines must not turn intact source words into fragments.
        # Statistical digits and a caption alone also occur in ordinary prose.
        for word in page.extract_words(x_tolerance=2, y_tolerance=2):
            box = (word["x0"], word["top"], word["x1"], word["bottom"])
            owners = {i for c in chars if _inside(c, box)
                      for i, cell in enumerate(cells) if _inside(c, cell)}
            if len(owners) > 1:
                raise UnreliableTable("Borderless grid splits a source word")
    if any("\ufffd" in c["text"] or any(ord(ch) < 32 for ch in c["text"]) for c in chars):
        raise UnreliableTable("Unmapped PDF glyphs")
    extracted = table.extract(x_tolerance=2, y_tolerance=2)
    if len(extracted) != len(rows) or any(not isinstance(cell, str) for row in extracted for cell in row):
        raise UnreliableTable("Invalid extracted cells")
    physical_rows = [row for row, values in zip(rows, extracted) if any(cell and cell.strip() for cell in values)]
    matrix = extracted
    # text-strategy creates physical whitespace rows; only truly empty rows go.
    matrix = [row for row in matrix if any(cell.strip() for cell in row)]
    if len(matrix) < 2 or any(not isinstance(cell, str) for row in matrix for cell in row):
        raise UnreliableTable("Empty table")
    # Extraction must neither drop nor duplicate any non-whitespace glyph.
    from collections import Counter
    # Expand only Latin presentation ligatures for comparison, never cell data.
    # General compatibility normalization could also change numbers or units.
    ligatures = str.maketrans({"\ufb00": "ff", "\ufb01": "fi", "\ufb02": "fl",
                               "\ufb03": "ffi", "\ufb04": "ffl", "\ufb05": "st", "\ufb06": "st"})
    glyphs = Counter(ch for c in chars for ch in c["text"].translate(ligatures) if not ch.isspace())
    text = Counter(ch for row in matrix for cell in row for ch in cell.translate(ligatures) if not ch.isspace())
    if glyphs != text:
        raise UnreliableTable("Extracted text does not match source glyphs")
    if any(re.search(r"[\u3400-\u9fff]", c["text"]) for c in chars):
        raise UnreliableTable("Source is not an English table")
    # Superscripts and mixed math layout require visual reconstruction, not a
    # linear text heuristic. A single ambiguous cell rejects the entire table.
    for cell in cells:
        sizes = [c["size"] for c in chars if _inside(c, cell)]
        if sizes and max(sizes) > min(sizes) * 1.25:
            raise UnreliableTable("Superscript or mixed-size mathematical layout")
    bold = []
    for row in rows:
        rc = [c for c in chars if any(_inside(c, cell) for cell in row.cells)]
        if rc:
            bold.append(all(re.search(r"bold|black|demi", c.get("fontname", ""), re.I) for c in rc))
    header_count = 0
    for flag in bold:
        if not flag:
            break
        header_count += 1
    if not header_count:
        # Non-bold headers are accepted only when there is a clear transition
        # from textual headings to data containing numbers in value columns.
        for i, row in enumerate(matrix):
            if any(re.search(r"\d", c) for c in row[1:]):
                header_count = i
                break
    if not 0 < header_count < len(matrix):
        raise UnreliableTable("Header boundary is ambiguous")
    if method == "text" and (len(matrix) - header_count < 2 or any("\n" in c for row in matrix for c in row)):
        raise UnreliableTable("Insufficient borderless alignment evidence")
    if method == "text" and any(not any(re.search(r"\d", c) for c in row) for row in matrix[header_count:]):
        raise UnreliableTable("Borderless rows lack statistical alignment evidence")
    return matrix[:header_count], matrix[header_count:], physical_rows


def _bounded_box(page, box):
    """Intersect in PDF coordinates; never round or assume a zero origin."""
    if (len(box) != 4 or not all(math.isfinite(n) for n in box) or
            box[0] >= box[2] or box[1] >= box[3]):
        raise UnreliableTable("Invalid PDF crop region")
    bounds = page.bbox
    box = (max(bounds[0], box[0]), max(bounds[1], box[1]),
           min(bounds[2], box[2]), min(bounds[3], box[3]))
    if box[0] >= box[2] or box[1] >= box[3]:
        raise UnreliableTable("Empty PDF crop region")
    return box


def _crop(page, box):
    box = _bounded_box(page, box)
    return page if box == tuple(page.bbox) else page.crop(box)


def _visible_page(page):
    # pdfplumber otherwise includes hidden text outside CropBox, unlike the
    # page image shown to the reader. Partial glyphs need visual verification.
    if tuple(page.bbox) != tuple(page.cropbox):
        box = _bounded_box(page, page.cropbox)
        if any(_inside(c, box) and (c["x0"] < box[0] or c["x1"] > box[2] or c["top"] < box[1] or c["bottom"] > box[3])
               for c in page.chars):
            raise UnreliableTable("Partially cropped table glyphs require PDF review")
        page = _crop(page, box)
    return page


def extract_page(page, number: int) -> PageTables:
    """Use pdfplumber's actual cell geometry, never model-supplied rows."""
    if not table_policy.enabled():
        return PageTables([], [table_policy.DISABLED])
    try:
        page = _visible_page(page)
    except ValueError as exc:
        return PageTables([], [str(exc)])
    lines = _lines(page)
    # "Table 1 contains ..." in body prose is a reference, not a caption.
    # Without punctuation or bold label evidence, leave it to PDF review.
    def caption_line(line):
        match = _CAPTION.match(line["text"])
        if not match:
            return False
        if line["text"][match.end():].lstrip().startswith((".", ":", "\u2013", "\u2014")):
            return True
        label_chars = [c for c in page.chars if line["top"] - 1 <= c["top"] <= line["bottom"] and c["x0"] <= line["words"][1]["x1"]]
        return bool(label_chars) and all(re.search(r"bold|black|demi", c.get("fontname", ""), re.I) for c in label_chars)
    captions = []
    for index, line in enumerate(lines):
        match = _CAPTION.match(line["text"])
        if match and not line["text"][match.end():].strip():
            # A bare label needs a nearby, aligned title, even if it is bold.
            # Do not let wrapped body references become caption candidates.
            if index + 1 >= len(lines):
                continue
            title = lines[index + 1]
            height = line["bottom"] - line["top"]
            left, right = line["words"][0]["x0"], line["words"][-1]["x1"]
            tl, tr = title["words"][0]["x0"], title["words"][-1]["x1"]
            text = title["text"]
            if (not 0 <= title["top"] - line["bottom"] <= min(12, height) or
                    not (abs(left - tl) <= 6 or abs((left + right) - (tl + tr)) <= 12) or
                    len(text.split()) < 2 or not re.match(r"[A-Z]", text) or
                    text.endswith((".", ":", ";", "?", "!")) or
                    _CAPTION.match(text) or _NOTE.match(text) or
                    re.match(r"(?:shows?|provides?|presents?|contains?|reports?|summarizes?|"
                             r"illustrates?|lists?|compares?|is|are|was|were|and|for|in|of|the)\b", text, re.I)):
                continue
            line = {**line, "text": line["text"] + " " + text,
                    "bottom": title["bottom"], "words": line["words"] + title["words"]}
        elif not caption_line(line):
            continue
        captions.append((line, match))
    found, issues, unresolved = [], [], []
    ruled = page.find_tables()
    for caption, match in captions:
        num = match.group(1)
        try:
            if _CONTINUED.search(caption["text"]):
                raise UnreliableTable("Continued table requires cross-page evidence")
            # Search only below the caption, stopping before notes / next
            # caption. Caption-below tables intentionally retain the PDF.
            end = min([ln["top"] for ln in lines if ln["top"] > caption["bottom"] + 2 and
                       (_NOTE.match(ln["text"]) or _CAPTION.match(ln["text"]))] + [page.bbox[3] - 18])
            candidates = [t for t in ruled if 0 <= t.bbox[1] - caption["bottom"] < 40 and t.bbox[3] <= end + 2]
            method = "lines"
            if not candidates:
                if any(0 <= t.bbox[1] - caption["bottom"] < 40 for t in ruled):
                    raise UnreliableTable("Table and footnote boundaries overlap")
                method = "text"
                if end - caption["bottom"] < 20:
                    raise UnreliableTable("No table below caption")
                area = _crop(page, (page.bbox[0], caption["bottom"] + 2, page.bbox[2], end))
                candidates = [t for t in area.find_tables({"vertical_strategy": "text", "horizontal_strategy": "text",
                                                         "min_words_vertical": 3, "text_x_tolerance": 2,
                                                         "text_y_tolerance": 2})
                              if 0 <= t.bbox[1] - caption["bottom"] < 40]
            if len(candidates) != 1:
                raise UnreliableTable("Missing or ambiguous table geometry")
            table = candidates[0]
            head, rows, physical_rows = _matrix(page, table, method)
            if table.bbox[3] >= page.bbox[3] - 30:
                raise UnreliableTable("Table touches page boundary")
            # A caption may wrap above the table. Reject prose between the
            # caption and table instead of silently discarding it.
            extra = [ln for ln in lines if caption["bottom"] < ln["top"] < table.bbox[1] - 2]
            if len(extra) > 2:
                raise UnreliableTable("Caption boundary is ambiguous")
            cap = " ".join([caption["text"], *(ln["text"] for ln in extra)])
            notes, note_boxes, last, note_size = [], [], table.bbox[3], None
            below = [ln for ln in lines if ln["top"] >= table.bbox[3] - 1]
            for ln in below:
                if ln["top"] - last > 18 or _CAPTION.match(ln["text"]):
                    break
                note_chars = [c for c in page.chars if c["text"].strip() and ln["top"] - 1 <= c["top"] <= ln["bottom"]]
                size = min((c["size"] for c in note_chars), default=0)
                if _NOTE.match(ln["text"]):
                    notes.append(ln["text"])
                    note_boxes.append([min(w["x0"] for w in ln["words"]), ln["top"], max(w["x1"] for w in ln["words"]), ln["bottom"]])
                    note_size = size
                elif notes and ln["top"] - last < 7 and note_size and abs(size - note_size) <= note_size * 0.05:
                    notes[-1] += " " + ln["text"]
                    note_boxes[-1] = [min(note_boxes[-1][0], min(w["x0"] for w in ln["words"])), note_boxes[-1][1],
                                      max(note_boxes[-1][2], max(w["x1"] for w in ln["words"])), ln["bottom"]]
                elif not notes:
                    raise UnreliableTable("Text below the table may contain unmarked footnotes")
                else:
                    break
                if note_chars and max(c["size"] for c in note_chars) > min(c["size"] for c in note_chars) * 1.25:
                    raise UnreliableTable("Footnotes contain mixed-size mathematical layout")
                last = ln["bottom"]
            block = {"type": "table", "page": number, "num": num, "table_schema": 1,
                     "caption_en": cap, "caption_pos": "above", "head_en": head, "rows_en": rows,
                     "footnotes_en": notes, "table_status": "ready",
                     "table_source_box": [round((table.bbox[i] - page.bbox[i % 2]) /
                                          (page.width if i % 2 == 0 else page.height), 6) for i in range(4)],
                     "table_evidence": {"extractor": VERSION, "method": method, "glyphs_verified": True}}
            def location(box):
                return {"page": number, "box": [round((box[i] - page.bbox[i % 2]) /
                                                     (page.width if i % 2 == 0 else page.height), 6) for i in range(4)]}
            block["table_cell_boxes"] = {}
            for i, row in enumerate(physical_rows):
                section, index = ("head", i) if i < len(head) else ("rows", i - len(head))
                for col, box in enumerate(row.cells):
                    block["table_cell_boxes"][f"{section}:{index}:{col}"] = location(box)
            for i, box in enumerate(note_boxes):
                block["table_cell_boxes"][f"note:{i}"] = location(box)
            block["table_geometry_source"] = tables.source_token(block)
            if tables.shape_problem(block):
                raise UnreliableTable("Invalid rectangular structure")
            found.append(block)
        except (UnreliableTable, ValueError) as exc:
            issues.append(f"Table {num}: {exc}")
            unresolved.append({"type": "table", "page": number, "num": num, "caption_en": caption["text"],
                               "caption_pos": "above", "table_status": "fallback", "table_issue": str(exc)})
    return PageTables(found, issues, unresolved)


def recognize(ws, block: dict) -> dict:
    """Match one existing table by its original caption number, without using
    legacy matrices as English evidence. Raises on zero or multiple matches.
    """
    if not table_policy.enabled():
        raise UnreliableTable(table_policy.DISABLED)
    import pdfplumber
    page = block.get("page")
    if not isinstance(block.get("caption_en", ""), str):
        raise UnreliableTable("Invalid source caption")
    num = str(block.get("num") or caption_number(block))
    if block.get("num") and caption_number(block) and str(block["num"]).casefold() != caption_number(block).casefold():
        raise UnreliableTable("Stored table number conflicts with its source caption")
    if type(page) is not int or page < 1 or block.get("table_spans") or block.get("table_segments"):
        raise UnreliableTable("Merged, cross-page or missing source page")
    with pdfplumber.open(ws.source_pdf) as pdf:
        if page > len(pdf.pages):
            raise UnreliableTable("Source page does not exist")
        result = extract_page(pdf.pages[page - 1], page)
        if page < len(pdf.pages) and re.search(r"Table\s+" + re.escape(num) + r"\b[^\n]{0,100}\bcontinued\b",
                                              pdf.pages[page].extract_text() or "", re.I):
            raise UnreliableTable("Table continues on the following page")
    candidates = [b for b in result.sources if b["num"].casefold() == num.casefold()]
    if len(candidates) != 1:
        raise UnreliableTable("; ".join(result.issues) or "Caption does not uniquely identify a source table")
    return candidates[0]
