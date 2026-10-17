"""文献库：一个目录里放多篇论文，每篇一个子目录（目录名就是 id，取 PDF 的 SHA-256 前 12 位）。"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import time
from datetime import datetime
from pathlib import Path

from . import page_check, review_policy, sources
from .i18n import tr
from .log import log
from .store import SCHEMA, Workspace, empty_discussion, empty_reader, now_iso, read_json, write_json_atomic



def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class Library:
    def __init__(self, root: Path):
        self.root = review_policy.require_path(Path(root), "library").resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def ws(self, pid: str) -> Workspace | None:
        if not re.fullmatch(r"[A-Za-z0-9_\-]{4,64}", pid or ""):
            return None
        p = self.root / pid
        return Workspace(p) if (p / "paper.json").exists() else None

    def all(self) -> list[Workspace]:
        return [Workspace(p) for p in sorted(self.root.iterdir()) if p.is_dir() and not p.name.startswith(".") and (p / "paper.json").exists()]

    # ---------- 列表摘要 ----------
    def summary(self, ws: Workspace) -> dict:
        paper = ws.load("paper") or {}
        meta = dict(paper.get("meta", {}))
        item = ws.load("item") or {}
        meta.update({k: v for k, v in (item.get("meta_override") or {}).items() if v or k == "doi"})
        reader = ws.load("reader") or {}
        disc = ws.load("discussion") or {}
        job = ws.load("job") or {}
        tr = paper.get("translation", {})
        if tr.get("done_pages") and not tr.get("gaps_checked"):  # 旧版本误记成已译的空页改回没译（#55），每篇只查一次
            try:
                if page_check.repair_done(ws):
                    tr = (ws.load("paper") or {}).get("translation", {})
            except OSError:
                log.exception("核对已译页失败 %s", ws.id)
        notes = [n for n in reader.get("notes", {}).values() if not n.get("deleted")]
        replied = {e.get("reply_to") for e in disc.get("entries", []) if e.get("reply_to")}
        abstract = next((b.get("zh") or b.get("en") for b in paper.get("blocks", []) if b.get("role") == "abstract"), "") or meta.get("abstract_en", "")
        return {
            "id": ws.id,
            "title_zh": meta.get("title_zh", ""), "title_en": meta.get("title_en", ""), "short_zh": meta.get("short_zh", ""), "target": meta.get("target", ""),
            "authors": meta.get("authors", ""), "affiliation": meta.get("affiliation", ""),
            "year": meta.get("year") or _year(meta.get("date", "")), "date": meta.get("date", ""),
            "venue": meta.get("venue", ""), "arxiv": meta.get("arxiv", ""), "url": _link(meta), "doi": meta.get("doi", ""),
            "pages": meta.get("page_count", 0), "done_pages": len(tr.get("done_pages", [])), "en_pages": len(tr.get("en_pages", [])),
            "todo": _todo(meta.get("page_count", 0), tr),
            "parsed_blocks": len(paper.get("blocks") or []),
            "abstract": abstract,
            "meta_override": item.get("meta_override") or {},
            "tags": item.get("tags", []), "status": item.get("status", "unread"), "starred": bool(item.get("starred")),
            "archived": bool(item.get("archived")),
            "interested": bool(item.get("interested")), "reading_plan": item.get("reading_plan") or {},
            "paper_ref": item.get("paper_ref", ""),
            "manual_order": item.get("manual_order", 0), "openalex_id": meta.get("openalex_id", ""),
            "added": item.get("added", ""), "last_opened": item.get("last_opened", ""),
            "progress": (reader.get("progress") or {}).get("ratio", 0),
            "notes": len([n for n in notes if n.get("kind") != "highlight"]),
            "highlights": len([n for n in notes if n.get("kind") == "highlight"]),
            "open_questions": len([n for n in notes if n.get("kind") == "question" and n["id"] not in replied]),
            "discussions": len(disc.get("entries", [])),
            "has_paper_note": bool((reader.get("paper_note") or {}).get("body")),
            "job": {k: job.get(k) for k in ("type", "state", "message", "done", "total", "updated", "error", "failed", "scope", "read", "model", "target", "pages", "cap_check", "page_cap", "usage", "usage_total")} if job else None,
            "thumb": f"/p/{ws.id}/pages/page-001.webp" if (ws.root / "pages" / "page-001.webp").exists() else "",
        }

    def list(self) -> list[dict]:
        return [self.summary(ws) for ws in self.all()]

    # ---------- 导入 ----------
    def create_from_pdf(self, data: bytes, filename: str, meta: dict | None = None) -> tuple[Workspace, bool]:
        """建目录、落 PDF 和空数据文件。渲染原页、抽文字放到后台任务里做。返回 (目录, 是否新建)。"""
        if not data.startswith(b"%PDF"):
            raise ValueError(tr("不是 PDF 文件"))
        digest = sha256_bytes(data)
        pid = digest[:12]
        ws = Workspace(self.root / pid)
        if (ws.root / "paper.json").exists():
            return ws, False
        ws.root.mkdir(parents=True, exist_ok=True)
        (ws.root / "source.pdf").write_bytes(data)
        base_meta = {"title_zh": "", "title_en": "", "authors": "", "source": filename, "source_sha256": digest, "pdf": "source.pdf"}
        base_meta.update(meta or {})
        if not base_meta.get("title_en"):
            base_meta["title_en"] = _pdf_title(ws.root / "source.pdf") or Path(filename).stem
        write_json_atomic(ws.paper_path, {
            "schema": SCHEMA, "meta": base_meta,
            "translation": {"scope": "未开始", "done_pages": [], "note": ""},  # i18n-ok 存进 paper.json
            "glossary": [], "references": [], "blocks": [],
        })
        write_json_atomic(ws.discussion_path, empty_discussion())
        write_json_atomic(ws.reader_path, empty_reader())
        write_json_atomic(ws.item_path, {"added": now_iso(), "tags": [], "status": "unread", "starred": False})
        return ws, True

    def fetch(self, ref: str) -> tuple[bytes, str, dict]:
        """链接、arXiv 编号、DOI、标题 → (PDF, 文件名, 元数据)。见 sources.py。"""
        try:
            return sources.fetch(ref)
        except sources.SourceError as e:
            log.warning("导入失败 %s：%s", ref[:200], e)  # 用户说“某个链接导不进来”时能查到原因
            raise

    def trash(self, pid: str) -> Path:
        ws = self.ws(pid)
        if not ws:
            raise KeyError(pid)
        dest = self.root / ".trash" / f"{pid}-{datetime.now():%Y%m%d%H%M%S}"
        dest.parent.mkdir(exist_ok=True)
        # 只整体改名，不用 shutil.move：改名失败时它会退回“复制再删”，删到一半出错就剩半个目录。
        # 刚取消的翻译要零点几秒才停下（Claude Code 进程的工作目录就在这里），多等几次
        for attempt in range(20):
            try:
                ws.root.rename(dest)
                return dest
            except PermissionError:
                if attempt == 19:
                    raise ValueError(tr("这篇论文的文件还被占用着（可能正在翻译或生成图片），等几秒再删")) from None
                time.sleep(0.25)
        return dest

    def find_by_sha(self, digest: str) -> Workspace | None:
        return self.ws(digest[:12])


def _todo(total: int, tr: dict) -> str:
    """还没译的页，写成 "3-5,9"（选页翻译用）。只读原文整理过、没译的页也算没译。"""
    done = set(tr.get("done_pages", [])) - set(tr.get("en_pages", []))
    out = []
    for n in range(1, (total or 0) + 1):
        if n in done:
            continue
        if out and out[-1][1] == n - 1:
            out[-1][1] = n
        else:
            out.append([n, n])
    return ",".join(str(a) if a == b else f"{a}-{b}" for a, b in out)


def _year(date: str) -> str:
    m = re.search(r"(19|20)\d{2}", date or "")
    return m.group(0) if m else ""


def _pdf_title(path: Path) -> str:
    try:
        import pypdf
        t = (pypdf.PdfReader(str(path)).metadata or {}).get("/Title", "") or ""
        return str(t).strip()
    except Exception:  # noqa: BLE001
        return ""


def migrate_folder(src: Path, lib: Library) -> Workspace:
    """把旧版技能生成的“xxx-共读”目录搬进文献库。"""
    src = Path(src)
    data = (src / "source.pdf").read_bytes()
    pid = sha256_bytes(data)[:12]
    dest = lib.root / pid
    if not dest.exists():
        shutil.copytree(src, dest, ignore=shutil.ignore_patterns("server.json", "*.html", "打开共读.cmd", ".write.lock"))  # i18n-ok 旧版文件名
    ws = Workspace(dest)
    if not ws.item_path.exists():
        write_json_atomic(ws.item_path, {"added": now_iso(), "tags": [], "status": "reading", "starred": False})
    reader = read_json(ws.reader_path, {}) or {}
    reader.setdefault("paper_note", {})
    write_json_atomic(ws.reader_path, reader)
    return ws



def _link(meta: dict) -> str:
    """论文主页链接：填了就用；否则由 arXiv 编号或 DOI 推出来。"""
    if meta.get("url"):
        return meta["url"]
    m = sources.ARXIV_RE.search(meta.get("arxiv") or meta.get("source") or "")
    if m and (meta.get("arxiv") or re.fullmatch(r"\d{4}\.\d{4,5}(v\d+)?\.pdf", meta.get("source") or "")):
        aid = re.sub(r"v\d+$", "", m.group(1))  # f-string 里不能有反斜杠（Python 3.10/3.11）
        return f"https://arxiv.org/abs/{aid}"
    return f"https://doi.org/{meta['doi']}" if meta.get("doi") else ""

if __name__ == "__main__":  # 调试用：打印库摘要
    import sys
    print(json.dumps(Library(Path(sys.argv[1])).list(), ensure_ascii=False, indent=1))
