"""PaperRead interface locales: Traditional Chinese by default, with Simplified Chinese and English.

代码里只写中文：前端 `PR.t("中文 {n}", {n})`，后端 `tr("中文 {n}", n=…)`。
中文原文就是词条的键，英文在 web/i18n/en.json；缺了哪条英文，tests/test_i18n.py 会报出来。
"""
from __future__ import annotations

import json
import html
import os
import re
import subprocess
import sys
from functools import lru_cache
from pathlib import Path

# 不导入 config：config 间接导入了很多用 tr 的模块，这里保持没有包内依赖
EN_PATH = Path(__file__).resolve().parent / "web" / "i18n" / "en.json"
CHOICES = ("auto", "zh-TW", "zh", "en")


@lru_cache(maxsize=1)
def _dict_cached(mtime: float) -> dict:
    return json.loads(EN_PATH.read_text(encoding="utf-8"))


def en_dict() -> dict:
    try:
        return _dict_cached(EN_PATH.stat().st_mtime)
    except (OSError, ValueError):
        return {}


def _is_zh(tag: str | None) -> bool:
    tag = (tag or "").strip().lower().replace("_", "-")
    return tag.startswith("zh") or tag.startswith("chinese")


def _locale(tag: str | None) -> str:
    tag = (tag or "").strip().lower().replace("_", "-")
    if tag.startswith(("zh-tw", "zh-hk", "zh-mo", "zh-hant")):
        return "zh-TW"
    if _is_zh(tag):
        return "zh"
    return "en" if tag else "zh-TW"


@lru_cache(maxsize=1)
def system_lang() -> str:
    # 桌面版由 Electron 传进来（macOS 从启动台打开时拿不到 LANG）
    tag = os.environ.get("EASYREAD_SYSTEM_LANG")
    if tag:
        return _locale(tag)
    for var in ("LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"):
        value = os.environ.get(var)
        if value and value not in ("C", "POSIX", "C.UTF-8"):
            return _locale(value)
    if sys.platform == "win32":
        try:
            import ctypes
            lang_id = ctypes.windll.kernel32.GetUserDefaultUILanguage()
            if lang_id & 0x3ff == 0x04:
                return "zh-TW" if lang_id in (0x0404, 0x0C04, 0x1404) else "zh"
            return "en"
        except (AttributeError, OSError):
            pass
    if sys.platform == "darwin":
        try:
            out = subprocess.run(["defaults", "read", "-g", "AppleLanguages"], capture_output=True, text=True, timeout=3).stdout
            first = next((line.strip(' ",()') for line in out.splitlines() if line.strip(' ",()')), "")
            return _locale(first)
        except (OSError, subprocess.SubprocessError):
            pass
    return "zh-TW"


def choice() -> str:
    forced = os.environ.get("EASYREAD_LANG")  # 测试、排查问题时临时指定，优先于设置
    if forced in CHOICES and forced != "auto":
        return forced
    from . import prefs
    value = (prefs.load().get("ui") or {}).get("lang")
    return value if value in CHOICES else "zh-TW"


def lang() -> str:
    value = choice()
    return system_lang() if value == "auto" else value


def tr(text: str, /, **kw) -> str:
    """Translate one interface string, keeping Chinese content and variables intact."""
    if lang() == "zh-TW":
        converter = _tw_converter()
        if converter:
            text = _tw_text(text)
    if lang() == "en":
        text = en_dict().get(text) or text
    return text.format(**kw) if kw else text


_TW = None


@lru_cache(maxsize=1)
def _tw_overrides() -> dict:
    return json.loads((EN_PATH.parent / "zh-TW.json").read_text(encoding="utf-8"))


def _tw_text(text: str) -> str:
    return _tw_overrides().get(text, _tw_converter().convert(text))


def _tw_converter():
    global _TW
    if _TW is None:
        try:
            from opencc import OpenCC
            _TW = OpenCC("s2twp")
        except ImportError:
            _TW = False
    return _TW


def _translate_html(page: str, converter) -> str:
    """Convert visible static UI text and labels while leaving scripts, styles, and paper text alone."""
    if not converter:
        return page
    from html.parser import HTMLParser

    class Translator(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=False)
            self.parts = []
            self.skip = 0

        def handle_starttag(self, tag, attrs):
            if tag in ("script", "style"):
                self.skip += 1
            values = dict(attrs)
            translatable_attrs = {"placeholder", "title", "aria-label", "alt"}
            if tag == "input" and (values.get("type") or "").lower() in {"button", "submit", "reset"}:
                translatable_attrs.add("value")
            rendered = []
            for key, value in attrs:
                if value is not None and key in translatable_attrs:
                    value = _tw_text(value)
                rendered.append(key if value is None else f'{key}="{html.escape(value, quote=True)}"')
            self.parts.append("<" + tag + (" " + " ".join(rendered) if rendered else "") + ">")

        def handle_startendtag(self, tag, attrs):
            self.handle_starttag(tag, attrs)
            self.parts[-1] = self.parts[-1][:-1] + "/>"
            if tag in ("script", "style"):
                self.skip -= 1

        def handle_endtag(self, tag):
            self.parts.append(f"</{tag}>")
            if tag in ("script", "style") and self.skip:
                self.skip -= 1

        def handle_data(self, data):
            self.parts.append(data if self.skip else _tw_text(data))

        def handle_entityref(self, name):
            self.parts.append(f"&{name};")

        def handle_charref(self, name):
            self.parts.append(f"&#{name};")

        def handle_comment(self, data):
            self.parts.append(f"<!--{data}-->")

        def handle_decl(self, decl):
            self.parts.append(f"<!{decl}>")

        def unknown_decl(self, data):
            self.parts.append(f"<![{data}]>")

        def handle_pi(self, data):
            self.parts.append(f"<?{data}>")

    parser = Translator()
    parser.feed(page)
    parser.close()
    return "".join(parser.parts)


def inject(page: str, language: str | None = None) -> str:
    """返回页面时写上语言，英文时把词典也塞进去，前端同步就能用。"""
    picked = choice() if language is None else language  # 设置里的“界面语言”要显示当前选的是哪项
    language = language or lang()
    from . import config, langs  # 用到时再导入，见文件开头
    target = langs.valid(config.load().get("target"))  # 设置里的译文语言：按钮文字、没译过的论文用它
    html_lang = {"zh-TW": "zh-TW", "zh": "zh-CN", "en": "en"}.get(language, "zh-TW")
    page = page.replace('<html lang="zh-CN">', f'<html lang="{html_lang}" data-lang-choice="{picked}" data-target="{target}">', 1)
    converter = _tw_converter() if language == "zh-TW" else None
    if converter:
        page = _translate_html(page, converter)
        # PR.t is used for interface strings rendered after page load. Convert the
        # same source catalogue once here so JavaScript does not need another library.
        values = set(en_dict()) | set(_tw_overrides())
        payload = {value: _tw_text(value) for value in values}
        tw_json = json.dumps(payload, ensure_ascii=False).replace("<", "\\u003c")
        page = page.replace("</title>", f'</title>\n<script id="pr-zh-tw" type="application/json">{tw_json}</script>', 1)
    if language == "en":
        payload = json.dumps(en_dict(), ensure_ascii=False).replace("<", "\\u003c")
        page = page.replace("</title>", f'</title>\n<script id="pr-i18n" type="application/json">{payload}</script>', 1)
    return page
