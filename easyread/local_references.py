"""Parse bibliography/reference pages locally without calling an LLM."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from . import langs, links, running_text, traditional
from .store import Workspace

# Match standalone section headings for bibliography sections (avoiding TOC lines with trailing page numbers).
_REF_HEADING_RE = re.compile(
    r"^\s*(?:(?:\d+(?:\.\d+)*\.?\s*|[IVXLC]+\.\s*))?"
    r"(?:references?|bibliography|works?\s+cited|literature\s+cited|參考文獻|参考文献)\s*$",  # i18n-ok
    re.I | re.M,
)

# Match standalone Appendix / Supplementary headings where normal LLM translation resumes.
_APPENDIX_HEADING_RE = re.compile(
    r"^\s*(?:"
    r"(?:[A-Z]\.?\s+)?appendix(?:\s+[A-Z0-9]+(?:\.\d+)*)?(?:\s*[:.\-–—]\s*\S.*)?|"
    r"appendices(?:\s*[:.\-–—]\s*\S.*)?|"
    r"supplementary(?:\s+(?:material|materials|information|appendix|section|notes))+(?:\s*[:.\-–—]\s*\S.*)?|"
    r"supporting\s+information(?:\s*[:.\-–—]\s*\S.*)?|"
    r"附[錄录](?:\s*[A-Z0-9]+)?(?:\s*[:.\-–—]\s*\S.*)?"  # i18n-ok
    r")\s*$",
    re.I | re.M,
)

_YEAR_IN_LINE_RE = re.compile(r"\b((?:19|20)\d{2}[a-z]?)\b")
_BRACKET_NUM_RE = re.compile(r"^\s*\[(\d{1,4})\]\s*(.*)$")
_BRACKET_ALPHA_RE = re.compile(r"^\s*\[([A-Za-z][A-Za-z0-9+\-]{1,15})\]\s+(.*)$")
_DOT_NUM_RE = re.compile(r"^\s*(\d{1,3})\.\s+(?=[A-Z\u00C0-\u024F\"“\['‘]|arXiv\b|[A-Z]{2,})(.*)$")

_CONT_START_RE = re.compile(
    r"^(?:"
    r"[a-z]|"
    r"https?://|www\.|doi:|arxiv:|isbn:|issn:|pp\.|vol\.|no\.|eds?\.|"
    r"Available\s+at:|Retrieved\s+|In\s+Proceedings|In\s+[A-Z]|"
    r"\(?(?:Accessed|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b|"
    r"\d+(?:\s*[–\-]\s*\d+)?\s*[.,;]?\s*$|"
    r"[,.;:)&\]]"
    r")",
)

_AUTHOR_START_RE = re.compile(
    r"^(?:"
    r"[A-Z\u00C0-\u024F][A-Za-z\u00C0-\u024F'’\-]+(?:\s+[A-Z\u00C0-\u024F][A-Za-z\u00C0-\u024F'’\-]+)?\s*,\s*(?:[A-Z]\.|[A-Z]\b)|"
    r"[A-Z\u00C0-\u024F][A-Za-z\u00C0-\u024F'’\-]+(?:\s+et\s+al\.|\s+and\s+|\s*&\s*|\s*\((?:19|20)\d{2}[a-z]?\))|"
    r"(?:[A-Z]\.\s*){1,3}[A-Z\u00C0-\u024F][A-Za-z\u00C0-\u024F'’\-]+,|"
    r"[A-Z][A-Za-z0-9\-]{2,}\s*\((?:19|20)\d{2}[a-z]?\)"
    r")"
)

_TRAILING_INCOMPLETE_RE = re.compile(r"(?:[,:\-(;/]|\band|\bin|\bof|\bthe|\bfor|\bwith|\bon)\s*$", re.I)


@dataclass
class PagePlan:
    pure_ref_pages: list[int] = field(default_factory=list)
    split_pages: dict[int, dict[str, str]] = field(default_factory=dict)
    ref_start_page: int | None = None
    ref_segments: dict[int, str] = field(default_factory=dict)


def _is_real_appendix_heading(line: str) -> bool:
    stripped = line.strip()
    if not stripped or len(stripped) > 80:
        return False
    if _YEAR_IN_LINE_RE.search(stripped):
        return False
    return bool(_APPENDIX_HEADING_RE.match(stripped))


def _find_first_appendix(text: str) -> re.Match | None:
    for m in _APPENDIX_HEADING_RE.finditer(text):
        if _is_real_appendix_heading(m.group(0)):
            return m
    return None


def _read_stripped_page(ws: Workspace, page_n: int) -> str:
    path = ws.root / "extract" / f"page-{page_n:03d}.txt"
    if not path.is_file():
        return ""
    raw = path.read_text(encoding="utf-8", errors="replace")
    return running_text.strip(raw, ws.root / "extract")


def _clean_ref_text(ws: Workspace, page_n: int, text: str) -> str:
    """Apply link insertion without polluting plain citations with bold/footnote wrappers."""
    urls = links.ensure(ws).get(str(page_n), [])
    if urls:
        text = links.insert(text, urls)
    return text


def analyze_paper(ws: Workspace, pages: list[int] | None = None) -> PagePlan:
    """Classify pages in `pages` as pure reference, split boundary, or normal LLM pages."""
    paper = ws.load("paper") or {}
    total_pages = paper.get("meta", {}).get("page_count") or 0
    if not total_pages:
        files = sorted((ws.root / "extract").glob("page-*.txt"))
        total_pages = len(files)
    wanted = set(pages) if pages is not None else set(range(1, total_pages + 1))

    plan = PagePlan()
    in_refs = False
    start_from = 1 if total_pages <= 1 else 2

    for p in range(1, total_pages + 1):
        text = _read_stripped_page(ws, p)
        if not in_refs:
            ref_m = _REF_HEADING_RE.search(text) if p >= start_from else None
            if not ref_m:
                continue
            if plan.ref_start_page is None:
                plan.ref_start_page = p
            prose_before = text[:ref_m.start()].strip()
            after_ref = text[ref_m.end():]
            app_m = _find_first_appendix(after_ref)
            if app_m:
                ref_part = after_ref[:app_m.start()].strip()
                prose_after = after_ref[app_m.start():].strip()
                in_refs = False
            else:
                ref_part = after_ref.strip()
                prose_after = ""
                in_refs = True
            llm_parts = [part for part in (prose_before, prose_after) if part]
            llm_text = "\n\n".join(llm_parts).strip()
            if ref_part:
                plan.ref_segments[p] = _clean_ref_text(ws, p, ref_part)
            elif p in wanted:
                plan.ref_segments[p] = ""
            if p in wanted:
                if llm_text:
                    plan.split_pages[p] = {
                        "llm_text": llm_text,
                        "prose_before": prose_before,
                        "prose_after": prose_after,
                        "ref_text": plan.ref_segments.get(p, ""),
                    }
                else:
                    plan.pure_ref_pages.append(p)
        else:
            app_m = _find_first_appendix(text)
            if app_m:
                ref_part = text[:app_m.start()].strip()
                prose_after = text[app_m.start():].strip()
                in_refs = False
                if ref_part:
                    plan.ref_segments[p] = _clean_ref_text(ws, p, ref_part)
                if p in wanted:
                    if prose_after:
                        plan.split_pages[p] = {
                            "llm_text": prose_after,
                            "prose_before": "",
                            "prose_after": prose_after,
                            "ref_text": plan.ref_segments.get(p, ""),
                        }
                    else:
                        plan.pure_ref_pages.append(p)
            else:
                ref_part = text.strip()
                if ref_part:
                    plan.ref_segments[p] = _clean_ref_text(ws, p, ref_part)
                if p in wanted:
                    plan.pure_ref_pages.append(p)

    return plan


def derive_cite_key(text: str) -> str:
    """Derive a PaperRead-compatible reference id/cite_key from reference entry text."""
    m = _BRACKET_NUM_RE.match(text)
    if m:
        return m.group(1)
    m = _DOT_NUM_RE.match(text)
    if m:
        return m.group(1)
    m = _BRACKET_ALPHA_RE.match(text)
    if m:
        return m.group(1)
    ym = _YEAR_IN_LINE_RE.search(text)
    if ym:
        head = re.split(r"[,(]", text, maxsplit=1)[0].strip()
        first = head.split()[0] if head.split() else ""
        surname = re.sub(r"[^A-Za-z0-9\u00C0-\u024F\-]", "", first)
        if surname:
            return f"{surname}-{ym.group(1)}"
    return ""


def _join_wrapped_lines(acc: str, line: str) -> str:
    if not acc:
        return line
    if acc.endswith("-") and not acc.endswith("--"):
        # Join URL or hyphenated line-break word cleanly.
        if re.search(r"https?://\S+$", acc):
            return acc + line
        head_word = acc.rsplit(None, 1)[-1]
        if len(head_word) >= 3 and re.match(r"^[a-z]", line):
            return acc[:-1] + line
    if re.search(r"https?://\S+$", acc) and not line.startswith(("(", "Accessed")):
        return acc + line
    return acc + " " + line


def _detect_style(lines: list[str], preferred: str | None = None) -> str:
    bnum = sum(1 for ln in lines if _BRACKET_NUM_RE.match(ln))
    balpha = sum(1 for ln in lines if _BRACKET_ALPHA_RE.match(ln))
    dnum = sum(1 for ln in lines if _DOT_NUM_RE.match(ln))
    best_count = max(bnum, balpha, dnum)
    if best_count >= 2 or (preferred is None and best_count == 1 and len(lines) <= 8):
        if bnum >= balpha and bnum >= dnum:
            return "bracket_num"
        if balpha >= bnum and balpha >= dnum:
            return "bracket_alpha"
        return "dot_num"
    if preferred in ("bracket_num", "bracket_alpha", "dot_num"):
        if (preferred == "bracket_num" and bnum) or (preferred == "bracket_alpha" and balpha) or (preferred == "dot_num" and dnum):
            return preferred
    return "author_year"


def parse_entries(ref_sections: list[tuple[int, str]], default_style: str | None = None) -> list[dict]:
    """Parse ordered `(page_n, ref_text)` slices into PaperRead reference dicts."""
    all_lines = [ln.strip() for _, txt in ref_sections for ln in txt.splitlines() if ln.strip()]
    if not all_lines:
        return []
    style = _detect_style(all_lines, default_style)

    entries: list[dict] = []
    cur_text = ""
    cur_key = ""
    cur_page: int | None = None
    had_blank = False

    def flush():
        nonlocal cur_text, cur_key, cur_page
        cleaned = " ".join(cur_text.split()).strip()
        if cleaned and cur_page is not None:
            entries.append({"id": cur_key or derive_cite_key(cleaned), "text": cleaned, "page": cur_page})
        cur_text = ""
        cur_key = ""
        cur_page = None

    for page_n, raw_text in ref_sections:
        for raw_ln in raw_text.splitlines():
            ln = raw_ln.strip()
            if not ln:
                had_blank = True
                continue
            if _REF_HEADING_RE.match(ln):
                had_blank = False
                continue

            matched_key = ""
            matched_body = ""
            is_new = False

            if style == "bracket_num":
                m = _BRACKET_NUM_RE.match(ln)
                if m:
                    is_new = True
                    matched_key, matched_body = m.group(1), m.group(2).strip()
            elif style == "bracket_alpha":
                m = _BRACKET_ALPHA_RE.match(ln)
                if m:
                    is_new = True
                    matched_key, matched_body = m.group(1), m.group(2).strip()
            elif style == "dot_num":
                m = _DOT_NUM_RE.match(ln)
                if m:
                    num = int(m.group(1))
                    if 1 <= num <= 500:
                        is_new = True
                        matched_key, matched_body = m.group(1), m.group(2).strip()
            else:
                if not cur_text:
                    is_new = True
                    matched_body = ln
                elif not _CONT_START_RE.match(ln) and not _TRAILING_INCOMPLETE_RE.search(cur_text):
                    prev_complete = cur_text.rstrip().endswith((".", "?", ")", "]")) or bool(_YEAR_IN_LINE_RE.search(cur_text))
                    if prev_complete and (_AUTHOR_START_RE.match(ln) or (had_blank and bool(_YEAR_IN_LINE_RE.search(cur_text)))):
                        is_new = True
                        matched_body = ln

            had_blank = False
            if is_new:
                flush()
                cur_page = page_n
                cur_key = matched_key
                cur_text = matched_body
            else:
                if not cur_text:
                    cur_page = page_n
                cur_text = _join_wrapped_lines(cur_text, ln)

    flush()
    return entries


def _references_heading_zh(target: str) -> str:
    if target == "zh-TW":
        return "參考文獻"  # i18n-ok
    if target == "zh":
        return "参考文献"  # i18n-ok
    return "References"


def build_ref_block(page: int, target: str) -> dict:
    zh = _references_heading_zh(target)
    return {
        "id": "refs",
        "type": "references",
        "page": page,
        "en": "References",
        "zh": zh if zh != "References" else "",
    }


def heading_block_if_needed(ws: Workspace, target_page: int, cfg: dict, replacing_pages: set[int]) -> tuple[dict | None, list[str]]:
    """Return a `(references_block, drop_ids)` pair honoring the single-references-block invariant."""
    paper = ws.load("paper") or {}
    target = langs.of_paper(paper.get("meta"), cfg)
    existing = [
        b for b in paper.get("blocks", [])
        if b.get("type") == "references" and b.get("page") not in replacing_pages
    ]
    if not existing:
        return build_ref_block(target_page, target), []
    earliest_existing = min(b.get("page") or 0 for b in existing)
    if earliest_existing and earliest_existing <= target_page:
        return None, []
    blk = build_ref_block(target_page, target)
    blk["id"] = existing[0]["id"]
    return blk, [b["id"] for b in existing]


def entries_for_pages(plan: PagePlan, target_pages: set[int]) -> list[dict]:
    """Parse all discovered reference segments together for style/wrap continuity, filtered to target_pages."""
    if not plan.ref_segments:
        return []
    ordered = sorted(plan.ref_segments.items())
    return [e for e in parse_entries(ordered) if e.get("page") in target_pages]


def apply_pure_pages(ws: Workspace, plan: PagePlan, cfg: dict) -> tuple[dict, list[int], list[str]] | None:
    """Build `(data, done_pages, drop_ids)` for pure reference pages ready for `merge_blocks`."""
    pure = sorted(plan.pure_ref_pages)
    if not pure:
        return None
    pure_set = set(pure)
    entries = entries_for_pages(plan, pure_set)
    anchor_page = plan.ref_start_page if (plan.ref_start_page in pure_set or plan.ref_start_page is None) else pure[0]
    if plan.ref_start_page is not None and plan.ref_start_page not in pure_set:
        # The heading lives on an earlier split page; still ensure a references block exists if none recorded yet.
        paper = ws.load("paper") or {}
        has_any = any(b.get("type") == "references" and b.get("page") not in pure_set for b in paper.get("blocks", []))
        blk = None if has_any else build_ref_block(pure[0], langs.of_paper(paper.get("meta"), cfg))
        drop_ids: list[str] = []
    else:
        blk, drop_ids = heading_block_if_needed(ws, anchor_page, cfg, pure_set)
    data = {"blocks": [blk] if blk else [], "references": entries}
    return data, pure, drop_ids


def parse_split_page(ws: Workspace, page_n: int, plan: PagePlan, data: dict, cfg: dict) -> None:
    """Attach locally parsed references and heading block onto an LLM result for a split page."""
    entries = entries_for_pages(plan, {page_n})
    if entries:
        data.setdefault("references", []).extend(entries)
    blocks = data.setdefault("blocks", [])
    has_ref_blk = any(b.get("type") == "references" and b.get("page") == page_n for b in blocks)
    if not has_ref_blk and (plan.ref_start_page == page_n or entries):
        paper = ws.load("paper") or {}
        target = langs.of_paper(paper.get("meta"), cfg)
        blk = build_ref_block(page_n, target)
        app_idx = next((i for i, b in enumerate(blocks) if b.get("page") == page_n and b.get("appendix")), None)
        if app_idx is not None:
            blocks.insert(app_idx, blk)
        else:
            blocks.append(blk)
