"""Additive bilingual table format; legacy head/rows have no inferred language.

This validates stored structure, not PDF recognition or translation accuracy.
Spans and page segments are reserved for later reconstruction; phase A readers
fall back to the source PDF whenever either is present.
"""
from __future__ import annotations

import re

from .i18n import tr

MATRICES = ("head_en", "rows_en", "head_zh", "rows_zh")
FOOTNOTES = ("footnotes_en", "footnotes_zh")


def cell_ref(block: dict, key: str) -> dict | None:
    """A language-independent address. Never search other cells by quote."""
    match = re.fullmatch(re.escape(str(block.get("id", ""))) + r"#cell:(head|rows|note):(0|[1-9]\d*)(?::(0|[1-9]\d*))?", str(key or ""))
    if not match or block.get("type") != "table" or shape_problem(block) or not is_bilingual(block):
        return None
    section, row, col = match.group(1), int(match.group(2)), match.group(3)
    if block.get("table_status") not in (None, "", "ready") or block.get("table_spans") or block.get("table_segments"):
        return None
    try:
        if section == "note":
            if col is not None:
                return None
            en = block.get("footnotes_en", [])[row]
            zh = (block.get("footnotes_zh") or [])[row] if row < len(block.get("footnotes_zh", [])) else ""
        else:
            if col is None:
                return None
            col = int(col)
            en = block[f"{section}_en"][row][col]
            zh = block[f"{section}_zh"][row][col] if f"{section}_zh" in block else ""
    except (IndexError, KeyError, TypeError):
        return None
    return {"key": key, "section": section, "row": row, "col": col, "en": en, "zh": zh, "source": source_token(block)}


def source_token(block: dict) -> str:
    from .store import text_hash
    import json
    return text_hash(json.dumps([block.get("caption_en", ""), block.get("head_en", []), block.get("rows_en", []),
                                 block.get("footnotes_en", [])], ensure_ascii=False, separators=(",", ":")))


def context(block: dict, key: str = "", source: str = "", *, include_table: bool = True) -> str:
    """Evidence for chat: bilingual rows, headers, notes and precise selection."""
    import json
    label = f"Table {block.get('num', '')}; PDF page {block.get('page', '?')}; block {block.get('id', '')}"
    if not is_bilingual(block) or shape_problem(block) or block.get("table_status") not in (None, "", "ready") or block.get("table_spans") or block.get("table_segments"):
        return label + "\nUnverified table; inspect the original PDF.\n" + str(block.get("caption_en") or "")
    selected = cell_ref(block, key) if key else None
    if key and (not selected or source and source != selected["source"]):
        return label + "\nSelected cell is unavailable or its source changed; inspect the original PDF."
    parts = [label]
    if selected:
        parts.append("Selected cell: " + json.dumps(selected, ensure_ascii=False))
        if selected["section"] == "rows":
            row = selected["row"]
            parts.append("Selected row (English / Chinese): " + json.dumps([block["rows_en"][row],
                         (block.get("rows_zh") or [])[row] if "rows_zh" in block else []], ensure_ascii=False))
    if include_table:
        parts.append("Bilingual table (English source / Chinese translation):")
        for field in ("caption", "head", "rows", "footnotes"):
            parts.append(field + ": " + json.dumps({side: block.get(f"{field}_{side}", "" if field == "caption" else [])
                                                   for side in ("en", "zh")}, ensure_ascii=False))
    text = "\n".join(parts)
    return text if len(text) <= 16000 else text[:16000] + "\n[Table context truncated; inspect the PDF for remaining rows.]"

# Ordered, literal invariants. Group numerical expressions with their syntax,
# so a changed sign, exponent, interval, comparator or significance attachment
# cannot pass by merely retaining the same bag of digits.
_PROTECTED = re.compile(
    r"\$\$[\s\S]*?\$\$|\$[^$]*\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]"
    r"|https?://[^\s]+"
    r"|[\[(]\s*[-+−]?(?:\d*\.\d+|\d+)(?:[eE][-+−]?\d+)?%?\s*,\s*"
    r"[-+−]?(?:\d*\.\d+|\d+)(?:[eE][-+−]?\d+)?%?\s*[\])]"
    r"|(?<![A-Za-z])[A-Za-zα-ωΑ-Ω](?:[_^][A-Za-z0-9{}]+|[₀-₉⁰¹²³⁴⁵⁶⁷⁸⁹]+)?"
    r"(?:\s*[-+−*/=<>≤≥≠≈±]\s*(?:[A-Za-zα-ωΑ-Ω](?:[_^][A-Za-z0-9{}]+|[₀-₉⁰¹²³⁴⁵⁶⁷⁸⁹]+)?|"
    r"[-+−]?(?:\d*\.\d+|\d+)(?:[eE][-+−]?\d+)?%?))+(?![A-Za-z])"
    r"|(?<![A-Za-z])(?:[A-Za-z]|[α-ωΑ-Ω])(?:[_^][A-Za-z0-9{}]+)?\s*[=<>≤≥≠≈±]\s*"
    r"[-+−]?(?:\d*\.\d+|\d+)(?:[eE][-+−]?\d+)?%?"
    r"|[-+−]?(?:\d{1,3}(?:,\d{3})+|\d*\.\d+|\d+)(?:\.\d+)?(?:[eE][-+−]?\d+)?"
    r"(?:\s*[×x]\s*10\^?[-+−]?\d+)?[%‰]?[*†‡]*"
    r"|[A-Za-zα-ωΑ-Ω]+[_^](?:\{[^}]+\}|[A-Za-z0-9]+)"
    r"|[A-Za-zα-ωΑ-Ω][₀-₉⁰¹²³⁴⁵⁶⁷⁸⁹]+|[₀-₉⁰¹²³⁴⁵⁶⁷⁸⁹]+"
    r"|(?<![A-Za-z])[A-Za-z](?![A-Za-z])|[α-ωΑ-Ω]"
    r"|[()\[\]{}+−=<>≤≥≠≈±*/†‡∑∏√∞∈∝∂]+"
)


def protected(text: str) -> list[str]:
    return [m.group() for m in _PROTECTED.finditer(text)]


def translation_problem(block: dict) -> str | None:
    """Validate every source/translation pair after all text processing."""
    problem = shape_problem(block)
    if problem:
        return problem
    if not is_bilingual(block) or "head_zh" not in block or "rows_zh" not in block:
        return "Missing table translation"
    pairs = []
    for field in ("head", "rows"):
        for i, row in enumerate(block[f"{field}_en"]):
            for j, cell in enumerate(row):
                pairs.append((f"{field}[{i}][{j}]", cell, block[f"{field}_zh"][i][j]))
    pairs += [(f"footnotes[{i}]", note, zh) for i, (note, zh) in
              enumerate(zip(block.get("footnotes_en", []), block.get("footnotes_zh", [])))]
    if len(block.get("footnotes_en", [])) != len(block.get("footnotes_zh", [])):
        return "Missing table footnotes"
    if block.get("caption_en"):
        pairs.append(("caption", block["caption_en"], block.get("caption_zh", "")))
    for path, source, target in pairs:
        if not isinstance(target, str) or source.strip() and not target.strip():
            return f"Missing translation: {path}"
        if protected(source) != protected(target):
            return f"Table data changed: {path}"
        # Numeric/formula-only cells are byte-for-byte invariants, including
        # whitespace, decimal precision and the placement of standard errors.
        if not re.search(r"[A-Za-z]{2,}", _PROTECTED.sub("", source)) and source != target:
            return f"Table notation changed: {path}"
        if any(ord(c) < 32 and c not in "\n\t\r" for c in target):
            return f"Invalid control character: {path}"
    return None


def is_bilingual(block: dict) -> bool:
    return "table_schema" in block or any(key in block for key in MATRICES + FOOTNOTES)


def shape_problem(block: dict) -> str | None:
    if "table_reading" in block:
        from .table_reading import shape_problem as reading_problem
        issue = reading_problem(block)
        if issue:
            return issue
    if not is_bilingual(block):
        return None

    def problem(field):
        return tr("{id}：雙語表格資料格式有誤（{field}）", id=block.get("id"), field=field)

    if type(block.get("table_schema")) is not int or block["table_schema"] != 1:
        return problem("table_schema")
    for side in ("en", "zh"):
        fields = (f"head_{side}", f"rows_{side}")
        if side == "zh" and not any(key in block for key in fields):
            continue
        for field in fields:
            matrix = block.get(field)
            if not isinstance(matrix, list) or any(
                not isinstance(row, list) or not row or any(not isinstance(cell, str) for cell in row)
                for row in matrix
            ):
                return problem(field)
        rows = block[fields[0]] + block[fields[1]]
        if not block[fields[1]] or len({len(row) for row in rows}) != 1:
            return problem(fields[1])
    for field in FOOTNOTES:
        if field in block and (not isinstance(block[field], list) or
                               any(not isinstance(note, str) for note in block[field])):
            return problem(field)
    if "head_zh" in block:
        for field in ("head", "rows"):
            if [len(row) for row in block[f"{field}_en"]] != [len(row) for row in block[f"{field}_zh"]]:
                return problem(f"{field}_zh")
    if "footnotes_zh" in block and len(block["footnotes_zh"]) != len(block.get("footnotes_en", [])):
        return problem("footnotes_zh")
    for field in ("table_spans", "table_segments"):
        if field in block and (not isinstance(block[field], list) or
                               any(not isinstance(item, dict) for item in block[field])):
            return problem(field)
    for field in ("table_issue", "table_status"):
        if field in block and not isinstance(block[field], str):
            return problem(field)
    return None
