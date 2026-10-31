"""Test paper title override and short title derivation."""
import tempfile
import unittest
from pathlib import Path

from easyread.library import Library
from easyread.store import Workspace, write_json_atomic


class TitleOverrideTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.lib = Library(self.root)
        self.ws_dir = self.root / "testpaper"
        self.ws_dir.mkdir(parents=True)
        self.ws = Workspace(self.ws_dir)

    def test_parts_includes_item(self):
        self.assertIn("item", Workspace.PARTS)
        versions = self.ws.versions()
        self.assertIn("item", versions)

    def test_summary_derives_short_zh_when_title_zh_is_overridden(self):
        # 模拟模型最初翻译生成的 paper.json，有旧的 short_zh
        paper_data = {
            "meta": {
                "title_en": "Do Vision-Language Models Lose Confidence? A Study of Sycophancy in VLMs",
                "title_zh": "視覺語言模型是否失去了信心？VLMs 諂媚現象研究",
                "short_zh": "VLMs 阿諛現象研究",
                "target": "zh-TW"
            },
            "blocks": []
        }
        write_json_atomic(self.ws.paper_path, paper_data)
        write_json_atomic(self.ws.item_path, {"meta_override": {"title_zh": "視覺語言模型是否失去信心？VLMs 諂媚現象研究"}})

        summary = self.lib.summary(self.ws)
        self.assertEqual(summary["title_zh"], "視覺語言模型是否失去信心？VLMs 諂媚現象研究")
        # 舊的 "VLMs 阿諛現象研究" 不應殘留，應動態衍生自使用者覆寫的 title_zh
        self.assertEqual(summary["short_zh"], "VLMs 諂媚現象研究")

    def test_summary_keeps_custom_short_zh_if_explicitly_set(self):
        paper_data = {
            "meta": {
                "title_en": "Test Paper",
                "title_zh": "舊標題",
                "short_zh": "舊短標題",
                "target": "zh-TW"
            },
            "blocks": []
        }
        write_json_atomic(self.ws.paper_path, paper_data)
        write_json_atomic(self.ws.item_path, {
            "meta_override": {
                "title_zh": "新標題：副標題",
                "short_zh": "自訂短標題"
            }
        })

        summary = self.lib.summary(self.ws)
        self.assertEqual(summary["title_zh"], "新標題：副標題")
        self.assertEqual(summary["short_zh"], "自訂短標題")


if __name__ == "__main__":
    unittest.main()
