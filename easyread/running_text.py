"""页眉、页脚、出版商水印：在多页的页首页尾反复出现的行，送给模型前去掉。

不按出版商写规则（Cambridge、Elsevier、arXiv……各家格式不同，列不完），只看统计：
同一行（数字归一成 #、去掉程序标出的 Markdown 后）出现在足够多页的边缘，就当成版面杂讯。
奇偶页不同的页眉（左页作者名、右页期刊名）各占约一半页数，比例门槛要低于 1/2。
只动送给模型的文字，磁盘上的 extract/page-*.txt 不变（emphasis、xrefs、links 的偏移都基于原文）。
"""
from __future__ import annotations

import math
import re
import threading
from pathlib import Path

EDGE_LINES = 4          # 每页只看头尾各几行非空行
MIN_PAGES = 3           # 少于这么多页的论文不判断（样本太少）
REPEAT_RATIO = 0.3      # 出现在至少这个比例的页上才算重复（奇偶页页眉约 0.5）

_MD_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_DIGITS = re.compile(r"\d+")

_cache: dict[Path, tuple[tuple, frozenset[str]]] = {}
_lock = threading.Lock()


def normalize(line: str) -> str:
    """比较用的形式：去掉 Markdown 链接和粗斜体标记，数字归一（页码、日期、IP 每页不同）。"""
    plain = _MD_LINK.sub(r"\1", line).replace("*", "").strip()
    return _DIGITS.sub("#", plain).lower()


def _edges(lines: list[str]) -> list[str]:
    body = [ln for ln in lines if ln.strip()]
    k = min(EDGE_LINES, (len(body) - 1) // 2)
    return body[:k] + body[-k:] if k >= 1 else []


def _signature(files: list[Path]) -> tuple:
    return tuple((f.name, f.stat().st_mtime_ns, f.stat().st_size) for f in files)


def repeated_lines(extract_dir: Path) -> frozenset[str]:
    """在足够多页边缘重复出现的行（normalize 之后的形式）。按抽取文件的修改时间缓存。"""
    files = sorted(extract_dir.glob("page-*.txt")) if extract_dir.exists() else []
    if len(files) < MIN_PAGES:
        return frozenset()
    sig = _signature(files)
    with _lock:
        hit = _cache.get(extract_dir)
        if hit and hit[0] == sig:
            return hit[1]
    counts: dict[str, int] = {}
    for f in files:
        lines = f.read_text(encoding="utf-8", errors="replace").splitlines()
        for norm in {normalize(ln) for ln in _edges(lines)}:
            if norm.strip("# "):  # 只有数字的行另外处理（见 is_page_number）
                counts[norm] = counts.get(norm, 0) + 1
    need = max(MIN_PAGES, math.ceil(REPEAT_RATIO * len(files)))
    found = frozenset(k for k, v in counts.items() if v >= need)
    with _lock:
        _cache[extract_dir] = (sig, found)
    return found


def is_page_number(norm: str) -> bool:
    return norm.strip() in {"#", "- # -", "— # —", "page #", "p. #"}


def strip(text: str, extract_dir: Path) -> str:
    """去掉这页头尾连续出现的重复行和孤立页码；碰到第一行正文就停，且至少保留一行非空正文。"""
    if not text.strip():
        return text
    repeated = repeated_lines(extract_dir)
    lines = text.splitlines()
    body = [i for i, ln in enumerate(lines) if ln.strip()]

    def is_noise(idx: int) -> bool:
        norm = normalize(lines[idx])
        return norm in repeated or is_page_number(norm)

    drop: set[int] = set()
    for idx in body[:EDGE_LINES]:
        if len(drop) >= len(body) - 1 or not is_noise(idx):
            break
        drop.add(idx)
    for idx in reversed(body[-EDGE_LINES:]):
        if idx in drop or len(drop) >= len(body) - 1 or not is_noise(idx):
            break
        drop.add(idx)
    return "\n".join(ln for i, ln in enumerate(lines) if i not in drop)
