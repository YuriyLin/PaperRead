"""User-selected figure crops, separate from automatic PDF geometry."""
from .figures import crop, figure_box


def save(ws, body):
    block_id = str(body.get("id", ""))
    reset = body.get("reset") is True
    page = body.get("page")
    box = figure_box(body.get("box"))
    if not reset and (type(page) is not int or not box):
        raise ValueError("Invalid page or crop rectangle")

    def apply(paper):
        block = next((b for b in paper.get("blocks", []) if b.get("id") == block_id and b.get("type") == "figure"), None)
        if not block:
            raise ValueError("Figure no longer exists; reload the paper")
        if reset:
            previous = block.pop("manual_crop", None)
            if previous:
                for key in ("src", "abox", "box", "page"):
                    if key in previous:
                        block[key] = previous[key]
                    else:
                        block.pop(key, None)
            return dict(block)
        if not any(p.get("n") == page for p in paper.get("meta", {}).get("pages", [])):
            raise ValueError("Page does not exist")
        src = crop(ws.root, page, box)
        block.setdefault("manual_crop", {k: block[k] for k in ("src", "abox", "box", "page") if k in block})
        block.update(src=src, abox=box, box=box, page=page)
        return dict(block)

    return {"block": ws.update("paper", apply)}
