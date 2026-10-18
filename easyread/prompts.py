"""给模型的提示词：分批翻译、回答用户问题、重译一段。"""
from __future__ import annotations

import json
import re

from . import langs, links, sentences, tables
from .store import Workspace

RULES = """翻译要求：
- 忠实：保留原文的论证顺序、章节编号、公式、表格、引用号 [n]、限定词（may/suggest/likely/at least）、否定和比较对象。可以调整中文语序、拆长句，读起来要像中文母语者写的学术文字。
- 只翻译，不解释、不总结、不加原文没有的内容。原文的笔误照录，不要改。
- 保留材料中的 Markdown 链接 [文字](URL)：原文保留链接文字，译文翻译链接文字，两边 URL 必须原样保留，不猜网址，不把链接移到段落外。
- 但要留心原文自己的问题：数字前后对不上（表和正文、两张表之间）、公式和文字说的不一致、符号用错、明显的笔误。发现了就写进 checks，正文照录不改；没有就不写，不要为了写而写，也不要写翻译说明。
- 术语全文统一；首次出现的核心术语写“中文（English）”。已有术语表必须遵守。统计学里 standard error 译“标准误差”。
- 行内数学一律写成 $TeX$（KaTeX 能渲染的 LaTeX），变量、下标、上标都要用 TeX，不要用 Unicode 拼。行间公式单独成 math 块，照原页重排，原编号放 tag。
- 表格重排成 table 块，数字与公式原样。图使用 figure 块，只保留 page、num 与图注（caption_en / caption_zh）；不要识别、抄写或翻译图内文字，不输出 image_en、image_zh 或裁切框，不截取图片，src 留空。读者将在原 PDF 核对图片。
- 参考文献列表不翻译：输出一个 references 块，条目放进 references 数组（id 是编号，text 是原文）。
- 看不清的地方写“此处识别不清，请核对原文第 N 页”，不要猜。
- 页眉、页脚、页码、arXiv 侧边水印不要输出。"""

SCHEMA = """输出格式：只输出一个 JSON 对象，不要任何别的文字。
{
  "meta": {"title_zh": "", "short_zh": "不超过 12 字的短标题", "title_en": "", "authors": "作者, 用逗号分隔", "affiliation": "", "date": "", "venue": ""},   // 只有包含第 1 页时才写
  "glossary": [{"en": "standard error", "zh": "标准误差"}],   // 本批新出现的核心术语
  "references": [{"id": "1", "text": "原文条目"}],             // 本批出现参考文献列表时才写
  "checks": [{"anchor": "块 id", "quote": "译文里相关的几个字（可空）", "title": "一句话：哪里不对", "body": "具体说明和依据，比如算一遍给出对得上的数"}],   // 原文有问题时才写
  "blocks": [ ... ]
}
块（每块都要 id、type、page；page 是这块在原 PDF 中开始的页码）：
- {"id":"p3-2","type":"para","page":3,"en":"英文原文第一句. ‖ Second sentence（行内数学也写成 $TeX$）.","zh":"中文译文第一句。‖第二句。"}   摘要段落加 "role":"abstract"；紧接在公式后的半句（如 where …）加 "cont": true
- {"id":"s2-1","type":"heading","page":2,"level":1或2,"num":"2.1","en":"Independent questions","zh":"相互独立的题目"}   附录标题加 "appendix": true，摘要标题 num 留空
- {"id":"p2-5","type":"list","page":2,"ordered":true,"items":[{"en":"…","zh":"…"}]}
- {"id":"eq1","type":"math","page":3,"tex":"…","tag":"1"}   没有编号不写 tag；多行用 \\begin{aligned}…\\end{aligned}
- {"id":"tab2","type":"table","page":3,"num":"2","head":[["","题目数","…"]],"rows":[["MATH","5,000","65.5%\\n(0.7%)"]],"align":"lrr","caption_en":"Table 2: …","caption_zh":"表 2：…"}
- {"id":"fig1","type":"figure","page":4,"num":"1","src":"","caption_en":"Figure 1: …","caption_zh":"图 1：…"}
- {"id":"refs","type":"references","page":10,"zh":"参考文献","en":"References"}
句子对齐：para 和 list 的每一项，en 和 zh 都在两边对应的句子交界处各插一个 ‖，两边 ‖ 个数必须相同。只在两边都断句的地方插：中文把两句英文合成一句时，这两句英文之间不插；一句英文拆成两句中文时，这两句中文之间也不插。只有一句就不插。‖ 不要放进 $公式$ 里，标题、表格、图、题注都不插。
id 规则：段落 p{页}-{序号}，标题 s{编号，点换成横线}，公式 eq{编号} 或 eq-p{页}-{序号}，表 tab{编号}，图 fig{编号}。
注意 JSON 里 TeX 的反斜杠要写两个（\\\\frac、\\\\text、\\\\bar）。字符串里的中文引号用“”或「」，不要出现没转义的英文双引号 "。表格和图放在正文第一次提到它的段落之后。"""


# 译成中文以外的语言时，把只适用于中文的说法换掉；中文的提示词保持原样
_RULES_SWAP = [
    ("可以调整中文语序、拆长句，读起来要像中文母语者写的学术文字。", "可以调整语序、拆长句，读起来要像{L}母语者写的学术文字。"),
    ("首次出现的核心术语写“中文（English）”。已有术语表必须遵守。统计学里 standard error 译“标准误差”。", "首次出现的核心术语写“{L}译名（English）”。已有术语表必须遵守。"),
    ("表头译成中文", "表头译成{L}"),
    ("看不清的地方写“此处识别不清，请核对原文第 N 页”", "看不清的地方写“[unclear, see page N]”"),
]
_SCHEMA_SWAP = [
    ("中文把两句英文合成一句时，这两句英文之间不插；一句英文拆成两句中文时，这两句中文之间也不插。", "译文把两句英文合成一句时，这两句英文之间不插；一句英文拆成两句译文时，这两句译文之间也不插。"),
    ('"short_zh": "不超过 12 字的短标题"', '"short_zh": "不超过 6 个词的短标题"'),
    ('{"en": "standard error", "zh": "标准误差"}', '{"en": "standard error", "zh": "{L}译名"}'),
    ('"zh":"中文译文第一句。‖第二句。"', '"zh":"{L}译文 … ‖ …"'),
    ('"zh":"相互独立的题目"', '"zh":"…"'),
    ('"head":[["","题目数","…"]]', '"head":[["","…","…"]]'),
    ('"caption_zh":"表 2：…"', '"caption_zh":"…"'),
    ('"caption_zh":"图 1：…"', '"caption_zh":"…"'),
    ('"zh":"参考文献"', '"zh":"…"'),
    ('字符串里的中文引号用“”或「」，不要出现没转义的英文双引号 "。', '字符串里的英文双引号要转义成 \\"。'),
]


def _swap(text: str, pairs, target: str) -> str:
    if target == "zh":
        return text
    name = langs.prompt_name(target)
    for a, b in pairs:
        text = text.replace(a, b.replace("{L}", name))
    return text


def rules(target: str = "zh") -> str:
    if target == "zh-TW":
        return RULES + "\n- 所有譯文欄位一律使用繁體中文與臺灣學術用語；保留模型、資料集及指標的英文名稱，不可使用簡體字。"
    if target == "zh":
        return RULES
    name = langs.prompt_name(target)
    return (_swap(RULES, _RULES_SWAP, target) +
            f"\n- 译文语言是{name}：zh、caption_zh、image_zh、title_zh 这些字段名是历史叫法，里面一律写{name}，不要写中文。")


def schema(target: str = "zh") -> str:
    return _swap(SCHEMA, _SCHEMA_SWAP, target)


_NOTE = re.compile(r"^\s*(\$\^|[¹²³⁴⁵⁶⁷⁸⁹*†‡]|\d{1,2}\s*https?:)|^\S*https?://\S*\s*$")
# 不带上标、直接写成 “3 That is, …” 的脚注（DeepSeek 常这么写）：开头 1–2 位数字接大写单词，块又很短
_NOTE_PLAIN = re.compile(r"^\s*\d{1,2}\s?[A-Z][a-z]")


def _is_note(b: dict) -> bool:
    text = b.get("en") or ""
    if _NOTE.search(text):
        return True
    return b.get("type") != "heading" and bool(_NOTE_PLAIN.match(text)) and len(text.split()) < 40


_ENDS = (".", "?", "!", ":", ";", "。", "？", "！", "：", ")", "]", "\"", "”", "’")


def _context(ws: Workspace, pages: list[int], new_blocks: bool = True, skip_head: bool = False) -> str:
    """new_blocks=False：只给已有的块补译文（只读原文之后再翻译），不用提块 id 和上一批的续文。
    skip_head：上一页由另一段同时在译（分段并行的交界），跨页那段由它补完整，这批跳过页首续文。"""
    paper = ws.load("paper")
    meta = paper.get("meta", {})
    blocks = paper.get("blocks", [])
    lines = [f"论文：{meta.get('title_en') or meta.get('source', '')}，共 {meta.get('page_count', '?')} 页。"]
    gl = paper.get("glossary", [])
    if gl:
        lines.append("已有术语表（必须沿用）：" + "；".join(f"{g['en']} = {g['zh']}" for g in gl))
    heads = [f"{b.get('num', '')} {b.get('zh') or b.get('en', '')}".strip() for b in blocks if b.get("type") == "heading"]
    if heads:
        lines.append("已有的章节：" + " / ".join(heads))
    if not new_blocks:
        return "\n".join(lines)
    ids = [b["id"] for b in blocks]
    if ids:
        lines.append("已用过的块 id（不要重复）：" + ", ".join(ids[-60:]))
    if skip_head:
        p = pages[0]
        lines.append(f"第 {p - 1} 页由另一批负责（同时在译，或者稍后重试），从第 {p - 1} 页跨到第 {p} 页的那一段由它补完整。"
                     f"所以第 {p} 页开头如果是接着上一页没写完的句子（不是新段落或新标题的开头），这半段不要输出，"
                     f"从第 {p} 页第一个新段落、标题、公式或图表开始。")
        return "\n".join(lines)
    # 只看紧挨着的前两页：再往前的段落不可能续到本批（分段并行时更早的页可能是别的段译的）
    # 脚注不算：模型常把脚注排在页的最后一块，拿它当“上一段”会让下一批误把页首正文当续文跳过
    near = [b for b in blocks if pages[0] - 2 <= (b.get("page") or 0) < pages[0] and not _is_note(b)]
    prev = next((b for b in reversed(near) if b.get("en") and b.get("type") != "references"), None)
    if prev:
        end = prev["en"].rstrip()
        lines.append(f"上一批最后一段（{prev['id']}，第 {prev['page']} 页）的英文结尾：……{end[-300:]}")
        # 只有最后一块就是这个段落、而且停在半句时才算没补完；后面跟着标题的，那段已经结束了
        tail = end[:-1].rstrip() if end.endswith("$") and end.count("$") % 2 == 0 else end  # “…$x=1.$”看公式里面的句号
        last = near[-1]
        if last is not prev and last.get("type") in ("math", "table", "figure"):
            # 上一页以公式、表、图结尾：本页开头常是公式后面接着的半句（where …、“… independent questions.”），
            # 它不是上一段的续文，上一批也不会译它
            lines.append(f"上一页最后是{'公式' if last.get('type') == 'math' else '图表'}（{last['id']}）。本批第一页开头如果是接在它后面的文字"
                         "（比如公式后的 where …，或者公式前那句话的后半句），要译出来：单独成一段，紧接公式的加 \"cont\": true。")
        elif last is not prev or prev.get("type") != "para" or tail.endswith(_ENDS) or end.endswith("$$"):
            lines.append("如果本批第一页开头是这一段的续文，不要再输出这段续文。")
        else:  # 上一批没能把这段补完（下一页开头的抽取文字里常先排着表格、公式），续文得由这批译
            lines.append("这一段在上一批停在了半句，没有补完。本批第一页开头接着这段的续文要译出来：单独成一段并加 \"cont\": true，"
                         "从续文的第一个词开始，不要重复上一批已经译了的部分。")
    return "\n".join(lines)


def _page_texts(ws: Workspace, pages: list[int]) -> str:
    texts = []
    urls = links.ensure(ws)
    for n in pages:
        p = ws.root / "extract" / f"page-{n:03d}.txt"
        text = p.read_text(encoding="utf-8") if p.exists() else ""
        texts.append(f"===== 第 {n} 页（抽取的文字，公式和表格可能是乱的）=====\n" + links.insert(text, urls.get(str(n), [])))
    return "\n\n".join(texts)


def peek_note(engine: str, pages: list[int], peek: list[int]) -> str:
    """分段并行的交界：两边的批次都看一眼相邻那页的原页图，按同一张图判断跨页那段在哪结束。
    只靠抽取文字不行：下一页的抽取文字常常先排着表格或图，开头 1500 字里可能根本没有那段的后半句。"""
    if engine not in ("claude", "attached"):
        return ""
    out = []
    if engine == "attached" and peek:  # 附图不带页码：说清楚顺序（translate 里按页码排好了）
        out.append("附上的原页图按页码排，依次是第 " + "、".join(map(str, sorted({*pages, *peek}))) + " 页。")
    for n in peek:
        img = f"Read 看 extract/page-{n:03d}.jpg" if engine == "claude" else f"看附上的第 {n} 页原页图"
        if n > pages[-1]:
            out.append(f"另外用 {img} 的开头：只用来把本批最后一段补完整（那段可能接着写到第 {n} 页，页首也可能先排着表格或图），第 {n} 页其余内容不要输出。")
        else:
            out.append(f"另外用 {img} 的末尾：只用来判断第 {pages[0]} 页开头哪些是第 {n} 页那段的续文，第 {n} 页的内容不要输出。")
    return "\n" + "\n".join(out) if out else ""


def translate(ws: Workspace, pages: list[int], engine: str, next_head: str, skip_head: bool = False, peek=(), front: str = "") -> str:
    """front：分段并行时每段第一批的前文参考（见 front_context）。"""
    look = ""
    if next_head:
        look = ("\n===== 下一页开头（只用来把本批最后一段补完整，其余不要翻译）=====\n" + next_head)
    see = ""
    if engine == "claude":
        imgs = "、".join(f"extract/page-{n:03d}.jpg" for n in pages)
        see = f"\n先用 Read 工具看原页图 {imgs}，以原页为准核对公式、表格、上下标和阅读顺序（双栏论文按栏读）。抽取的文字只作参考。"
    elif engine == "attached":
        see = "\n附上了这几页的原页图，以原页为准核对公式、表格和阅读顺序。"
    see += peek_note(engine, pages, list(peek))
    target = langs.of_paper(ws.load("paper").get("meta"))
    return (f"你在把一篇学术论文译成{langs.prompt_name(target)}，这次只处理第 {', '.join(map(str, pages))} 页。{see}\n\n"
            f"{_context(ws, pages, skip_head=skip_head)}\n\n{rules(target)}\n\n{schema(target)}\n\n" + (front + "\n\n" if front else "")
            + _page_texts(ws, pages) + look)


def consistency(items: list[dict], agree: dict[str, int], target_name: str) -> str:
    """译完后的术语一致性检查（见 consistency.py）：模型只判断用哪个说法、每段里哪个是另一种说法，不改写段落。"""
    terms = {}
    for it in items:
        for t in it["terms"]:
            terms[t["en"]] = {"术语表译法": t["want"], "全文用了术语表译法的段数": agree.get(t["en"], 0)}
    rows = [{"key": it["key"], "terms": [t["en"] for t in it["terms"]], "en": it["en"], "zh": it["zh"]} for it in items]
    return (f"下面是一篇学术论文{target_name}译文里术语可能不统一的地方。terms 里是英文术语、术语表登记的译法、全文有几段用了这个译法；"
            "passages 是原文出现了这个术语、译文里却没用术语表译法的段落。只做判断，不要改写段落：\n"
            "1. use：给每个术语定一个全文统一用的译法。看全文多数段落怎么译、哪个说法在这个领域最通行，不一定是术语表登记的那个。\n"
            "2. fixes：逐段看，这段把术语译成了别的说法时，写出这段译文里那个说法的原样（from，必须是这段 zh 里一字不差的连续文字，"
            "只包含术语本身的译法，不带前后的字）。合理的省略、代词、缩写，或者这里的英文不是那个术语的意思，就不写这段。\n"
            '只输出一个 JSON 对象，不要任何别的文字：{"use": {"英文术语": "定下的译法"}, '
            '"fixes": [{"key": "段的 key", "term": "英文术语", "from": "这段里的另一种说法"}]}\n\n'
            + json.dumps({"terms": terms, "passages": rows}, ensure_ascii=False, indent=1))


def repair(original_json: str, problems: list[str]) -> str:
    return ("下面这份论文翻译 JSON 有问题，请修好后输出完整的 JSON（格式不变，只输出 JSON）：\n"
            + "\n".join(f"- {p}" for p in problems[:30]) + "\n\nJSON：\n" + original_json)


def _block_text(b: dict) -> str:
    """块的正文：有译文用译文，只读原文、还没译的块用英文。"""
    if b.get("type") == "list":
        return "\n".join(f"- {it.get('zh') or it.get('en', '')}" for it in b.get("items", []))
    if b.get("type") == "table" and tables.is_bilingual(b):
        return tables.context(b)
    if b.get("type") in ("table", "figure"):
        return "\n".join(filter(None, [b.get("caption_zh") or b.get("caption_en", ""), b.get("image_zh") or b.get("image_en", "")]))
    if b.get("type") == "math":
        return f"$${b.get('tex', '')}$$"
    return b.get("zh") or b.get("en", "")


def answer(ws: Workspace, note: dict) -> str:
    paper = ws.load("paper")
    blocks = paper.get("blocks", [])
    idx = next((i for i, b in enumerate(blocks) if b.get("id") == note.get("anchor")), None)
    near = blocks[max(0, idx - 3): idx + 3] if idx is not None else blocks[:6]
    section = ""
    if idx is not None:
        h = next((b for b in reversed(blocks[:idx + 1]) if b.get("type") == "heading"), None)
        section = f"{h.get('num', '')} {h.get('zh') or h.get('en', '')}" if h else ""
    ctx = "\n\n".join(f"[{b['id']}] {_block_text(b)}" for b in near)
    focus = blocks[idx] if idx is not None else {}
    by_id = {b.get("id"): b for b in blocks}
    for part in note.get("parts") or [note]:
        table = by_id.get(part.get("anchor")) or {}
        if table.get("type") == "table" and "#cell:" in str(part.get("key", "")):
            ctx += "\n\n" + tables.context(table, part["key"], part.get("table_source", ""), include_table=False)
    return (f"你正在和讀者一起閱讀論文《{paper.get('meta', {}).get('title_zh') or paper.get('meta', {}).get('title_en')}》。"
            f"讀者讀到「{section}」時在 [{note.get('anchor')}] 這段提出一個問題。\n\n"
            f"上下文（譯文；尚未翻譯的段落是英文原文）：\n{ctx}\n\n這段英文原文：{focus.get('en', '')}\n\n"
            + (f"讀者選取的{'英文原文' if note.get('side') == 'en' else '原話'}：「{note.get('quote')}」\n" if note.get("quote") else "")
            + f"讀者的問題：{note.get('body', '')}\n\n"
            "需要時可以使用 Read 讀取目前目錄的 paper.json 查看全文。請直接回答：" + langs.reply_language_rule(paper.get("meta")) + "，具體、講清楚，能舉例就舉例，"
            "區分「論文裡寫了什麼」和「你的補充解釋」。行內公式使用 $TeX$，段落之間空一行。只輸出回答正文，不要客套。")


def retranslate(ws: Workspace, key: str, hint: str) -> tuple[str, tuple | None]:
    """返回（提示词，段落和列表项的（英文, 句尾）或 None）：英文按句插好 ‖，新译文照着插，重译后句子还对得上。"""
    links.refresh(ws)
    paper = ws.load("paper")
    bid, _, field = key.partition("#")
    blocks = paper.get("blocks", [])
    idx = next(i for i, b in enumerate(blocks) if b.get("id") == bid)
    b = blocks[idx]
    if field == "caption":
        en, zh = b.get("caption_en", ""), b.get("caption_zh", "")
    elif field == "image":
        en, zh = b.get("image_en", ""), b.get("image_zh", "")
    elif field.isdigit():
        en, zh = b["items"][int(field)].get("en", ""), b["items"][int(field)].get("zh", "")
    else:
        en, zh = b.get("en", ""), b.get("zh", "")
    src = b["items"][int(field)] if field.isdigit() else b
    ends = None
    if (b.get("type") == "para" and not field) or (b.get("type") == "list" and field.isdigit()):
        marked, cut = sentences.mark_en(en, src.get("sents") if sentences.valid(src) else None)
        if cut:
            en, ends = marked, (src.get("en", ""), cut)
    near = "\n".join(_block_text(x) for x in blocks[max(0, idx - 2): idx + 3] if x is not b)
    gl = "；".join(f"{g['en']} = {g['zh']}" for g in paper.get("glossary", []))
    target = langs.of_paper(paper.get("meta"))
    return (f"请重新翻译论文里的一段，译成{langs.prompt_name(target)}。\n{rules(target)}\n\n术语表：{gl}\n\n前后文（译文）：\n{near}\n\n"
            f"英文原文：\n{en}\n\n现在的译文：\n{zh}\n\n"
            + (f"读者觉得不好的地方：{hint}\n\n" if hint else "")
            + ("英文里的 ‖ 是句子分界：新译文在对应的句子交界处也插 ‖，个数和英文的一样。\n\n" if ends else "")
            + '只输出 JSON：{"zh": "新译文"}'), ends


def dump(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=1)
