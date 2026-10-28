import base64
import json
import zipfile
import io
from pathlib import Path
import unittest
import tempfile
from easyread.store import Workspace
from easyread import chat_markdown


class ChatMarkdownTests(unittest.TestCase):
    def setUp(self):
        self._temp = tempfile.TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.tmp_path = Path(self._temp.name)

    def test_chat_markdown_export_basic(self):
        tmp_path = self.tmp_path
        ws = Workspace(tmp_path)
        (tmp_path / "paper.json").write_text(json.dumps({
            "meta": {"title_en": "Attention Is All You Need", "title_zh": "注意力就是你所需"}
        }, ensure_ascii=False), encoding="utf-8")
        (tmp_path / "chat.json").write_text(json.dumps({
            "threads": [{
                "id": "t1",
                "title": "Thread 1",
                "messages": [
                    {"role": "user", "id": "u1", "content": "What is self-attention?"},
                    {"role": "assistant", "id": "a1", "content": "Self-attention relates different positions of a single sequence.", "at": "2026-10-27T12:00:00Z"}
                ]
            }]
        }, ensure_ascii=False), encoding="utf-8")

        result = chat_markdown.export(ws, {"thread": "t1", "id": "a1"})
        assert result["filename"].endswith(".md")
        assert result["mime"].startswith("text/markdown")
        decoded = base64.b64decode(result["data"]).decode("utf-8")
        assert "What is self-attention?" in decoded
        assert "Self-attention relates different positions of a single sequence." in decoded
        assert "2026-10-27T12:00:00Z" in decoded


    def test_chat_markdown_export_with_image(self):
        tmp_path = self.tmp_path
        ws = Workspace(tmp_path)
        (tmp_path / "paper.json").write_text(json.dumps({
            "meta": {"title_en": "Sample Paper"}
        }, ensure_ascii=False), encoding="utf-8")
        media_dir = tmp_path / "chat-media"
        media_dir.mkdir(parents=True)
        (media_dir / "fig1.png").write_bytes(b"FAKE_PNG_DATA")

        (tmp_path / "chat.json").write_text(json.dumps({
            "threads": [{
                "id": "t1",
                "title": "Thread 1",
                "messages": [
                    {"role": "user", "id": "u1", "content": "Explain this", "images": [f"/p/{ws.id}/chat-media/fig1.png"]},
                    {"role": "assistant", "id": "a1", "content": f"Here is the result: ![](/p/{ws.id}/chat-media/fig1.png)"}
                ]
            }]
        }, ensure_ascii=False), encoding="utf-8")

        result = chat_markdown.export(ws, {"thread": "t1", "id": "a1"})
        assert result["filename"].endswith(".zip")
        assert result["mime"] == "application/zip"
        raw_zip = base64.b64decode(result["data"])
        with zipfile.ZipFile(io.BytesIO(raw_zip), "r") as z:
            names = z.namelist()
            md_name = next(n for n in names if n.endswith(".md"))
            assert "assets/fig1.png" in names
            assert z.read("assets/fig1.png") == b"FAKE_PNG_DATA"
            md_content = z.read(md_name).decode("utf-8")
            assert "assets/fig1.png" in md_content


    def test_chat_markdown_export_not_found(self):
        tmp_path = self.tmp_path
        ws = Workspace(tmp_path)
        (tmp_path / "chat.json").write_text(json.dumps({"threads": []}), encoding="utf-8")
        with self.assertRaises(ValueError):
            chat_markdown.export(ws, {"thread": "t1", "id": "nonexistent"})
