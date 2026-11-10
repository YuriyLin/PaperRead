import json
from pathlib import Path
import tempfile
import unittest
from easyread.research import deep_analysis
from easyread import store


def fake_app(tmp_path):
    class FakeLib:
        def __init__(self, root):
            self.root = root

        def ws(self, pid):
            paper_dir = self.root / pid
            if not paper_dir.exists():
                return None
            return store.Workspace(paper_dir)

        def all(self):
            res = []
            for d in self.root.iterdir():
                if d.is_dir() and (d / "paper.json").is_file():
                    res.append(store.Workspace(d))
            return res

    class FakeApp:
        def __init__(self, root):
            self.lib = FakeLib(root)

    return FakeApp(tmp_path)


class DeepAnalysisTest(unittest.TestCase):
    def test_deep_analysis_flow(self):
        with tempfile.TemporaryDirectory() as directory:
            tmp_path = Path(directory)
            app = fake_app(tmp_path)
            pid = "test_paper_1"
            paper_dir = tmp_path / pid
            paper_dir.mkdir(parents=True)

            paper_data = {
                "meta": {
                    "title_zh": "注意力機制全面解析",
                    "title_en": "Attention Is All You Need",
                    "authors": "Vaswani et al.",
                    "year": 2017,
                    "venue": "NeurIPS",
                    "abstract": "We propose the Transformer...",
                },
                "blocks": [
                    {"id": "b1", "type": "heading", "zh": "1. 緒論", "en": "1. Introduction", "page": 1},
                    {"id": "b2", "type": "paragraph", "en": "Recurrent models typically factor computation...", "page": 1},
                    {"id": "b3", "type": "table", "head": [["Model", "BLEU"]], "rows": [["Transformer", "28.4"]], "page": 5},
                ]
            }
            (paper_dir / "paper.json").write_text(json.dumps(paper_data, ensure_ascii=False), encoding="utf-8")
            (paper_dir / "reader.json").write_text(json.dumps(store.empty_reader(), ensure_ascii=False), encoding="utf-8")

            ws = app.lib.ws(pid)
            assert ws is not None

            meta, text = deep_analysis.extract_paper_text(ws)
            assert "注意力機制全面解析" in text
            assert "Vaswani et al." in text
            assert "Recurrent models" in text
            assert "Transformer" in text
            assert "28.4" in text

            assert deep_analysis.get_report(ws) is None
            reports = deep_analysis.list_reports(app.lib)
            assert len(reports) == 0

            mock_report = {
                "paper_id": pid,
                "title": "注意力機制全面解析",
                "model": "gpt-4o",
                "created_at": "2026-10-31T00:00:00",
                "updated_at": "2026-10-31T00:00:00",
                "focus": "測試消融實驗",
                "markdown": "## 1. 核心假說與實證對齊\n充分支持。\n## 2. 消融實驗審計\n對照組完整。",
            }
            store.write_json_atomic(ws.root / "report.json", mock_report)
            loaded = deep_analysis.get_report(ws)
            assert loaded["model"] == "gpt-4o"
            assert "消融實驗" in loaded["markdown"]

            reports = deep_analysis.list_reports(app.lib)
            assert len(reports) == 1
            assert reports[0]["paper_id"] == pid

            res = deep_analysis.apply_to_paper_note(ws, loaded["markdown"])
            assert res["ok"] is True
            note_body = (ws.load("reader").get("paper_note") or {}).get("body", "")
            assert "論文深度剖析報告" in note_body

    def test_extract_paper_text_anti_truncation_keeps_later_sections(self):
        with tempfile.TemporaryDirectory() as directory:
            tmp_path = Path(directory)
            app = fake_app(tmp_path)
            pid = "long_paper"
            paper_dir = tmp_path / pid
            paper_dir.mkdir(parents=True)

            blocks = [
                {"id": "b1", "type": "heading", "en": "1. Introduction", "page": 1},
                {"id": "b2", "type": "paragraph", "en": "Intro content " * 400, "page": 1},
                {"id": "b3", "type": "heading", "en": "2. Method", "page": 3},
                {"id": "b4", "type": "paragraph", "en": "Method formula details " * 400, "page": 3},
                {"id": "b5", "type": "heading", "en": "3. Experiments and Ablation", "page": 7},
                {"id": "b6", "type": "paragraph", "en": "CRITICAL_ABLATION_RESULT_99_2", "page": 7},
                {"id": "b7", "type": "heading", "en": "4. Limitations and Conclusion", "page": 10},
                {"id": "b8", "type": "paragraph", "en": "KEY_LIMITATION_QUADRATIC_COST", "page": 10},
            ]
            (paper_dir / "paper.json").write_text(
                json.dumps({"meta": {"title_en": "Long Paper"}, "blocks": blocks}, ensure_ascii=False),
                encoding="utf-8",
            )
            ws = app.lib.ws(pid)
            _, text = deep_analysis.extract_paper_text(ws, max_chars=4000)
            self.assertIn("CRITICAL_ABLATION_RESULT_99_2", text)
            self.assertIn("KEY_LIMITATION_QUADRATIC_COST", text)
