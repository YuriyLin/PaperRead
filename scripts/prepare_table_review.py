"""Create deterministic mock desktop review data, only below the ignored test root."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
PROFILE = ROOT / ".paperread-local-test" / "desktop-review"
if not PROFILE.resolve().is_relative_to((ROOT / ".paperread-local-test").resolve()):
    raise SystemExit("Review profile escapes the isolated test directory")
os.environ.update(EASYREAD_HOME=str(PROFILE / "home"), EASYREAD_LIBRARY=str(PROFILE / "library"), PAPERREAD_OFFLINE_TEST="1")
sys.path.insert(0, str(ROOT))

import pdfplumber
from easyread import pdfwork, table_extract
from easyread.store import empty_reader, empty_discussion, write_json_atomic
from tests.test_table_translation import make_table_pdf


def prepare():
    room = PROFILE / "library" / "table-review"
    room.mkdir(parents=True, exist_ok=True)
    make_table_pdf(room / "source.pdf")
    pages = pdfwork.prepare(room)
    with pdfplumber.open(room / "source.pdf") as pdf:
        block = table_extract.extract_page(pdf.pages[0], 1).sources[0]
    block.update(id="tab1", caption_zh="表 1：統計結果（隔離 Mock 資料）", head_zh=[["變數", "平均數", "標準差"]],
                 rows_zh=[["處理組：使用較長的中文文字確認表格儲存格能換行並保持數值對齊", "1.20", "0.045"], ["控制組", "-0.50", "0.060"]],
                 footnotes_zh=["註：括號內為標準誤；*** p < 0.01。", "來源：World Bank (2020)。"])
    paper = {"schema": 2, "meta": {"title_en": "PaperRead Table Review (Mock)", "title_zh": "表格互動隔離驗證", "target": "zh-TW", "page_count": 1,
             "pages": pages, "source_sha256": hashlib.sha256((room / "source.pdf").read_bytes()).hexdigest()},
             "translation": {"done_pages": [1], "en_pages": [], "gaps_checked": True}, "blocks": [block], "references": [], "glossary": []}
    write_json_atomic(room / "paper.json", paper)
    # Reruns preserve review annotations and personal edits.
    for name, value in (("reader", empty_reader()), ("discussion", empty_discussion()), ("item", {"status": "reading"}), ("layout", {})):
        if not (room / f"{name}.json").exists():
            write_json_atomic(room / f"{name}.json", value)
    home = PROFILE / "home"
    home.mkdir(parents=True, exist_ok=True)
    config = home / "config.json"
    if not config.exists():
        write_json_atomic(config, {"engine": "none", "auto_translate": False, "check_updates": False,
                                  "library_dir": str(PROFILE / "library")})
    vault = PROFILE / "vault"
    vault.mkdir(exist_ok=True)
    preferences = PROFILE / "library" / ".prefs.json"
    if not preferences.exists():
        write_json_atomic(preferences, {"research": {"vault": str(vault)}})
    print(f"Isolated profile: {PROFILE}\nReview paper: table-review\nNo model calls or production data are used.")


if __name__ == "__main__":
    prepare()
