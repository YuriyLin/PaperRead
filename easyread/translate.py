"""后台翻译：一批几页交给模型，校验后并进 paper.json。每批落盘，中断了下次接着译。

一批失败会重试；还是失败就记下来跳过，接着译后面的页，最后在页面上给“重试失败的页”。
"""
from __future__ import annotations

import json
import re
import threading
from concurrent.futures import ThreadPoolExecutor

from . import batch_repair, blank_pages, codeblocks, consistency, engines, figures, footnotes, front_context, langs, netcheck, numbered_listings, page_check, pdfwork, prompts, prompts_en, segments, sentences, sources, terms, timing, xrefs
from .checks import block_problems, tex_problems
from .repair_guard import retains_content
from .figures import normalize_figure, prepare_figures
from .i18n import lang, tr
from .log import log
from .paperdata import BLOCK_TYPES, add_discussion, fill_zh, merge_blocks, restore_page, set_block_text, snapshot_page
from .store import Workspace, now_iso

_merge_lock = threading.Lock()  # 并发翻译时，并入 paper.json 和重算原页定位一次只做一个
# 用量到顶、余额不足这类错误，后面的批次也一定失败：直接停，剩下的页记为没译，等额度恢复后一键重试
_QUOTA = re.compile(r"session limit|usage limit|rate limit reached|insufficient_quota|余额不足|额度|接口返回 40[12]|insufficient balance|API returned 40[12]", re.I)  # i18n-ok
_REF_LINE = re.compile(r"^\s*(\d+\.?\s*)?(references|bibliography|参考文献)\s*$", re.I | re.M)  # i18n-ok


def prepare(ws: Workspace) -> None:
    pages = pdfwork.prepare(ws.root)
    extra = {}
    try:  # 本地拖进来的 PDF：从第一页的 arXiv 编号或 DOI 补上作者、年份、出处
        first = ws.root / "extract" / "page-001.txt"
        if first.exists():
            extra = sources.enrich(first.read_text(encoding="utf-8", errors="replace"), ws.load("paper").get("meta", {}))
    except Exception:  # noqa: BLE001
        log.exception("补元数据失败 %s", ws.id)

    def apply(paper):
        meta = paper.setdefault("meta", {})
        meta.update({"pages": pages, "page_count": len(pages)})
        for k, v in extra.items():
            if not meta.get(k) or (k == "title_en" and meta.get(k) == meta.get("source", "").removesuffix(".pdf")):
                meta[k] = v
    ws.update("paper", apply)


def references_page(ws: Workspace) -> int | None:
    """参考文献从哪一页开始（找单独成行的 References 标题）。找不到返回 None。"""
    n = ws.load("paper").get("meta", {}).get("page_count") or 0
    for p in range(2, n + 1):
        f = ws.root / "extract" / f"page-{p:03d}.txt"
        if f.exists() and _REF_LINE.search(f.read_text(encoding="utf-8", errors="replace")):
            return p
    return None


def scope_pages(ws: Workspace, scope: str | None) -> list[int] | None:
    """翻译范围：all 全文；body 到参考文献那页为止；range:A-B 第 A 到 B 页；first:N 前 N 页（旧写法）。返回 None 表示全文。"""
    n = ws.load("paper").get("meta", {}).get("page_count") or 0
    if scope == "body":
        ref = references_page(ws)
        return list(range(1, ref + 1)) if ref else None
    if scope and scope.startswith("range:"):
        a, _, b = scope.split(":", 1)[1].partition("-")
        start, end = sorted((int(a or 1), int(b or n)))
        lo, hi = max(1, start), min(n, end)
        if lo > hi:
            raise ValueError(tr("指定页码超出了论文范围（共 {n} 页）", n=n))
        return list(range(lo, hi + 1))
    if scope and scope.startswith("first:"):
        k = int(scope.split(":", 1)[1] or 0)
        return list(range(1, min(n, k) + 1)) if k > 0 else None
    return None


def _next_head(ws: Workspace, n: int, whole: bool = False) -> str:
    """下一页开头的抽取文字（粗体斜体、内部链接、脚注标记和正文一样标出）。whole：整页都给（不能看图的引擎在分段交界处，续文可能排在表格、图注后面）。"""
    if not (ws.root / "extract" / f"page-{n:03d}.txt").exists():
        return ""
    text = prompts.page_text(ws, n)
    if whole:
        return text
    head = text[:1500]
    cut = re.search(r"\[[^\[\]\n]*(?:\]\([^)\n]*)?$", head)  # don't hand the model half a link
    return head[:cut.start()] if cut else head


_FLOAT_CAPTION_RE = re.compile(
    r"^\s*(Table|Fig\.?|Figure)\s+([A-Za-z0-9]+(?:\.[A-Za-z0-9]+)?)\s*[.:：]\s*(.+)",
    re.I | re.M,
)
_FLOAT_EN_PREFIX_RE = re.compile(r"^(\s*(?:Table|Fig\.?|Figure)\s+)([A-Za-z0-9]+(?:\.[A-Za-z0-9]+)?)", re.I)
_FLOAT_ZH_PREFIX_RE = re.compile(r"^(\s*(?:表|圖|图)\s*)([A-Za-z0-9]+(?:\.[A-Za-z0-9]+)?)(?=\s*[.:：]|$|\s)")


def _norm_caption_letters(text: str) -> str:
    return re.sub(r"[^a-z]", "", text.lower())


def _printed_captions(extract_dir, pages: set[int]) -> dict[tuple[int, str], list[tuple[str, str]]]:
    out: dict[tuple[int, str], list[tuple[str, str]]] = {}
    for p in pages:
        f = extract_dir / f"page-{p:03d}.txt"
        if not f.exists():
            continue
        raw = f.read_text(encoding="utf-8", errors="replace")
        for m in _FLOAT_CAPTION_RE.finditer(raw):
            kind = "table" if m.group(1).lower().startswith("table") else "figure"
            out.setdefault((p, kind), []).append((m.group(2), _norm_caption_letters(m.group(3))))
    return out


def _reconcile_float_numbers(blocks: list[dict], extract_dir) -> None:
    """当模型把原页里的 Table 2 误写成 Table 3 时，对照抽取文字中的题注编号自动纠正 num 与中英文题注编号。"""
    pages = {b.get("page") for b in blocks if b.get("type") in ("table", "figure") and b.get("page")}
    if not pages:
        return
    printed = _printed_captions(extract_dir, pages)
    for b in blocks:
        kind = b.get("type")
        page = b.get("page")
        if kind not in ("table", "figure") or not page:
            continue
        cands = printed.get((page, kind))
        if not cands:
            continue
        cur_num = str(b.get("num") or "").strip()
        if cur_num and cur_num in {num for num, _ in cands}:
            continue
        cap_en = str(b.get("caption_en") or "")
        body = re.sub(r"^\s*(?:Table|Fig\.?|Figure)\s+[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)?\s*[.:：]?\s*", "", cap_en, flags=re.I)
        norm_body = _norm_caption_letters(body)
        matched = next(
            (num for num, p_title in cands
             if norm_body and p_title and (norm_body == p_title or (min(len(norm_body), len(p_title)) >= 8 and (norm_body in p_title or p_title in norm_body)))),
            None,
        )
        if not matched and len(cands) == 1 and sum(1 for x in blocks if x.get("page") == page and x.get("type") == kind) == 1:
            matched = cands[0][0]
        if not matched or matched == cur_num:
            continue
        b["num"] = matched
        if b.get("caption_en"):
            if cur_num:
                b["caption_en"] = re.sub(r"^(\s*(?:Table|Fig\.?|Figure)\s+)" + re.escape(cur_num) + r"\b", rf"\g<1>{matched}", b["caption_en"], count=1, flags=re.I)
            else:
                b["caption_en"] = _FLOAT_EN_PREFIX_RE.sub(rf"\g<1>{matched}", b["caption_en"], count=1)
        if b.get("caption_zh"):
            if cur_num:
                b["caption_zh"] = re.sub(r"^(\s*(?:表|圖|图)\s*)" + re.escape(cur_num) + r"(?=\s*[.:：]|$|\s)", rf"\g<1>{matched}", b["caption_zh"], count=1)
            else:
                b["caption_zh"] = _FLOAT_ZH_PREFIX_RE.sub(rf"\g<1>{matched}", b["caption_zh"], count=1)


def _normalize(data: dict, pages: list[int], taken: set[str], extract_dir=None) -> dict:
    """补页码、去掉和已有块撞车的 id、丢掉明显无效的块。"""
    if isinstance(data, list):
        data = {"blocks": data}
    blocks = []
    for b in data.get("blocks") or []:
        if not isinstance(b, dict) or not b.get("type"):
            continue
        btype = b.get("type")
        if btype in ("footnote", "note"):
            b = {**b, "type": "para", "role": b.get("role") or "footnote"}
        elif btype not in BLOCK_TYPES:
            if b.get("en") or b.get("zh"):
                b = {**b, "type": "para"}
            else:
                continue
        codeblocks.normalize(b)
        b.setdefault("page", pages[0])
        try:
            b["page"] = int(b["page"])
        except (TypeError, ValueError):
            b["page"] = pages[0]
        bid = re.sub(r"[^A-Za-z0-9_\-]", "-", str(b.get("id") or f"p{b['page']}-{len(blocks) + 1}"))
        base, k = bid, 2
        while bid in taken:
            bid = f"{base}-{k}"
            k += 1
        taken.add(bid)
        b["id"] = bid
        if b["type"] == "figure":
            normalize_figure(b)  # 截圖要等合併鎖裡 id 最終去重之後，見 prepare_figures
        blocks.append(b)
    if extract_dir:
        codeblocks.restore_sql_lines(blocks, extract_dir)
        _reconcile_float_numbers(blocks, extract_dir)
    data["blocks"] = blocks
    # 标题、作者和参考文献条目不按 Markdown 显示：模型照抄过去的内部链接、脚注标记去掉
    for k, v in (data.get("meta") or {}).items():
        data["meta"][k] = xrefs.plain(v)
    for r in data.get("references") or []:
        if isinstance(r, dict):
            r["text"] = xrefs.plain(r.get("text"))
            r.setdefault("page", pages[0])
    return data


def _taken(ws: Workspace, batch: list[int]) -> set[str]:
    return {b["id"] for b in ws.load("paper").get("blocks", []) if b.get("page") not in batch}


def _problems(data: dict) -> list[str]:
    problems, tex = block_problems(data["blocks"])
    return problems + tex_problems(tex)


def journal(ws: Workspace, line: str) -> None:
    """每篇论文自己的翻译记录 job.log，页面上“查看记录”看的就是它。"""
    with open(ws.root / "job.log", "a", encoding="utf-8") as f:
        f.write(f"{now_iso()[:19].replace('T', ' ')}  {line}\n")


def _fill_problems(zh: dict) -> list[str]:
    # Fill responses use keys instead of blocks; table heads still need math checks.
    blocks = [{"id": k, "type": "table", "head": v} if k.endswith("#head") else
              {"id": k, "type": "para", "zh": v}
              for k, v in zh.items() if isinstance(v, str) or k.endswith("#head")]
    return _problems({"blocks": blocks})


def _fill_items(ws: Workspace, cfg: dict, batch: list[int], blocks: list[dict], items: dict[str, object],
                cancel, say, meter=None, custom_prompt: str = "", final_pages: list[int] | None = None,
                retry_missing: bool = True) -> None:
    if not items:
        if final_pages:
            fill_zh(ws, {}, final_pages, set())
        return
    if cancel.is_set():
        raise engines.Cancelled()
    marked, ends = sentences.mark_items(blocks, items)  # 英文先按句插好 ‖，译文照着插，记句子对齐
    try:
        with timing.stage(meter, "translate"):
            text = engines.run(
                cfg,
                prompts_en.fill(ws, batch, marked, custom_prompt=custom_prompt),
                ws.root, None, cancel, meter, json_mode=True,
            )
    except engines.OutputLimitReached:
        if len(items) <= 1:
            raise
        pairs = list(items.items())
        mid = len(pairs) // 2
        _fill_items(ws, cfg, batch, blocks, dict(pairs[:mid]), cancel, say, meter, custom_prompt, None, retry_missing)
        _fill_items(ws, cfg, batch, blocks, dict(pairs[mid:]), cancel, say, meter, custom_prompt, final_pages, retry_missing)
        return
    data = engines.parse_json(text)
    if not isinstance(data, dict) or not isinstance(data.get("zh"), dict):
        raise engines.EngineError(tr("模型输出的格式不对（缺 zh）"))
    problems = _fill_problems(data["zh"])
    if problems:
        say(tr("第 {page} 页起有 {n} 处公式或格式问题，正在让模型修正", page=batch[0], n=len(problems)))
        try:
            with timing.stage(meter, "repair"):
                data = batch_repair.repair(
                    data,
                    "zh",
                    problems,
                    lambda prompt: engines.run(cfg, prompt, ws.root, None, cancel, meter, json_mode=True),
                    lambda d: _fill_problems(d.get("zh", {})),
                )
        except engines.EngineError as e:
            pg_lbl = f"Pages {batch[0]}–{batch[-1]}" if len(batch) > 1 else f"Page {batch[0]}"
            journal(ws, f"{pg_lbl} fix failed, original translation kept: {e}")
    with timing.merge_lock(meter, _merge_lock):
        _unify_terms(ws, data, batch, {k: v if isinstance(v, str) else json.dumps(v, ensure_ascii=False) for k, v in items.items()})
        missing = fill_zh(ws, data, final_pages or [], set(items), sentences.unmark_fill(data["zh"], ends))
        _save_checks(ws, data.get("checks"), batch)
    if missing:
        if retry_missing and 0 < len(missing) < len(items):
            rem = {k: items[k] for k in missing if k in items}
            if rem:
                _fill_items(ws, cfg, batch, blocks, rem, cancel, say, meter, custom_prompt, final_pages, False)
                return
        raise engines.EngineError(tr("漏译了 {n} 处（{ids}）", n=len(missing), ids=", ".join(missing[:5])))


def _fill_batch(ws: Workspace, cfg: dict, batch: list[int], cancel, say, meter=None) -> None:
    """只读原文整理过的页：不重排，只给已有的块补译文。漏译的键抛错，重试时只译剩下的。"""
    custom_prompt = str(cfg.get("custom_prompt") or "")[:2000]
    blocks = [b for b in ws.load("paper").get("blocks", []) if b.get("page") in batch]
    items = prompts_en.todo(blocks)
    if not items:
        fill_zh(ws, {}, batch, set())
        return
    _fill_items(ws, cfg, batch, blocks, items, cancel, say, meter, custom_prompt, batch)


_NON_REF_PROSE = re.compile(
    r"^\s*(?:Acknowledgements?|Competing interests?|Funding|Data availability|Author contributions?|Cite this article)\b",
    re.I,
)
_REF_CONT = re.compile(
    r"^(?:Available at:|https?://|www\.|doi:|\(?(?:Accessed|January|February|March|April|May|June|July|August|September|October|November|December)\b|[a-z])"
)


def _derive_cite_key(text: str) -> str:
    m = re.match(r"^\s*(?:\[(\d{1,3})\]|(\d{1,3})\.(?=\s))", text)
    if m:
        return m.group(1) or m.group(2)
    ym = re.search(r"\b((?:19|20)\d{2}[a-z]?)\b", text)
    if ym:
        head = re.split(r"[,(]", text, maxsplit=1)[0].strip()
        first = head.split()[0] if head.split() else ""
        surname = re.sub(r"[^A-Za-z0-9\u00C0-\u024F\-]", "", first)
        if surname:
            return f"{surname}-{ym.group(1)}"
    return ""


def _collect_reference_blocks(ws: Workspace, data: dict, batch: list[int]) -> None:
    """将参考文献页里被模型拆成独立 para 块的条目归并进顶层 references 列表，确保按整段参考文献区排版。"""
    ref_pg = references_page(ws)
    if not ref_pg or max(batch) < ref_pg:
        return
    in_refs = False
    appendix_seen = False
    kept: list[dict] = []
    collected: list[dict] = []
    refs_insert_at: int | None = None
    has_refs_block = False

    for b in data.get("blocks", []):
        page = b.get("page") or batch[0]
        btype = b.get("type")
        if btype == "heading" and b.get("appendix"):
            in_refs = False
            appendix_seen = True
            kept.append(b)
            continue
        if btype == "references" or (btype == "heading" and _REF_LINE.match(str(b.get("en") or ""))):
            in_refs = True
            if not has_refs_block:
                if btype == "heading":
                    b = {"id": b["id"], "type": "references", "page": page, "en": "References", "zh": "參考文獻"}
                refs_insert_at = len(kept)
                kept.append(b)
                has_refs_block = True
            continue
        if page > ref_pg and not appendix_seen:
            in_refs = True
        en_raw = str(b.get("en") or "")
        is_ref_id = str(b.get("id") or "").lower().startswith("ref")
        if btype == "para" and not _NON_REF_PROSE.match(en_raw) and (in_refs or (page >= ref_pg and is_ref_id)):
            in_refs = True
            en_text = " ".join(xrefs.plain(en_raw).split())
            if not en_text:
                continue
            if collected and _REF_CONT.match(en_text):
                collected[-1]["text"] = collected[-1]["text"].rstrip() + " " + en_text
            else:
                if refs_insert_at is None and page == ref_pg:
                    refs_insert_at = len(kept)
                collected.append({"id": _derive_cite_key(en_text), "text": en_text, "page": page})
            continue
        kept.append(b)

    if collected:
        data.setdefault("references", []).extend(collected)
    if ref_pg in batch and (collected or data.get("references")) and not has_refs_block:
        blk = {"id": "refs", "type": "references", "page": ref_pg, "en": "References", "zh": "參考文獻"}
        if refs_insert_at is not None:
            kept.insert(refs_insert_at, blk)
        else:
            kept.append(blk)
    data["blocks"] = kept


def _drop_premature_references(ws: Workspace, data: dict, pages: list[int]) -> None:
    """小模型有时在正文页凭空输出参考文献块和条目。整批都在参考文献标题所在页之前时一律丢掉；
    找不到参考文献标题（references_page 为 None）时不判断，照模型给的。"""
    start = references_page(ws)
    if start and max(pages) < start:
        data["blocks"] = [b for b in data["blocks"] if b.get("type") != "references"]
        data.pop("references", None)


def _parse_and_repair(ws: Workspace, cfg: dict, batch: list[int], text: str, read: bool, cancel, say, meter,
                      taken: set[str] | None = None) -> dict:
    """解析模型输出、规整块 id、去掉幻觉出的参考文献，有公式或格式问题时给一次修的机会。"""
    try:
        data = engines.parse_json(text)
    except engines.EngineError:
        (ws.root / "extract" / f"failed-{batch[0]:03d}.txt").write_text(text, encoding="utf-8")
        raise

    shared_taken = taken if taken is not None else _taken(ws, batch)

    def normalize(d: dict) -> dict:
        return _normalize(d, batch, shared_taken, ws.root / "extract")

    data = normalize(data)
    _drop_premature_references(ws, data, batch)
    _collect_reference_blocks(ws, data, batch)
    expected_notes = footnotes.expected(ws, data["blocks"])

    def check(d: dict) -> list[str]:
        return _problems(d) + footnotes.problems(d.get("blocks", []), expected_notes, read)

    problems = check(data)
    if problems:  # 给一次修的机会
        say(tr("第 {page} 页起有 {n} 处公式或格式问题，正在让模型修正", page=batch[0], n=len(problems)))
        try:
            with timing.stage(meter, "repair"):
                data = batch_repair.repair(
                    data, "blocks", problems,
                    lambda prompt: engines.run(cfg, prompt, ws.root, None, cancel, meter, json_mode=True),
                    check, normalize=normalize,
                )
            _drop_premature_references(ws, data, batch)
            _collect_reference_blocks(ws, data, batch)
        except engines.EngineError as e:
            pg_lbl = f"Pages {batch[0]}–{batch[-1]}" if len(batch) > 1 else f"Page {batch[0]}"
            journal(ws, f"{pg_lbl} fix failed, original translation kept: {e}")
    return data


def _page_parts(ws: Workspace, page_n: int) -> list[str]:
    """把一页送给模型的文字切成可以分开整理的单位：先按空行分段，分不开再按行。"""
    raw = prompts.page_text(ws, page_n)
    parts = [p for p in re.split(r"\n\s*\n", raw) if p.strip()]
    return parts if len(parts) > 1 else [ln for ln in raw.splitlines() if ln.strip()]


def _split_point(parts: list[str], start: int, end: int) -> int:
    mid = (start + end) // 2
    for offset in range(0, 7):
        for cand in (mid - offset, mid + offset):
            if start < cand < end:
                prev_s = parts[cand - 1].rstrip()
                next_s = parts[cand].lstrip()
                if (
                    prev_s.endswith((".", ")", "?", "!"))
                    and next_s[:1].isalnum()
                    and (next_s[0].isupper() or next_s[0].isdigit())
                    and not next_s.startswith(("Available at:", "Accessed:"))
                ):
                    return cand
    return mid


def _structure_in_parts(ws: Workspace, cfg: dict, page_n: int, total_pages: int, cancel, say, meter,
                        skip_head: bool, peek, compact: bool) -> bool:
    """单页整理原文也超出输出上限：把这页的文字对半切开，一份份整理后再一次并入同一页（块 id 由 _normalize 避开已用的）。
    哪一份还超限就再对半切，切到只剩一段仍超限才放弃。这页切不开（只有一段）返回 False，交回调用方报错。
    只送文字片段，不附原页图及下一页全文，避免把下一页正文复制到本页。"""
    parts = _page_parts(ws, page_n)
    if len(parts) < 2:
        return False
    total = len(parts)
    init_mid = _split_point(parts, 0, total)
    queue = [(0, init_mid), (init_mid, total)]
    all_blocks: list[dict] = []
    all_refs: list[dict] = []
    taken = _taken(ws, [page_n])
    while queue:
        if cancel.is_set():
            raise engines.Cancelled()
        start, end = queue.pop(0)
        first = start == 0
        prompt = prompts_en.structure(ws, [page_n], "text", "", skip_head and first, (),
                                      page_text_override="\n\n".join(parts[start:end]))
        try:
            with timing.stage(meter, "translate"):
                text = engines.run(cfg, prompt, ws.root, [], cancel, meter, json_mode=True)
        except engines.OutputLimitReached:
            if end - start < 2:
                raise
            mid = _split_point(parts, start, end)
            queue[:0] = [(start, mid), (mid, end)]
            continue
        data = _parse_and_repair(ws, cfg, [page_n], text, True, cancel, say, meter, taken=taken)
        all_blocks.extend(data.get("blocks", []))
        all_refs.extend(data.get("references", []))
    if not all_blocks and not all_refs:
        raise engines.EngineError(tr("模型没有整理出任何内容"))
    merged = {"blocks": all_blocks, "references": all_refs}
    with timing.merge_lock(meter, _merge_lock):
        merged = _normalize(merged, [page_n], _taken(ws, [page_n]), ws.root / "extract")
        _drop_premature_references(ws, merged, [page_n])
        _collect_reference_blocks(ws, merged, [page_n])
        prepare_figures(ws.root, merged["blocks"], total_pages)
        drop = _one_references(ws, merged, [page_n])
        merge_blocks(ws, merged, done=[page_n], replace_pages=[page_n], en_only=True, drop_ids=drop)
        _locate_quietly(ws)
    return True


def _locate_quietly(ws: Workspace) -> None:
    try:
        pdfwork.locate(ws.root)
        figures.fill(ws)
    except Exception:  # noqa: BLE001 —— 定位失败不影响阅读
        log.exception("locate 失败 %s", ws.id)


def _one_batch(ws: Workspace, cfg: dict, batch: list[int], total_pages: int, cancel, say, meter=None, read=False,
               skip_head=False, peek=(), front=False, compact: bool = False) -> None:
    """read：只读原文，整理成块但不翻译。skip_head：上一页由另一段同时在译，页首续文归它。
    peek：分段交界处顺便看一眼的相邻页（见 prompts.peek_note）。front：带上前文参考（每段第一批，见 front_context）。
    compact：输出上限很紧时用（单页分两步）：不带前文参考，下一页只给开头，省下输入给输出。"""
    mode = engines.image_mode(cfg)
    images = [pdfwork.engine_image(ws.root, n) for n in sorted({*batch, *peek})] if mode != "text" else []
    nxt = batch[-1] + 1
    # 分段交界、引擎不能看图：前一段最后一批拿下一页全文补完跨页那段（后一段第一批会跳过页首续文，这里补不全就丢了）
    head = _next_head(ws, nxt, whole=mode == "text" and nxt in peek and not compact) if nxt <= total_pages else ""
    custom_prompt = str(cfg.get("custom_prompt") or "")[:2000]
    if read:
        prompt = prompts_en.structure(ws, batch, mode, head, skip_head, peek)
    else:
        front_text = front_context.build(ws.root, batch[0]) if (front and not compact) else ""
        prompt = prompts.translate(ws, batch, mode, head, skip_head, peek, front_text, custom_prompt=custom_prompt)
    listing_figures = {(page, number): caption for page in batch
                       for number, (_, caption) in numbered_listings.read_listings(ws.root / "extract", page).items()}
    if listing_figures:
        prompt += "\n以下原页图题紧接在带行号的代码后。每条保留为单独的 figure 块，照录图号和题注：\n" + "\n".join(  # i18n-ok
            f"p.{page} {caption}" for (page, _), caption in listing_figures.items())
    try:
        with timing.stage(meter, "translate"):
            text = engines.run(cfg, prompt, ws.root, images, cancel, meter, json_mode=True)
    except engines.OutputLimitReached:
        if read and len(batch) == 1 and _structure_in_parts(ws, cfg, batch[0], total_pages, cancel, say, meter,
                                                            skip_head, peek, compact):
            return
        raise
    data = _parse_and_repair(ws, cfg, batch, text, read, cancel, say, meter)
    if listing_figures:
        present = {(b["page"], numbered_listings.figure_number(b.get("caption_en")) or str(b.get("num")))
                   for b in data["blocks"] if b["type"] == "figure" and b.get("caption_en")}
        missing_figs = [f"p.{page} Fig. {num}" for page, num in listing_figures if (page, num) not in present]
        if missing_figs:
            raise engines.EngineError(tr("模型遗漏了原页图块：{ids}", ids=", ".join(missing_figs)))
    if not data["blocks"] and not data.get("references"):  # 整页都是参考文献时只有 references，没有新块，也算译完
        raise engines.EngineError(tr("模型没有整理出任何内容") if read else tr("模型没有译出任何内容"))
    with timing.merge_lock(meter, _merge_lock):
        data = _normalize(data, batch, _taken(ws, batch), ws.root / "extract")  # 并发时别的批可能刚占用了同名 id
        _drop_premature_references(ws, data, batch)
        _collect_reference_blocks(ws, data, batch)
        missing = page_check.missing_pages(ws, batch, data)  # 有的页有内容、有的页整页漏了：漏的页不算译完
        keep = [n for n in batch if n not in missing]
        prepare_figures(ws.root, data["blocks"], total_pages)
        _unify_terms(ws, data, batch)
        drop = _one_references(ws, data, batch)
        merge_blocks(ws, data, done=keep, replace_pages=keep, en_only=read, drop_ids=drop)
        _save_checks(ws, data.get("checks"), batch)
        _locate_quietly(ws)
    if missing:
        raise page_check.MissingPages(missing)


def _one_references(ws: Workspace, data: dict, batch: list[int]) -> list[str]:
    """全文只留一个“参考文献”块（页面上它会把整张参考文献表画出来，两个就画两遍）。
    参考文献跨了几批（分段并行时可能两段各起一个）时留页码最早的那个；这批的更早，就接过已有那块的 id
    （挂在上面的笔记还挂得住），返回要在合并时一并删掉的旧块 id。在合并锁里调。"""
    mine = [b for b in data["blocks"] if b.get("type") == "references"]
    if not mine:
        return []
    others = [b for b in ws.load("paper").get("blocks", []) if b.get("type") == "references" and b.get("page") not in batch]
    keep = min(mine, key=lambda b: b.get("page") or 0)
    data["blocks"] = [b for b in data["blocks"] if b.get("type") != "references" or b is keep]
    if not others:
        return []
    if min(b.get("page") or 0 for b in others) <= (keep.get("page") or 0):
        data["blocks"].remove(keep)
        return []
    keep["id"] = others[0]["id"]
    return [b["id"] for b in others]


def _unify_terms(ws: Workspace, data: dict, batch: list[int], en_of: dict | None = None) -> None:
    """这批新报的术语和术语表里已有的译法不同（分段并行时几段各自先定了译法）：译文改成已有的说法。在合并锁里调。"""
    for en, mine, old in terms.unify(ws.load("paper").get("glossary", []), data, en_of):
        journal(ws, f'Terminology unified starting from page {batch[0]}: "{mine}" -> "{old}" for {en}')


def _save_checks(ws: Workspace, checks, batch: list[int]) -> None:
    """模型发现的原文问题 → 页边的“原文核对提示”。重译这几页时，先去掉上次翻译留下的那几条。"""
    pages = {b["id"]: b.get("page") for b in ws.load("paper").get("blocks", [])}
    old = [e["id"] for e in ws.load("discussion").get("entries", [])
           if e.get("kind") == "check" and e.get("by") == "translator" and pages.get(e.get("anchor")) in batch]
    if old:
        ws.update("discussion", lambda d: d.__setitem__("entries", [e for e in d["entries"] if e.get("id") not in old]))
    items = [{"kind": "check", "by": "translator", "anchor": c["anchor"], "quote": sentences.strip(str(c.get("quote") or ""))[:200],
              "title": str(c.get("title") or "")[:80], "body": str(c["body"])}
             for c in (checks or []) if isinstance(c, dict) and c.get("anchor") in pages and str(c.get("body") or "").strip()]
    if items:
        try:
            add_discussion(ws, items)
        except ValueError as e:
            journal(ws, f"Verification prompt failed to save: {e}")


def _batches(pages: list[int], size: int, en_pages: set[int]) -> list[list[int]]:
    """分批：只把连续的页放一批（续传时中间隔着已译的页，跨页续文对不上）；只读原文整理过的页（补译文）和要从头译的页不混在一批里。"""
    out: list[list[int]] = []
    for n in pages:
        if out and n == out[-1][-1] + 1 and len(out[-1]) < size and (out[-1][0] in en_pages) == (n in en_pages):
            out[-1].append(n)
        else:
            out.append([n])
    return out


def _staged_single_page(ws: Workspace, cfg: dict, page_n: int, total_pages: int, cancel, say, meter,
                        skip_head: bool, peek) -> None:
    """单页一次译完会超出输出上限：先整理原文（只输出英文结构），再按块补译文，每次的输出都小一半以上。
    这页原来已有译文时先留快照，中途失败就还原，重译失败不会让读者丢掉旧译文；
    全新的页失败时留下已整理好的原文（记在 en_pages），下次直接补译文。"""
    with timing.merge_lock(meter, _merge_lock):
        snap = snapshot_page(ws, page_n)
    try:
        _one_batch(ws, cfg, [page_n], total_pages, cancel, say, meter, True, skip_head, peek, False, compact=True)
        if cancel.is_set():
            raise engines.Cancelled()
        _fill_batch(ws, cfg, [page_n], cancel, say, meter)
    except BaseException:
        if snap["blocks"]:
            with timing.merge_lock(meter, _merge_lock):
                restore_page(ws, snap)
        raise


def translate_pages(ws: Workspace, cfg: dict, pages: list[int], cancel, report, meter=None, read=False) -> dict[int, str]:
    """翻译给定的页（已完成的页会重译并替换；只读原文整理过的页就地补译文）。report(done, total, message)；
    meter 收集 token 用量。read：只读原文，把页整理成块但不翻译。返回没做成的页 {页码: 原因}。"""
    if cancel.is_set():
        raise engines.Cancelled()
    blank = blank_pages.find(ws, pages, cancel)
    if cancel.is_set():
        raise engines.Cancelled()
    if blank:
        with timing.merge_lock(meter, _merge_lock):
            merge_blocks(ws, {"blocks": []}, done=blank)
        pages = [n for n in pages if n not in blank]
    if not pages:
        report(len(blank), len(blank), tr("结束，全部成功"))
        return {}
    if blank:
        original_report = report
        report = lambda done, total, message: original_report(done + len(blank), total + len(blank), message)
    cfg = engines.for_translation(cfg)  # 本机 CLI 不加载用户的 MCP、多余的工具定义（问 AI 不走这里）
    paper = ws.load("paper")
    total_pages = paper.get("meta", {}).get("page_count") or 0
    en_pages = set() if read else set(paper.get("translation", {}).get("en_pages", []))
    size = max(1, int(cfg.get("batch_pages") or 2))
    # 分段并行：切成几段连续的页同时译，段内一批接一批（见 segments.py）
    k = segments.workers(cfg.get("concurrency"), len(_batches(pages, size, en_pages)))
    lanes = [_batches(seg, size, en_pages) for seg in segments.plan(pages, size, k, ws.root)]
    batches = [b for lane in lanes for b in lane]
    verb = tr("正在整理原文") if read else tr("正在翻译")
    workers = max(1, len(lanes))
    job_pages = set(pages)
    had = set(paper.get("translation", {}).get("done_pages", [])) - en_pages  # 开译前已经有译文的页
    lane_of = {n: i for i, lane in enumerate(lanes) for b in lane for n in b}
    state = {"done": 0, "active": set(), "quota": "", "ok": set(), "prefer_staged": False}  # ok：这次已经做成的页
    failed: dict[int, str] = {}
    lock = threading.Lock()
    bad = netcheck.problem(cfg)
    if bad:
        raise engines.EngineError(bad)
    if not read and not paper.get("meta", {}).get("target"):  # 第一次翻译时记下译文语言，之后改设置不影响这篇
        old_zh = any(b.get("zh") or b.get("caption_zh") for b in paper.get("blocks", []))  # 1.3 以前译的都是中文
        target = "zh" if old_zh else langs.of_paper(paper.get("meta"), cfg)
        ws.update("paper", lambda p: p.setdefault("meta", {}).setdefault("target", target))
    def en_page_range(b):
        return f"Pages {b[0]}–{b[-1]}" if len(b) > 1 else f"Page {b[0]}"

    ro_pfx = "[Read-only] " if read else ""
    journal(ws, f"{ro_pfx}Started: {len(pages)} pages, {len(batches)} batches, engine {engines.engine_name(cfg.get('engine'))}, concurrency {workers}")

    def label(batch):
        return tr("第 {a}–{b} 页", a=batch[0], b=batch[-1]) if len(batch) > 1 else tr("第 {page} 页", page=batch[0])

    if workers > 1:
        ranges_str = ", ".join(en_page_range(sorted({lane[0][0], lane[-1][-1]})) for lane in lanes)
        journal(ws, f"Concurrent translation in {workers} segments: {ranges_str}")

    def say(msg=None):
        with lock:
            active = sorted(state["active"])
            sep = " " if lang() == "en" else ""
            text = msg or ((verb + sep + tr("、").join(label(b) for b in active)) if active else verb)
            report(state["done"], len(pages), text)

    def work(batch):
        if cancel.is_set():
            return
        if state["quota"]:  # 额度用完了，不再白跑
            with lock:
                state["done"] += len(batch)
                for n in batch:
                    failed[n] = state["quota"]
            return
        with lock:
            state["active"].add(tuple(batch))
            p = batch[0] - 1  # 上一页这次也要译、还没译好（在别的段里同时译）：跨页那段归它，这批跳过页首续文
            skip_head = p in job_pages and p not in state["ok"] and p not in en_pages
            # 交界两边都看一眼相邻页的原页图：后一段第一批看上一页末尾，前一段最后一批看下一页开头
            q = batch[-1] + 1
            # 下一页存在、不在本段（别的段在译，或者断点续传时已经译过、跳过了页首续文）：本批负责把跨页那段补完整
            owner = q <= total_pages and lane_of.get(q) != lane_of[batch[-1]] and q not in en_pages
            peek = ([p] if skip_head else []) + ([q] if owner else [])
            # 每段第一批、上一页还没有译文（同时在别的段里译，或从没译过）：给原文的前文参考
            front = batch is lanes[lane_of[batch[0]]][0] and batch[0] > 1 and (p not in had or skip_head)
        with lock:
            prefer_staged = state["prefer_staged"]
        say()
        err, todo = None, batch
        stage_single_page = prefer_staged and not read and len(batch) == 1 and batch[0] not in en_pages
        for attempt in range(2):
            try:
                if stage_single_page:
                    _staged_single_page(ws, cfg, todo[0], total_pages, cancel, say, meter, skip_head, peek)
                elif todo[0] in en_pages:
                    _fill_batch(ws, cfg, todo, cancel, say, meter)
                elif todo is batch:
                    _one_batch(ws, cfg, batch, total_pages, cancel, say, meter, read, skip_head, peek, front)
                else:  # 只重译这批里漏掉的页：前面的页已经并进去了，不用再跳过页首续文
                    _one_batch(ws, cfg, todo, total_pages, cancel, say, meter, read)
                with lock:
                    state["ok"].update(todo)
                journal(ws, f"{en_page_range(todo)} completed")
                err = None
                break
            except page_check.MissingPages as e:
                with lock:
                    state["ok"].update(n for n in todo if n not in e.pages)
                todo = e.pages
                err = tr("模型漏译了这一页")
                journal(ws, f"{en_page_range(todo)} missed entirely by model, retrying individually")
            except engines.Cancelled:
                raise
            except engines.OutputLimitReached as e:
                err = (tr("模型输出被截断了（超过它的输出长度上限）。在设置里把“每次交给模型的页数”调成 1 页再试。")
                       if len(todo) > 1 else str(e))
                journal(ws, f"{en_page_range(todo)} failed (attempt {attempt + 1}): {err[:500]}")
                log.warning("翻译失败 %s %s: %s", ws.id, todo, err[:300])
                if cancel.is_set():
                    raise engines.Cancelled()
                if attempt or read or len(todo) != 1 or todo[0] in en_pages or stage_single_page:
                    break
                with lock:
                    state["prefer_staged"] = True
                stage_single_page = True
                say(tr("单页输出达到上限，正在分开整理原文和翻译"))
            except Exception as e:  # noqa: BLE001
                err = str(e) if isinstance(e, engines.EngineError) else f"{type(e).__name__}: {e}"
                journal(ws, f"{en_page_range(todo)} failed (attempt {attempt + 1}): {err[:500]}")
                log.warning("翻译失败 %s %s: %s", ws.id, todo, err[:300])
                if cancel.is_set():
                    raise engines.Cancelled()
                if _QUOTA.search(err) or netcheck.offline(err):
                    state["quota"] = err[:300]
                    journal(ws, "Quota exceeded or connection lost, stopping remaining pages")
                    break
        with lock:
            state["active"].discard(tuple(batch))
            state["done"] += len(batch)
            if err:
                for n in todo:
                    failed[n] = err[:300]
        say()

    def run_lane(lane):
        for batch in lane:
            if cancel.is_set():
                return
            work(batch)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(run_lane, lane) for lane in lanes]
        for f in futures:
            f.result()  # Cancelled 在这里抛出去
    if cancel.is_set():
        raise engines.Cancelled()
    if not read and len(batches) > 1 and not state["quota"] and state["ok"]:
        try:  # 检查失败或这时取消，都不影响已经译好的内容：照常结束，不算取消
            report(state["done"], len(pages), tr("正在检查术语一致性"))
            consistency.check(ws, cfg, sorted(state["ok"]), cancel, meter, journal, _merge_lock)
        except engines.Cancelled:
            journal(ws, "Terminology consistency check cancelled, translation kept")
        except Exception as e:  # noqa: BLE001
            journal(ws, f"Terminology consistency check failed: {str(e)[:300]}")
            log.warning("术语一致性检查失败 %s: %s", ws.id, e)
    journal(ws, f"Finished, {len(failed)} pages failed: {sorted(failed)}" if failed else "Finished, all successful")
    return failed


def answer(ws: Workspace, cfg: dict, note_id: str, cancel) -> None:
    note = ws.load("reader").get("notes", {}).get(note_id)
    if not note:
        raise KeyError(note_id)
    text = engines.run(engines.for_translation(cfg), prompts.answer(ws, note), ws.root, None, cancel).strip()
    if not text:
        raise engines.EngineError(tr("模型没有给出回答"))
    add_discussion(ws, [{"reply_to": note_id, "kind": "reply", "body": text, "by": engines.who(cfg)}])


def retranslate(ws: Workspace, cfg: dict, key: str, hint: str, cancel) -> None:
    prompt, en_ends = prompts.retranslate(ws, key, hint)
    data = engines.parse_json(engines.run(engines.for_translation(cfg), prompt, ws.root, None, cancel))
    zh = (data or {}).get("zh", "").strip() if isinstance(data, dict) else ""
    if not zh:
        raise engines.EngineError(tr("模型没有给出新译文"))
    zh, sents = sentences.zh_sents(*en_ends, zh) if en_ends else (sentences.strip(zh), None)
    set_block_text(ws, key, zh, sents)
