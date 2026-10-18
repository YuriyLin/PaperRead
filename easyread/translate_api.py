"""整篇翻译入口：继续确认中的任务、重试失败页、给已整理的原文补译文。"""
from __future__ import annotations

from . import paperdata, review_policy, translate
from .i18n import tr


def enqueue(jobs, ws, body: dict) -> dict:
    if review_policy.isolated() and not body.get("pages"):
        raise ValueError(tr("隔離驗證必須明確指定 PDF 頁碼。"))
    last = ws.load("job") or {}
    table_confirmation = last.get("state") == "confirm" and last.get("tables_only")
    if body.get("tables_only") is True or table_confirmation:
        pages = paperdata.parse_pages(body["pages"]) if body.get("pages") is not None else last.get("pages") if table_confirmation else None
        if table_confirmation and pages is not None and body.get("scope"):
            selected = translate.scope_pages(ws, body["scope"])
            if selected is not None:
                pages = [n for n in pages if n in selected]
        if pages is not None and any(n < 1 or n > (ws.load("paper").get("meta", {}).get("page_count") or 0) for n in pages):
            raise ValueError("Table page is outside the source PDF")
        fields = {"confirmed": body.get("confirmed") is True, "cap_check": True} if table_confirmation else {}
        jobs.enqueue(ws, pages=pages, tables_only=True, **fields)
        return {"ok": True}
    pending = last.get("state") == "confirm"
    explicit = body.get("pages") is not None
    pages = paperdata.parse_pages(body["pages"]) if explicit else None
    cap_check = False
    scope = body.get("scope") or (last.get("scope") if pending else None)
    read = bool(last.get("read")) if pending else bool(body.get("read"))
    model = (last.get("model") or "") if pending else str(body.get("model") or "")
    target = (last.get("target") or "") if pending else ""
    if pending and not explicit:
        # 确认的是等待时已算好的页，不能因为后来又整理了原文而扩大范围。
        pages = last.get("pages")
        cap_check = last.get("cap_check") is True
        if pages is not None and body.get("scope") and scope != last.get("scope"):
            selected = translate.scope_pages(ws, scope)
            if selected is not None:
                pages = [n for n in pages if n in selected]
                cap_check = False  # 用户已选择更小的明确范围。
    if body.get("failed"):
        pages = sorted(int(k) for k in (last.get("failed") or {})) or None
        read, model, target = bool(last.get("read")), last.get("model") or "", last.get("target") or ""
    elif body.get("en"):
        read = False
        if not explicit and not pending:
            pages = sorted(set((ws.load("paper").get("translation") or {}).get("en_pages", [])))
            cap_check = True  # 系统生成的页计划仍需确认；用户亲自填 pages 才豁免。
    jobs.enqueue(ws, pages=pages, translate_after=True, scope=scope, read=read, model=model,
                 confirmed=body.get("confirmed") is True, target=target, cap_check=cap_check)
    return {"ok": True}
