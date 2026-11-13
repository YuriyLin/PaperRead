"""界面语言：系统语言判断、tr 填占位符、页面注入词典，以及所有界面文字都有英文。  python -m unittest tests.test_i18n"""
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

from easyread import i18n

ROOT = Path(__file__).resolve().parents[1]


class I18nTest(unittest.TestCase):
    def setUp(self):
        i18n.system_lang.cache_clear()

    def tearDown(self):
        i18n.system_lang.cache_clear()

    def test_system_lang_from_electron(self):
        for tag, want in (("zh-CN", "zh"), ("zh-TW", "zh-TW"), ("zh-HK", "zh-TW"), ("zh-Hant", "zh-TW"), ("en-US", "en"), ("de", "en"), ("ja", "en")):
            i18n.system_lang.cache_clear()
            with mock.patch.dict(os.environ, {"EASYREAD_SYSTEM_LANG": tag}):
                self.assertEqual(i18n.system_lang(), want, tag)

    def test_system_lang_from_env(self):
        env = {k: v for k, v in os.environ.items() if k not in ("EASYREAD_SYSTEM_LANG", "LC_ALL", "LC_MESSAGES", "LANGUAGE")}
        env["LANG"] = "de_DE.UTF-8"
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(i18n.system_lang(), "en")

    def test_choice_overrides_system(self):
        with mock.patch.object(i18n, "system_lang", lambda: "zh"), mock.patch.object(i18n, "choice", lambda: "en"):
            self.assertEqual(i18n.lang(), "en")
        with mock.patch.object(i18n, "system_lang", lambda: "en"), mock.patch.object(i18n, "choice", lambda: "auto"):
            self.assertEqual(i18n.lang(), "en")

    def test_tr(self):
        fake = {"已导入 {n} 篇": "Imported {n} papers"}
        with mock.patch.object(i18n, "en_dict", lambda: fake):
            with mock.patch.object(i18n, "lang", lambda: "en"):
                self.assertEqual(i18n.tr("已导入 {n} 篇", n=3), "Imported 3 papers")
                self.assertEqual(i18n.tr("词典里没有"), "词典里没有")
            with mock.patch.object(i18n, "lang", lambda: "zh"):
                self.assertEqual(i18n.tr("已导入 {n} 篇", n=3), "已导入 3 篇")

    def test_parse_json_reports_model_output_without_json(self):
        from easyread.engines import EngineError, parse_json

        with mock.patch.object(i18n, "lang", lambda: "en"), mock.patch.object(
            i18n, "en_dict", lambda: {"模型输出里没有 JSON：{text}": "No JSON in model output: {text}"}
        ):
            with self.assertRaisesRegex(EngineError, "No JSON in model output: plain text"):
                parse_json("plain text")

        self.assertEqual(parse_json('{"translated": "ok"}'), {"translated": "ok"})

    def test_traditional_conversion_uses_taiwan_terms(self):
        with mock.patch.object(i18n, "lang", lambda: "zh-TW"):
            self.assertEqual(i18n.tr("设置、软件和文件夹"), "設定、軟體和資料夾")

    def test_first_run_choice_defaults_to_traditional_chinese(self):
        from easyread import prefs
        env = {k: v for k, v in os.environ.items() if k != "EASYREAD_LANG"}
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(prefs, "load", lambda: {}):
            self.assertEqual(i18n.choice(), "zh-TW")

    def test_inject(self):
        page = '<html lang="zh-CN">\n<head><title>EasyRead</title></head>'
        self.assertNotIn("pr-i18n", i18n.inject(page, "zh"))
        with mock.patch.object(i18n, "en_dict", lambda: {"设置": "Settings</script>"}):
            out = i18n.inject(page, "en")
        self.assertIn('<html lang="en"', out)
        self.assertIn('id="pr-i18n"', out)
        self.assertNotIn("Settings</script>", out)  # 词典里的 < 要转义，不能提前结束 script

    def test_traditional_html_conversion_skips_scripts_and_converts_labels(self):
        page = ('<html lang="zh-CN"><head><title>设置</title></head><body>'
                '<button title="打开设置">设置</button><input placeholder="搜索文件夹">'
                '<script>const label = "设置";</script></body></html>')
        out = i18n.inject(page, "zh-TW")
        self.assertIn('<html lang="zh-TW"', out)
        self.assertIn("<title>設定</title>", out)
        self.assertIn('title="開啟設定"', out)
        self.assertIn("<button title=\"開啟設定\">設定</button>", out)
        self.assertIn('placeholder="搜尋資料夾"', out)
        self.assertIn('const label = "设置";', out)

    def test_every_ui_string_has_english(self):
        result = subprocess.run([sys.executable, str(ROOT / "scripts" / "i18n_check.py")], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0, result.stdout[-3000:])


class I18nSettingsTest(unittest.TestCase):
    def test_zh_tw_includes_all_tw_overrides_in_script_tag(self):
        html = '<html lang="zh-CN"><head><title>PaperRead</title></head><body></body></html>'
        injected = i18n.inject(html, language="zh-TW")
        self.assertIn('id="pr-zh-tw"', injected)
        start = injected.find('<script id="pr-zh-tw" type="application/json">') + len('<script id="pr-zh-tw" type="application/json">')
        end = injected.find('</script>', start)
        payload = json.loads(injected[start:end])
        self.assertIn("自动隐藏多标签页", payload)
        self.assertEqual(payload["自动隐藏多标签页"], "自動隱藏多標籤頁")
        self.assertIn("移出标签列时自动收合，鼠标移至顶部边缘时滑出，提供更开阔的阅读视野", payload)
        self.assertEqual(payload["移出标签列时自动收合，鼠标移至顶部边缘时滑出，提供更开阔的阅读视野"], "移出標籤列時自動收合，滑鼠移至頂部邊緣時滑出，提供更開闊的閱讀視野")

    def test_en_includes_tab_autohide_translations(self):
        html = '<html lang="zh-CN"><head><title>PaperRead</title></head><body></body></html>'
        injected = i18n.inject(html, language="en")
        self.assertIn('id="pr-i18n"', injected)
        start = injected.find('<script id="pr-i18n" type="application/json">') + len('<script id="pr-i18n" type="application/json">')
        end = injected.find('</script>', start)
        payload = json.loads(injected[start:end])
        self.assertIn("自动隐藏多标签页", payload)
        self.assertEqual(payload["自动隐藏多标签页"], "Auto-hide tabs")
        self.assertIn("移出标签列时自动收合，鼠标移至顶部边缘时滑出，提供更开阔的阅读视野", payload)

    def test_brand_mark_has_explicit_dimensions(self):
        lib_html = Path("easyread/web/library.html").read_text(encoding="utf-8")
        self.assertIn('class="mark" src="/web/paperread-mark.png" width="26" height="26"', lib_html)


class ReleaseI18nTest(unittest.TestCase):
    def test_english_dictionary_has_no_duplicate_keys(self):
        pairs = json.loads((ROOT / "easyread/web/i18n/en.json").read_text(encoding="utf-8"), object_pairs_hook=list)
        keys = [key for key, _ in pairs]
        self.assertEqual(len(keys), len(set(keys)))

    def test_new_feature_translations_preserve_named_parameters(self):
        import re
        en = json.loads((ROOT / "easyread/web/i18n/en.json").read_text(encoding="utf-8"))
        sources = ["common/page-cap.js", "library/cite-export.js", "common/cite.js",
                   "common/library-nav.js", "library/import.js", "library/detail.js"]
        for source in sources:
            code = (ROOT / "easyread/web/js" / source).read_text(encoding="utf-8")
            for key in re.findall(r'PR\.t\("([^"\n]+)"', code):
                with self.subTest(source=source, key=key):
                    self.assertTrue(en.get(key))
                    self.assertEqual(set(re.findall(r"\{\w+\}", key)), set(re.findall(r"\{\w+\}", en[key])))
                    self.assertIsNone(re.search("[一-鿿]", en[key]))


if __name__ == "__main__":
    unittest.main()
