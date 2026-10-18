from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path
from pathlib import PurePosixPath, PureWindowsPath
from urllib.parse import quote

from .. import config, prefs, review_policy
from ..i18n import tr


KINDS = {
    "paper": "Papers",
    "topic": "Topics",
    "concept": "Concepts",
    "question": "Questions",
    "hypothesis": "Hypotheses",
    "comparison": "04-跨論文比較",
}

# New multi-file Obsidian export layout.  The legacy folders above remain
# readable for compatibility with existing Research OS notes.
EXPORT_FOLDERS = ("01-論文分析", "02-心智圖", "03-閱讀標註", "04-跨論文比較")


def state_dir() -> Path:
    path = config.HOME / ".research-os"
    path.mkdir(parents=True, exist_ok=True)
    return path


def settings() -> dict:
    return (prefs.load().get("research") or {}).copy()


def normalize_folders(value=None) -> list[str]:
    if value is None:
        value = ["Research", "Papers"]
    if isinstance(value, str):
        value = value.replace(";", ",").split(",")
    if not isinstance(value, (list, tuple)):
        raise ValueError(tr("索引資料夾必須是 Vault 內的相對路徑清單。"))
    result = []
    for item in value:
        raw = str(item or "").strip().replace("\\", "/")
        if not raw:
            continue
        # Check before normalization: stripping a leading slash would otherwise
        # turn an absolute path into an apparently safe vault-relative path.
        raw_parts = raw.split("/")
        if raw.startswith("/") or any(part in (".", "..") or part.startswith(".") for part in raw_parts):
            raise ValueError(tr("索引資料夾必須位於 Vault 內，且不能包含隱藏資料夾。"))
        path = PurePosixPath(raw)
        if path.is_absolute() or PureWindowsPath(raw).drive:
            raise ValueError(tr("索引資料夾必須位於 Vault 內，且不能包含隱藏資料夾。"))
        normalized = path.as_posix()
        if normalized.casefold() not in {entry.casefold() for entry in result}:
            result.append(normalized)
    return result


def index_folders() -> list[str]:
    # An old or partially saved preference may contain an empty list. Keep the
    # Research OS usable in that case and stay within its standard folders.
    return normalize_folders(settings().get("folders")) or normalize_folders(None)


def vault_path() -> Path | None:
    raw = settings().get("vault")
    if not raw:
        return None
    return review_policy.require_path(Path(raw).expanduser(), "vault").resolve()


def set_vault(raw: str, folders=None) -> Path:
    if not raw.strip():
        raise ValueError(tr("請選擇 Obsidian Vault 資料夾。"))
    path = review_policy.require_path(Path(raw).expanduser(), "vault")
    selected_folders = normalize_folders(folders)
    directories = [review_policy.require_path(path / "Research" / name, "vault") for name in {*KINDS.values(), *EXPORT_FOLDERS}]
    path.mkdir(parents=True, exist_ok=True)
    path = path.resolve(strict=True)
    if not path.is_dir():
        raise ValueError(tr("所選路徑不是資料夾。"))
    if path == config.HOME.resolve() or path == config.library_dir().resolve():
        raise ValueError(tr("請選擇 Obsidian Vault 資料夾，不可選 PaperRead 資料目錄。"))
    prefs.save({"research": {"vault": str(path), "folders": selected_folders}})
    for directory in directories:
        directory.mkdir(parents=True, exist_ok=True)
    return path


def validate_vault_path(path: Path) -> Path:
    root = vault_path()
    if root is None:
        raise ValueError(tr("請先設定 Obsidian Vault 資料夾。"))
    # Test doubles and temporary folders can contain symlinks (especially on
    # macOS), and an as-yet-uncreated child can retain a different spelling
    # from its parent after ``Path.resolve()``.  realpath/commonpath compares
    # the canonical directory boundary while still rejecting paths that leave
    # the Vault.
    root_path = Path(root).expanduser()
    candidate_path = root_path / path
    root_real = os.path.realpath(os.fspath(root_path))
    candidate_real = os.path.realpath(os.fspath(candidate_path))
    try:
        inside = os.path.normcase(os.path.commonpath([root_real, candidate_real])) == os.path.normcase(root_real)
    except ValueError:  # Different Windows drives cannot share a Vault root.
        inside = False
    if not inside and not path.is_absolute() and ".." not in path.parts:
        # Some macOS temp directories keep /var and /private/var as distinct
        # spellings even after realpath().  A plain relative path without a
        # parent component is lexically contained and cannot escape the root.
        root_abs = os.path.normcase(os.path.abspath(os.fspath(root_path)))
        candidate_abs = os.path.normcase(os.path.abspath(os.fspath(candidate_path)))
        try:
            inside = os.path.commonpath([root_abs, candidate_abs]) == root_abs
        except ValueError:
            inside = False
    resolved = Path(candidate_real)
    review_policy.require_path(resolved, "vault")
    if not inside or resolved.suffix.lower() != ".md":
        raise ValueError(tr("筆記路徑必須是所選 Vault 內的 Markdown 檔案。"))
    return resolved


def open_easyread(sha256: str, block: str = "") -> str:
    if not re.fullmatch(r"[0-9a-f]{64}", sha256 or ""):
        return ""
    query = f"sha256={sha256}"
    if re.fullmatch(r"[A-Za-z0-9_-]{1,64}", block or ""):
        query += "&block=" + quote(block)
    return "easyread://open?" + query


def markdown_path(root: Path, kind: str, title: str, identity: str) -> Path:
    folder = KINDS.get(kind)
    if not folder:
        raise ValueError(tr("不支援的研究筆記類型。"))
    safe = re.sub(r"[<>:\"/\\|?*\x00-\x1f]", "-", title).strip(" .-")[:100] or kind.title()
    if safe.upper() in {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}:
        safe = "_" + safe
    candidate = root / "Research" / folder / f"{safe}.md"
    if candidate.exists():
        candidate = root / "Research" / folder / f"{safe} ({identity[:8]}).md"
    return candidate


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def atomic_replace(path: Path, data: bytes) -> None:
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with open(tmp, "xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)
