"""成批搬进文献库：从 Zotero 迁移、导入整个文件夹都走这里。在后台线程里一条条做，页面轮询进度。

来源先读成一串条目（zotero/reader.py、bulk/folder.py），每条：读 PDF → 建论文（同一个 PDF 已经在库里
就不重建）→ 放进对应分类（可选再加“Zotero 标签/标签名”）→ 排队渲染原页。不翻译。
没有 PDF 的条目默认跳过；选了“联网下载”时，有 DOI 或 arXiv 编号的去下载。
再做一次是安全的：已经在库里的只补分类，不重复建。"""
from __future__ import annotations

import hashlib
import re
import threading
from pathlib import Path

from .. import prefs
from ..i18n import tr
from ..log import log
from ..store import dir_lock, read_json, write_json_atomic
from ..zotero import locate, reader
from ..zotero.reader import Entry, Snapshot
from . import folder

SEG = 40     # 分类每一级最多多少字
PATH = 120   # 整条路径（页面校验 tag 不超过 128）
SYNC_HISTORY = ".zotero-sync.json"


def _digest_file(file) -> str:
    digest = hashlib.sha256()
    for chunk in iter(lambda: file.read(1024 * 1024), b""):
        digest.update(chunk)
    return digest.hexdigest()


def _history(lib) -> set[str]:
    data = read_json(lib.root / SYNC_HISTORY, {})
    return set(data.get("sha256", [])) if isinstance(data, dict) else set()


def _remember(lib, digest: str) -> None:
    with dir_lock(lib.root, name=".zotero-sync.lock"):
        seen = _history(lib)
        if digest not in seen:
            write_json_atomic(lib.root / SYNC_HISTORY, {"sha256": sorted(seen | {digest})})


def _deleted(lib, digest: str, seen: set[str]) -> bool:
    if lib.ws(digest[:12]):
        return False
    trash = lib.root / ".trash"
    if digest in seen:
        return True
    if trash.is_dir():
        for folder in trash.glob(digest[:12] + "-*"):
            paper = read_json(folder / "paper.json", {})
            if (paper.get("meta") or {}).get("source_sha256") == digest:
                return True
    return False


def cat_path(*parts: str) -> str:
    segs = [p.strip().replace("/", "／")[:SEG] for p in parts if p and p.strip()]
    return "/".join(segs)[:PATH]


def _clip(path: str) -> str:
    return cat_path(*path.split("/"))


def _title(e: Entry) -> str:
    return e.meta.get("title_en") or (e.pdf.name if e.pdf else e.key)


def read(source: str, path: str, base: str = "") -> tuple[Snapshot, str]:
    """(条目, 规范后的路径)。source：zotero / folder。"""
    if source == "zotero":
        return reader.read(path, base), str(locate.resolve(path))
    if source == "folder":
        return folder.read(path), str(Path(path).expanduser().resolve())
    raise ValueError(tr("不认识的来源：{source}", source=source))


class Migration:
    def __init__(self, app):
        self.app = app
        self.lock = threading.Lock()
        self.status: dict = {"state": "idle"}
        self.cancel = threading.Event()

    def busy(self) -> bool:
        return self.status.get("state") == "running"

    # ---------- 先看一眼 ----------
    def scan(self, source: str, path: str, base: str = "") -> dict:
        snap, where = read(source, path, base)
        es = snap.entries
        no_pdf = [e for e in es if not e.pdf]
        return {
            "source": source, "path": where, "from_backup": snap.from_backup,
            "total": len(es), "with_pdf": len(es) - len(no_pdf),
            "no_pdf": len(no_pdf), "fetchable": sum(1 for e in no_pdf if e.meta.get("doi") or e.meta.get("arxiv")),
            "collections": len(snap.collections), "tags": len({t for e in es for t in e.tags}),
            "missing": [{"title": _title(e), "why": e.missing} for e in no_pdf[:50]],
        }

    def sync_preview(self, path: str, base: str = "") -> dict:
        snap, _ = read("zotero", path, base)
        lib = self.app.lib
        seen = _history(lib)
        deleted, seen_hashes = [], set()
        for entry in snap.entries:
            if not entry.pdf:
                continue
            try:
                with entry.pdf.open("rb") as file:
                    digest = _digest_file(file)
            except OSError:
                continue
            if digest not in seen_hashes and _deleted(lib, digest, seen):
                deleted.append({"sha256": digest, "title": _title(entry)})
                seen_hashes.add(digest)
        return {"deleted": deleted, "from_backup": snap.from_backup,
                "library_token": hashlib.sha256(str(lib.root).encode("utf-8")).hexdigest()}

    # ---------- 搬 ----------
    def start(self, source: str, path: str, base: str = "", with_tags: bool = True, fetch: bool = False,
              link: bool = False, sync: bool = False, selected: list[str] | None = None, library_token: str = "") -> dict:
        if link and fetch:
            raise ValueError(tr("链接导入只支持本地 PDF 文件"))
        if sync and (source != "zotero" or link or fetch):
            raise ValueError(tr("Zotero 同步只複製本機 PDF"))
        if selected is not None and (not isinstance(selected, list) or len(selected) > 10000 or any(not isinstance(x, str) or not re.fullmatch(r"[0-9a-f]{64}", x) for x in selected)):
            raise ValueError(tr("同步選取資料無效。"))
        with self.lock:
            if self.busy():
                raise ValueError(tr("已经在迁移了，等这一次做完"))
            lib, jobs = self.app.lib, self.app.jobs
            if sync and library_token != hashlib.sha256(str(lib.root).encode("utf-8")).hexdigest():
                raise ValueError(tr("文獻庫已變更，請重新開始同步。"))
            snap, _ = read(source, path, base)  # 读不了就在这里报错，不进后台
            self.cancel.clear()
            self.status = {"state": "running", "source": source, "link": link, "sync": sync, "from_backup": snap.from_backup, "done": 0, "total": len(snap.entries), "imported": 0, "existing": 0,
                           "skipped": [], "failed": [], "message": tr("正在迁移")}
        threading.Thread(target=self._run, args=(snap, with_tags, fetch, link, sync, lib, jobs, set(selected or [])), daemon=True).start()
        return self.status

    def stop(self) -> dict:
        self.cancel.set()
        return self.status

    def _set(self, **kw):
        with self.lock:
            self.status.update(kw)

    def _note(self, key: str, e: Entry, why: str):
        with self.lock:
            if len(self.status[key]) < 200:
                self.status[key].append({"title": _title(e), "why": why})

    def _run(self, snap: Snapshot, with_tags: bool, fetch: bool, link: bool = False, sync: bool = False, lib=None, jobs=None, selected=None):
        lib, jobs = lib or self.app.lib, jobs or self.app.jobs
        tag_root = tr("Zotero 标签")
        cats = [] if sync else [_clip(c) for c in snap.collections]
        try:
            seen = _history(lib) if sync else set()
            for n, e in enumerate(snap.entries, 1):
                if self.cancel.is_set():
                    break
                self._set(done=n - 1, message=_title(e)[:120])
                try:
                    if link:
                        if not e.pdf:
                            self._note("skipped", e, e.missing)
                            continue
                        ws, fresh = lib.import_pdf_path(e.pdf, e.meta, link=True)
                    else:
                        data, name, meta = self._pdf(e, fetch, lib)
                        if data is None:
                            self._note("skipped", e, e.missing)
                            continue
                        if sync:
                            digest = hashlib.sha256(data).hexdigest()
                            if _deleted(lib, digest, seen) and digest not in selected:
                                self._note("skipped", e, tr("先前已刪除，未選擇重新匯入"))
                                continue
                        ws, fresh = lib.create_from_pdf(data, name, meta)
                        if sync:
                            _remember(lib, digest)
                            seen.add(digest)
                except Exception as err:  # noqa: BLE001 —— 下载失败、文件读不了：记下来接着做下一条
                    self._note("failed", e, str(err)[:300])
                    continue
                if sync and not fresh:
                    self._set(existing=self.status["existing"] + 1)
                    continue
                want = [_clip(c) for c in e.cats] + ([cat_path(tag_root, t) for t in e.tags] if with_tags else [])
                cats += [c for c in want if c not in cats]

                def apply(item, want=want, fresh=fresh):
                    item["tags"] = list(dict.fromkeys((item.get("tags") or []) + want))
                    if fresh and e.added:
                        item["added"] = e.added
                    return item
                ws.update("item", apply)
                prepared = (ws.load("paper") or {}).get("meta", {}).get("pages")
                active = (ws.load("job") or {}).get("state") in ("queued", "running")
                if not prepared and not active:
                    jobs.enqueue(ws, translate_after=False)
                self._set(**{"imported" if fresh else "existing": self.status["imported" if fresh else "existing"] + 1})
            self._save_cats(cats)
            stopped = self.cancel.is_set()
            self._set(state="stopped" if stopped else "done", done=self.status["done"] if stopped else len(snap.entries),
                      message=tr("已停止") if stopped else tr("迁移完成"))
        except Exception as err:  # noqa: BLE001
            log.exception("成批导入出错")
            self._set(state="error", message=str(err)[:500])

    def _pdf(self, e: Entry, fetch: bool, lib) -> tuple[bytes | None, str, dict]:
        if e.pdf:
            return Path(e.pdf).read_bytes(), e.pdf.name, e.meta
        ref = e.meta.get("arxiv", "").removeprefix("arXiv:") or e.meta.get("doi", "")
        if not fetch or not ref:
            return None, "", {}
        data, name, got = lib.fetch(ref)
        return data, name, {**got, **e.meta}  # Zotero 里的元数据优先

    def _save_cats(self, cats: list[str]):
        """侧栏的分类顺序：原来的在前，新的按来源里的顺序接在后面（空分类也建出来）。"""
        lib = prefs.load().get("library") or {}
        old = lib.get("cats") or []
        prefs.save({"library": {"cats": old + [c for c in cats if c not in old]}})
