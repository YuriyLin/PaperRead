"""“只读原文”的两段提示词：
- structure：不翻译，只把原页整理成和译文一样的块（段落、标题、公式、表格），文字都放 en；
- fill：之后想看中文了，给已经整理好的块就地补上 zh，块 id 不变，笔记、划线都还挂得住。"""
from __future__ import annotations

import json

from . import langs, links
from .prompts import MATH_RULES, _context, _page_texts, _target_prompt, peek_note, rules
from .store import Workspace

RULES_EN = """整理要求（不翻译）：
- 只把原文整理好，不翻译、不解释、不总结，不加原文没有的内容。原文的笔误照录。
- 保留材料中的 Markdown 链接 [文字](URL)，文字和 URL 原样保留，不猜网址，不把链接移到段落外。
- 本文内部引用写成链接：提到本文有编号的图、表、公式、章节、附录、算法、代码清单时，en 把指代它的文字写成 [文字](#类型:编号)。类型：fig 图，tab 表，eq 公式，sec 章节和附录，alg 算法，lst 代码清单；编号照原文（3、A1、2.1、C.1）。例如 [Figure 3](#fig:3)、Section [3.1](#sec:3.1)、Eqs. [(4)](#eq:4) and [(5)](#eq:5)、[Listing 3](#lst:3)。材料里的 [文字](#) 是 PDF 自己的内部链接，按它指的对象补上类型和编号；没标出的引用也照样写。引用别的论文里的图表不写链接；标题、作者、单位、参考文献条目、题注开头的编号（Figure 1:）里不写。
- 保留粗体和斜体：抽取的文字里 **…** 是原文的粗体，*…* 是斜体，由程序按 PDF 字体标出。en 照录这些标记，成对出现，不放进 $公式$ 和代码；整行加粗的标题、题注开头的编号（Figure 1:）不用标，原文没有的不要自己加。有原页图时以原页为准，补上抽取文字里漏标的。
- 保留原文的阅读顺序、章节编号、引用号 [n]。双栏论文按栏读，断在行尾的连字符单词拼回去。
""" + MATH_RULES + """
- 表格重排成 table 块，数字与公式原样。图使用 figure 块，只保留 page、num 与图注（caption_en / caption_zh）；不要识别、抄写或翻译图内文字，不输出 image_en、image_zh 或裁切框，不截取图片，src 留空。读者将在原 PDF 核对图片。
- 参考文献列表：输出一个 references 块，条目放进 references 数组（text 是原文）。id 是这条的引用键：编号式列表写编号（"13"）；作者-年份式写作者的姓和年份，用连字符连起来，一两位作者写全部的姓，三位及以上只写第一作者的姓，姓里的空格去掉，年份带原文的 a/b 后缀，例如 Jimenez-2024、Chen-Jiang-2025、Chen-2026a、DaSilva-2025、Anthropic-2025；字母标签式写标签（JYW+24）。
- 作者-年份式、字母标签式的文献引用写成链接 [文字](#cite:键)，键和参考文献条目的 id 同一个写法，例如 [Jimenez et al. (2024)](#cite:Jimenez-2024)；括号里有几条就各写一个链接，方括号留在链接外：[[Jimenez et al., 2024](#cite:Jimenez-2024), [Chen and Jiang, 2025](#cite:Chen-Jiang-2025)]。材料里指向参考文献的 [文字](#) 也这样补上键；一处引用被拆成几个 [文字](#)（作者和年份分开链）时合成一个链接。编号式引用照旧写 [13]，不写链接。
- 脚注与参考文献独立：文献引用使用 [13]，脚注标记使用 [^13]（13 换成原编号；符号脚注照原符号写，如 [^*]、[^†]），en/zh 两边保持一致，不要混用。材料里程序已按 PDF 标出的 [^…] 照录在原位。脚注内容单独输出 para 块，加 "role":"footnote","num":"13"（符号脚注写 "num":"*" 这样的原符号），page 填脚注所在页；块的 en/zh 只放脚注正文，不重复编号。脚注不得放入 references 数组，也不能当页脚丢弃。同号文献与脚注可以同时存在；不确定时保留原标记，不猜。标题、作者、单位里不写脚注标记。
- 代码和伪代码用 para 块，en 中用 Markdown 代码围栏包住代码，原样保留缩进、换行和符号；题注放在围栏外。不要输出 code 或 listing 类型，不要在代码里插句子分界 ‖。原文给它编了号（Listing 3、Algorithm 1）时，这块加 "role":"listing" 或 "role":"algorithm" 和 "num":"3"。
- 看不清的地方写“[unclear, see page N]”，不要猜。
- 页眉、页脚、页码、arXiv 侧边水印不要输出。"""

SCHEMA_EN = """输出格式：只输出一个 JSON 对象，不要任何别的文字。
{
  "meta": {"title_en": "", "authors": "作者, 用逗号分隔", "affiliation": "", "date": "", "venue": ""},   // 只有包含第 1 页时才写
  "references": [{"id": "1", "text": "原文条目"}],             // 本批出现参考文献列表时才写
  "blocks": [ ... ]
}
块（每块都要 id、type、page；page 是这块在原 PDF 中开始的页码；文字只写 en，不写 zh）：
- {"id":"p3-2","type":"para","page":3,"en":"原文（行内数学也写成 $TeX$）"}   摘要段落加 "role":"abstract"；紧接在公式后的半句（如 where …）加 "cont": true
- {"id":"s2-1","type":"heading","page":2,"level":1或2,"num":"2.1","en":"Independent questions"}   附录标题加 "appendix": true，摘要标题 num 留空
- {"id":"p2-5","type":"list","page":2,"ordered":true,"items":[{"en":"…"}]}
- {"id":"eq1","type":"math","page":3,"tex":"…","tag":"1"}   没有编号不写 tag；多行用 \\begin{aligned}…\\end{aligned}
- {"id":"tab2","type":"table","page":3,"num":"2","head":[["","Questions","…"]],"rows":[["MATH","5,000","65.5%\\n(0.7%)"]],"align":"lrr","caption_en":"Table 2: …"}
- {"id":"fig1","type":"figure","page":4,"num":"1","src":"","caption_en":"Figure 1: …","caption_zh":"图 1：…"}
- {"id":"refs","type":"references","page":10,"en":"References"}
id 规则：段落 p{页}-{序号}，标题 s{编号，点换成横线}，公式 eq{编号} 或 eq-p{页}-{序号}，表 tab{编号}，图 fig{编号}。
注意 JSON 里 TeX 的反斜杠要写两个（\\\\frac、\\\\text、\\\\bar）。字符串里的英文双引号要转义成 \\"。表格和图放在正文第一次提到它的段落之后。"""


def structure(ws: Workspace, pages: list[int], engine: str, next_head: str, skip_head: bool = False, peek=()) -> str:
    see = ""
    if engine == "claude":
        imgs = "、".join(f"extract/page-{n:03d}.jpg" for n in pages)
        see = f"\n先用 Read 工具看原页图 {imgs}，以原页为准核对公式、表格、上下标和阅读顺序（双栏论文按栏读）。抽取的文字只作参考。"
    elif engine == "attached":
        see = "\n附上了这几页的原页图，以原页为准核对公式、表格和阅读顺序。"
    see += peek_note(engine, pages, list(peek))
    look = ("\n===== 下一页开头（只用来把本批最后一段补完整，其余不要输出）=====\n" + next_head) if next_head else ""
    target = langs.of_paper(ws.load("paper").get("meta"))
    lead = _target_prompt(f"你在把一篇学术论文的 PDF 整理成便于阅读的结构化原文（读者要直接读英文，不要翻译），这次只处理第 {', '.join(map(str, pages))} 页。{see}", target)
    rules_text = _target_prompt(RULES_EN, target)
    schema_text = _target_prompt(SCHEMA_EN, target)
    return (lead + "\n\n" + f"{_context(ws, pages, skip_head=skip_head)}\n\n{rules_text}\n\n{schema_text}\n\n"
            + _page_texts(ws, pages) + look)


def todo(blocks: list[dict]) -> dict[str, object]:
    """这些块里还没有中文的地方：{键: 英文}。键同页面：块 id、id#caption、id#image（图内文字）、id#序号、id#head（表头）。"""
    out: dict[str, object] = {}
    for b in blocks:
        t = b.get("type")
        if t in ("para", "heading") and b.get("en") and not b.get("zh"):
            out[b["id"]] = b["en"]
        elif t == "list":
            for i, it in enumerate(b.get("items", [])):
                if it.get("en") and not it.get("zh"):
                    out[f"{b['id']}#{i}"] = it["en"]
        elif t in ("table", "figure") and b.get("caption_en") and not b.get("caption_zh"):
            out[f"{b['id']}#caption"] = b["caption_en"]
            if t == "table" and b.get("head"):
                out[f"{b['id']}#head"] = b["head"]
    return out


def fill(ws: Workspace, pages: list[int], items: dict[str, object]) -> str:
    """给已经整理好的原文块补译文。"""
    urls = links.ensure(ws)
    records = [link for page in pages for link in urls.get(str(page), [])]
    items = {key: links.insert(value, records) if isinstance(value, str) else value for key, value in items.items()}
    first = 1 in pages
    target = langs.of_paper(ws.load("paper").get("meta"))
    name = langs.prompt_name(target)
    meta = ('  "meta": {"title_zh": "", "short_zh": "' + ("不超过 12 字的短标题" if target in ("zh", "zh-TW") else "不超过 6 个词的短标题") + '"},   // 论文英文标题：'
            + json.dumps(ws.load("paper").get("meta", {}).get("title_en", ""), ensure_ascii=False) + "\n") if first else ""
    lead = _target_prompt(f"你在把一篇学术论文译成{name}。原文已经整理成块，这次只翻译第 {', '.join(map(str, pages))} 页上下面这些键对应的文字。", target)
    head_rule = _target_prompt(f"- 表头（键以 #head 结尾）是二维数组：保持行列数不变，把文字译成{name}，数字和符号原样。", target)
    sentence_rule = _target_prompt(f"- 英文里的 ‖ 是句子分界：译文在对应的句子交界处也插 ‖，个数和这条英文的一样。两句英文在{name}里要合成一句时，也在合并后最接近的位置插上。", target)
    output_rule = _target_prompt("输出格式：只输出一个 JSON 对象，不要任何别的文字。", target)
    glossary = _target_prompt("本批新出现的核心术语", target)
    checks = _target_prompt("原文有问题时才写", target)
    keys_rule = _target_prompt("下面每个键都要有，一个不漏", target)
    tex_rule = _target_prompt("注意 JSON 里 TeX 的反斜杠要写两个（\\\\frac、\\\\text、\\\\bar）。", target)
    content_rule = _target_prompt("要翻译的内容（键 → 英文）：", target)
    return (lead + "\n\n" + f"{_context(ws, pages, new_blocks=False)}\n\n{rules(target)}\n" + head_rule + "\n"
            + (sentence_rule + "\n" if any(isinstance(v, str) and "‖" in v for v in items.values()) else "") + "\n"
            + output_rule + "\n{\n" + meta +
            '  "glossary": [{"en": "standard error", "zh": "' + ("標準誤差" if target == "zh-TW" else "标准误差" if target == "zh" else name + "译名") + '"}],   // ' + glossary + '\n'
            '  "checks": [{"anchor": "块 id", "quote": "译文里相关的几个字（可空）", "title": "一句话：哪里不对", "body": "具体说明和依据"}],   // ' + checks + '\n'
            '  "zh": {"键": "' + name + '译文", …}   // ' + keys_rule + '\n}\n'
            + tex_rule + ("字串內的中文引號請用「」或『』。" if target == "zh-TW" else "字符串里的中文引号用“”或「”。" if target == "zh" else "字符串里的英文双引号要转义。") + "\n\n"
            + content_rule + "\n" + json.dumps(items, ensure_ascii=False, indent=1))
