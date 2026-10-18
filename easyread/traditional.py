"""Traditional translation normalization and reversible migration of legacy Chinese papers."""
from __future__ import annotations

import copy
from .i18n import _tw_converter
from .store import dir_lock, text_hash, write_json_atomic


def convert(text):
    return _tw_converter().convert(text) if isinstance(text, str) else text


def normalize(data: dict) -> None:
    """Convert authored translation fields only; never touch English, TeX, IDs or source hashes."""
    def walk(value):
        if isinstance(value, dict):
            original = value.get("zh")
            for key, child in list(value.items()):
                if key in ("zh", "caption_zh", "title_zh", "short_zh") and isinstance(child, str):
                    value[key] = convert(child)
                elif key == "zh" and isinstance(child, dict):
                    value[key] = {k: convert(v) if isinstance(v, str) else v for k, v in child.items()}
                else:
                    walk(child)
            if isinstance(original, str) and original != value.get("zh"):
                # Phrase conversion may change UTF-16 sentence offsets. Recompute
                # each existing boundary from the original prefix.
                for pair in value.get("sents", []):
                    prefix = original.encode("utf-16-le")[:pair[1] * 2].decode("utf-16-le")
                    pair[1] = len(convert(prefix).encode("utf-16-le")) // 2
            if value.get("type") == "table":
                # Legacy matrices have no reliable language label. Neither
                # migration nor normalization may reinterpret or rewrite them.
                for field in ("head_zh", "rows_zh"):
                    if field not in value:
                        continue
                    value[field] = [[convert(cell) for cell in row] for row in value.get(field, [])]
                if "footnotes_zh" in value:
                    value["footnotes_zh"] = [convert(note) for note in value["footnotes_zh"]]
        elif isinstance(value, list):
            for child in value: walk(child)
    walk(data)


def _translations(paper: dict) -> dict:
    result = {}
    for block in paper.get("blocks", []):
        bid = block.get("id", "")
        result[bid] = block.get("zh") or block.get("en") or ""
        result[bid + "#caption"] = block.get("caption_zh") or block.get("caption_en") or ""
        for i, item in enumerate(block.get("items", [])):
            result[f"{bid}#{i}"] = item.get("zh") or item.get("en") or ""
    return result


def migrate(ws) -> bool:
    """Preserve both originals before converting translator text and quote anchors.

    Handwritten note bodies and user translation edits remain byte-for-byte text.
    Existing stale edit bases remain stale; current bases follow the conversion.
    """
    with dir_lock(ws.root):
        paper = ws.load("paper") or {}
        meta = paper.get("meta") or {}
        if meta.get("target") not in (None, "zh") or meta.get("paperread_traditional_v"):
            return False
        if not any(b.get("zh") or b.get("caption_zh") for b in paper.get("blocks", [])):
            return False
        reader = ws.load("reader")
        originals = _translations(paper)
        history = ws.root / "history" / "before-paperread-zh-TW"
        history.mkdir(parents=True, exist_ok=True)
        for name in ("paper", "reader"):
            source = ws.root / f"{name}.json"
            backup = history / source.name
            if source.exists() and not backup.exists():
                backup.write_bytes(source.read_bytes())
        normalize(paper)
        paper.setdefault("meta", {}).update(target="zh-TW", paperread_traditional_v=1)
        converted = _translations(paper)
        for key, edit in reader.get("edits", {}).items():
            if edit.get("base") == text_hash(originals.get(key, "")):
                edit["base"] = text_hash(converted.get(key, ""))
        for note in reader.get("notes", {}).values():
            if note.get("quote") and note.get("side") != "en" and not reader.get("edits", {}).get(note.get("key") or note.get("anchor"), {}).get("zh"):
                note["quote"] = convert(note["quote"])
        write_json_atomic(ws.paper_path, paper)
        write_json_atomic(ws.reader_path, reader)
        return True
