"""Tests for ported upstream v1.4 features:
- Codeblock fallback & prompt formatting (PR #44)
- Hierarchical category matching & max path lengths
- Linked local PDF support (PR #74)
- Bulk folder import scanning & depth-to-category mapping
- Corrupted paper isolation (#68)
- Translation stop API / job cancellation (#62)
- Mobile HTML export flag & assets (#24)
"""
import io
import json
import shutil
import tempfile
from pathlib import Path
import unittest

from easyread import build as export_build, codeblocks
from easyread.library import Library, DataReadError
from easyread.bulk.folder import read as read_folder
from easyread.jobs import Jobs
from easyread.store import write_json_atomic


class TestV14Features(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.lib_root = self.tmp / "library"
        self.lib_root.mkdir()
        self.lib = Library(self.lib_root)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_codeblocks_detection_and_prose(self):
        # Normal markdown with a python code block
        text = "Here is the code:\n```python\nx = 1\ny = $2$\n```\nAnd after the code."
        self.assertTrue(codeblocks.has_fence(text))
        prose = codeblocks.prose(text)
        self.assertIn("Here is the code:", prose)
        self.assertIn("And after the code.", prose)
        # Prose should not include the code block content
        self.assertNotIn("x = 1", prose)

        # Parts extraction
        parts = codeblocks.parts(text)
        self.assertEqual(len(parts), 3)
        self.assertEqual(parts[0], "Here is the code:\n")
        self.assertIn("x = 1", parts[1])
        self.assertEqual(parts[2], "\nAnd after the code.")

    def test_codeblocks_normalize(self):
        # Paragraph containing markdown code fence gets normalized into para block with fenced code
        b = {"type": "code", "en": "print('hello')", "zh": "print('hello')", "lang": "python"}
        codeblocks.normalize(b)
        self.assertEqual(b["type"], "para")
        self.assertIn("```python", b["zh"])
        self.assertIn("print('hello')", b["zh"])

    def test_corrupted_paper_isolation(self):
        # Create a valid paper
        ws1, _ = self.lib.create_from_pdf(b"%PDF-1.4 valid\n%%EOF", "paper1.pdf")
        write_json_atomic(ws1.root / "paper.json", {"id": ws1.id, "meta": {"title_en": "Paper 1"}, "tags": ["tag1"]})

        # Create a corrupted paper
        corrupted_dir = self.lib.root / "corrupted_paper"
        corrupted_dir.mkdir()
        (corrupted_dir / "paper.json").write_text("{broken json invalid syntax", encoding="utf-8")

        # Listing should isolate the corrupted paper and not crash
        items = self.lib.list()
        self.assertEqual(len(items), 2)
        valid_item = next(i for i in items if i["id"] == ws1.id)
        corrupt_item = next(i for i in items if i["id"] == "corrupted_paper")

        self.assertNotIn("load_error", valid_item)
        self.assertIn("load_error", corrupt_item)
        self.assertIn("paper.json", corrupt_item["load_error"])

    def test_linked_local_pdf(self):
        # Create an external PDF outside library root
        external_dir = self.tmp / "external_docs"
        external_dir.mkdir()
        ext_pdf = external_dir / "test.pdf"
        ext_pdf.write_bytes(b"%PDF-1.4 external content\n%%EOF")

        # Import as linked PDF
        ws, created = self.lib.import_pdf_path(ext_pdf, link=True)
        self.assertTrue(created)
        meta = (ws.load("paper") or {}).get("meta", {})
        self.assertEqual(meta.get("source_pdf_path"), str(ext_pdf.resolve()))
        self.assertEqual(ws.source_pdf.resolve(), ext_pdf.resolve())
        # The stored source.pdf should NOT exist inside workspace
        self.assertFalse((ws.root / "source.pdf").exists())

        # Calling _linked_pdf on file inside library root should fail
        with self.assertRaises(ValueError):
            self.lib._linked_pdf(ws.root / "data.json")

    def test_bulk_folder_scan(self):
        # Create folder structure
        papers_dir = self.tmp / "papers"
        sub1 = papers_dir / "AI" / "LLM"
        sub2 = papers_dir / "Vision"
        hidden = papers_dir / ".hidden" / "Sub"
        sub1.mkdir(parents=True)
        sub2.mkdir(parents=True)
        hidden.mkdir(parents=True)

        (sub1 / "doc1.pdf").write_bytes(b"%PDF-1.4 1\n%%EOF")
        (sub2 / "doc2.pdf").write_bytes(b"%PDF-1.4 2\n%%EOF")
        (sub2 / "doc3.txt").write_text("not a pdf")
        (hidden / "ignored.pdf").write_bytes(b"%PDF-1.4 ignored\n%%EOF")

        snap = read_folder(str(papers_dir))
        self.assertEqual(len(snap.entries), 2)
        items = snap.entries

        # Check category nesting
        ai_item = next(i for i in items if i.pdf.name == "doc1.pdf")
        vis_item = next(i for i in items if i.pdf.name == "doc2.pdf")

        self.assertEqual(ai_item.cats, ["papers/AI/LLM"])
        self.assertEqual(vis_item.cats, ["papers/Vision"])

    def test_stop_model_work(self):
        ws, _ = self.lib.create_from_pdf(b"%PDF-1.4 cancel\n%%EOF", "cancel.pdf")
        write_json_atomic(ws.root / "job.json", {"state": "confirm", "translate": True, "read": False})

        jobs = Jobs(self.lib)
        stopped = jobs.stop_model_work([ws.id])
        self.assertEqual(stopped, 1)

        job = ws.load("job")
        self.assertEqual(job["state"], "done")
        self.assertIn("已导入", job["message"])

    def test_mobile_export_build(self):
        ws, _ = self.lib.create_from_pdf(b"%PDF-1.4 export\n%%EOF", "export.pdf")
        write_json_atomic(ws.root / "paper.json", {
            "id": ws.id,
            "meta": {"title_en": "Sample Mobile Export", "title_zh": "手機版匯出測試"},
            "blocks": [{"id": "b1", "type": "para", "page": 1, "en": "Hello", "zh": "你好"}],
            "translation": {"done_pages": [1]},
        })
        write_json_atomic(ws.root / "reader.json", {"notes": {"b1": {"body": "My note"}}})

        out_file = self.tmp / "test-mobile.html"
        res = export_build.build(ws, out=out_file, mobile=True)
        self.assertTrue(res.exists())
        html = res.read_text(encoding="utf-8")

        # Mobile export should inline mobile styles and scripts
        self.assertIn("mobile-read", html)
        self.assertIn("view-row-narrow", html)
        # Should contain the notes
        self.assertIn("My note", html)

    def test_standalone_export_contains_used_sticker_assets(self):
        ws, _ = self.lib.create_from_pdf(b"%PDF-1.4 export\n%%EOF", "export.pdf")
        write_json_atomic(ws.root / "paper.json", {"id": ws.id, "meta": {"title_en": "Sticker"}, "blocks": []})
        write_json_atomic(ws.root / "reader.json", {"stickers": {"s1": {"id": "s1", "assetId": "doodle-smiling-book"}}})
        out = export_build.build(ws, out=self.tmp / "sticker.html")
        html = out.read_text(encoding="utf-8")
        self.assertIn('"stickerAssets":', html)
        self.assertIn('"assetId": "doodle-smiling-book"', html)
        self.assertIn('/public/stickers/decorative/doodle-smiling-book.svg', html)
        self.assertIn('data:image/svg+xml;base64,', html)


if __name__ == "__main__":
    unittest.main()
