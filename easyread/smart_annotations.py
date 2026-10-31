"""AI 智慧標註：產生可驗證的待確認候選，接受後才寫入既有 notes。"""
from __future__ import annotations

import hashlib
import json
import re
import threading
from collections import defaultdict

from .i18n import tr
from .prompts import _block_text
from .store import Workspace, now_iso, text_hash


ANNOTATION_TYPES = {"highlight", "underline"}
COLORS = {"yellow", "green", "blue", "red", "pink"}

HIGHLIGHT_SEMANTICS = {
    "yellow": ("核心主張", "標記完整的重要句子、核心貢獻與主要論點（建議 15～90 字）"),  # i18n-ok: prompt
    "green": ("方法與證據", "標記研究方法設計、技術流程與關鍵實驗結果（建議 15～90 字）"),  # i18n-ok: prompt
    "blue": ("背景知識", "標記重要研究背景、問題定義與基本假設（建議 15～90 字）"),  # i18n-ok: prompt
    "red": ("研究限制", "標記研究問題、方法瓶頸與適用限制（建議 15～90 字）"),  # i18n-ok: prompt
}

UNDERLINE_SEMANTICS = {
    "yellow": ("關鍵詞", "標記核心概念、模型名稱與專有名詞（建議 2～30 字，勿標普通單詞）"),  # i18n-ok: prompt
    "green": ("數據指標", "標記具體數值、改善幅度與統計評估指標（建議 2～30 字）"),  # i18n-ok: prompt
    "blue": ("引用來源", "標記重要作者、理論名稱、基準模型與文獻引用（建議 2～30 字）"),  # i18n-ok: prompt
    "red": ("疑點與風險", "標記不確定性推論、異常現象或潛在矛盾語句（建議 4～35 字）"),  # i18n-ok: prompt
}

INTENSITY_MODES = {
    "concise": {
        "label": "精簡",  # i18n-ok: prompt
        "chars_per_item": 500,
        "min_items": 4,
        "max_items": 10,
        "guide": "【精簡模式（快速閱讀）】每段只保留最有價值的核心資訊（每段約 0～2 處），優先標記最關鍵的核心主張螢光筆與最重要的關鍵詞／數據底線，寧精勿多。",  # i18n-ok: prompt
    },
    "standard": {
        "label": "標準",  # i18n-ok: prompt
        "chars_per_item": 260,
        "min_items": 8,
        "max_items": 18,
        "guide": "【標準模式（一般研究）】保留各類重要資訊（每段約 1～3 處），均衡運用螢光筆（標記核心主張、方法證據、重要背景、研究限制的完整句子）與底線筆（標記句中關鍵詞、數據指標、引用來源、疑點風險）。",  # i18n-ok: prompt
    },
    "detailed": {
        "label": "詳細",  # i18n-ok: prompt
        "chars_per_item": 160,
        "min_items": 14,
        "max_items": 28,
        "guide": "【詳細模式（深入研究）】全面保留主次要證據與技術細節（每段約 2～5 處），除完整論點與方法實驗句子用螢光筆外，積極使用底線筆標出文中所有重要專有名詞、實驗數據指標、基準方法／文獻引用與假設限制。",  # i18n-ok: prompt
    },
}

MAX_CANDIDATES = 250
CHUNK_CHARS = 4500


def _section_label(block: dict, current: dict | None) -> str:
    if current:
        return " ".join(filter(None, [str(current.get("num") or "").strip(), current.get("zh") or current.get("en") or ""]))
    return tr("論文開頭")


def _sources(paper: dict, reader: dict | None = None) -> list[dict]:
    out = []
    current = None
    edits = (reader or {}).get("edits") or {}

    def _edit_zh(key: str) -> str | None:
        entry = edits.get(key)
        if isinstance(entry, dict) and entry.get("zh") is not None and not entry.get("reverted"):
            return str(entry.get("zh") or "").strip()
        return None

    for block in paper.get("blocks", []) or []:
        btype = block.get("type")
        if btype in ("heading", "references"):
            current = block
            continue
        if btype in ("note", "math"):
            continue
        bid = str(block.get("id") or "")
        if not bid:
            continue
        sec_label = _section_label(block, current)
        sec_id = str(current.get("id") or "") if current else ""
        page = block.get("page")
        role = str(block.get("role") or "")
        if btype == "list":
            items = block.get("items")
            if not items:
                items_en = block.get("items_en") or []
                items_zh = block.get("items_zh") or []
                max_len = max(len(items_en), len(items_zh))
                items = [{"en": items_en[i] if i < len(items_en) else "",
                          "zh": items_zh[i] if i < len(items_zh) else ""}
                         for i in range(max_len)]
            for idx, item in enumerate(items or []):
                if isinstance(item, str):
                    item = {"en": item, "zh": item}
                elif not isinstance(item, dict):
                    continue
                key = f"{bid}#{idx}"
                edited = _edit_zh(key)
                zh = edited if edited is not None else str(item.get("zh") or "").strip()
                en = str(item.get("en") or "").strip()
                text = (zh or en).strip()
                if not text:
                    continue
                out.append({
                    "anchor": bid, "key": key, "page": page, "section": sec_label, "section_id": sec_id,
                    "role": role, "zh": zh or text, "en": en, "sents": item.get("sents"), "text": text,
                })
            continue
        if btype in ("table", "figure"):
            key = f"{bid}#caption"
            edited = _edit_zh(key)
            zh = edited if edited is not None else str(block.get("caption_zh") or "").strip()
            en = str(block.get("caption_en") or "").strip()
            text = (zh or en).strip()
            if not text:
                continue
            out.append({
                "anchor": bid, "key": key, "page": page, "section": sec_label, "section_id": sec_id,
                "role": role, "zh": zh or text, "en": en, "sents": block.get("sents"), "text": text,
            })
            continue
        key = bid
        edited = _edit_zh(key)
        zh = edited if edited is not None else str(block.get("zh") or "")
        en = str(block.get("en") or "")
        text = _block_text(block).strip()
        if not text and not zh:
            continue
        out.append({
            "anchor": bid, "key": bid, "page": page, "section": sec_label, "section_id": sec_id,
            "role": role, "zh": str(zh or text), "en": en,
            "sents": block.get("sents") if btype == "para" else None, "text": text or zh,
        })
    return [x for x in out if x["anchor"]]


def _selected_sources(paper_or_sources: dict | list[dict], scope_or_sections: str | list[str] = "all", section_id: str = "", reader: dict | None = None) -> list[dict]:
    if isinstance(paper_or_sources, list):
        sources = paper_or_sources
        if isinstance(scope_or_sections, list):
            target_ids = set(scope_or_sections)
            return [x for x in sources if x.get("section_id") in target_ids or x.get("anchor") in target_ids] or sources
    else:
        sources = _sources(paper_or_sources, reader)
    scope = scope_or_sections if isinstance(scope_or_sections, str) else "all"
    if scope != "section" or not section_id:
        return sources
    by_sec = [x for x in sources if x.get("section_id") == section_id]
    if by_sec:
        return by_sec
    selected = []
    active = False
    section_label = ""
    for item in sources:
        if item["anchor"] == section_id:
            active = True
            section_label = item["section"]
        elif active and item["section"] != section_label:
            break
        if active:
            selected.append(item)
    return selected or [x for x in sources if x["anchor"] == section_id]


def _prompt_source_text(source: dict) -> str:
    """單一語言送入：已翻譯優先取譯文（zh），未翻譯退回原文（en）。"""
    return _clean_prompt_text(source.get("zh") or source.get("en") or "")


def _chunks(sources: list[dict]) -> list[list[dict]]:
    chunks, current, size = [], [], 0
    for source in sources:
        estimate = len(_prompt_source_text(source)) + 120
        if current and size + estimate > CHUNK_CHARS:
            chunks.append(current)
            current, size = [], 0
        current.append(source)
        size += estimate
    if current:
        chunks.append(current)
    return chunks


def _clean_prompt_text(text: str) -> str:
    return str(text or "").replace("‖", "").replace("\u200b", "").strip()


def _paper_overview(paper: dict, sources: list[dict]) -> str:
    abstract_parts = [
        _clean_prompt_text(s.get("zh") or s.get("en") or "")
        for s in sources
        if s.get("role") == "abstract" or "abstract" in str(s.get("section") or "").lower() or "摘要" in str(s.get("section") or "")  # i18n-ok: section match
    ]
    if not abstract_parts and sources:
        abstract_parts = [_clean_prompt_text(sources[0].get("zh") or sources[0].get("en") or "")]
    abstract = " ".join(filter(None, abstract_parts))[:600]
    sec_names = []
    for s in sources:
        sec = str(s.get("section") or "").strip()
        if sec and sec not in sec_names:
            sec_names.append(sec)
    lines = []
    if sec_names:
        lines.append("章節脈絡：" + " / ".join(sec_names[:12]))  # i18n-ok: model prompt
    if abstract:
        lines.append("論文核心摘要：" + abstract)  # i18n-ok: model prompt
    return "\n".join(lines)


def _manual_notes_by_anchor(reader: dict | None) -> dict[str, list[dict]]:
    """整理已存在的手動標註（排除 AI 自動產生的標註），供 prompt 避開與後端重疊偵測。"""
    by_anchor: dict[str, list[dict]] = defaultdict(list)
    notes = (reader or {}).get("notes") or {}
    for n in notes.values():
        if not isinstance(n, dict) or n.get("deleted") or n.get("ai_generated") or n.get("ai_annotation_id"):
            continue
        anchor = str(n.get("anchor") or "").strip()
        quote = str(n.get("quote") or "").strip()
        if anchor and quote:
            by_anchor[anchor].append(n)
    return by_anchor


def _detect_manual_overlap(candidate: dict, source: dict, manual_notes: dict[str, list[dict]]) -> None:
    """比對 AI 候選標註與該段手動標註是否有字元區間重疊。"""
    anchor = candidate.get("anchor")
    notes = manual_notes.get(anchor) or []
    if not notes or not candidate.get("locatable"):
        return
    c_side = candidate.get("side") or "zh"
    c_quote = candidate.get("quote") or ""
    c_norm = _norm(c_quote)
    if not c_norm:
        return
    for m in notes:
        m_quote = str(m.get("quote") or "")
        m_norm = _norm(m_quote)
        if not m_norm:
            continue
        # 1. 規範化字串互相包含
        if c_norm in m_norm or m_norm in c_norm:
            candidate["manual_overlap"] = True
            candidate["overlap_quote"] = m_quote[:120]
            candidate["overlap_info"] = {
                "note_id": m.get("id"),
                "color": m.get("color", "yellow"),
                "style": m.get("style", "marker"),
                "quote": m_quote[:120],
            }
            return
        # 2. 正文精確字元區間重疊計算
        text = source.get(c_side) or ""
        if text and c_quote in text and m_quote in text:
            c_start = text.find(c_quote)
            c_end = c_start + len(c_quote)
            m_start = text.find(m_quote)
            m_end = m_start + len(m_quote)
            if max(c_start, m_start) < min(c_end, m_end):
                candidate["manual_overlap"] = True
                candidate["overlap_quote"] = m_quote[:120]
                candidate["overlap_info"] = {
                    "note_id": m.get("id"),
                    "color": m.get("color", "yellow"),
                    "style": m.get("style", "marker"),
                    "quote": m_quote[:120],
                }
                return


def _prompt(title: str, mode: str, purpose: str, chunk: list[dict], overview: str = "", meta: dict | None = None,
            prior_notes: list[str] | None = None, intensity: str = "standard",
            manual_notes_map: dict[str, list[dict]] | None = None) -> str:
    from . import langs
    mode_text = {
        "auto": "找出最值得整體標記的句子與詞彙，充分發揮螢光筆與底線筆的搭配。",  # i18n-ok: model prompt
        "suggest": "列出可逐筆審閱的候選句子與關鍵詞，結構嚴謹，寧精勿濫。",  # i18n-ok: model prompt
        "purpose": "挑選與研究目的直接相關、具備研究價值的句子與關鍵詞句。",  # i18n-ok: model prompt
    }.get(mode, "列出高價值候選句子與關鍵詞。")  # i18n-ok: model prompt
    lang_rule = langs.reply_language_rule(meta)
    cfg_mode = INTENSITY_MODES.get(intensity, INTENSITY_MODES["standard"])
    records = []
    total_chars = 0
    for source in chunk:
        text_clean = _prompt_source_text(source)
        total_chars += len(text_clean)
        manual_block = ""
        anchor = source.get("anchor")
        m_list = (manual_notes_map or {}).get(anchor) or []
        if m_list:
            m_quotes = [f'"{_clean_prompt_text(m.get("quote"))}" ({m.get("style", "marker")})' for m in m_list[:3]]
            manual_block = "\n[此段使用者已手動標註，請勿完全重複標記相同文字：" + "；".join(m_quotes) + "]"  # i18n-ok: model prompt
        records.append(
            f"[anchor={source['anchor']} key={source['key']} page={source.get('page') or ''} section={source['section']}]{manual_block}\n"
            f"TEXT: {text_clean}"
        )
    est_items = round(max(total_chars, 800) / cfg_mode["chars_per_item"])
    max_items = max(cfg_mode["min_items"], min(cfg_mode["max_items"], est_items))
    overview_block = f"{overview}\n" if overview else ""
    prior_block = ""
    if prior_notes:
        recent = [str(n).strip() for n in prior_notes[-12:] if str(n).strip()]
        if recent:
            prior_block = "前段已標註之論點摘要（避免重複標註相同觀點）：\n- " + "\n- ".join(recent) + "\n\n"  # i18n-ok: model prompt

    hl_rules = "；".join(f"{c}（{info[0]}：{info[1]}）" for c, info in HIGHLIGHT_SEMANTICS.items())  # i18n-ok: model prompt
    ul_rules = "；".join(f"{c}（{info[0]}：{info[1]}）" for c, info in UNDERLINE_SEMANTICS.items())  # i18n-ok: model prompt

    return (
        "你是 PaperRead 的論文閱讀標註助手。只能根據提供的文字工作，不可補造論文內容、數據或引用。\n"  # i18n-ok: model prompt
        f"論文：{title}\n{overview_block}研究目的：{purpose or '未指定，依論文研究價值判斷'}\n{mode_text}\n"  # i18n-ok: model prompt
        f"{cfg_mode['guide']}\n\n"
        f"{prior_block}"
        "【標註工具與 8 種語意顏色規則（必嚴格遵循）】：\n"  # i18n-ok: model prompt
        "一、螢光筆（type: \"highlight\"）：標記一段【具有完整語意的連續句子】（建議 15～90 字，不可只標單詞）：\n"  # i18n-ok: model prompt
        f"  - {hl_rules}。\n"  # i18n-ok: model prompt
        "二、底線筆（type: \"underline\"）：標記句子中的【特定詞彙、數字或關鍵短語】（建議 2～30 字）：\n"  # i18n-ok: model prompt
        f"  - {ul_rules}。\n"  # i18n-ok: model prompt
        "三、雙工具組合：底線筆可標記在已經被螢光筆標記的句子內部之關鍵詞或數據上，形成層次豐富的閱讀焦點。\n\n"  # i18n-ok: model prompt
        "【嚴格品質規範】：\n"  # i18n-ok: model prompt
        "1. 禁止標註章節導覽、過渡句或空泛鋪陳（例如「本節將介紹…」、「結果如表 1 所示」、「總結而言」）。\n"  # i18n-ok: model prompt
        f"2. 禁止在 note 中單純重述或換句話抄寫原文；note 必須{lang_rule}點出「這句話或詞彙的學術角色與價值」（例如：指出方法瓶頸、創新機制、領先幅度或疑點）。\n"  # i18n-ok: model prompt
        "3. 若某段已標記使用者手動標註，嚴禁標出完全重疊的相同區間，請尋找該段其他價值點或不同層次的詞彙。\n"  # i18n-ok: model prompt
        "4. 本批建議輸出約 6～" + str(max_items) + " 筆標註，請兼顧螢光筆與底線筆的合理比例。\n\n"  # i18n-ok: model prompt
        "請只輸出 JSON，不要 Markdown 或任何說明文字，格式："  # i18n-ok: model prompt
        '{"annotations":[{"anchor":"來源中的 anchor","key":"來源中的 key","quote":"完全照抄對應區塊 TEXT 的連續文字",'  # i18n-ok: model prompt
        f'"type":"highlight 或 underline","color":"yellow/green/blue/red","note":"{lang_rule}說明研究角色與價值，一至三句，不要重複原文",'  # i18n-ok: model prompt
        f'"reason":"{lang_rule}簡述為何值得標註","confidence":0.85'  # i18n-ok: model prompt
        '}]}\n'  # i18n-ok: model prompt
        f"quote 必須逐字從對應區塊的 TEXT 複製，不要翻譯、改寫、使用省略號（...）或自行補標點。note 與 reason 請{lang_rule}。anchor、key 只可使用來源標籤。最多輸出 {max_items} 筆。\n\n"  # i18n-ok: model prompt
        + "\n\n".join(records)
    )


def _norm(text: str) -> str:
    # ‖ is an internal sentence-alignment marker and is not rendered as text.
    return re.sub(r"\s+", " ", str(text or "").replace("‖", "").replace("\u200b", "")).strip()


_MD_LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
_CITE_BRACKET_RE = re.compile(r"\[\d+(?:\s*[,，–-]\s*\d+)*\]")  # i18n-ok
_SKIP_PUNCT = set(" \t\r\n‖\u200b*_`$，,。.;；:：!！?？()（）[]【】\"'“”‘’「」『』—–-·•")  # i18n-ok


def _normalized_match(text: str, quote: str) -> tuple[int, str] | None:
    """Match whitespace/alignment-marker differences while retaining real offsets."""
    chars, positions = [], []
    previous_space = False
    for index, char in enumerate(str(text or "")):
        if char in ("‖", "\u200b"):
            continue
        if char.isspace():
            if previous_space:
                continue
            chars.append(" ")
            positions.append(index)
            previous_space = True
            continue
        chars.append(char)
        positions.append(index)
        previous_space = False
    target = _norm(quote)
    normalized = "".join(chars)
    start = normalized.find(target)
    if start < 0 or not target:
        return None
    end_index = start + len(target) - 1
    begin = positions[start]
    end = positions[end_index] + 1
    return begin, str(text or "")[begin:end]


def _skeleton(text: str, drop_cites: bool = False) -> tuple[str, list[int]]:
    """Build a punctuation/markdown-insensitive character stream mapped to original indices."""
    raw = str(text or "")
    keep_mask = [True] * len(raw)
    for m in _MD_LINK_RE.finditer(raw):
        # Keep only the link label [label](url), masking out '[' and '](url)'.
        keep_mask[m.start()] = False
        for i in range(m.end(1), m.end()):
            keep_mask[i] = False
    if drop_cites:
        for m in _CITE_BRACKET_RE.finditer(raw):
            for i in range(m.start(), m.end()):
                keep_mask[i] = False
    chars, positions = [], []
    for index, char in enumerate(raw):
        if not keep_mask[index] or char in _SKIP_PUNCT or char.isspace():
            continue
        chars.append(char.lower())
        positions.append(index)
    return "".join(chars), positions


def _expand_formatting_bounds(text: str, begin: int, end: int, quote: str) -> tuple[int, int]:
    """Include balanced markdown/LaTeX markers or trailing sentence punctuation when appropriate."""
    while begin > 0 and text[begin - 1] in ("*", "`", "$") and end < len(text) and text[end] == text[begin - 1]:
        begin -= 1
        end += 1
    q_strip = str(quote or "").rstrip()
    if q_strip and q_strip[-1] in "。.!！？?」”)）" and end < len(text) and text[end] in "。.!！？?」”)）":  # i18n-ok
        end += 1
    return begin, end


def _loose_match(text: str, quote: str) -> tuple[int, str] | None:
    """Fallback matcher for weak models that alter punctuation, spaces, citations, or use ellipsis."""
    raw_text = str(text or "")
    raw_quote = str(quote or "").strip()
    if not raw_text or not raw_quote:
        return None
    # 1. Handle ellipsis ("前半句...後半句" or "前半句…後半句") often produced by smaller models.
    ellipsis_parts = [p.strip() for p in re.split(r"\.{2,}|…+", raw_quote) if len(p.strip()) >= 4]
    if len(ellipsis_parts) >= 2:
        head_hit = _normalized_match(raw_text, ellipsis_parts[0]) or _loose_match(raw_text, ellipsis_parts[0])
        if head_hit:
            tail_offset = head_hit[0] + len(head_hit[1])
            tail_hit = (_normalized_match(raw_text[tail_offset:], ellipsis_parts[-1])
                        or _loose_match(raw_text[tail_offset:], ellipsis_parts[-1]))
            if tail_hit:
                begin = head_hit[0]
                end = tail_offset + tail_hit[0] + len(tail_hit[1])
                if 0 < end - begin <= max(len(raw_quote) * 4, 260):
                    return begin, raw_text[begin:end]
    # 2. Punctuation, whitespace, markdown-syntax, and inline-citation insensitive substring match.
    q_skel, _ = _skeleton(raw_quote, drop_cites=False)
    if len(q_skel) < 4:
        return None
    for drop_cites in (False, True):
        t_skel, t_pos = _skeleton(raw_text, drop_cites=drop_cites)
        q_target = _skeleton(raw_quote, drop_cites=drop_cites)[0] if drop_cites else q_skel
        if len(q_target) < 4:
            continue
        start = t_skel.find(q_target)
        if start >= 0:
            begin = t_pos[start]
            end = t_pos[start + len(q_target) - 1] + 1
            begin, end = _expand_formatting_bounds(raw_text, begin, end, raw_quote)
            return begin, raw_text[begin:end]
    # 3. High-overlap fuzzy sentence alignment (handles 1-2 character typos/paraphrases by weak models).
    if len(q_skel) < 6:
        return None
    from difflib import SequenceMatcher
    t_skel, t_pos = _skeleton(raw_text, drop_cites=True)
    q_target, _ = _skeleton(raw_quote, drop_cites=True)
    if len(t_skel) < 4 or len(q_target) < 6:
        return None
    matcher = SequenceMatcher(None, t_skel, q_target, autojunk=False)
    blocks = [b for b in matcher.get_matching_blocks() if b.size > 0]
    if not blocks:
        return None
    matched_chars = sum(b.size for b in blocks)
    span_start = blocks[0].a
    span_end = blocks[-1].a + blocks[-1].size
    span_len = span_end - span_start
    # Require >= 82% of quote characters matched and compact span length close to quote length.
    if matched_chars / len(q_target) >= 0.82 and span_len <= int(len(q_target) * 1.25) + 3:
        begin = t_pos[span_start]
        end = t_pos[span_end - 1] + 1
        begin, end = _expand_formatting_bounds(raw_text, begin, end, raw_quote)
        return begin, raw_text[begin:end]
    return None


def _u16_positions(text: str) -> list[int]:
    """Map UTF-16 offsets (the paper.json/JS convention) to Python offsets."""
    positions = [0]
    for index, char in enumerate(str(text or "")):
        positions.append(positions[-1] + (2 if ord(char) > 0xFFFF else 1))
    return positions


def _aligned_zh_location(source: dict, en_location: dict) -> dict | None:
    """Map an English match to its aligned Chinese sentence(s), when available."""
    en, zh, sents = str(source.get("en") or ""), str(source.get("zh") or ""), source.get("sents")
    if not en or not zh or not isinstance(sents, list) or len(sents) < 2:
        return None
    if not isinstance(sents[-1], list) or len(sents[-1]) != 2:
        return None
    en_pos, zh_pos = _u16_positions(en), _u16_positions(zh)
    if sents[-1] != [en_pos[-1], zh_pos[-1]]:
        return None
    en_start = en_pos[min(max(int(en_location.get("index") or 0), 0), len(en))]
    en_end_py = min(len(en), int(en_location.get("index") or 0) + len(str(en_location.get("quote") or "")))
    en_end = en_pos[en_end_py]
    rows = [row for row in sents if isinstance(row, list) and len(row) == 2]
    start_row = next((i for i, row in enumerate(rows) if row[0] > en_start), None)
    end_row = next((i for i, row in enumerate(rows) if row[0] >= en_end), None)
    if start_row is None or end_row is None:
        return None
    zh_start_u16 = 0 if start_row == 0 else rows[start_row - 1][1]
    zh_end_u16 = rows[end_row][1]
    if not (0 <= zh_start_u16 < zh_end_u16 <= zh_pos[-1]):
        return None
    start = next((i for i, value in enumerate(zh_pos) if value >= zh_start_u16), None)
    end = next((i for i, value in enumerate(zh_pos) if value >= zh_end_u16), None)
    if start is None or end is None or end <= start:
        return None
    quote = zh[start:end].strip()
    if not quote:
        return None
    leading = len(zh[start:end]) - len(zh[start:end].lstrip())
    return {"source": source, "side": "zh", "quote": quote, "index": start + leading}


def _aligned_en_location(source: dict, zh_location: dict) -> dict | None:
    """Map a Chinese/target match to its aligned English sentence(s), when available."""
    en, zh, sents = str(source.get("en") or ""), str(source.get("zh") or ""), source.get("sents")
    if not en or not zh or not isinstance(sents, list) or len(sents) < 2:
        return None
    if not isinstance(sents[-1], list) or len(sents[-1]) != 2:
        return None
    en_pos, zh_pos = _u16_positions(en), _u16_positions(zh)
    if sents[-1] != [en_pos[-1], zh_pos[-1]]:
        return None
    zh_start = zh_pos[min(max(int(zh_location.get("index") or 0), 0), len(zh))]
    zh_end_py = min(len(zh), int(zh_location.get("index") or 0) + len(str(zh_location.get("quote") or "")))
    zh_end = zh_pos[zh_end_py]
    rows = [row for row in sents if isinstance(row, list) and len(row) == 2]
    start_row = next((i for i, row in enumerate(rows) if row[1] > zh_start), None)
    end_row = next((i for i, row in enumerate(rows) if row[1] >= zh_end), None)
    if start_row is None or end_row is None:
        return None
    en_start_u16 = 0 if start_row == 0 else rows[start_row - 1][0]
    en_end_u16 = rows[end_row][0]
    if not (0 <= en_start_u16 < en_end_u16 <= en_pos[-1]):
        return None
    start = next((i for i, value in enumerate(en_pos) if value >= en_start_u16), None)
    end = next((i for i, value in enumerate(en_pos) if value >= en_end_u16), None)
    if start is None or end is None or end <= start:
        return None
    quote = en[start:end].strip()
    if not quote:
        return None
    leading = len(en[start:end]) - len(en[start:end].lstrip())
    return {"source": source, "side": "en", "quote": quote, "index": start + leading}


def _locate(quote: str, suggested_anchor: str, sources: list[dict], preferred_side: str = "", suggested_key: str = "") -> dict | None:
    quote = str(quote or "").strip()
    if not quote:
        return None
    by_key = [x for x in sources if suggested_key and x.get("key") == suggested_key]
    by_anchor = [x for x in sources if x.get("anchor") == suggested_anchor and x not in by_key]
    preferred = by_key + by_anchor
    candidates = preferred + [x for x in sources if x not in preferred]

    sides = [preferred_side] if preferred_side in ("zh", "en") else []
    fallback_sides = [side for side in ("zh", "en") if side not in sides]
    passes = [sides, fallback_sides] if sides else [["zh", "en"]]

    for side_list in passes:
        if not side_list:
            continue
        exact = []
        normalized = []
        for source in candidates:
            for side in side_list:
                text = source.get(side) or ""
                if not text:
                    continue
                if quote in text:
                    exact.append((source, side, text.index(quote), quote))
                else:
                    match = _normalized_match(text, quote)
                    if match:
                        normalized.append((source, side, match[0], match[1], _norm(quote)))
        matches = exact or normalized
        if not matches:
            # Try loose matching on preferred block(s) first, then across all blocks.
            loose = []
            for pool in (preferred, [x for x in sources if x not in preferred]):
                for source in pool:
                    for side in side_list:
                        text = source.get(side) or ""
                        match = _loose_match(text, quote) if text else None
                        if match:
                            loose.append((source, side, match[0], match[1], _norm(match[1])))
                if loose:
                    break
            matches = loose

        if not matches:
            continue

        unique = {(m[0].get("key"), m[1], _norm(m[3])) for m in matches}
        if len(unique) != 1:
            preferred_matches = ([m for m in matches if suggested_key and m[0].get("key") == suggested_key]
                                 or [m for m in matches if m[0].get("anchor") == suggested_anchor])
            if preferred_matches:
                if preferred_side:
                    side_matches = [m for m in preferred_matches if m[1] == preferred_side]
                    if side_matches:
                        preferred_matches = side_matches
                matches = [preferred_matches[0]]
            elif len(matches) == 1:
                pass
            else:
                continue

        source, side, index = matches[0][:3]
        actual = matches[0][3]
        text = source.get(side) or ""
        if actual == text and index:
            actual = text[index:index + len(str(quote))]
        return {"source": source, "side": side, "quote": actual, "index": index}

    return None


def _stable_id(paper_id: str, item: dict) -> str:
    raw = "|".join(str(item.get(k) or "") for k in ("anchor", "key", "quote", "type", "color"))
    return "ai-" + hashlib.sha256((paper_id + "|" + raw).encode("utf-8")).hexdigest()[:20]


def _candidate(paper_id: str, raw: dict, sources: list[dict], model: str, purpose: str, created: str) -> dict | None:
    if not isinstance(raw, dict):
        return None
    typ = str(raw.get("type") or raw.get("annotation_type") or "highlight").lower()
    if typ not in ANNOTATION_TYPES:
        return None
    color = str(raw.get("color") or "yellow").lower()
    # Existing reader notes call the red semantic color "pink"; keep that
    # canonical value so old CSS and manual annotations continue to render.
    if color == "red":
        color = "pink"
    if color not in COLORS:
        return None
    requested_side = str(raw.get("side") or "").lower()
    raw_quote = str(raw.get("quote") or "").strip()
    raw_quote_en = str(raw.get("quote_en") or "").strip()
    raw_quote_zh = str(raw.get("quote_zh") or "").strip()
    quote_en = raw_quote_en or (raw_quote if requested_side == "en" else "")
    quote_zh = raw_quote_zh or (raw_quote if requested_side == "zh" else "")
    if not quote_en and not quote_zh and raw_quote:
        quote_zh = raw_quote
        quote_en = raw_quote
    if not quote_en and not quote_zh:
        return None
    suggested_anchor = str(raw.get("anchor") or "").strip()
    suggested_key = str(raw.get("key") or "").strip()
    located_zh = _locate(quote_zh, suggested_anchor, sources, "zh", suggested_key) if quote_zh else None
    if located_zh and located_zh.get("side") != "zh":
        located_zh = None
    source = (located_zh["source"] if located_zh else
              next((x for x in sources if suggested_key and x["key"] == suggested_key), None) or
              next((x for x in sources if x["anchor"] == suggested_anchor), None))
    en_anchor = source["anchor"] if source else suggested_anchor
    en_key = source["key"] if source else suggested_key
    located_en = _locate(quote_en, en_anchor, sources, "en", en_key) if quote_en else None
    if located_en and located_en.get("side") != "en":
        located_en = None
    if located_en and not located_zh:
        source = located_en["source"]
    if not source:
        source = {"anchor": suggested_anchor, "key": suggested_key or suggested_anchor, "page": None, "section": "", "zh": "", "en": "", "sents": None}
    if located_zh is None and located_en and source.get("zh"):
        located_zh = _aligned_zh_location(source, located_en)
    if located_en is None and located_zh and source.get("en"):
        located_en = _aligned_en_location(source, located_zh)
    located = located_zh or located_en
    if located and located["source"] is not source:
        source = located["source"]
    actual_quote = located["quote"] if located else (quote_zh or quote_en)
    confidence = raw.get("confidence", 0.0)
    try:
        confidence = max(0.0, min(1.0, float(confidence)))
    except (TypeError, ValueError):
        confidence = 0.0
    note_text = str(raw.get("note") or "").strip()[:1200]
    reason_text = str(raw.get("reason") or "").strip()[:1200]
    # Weak models sometimes copy the quote verbatim into `note`; replace with `reason` when available.
    if note_text and _norm(note_text) == _norm(actual_quote) and reason_text and _norm(reason_text) != _norm(actual_quote):
        note_text = reason_text
    annotation_side = located["side"] if located else ("zh" if source.get("zh") else "en")
    annotation = {
        "annotation_id": _stable_id(paper_id, {"anchor": source["anchor"], "key": source["key"], "quote": actual_quote, "type": typ, "color": color}),
        "paper_id": paper_id, "quote": actual_quote, "type": typ, "style": "underline" if typ == "underline" else "marker",
        "color": color, "note": note_text, "reason": reason_text,
        "purpose": purpose[:500], "page": source.get("page"), "anchor": source["anchor"], "key": source["key"],
        "prefix": (source.get(annotation_side) or source.get("zh") or source.get("en") or "")[:32], "suffix": "", "confidence": confidence,
        "section": source.get("section") or "", "status": "pending", "locatable": bool(located),
        "side": annotation_side,
        "source_quote_en": located_en["quote"] if located_en else quote_en,
        "source_quote_zh": actual_quote if annotation_side == "zh" else quote_zh,
        "source_en_hash": text_hash(source.get("en") or ""),
        "source_zh_hash": text_hash(source.get("zh") or ""),
        "source_text_hash": text_hash(source.get(annotation_side) or ""),
        "model": model, "created_at": created, "updated_at": created,
    }
    if located:
        text = located["source"].get(located["side"]) or ""
        i = located["index"]
        annotation["prefix"] = text[max(0, i - 32):i]
        annotation["suffix"] = text[i + len(actual_quote):i + len(actual_quote) + 32]
    return annotation


def _dedupe(candidates: list[dict]) -> list[dict]:
    indexed = list(enumerate(candidates))
    # Prioritize locatable candidates and higher confidence so weak-model broken duplicates don't shadow valid ones.
    indexed.sort(key=lambda pair: (
        bool(pair[1].get("locatable")),
        float(pair[1].get("confidence") or 0.0),
        len(pair[1].get("note") or ""),
        -pair[0],
    ), reverse=True)
    kept = []
    seen = set()
    for idx, item in indexed:
        norm_q = _norm(item.get("quote"))
        if not norm_q:
            continue
        key = (item.get("anchor"), item.get("key"), norm_q, item.get("type"))
        if key in seen:
            continue
        seen.add(key)
        overlap = False
        for _, existing in kept:
            if existing.get("anchor") != item.get("anchor") or existing.get("key") != item.get("key"):
                continue
            ex_q = _norm(existing.get("quote"))
            if not ex_q:
                continue
            if norm_q in ex_q or ex_q in norm_q:
                # Allow short underline terms inside a full-sentence highlight if both are locatable.
                shorter, longer = (len(norm_q), len(ex_q)) if len(norm_q) <= len(ex_q) else (len(ex_q), len(norm_q))
                if (existing.get("type") != item.get("type") and item.get("locatable") and existing.get("locatable")
                        and shorter < longer * 0.85):
                    continue
                overlap = True
                break
        if overlap:
            continue
        kept.append((idx, item))
        if len(kept) >= MAX_CANDIDATES:
            break
    kept.sort(key=lambda pair: pair[0])
    return [item for _, item in kept]


def generate(ws: Workspace, *, scope="all", section_id="", mode="auto", purpose="", intensity="standard", model_id="", cancel=None, on_progress=None) -> dict:
    from . import chat_models, config, engines, usage
    paper = ws.load("paper") or {}
    reader = ws.load("reader") or {}
    all_sources = _sources(paper, reader)
    sources = _selected_sources(all_sources, scope, section_id)
    if not sources:
        raise ValueError(tr("這篇論文目前沒有可供分析的文字。"))
    cfg, selected = chat_models.engine_cfg(config.load(), model_id or None)
    cfg = engines.for_translation(cfg)
    model_name = chat_models.label(selected)
    meter = usage.Meter(cfg.get("engine") or "")
    meta = paper.get("meta") or {}
    title = meta.get("title_zh") or meta.get("title_en") or tr("未命名論文")
    overview = _paper_overview(paper, all_sources)
    manual_notes = _manual_notes_by_anchor(reader)
    # 先把舊版本候選重新對照目前 blocks；重新翻譯後再按智慧標註時，
    # 使用者會看到哪些項目仍有效、哪些必須重新分析，而不是沿用舊譯文位置。
    refresh_after_translation(ws)
    generated = []
    existing = (ws.load("reader") or {}).get("ai_annotations") or {}
    saved = 0
    chunks = _chunks(sources)
    total_chunks = len(chunks)
    prior_notes: list[str] = []

    if on_progress:
        on_progress(0, total_chunks, saved)

    for chunk_idx, chunk in enumerate(chunks, 1):
        if cancel is not None and cancel.is_set():
            raise engines.Cancelled()
        prompt_text = _prompt(title, mode, purpose, chunk, overview=overview, meta=meta,
                              prior_notes=prior_notes, intensity=intensity, manual_notes_map=manual_notes)
        raw = engines.parse_json(engines.run(cfg, prompt_text, ws.root, [], cancel, meter))
        rows = raw.get("annotations", []) if isinstance(raw, dict) else raw if isinstance(raw, list) else []
        candidates = []
        for row in rows:
            cand = _candidate(ws.id, row, sources, model_name, purpose, now_iso())
            if cand:
                src = next((s for s in sources if s.get("key") == cand.get("key") or s.get("anchor") == cand.get("anchor")), {})
                _detect_manual_overlap(cand, src, manual_notes)
                candidates.append(cand)
        chunk_items = _dedupe(candidates)
        ops = []
        for item in chunk_items:
            if any(x["annotation_id"] == item["annotation_id"] for x in generated):
                continue
            generated.append(item)
            note_summary = f"[{item.get('section') or ''}] {item.get('note') or item.get('quote') or ''}"
            prior_notes.append(note_summary.strip())
            old = existing.get(item["annotation_id"])
            if old and old.get("status") in ("accepted", "rejected"):
                continue
            if old:
                item["status"] = old.get("status", "pending")
                item["created_at"] = old.get("created_at", item["created_at"])
            ops.append({"op": "ai_annotation", "annotation": item, "at": item["updated_at"]})
        if ops:
            ws.apply_reader_ops(ops, client="smart-annotations")
            saved += len(ops)
            existing = (ws.load("reader") or {}).get("ai_annotations") or {}
        if on_progress:
            on_progress(chunk_idx, total_chunks, saved)
    return {"count": saved, "total": len(generated), "usage": meter.snapshot(), "model": model_name}


def _valid_patch(annotation: dict, patch: dict, sources: list[dict] | None = None) -> dict:
    out = dict(annotation)
    if "quote" in patch and sources is not None:
        quote = str(patch.get("quote") or "").strip()
        located = _locate(quote, str(annotation.get("anchor") or ""), sources, str(annotation.get("side") or ""), str(annotation.get("key") or ""))
        out["quote"] = quote
        out["locatable"] = bool(located)
        if located:
            source = located["source"]
            out.update({"quote": located["quote"], "anchor": source["anchor"], "key": source["key"],
                        "page": source.get("page"), "section": source.get("section") or "", "side": located["side"]})
            text = source.get(located["side"]) or ""
            i = located["index"]
            out["prefix"] = text[max(0, i - 32):i]
            out["suffix"] = text[i + len(located["quote"]):i + len(located["quote"]) + 32]
            out["source_en_hash"] = text_hash(source.get("en") or "")
            out["source_zh_hash"] = text_hash(source.get("zh") or "")
            out["source_text_hash"] = text_hash(text)
            out["source_quote_zh"] = located["quote"] if located["side"] == "zh" else out.get("source_quote_zh", "")
    for key in ("note", "reason", "purpose"):
        if key in patch:
            out[key] = str(patch[key] or "")[:1200]
    if patch.get("color") in COLORS:
        out["color"] = "pink" if patch["color"] == "red" else patch["color"]
    if patch.get("type") in ANNOTATION_TYPES:
        out["type"] = patch["type"]
        out["style"] = "underline" if patch["type"] == "underline" else "marker"
    out["updated_at"] = now_iso()
    return out


def _formal_note(annotation: dict, existing: dict) -> dict:
    nid = "ai-note-" + annotation["annotation_id"].removeprefix("ai-")
    return {
        "id": nid, "anchor": annotation.get("anchor"), "key": annotation.get("key"), "quote": annotation.get("quote"),
        "prefix": annotation.get("prefix", ""), "suffix": annotation.get("suffix", ""), "side": annotation.get("side"),
        "kind": "highlight", "color": annotation.get("color", "yellow"), "style": annotation.get("style", "marker"),
        "body": annotation.get("note", ""), "created": existing.get("created", now_iso()), "updated": now_iso(),
        "ai_generated": True, "ai_annotation_id": annotation["annotation_id"],
    }


def _source_for_annotation(annotation: dict, sources: list[dict]) -> dict | None:
    """Find the current block, even when a retranslation regenerated its block id."""
    anchor = str(annotation.get("anchor") or "")
    key = str(annotation.get("key") or "")
    exact = (next((source for source in sources if key and source["key"] == key), None)
             or next((source for source in sources if source["anchor"] == anchor), None))
    old_en_hash = str(annotation.get("source_en_hash") or "")
    old_zh_hash = str(annotation.get("source_zh_hash") or "")
    if exact and (not old_en_hash or text_hash(exact.get("en") or "") == old_en_hash or
                  not old_zh_hash or text_hash(exact.get("zh") or "") == old_zh_hash):
        return exact
    en_hash = old_en_hash
    if en_hash:
        matches = [source for source in sources if text_hash(source.get("en") or "") == en_hash]
        if len(matches) == 1:
            return matches[0]
    zh_hash = old_zh_hash
    if zh_hash:
        matches = [source for source in sources if text_hash(source.get("zh") or "") == zh_hash]
        if len(matches) == 1:
            return matches[0]
    return None


def _refresh_annotation(annotation: dict, sources: list[dict]) -> dict:
    """Rebase an AI suggestion against the latest paper blocks after translation."""
    out = dict(annotation)
    source = _source_for_annotation(annotation, sources)
    if not source:
        out.update({"locatable": False, "source_stale": True, "stale_reason": "source_missing"})
        return out
    side = str(annotation.get("side") or "")
    source_quote_en = str(annotation.get("source_quote_en") or (annotation.get("quote") if side == "en" else ""))
    source_quote_zh = str(annotation.get("source_quote_zh") or (annotation.get("quote") if side == "zh" else ""))
    located_en = _locate(source_quote_en, source["anchor"], [source], "en", source["key"]) if source_quote_en else None
    if located_en and located_en.get("side") != "en":
        located_en = None
    located_zh = _locate(source_quote_zh, source["anchor"], [source], "zh", source["key"]) if source_quote_zh else None
    if located_zh and located_zh.get("side") != "zh":
        located_zh = None
    if located_zh is None and located_en and source.get("zh"):
        located_zh = _aligned_zh_location(source, located_en)
    if located_en is None and located_zh and source.get("en"):
        located_en = _aligned_en_location(source, located_zh)
    located = located_zh or (located_en if not source.get("zh") else None)
    out.update({
        "anchor": source["anchor"], "key": source["key"], "page": source.get("page"),
        "section": source.get("section") or "", "source_en_hash": text_hash(source.get("en") or ""),
        "source_zh_hash": text_hash(source.get("zh") or ""),
    })
    if located:
        text = located["source"].get(located["side"]) or ""
        i = located["index"]
        out.update({
            "quote": located["quote"], "side": located["side"], "locatable": True,
            "source_quote_en": located_en["quote"] if located_en else source_quote_en,
            "source_quote_zh": located["quote"] if located["side"] == "zh" else source_quote_zh,
            "source_text_hash": text_hash(text), "source_stale": False, "stale_reason": "",
            "prefix": text[max(0, i - 32):i], "suffix": text[i + len(located["quote"]):i + len(located["quote"]) + 32],
        })
        return out
    current_hash = text_hash(source.get("zh" if source.get("zh") else side) or "") if side in ("zh", "en") else ""
    old_hash = str(annotation.get("source_text_hash") or "")
    reason = "translation_changed" if source.get("zh") and old_hash and current_hash != old_hash else "source_changed"
    out.update({"locatable": False, "source_stale": True, "stale_reason": reason})
    return out


def refresh_after_translation(ws: Workspace, block_ids: set[str] | None = None) -> dict:
    """Revalidate AI suggestions and accepted notes after paper text is replaced.

    English quotes survive a retranslation because the English source is stable. A
    quote that was made against the old Chinese translation is kept for review but
    marked stale instead of silently being attached to a wrong sentence.
    """
    reader = ws.load("reader") or {}
    annotations = reader.get("ai_annotations") or {}
    if not annotations:
        return {"updated": 0, "rev": reader.get("rev", 0)}
    sources = _sources(ws.load("paper") or {}, reader)
    scope = set(block_ids or ())
    ops = []
    for aid, annotation in annotations.items():
        if scope and annotation.get("anchor") not in scope and not _source_for_annotation(annotation, sources):
            continue
        updated = _refresh_annotation(annotation, sources)
        changed = any(updated.get(key) != annotation.get(key) for key in (
            "anchor", "key", "page", "section", "quote", "side", "prefix", "suffix", "locatable",
            "source_quote_en", "source_quote_zh", "source_en_hash", "source_zh_hash", "source_text_hash", "source_stale", "stale_reason"))
        if not changed:
            continue
        updated["updated_at"] = now_iso()
        ops.append({"op": "ai_annotation", "annotation": updated, "at": updated["updated_at"]})
        for note in (reader.get("notes") or {}).values():
            if note.get("ai_annotation_id") != aid or note.get("deleted"):
                continue
            note_updated = dict(note, anchor=updated.get("anchor"), key=updated.get("key"), quote=updated.get("quote"),
                                prefix=updated.get("prefix", ""), suffix=updated.get("suffix", ""), side=updated.get("side"),
                                stale=not updated.get("locatable"), updated=updated["updated_at"])
            ops.append({"op": "note", "note": note_updated, "at": updated["updated_at"]})
    if not ops:
        return {"updated": 0, "rev": reader.get("rev", 0)}
    result = ws.apply_reader_ops(ops, client="smart-annotation-source-refresh")
    return {"updated": len(ops), **result}


def apply_action(ws: Workspace, body: dict) -> dict:
    action = str(body.get("action") or "")
    reader = ws.load("reader") or {}
    annotations = reader.get("ai_annotations") or {}
    sources = _sources(ws.load("paper") or {})
    ids = [str(body.get("id"))] if body.get("id") else list(annotations)
    if action == "accept_all":
        include_overlap = bool(body.get("include_overlap", False))
        ids = [k for k, v in annotations.items() if v.get("status") in ("pending", "edited") and v.get("locatable") and (include_overlap or not v.get("manual_overlap"))]
    elif action == "reject_all":
        ids = [k for k, v in annotations.items() if v.get("status") in ("pending", "edited")]
    elif action == "reject_overlaps":
        ids = [k for k, v in annotations.items() if v.get("status") in ("pending", "edited") and v.get("manual_overlap")]
    if action not in ("accept", "reject", "edit", "accept_all", "reject_all", "reject_overlaps"):
        raise ValueError(tr("智慧標註操作不正確。"))
    ops = []
    for aid in ids:
        annotation = annotations.get(aid)
        if not annotation:
            continue
        if action in ("reject", "reject_all", "reject_overlaps"):
            updated = dict(annotation, status="rejected", updated_at=now_iso())
            ops.append({"op": "ai_annotation", "annotation": updated, "at": updated["updated_at"]})
        elif action == "edit":
            updated = _valid_patch(annotation, body.get("patch") or {}, sources)
            updated["status"] = "edited"
            ops.append({"op": "ai_annotation", "annotation": updated, "at": updated["updated_at"]})
        elif action in ("accept", "accept_all"):
            if not annotation.get("locatable"):
                raise ValueError(tr("這筆標註尚未確認文字位置，請先修改原文。"))
            updated = dict(annotation, status="accepted", updated_at=now_iso())
            ops.append({"op": "ai_annotation", "annotation": updated, "at": updated["updated_at"]})
            notes = reader.get("notes") or {}
            if not any(n.get("ai_annotation_id") == aid and not n.get("deleted") for n in notes.values()):
                ops.append({"op": "note", "note": _formal_note(updated, {}) , "at": updated["updated_at"]})
    if ops:
        result = ws.apply_reader_ops(ops, client="smart-annotation-review")
    else:
        result = {"applied": [], "rev": reader.get("rev", 0)}
    res = {"ok": True, "action": action, "count": len(ops), **result}
    if action in ("reject_all", "reject_overlaps"):
        res["rejected"] = len([op for op in ops if op.get("op") == "ai_annotation"])
    elif action == "accept_all":
        res["accepted"] = len([op for op in ops if op.get("op") == "ai_annotation"])
    return res


def sections(ws: Workspace) -> list[dict]:
    paper = ws.load("paper") or {}
    return [{"id": b.get("id"), "label": _section_label(b, b), "page": b.get("page")} for b in paper.get("blocks", []) if b.get("type") in ("heading", "references")]
