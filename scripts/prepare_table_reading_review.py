"""Prepare persistent D1 -> D2 -> D2.5 Mock data for the desktop reader.

Run with the repository venv. No credentials, network, Vault, or production data.
Close the review reader before preparing its data.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import stat
import sys

ROOT = Path(__file__).resolve().parents[1]
PROFILE = ROOT / ".paperread-local-test" / "desktop-review"
PAPER_ID = "table-reading-review"
TITLE = "PaperRead Reading Table Review (Mock)"


def safe_path(path):
    """Only the fixed profile; reject redirects and hard links before access."""
    path = Path(os.path.abspath(path))
    if not path.is_relative_to(PROFILE):
        raise ValueError("Path must stay inside the desktop-review profile")
    for entry in (path, *path.parents):
        try:
            info = entry.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError("Review paths must not contain redirects")
        if stat.S_ISREG(info.st_mode) and info.st_nlink > 1:
            raise ValueError("Review files must not be hard-linked")
    return path


class LocalResponse:
    """Translate fixture labels only; pass masks through without interpreting data."""

    def __init__(self):
        self.calls = 0

    def __call__(self, cfg, prompt, cwd, images, cancel, meter):
        self.calls += 1
        labels = {"Variable": "變數", "Mean": "平均數", "SD": "標準差",
                  "Treatment": "處理組", "Control": "控制組"}
        data = json.loads(prompt.split("\n", 1)[1])
        segments = []
        for segment in data["segments"]:
            pieces = re.split(r"(\[\[READING\d+\]\])", segment["en"])
            for i in range(0, len(pieces), 2):
                # Unknown English is an error, never a request to a real model.
                pieces[i] = re.sub(r"[A-Za-z]+", lambda m: labels[m.group()], pieces[i])
            segments.append({"id": segment["id"], "zh": "".join(pieces)})
        return json.dumps({"segments": segments}, ensure_ascii=False)


def prepare(paper_id=PAPER_ID):
    if not re.fullmatch(r"table-reading-review(?:-[a-z0-9-]+)?", paper_id):
        raise ValueError("Only dedicated reading review paper IDs are allowed")
    room = safe_path(PROFILE / "library" / paper_id)
    # Check all existing files before libraries can read paper.json or write locks.
    if room.exists():
        for parent, dirs, files in os.walk(room, followlinks=False):
            for name in dirs + files:
                safe_path(Path(parent) / name)
    home = safe_path(PROFILE / "home")
    settings = safe_path(home / "config.json")
    os.environ.update(PAPERREAD_TEST_PROFILE=str(PROFILE), PAPERREAD_REVIEW_MODE="Mock",
                      PAPERREAD_REVIEW_KIND="Mock", PAPERREAD_OFFLINE_TEST="1",
                      EASYREAD_HOME=str(home), EASYREAD_LIBRARY=str(PROFILE / "library"))
    sys.path.insert(0, str(ROOT))
    from easyread import pdfwork, reader_data, table_extract, table_translate
    from easyread.store import Workspace, empty_discussion, empty_reader, write_json_atomic
    from tests.test_table_translation import make_table_pdf

    room.mkdir(parents=True, exist_ok=True)
    ws = Workspace(room)
    fresh = not ws.paper_path.exists()
    if fresh:
        if any(room.iterdir()):
            raise ValueError("Unrecognized review directory; refusing to overwrite it")
        make_table_pdf(ws.source_pdf, merged=True)
        pages = pdfwork.prepare(room)
        write_json_atomic(ws.paper_path, {
            "schema": 2, "meta": {"title_en": TITLE, "title_zh": "閱讀型表格翻譯隔離驗收（Mock）",
                "target": "zh-TW", "page_count": 1, "pages": pages,
                "source_sha256": table_translate.pdf_hash(ws), "reading_review_fixture": 1},
            "translation": {"done_pages": [1], "en_pages": [], "gaps_checked": True},
            "blocks": [], "references": [], "glossary": []})
    meta = ws.load("paper").get("meta", {})
    if (meta.get("reading_review_fixture") != 1 or meta.get("title_en") != TITLE or
            meta.get("source_pdf_path") or meta.get("source_sha256") != table_translate.pdf_hash(ws)):
        raise ValueError("Unrecognized or changed review source; refusing to overwrite it")

    # Demonstrate the actual structural rejection, not a patched recognizer.
    block = {"id": "table-p1-1", "type": "table", "page": 1,
             "num": "1", "caption_en": "Table 1: Statistics"}
    try:
        table_extract.recognize(ws, block)
    except table_extract.UnreliableTable as error:
        reason = str(error).split(": ", 1)[-1]
        if reason != "Merged or irregular cells":
            raise ValueError("Unexpected structural rejection: " + reason) from error
    else:
        raise ValueError("Fixture unexpectedly passed structured recognition")

    runner = LocalResponse()
    cfg = {"engine": "openai", "openai": {"model": "local-reading-fixture-v1"}}
    first = table_translate.translate_missing(ws, cfg, [1], run=runner, attempts=1)
    expected = "reading_translated" if fresh else "reading_cached"
    if first.get(expected) != 1 or first["failed"]:
        raise ValueError("Reading job failed: " + repr(first))
    calls = runner.calls
    if calls != (1 if fresh else 0):
        raise ValueError("Unexpected local response call count")
    saved = ws.load("paper")
    projected, _ = reader_data.reader_paper(ws)
    if (len(projected["blocks"]) != 1 or
            projected["blocks"][0].get("table_reading_zh") != saved["blocks"][0].get("table_reading_zh") or
            not projected["blocks"][0].get("table_reading_zh")):
        raise ValueError("D2.5 rejected reading content")
    second = table_translate.translate_missing(ws, cfg, [1], run=runner, attempts=1)
    if second.get("reading_cached") != 1 or second["failed"] or runner.calls != calls:
        raise ValueError("Second job did not reuse the verified reading cache")

    for name, value in (("reader", empty_reader()), ("discussion", empty_discussion()),
                        ("item", {"status": "reading"}), ("layout", {})):
        path = safe_path(room / f"{name}.json")
        if not path.exists():
            write_json_atomic(path, value)
    home.mkdir(parents=True, exist_ok=True)
    if not settings.exists():
        write_json_atomic(settings, {"engine": "none", "auto_translate": False,
                                    "check_updates": False, "library_dir": str(PROFILE / "library")})
    summary = {"paper": paper_id, "first": first, "second": second,
               "local_response_calls": runner.calls, "projection_verified": True}
    print(json.dumps(summary, ensure_ascii=True))
    print(f"Open: {TITLE} ({paper_id})")
    return summary


if __name__ == "__main__":
    prepare()
