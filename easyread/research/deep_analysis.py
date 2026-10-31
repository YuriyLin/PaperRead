"""Technical deep audit / X-Ray analysis for library papers."""
from __future__ import annotations

import re
import time
from datetime import datetime, timezone
from pathlib import Path

from .. import chat_models, config, engines, usage
from ..i18n import tr
from ..store import write_json_atomic
from . import tasks, obsidian_export

MAX_TEXT_CHARS = 48000

AUDIT_PROMPT_SYSTEM = """你是一位具備頂尖同行評審（Senior Peer Reviewer / Area Chair）標準的學術技術審計員。
你的任務是對以下論文進行客觀、深度、技術性的全面審查與剖析。

【核心原則】
1. 只輸出繁體中文（臺灣習慣用語），學術專有名詞（如 Transformer、Ablation、Zero-shot、Backpropagation 等）保留標準英文或附括號原文。
2. 秉持「嚴謹批判、不講客套」的態度，拒絕空泛的讚美或套話；嚴格區分作者聲稱（Claim）與論文實證（Evidence）。若論文缺乏實質證據或推論跳躍，必須直接指明。
3. 數學公式：行內公式一律使用 $TeX$，獨立行間公式一律使用 $$TeX$$ 並單獨成行。不要使用 \\( \\) 或 \\[ \\]。公式內部保持乾淨，多行推導使用 aligned。
4. 引用位置：提及原文依據時標註章節名或頁碼（如「第 3.2 節」「第 5 頁表 2」），不要憑空捏造。若正文未提供某項資訊，明確註記「論文未報告」。

【報告結構】請嚴格依照以下 5 大維度展開詳細剖析，使用二級標題（##）：

## 1. 核心假說與實證對齊
- 精確提煉作者在摘要與引言中提出的 1~3 項核心假說（Core Claims）與方法創新點。
- 逐一對照正文論證與實驗結果，評估每項主張的實證支持強度（「充分支持」、「部分支持」或「存在推論跳躍」）。
- 指出作者是否有論述過於寬泛、宣傳性評價或未經直接實驗檢驗之處。

## 2. 消融實驗審計 (Ablation Audit)
- 核心架構機制 vs 輔助性技巧 (Engineering Tricks) 貢獻拆解：這篇論文的核心架構到底帶來了多少增益？哪些提升其實來自於資料增強、學習率調度、正規化等次要工程技巧？
- 關鍵組件敏感度：拿掉關鍵設計（如移除特定 Attention、特定 Loss 權重）後性能如何變化？列出關鍵數據。
- 對照組缺陷：審查作者是否缺少「應該做卻沒做」的控制組（Control Group）或消融對照？

## 3. 關鍵公式微型推導與數值示範 (Formula & Toy Example)
- 挑選本文最關鍵的 1~2 個核心數學公式，說明每個變數、運算子與張量形狀（Tensor Dimensions）的物理或統計意涵。
- 提供一組可手算的微型數值示例 (Toy Example)：設定極簡的具體數值（例如 2 個維度或 2 個 token 的小向量/小矩陣），一步步手算展示前向計算過程與每一步中間值，直至算出最終數值。明確標記這是教學示範，讓讀者看懂底層計算細節。

## 4. 實驗條件、基線公平性與資料審查
- 評估指標：所選用的指標（如 BLEU、Accuracy、FID 等）是否能真實反映該任務的核心痛點？是否有挑選有利指標的嫌疑？
- Baselines 公平性：對比的先前文獻是否為當下強基準？對照方法是否獲得了同等的訓練步數、參數量與超參數調優預算？
- 資料與開銷：是否存在潛在的資料外洩 (Data Leakage) 或過擬合測試集的風險？作者是否如實報告了 GPU/TPU 訓練時長、FLOPs 與推論延遲？

## 5. 局限性、邊界條件與潛在盲點
- 作者明示局限 vs 隱含邊界：區分作者在 Conclusion/Limitation 中承認的問題，與實驗數據背後隱含的適用邊界。
- 失效模式 (Failure Modes)：在哪些邊界情況、極端分佈 (OOD) 或實際落地環境中，本方法很可能會失效？
- 未解的核心挑戰與未來延伸方向。
"""


def extract_paper_text(ws, max_chars: int = MAX_TEXT_CHARS) -> tuple[dict, str]:
    paper = ws.load("paper") or {}
    meta = paper.get("meta") or {}
    blocks = paper.get("blocks") or []
    lines = []

    title = meta.get("title_zh") or meta.get("title_en") or ws.id
    authors = meta.get("authors") or ""
    abstract = meta.get("abstract") or ""
    lines.append(f"論文標題：{title}")
    if authors:
        lines.append(f"作者：{authors}")
    if abstract:
        lines.append(f"摘要：\n{abstract}\n")

    section = "未標示章節"
    for block in blocks:
        kind = block.get("type") or "paragraph"
        if kind == "references":
            continue
        if kind == "heading":
            section = " ".join(str(block.get(k) or "").strip() for k in ("num", "en", "zh")).strip() or section
            lines.append(f"\n[章節標題 p.{block.get('page') or '?'}] {section}")
            continue
        content = [str(block.get(k) or "").strip() for k in ("en", "caption_en", "tex")]
        if not any(content):
            content = [str(block.get(k) or "").strip() for k in ("zh", "caption_zh")]
        if kind == "list":
            content.extend(str(item.get("en") or item.get("zh") or "").strip() for item in block.get("items") or [])
        if kind == "table":
            content.extend(" | ".join(map(str, row)) for row in (block.get("head") or []) + (block.get("rows") or []))
        val = "\n".join(p for p in content if p)
        if val:
            lines.append(f"[{block.get('id') or '?'} p.{block.get('page') or '?'}] {val}")

    full = "\n".join(lines)
    if len(full) > max_chars:
        full = full[:max_chars] + "\n\n...（正文超過字數上限已節錄）..."
    return meta, full


def get_report(ws) -> dict | None:
    if not ws:
        return None
    rep = ws.load("report")
    if rep and isinstance(rep, dict) and rep.get("markdown"):
        return rep
    return None


def list_reports(lib) -> list[dict]:
    reports = []
    for ws in lib.all():
        rep = ws.load("report")
        if rep and isinstance(rep, dict) and rep.get("markdown"):
            meta = (ws.load("paper") or {}).get("meta") or {}
            item = ws.load("item") or {}
            reports.append({
                "paper_id": ws.id,
                "title": meta.get("title_zh") or meta.get("title_en") or item.get("title") or ws.id,
                "authors": meta.get("authors") or item.get("authors") or "",
                "year": meta.get("year") or item.get("year") or "",
                "venue": meta.get("venue") or item.get("venue") or "",
                "model": rep.get("model", ""),
                "created_at": rep.get("created_at", ""),
                "updated_at": rep.get("updated_at", ""),
                "focus": rep.get("focus", ""),
                "markdown": rep.get("markdown", ""),
            })
    return sorted(reports, key=lambda x: str(x.get("updated_at") or ""), reverse=True)


def delete_report(ws) -> dict:
    if not ws:
        raise ValueError(tr("找不到指定的論文"))
    report_file = ws.root / "report.json"
    if report_file.is_file():
        report_file.unlink()
    return {"ok": True, "paper_id": ws.id}


def current_task(root: Path, pid: str | None = None) -> dict | None:
    scope = tasks.scope_id(root)
    live = next((t for t in tasks.list_tasks(scope=scope)
                 if t.get("kind") == "deep-analysis" and (not pid or t.get("paper_id") == pid or t.get("key") == pid)), None)
    if live:
        return tasks.get(live["id"], scope=scope) or live
    return None


def start_deep_analysis_task(app, pid: str, model: str = "", focus: str = "") -> dict:
    ws = app.lib.ws(pid)
    if not ws:
        raise ValueError(tr("找不到指定的論文：{id}", id=pid))
    scope = tasks.scope_id(app.lib.root)

    def run(cancel, report):
        report("read", 1, 4, tr("正在讀取論文原文與章節結構…"))
        meta, text = extract_paper_text(ws)
        if not text.strip():
            raise ValueError(tr("論文尚未完成原文整理，無法進行深度剖析。"))

        report("audit", 2, 4, tr("正在進行深度技術審計與微型推導…"))
        cfg = config.load()
        model_cfg, selected = chat_models.engine_cfg(cfg, model or (cfg.get("chat") or {}).get("default"))
        meter = usage.Meter(model_cfg.get("engine", ""))

        prompt = AUDIT_PROMPT_SYSTEM + f"\n\n【論文全文內容】\n{text}"
        if focus.strip():
            prompt += f"\n\n【讀者特別關注的審查重點】\n讀者提出了本次剖析的特別焦點：{focus.strip()}\n請在完成上述 5 大維度分析的同時，在文末增加「## 6. 特別焦點深度回應」，專門針對讀者的焦點進行深度剖析。"

        answer = engines.run(engines.for_translation(model_cfg), prompt, app.lib.root, [], cancel, meter).strip()

        report("save", 3, 4, tr("正在儲存深度剖析報告…"))
        now_iso = datetime.now(timezone.utc).isoformat()
        result_data = {
            "paper_id": ws.id,
            "title": meta.get("title_zh") or meta.get("title_en") or ws.id,
            "model": selected.get("name") or selected.get("id") or model or "",
            "created_at": now_iso,
            "updated_at": now_iso,
            "focus": focus,
            "markdown": answer,
        }
        write_json_atomic(ws.root / "report.json", result_data)

        report("done", 4, 4, tr("深度剖析報告已完成！"))
        return {"paper_id": pid, "result": result_data}

    task = tasks.submit("deep-analysis", run, retry_failed=True, scope=scope,
                        key=pid, paper_id=pid)
    return task


def apply_to_paper_note(ws, report_markdown: str) -> dict:
    if not ws:
        raise ValueError(tr("找不到指定的論文"))
    reader = ws.load("reader") or {}
    current_note = (reader.get("paper_note") or {}).get("body") or ""
    now_str = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M")
    section_text = f"\n\n---\n\n## 🔬 論文深度剖析報告（{now_str}）\n\n{report_markdown.strip()}\n"
    new_body = (current_note.rstrip() + section_text) if current_note.strip() else section_text.strip()
    res = ws.apply_reader_ops([{"op": "paper_note", "body": new_body}])
    return {"ok": True, "rev": res.get("rev")}


def export_to_obsidian(ws, report_data: dict) -> dict:
    if not ws:
        raise ValueError(tr("找不到指定的論文"))
    meta = (ws.load("paper") or {}).get("meta") or {}
    title = meta.get("title_zh") or meta.get("title_en") or ws.id
    markdown = str(report_data.get("markdown") or "").strip()
    if not markdown:
        saved = get_report(ws)
        markdown = (saved or {}).get("markdown") or ""
    if not markdown:
        raise ValueError(tr("目前尚無可匯出的深度剖析報告"))
    stem = obsidian_export._safe_title(meta.get("title_en") or meta.get("title_zh") or ws.id, "Paper")
    doc = {
        "id": f"paper:{ws.id}:deep_analysis",
        "kind": "deep-analysis",
        "paper_id": ws.id,
        "title": f"{title} - 深度剖析",
        "filename": f"{stem}-deep-analysis",
        "body": markdown,
    }
    return obsidian_export.export_to_vault([doc])
