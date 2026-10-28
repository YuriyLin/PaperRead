import json
import unittest
from pathlib import Path
from easyread import i18n

class I18nSettingsTest(unittest.TestCase):
    def test_zh_tw_includes_all_tw_overrides_in_script_tag(self):
        html = '<html lang="zh-CN"><head><title>PaperRead</title></head><body></body></html>'
        injected = i18n.inject(html, language="zh-TW")
        self.assertIn('id="pr-zh-tw"', injected)
        # Find json content
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

if __name__ == "__main__":
    unittest.main()
