"""譯文語言：繁體中文提示詞、其他語言規則與舊論文相容性。"""
import json
import shutil
import threading
import unittest
from unittest import mock

from easyread import engines, langs, prompts, prompts_en, settings_api, translate
from easyread.store import write_json_atomic
from tests.test_translate import make_ws


def set_meta(ws, **kw):
    paper = ws.load("paper")
    paper["meta"].update(kw)
    write_json_atomic(ws.root / "paper.json", paper)


class LangsTest(unittest.TestCase):
    def setUp(self):
        self.ws = make_ws(2)

    def tearDown(self):
        shutil.rmtree(self.ws.root, ignore_errors=True)

    def test_chinese_prompt_unchanged(self):
        set_meta(self.ws, target="zh")
        self.assertIs(prompts.rules("zh"), prompts.RULES)
        self.assertIs(prompts.schema("zh"), prompts.SCHEMA)
        with mock.patch.object(langs, "of_paper", lambda meta, cfg=None: "zh"):
            text = prompts.translate(self.ws, [1], "text", "")
        self.assertIn("译成中文，这次只处理第 1 页", text)
        self.assertIn("standard error 译“标准误差”", text)

    def test_traditional_translation_prompt_converts_fixed_instructions(self):
        set_meta(self.ws, target="zh-TW")
        rules = prompts.rules("zh-TW")
        schema = prompts.schema("zh-TW")
        self.assertIn("翻譯要求", rules)
        self.assertIn("輸出格式", schema)
        self.assertNotIn("翻译要求", rules)
        self.assertNotIn("输出格式", schema)

    def test_every_swap_applies(self):
        for old, _ in prompts._RULES_SWAP:
            if old in prompts.RULES:
                self.assertIn(old, prompts.RULES)
        for old, _ in prompts._SCHEMA_SWAP:
            self.assertIn(old, prompts.SCHEMA)

    def test_other_language_prompt(self):
        set_meta(self.ws, target="ja")
        for text in (prompts.translate(self.ws, [1], "text", ""),
                     prompts_en.fill(self.ws, [1], {"p1-1": "Hello"})):
            self.assertIn("日语", text)
            self.assertNotIn("标准误差", text)
            self.assertNotIn("中文译文", text)
            self.assertNotIn("中文语序", text)

    def test_old_papers_count_as_chinese(self):
        self.assertEqual(langs.of_paper({"title_zh": "舊論文"}, {"target": "ja"}), "zh-TW")
        self.assertEqual(langs.of_paper({}, {"target": "ja"}), "ja")
        self.assertEqual(langs.of_paper({"target": "fr"}, {"target": "ja"}), "fr")
        self.assertEqual(langs.of_paper({}, {"target": "xx"}), "zh-TW")

    def test_reply_language(self):
        self.assertEqual(langs.reply_lang({"target": "de"}), "德语（Deutsch）")
        self.assertEqual(langs.reply_lang({"title_zh": "舊論文"}), "繁體中文（臺灣用語，zh-TW；不可使用簡體字）")
        self.assertEqual(langs.reply_language_rule({"title_zh": "舊論文"}), "用繁體中文（臺灣用語），不可使用簡體字")
        with mock.patch("easyread.i18n.lang", lambda: "en"):
            self.assertEqual(langs.reply_lang({}), "英文（English）")
            self.assertEqual(langs.reply_language_rule({}), "用英文（English）")

    def test_first_translation_records_target(self):
        def run(cfg, prompt, cwd, images=None, cancel=None, meter=None, json_mode=False):
            self.assertIn("译成韩语", prompt)
            return json.dumps({"blocks": [{"id": "p1-1", "type": "para", "page": 1, "en": "x", "zh": "번역"}]})
        cfg = {"engine": "openai", "batch_pages": 1, "concurrency": 1, "openai": {"vision": False}, "target": "ko"}
        with mock.patch.object(engines, "run", run), mock.patch.object(translate.netcheck, "problem", lambda cfg: ""), \
                mock.patch.object(translate.pdfwork, "locate", lambda root: None), mock.patch.object(translate, "tex_problems", lambda tex: []):
            translate.translate_pages(self.ws, cfg, [1], threading.Event(), lambda *a: None)
            self.assertEqual(self.ws.load("paper")["meta"]["target"], "ko")
            cfg["target"] = "ja"  # 之后改设置，这篇不跟着变
            translate.translate_pages(self.ws, cfg, [1], threading.Event(), lambda *a: None)
        self.assertEqual(self.ws.load("paper")["meta"]["target"], "ko")

    def test_import_remembers_target(self):
        langs.remember(self.ws, "fr")
        self.assertEqual(self.ws.load("paper")["meta"]["target"], "fr")
        langs.remember(self.ws, "de")  # 已经记过的不改
        self.assertEqual(self.ws.load("paper")["meta"]["target"], "fr")
        other = make_ws(1)
        paper = other.load("paper")
        paper["blocks"] = [{"id": "p1-1", "type": "para", "page": 1, "en": "x", "zh": "旧译文"}]
        write_json_atomic(other.root / "paper.json", paper)
        langs.remember(other, "ja")  # 已经有中文译文的旧论文不改
        langs.remember(self.ws, "xx")
        self.assertNotIn("target", other.load("paper")["meta"])
        shutil.rmtree(other.root, ignore_errors=True)

    def test_settings_rejects_unknown_target(self):
        with mock.patch.object(settings_api.config, "save", lambda patch: patch), mock.patch.object(settings_api.config, "public", lambda c: c):
            self.assertEqual(settings_api.save_config({"target": "xx"})["config"]["target"], "zh-TW")
            self.assertEqual(settings_api.save_config({"target": "es"})["config"]["target"], "es")


if __name__ == "__main__":
    unittest.main()
