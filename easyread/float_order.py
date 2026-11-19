"""图和表按原页位置摆放：模型常把图表挪到“第一次提到它的段落”后面，甚至挪过一个小节，
和右边跟随的原页对不上。定位算出每块在原页的框以后，把图表插回原页上它所在的位置。

只动图表，正文之间的顺序照模型给的不变。没定位到的图表留在原处。
"""
from __future__ import annotations

FLOATS = ("table", "figure")
# 拿来比位置的块：按英文或图形边界在原页找到的。“between” 是按块顺序估出来的，不能反过来决定顺序
_ANCHORED = ("text", "head", "graphic", "caption", "manual")


def _overlap_x(a: list, x0: float, x1: float) -> bool:
    return max(a[0], x0) < min(a[2], x1) - 0.01


def _after(loc: dict, page: int, box: list) -> bool:
    """这块是否排在图表 (page, box) 后面：页更靠后，或同一页、同一栏、上沿不比图表高。"""
    if loc["page"] != page:
        return loc["page"] > page
    if loc.get("src") not in _ANCHORED:
        return False
    top = (loc.get("boxes") or [loc["box"]])[0]
    wide = box[2] - box[0] > 0.5  # 横跨两栏的图表：任何一栏里在它下面的块都算后面
    if not wide and top[2] - top[0] <= .5 and not _overlap_x(top, box[0], box[2]):
        # Finish the left column before entering the right, even if a right
        # column figure is higher on the page than a left column figure.
        return top[0] >= .45 and box[2] <= .55
    return top[1] >= box[1] - 0.005 and (wide or _overlap_x(top, box[0], box[2]))


def _before_unplaced(rest: list[dict], pos: int, loc: dict, layout: dict) -> int:
    """pos 前面紧挨着一串同页、还没定位的块（公式没有英文可匹配）时，看它们在图表上面还是下面：
    比较图表上方和下方各剩多少空当，下方空当大就把图表插到这串块前面。"""
    page, box = loc["page"], loc["box"]
    start = pos
    while start > 0 and rest[start - 1].get("id") not in layout and rest[start - 1].get("page") == page:
        start -= 1
    if start == pos:
        return pos
    prev = layout.get(rest[start - 1].get("id")) if start else None
    top = prev["box"][3] if prev and prev["page"] == page else 0.08
    nxt = layout.get(rest[pos].get("id")) if pos < len(rest) else None
    bottom = nxt["box"][1] if nxt and nxt["page"] == page else 0.92
    return start if bottom - box[3] > box[1] - top else pos


def order(blocks: list[dict], layout: dict) -> list[str] | None:
    """返回按原页位置排好的块 id 顺序；不用动时返回 None。"""
    moving = [b for b in blocks if b.get("type") in FLOATS and b.get("id") in layout]
    if not moving:
        return None
    moving_ids = {b["id"] for b in moving}
    rest = [b for b in blocks if b.get("id") not in moving_ids]
    for f in moving:
        loc = layout[f["id"]]
        f_page = f.get("page") or loc["page"]
        pos = len(rest)
        for i, b in enumerate(rest):
            b_page = b.get("page") or 0
            if b_page < f_page:
                continue
            other = layout.get(b.get("id"))
            if other is None or other.get("page") != b_page:
                if b_page > loc["page"]:  # 没定位或跨页定位失准的块只看页码
                    pos = i
                    break
                continue
            if _after(other, loc["page"], loc["box"]):
                pos = i
                break
        rest.insert(_before_unplaced(rest, pos, loc, layout), f)
    ids = [b.get("id") for b in rest]
    return None if ids == [b.get("id") for b in blocks] else ids


def apply(paper: dict, ids: list[str]) -> None:
    """按 ids 重排 paper 里的块。重读到的 paper 可能多了或少了块：只重排两边都有的，其余原样留着。"""
    blocks = paper.get("blocks", [])
    rank = {bid: i for i, bid in enumerate(ids)}
    known = sorted((b for b in blocks if b.get("id") in rank), key=lambda b: rank[b["id"]])
    it = iter(known)
    paper["blocks"] = [next(it) if b.get("id") in rank else b for b in blocks]
