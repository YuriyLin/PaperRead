"""文件读写：原子写、跨进程锁、用户修改的合并规则。

一篇论文一个目录，文件按“谁写”分开，这是互不覆盖的根本保证：
  paper.json       翻译方（对话里的 agent 或后台翻译任务）写：原文、译文、术语、参考文献
  discussion.json  翻译方写：解释、问答、回复、原文核对提示
  reader.json      只由页面经 /api/.../ops 写：用户改的译文、笔记、划线、论文笔记、进度
  item.json        只由页面经 /api/items 写：标签、阅读状态、星标、打开时间
"""
from __future__ import annotations

import base64
import binascii
import io
import json
import math
import os
import re
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit
from xml.etree import ElementTree

from PIL import Image

SCHEMA = 2


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="milliseconds")


class DataReadError(ValueError):
    """A saved JSON file is unreadable; callers must not overwrite it with defaults."""

    def __init__(self, path: Path):
        self.path = Path(path)
        super().__init__(f"Cannot read data file: {self.path}; the original file has been preserved")


def read_json(path: Path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def write_json_atomic(path: Path, data) -> None:
    path = Path(path)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{time.monotonic_ns()}.tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    for attempt in range(20):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:  # Windows：别的进程正在读，稍等重试
            time.sleep(0.05 * (attempt + 1))
    os.replace(tmp, path)


@contextmanager
def dir_lock(folder: Path, name: str = ".write.lock", timeout: float = 15.0):
    """O_EXCL 建锁文件做跨进程互斥；超过 30 秒的旧锁视为残留。"""
    lock = Path(folder) / name
    start = time.time()
    while True:
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, str(os.getpid()).encode())
            os.close(fd)
            break
        except FileExistsError:
            try:
                if time.time() - lock.stat().st_mtime > 30:
                    lock.unlink(missing_ok=True)
                    continue
            except FileNotFoundError:
                continue
            if time.time() - start > timeout:
                from .i18n import tr
                raise TimeoutError(tr("等锁超时：{lock}", lock=lock))
            time.sleep(0.05)
    try:
        yield
    finally:
        lock.unlink(missing_ok=True)


def text_hash(s: str | None) -> str:
    """和页面 util.js 的 hashText 一致：FNV-1a 32 位，按 UTF-16 码元。"""
    h = 0x811C9DC5
    b = (s or "").encode("utf-16-le")
    for i in range(0, len(b), 2):
        h ^= b[i] | (b[i + 1] << 8)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return format(h, "08x")


def file_version(path: Path) -> str:
    try:
        st = Path(path).stat()
        return f"{st.st_mtime_ns:x}-{st.st_size:x}"
    except FileNotFoundError:
        return "0"


def empty_reader() -> dict:
    return {"schema": SCHEMA, "rev": 0, "edits": {}, "notes": {}, "ai_annotations": {}, "ink": {}, "stickers": {}, "paper_note": {}, "progress": {}}


def empty_discussion() -> dict:
    return {"schema": SCHEMA, "entries": []}


# ---------- reader.json 的操作合并 ----------
# 每个操作幂等、带时间戳；同一对象以较新的为准。页面断网时操作留在浏览器，恢复后重发不会重复或倒退。

def _newer(a: str | None, b: str | None) -> bool:
    return (a or "") >= (b or "")


def _valid_sticker_link(value: str) -> bool:
    if not isinstance(value, str) or len(value) > 2048 or any(ord(c) < 33 or ord(c) == 127 for c in value):
        return False
    try:
        parsed = urlsplit(value)
        return parsed.scheme in ("http", "https") and bool(parsed.hostname) and parsed.username is None and parsed.password is None and (parsed.port is None or 0 < parsed.port < 65536)
    except ValueError:
        return False


def _valid_sticker_data(value: str) -> bool:
    if not isinstance(value, str) or len(value) > 540000:
        return False
    match = re.fullmatch(r"data:(image/(?:png|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)", value)
    if not match:
        return False
    try:
        raw = base64.b64decode(match.group(2), validate=True)
        if not raw or len(raw) > 400000:
            return False
        if match.group(1) != "image/svg+xml":
            with Image.open(io.BytesIO(raw)) as image:
                if image.format != {"image/png": "PNG", "image/webp": "WEBP"}[match.group(1)] or image.width * image.height > 16000000:
                    return False
                image.verify()
            return True
        text = raw.decode("utf-8")
        if re.search(r"<!doctype|<!entity|<\?xml-stylesheet|@import|url\s*\(", text, re.I):
            return False
        root = ElementTree.fromstring(text)
        allowed = {"svg", "g", "defs", "style", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "title", "desc"}
        if root.tag.split("}")[-1] != "svg":
            return False
        for element in root.iter():
            tag = element.tag.split("}")[-1]
            if tag not in allowed:
                return False
            if tag == "style" and not re.fullmatch(r"(?:\s*\.[a-zA-Z0-9_-]+\s*\{\s*fill\s*:\s*#[0-9a-fA-F]{3,8}\s*;?\s*\}\s*)*", element.text or ""):
                return False
            if any(k.lower().startswith("on") or k.lower().endswith("href") or re.search(r"url\s*\(|javascript:|data:", v, re.I) for k, v in element.attrib.items()):
                return False
        return True
    except (ValueError, TypeError, UnicodeError, ElementTree.ParseError, binascii.Error, OSError, Image.DecompressionBombError):
        return False


def apply_ops(reader: dict, ops: list[dict]) -> list[str]:
    applied = []
    edits = reader.setdefault("edits", {})
    notes = reader.setdefault("notes", {})
    ai_annotations = reader.setdefault("ai_annotations", {})
    ink = reader.setdefault("ink", {})
    stickers = reader.setdefault("stickers", {})
    progress = reader.setdefault("progress", {})
    for op in ops:
        kind = op.get("op")
        at = op.get("at") or now_iso()
        if kind == "edit":
            block = str(op["block"])
            cur = edits.get(block)
            if cur and not _newer(at, cur.get("at")):
                continue
            if op.get("zh") is None:  # 恢复译者稿：留一条撤销记录
                if cur:
                    edits[block] = {"reverted": True, "prev": cur.get("zh"), "at": at}
            else:
                entry = {"zh": op["zh"], "base": op.get("base", ""), "at": at}
                if cur and cur.get("zh") and cur.get("zh") != op["zh"]:
                    entry["prev"] = cur.get("zh")
                edits[block] = entry
            applied.append(f"edit:{block}")
        elif kind == "note":
            note = dict(op["note"])
            nid = str(note["id"])
            cur = notes.get(nid)
            if cur and not _newer(note.get("updated"), cur.get("updated")):
                continue
            notes[nid] = note
            applied.append(f"note:{nid}")
        elif kind == "note_del":
            nid = str(op["id"])
            cur = notes.get(nid)
            if not cur or _newer(at, cur.get("updated")):
                notes[nid] = {**(cur or {"id": nid}), "deleted": True, "updated": at}
                applied.append(f"note_del:{nid}")
        elif kind == "ai_annotation":
            annotation = dict(op.get("annotation") or {})
            aid = str(annotation.get("annotation_id") or annotation.get("id") or "")
            if not aid:
                continue
            cur = ai_annotations.get(aid)
            if cur and not _newer(annotation.get("updated_at") or at, cur.get("updated_at")):
                continue
            annotation["annotation_id"] = aid
            annotation.setdefault("created_at", at)
            annotation["updated_at"] = annotation.get("updated_at") or at
            ai_annotations[aid] = annotation
            applied.append(f"ai_annotation:{aid}")
        elif kind in ("ink", "ink_del"):
            stroke = dict(op.get("stroke") or {}) if kind == "ink" else {"id": str(op.get("id") or "")}
            sid = str(stroke.get("id") or "")
            if not sid or len(sid) > 80:
                continue
            cur = ink.get(sid) or {}
            if _newer(at, cur.get("updated")):
                if kind == "ink":
                    points = stroke.get("points")
                    if (not isinstance(points, list) or not 1 <= len(points) <= 2000 or
                            any(not isinstance(p, list) or len(p) != 2 or
                                any(not isinstance(v, (int, float)) or isinstance(v, bool) or abs(v) > 5000 or not math.isfinite(v) for v in p)
                                for p in points)):
                        raise ValueError("Invalid ink stroke points")
                    if (not isinstance(stroke.get("anchor"), str) or len(stroke["anchor"]) > 200 or
                            not isinstance(stroke.get("group"), str) or len(stroke["group"]) > 80 or
                            ("groupId" in stroke and (not isinstance(stroke["groupId"], str) or not re.fullmatch(r"[a-z0-9-]{1,80}", stroke["groupId"]))) or
                            not isinstance(stroke.get("textHash"), str) or len(stroke["textHash"]) != 8 or
                            any(c not in "0123456789abcdef" for c in stroke["textHash"].lower()) or
                            not isinstance(stroke.get("color"), str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", stroke["color"]) or
                            not isinstance(stroke.get("width"), (int, float)) or isinstance(stroke.get("width"), bool) or
                            not 1 <= stroke["width"] <= 12 or not math.isfinite(stroke["width"]) or
                            not isinstance(stroke.get("ref"), list) or len(stroke["ref"]) != 2 or
                            any(not isinstance(v, (int, float)) or isinstance(v, bool) or not 1 <= v <= 5000 or not math.isfinite(v) for v in stroke["ref"])):
                        raise ValueError("Invalid ink stroke")
                    ink[sid] = {**stroke, "updated": at}
                else:
                    ink[sid] = {**cur, "id": sid, "deleted": True, "updated": at}
                applied.append(f"ink:{sid}")
        elif kind in ("sticker", "sticker_del"):
            sticker = dict(op.get("sticker") or {}) if kind == "sticker" else {"id": str(op.get("id") or "")}
            sid = str(sticker.get("id") or "")
            if not sid or len(sid) > 80:
                continue
            cur = stickers.get(sid) or {}
            if not _newer(at, cur.get("updated")):
                continue
            if kind == "sticker":
                numeric = ("x", "y", "width", "height", "rotation", "opacity", "z")
                if (not isinstance(sticker.get("assetId"), str) or not re.fullmatch(r"[a-z0-9-]{1,100}", sticker["assetId"]) or
                        not isinstance(sticker.get("anchor"), str) or not 1 <= len(sticker["anchor"]) <= 200 or
                        not isinstance(sticker.get("textHash"), str) or not re.fullmatch(r"[0-9a-f]{8}", sticker["textHash"]) or
                        not isinstance(sticker.get("ref"), list) or len(sticker["ref"]) != 2 or
                        any(not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v) or not 1 <= v <= 5000 for v in sticker["ref"]) or
                        any(not isinstance(sticker.get(k), (int, float)) or isinstance(sticker.get(k), bool) or not math.isfinite(sticker[k]) for k in numeric) or
                        not all(abs(sticker[k]) <= 5000 for k in ("x", "y")) or
                        not all(1 <= sticker[k] <= 5000 for k in ("width", "height")) or
                        abs(sticker["rotation"]) > 36000 or not 0 <= sticker["opacity"] <= 1 or
                        abs(sticker["z"]) > 1000000 or not isinstance(sticker.get("locked"), bool) or
                        ("strokeColor" in sticker and (not isinstance(sticker["strokeColor"], str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", sticker["strokeColor"]))) or
                        ("strokeWidth" in sticker and (not isinstance(sticker["strokeWidth"], (int, float)) or isinstance(sticker["strokeWidth"], bool) or not math.isfinite(sticker["strokeWidth"]) or not 1 <= sticker["strokeWidth"] <= 4)) or
                        ("href" in sticker and not _valid_sticker_link(sticker["href"])) or
                        ("textColor" in sticker and (not isinstance(sticker["textColor"], str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", sticker["textColor"]))) or
                        ("textSize" in sticker and (not isinstance(sticker["textSize"], (int, float)) or isinstance(sticker["textSize"], bool) or not math.isfinite(sticker["textSize"]) or not 10 <= sticker["textSize"] <= 72)) or
                        ("textBold" in sticker and not isinstance(sticker["textBold"], bool)) or
                        ("groupId" in sticker and (not isinstance(sticker["groupId"], str) or not re.fullmatch(r"[a-z0-9-]{1,80}", sticker["groupId"]))) or
                        (sticker["assetId"] == "paperread-text-box" and (not isinstance(sticker.get("text"), str) or len(sticker["text"]) > 2000)) or
                        ("customData" in sticker and not _valid_sticker_data(sticker["customData"])) or
                        (sticker["assetId"].startswith("custom-") and "customData" not in sticker)):
                    raise ValueError("Invalid sticker")
                stickers[sid] = {**sticker, "updated": at}
            else:
                stickers[sid] = {**cur, "id": sid, "deleted": True, "updated": at}
            applied.append(f"sticker:{sid}")
        elif kind == "paper_note":
            cur = reader.get("paper_note") or {}
            if _newer(at, cur.get("at")):
                reader["paper_note"] = {"body": op.get("body", ""), "at": at}
                applied.append("paper_note")
        elif kind == "progress":
            if _newer(at, progress.get("at")):
                progress.update({"block": op.get("block"), "at": at})
                progress.pop("off", None)  # Older clients do not send a block offset.
                for key in ("ratio", "off"):  # off：线在块里的位置，长段落靠它落回原处
                    if op.get(key) is not None:
                        progress[key] = op[key]
            applied.append("progress")
    if applied:
        reader["rev"] = int(reader.get("rev", 0)) + 1
    return applied


class Workspace:
    """一篇论文的目录。"""

    PARTS = ("paper", "discussion", "reader", "layout", "item")

    def __init__(self, root: Path):
        self.root = Path(root).resolve()

    @property
    def id(self) -> str:
        return self.root.name

    paper_path = property(lambda s: s.root / "paper.json")
    discussion_path = property(lambda s: s.root / "discussion.json")
    reader_path = property(lambda s: s.root / "reader.json")
    item_path = property(lambda s: s.root / "item.json")
    journal_path = property(lambda s: s.root / "history" / "reader.log.jsonl")

    @property
    def source_pdf(self) -> Path:
        """Original PDF only: generated files remain inside this workspace."""
        meta = (self.load("paper") or {}).get("meta", {})
        linked = meta.get("source_pdf_path")
        if not linked:
            return self.root / "source.pdf"
        path = Path(linked)
        if not path.is_absolute() or not path.is_file():
            from .i18n import tr
            raise ValueError(tr("链接的 PDF 不存在或不可读：{path}；请恢复原文件到此位置", path=str(path)))
        try:
            with path.open("rb") as stream:
                if not stream.read(4).startswith(b"%PDF"):
                    raise ValueError
        except (OSError, ValueError):
            from .i18n import tr
            raise ValueError(tr("链接的 PDF 不存在或不可读：{path}；请恢复原文件到此位置", path=str(path))) from None
        return path

    def load(self, name: str):
        defaults = {"reader": empty_reader(), "discussion": empty_discussion(), "layout": {}, "item": {}, "job": {}, "chat": {"messages": []}}
        path = self.root / f"{name}.json"
        try:
            return read_json(path, defaults.get(name))
        except (UnicodeError, json.JSONDecodeError) as e:
            raise DataReadError(path) from e

    def versions(self) -> dict:
        v = {n: file_version(self.root / f"{n}.json") for n in self.PARTS}
        v["job"] = file_version(self.root / "job.json")
        return v

    def apply_reader_ops(self, ops: list[dict], client: str = "") -> dict:
        with dir_lock(self.root):
            reader = self.load("reader")
            applied = apply_ops(reader, ops)
            if applied:
                self._journal(ops, client)
                self._snapshot()
                write_json_atomic(self.reader_path, reader)
            return {"rev": reader.get("rev", 0), "applied": applied}

    def _journal(self, ops, client):
        self.journal_path.parent.mkdir(exist_ok=True)
        with open(self.journal_path, "a", encoding="utf-8") as f:
            for op in ops:
                f.write(json.dumps({"t": now_iso(), "client": client, **op}, ensure_ascii=False) + "\n")

    def _snapshot(self, every_seconds: int = 600):
        """reader.json 每 10 分钟最多留一份快照，出事可以回滚。"""
        hist = self.root / "history"
        hist.mkdir(exist_ok=True)
        snaps = sorted(hist.glob("reader-*.json"))
        if snaps and time.time() - snaps[-1].stat().st_mtime < every_seconds:
            return
        if self.reader_path.exists():
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            (hist / f"reader-{stamp}.json").write_bytes(self.reader_path.read_bytes())

    def update(self, name: str, fn):
        """在锁内读-改-写一个翻译方的文件（paper / discussion / job / item）。"""
        with dir_lock(self.root):
            data = self.load(name)
            result = fn(data)
            write_json_atomic(self.root / f"{name}.json", data)
            return result

    def patch_item(self, fields: dict) -> dict:
        allowed = {"tags", "status", "starred", "rating", "last_opened", "meta_override", "archived",
                   "reading_plan", "interested", "manual_order", "paper_ref"}

        def apply(item):
            for k, v in fields.items():
                if k in allowed:
                    item[k] = v
            item["updated"] = now_iso()
            return item
        return self.update("item", apply)
