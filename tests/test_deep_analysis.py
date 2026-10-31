import json
from pathlib import Path
import tempfile
import unittest
from easyread.research import deep_analysis
from easyread import research_v2, store


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

            # 1. extract_paper_text
            meta, text = deep_analysis.extract_paper_text(ws)
            assert "注意力機制全面解析" in text
            assert "Vaswani et al." in text
            assert "Transformer" in text
            assert "28.4" in text

            # 2. empty report check
            assert deep_analysis.get_report(ws) is None
            reports = deep_analysis.list_reports(app.lib)
            assert len(reports) == 0

            # 3. save report and get_report
            mock_report = {
                "paper_id": pid,
                "title": "注意力機制全面解析",
                "model": "gpt-4o",
                "created_at": "2026-10-31T00:00:00",
                "updated_at": "2026-10-31T00:00:00",
                "focus": "測試消融實驗",
                "markdown": "## 1. 核心假說與實證對齊\n充分支持。\n## 2. 消融實驗審計\n對照組完整。"
            }
            store.write_json_atomic(ws.root / "report.json", mock_report)
            loaded = deep_analysis.get_report(ws)
            assert loaded["model"] == "gpt-4o"
            assert "消融實驗" in loaded["markdown"]

            reports = deep_analysis.list_reports(app.lib)
            assert len(reports) == 1
            assert reports[0]["paper_id"] == pid

            # 4. apply_to_paper_note
            # When note is empty
            res = deep_analysis.apply_to_paper_note(ws, loaded["markdown"])
            assert res["ok"] is True
            note_body = (ws.load("reader").get("paper_note") or {}).get("body", "")
            assert "論文深度剖析報告" in note_body
            assert "消融實驗審計" in note_body

            # When note already has user thoughts
            user_initial = "# 我的讀書心得\n我覺得這篇論文很有趣。"
            ws.apply_reader_ops([{"op": "paper_note", "body": user_initial}])
            deep_analysis.apply_to_paper_note(ws, "新一輪審計內容")
            updated_body = (ws.load("reader").get("paper_note") or {}).get("body", "")
            assert "我的讀書心得" in updated_body
            assert "新一輪審計內容" in updated_body

            # 5. Export to Obsidian Vault (04-論文深度剖析)
            vault_dir = tmp_path / "test_vault"
            vault_dir.mkdir()
            from unittest import mock
            with mock.patch("easyread.research.obsidian_export.vault_path", lambda: vault_dir):
                exp_res = deep_analysis.export_to_obsidian(ws, loaded)
                assert len(exp_res["written"]) == 1
                exported_file = vault_dir / "Research" / "04-論文深度剖析" / "Attention Is All You Need-deep-analysis.md"
                assert exported_file.is_file()
                content = exported_file.read_text(encoding="utf-8")
                assert "消融實驗審計" in content
                assert 'type: "deep-analysis"' in content

            # 6. API get & post
            res_get = research_v2.get(app, f"/api/research/v2/deep-analysis")
            assert "reports" in res_get
            assert len(res_get["reports"]) == 1

            res_paper_get = research_v2.get(app, f"/api/research/v2/paper/{pid}/deep-analysis")
            assert res_paper_get["report"] is not None
            assert res_paper_get["report"]["paper_id"] == pid

            # 7. Delete report
            res_del = deep_analysis.delete_report(ws)
            assert res_del["ok"] is True
            assert deep_analysis.get_report(ws) is None
            assert len(deep_analysis.list_reports(app.lib)) == 0
