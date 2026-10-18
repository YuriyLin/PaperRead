"""检查 paper.json / discussion.json：块 id、引用号、锚点、被 JSON 吃掉的反斜杠、全部 TeX 能否渲染。"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

from .config import WEB
from .paperdata import BLOCK_TYPES, block_shape_problem
from .store import Workspace
from .tables import MATRICES, FOOTNOTES

_CITE = re.compile(r"\[(\d+(?:\s*[,–-]\s*\d+)*)\]")
_INLINE_MATH = re.compile(r"(?<!\\)\$((?:\\\$|[^$])+?)(?<!\\)\$")
_CTRL = re.compile("[" + chr(0) + "-" + chr(8) + chr(11) + chr(12) + chr(14) + "-" + chr(31) + "]")
CHECK_TEX = Path(__file__).with_name("check_tex.js")
KATEX = WEB / "vendor" / "katex" / "katex.min.js"


def texts(block: dict):
    for key in ("zh", "en", "caption_zh", "caption_en", "image_zh", "image_en"):
        if block.get(key):
            yield block[key]
    items = block.get("items", [])
    if isinstance(items, list):
        for it in items:
            if isinstance(it, dict):
                yield it.get("zh", "")
                yield it.get("en", "")
            else:
                yield str(it)
    for field in ("head", "rows") + MATRICES:
        matrix = block.get(field, [])
        if not isinstance(matrix, list):
            continue
        for row in matrix:
            cells = row if isinstance(row, list) else [row]
            for cell in cells:
                yield str(cell)
    for field in FOOTNOTES:
        notes = block.get(field, [])
        if isinstance(notes, list):
            yield from (str(note) for note in notes)


def block_problems(blocks: list[dict], refs: set[str] | None = None) -> tuple[list[str], list]:
    problems, tex = [], []
    ids = set()
    for b in blocks:
        if not isinstance(b, dict):
            problems.append(f"块必须是对象：{str(b)[:80]}")  # i18n-ok
            continue
        bid = b.get("id")
        if not bid:
            problems.append(f"缺 id：{str(b)[:80]}")  # i18n-ok 交给模型修正的问题清单
        elif bid in ids:
            problems.append(f"id 重复：{bid}")  # i18n-ok
        ids.add(bid)
        if b.get("type") not in BLOCK_TYPES:
            problems.append(f"{bid}：未知类型 {b.get('type')}")  # i18n-ok
        shape_problem = block_shape_problem(b)
        if shape_problem:
            problems.append(shape_problem)
        if b.get("type") == "math":
            tex.append((bid, b.get("tex", ""), True))
        for t in list(texts(b)) + [b.get("tex", "")]:
            if _CTRL.search(t or ""):
                problems.append(f"{bid}：含控制字符，多半是 JSON 里 TeX 命令（frac、text、bar、nu 这类）前的反斜杠只写了一个")  # i18n-ok
        for t in texts(b):
            if (t.count("$") - t.count("\\$")) % 2:
                problems.append(f"{bid}：$ 不成对")  # i18n-ok
            tex += [(bid, m.group(1), False) for m in _INLINE_MATH.finditer(t)]
            if refs:
                for m in _CITE.finditer(_INLINE_MATH.sub("", t)):
                    for n in re.split(r"\s*[,–-]\s*", m.group(1)):
                        if n not in refs:
                            problems.append(f"{bid}：引用 [{n}] 不在参考文献里")  # i18n-ok
    return problems, tex


def tex_problems(items: list) -> list[str]:
    node = shutil.which("node")
    if not node or not items:
        return []
    proc = subprocess.run([node, str(CHECK_TEX), str(KATEX)], input=json.dumps(items, ensure_ascii=False),
                          capture_output=True, text=True, encoding="utf-8")
    if proc.returncode not in (0, 1):
        return [f"TeX 检查没跑起来：{proc.stderr.strip()[:300]}"]  # i18n-ok
    return [line for line in proc.stdout.splitlines() if line.strip()]


def check(ws: Workspace) -> dict:
    paper, disc = ws.load("paper"), ws.load("discussion")
    refs = {str(r.get("id")) for r in paper.get("references", [])}
    problems, tex = block_problems(paper.get("blocks", []), refs)
    ids = {b.get("id") for b in paper.get("blocks", [])}
    for e in disc.get("entries", []):
        if e.get("anchor") and e["anchor"] not in ids:
            problems.append(f"讨论 {e['id']} 的锚点不存在：{e['anchor']}")  # i18n-ok
        for t in (e.get("body", ""), e.get("q", "")):
            tex += [(e["id"], m.group(1), False) for m in _INLINE_MATH.finditer(t)]
    problems += tex_problems(tex)
    pages = {p["n"] for p in paper.get("meta", {}).get("pages", [])}
    done = set(paper.get("translation", {}).get("done_pages", []))
    return {"blocks": len(ids), "tex": len(tex), "missing_pages": sorted(pages - done), "problems": problems}
