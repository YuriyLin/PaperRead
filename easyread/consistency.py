"""全文译完后的术语一致性检查：同一个英文术语在译文里用了不同说法时，定一个说法，把其余的统一过来。

合并时的统一（terms.unify）只管模型自己报进术语表的冲突；这里看全文实际的译文。
程序先筛出“原文有这个术语、译文里却没有术语表译法”的段落（没有就不调模型），连同术语表译法在全文用了几段，
一起发给模型（只看文字不看图）。模型只做判断：每个术语全文用哪个说法（use，按多数用法和领域通行说法，
不一定是先登记的那个），以及每段里哪个说法是这个术语的另一种译法（from）。
改文字由程序做，不让模型重写段落：只把 from 换成 use，而且只在这段里 from 出现的次数和英文术语出现的次数一样时才换
（对不上说明这个说法还有别的意思，比如“标准偏差”里的“偏差”），公式里不换，包含它的其他术语译法先护住。
定下的译法和术语表不同时，术语表改过来，全文原来用术语表译法的段落按同样的规则换掉。
块 id 不变，笔记挂得住；用户改过的译文不动；句子对齐跟着挪；每处改动记进 job.log。
"""
from __future__ import annotations

import difflib
import re

from . import codeblocks, engines, langs, prompts, sentences
from .i18n import tr
from .terms import _MATH, _mentions, _swap, mentions_count, occurrences

LIMIT = 60          # 一次最多检查几段
_PAREN = re.compile(r"[（(].*?[）)]")  # i18n-ok


def _fields(b: dict):
    """(键, 英文, 译文)：键同页面上的写法（块 id、id#序号、id#caption）。"""
    t = b.get("type")
    if t in ("para", "heading"):
        yield b["id"], str(b.get("en") or ""), str(b.get("zh") or "")
    elif t == "list":
        for i, it in enumerate(b.get("items") or []):
            if isinstance(it, dict):
                yield f"{b['id']}#{i}", str(it.get("en") or ""), str(it.get("zh") or "")
    elif t in ("table", "figure"):
        yield f"{b['id']}#caption", str(b.get("caption_en") or ""), str(b.get("caption_zh") or "")


def _plain(zh: str) -> str:
    return " ".join(_MATH.split(codeblocks.prose(zh))[0::2])  # 公式外的文字


def _has(zh: str, want: str) -> bool:
    return want.lower() in _plain(zh).lower()


def _clean(zh) -> str:
    return _PAREN.sub("", str(zh or "")).strip()


def _rules(paper: dict) -> list[tuple[str, str]]:
    out = []
    for g in paper.get("glossary") or []:
        if isinstance(g, dict):
            en, want = str(g.get("en") or "").strip(), _clean(g.get("zh"))
            if len(en) >= 3 and len(want) >= 2 and want.lower() != en.lower():
                out.append((en, want))
    return out


def _skip(key: str, edited: set[str]) -> bool:
    return key in edited or key.partition("#")[0] in edited


def suspects(paper: dict, edited: set[str], pages: set[int] | None = None) -> tuple[list[dict], dict[str, int]]:
    """（可疑的地方 [{key, page, en, zh, terms: [{en, want}]}]，{术语: 全文用了术语表译法的段数}）。
    pages：可疑的地方只找这些页；用了几段按全文算。"""
    rules = _rules(paper)
    out, agree = [], {}
    for b in paper.get("blocks") or []:
        for key, en, zh in _fields(b):
            if not zh or _skip(key, edited):
                continue
            miss = []
            for t, w in rules:
                if _mentions(en, t):
                    if _has(zh, w):
                        agree[t] = agree.get(t, 0) + 1
                    else:
                        miss.append({"en": t, "want": w})
            if miss and (pages is None or b.get("page") in pages):
                out.append({"key": key, "page": b.get("page"), "en": en, "zh": zh, "terms": miss})
    return out[:LIMIT], agree


def swap(zh: str, en_text: str, term: str, old: str, use: str, keep: list[str]) -> str | None:
    """把这段里的 old 换成 use。old 在公式外出现的次数（去掉护住的说法后）要和英文术语出现的次数一样，否则不换，返回 None。"""
    if not old or old == use or len(old) > 3 * max(2, len(use)):
        return None
    guard = sorted({k for k in keep + [use] if old in k and k != old}, key=len, reverse=True)
    n = occurrences(zh, old, guard)
    if n == 0 or n != mentions_count(en_text, term):
        return None
    new = _swap(zh, [(old, use, guard)])
    if _doubled(new, use) and not _doubled(zh, use):  # “监督微调（SFT）”换成 SFT 会变成“SFT（SFT）”
        return None
    return new if new != zh else None


def _doubled(text: str, use: str) -> bool:
    return bool(re.search(re.escape(use) + r"\s*[（(]\s*" + re.escape(use) + r"\s*[)）]", text))  # i18n-ok 全角括号


def resent(obj: dict | None, old: str, new: str) -> list | None:
    """译文只换了术语：把句子对齐（sents，UTF-16 位置）跟着挪过去。句界落在改动里面就放弃，页面按整段对应。"""
    if not obj or not sentences.valid(obj):
        return None
    to16 = [0]
    for c in old:
        to16.append(to16[-1] + sentences.u16(c))
    py = {v: i for i, v in enumerate(to16)}
    ops = difflib.SequenceMatcher(None, old, new, autojunk=False).get_opcodes()

    def move(p16):
        p = py.get(p16)
        for tag, i1, i2, j1, j2 in ops if p is not None else ():
            if tag == "equal" and i1 <= p <= i2:
                return sentences.u16(new[:p - i1 + j1])
        return None

    out = []
    for en_end, zh_end in obj["sents"][:-1]:
        z = move(zh_end)
        if z is None:
            return None
        out.append([en_end, z])
    return out + [[obj["sents"][-1][0], sentences.u16(new)]]


def _rewrite(ws, changes: dict[str, tuple[str, str]], edited: set[str]) -> list[str]:
    """一次写入里把 {键: (旧译文, 新译文)} 改好：这段在检查期间被改过（重译、用户改译文）就跳过。返回改成了的键。"""
    done = []

    def apply(paper):
        for b in paper.get("blocks") or []:
            for key, _, zh in _fields(b):
                if key not in changes or _skip(key, edited) or changes[key][0] != zh:
                    continue
                new = changes[key][1]
                field = key.partition("#")[2]
                if field == "caption":
                    b["caption_zh"] = new
                    continue
                obj = b["items"][int(field)] if field.isdigit() else b
                s = resent(obj, zh, new)
                obj["zh"] = new
                if s:
                    obj["sents"] = s
                else:
                    obj.pop("sents", None)
                done.append(key)
    ws.update("paper", apply)
    return done


def check(ws, cfg: dict, pages: list[int], cancel, meter, journal, lock) -> int:
    """跑一遍检查并改好，返回改了几段。lock：翻译用的合并锁。pages 不是全文时只改这些页，术语表不动。"""
    def edited_now() -> set[str]:
        reader = ws.load("reader") or {}
        return {k for k, v in (reader.get("edits") or {}).items() if isinstance(v, dict) and v.get("zh")}

    paper = ws.load("paper")
    in_job = set(pages)
    items, agree = suspects(paper, edited_now(), in_job)
    whole = in_job >= {b.get("page") for b in paper.get("blocks") or [] if b.get("page")}
    if not items:
        journal(ws, "Terminology consistency check: no inconsistencies found")
        return 0
    name = langs.prompt_name(langs.of_paper(paper.get("meta")))
    data = engines.parse_json(engines.run(cfg, prompts.consistency(items, agree, name), ws.root, None, cancel, meter))
    data = data if isinstance(data, dict) else {}
    asked = {t["en"]: t["want"] for it in items for t in it["terms"]}
    use = {en: _clean(v) for en, v in (data.get("use") or {}).items() if en in asked and len(_clean(v)) >= 2}
    # 统一成纯英文缩写（supervised fine-tuning → SFT）不算译法，不换；保留原词（Transformer）的照常
    use = {en: u for en, u in use.items() if not (u.isascii() and u.lower() != en.lower() and not asked[en].isascii())}
    by_key = {it["key"]: it for it in items}
    with lock:
        paper = ws.load("paper")
        edited = edited_now()
        keep = [_clean(g.get("zh")) for g in paper.get("glossary") or [] if isinstance(g, dict)]
        changes, why = {}, {}
        texts = {key: (en, zh) for b in paper.get("blocks") or [] for key, en, zh in _fields(b)}
        # 定下的说法和术语表不同：全文（只译了一部分时不动术语表，只改这次的页）原来用术语表说法的段落换过来
        for en, u in use.items():
            old = asked[en]
            if u == old:
                continue
            for b in paper.get("blocks") or []:
                if not whole and b.get("page") not in in_job:
                    continue
                for key, en_text, zh in _fields(b):
                    cur = changes.get(key, (zh, zh))[1]
                    if _mentions(en_text, en) and _has(cur, old) and not _skip(key, edited):
                        new = swap(cur, en_text, en, old, u, keep)
                        if new:
                            changes[key] = (zh, new)
                            why.setdefault(key, []).append(f"{old} → {u}")
        for f in data.get("fixes") or []:
            it = by_key.get(str(f.get("key"))) if isinstance(f, dict) else None
            term = str(f.get("term") or "") if it else ""
            if not it or term not in {t["en"] for t in it["terms"]}:
                continue
            u = use.get(term, asked[term])
            src = str(f.get("from") or "").strip()
            en_text, zh = texts.get(it["key"], ("", None))
            if zh != it["zh"]:
                continue  # 检查期间这段被重译了
            cur = changes.get(it["key"], (zh, zh))[1]
            new = swap(cur, en_text, term, src, u, keep) if src in cur else None
            if new:
                changes[it["key"]] = (zh, new)
                why.setdefault(it["key"], []).append(f"{src} → {u}")
        done = _rewrite(ws, changes, edited) if changes else []
        if whole:
            renamed = {en: u for en, u in use.items() if u != asked[en]}

            def regloss(p):
                for g in p.get("glossary") or []:
                    if isinstance(g, dict) and str(g.get("en") or "").strip() in renamed:
                        g["zh"] = renamed[str(g["en"]).strip()]
            ws.update("paper", regloss)
    page_of = {key: b.get("page") for b in paper.get("blocks") or [] for key, _, _ in _fields(b)}
    for key in done:
        journal(ws, f"Terminology consistency: Page {page_of.get(key)} {key} {', '.join(why[key])}")
    journal(ws, f"Terminology consistency check: checked {len(items)} sections, updated {len(done)} sections")
    return len(done)
