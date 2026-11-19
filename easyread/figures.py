"""圖塊截圖。兩條路：

- 翻譯 / 只讀原文整理時，模型給了圖本身的裁剪框 box：等塊 id 在合併鎖裡最終去重之後，
  prepare_figures 先按 box 截一張（normalize_figure 只整理欄位，不截圖）。
- 定位（layout.json）之後 fill 按原頁定位補截或更新截圖：PDF 圖形邊界認出了這張圖就以它為準
  （模型的框只用來認圖，常常偏緊或偏鬆），認不出時 layout 裡就是模型的框。

截圖檔名帶上頁碼、框和 PDF 檔案身份的雜湊（figures/crop-<頁>-<雜湊>.webp）：
重譯改了框就換新檔，不會沿用舊圖或瀏覽器快取，同 id 的塊在別的頁上也不會撞到同一張。
換新檔後舊截圖如果沒有別處引用（含手動裁剪快照裡留檔的 src），fill 會順手清掉。
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import threading

from . import pdfwork
from .log import log
from .store import Workspace, dir_lock

_running: set[str] = set()

_CROP_NAME = re.compile(r"crop-\d+-[0-9a-f]{20}\.webp\Z")


def figure_box(value) -> list[float] | None:
    """歸一化 [x0, y0, x1, y1]；不是有限數、反了或太小都算無效。"""
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return None
    try:
        coords = [float(x) for x in value]
    except (TypeError, ValueError, OverflowError):
        return None
    if not all(math.isfinite(x) for x in coords):
        return None
    box = [round(max(0.0, min(1.0, x)), 4) for x in coords]
    if box[2] - box[0] < .02 or box[3] - box[1] < .02:
        return None
    return box


def _crop_path(root, page: int, box: list[float]) -> str:
    source = Workspace(root).source_pdf.stat()
    identity = json.dumps([page, box, source.st_size, source.st_mtime_ns])
    name = f"crop-{page}-{hashlib.sha256(identity.encode()).hexdigest()[:20]}"
    return f"figures/{name}.webp"


def crop(root, page: int, box: list[float]) -> str:
    """按頁碼、框和 PDF 身份命名截圖，已有同名檔就直接用。返回相對路徑。"""
    rel = _crop_path(root, page, box)
    if not (root / rel).is_file():
        pdfwork.crop(root, page, box, rel.rsplit("/", 1)[1][:-5])
    return rel


def normalize_figure(block: dict) -> None:
    """整理模型給的圖塊欄位：框無效就去掉，清除圖內文字欄位（圖內文字不翻譯）。不截圖。"""
    box = figure_box(block.get("box"))
    if box:
        block["box"] = box
    else:
        block.pop("box", None)
    for key in ("image_en", "image_zh", "image_text_en", "image_text_zh"):
        block.pop(key, None)


def prepare_figures(root, blocks: list[dict], total_pages: int) -> None:
    """在合併鎖裡、最後一次 id 去重之後呼叫：有 box 的圖塊重新截圖。
    截不了（頁碼不對、框無效、截圖失敗）就清掉 src 和 box，留給原頁入口和 fill_later。沒 box 的塊不動。
    abox 始終是當前 src 那張截圖實際用的框，閱讀頁按它佔原頁的比例給圖定寬。"""
    for block in blocks:
        if block.get("type") != "figure" or not block.get("box"):
            continue
        block["src"] = ""
        block.pop("abox", None)
        page, box = block.get("page"), figure_box(block["box"])
        if not box or not isinstance(page, int) or not 1 <= page <= total_pages:
            block.pop("box", None)
            continue
        try:
            block["src"] = crop(root, page, box)
            block["abox"] = box
        except Exception:  # noqa: BLE001
            block.pop("box", None)
            log.exception("截圖失敗 %s 第 %s 頁", block.get("id"), page)


def _pending(ws):
    """沒有截圖、自動裁剪範圍已變化或缺 abox 的圖塊；保留自訂 src。"""
    layout = ws.load("layout") or {}
    out = []
    for b in (ws.load("paper") or {}).get("blocks", []):
        src = b.get("src", "")
        if b.get("type") != "figure" or "manual_crop" in b or src and not src.startswith("figures/crop-"):
            continue
        loc = layout.get(b.get("id")) or {}
        box = figure_box(loc.get("crop") or loc.get("box"))
        page = loc.get("page")
        if not box or not isinstance(page, int) or page < 1:
            continue
        x0, y0, x1, y1 = box
        if x1 - x0 < 0.05 or y1 - y0 < 0.03:  # 只匹配到一行題注、沒撐開的框截出來沒用
            continue
        if src:
            try:
                if src == _crop_path(ws.root, page, box) and (ws.root / src).is_file():
                    if b.get("abox") == list(box):
                        continue  # 截圖和框都已是最新
                    out.append((b, page, box))  # 只缺 abox：crop 命中快取，零成本回填
                    continue
            except OSError:
                continue  # PDF 不在時保留已經存在的截圖。
        out.append((b, page, box))
    return out


def missing(ws) -> list[tuple[str, int, list[float]]]:
    """需要補截或更新自動截圖的圖塊：[(塊 id, 頁碼, 框)]。"""
    return [(b["id"], page, box) for b, page, box in _pending(ws)]


def fill(ws) -> int:
    """補截或更新自動截圖；寫回時保留截圖期間發生的編輯和重譯。"""
    done = {}
    for block, page, box in _pending(ws):
        try:
            done[block["id"]] = (block, page, box, crop(ws.root, page, box))
        except Exception:  # noqa: BLE001
            log.exception("截圖失敗 %s %s", ws.root, block["id"])
    if done:
        stale: set[str] = set()

        def apply(paper):
            count = 0
            for b in paper.get("blocks", []):
                done_item = done.get(b.get("id"))
                if done_item and b == done_item[0]:
                    _, page, box, src = done_item
                    if b.get("src") and b["src"] != src:
                        stale.add(b["src"])
                    b["src"] = src
                    b["abox"] = list(box)  # 截圖實際用的框（不含題注），前端按它佔原頁的比例定寬；box 仍是模型給的框
                    count += 1
            return count
        count = ws.update("paper", apply)
        _drop_orphans(ws, stale)
        return count
    return 0


def _figure_srcs(paper) -> set[str]:
    """paper.json 裡指向截圖的所有引用：塊 src，加上手動裁剪快照裡留檔的舊 src（reset 要恢復它）。"""
    out = set()
    for b in paper.get("blocks", []):
        if isinstance(b.get("src"), str):
            out.add(b["src"])
        snapshot = b.get("manual_crop")
        if isinstance(snapshot, dict):
            if isinstance(snapshot.get("src"), str):
                out.add(snapshot["src"])
    return out


def _drop_orphans(ws, stale: set[str]) -> None:
    """src 換新截圖後清掉不再被引用的舊自動截圖：定位修正、重譯換框都會留下孤兒檔案。
    引用以清理那一刻的 paper.json 為準，只刪自動裁剪命名的檔案；刪不掉就留著，無害。"""
    if not stale:
        return
    try:
        with dir_lock(ws.root):
            referenced = _figure_srcs(ws.load("paper"))
            directory = ws.root.resolve() / "figures"
            if directory.resolve() != directory:
                return  # Do not follow a relocated figures directory/junction.
            for src in stale:
                if not isinstance(src, str) or src in referenced:
                    continue
                name = src.removeprefix("figures/")
                if src != "figures/" + name or not _CROP_NAME.fullmatch(name):
                    continue
                target = directory / name
                if target.is_symlink() or target.resolve().parent != directory:
                    continue
                try:
                    target.unlink(missing_ok=True)
                except OSError:
                    log.exception("Unable to remove replaced crop %s", src)
    except Exception:  # Cleanup is optional; keep files if state/locking fails.
        log.exception("Unable to check replaced crops in %s", ws.root)


def fill_later(ws, gate=None) -> None:
    """打開閱讀頁時在背景補；補完 paper.json 變了，頁面輪詢到就會重畫。"""
    key = str(ws.root)
    if key in _running or not missing(ws):
        return
    if gate:
        gate.begin()
    _running.add(key)

    def run():
        try:
            fill(ws)
        finally:
            _running.discard(key)
            if gate:
                gate.end()
    threading.Thread(target=run, daemon=True).start()
