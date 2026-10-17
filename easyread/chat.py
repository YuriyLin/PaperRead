"""阅读页右侧的“问 AI”：提示词和流式输出（回答一个字一个字流出来）。

- 用哪个模型：chat_models.py（设置里的一张短名单）。
- 对话记录：chat_store.py（每篇论文可以有多个对话）。
- 上下文：论文标题、摘要、读者指着的段落和前后几段、读者引用的几处原文、术语表。
  读者的标记（按颜色分好的划线、笔记、问题）只在问题提到“标红的”“划线”“笔记”时才带上，
  提到具体颜色就只带那种颜色，所以可以问“我标红的那些公式之间有什么联系”。
  Claude Code 还能自己 Read paper.json、reader.json 看全文和全部标记。
"""
from __future__ import annotations

import json
import os
import re
import threading
from collections.abc import Iterator
from pathlib import Path

from . import answer_styles, engines, netcheck, openai_api, usage
from . import langs, tables
from .i18n import tr
from .log import log
from .prompts import _block_text
from .store import Workspace

HISTORY = 12  # 带上最近几轮对话
COLOR_NAMES = {"yellow": "黃", "green": "綠", "blue": "藍", "pink": "紅"}  # i18n-ok
MARKS_BUDGET = 9000  # 标记部分最多带多少字
PAPER_BUDGET = 30000  # STE 问答带上正文，长论文各段取节选，保留后面的结果和结论


# ---------- 提示词 ----------
def _context(ws: Workspace, anchor: str | None, quote: str, refs: list[dict] | None = None) -> str:
    paper = ws.load("paper")
    meta = paper.get("meta", {})
    blocks = paper.get("blocks", [])
    lines = [f"論文：《{meta.get('title_zh') or ''}》{meta.get('title_en') or ''}，{meta.get('authors', '')[:200]}。"]  # i18n-ok
    abstract = next((_block_text(b) for b in blocks if b.get("role") == "abstract"), "")
    if abstract:
        lines.append("摘要：" + abstract[:1500])  # i18n-ok
    idx = next((i for i, b in enumerate(blocks) if b.get("id") == anchor), None)
    if idx is not None:
        h = next((b for b in reversed(blocks[:idx + 1]) if b.get("type") == "heading"), None)
        if h:
            lines.append(f"讀者正在閱讀的章節：{h.get('num', '')} {h.get('zh') or h.get('en', '')}")  # i18n-ok
        near = blocks[max(0, idx - 3): idx + 3]
        lines.append("附近的段落（有譯文用譯文，沒有譯文則使用原文）：\n" + "\n\n".join(f"[{b['id']}] {_block_text(b)}" for b in near))  # i18n-ok
        focus = blocks[idx]
        lines.append(f"讀者指向的段落 [{focus['id']}]：\n譯文：{_block_text(focus)}\n原文：{focus.get('en') or focus.get('caption_en') or focus.get('tex', '')}")  # i18n-ok
        for ref in refs or []:
            if ref.get("anchor") == anchor and ref.get("key") and focus.get("type") == "table":
                lines.append(tables.context(focus, ref["key"], ref.get("table_source", ""), include_table=False))
    if quote:
        lines.append(f"讀者選取的原話：「{quote}」")  # i18n-ok
    extra = [r for r in (refs or []) if r.get("anchor") != anchor or
             (r.get("quote") or "") != quote and "#cell:" not in str(r.get("key", ""))]
    if extra:
        by_id = {b.get("id"): b for b in blocks}
        parts = []
        shown_tables = set()
        for r in extra[:200]:
            b = by_id.get(r.get("anchor")) or {}
            q = (r.get("quote") or "").strip()
            if b.get("type") == "table" and r.get("key"):
                parts.append(tables.context(b, r["key"], r.get("table_source", ""), include_table=b.get("id") not in shown_tables))
                shown_tables.add(b.get("id"))
                continue
            parts.append(f"[{r.get('anchor')}] " + (f"讀者選取：「{q[:800]}」\n  所在段落：" if q else "") + _block_text(b)[:1200])  # i18n-ok
        lines.append("讀者引用了這幾處（問題可能是在問它們之間的關係）：\n" + "\n".join(parts))  # i18n-ok
    gl = paper.get("glossary", [])
    if gl:
        lines.append("術語表：" + "；".join(f"{g['en']} = {g['zh']}" for g in gl[:80]))  # i18n-ok
    return "\n\n".join(lines)


def _paper_context(ws: Workspace) -> str:
    """跨段或全文问题也能读到后面的结果；明确标出未提供的内容。"""
    paper = ws.load("paper")
    blocks = paper.get("blocks", [])
    parts = []
    for b in blocks:
        text = b.get("en") or b.get("caption_en") or _block_text(b)
        if b.get("type") == "list":
            text = "\n".join("- " + (it.get("en") or it.get("zh", "")) for it in b.get("items", []))
        elif b.get("type") == "table":
            if tables.is_bilingual(b):
                text = tables.context(b)
            else:
                rows = b.get("head", []) + b.get("rows", [])
                text += "\n" + "\n".join(" | ".join(str(cell) for cell in row) for row in rows)
        if text:
            page = f"第 {b['page']} 頁" if b.get("page") else ""  # i18n-ok
            parts.append(f"[{b.get('id', '')}] {page}\n{text}")
    if not parts:
        return "論文正文尚未提供；只能依據摘要、引用和目前段落回答。"  # i18n-ok
    complete = sum(map(len, parts)) + 2 * (len(parts) - 1) <= PAPER_BUDGET
    if not complete:
        limit = max(0, PAPER_BUDGET // len(parts) - 2)
        marker = "\n…（本段節錄）…\n"  # i18n-ok
        clipped = []
        for part in parts:
            if len(part) > limit:
                room = max(0, limit - len(marker))
                head = (room + 1) // 2
                tail = room - head
                part = (part[:head] + marker + (part[-tail:] if tail else "")) if room else part[:limit]
            clipped.append(part)
        parts = clipped
    label = "目前已匯入的正文" if complete else "正文節錄（長文超出上下文預算，各段只保留部分內容）"  # i18n-ok
    total = paper.get("meta", {}).get("page_count")
    done = paper.get("translation", {}).get("done_pages")
    if total and done is not None and len(set(done)) < total:
        label += f"（只完成整理 {len(set(done))} / {total} 頁）"  # i18n-ok
    return label + "；沒有提供的頁面和省略部分不能視為已讀：\n\n" + "\n\n".join(parts)  # i18n-ok


def _marks(ws: Workspace, colors: set[str] | None = None) -> str:
    """读者的全部标记，按颜色分组；每处带上所在段落的译文（含 $TeX$），这样问“红色那些公式”也答得上。"""
    paper = ws.load("paper")
    blocks = {b.get("id"): b for b in paper.get("blocks", [])}
    order = {b.get("id"): i for i, b in enumerate(paper.get("blocks", []))}
    notes = [n for n in (ws.load("reader").get("notes") or {}).values() if not n.get("deleted")]
    if not notes:
        return ""
    notes.sort(key=lambda n: order.get(n.get("anchor"), 1e9))
    kinds = {"highlight": "劃線", "note": "筆記", "question": "問題"}  # i18n-ok
    groups: dict[str, list[str]] = {}
    shown: set[str] = set()
    for n in notes:
        color = COLOR_NAMES.get(n.get("color") or "yellow", "黃") if n.get("quote") else "無顏色"  # i18n-ok
        if colors and color not in colors:
            continue
        b = blocks.get(n.get("anchor")) or {}
        line = f"- [{n.get('anchor')}] {kinds.get(n.get('kind'), '筆記')}"  # i18n-ok
        if n.get("quote"):
            line += f"：「{n['quote']}」" + ("（英文原文）" if n.get("side") == "en" else "")  # i18n-ok 发给模型的上下文
        if n.get("body"):
            line += f"；讀者寫道：{n['body'][:300]}"  # i18n-ok
        for part in n.get("parts") or [n]:
            table = blocks.get(part.get("anchor")) or {}
            if table.get("type") == "table" and "#cell:" in str(part.get("key", "")):
                line += "\n" + tables.context(table, part["key"], part.get("table_source", ""), include_table=False)[:2400]
        if b and b.get("id") not in shown:
            shown.add(b["id"])
            line += f"\n  所在段落：{_block_text(b)[:600]}"  # i18n-ok
        groups.setdefault(color, []).append(line)
    parts, used = [], 0
    for color in ["紅", "黃", "綠", "藍", "無顏色"]:  # i18n-ok
        for line in groups.get(color, []):
            if used > MARKS_BUDGET:
                break
            if not parts or not parts[-1].startswith(f"【{color}"):  # i18n-ok 發給模型的上下文
                parts.append(f"【{color}色】" if color != "無顏色" else "【沒有顏色的筆記和問題】")  # i18n-ok
            parts.append(line)
            used += len(line)
    return ("讀者在譯文上做的標記（按顏色分組，讀者說「紅的」「黃色那些」就是指這裡；每處附所在段落譯文，行內公式是 $TeX$）：\n"  # i18n-ok
            + "\n".join(parts) + ("\n（標記太多，只列出一部分；Claude Code 可以 Read reader.json 查看全部）" if used > MARKS_BUDGET else ""))  # i18n-ok


MARK_WORDS = re.compile(r"[標标][紅红黃黄綠绿藍蓝記记了過过的出注]|劃線|划线|劃過|划过|劃的|划的|畫線|画线|高亮|塗|涂|顏色|颜色|[紅红黃黄綠绿藍蓝][色的]|筆記|笔记|批註|批注|標記|标记|我的問題|我的问题|highlight", re.I)  # i18n-ok


def wants_marks(text: str) -> tuple[bool, set[str] | None]:
    """问题里提到“标红的”“划线”“我的笔记”这类词，才把读者的标记带上；提到具体颜色就只带那几种。"""
    if not MARK_WORDS.search(text or ""):
        return False, None
    colors = set()
    color_pairs = {"紅": "紅", "红": "紅", "黃": "黃", "黄": "黃", "綠": "綠", "绿": "綠", "藍": "藍", "蓝": "藍"}  # i18n-ok
    for source, output in color_pairs.items():
        if re.search(source + "[色的]|[標标]" + source, text):  # i18n-ok
            colors.add(output)
    return True, (colors | {"無顏色"} if colors and re.search(r"筆記|笔记|問題|问题|批註|批注", text) else colors or None)  # i18n-ok


def _marks_summary(ws: Workspace) -> str:
    notes = [n for n in (ws.load("reader").get("notes") or {}).values() if not n.get("deleted")]
    if not notes:
        return ""
    counts: dict[str, int] = {}
    for n in notes:
        k = COLOR_NAMES.get(n.get("color") or "yellow", "黃") + "色" if n.get("quote") else "無顏色筆記"  # i18n-ok
        counts[k] = counts.get(k, 0) + 1
    return "讀者在論文上做過 " + str(len(notes)) + " 處標記（" + "、".join(f"{k} {v}" for k, v in counts.items()) + "），這次問題沒提到，所以沒有附上。"  # i18n-ok


def prompt(ws: Workspace, messages: list[dict], anchor: str | None, quote: str, engine: str, refs: list[dict] | None = None,
           answer_style: str = answer_styles.DEFAULT) -> str:
    answer_style = answer_styles.parse(answer_style)
    history = messages[-HISTORY:]
    convo = "\n\n".join(("讀者" if m["role"] == "user" else "你") + "：" + m["content"] for m in history[:-1])  # i18n-ok
    ask = history[-1]["content"] if history else ""
    tool = ("需要查看全文時，使用 Read 工具讀取目前目錄的 paper.json（blocks 裡是譯文和原文）；讀者的全部標記在 reader.json 的 notes 裡。\n"  # i18n-ok
            if engine == "claude" else "")
    want, colors = wants_marks(ask)
    marks = _marks(ws, colors) if want else _marks_summary(ws)
    meta = ws.load("paper").get("meta") or {}
    style = (answer_styles.STE100_INSTRUCTIONS if answer_style == answer_styles.STE100
             else langs.reply_language_rule(meta) + "，直接、具體，能舉例就舉例。\n")  # i18n-ok
    whole = _paper_context(ws) if answer_style == answer_styles.STE100 else ""
    return ("你正在陪讀者閱讀一篇學術論文，回答他邊讀邊產生的問題。\n" + style  # i18n-ok
            + "區分「論文裡寫了什麼」和「你的補充解釋」，論文裡沒有的內容不要說成是論文說的。"  # i18n-ok
            "行內公式只使用 $TeX$，行間公式只使用 $$TeX$$。"  # i18n-ok
            r"不要使用 \(\) 或 \[\]，不要把公式放進反引號或程式碼區塊。"  # i18n-ok
            "行間公式的 $$ 必須單獨佔一行。公式內部可以換行，但不要在公式中插入空行；多行推導使用 aligned 環境。"  # i18n-ok
            "保留完整的上下標、括號和單位。提到原文位置時使用「式 5」「第 4 頁那段」，不要寫 [p4-5] 這類內部編號。只輸出回答本身，不要客套，不要重複問題。\n" + tool + "\n"  # i18n-ok
            + _context(ws, anchor, quote, refs)
            + ("\n\n" + whole if whole else "")
            + ("\n\n" + marks if marks else "")
            + (f"\n\n先前的對話：\n{convo}" if convo else "")  # i18n-ok
            + f"\n\n讀者目前的問題：{ask}")  # i18n-ok


# ---------- 流式输出 ----------
def stream(ecfg: dict, text: str, cwd: Path, cancel: threading.Event, on_model=None, meter=None) -> Iterator[str]:
    """on_model reports the model actually used; meter records token usage."""
    engines.require_model_access()
    e = ecfg.get("engine")
    bad = netcheck.problem(ecfg)
    if bad:
        raise engines.EngineError(bad)
    try:
        if e == "claude":
            yield from _stream_claude(ecfg["claude"], text, cwd, cancel, on_model, meter)
        elif e == "openai":
            yield from openai_api.stream(ecfg["openai"], text, cancel, meter)
        else:  # codex 没有逐字输出，整段给；不拉起用户的 MCP 和用不到的功能（见 codex_lean）
            yield engines.run(engines.for_translation(ecfg), text, cwd, None, cancel, meter)
    except engines.EngineError as err:
        raise engines.EngineError(netcheck.explain(ecfg, str(err))) from None


def _stream_claude(c: dict, text: str, cwd: Path, cancel, on_model=None, meter=None) -> Iterator[str]:
    """只给 Read 一个工具（--tools Read）：其余内置工具的定义每问一次都要发，约 2.7 万 token。
    这版 Claude Code 不认 --tools、还没输出任何字时，去掉它再问一次。"""
    engines.require_model_access()
    exe = engines.claude_path(c)
    if not exe:
        raise engines.EngineError(tr("找不到 Claude Code 命令（先装好并登录 Claude Code）"))
    args = [exe, "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
            "--allowedTools", "Read", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]
    if c.get("model"):
        args += ["--model", c["model"]]
    if c.get("reasoning_effort"):
        args += ["--effort", c["reasoning_effort"]]
    said = []
    try:
        for piece in _stream_once(args + engines.CLAUDE_LEAN, text, cwd, cancel, on_model, meter):
            said.append(piece)
            yield piece
    except engines.EngineError as e:
        if said or not engines.option_unknown(e):
            raise
        log.warning("Claude Code 不认 --tools，照旧调用：%s", str(e)[-300:])
        yield from _stream_once(args, text, cwd, cancel, on_model, meter)


def _stream_once(args: list[str], text: str, cwd: Path, cancel, on_model=None, meter=None) -> Iterator[str]:
    proc = engines._popen(args, cwd)
    proc.stdin.write(text)
    proc.stdin.close()
    done = threading.Event()

    def kill_on_cancel():
        while not done.wait(0.2):
            if cancel.is_set():
                if proc.poll() is None:
                    proc.kill()
                return

    threading.Thread(target=kill_on_cancel, daemon=True).start()
    got = False
    rate = None
    try:
        for line in proc.stdout:
            if cancel.is_set():
                raise engines.Cancelled()
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if ev.get("type") == "system" and ev.get("subtype") == "init" and ev.get("model") and on_model:
                on_model(ev["model"])
            if ev.get("type") == "stream_event":
                d = (ev.get("event") or {}).get("delta") or {}
                if d.get("type") == "text_delta" and d.get("text"):
                    got = True
                    yield d["text"]
            elif ev.get("type") == "rate_limit_event":
                rate = ev
            elif ev.get("type") == "result":
                if meter is not None:
                    meter.add(**usage.from_claude(ev, rate))
                if ev.get("is_error"):
                    raise engines.EngineError(tr("Claude Code 出错：{detail}", detail=str(ev.get("result") or ev.get("subtype"))))
                if not got and ev.get("result"):
                    yield ev["result"]
                return
        err = proc.stderr.read()[-400:]
        if not got:
            raise engines.EngineError(err or tr("Claude Code 没有输出"))
    finally:
        if proc.poll() is None:
            proc.kill()
        done.set()  # 让 kill_on_cancel 线程退出
