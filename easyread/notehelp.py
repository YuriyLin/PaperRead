"""論文筆記的 AI 助手：點評、幫我改、起草稿。

和「問 AI」對話分開：結果直接流回筆記面板，不進對話記錄；由讀者決定要不要替換或追加到筆記裡。
輸出格式和對話一樣：一行一個 JSON，{"t": 片段} … 最後 {"done": true} 或 {"error": …}。
"""
from __future__ import annotations

import json
import threading

from . import langs
from . import chat, chat_models, config, engines
from .i18n import tr
from .log import log
from .prompts import _block_text
from .store import Workspace

PAPER_BUDGET = 48000  # 不能自己读文件的引擎：随提示词附上的原文与表格字数上限
ANNOTATION_BUDGET = 2500  # 随提示词附上的读者划线与批注字数上限

ASK = {
    "review": ("請點評這份筆記：哪些理解是準確的；哪些地方和論文不符或理解有誤（說清論文實際怎麼說、在哪一節）；"  # i18n-ok 提示詞
               "漏掉了哪些重要內容；還可以往哪想。直接、具體，分條寫，不要客套，不要重寫整份筆記。"),  # i18n-ok
    "revise": ("請幫讀者修改並完善這份筆記：保留他的觀點、結構和口吻，修正和論文不符的地方，補上明顯漏掉的要點，把表達理順。"  # i18n-ok
               "善用富文本結構：理順標題層級，適度補充關鍵公式（$TeX$）、數據對比表格或待辦清單（- [ ]）。"  # i18n-ok
               "若筆記中有未填寫的空白區塊、空引用塊或空列點，請直接根據論文內容補齊具體內容並移除空白項目。"  # i18n-ok
               "只輸出修改後的完整筆記（Markdown，公式寫 $TeX$），不要解釋改了什麼。"),  # i18n-ok
    "draft": ("讀者還沒寫筆記。請根據論文內容與讀者標註幫他起一份結構嚴謹、內容充實的高品質讀書筆記。"  # i18n-ok
              "所有章節標題與內文一律依照指定語言撰寫（保留模型、資料集與指標英文原名）。"  # i18n-ok
              "充分利用富文本排版能力：\n"  # i18n-ok
              "1. 核心問題與動機：闡明背景、核心痛點，並用引用塊（> ）總結作者的核心直覺洞見。\n"  # i18n-ok
              "2. 方法與資料流要點：梳理模組分工，寫出關鍵數學公式（行內 $TeX$ 或獨立 $$TeX$$）。\n"  # i18n-ok
              "3. 主要結論與關鍵實驗證據：將論文中的關鍵實驗表格數據（如主實驗或消融實驗）整理成 Markdown 表格，並搭配條列結論。\n"  # i18n-ok
              "4. 局限與延伸思考：指出缺陷或假設條件，並用待辦清單（- [ ]）列出後續可追蹤或復現的問題。\n"  # i18n-ok
              "使用 Markdown 標題（##）與分層條列組織以利轉為心智圖。請直接寫出具體分析與結論，不要留空白填空區或空列點。只輸出筆記本身。"),  # i18n-ok
}


def _table_text(b: dict) -> str:
    cap = b.get("caption_en") or b.get("caption_zh") or ""
    rows = [r for r in (b.get("head") or []) + (b.get("rows") or []) if isinstance(r, list)]
    table_lines = [" | ".join(str(cell).replace("\n", " ").strip() for cell in row) for row in rows]
    return "\n".join(filter(None, [cap, *table_lines]))


def _source_block_text(b: dict) -> str:
    """提取論文區塊文字：以精準原文（英文）為主，保留數學公式與表格。"""
    btype = b.get("type")
    if btype == "list":
        return "\n".join(f"- {it.get('en') or it.get('zh', '')}" for it in b.get("items", []) if isinstance(it, dict))
    if btype == "table":
        return _table_text(b)
    if btype == "figure":
        return b.get("caption_en") or b.get("caption_zh") or ""
    if btype == "math":
        tex = b.get("tex", "")
        return f"$${tex}$$" if tex else ""
    return b.get("en") or b.get("zh") or ""


def _paper_text(ws: Workspace) -> str:
    paper = ws.load("paper")
    blocks = paper.get("blocks", [])
    gl = paper.get("glossary", [])
    out, used = [], 0
    if gl:
        gl_text = "已有術語表（專有名詞請依此對照）：\n" + "\n".join(f"- {g['en']} = {g['zh']}" for g in gl if g.get("en"))  # i18n-ok 提示詞
        out.append(gl_text + "\n")
        used += len(gl_text)
    for b in blocks:
        if b.get("type") == "references":
            break
        btype = b.get("type")
        if btype == "heading":
            t = "\n## " + (b.get("en") or b.get("zh") or "")
        else:
            t = _source_block_text(b)
        if not t:
            continue
        if used + len(t) > PAPER_BUDGET:
            out.append("……（後面的內容省略）")  # i18n-ok 提示詞
            break
        out.append(t)
        used += len(t)
    return "\n".join(out)


def _reader_annotations(ws: Workspace) -> str:
    notes = (ws.load("reader").get("notes") or {}).values()
    lines, used = [], 0
    for item in notes:
        if not isinstance(item, dict):
            continue
        quote = str(item.get("quote") or "").strip()
        body = str(item.get("body") or "").strip()
        if not quote and not body:
            continue
        parts = []
        if quote:
            parts.append(f"劃線：「{quote}」")  # i18n-ok 提示詞
        if body:
            parts.append(f"批註：{body}")  # i18n-ok 提示詞
        entry = "- " + "｜".join(parts)  # i18n-ok 提示詞
        if used + len(entry) > ANNOTATION_BUDGET:
            break
        lines.append(entry)
        used += len(entry)
    return "\n".join(lines)


def prompt(ws: Workspace, mode: str, note: str, engine: str) -> str:
    meta = ws.load("paper").get("meta", {})
    title = meta.get("title_zh") or meta.get("title_en") or ""
    paper = ("論文全文在目前目錄的 paper.json 裡（blocks 裡是譯文和原文），需要核對時使用 Read 工具讀取。"  # i18n-ok 提示詞
             if engine == "claude" else "論文原文與關鍵資料（節錄）：\n" + _paper_text(ws))  # i18n-ok
    annotations = _reader_annotations(ws)
    ann_block = f"讀者在正文中的劃線與批註：\n{annotations}\n\n" if annotations else ""  # i18n-ok 提示詞
    return (f"你正在幫讀者整理論文《{title}》的筆記。{langs.reply_language_rule(meta)}。{ASK[mode]}\n\n{paper}\n\n"  # i18n-ok
            + ann_block
            + (f"讀者的筆記：\n<<<\n{note}\n>>>" if note.strip() else ""))  # i18n-ok


def is_local_model(ecfg: dict, m: dict) -> bool:
    if m.get("engine") != "openai":
        return False
    preset = (m.get("preset") or "").lower()
    base_url = (ecfg.get("openai", {}).get("base_url") or m.get("base_url") or "").lower()
    return preset in ("ollama", "lmstudio") or any(h in base_url for h in ("127.0.0.1", "localhost", "::1", "0.0.0.0"))


def local_model_notice(ecfg: dict, m: dict) -> str:
    if not is_local_model(ecfg, m):
        return ""
    return tr("提示：检测到当前使用本地模型（Ollama / LM Studio），默认上下文通常较小（常为 2k~8k）；若长篇论文未在 Modelfile 调大 num_ctx，后半部实验数据可能受限。")


def handle(handler, ws: Workspace, body: dict) -> None:
    """server.py 里 POST /api/p/<id>/notehelp 调这里；handler 是那次请求的 BaseHTTPRequestHandler。"""
    mode = body.get("mode")
    note = str(body.get("note") or "")[:20000]
    if mode not in ASK:
        raise ValueError(tr("mode 只能是 review / revise / draft"))
    if mode != "draft" and not note.strip():
        raise ValueError(tr("笔记还是空的"))
    ecfg, m = chat_models.engine_cfg(config.load(), body.get("model"))
    text = prompt(ws, mode, note, ecfg["engine"])
    handler.send_response(200)
    handler.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Connection", "close")
    handler.end_headers()
    handler.close_connection = True
    cancel = threading.Event()

    def send(obj):
        handler.wfile.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
        handler.wfile.flush()
    try:
        init_payload = {"model": chat_models.label(m)}
        notice = local_model_notice(ecfg, m)
        if notice:
            init_payload["notice"] = notice
        send(init_payload)
        for piece in chat.stream(ecfg, text, ws.root, cancel):
            send({"t": piece})
        send({"done": True})
    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
        cancel.set()  # 读者点了停止或关了页面
    except engines.Cancelled:
        pass
    except Exception as e:  # noqa: BLE001
        log.exception("笔记帮手出错 %s", ws.id)
        try:
            send({"error": str(e)[:500]})
        except OSError:
            pass
