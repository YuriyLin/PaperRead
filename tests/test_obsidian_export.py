import tempfile
import unittest
from pathlib import Path
from unittest import mock

from easyread.research import obsidian_export


class ObsidianExportTest(unittest.TestCase):
    def documents(self):
        return [
            {"id": "paper:p1:analysis", "kind": "analysis", "paper_id": "p1", "title": "測試論文", "body": "## 摘要\n內容", "links": ["paper:p1:mindmap"]},
            {"id": "paper:p1:mindmap", "kind": "mindmap", "paper_id": "p1", "title": "測試論文 - 心智圖", "body": "```mermaid\nmindmap\n  root((測試))\n```", "links": ["paper:p1:analysis"]},
        ]

    def test_export_creates_stable_layout_and_links(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with mock.patch.object(obsidian_export, "vault_path", lambda: root):
                first = obsidian_export.export_to_vault(self.documents())
                second = obsidian_export.export_to_vault(self.documents())
            self.assertEqual(len(first["written"]), 2)
            self.assertEqual(len(second["updated"]), 2)
            analysis = next(root.glob("Research/01-論文分析/*.md")).read_text(encoding="utf-8")
            self.assertIn("[[Research/02-心智圖/測試論文 - 心智圖]]", analysis)
            self.assertTrue((root / "Research" / ".paperread-index.json").is_file())

    def test_existing_note_without_managed_block_is_preserved_as_conflict(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "Research" / "01-論文分析" / "手動筆記.md"
            target.parent.mkdir(parents=True)
            target.write_text('---\nresearch_id: "paper:p1:analysis"\n---\n\n# 使用者內容\n', encoding="utf-8")
            with mock.patch.object(obsidian_export, "vault_path", lambda: root):
                result = obsidian_export.export_to_vault(self.documents()[:1])
            self.assertEqual(len(result["conflicts"]), 1)
            self.assertIn("使用者內容", target.read_text(encoding="utf-8"))

    def test_zip_contains_research_structure(self):
        import base64
        import io
        import zipfile

        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(obsidian_export, "vault_path", lambda: Path(tmp)):
                result = obsidian_export.export_zip(self.documents())
            archive = zipfile.ZipFile(io.BytesIO(base64.b64decode(result["content_base64"])))
            self.assertIn("Research/01-論文分析/測試論文.md", archive.namelist())
            self.assertIn("Research/.paperread-index.json", archive.namelist())

    def test_tampered_index_path_cannot_escape_vault(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            outside = root.parent / "paperread-outside.md"
            outside.write_text('research_id: "paper:p1:analysis"\n', encoding="utf-8")
            index_path = root / "Research" / ".paperread-index.json"
            index_path.parent.mkdir(parents=True)
            index_path.write_text('{"version": 1, "documents": {"paper:p1:analysis": {"path": "../paperread-outside.md"}}}\n', encoding="utf-8")
            with mock.patch.object(obsidian_export, "vault_path", lambda: root):
                result = obsidian_export.export_to_vault(self.documents()[:1])
            self.assertEqual(result["written"], ["Research/01-論文分析/測試論文.md"])
            self.assertIn('research_id: "paper:p1:analysis"', outside.read_text(encoding="utf-8"))

    def test_export_uses_short_english_filename_when_provided(self):
        documents = [{
            "id": "paper:p2:analysis", "kind": "analysis", "paper_id": "p2",
            "title": "中文顯示標題", "filename": "A Very Long English Paper Title About Reliable Vision Models and Their Evaluation Benchmarks",
            "body": "內容",
        }]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with mock.patch.object(obsidian_export, "vault_path", lambda: root):
                result = obsidian_export.export_to_vault(documents)
            self.assertEqual(result["written"], ["Research/01-論文分析/A Very Long English Paper Title About Reliable Vision Models and Their.md"])
            self.assertLessEqual(len(Path(result["written"][0]).stem), 80)

    def test_export_mindmap_with_png_attachment(self):
        import base64
        import io
        import zipfile
        fake_png_bytes = b"\x89PNG\r\n\x1a\nfake_png_header_and_data"
        fake_b64 = base64.b64encode(fake_png_bytes).decode("ascii")
        documents = [{
            "id": "paper:p1:mindmap",
            "kind": "mindmap",
            "paper_id": "p1",
            "title": "測試論文 - 心智圖",
            "filename": "test-paper-mind-map",
            "body": "## 論文心智圖\n\n![[test-paper-mind-map.png]]",
            "image_base64": fake_b64,
            "attachment": {
                "filename": "test-paper-mind-map.png",
                "content_base64": fake_b64,
            },
        }]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with mock.patch.object(obsidian_export, "vault_path", lambda: root):
                result = obsidian_export.export_to_vault(documents)
                zip_res = obsidian_export.export_zip(documents)
            md_file = root / "Research" / "02-心智圖" / "test-paper-mind-map.md"
            png_file = root / "Research" / "02-心智圖" / "test-paper-mind-map.png"
            self.assertTrue(md_file.is_file())
            self.assertTrue(png_file.is_file())
            self.assertEqual(png_file.read_bytes(), fake_png_bytes)
            self.assertIn("![[test-paper-mind-map.png]]", md_file.read_text(encoding="utf-8"))

            archive = zipfile.ZipFile(io.BytesIO(base64.b64decode(zip_res["content_base64"])))
            self.assertIn("Research/02-心智圖/test-paper-mind-map.md", archive.namelist())
            self.assertIn("Research/02-心智圖/test-paper-mind-map.png", archive.namelist())
            self.assertEqual(archive.read("Research/02-心智圖/test-paper-mind-map.png"), fake_png_bytes)

    def test_export_annotations_nested_subfolders_and_attachments(self):
        import base64
        import io
        import zipfile
        fake_img = b"FAKE_IMAGE_DATA"
        fake_b64 = base64.b64encode(fake_img).decode("ascii")
        documents = [
            {
                "id": "paper:p1:chat:msg1",
                "kind": "annotations",
                "paper_id": "p1",
                "title": "單則回答標題",
                "filename": "SingleAnswer",
                "subfolder": "SamplePaper/單則回答",
                "body": "## AI 回答\n\n![附圖](assets/fig1.png)",
                "attachments": [
                    {"filename": "assets/fig1.png", "content_base64": fake_b64}
                ],
            },
            {
                "id": "paper:p1:notes",
                "kind": "annotations",
                "paper_id": "p1",
                "title": "我的筆記",
                "filename": "MyNotes",
                "subfolder": "SamplePaper/我的筆記",
                "body": "## 筆記內容",
            },
            {
                "id": "paper:p1:highlights",
                "kind": "annotations",
                "paper_id": "p1",
                "title": "我的劃線",
                "filename": "MyHighlights",
                "subfolder": "SamplePaper/我的劃線",
                "body": "## 劃線內容",
            },
            {
                "id": "paper:p1:chat_all",
                "kind": "annotations",
                "paper_id": "p1",
                "title": "所有AI問答",
                "filename": "AllAiQa",
                "subfolder": "SamplePaper/所有AI問答",
                "body": "## 所有問答",
            },
        ]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with mock.patch.object(obsidian_export, "vault_path", lambda: root):
                result = obsidian_export.export_to_vault(documents)
                zip_res = obsidian_export.export_zip(documents)
            self.assertEqual(len(result["written"]), 4)
            ans_file = root / "Research" / "03-閱讀標註" / "SamplePaper" / "單則回答" / "SingleAnswer.md"
            att_file = root / "Research" / "03-閱讀標註" / "SamplePaper" / "單則回答" / "assets" / "fig1.png"
            notes_file = root / "Research" / "03-閱讀標註" / "SamplePaper" / "我的筆記" / "MyNotes.md"
            hl_file = root / "Research" / "03-閱讀標註" / "SamplePaper" / "我的劃線" / "MyHighlights.md"
            all_file = root / "Research" / "03-閱讀標註" / "SamplePaper" / "所有AI問答" / "AllAiQa.md"

            self.assertTrue(ans_file.is_file())
            self.assertTrue(att_file.is_file())
            self.assertEqual(att_file.read_bytes(), fake_img)
            self.assertTrue(notes_file.is_file())
            self.assertTrue(hl_file.is_file())
            self.assertTrue(all_file.is_file())

            archive = zipfile.ZipFile(io.BytesIO(base64.b64decode(zip_res["content_base64"])))
            self.assertIn("Research/03-閱讀標註/SamplePaper/單則回答/SingleAnswer.md", archive.namelist())
            self.assertIn("Research/03-閱讀標註/SamplePaper/單則回答/assets/fig1.png", archive.namelist())
            self.assertEqual(archive.read("Research/03-閱讀標註/SamplePaper/單則回答/assets/fig1.png"), fake_img)
            self.assertIn("Research/03-閱讀標註/SamplePaper/我的筆記/MyNotes.md", archive.namelist())
            self.assertIn("Research/03-閱讀標註/SamplePaper/我的劃線/MyHighlights.md", archive.namelist())
            self.assertIn("Research/03-閱讀標註/SamplePaper/所有AI問答/AllAiQa.md", archive.namelist())


if __name__ == "__main__":
    unittest.main()
