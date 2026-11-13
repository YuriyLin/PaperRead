"""把阅读页和一篇论文打成单个 HTML：离线打开、发给别人看。

单文件里的修改存在浏览器；在页面“说明”里导出后，用 `easyread merge ID --from 导出.json` 并回文献库。
"""
from __future__ import annotations

import base64
import html as htmllib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

from . import i18n
from .config import WEB
from .store import Workspace

_LINK = re.compile(r'<link rel="stylesheet" href="/web/([^"]+)"\s*/?>')
_SCRIPT = re.compile(r'<script src="/web/([^"]+)"></script>')
RENDER_TEX = Path(__file__).with_name("render_tex.js")
KATEX = WEB / "vendor" / "katex" / "katex.min.js"

_TOKENS = re.compile(
    r"(?<!\\)(`+)([\s\S]*?)\1"
    r"|(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$"
    r"|(?<![\\$])\$(?!\$)((?![0-9])(?:\\\$|[^$])+?|[0-9](?:\\\$|[^$])*?(?<![\s，。；、：（(\u3400-\u9fff])(?=\$(?![0-9])))(?<!\\)\$(?!\$)"  # i18n-ok
    r"|(?<!\\)\\\[([\s\S]+?)(?<!\\)\\\]"
    r"|(?<!\\)\\\(([\s\S]+?)(?<!\\)\\\)"
    r"|(?<!\\)\[((?:\\.|[^\[\]\\\n])+)\]\(((?:[^\s()<>]|\([^\s()<>]*\))+)\)"
)


def _data_uri(path: Path, mime: str) -> str:
    return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode()


def _inline_css(rel: str) -> str:
    path = WEB / rel
    css = path.read_text(encoding="utf-8")
    if "katex" in rel:  # 字体转成 data URI，离线也能显示公式
        css = re.sub(r"url\((fonts/[^)]+\.woff2)\)", lambda m: f"url({_data_uri(path.parent / m.group(1), 'font/woff2')})", css)
        css = re.sub(r",\s*url\(fonts/[^)]+\.(woff|ttf)\) format\(\"(woff|truetype)\"\)", "", css)
    return f"<style>{css}</style>"


def _script(rel: str) -> str:
    js = (WEB / rel).read_text(encoding="utf-8").replace("</script", "<\\/script")
    return f"<script>{js}</script>"


def _collect_math_items(paper: dict, reader: dict) -> list[dict]:
    items: list[dict] = []
    seen: set[str] = set()

    def add(tex: str, display: bool):
        t = (tex or "").strip() if display else (tex or "")
        if not t:
            return
        key = ("D" if display else "I") + t
        if key not in seen:
            seen.add(key)
            items.append({"key": key, "tex": t, "display": display})

    blocks = paper.get("blocks", [])
    for b in blocks:
        if isinstance(b, dict) and b.get("type") == "math" and b.get("tex"):
            add(b["tex"], True)

    texts: list[str] = []
    meta = paper.get("meta", {})
    for k in ("title_zh", "title_en", "abstract", "abstract_en"):
        v = meta.get(k)
        if v:
            texts.append(str(v))

    edits = (reader or {}).get("edits", {})
    for e in edits.values():
        if isinstance(e, dict) and e.get("zh"):
            texts.append(str(e["zh"]))

    for b in blocks:
        if not isinstance(b, dict):
            continue
        for k in ("zh", "en", "caption_zh", "caption_en"):
            v = b.get(k)
            if v:
                texts.append(str(v))
        for it in b.get("items") or []:
            if isinstance(it, dict):
                for k in ("zh", "en"):
                    v = it.get(k)
                    if v:
                        texts.append(str(v))
            elif isinstance(it, str):
                texts.append(it)

    for r in paper.get("references") or []:
        if isinstance(r, dict) and r.get("text"):
            texts.append(str(r["text"]))

    for text in texts:
        for m in _TOKENS.finditer(text):
            g1, g2, g3, g4, g5, g6, g7, g8 = m.groups()
            if g1:
                continue
            elif g3:
                add(g3, True)
            elif g4:
                add(g4, False)
            elif g5:
                add(g5, True)
            elif g6:
                add(g6, False)

    return items


def _find_node() -> str | None:
    node = shutil.which("node")
    if node:
        return node
    for candidate in [
        os.environ.get("NODE_PATH"),
        r"C:\Program Files\nodejs\node.exe",
        r"C:\Program Files (x86)\nodejs\node.exe",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ]:
        if candidate and Path(candidate).is_file():
            return str(candidate)
    return None


def _render_math_batch(items: list[dict]) -> dict[str, str]:
    if not items:
        return {}
    node = _find_node()
    env = None
    if not node and os.environ.get("EASYREAD_ELECTRON_EXECUTABLE"):
        node = os.environ["EASYREAD_ELECTRON_EXECUTABLE"]
        env = {**os.environ, "ELECTRON_RUN_AS_NODE": "1"}
    if node and RENDER_TEX.exists() and KATEX.exists():
        try:
            proc = subprocess.run(
                [node, str(RENDER_TEX), str(KATEX.resolve())],
                input=json.dumps(items, ensure_ascii=False),
                capture_output=True,
                text=True,
                encoding="utf-8",
                env=env,
                timeout=30,
            )
            if proc.returncode == 0 and proc.stdout:
                res = json.loads(proc.stdout)
                if isinstance(res, dict):
                    return res
        except Exception:
            pass

    fallback: dict[str, str] = {}
    for item in items:
        tex = item.get("tex", "")
        key = item.get("key") or (("D" if item.get("display") else "I") + tex)
        if item.get("display"):
            fallback[key] = f'<div class="eq"><code>{htmllib.escape(tex)}</code></div>'
        else:
            fallback[key] = f"<code>{htmllib.escape(tex)}</code>"
    return fallback


def _inline_md(text: str, math_map: dict[str, str] | None = None, ref_ids: set[str] | None = None) -> str:
    if not text:
        return ""
    math_map = math_map or {}
    ref_ids = ref_ids or set()
    placeholders: list[str] = []

    def repl_token(m):
        g1, g2, g3, g4, g5, g6, g7, g8 = m.groups()
        if g1:  # `code`
            html = f"<code>{htmllib.escape(g2)}</code>"
        elif g3:  # $$...$$
            tex = g3.strip()
            html = math_map.get("D" + tex) or f'<div class="eq"><code>{htmllib.escape(tex)}</code></div>'
        elif g4:  # $...$
            tex = g4
            html = math_map.get("I" + tex) or f"<code>{htmllib.escape(tex)}</code>"
        elif g5:  # \[...\]
            tex = g5.strip()
            html = math_map.get("D" + tex) or f'<div class="eq"><code>{htmllib.escape(tex)}</code></div>'
        elif g6:  # \(...\)
            tex = g6
            html = math_map.get("I" + tex) or f"<code>{htmllib.escape(tex)}</code>"
        elif g7:  # [label](url)
            label = htmllib.escape(g7)
            url = g8
            if url.startswith("#cite:"):
                cite_id = url[6:]
                html = f'<a class="cite" href="#ref-{htmllib.escape(cite_id)}">{label}</a>'
            elif url.startswith("#"):
                html = f'<a class="xref" href="{htmllib.escape(url)}">{label}</a>'
            elif url.startswith(("http://", "https://", "mailto:")):
                html = f'<a class="external-link" href="{htmllib.escape(url)}" target="_blank" rel="noopener noreferrer">{label}</a>'
            else:
                html = label
        else:
            return m.group(0)

        idx = len(placeholders)
        placeholders.append(html)
        return f"\x00{idx}\x01"

    s = _TOKENS.sub(repl_token, text)
    s = htmllib.escape(s)

    # Footnote references [^1]
    s = re.sub(r"(?<!\\)\[\^(\d{1,3}|[*∗†‡§¶]{1,3})\]", r"<sup>\1</sup>", s)

    # Citation references like [40, 53]
    if ref_ids:
        def link_cites(m):
            inner = m.group(1)
            parts = re.split(r"(\s*[,，–-]\s*)", inner)  # i18n-ok
            linked = []
            for p in parts:
                p_clean = p.strip()
                if p_clean in ref_ids:
                    linked.append(f'<a class="cite" href="#ref-{htmllib.escape(p_clean)}">{htmllib.escape(p)}</a>')
                else:
                    linked.append(htmllib.escape(p))
            return "[" + "".join(linked) + "]"
        s = re.sub(r"\[(\d+(?:\s*[,，–-]\s*\d+)*)\]", link_cites, s)  # i18n-ok

    # Bold **text**
    s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
    # Italic *text*
    s = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<em>\1</em>", s)
    # Newlines
    s = s.replace("\n", "<br>")
    # Escaped dollar signs \$ -> $
    s = s.replace(r"\$", "$")

    # Restore placeholders
    s = re.sub(r"\x00(\d+)\x01", lambda m: placeholders[int(m.group(1))], s)
    return s


def _prerender_paper(paper: dict, reader: dict, images: dict, mobile: bool = False, lang: str | None = None) -> str:
    meta = paper.get("meta", {})
    blocks = paper.get("blocks", [])
    edits = (reader or {}).get("edits", {})
    ref_ids = {str(r.get("id")) for r in paper.get("references", []) if r.get("id")}

    math_items = _collect_math_items(paper, reader)
    math_map = _render_math_batch(math_items)

    parts = []

    # Head
    kicker = "　·　".join(filter(None, [meta.get("arxiv"), meta.get("venue"), meta.get("date")]))
    title = meta.get("title_zh") or meta.get("title_en") or meta.get("title") or i18n.tr("论文")
    title_en = meta.get("title_en")
    byline = "　·　".join(filter(None, [meta.get("authors"), meta.get("affiliation")]))

    head_parts = ['<header class="paper-head" id="b-head" data-id="head">']
    if kicker:
        head_parts.append(f'<div class="kicker">{htmllib.escape(kicker)}</div>')
    head_parts.append(f'<h1 data-title-key="title_zh"><span class="title-text">{_inline_md(title, math_map, ref_ids)}</span></h1>')
    if title_en and title_en != title:
        head_parts.append(f'<p class="title-en" lang="en">{_inline_md(title_en, math_map, ref_ids)}</p>')
    if byline:
        head_parts.append(f'<p class="byline">{htmllib.escape(byline)}</p>')
    head_parts.append('</header>')
    parts.append("".join(head_parts))

    # If no blocks, render abstract
    if not blocks:
        abstract = meta.get("abstract") or meta.get("abstract_en") or ""
        if abstract:
            parts.append(f'<section class="blk blk-para abstract" id="b-abstract"><div class="zh">{_inline_md(abstract, math_map, ref_ids)}</div></section>')

    # Blocks
    for b in blocks:
        if not isinstance(b, dict):
            continue
        bid = b.get("id", "")
        btype = b.get("type", "")

        if btype == "heading":
            level = b.get("level", 1)
            tag = "h2" if level == 1 else "h3"
            zh = edits.get(bid, {}).get("zh") or b.get("zh") or b.get("en") or ""
            num = f'<span class="num">{htmllib.escape(b["num"])} </span>' if b.get("num") else ""
            en_title = f'<span class="en-title" lang="en">{_inline_md(b["en"], math_map, ref_ids)}</span>' if (b.get("en") and b.get("zh")) else ""
            parts.append(f'<section class="blk blk-heading h{level}" id="b-{bid}" data-id="{bid}"><{tag} class="zh" data-key="{bid}">{num}<span>{_inline_md(zh, math_map, ref_ids)}</span>{en_title}</{tag}></section>')

        elif btype == "para":
            zh = edits.get(bid, {}).get("zh") or b.get("zh") or b.get("en") or ""
            role = b.get("role", "")
            extra = " abstract" if role == "abstract" else (" footnote" if role == "footnote" else "")
            parts.append(f'<section class="blk blk-para{extra}" id="b-{bid}" data-id="{bid}"><div class="zh" data-key="{bid}">{_inline_md(zh, math_map, ref_ids)}</div></section>')

        elif btype == "list":
            tag = "ol" if b.get("ordered") else "ul"
            items = b.get("items") or []
            item_htmls = []
            for i, it in enumerate(items):
                item_key = f"{bid}#{i}"
                item_zh = edits.get(item_key, {}).get("zh") or (it.get("zh") or it.get("en") if isinstance(it, dict) else str(it))
                item_htmls.append(f'<li><div class="zh" data-key="{item_key}">{_inline_md(item_zh, math_map, ref_ids)}</div></li>')
            parts.append(f'<section class="blk blk-list" id="b-{bid}" data-id="{bid}"><{tag}>{"".join(item_htmls)}</{tag}></section>')

        elif btype == "math":
            tex = b.get("tex", "")
            tag_str = f'<div class="math-tag">({htmllib.escape(b["tag"])})</div>' if b.get("tag") else ""
            math_html = math_map.get("D" + tex) or math_map.get("D" + tex.strip()) or f"<code>{htmllib.escape(tex)}</code>"
            parts.append(f'<section class="blk blk-math" id="b-{bid}" data-id="{bid}"><div class="math-row"><div class="math-body">{math_html}</div>{tag_str}</div></section>')

        elif btype == "figure":
            cap_key = f"{bid}#caption"
            caption = edits.get(cap_key, {}).get("zh") or b.get("caption_zh") or b.get("caption_en") or ""
            src = images.get(b.get("src", "")) if b.get("src") else ""
            page_n = b.get("page", 1)
            page_rel = f"pages/page-{page_n:03d}.webp"
            has_page = page_rel in images
            if src:
                media = f'<div class="figure-media"><img src="{src}" alt="{htmllib.escape(caption)}"></div>'
            elif has_page:
                media = f'<div class="figure-media"><button class="fig-placeholder" data-t="page"><span>{i18n.tr("圖表保留於原文")}</span><small>{i18n.tr("圖見原文第 {n} 頁（點擊查看）", n=page_n)}</small></button></div>'  # i18n-ok
            else:
                media = f'<div class="figure-media"><button class="fig-placeholder" disabled><span>{i18n.tr("圖表保留於原文")}</span><small>{i18n.tr("圖見原文第 {n} 頁", n=page_n)}</small></button></div>'  # i18n-ok
            cap_html = f'<div class="caption"><div class="zh" data-key="{cap_key}">{_inline_md(caption, math_map, ref_ids)}</div></div>' if caption else ""
            parts.append(f'<section class="blk blk-figure" id="b-{bid}" data-id="{bid}">{media}{cap_html}</section>')

        elif btype == "table":
            cap_key = f"{bid}#caption"
            caption = edits.get(cap_key, {}).get("zh") or b.get("caption_zh") or b.get("caption_en") or ""
            page_n = b.get("page", 1)
            page_rel = f"pages/page-{page_n:03d}.webp"
            has_page = page_rel in images
            if has_page:
                media = f'<div class="figure-media"><button class="fig-placeholder table-placeholder" data-t="page"><span>{i18n.tr("表格保留於原文")}</span><small>{i18n.tr("表格位於原文第 {n} 頁（點擊查看）", n=page_n)}</small></button></div>'  # i18n-ok
            else:
                media = f'<div class="figure-media"><button class="fig-placeholder table-placeholder" disabled><span>{i18n.tr("表格保留於原文")}</span><small>{i18n.tr("表格位於原文第 {n} 頁", n=page_n)}</small></button></div>'  # i18n-ok
            cap_html = f'<div class="caption"><div class="zh" data-key="{cap_key}">{_inline_md(caption, math_map, ref_ids)}</div></div>' if caption else ""
            content = (cap_html + media) if b.get("caption_pos") == "above" else (media + cap_html)
            parts.append(f'<section class="blk blk-table" id="b-{bid}" data-id="{bid}">{content}</section>')

        elif btype == "references":
            refs = paper.get("references") or []
            ref_lis = "".join(f'<li id="ref-{r.get("id")}"><span class="n">[{htmllib.escape(str(r.get("id")))}]</span> <span>{_inline_md(r.get("text", ""), math_map, ref_ids)}</span></li>' for r in refs)
            title_text = edits.get(bid, {}).get("zh") or b.get("zh") or i18n.tr("参考文献")
            parts.append(f'<section class="blk blk-references" id="b-{bid}" data-id="{bid}"><h2 class="zh" data-key="{bid}"><span>{htmllib.escape(title_text)}</span></h2><div class="refs"><ol>{ref_lis}</ol></div></section>')

        elif btype == "note":
            zh = edits.get(bid, {}).get("zh") or b.get("zh") or ""
            parts.append(f'<section class="blk blk-note" id="b-{bid}" data-id="{bid}"><div class="inline-note"><div class="lbl">{i18n.tr("阅读批注（非原文）")}</div><p>{_inline_md(zh, math_map, ref_ids)}</p></div></section>')  # i18n-ok

    return "\n".join(parts)


def build(ws: Workspace, out: Path | None = None, assets: Path | None = None, extra: dict | None = None, lang: str | None = None, mobile: bool = False) -> Path:
    """assets：图片不内嵌、另存到这个目录（放到网站上时页面小很多，图按需加载）；extra：额外写进页面数据的内容；lang：界面语言，默认跟当前设置。
    mobile：手机版，只读；不带 PDF 原页图（没译的页除外，正文里要用它），体积小很多。"""
    page = i18n.inject((WEB / "reader.html").read_text(encoding="utf-8"), lang)
    if mobile:
        page = page.replace("</head>", '<link rel="stylesheet" href="/web/css/reader-mobile.css">\n</head>', 1)
        page = page.replace('<script src="/web/js/reader/main.js">', '<script src="/web/js/reader/mobile.js"></script>\n<script src="/web/js/reader/main.js">', 1)
    page = _LINK.sub(lambda m: _inline_css(m.group(1)), page)
    page = _SCRIPT.sub(lambda m: _script(m.group(1)), page)
    page = page.replace('<link rel="icon" href="/web/paperread-mark.png" type="image/png">', f'<link rel="icon" href="{_data_uri(WEB / "paperread-mark.png", "image/png")}">')
    paper = ws.load("paper")
    images = {}
    done = set((paper.get("translation") or {}).get("done_pages") or []) if mobile else set()
    rels = [p["img"] for p in paper.get("meta", {}).get("pages", []) if p.get("n") not in done] + [b["src"] for b in paper.get("blocks", []) if b.get("src")]
    for rel in rels:
        src = ws.root / rel
        if not src.exists():
            continue
        if assets:
            dst = assets / rel.replace("/", "-")
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(src.read_bytes())
            images[rel] = f"{assets.name}/{dst.name}"
        else:
            images[rel] = _data_uri(src, "image/webp")
    data = {n: ws.load(n) for n in ("discussion", "reader", "layout", "item")}
    # Keep stickers already placed in the standalone reader available offline.
    catalog = json.loads((WEB / "stickers" / "sticker-manifest.json").read_text(encoding="utf-8"))
    used = {s.get("assetId") for s in data["reader"].get("stickers", {}).values() if not s.get("deleted")}
    sticker_assets = []
    for asset in catalog["assets"]:
        if asset.get("id") not in used:
            continue
        rel = str(asset.get("path", "")).removeprefix("/public/stickers/")
        file = (WEB / "stickers" / rel).resolve()
        if not file.is_relative_to((WEB / "stickers").resolve()) or not file.is_file():
            continue
        mime = {".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp"}.get(file.suffix.lower())
        if mime:
            sticker_assets.append({**asset, "offlineData": _data_uri(file, mime)})
    data["stickerAssets"] = sticker_assets
    if sticker_assets:
        data["stickerLicenses"] = {name: (WEB / "stickers" / name).read_text(encoding="utf-8")
                                   for name in ("LICENSE-LUCIDE.txt", "LICENSE-CC-BY-SA-4.0.txt")}
    if mobile:  # 笔记、讨论、改过的译文都带上（手机上只读）；原页定位用不上
        data["layout"] = {}
    data.update({"paper": paper, "images": images}, **(extra or {}))
    payload = json.dumps(data, ensure_ascii=False).replace("<", "\\u003c")
    page = page.replace("<!--PR:DATA-->", f'<script id="pr-data" type="application/json">{payload}</script>')
    title = paper.get("meta", {}).get("title_zh") or paper.get("meta", {}).get("title_en") or i18n.tr("论文")
    page = re.sub(r"<title>.*?</title>", f"<title>{htmllib.escape(title)}</title>", page, count=1)

    # Pre-render static readable paper markup into <article id="paper"> so viewers without JS
    # (e.g. Apple Quick Look in Files/AirDrop/Mail on iOS/iPadOS, Android HTMLViewer) render the paper immediately.
    prerendered_html = _prerender_paper(paper, data["reader"], images, mobile=mobile, lang=lang)
    page = re.sub(r'<article id="paper"[^>]*></article>', lambda m: f'{m.group(0)[:-10]}{prerendered_html}</article>', page, count=1)

    # Pre-fill bar-title in header so topbar has title even before JS runs
    page = page.replace('<span class="bar-title"></span>', f'<span class="bar-title">{htmllib.escape(title)}</span>', 1)
    # Hide standalone back button by default
    page = page.replace('<a class="btn brand-back" id="backBtn" href="/" title="回文献库"></a>', '<a class="btn brand-back" id="backBtn" href="/" title="回文献库" style="display:none"></a>', 1)  # i18n-ok

    # Fallback styling when JS is not running (Quick Look / static preview)
    noscript_css = (
        '<noscript>\n<style>\n'
        '#progress, #inkTools, #stickerPanel, #stickerTools, #pageview, #notespanel, #chatpanel, #researchpanel, '
        '#margin, #margin-left, #inkLayer, .seg.view-seg, [data-act="pages"], [data-act="notes"], [data-act="chat"], '
        '[data-act="research"], .save-state, .order-caret, [data-act="drawer"], #scrim, .ink-toggle, #stickerToggle { display: none !important; }\n'
        '#stage { grid-template-columns: 1fr !important; padding-left: 18px !important; padding-right: 18px !important; '
        'width: 100% !important; max-width: 820px !important; margin: 0 auto !important; padding-top: 60px !important; }\n'
        '#paper { grid-column: 1 !important; width: 100% !important; visibility: visible !important; }\n'
        '.bar-titles { display: block !important; flex: 1 !important; }\n'
        '.bar-title { max-width: none !important; font-size: 15px !important; }\n'
        '</style>\n</noscript>\n'
    )
    page = page.replace("</head>", f"{noscript_css}</head>", 1)

    stem = re.sub(r'[\\/:*?"<>|]', "", paper.get("meta", {}).get("short_zh") or paper.get("meta", {}).get("title_zh") or ws.id)
    suffix = i18n.tr("{name}-手机版.html", name=stem) if mobile else i18n.tr("{name}-离线版.html", name=stem)
    out = out or ws.root / suffix
    out.write_text(page, encoding="utf-8")
    return out
