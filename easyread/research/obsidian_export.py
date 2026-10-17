"""Safe, repeatable multi-file exports for an Obsidian research vault."""
from __future__ import annotations

import base64
import io
import json
import os
import re
import time
import zipfile
from pathlib import Path

from .store import atomic_replace, sha256_text, vault_path


EXPORT_FOLDERS = {
    "analysis": "01-論文分析",
    "mindmap": "02-心智圖",
    "annotations": "03-閱讀標註",
    "comparison": "04-跨論文比較",
}
MANAGED_START = "<!-- paperread:managed:start -->"
MANAGED_END = "<!-- paperread:managed:end -->"
INDEX_NAME = ".paperread-index.json"
MAX_DOCUMENTS = 32
MAX_DOCUMENT_SIZE = 2_000_000


def _index_path(root: Path) -> Path:
    return root / "Research" / INDEX_NAME


def _load_index(root: Path) -> dict:
    path = _index_path(root)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) and isinstance(value.get("documents"), dict) else {"version": 1, "documents": {}}
    except (OSError, UnicodeError, json.JSONDecodeError):
        return {"version": 1, "documents": {}}


def _safe_title(value: str, fallback: str) -> str:
    title = re.sub(r"[\r\n\t]+", " ", str(value or ""))
    title = re.sub(r"[<>:\"/\\|?*\x00-\x1f]", "-", title).strip(" .-")
    title = re.sub(r"\s+", " ", title)
    if len(title) > 80:
        title = (title[:80].rsplit(" ", 1)[0] or title[:80]).strip(" .-")
    if not title:
        title = fallback
    if title.upper() in {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}:
        title = "_" + title
    return title


def _relative(root: Path, path: Path) -> str:
    return os.path.relpath(os.path.realpath(path), os.path.realpath(root)).replace(os.sep, "/")


def _contained_file(root: Path, raw_path: str) -> Path | None:
    """Resolve an index path only when it remains inside the configured Vault."""
    if not raw_path or Path(raw_path).is_absolute():
        return None
    candidate = root / raw_path
    try:
        root_real = os.path.realpath(os.fspath(root))
        candidate_real = os.path.realpath(os.fspath(candidate))
        if os.path.normcase(os.path.commonpath([root_real, candidate_real])) != os.path.normcase(root_real):
            return None
    except ValueError:
        return None
    resolved = Path(candidate_real)
    return resolved if resolved.suffix.lower() == ".md" else None


def _read_research_id(path: Path) -> str:
    try:
        text = path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError):
        return ""
    match = re.search(r"(?m)^research_id:\s*[\"']?([^\"'\s]+)", text[:12000])
    return match.group(1) if match else ""


def _existing_path(root: Path, identity: str, index: dict) -> Path | None:
    entry = index.get("documents", {}).get(identity) or {}
    candidate = _contained_file(root, str(entry.get("path") or ""))
    if candidate and candidate.is_file() and _read_research_id(candidate) == identity:
        return candidate
    research = root / "Research"
    if research.is_dir():
        for path in research.rglob("*.md"):
            contained = _contained_file(root, _relative(root, path))
            if contained and _read_research_id(contained) == identity:
                return contained
    return None


def _identity(doc: dict) -> str:
    raw = str(doc.get("id") or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9:_-]{1,180}", raw):
        raise ValueError("匯出資料缺少有效的穩定 ID。")  # i18n-ok: export validation message is fixed Traditional Chinese.
    return raw


def _links_for(doc: dict, paths: dict[str, str]) -> list[str]:
    links = []
    for target in doc.get("links") or []:
        rel = paths.get(str(target))
        if rel:
            links.append(f"[[{Path(rel).with_suffix('').as_posix()}]]")
    return list(dict.fromkeys(links))


def _managed_body(doc: dict, paths: dict[str, str]) -> str:
    body = str(doc.get("body") or "").strip()
    title = re.sub(r"[\r\n]+", " ", str(doc.get("title") or "未命名研究筆記")).strip() or "未命名研究筆記"
    links = _links_for(doc, paths)
    parts = [f"# {title}"]
    if body:
        parts.extend(["", body])
    if links:
        parts.extend(["", "## 相關筆記", "", *[f"- {link}" for link in links]])
    return "\n".join(parts).rstrip()


def _frontmatter(doc: dict, identity: str) -> str:
    kind = str(doc.get("kind") or "analysis")
    paper_id = str(doc.get("paper_id") or "")
    title = re.sub(r"[\r\n]+", " ", str(doc.get("title") or "未命名研究筆記")).strip() or "未命名研究筆記"
    def quote(value: str) -> str:
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
    lines = ["---", f"research_id: {quote(identity)}", f"type: {quote(kind)}", 'schema_version: "2"']
    if paper_id:
        lines.append(f"paper_id: {quote(paper_id)}")
    lines.append(f"title: {quote(title)}")
    lines.extend(["---", ""])
    return "\n".join(lines)


def _render_new(doc: dict, identity: str, paths: dict[str, str]) -> str:
    return _frontmatter(doc, identity) + MANAGED_START + "\n" + _managed_body(doc, paths) + "\n" + MANAGED_END + "\n"


def _merge_existing(existing: str, generated: str) -> str | None:
    if any(text.count(marker) != 1 for text in (existing, generated) for marker in (MANAGED_START, MANAGED_END)):
        return None
    start = existing.find(MANAGED_START)
    end = existing.find(MANAGED_END, start + len(MANAGED_START)) if start >= 0 else -1
    if start < 0 or end < 0:
        return None
    managed_start = generated.find(MANAGED_START)
    managed_end = generated.find(MANAGED_END, managed_start + len(MANAGED_START))
    if managed_start < 0 or managed_end < 0:
        return None
    return existing[:start] + generated[managed_start:managed_end + len(MANAGED_END)] + existing[end + len(MANAGED_END):]


def _plan(root: Path, documents: list[dict], index: dict) -> tuple[list[dict], dict[str, str]]:
    paths: dict[str, str] = {}
    planned = []
    used = set()
    for doc in documents:
        identity = _identity(doc)
        kind = str(doc.get("kind") or "")
        if kind not in EXPORT_FOLDERS:
            raise ValueError("匯出資料類型不受支援。")  # i18n-ok: export validation message is fixed Traditional Chinese.
        body = str(doc.get("body") or "")
        if any(marker in body or marker in str(doc.get("title") or "") for marker in (MANAGED_START, MANAGED_END)):
            raise ValueError("匯出內容含有保留的管理區塊標記。")  # i18n-ok: export validation
        if len(body.encode("utf-8")) > MAX_DOCUMENT_SIZE:
            raise ValueError("單一匯出檔案過大，請拆分後再匯出。")  # i18n-ok: export validation message is fixed Traditional Chinese.
        existing = _existing_path(root, identity, index)
        if existing:
            rel = _relative(root, existing)
        else:
            filename = _safe_title(str(doc.get("filename") or doc.get("title") or ""), kind) + ".md"
            candidate = root / "Research" / EXPORT_FOLDERS[kind] / filename
            if candidate.exists() and identity not in used:
                candidate = candidate.with_name(candidate.stem + "-" + identity.replace(":", "-")[-12:] + candidate.suffix)
            rel = _relative(root, candidate)
        if _contained_file(root, rel) is None:
            raise ValueError("匯出檔案位置必須位於 Vault 內。")  # i18n-ok: export path validation
        if rel in used:
            raise ValueError("同一匯出中出現重複的檔案位置。")  # i18n-ok: export validation message is fixed Traditional Chinese.
        used.add(rel)
        paths[identity] = rel
        planned.append({"doc": doc, "id": identity, "path": rel, "existing": existing})
    return planned, paths


def _render(planned: list[dict], paths: dict[str, str]) -> list[dict]:
    output = []
    for item in planned:
        doc, identity = item["doc"], item["id"]
        generated = _render_new(doc, identity, paths)
        existing = item["existing"]
        current = existing.read_bytes().decode("utf-8") if existing else ""
        content = generated if not current else _merge_existing(current, generated)
        output.append({**item, "generated": generated, "current": current, "content": content})
    return output


def _index_payload(index: dict, rendered: list[dict]) -> dict:
    docs = dict(index.get("documents") or {})
    now = time.time()
    for item in rendered:
        doc = item["doc"]
        docs[item["id"]] = {"path": item["path"], "kind": doc.get("kind"), "title": doc.get("title") or "", "updated_at": now}
    return {"version": 1, "documents": docs}


def register_document(root: Path, identity: str, kind: str, title: str, path: str) -> None:
    """Record a note written by the proposal workflow in the shared export index."""
    if not re.fullmatch(r"[A-Za-z0-9:_-]{1,180}", str(identity or "")):
        return
    safe_path = _contained_file(root, str(path))
    if safe_path is None:
        return
    index = _load_index(root)
    documents = dict(index.get("documents") or {})
    documents[str(identity)] = {"path": _relative(root, safe_path), "kind": str(kind or ""),
                                "title": str(title or ""), "updated_at": time.time()}
    destination = _index_path(root)
    destination.parent.mkdir(parents=True, exist_ok=True)
    atomic_replace(destination, (json.dumps({"version": 1, "documents": documents}, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))


def _validate_documents(value) -> list[dict]:
    if not isinstance(value, list) or not value or len(value) > MAX_DOCUMENTS:
        raise ValueError("請至少選擇一項匯出內容。")  # i18n-ok: export validation message is fixed Traditional Chinese.
    documents = [item for item in value if isinstance(item, dict)]
    if not documents:
        raise ValueError("請至少選擇一項匯出內容。")  # i18n-ok: export validation message is fixed Traditional Chinese.
    return documents


def export_to_vault(documents: list[dict]) -> dict:
    root = vault_path()
    if root is None:
        raise ValueError("請先設定 Obsidian Vault 資料夾。")  # i18n-ok: export validation message is fixed Traditional Chinese.
    docs = _validate_documents(documents)
    index = _load_index(root)
    planned, paths = _plan(root, docs, index)
    rendered = _render(planned, paths)
    blocked = [{"id": item["id"], "path": item["path"], "reason": "existing_note_without_managed_block"}
               for item in rendered if item["content"] is None]
    if blocked:
        return {"written": [], "updated": [], "conflicts": blocked, "index": _relative(root, _index_path(root))}
    written, updated, conflicts = [], [], []
    for item in rendered:
        destination = root / item["path"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        atomic_replace(destination, item["content"].encode("utf-8"))
        (updated if item["current"] else written).append(item["path"])
    index_data = _index_payload(index, rendered)
    index_path = _index_path(root)
    index_path.parent.mkdir(parents=True, exist_ok=True)
    atomic_replace(index_path, (json.dumps(index_data, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    return {"written": written, "updated": updated, "conflicts": conflicts, "index": _relative(root, _index_path(root))}


def export_zip(documents: list[dict]) -> dict:
    root = vault_path()
    if root is None:
        raise ValueError("請先設定 Obsidian Vault 資料夾。")  # i18n-ok: export validation message is fixed Traditional Chinese.
    docs = _validate_documents(documents)
    index = _load_index(root)
    planned, paths = _plan(root, docs, index)
    rendered = _render(planned, paths)
    index_data = _index_payload(index, rendered)
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        for item in rendered:
            if item["content"] is None:
                continue
            archive.writestr(item["path"], item["content"])
        archive.writestr("Research/" + INDEX_NAME, json.dumps(index_data, ensure_ascii=False, indent=2) + "\n")
    return {"filename": "PaperRead-Research.zip", "content_base64": base64.b64encode(stream.getvalue()).decode("ascii"), "conflicts": [item["id"] for item in rendered if item["content"] is None]}
