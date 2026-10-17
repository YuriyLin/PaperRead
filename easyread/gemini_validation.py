"""Single-page / single-table command. No server, CLI tools, or saved Key."""
from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import threading

PROFILE = Path(__file__).resolve().parents[1] / ".paperread-local-test" / "gemini-validation"
_TOKEN = object()


class ValidationError(ValueError):
    pass


def safe_path(value, base=None) -> Path:
    """Reject redirects rather than resolving them into another allowed path."""
    root = Path(os.path.abspath(PROFILE))
    candidate = Path(os.path.abspath(value))
    boundary = Path(os.path.abspath(base)) if base else root
    if not boundary.is_relative_to(root) or not candidate.is_relative_to(boundary):
        raise ValidationError("Path must be inside the dedicated Gemini validation directory")
    for entry in [candidate, *candidate.parents]:
        try:
            info = entry.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValidationError("Symlinks, junctions and reparse points are forbidden")
        if stat.S_ISREG(info.st_mode) and info.st_nlink > 1:
            raise ValidationError("Hard-linked validation files are forbidden")
    return candidate


def check_tree():
    root = safe_path(PROFILE)
    if root.exists():
        for parent, folders, files in os.walk(root, followlinks=False):
            for name in folders + files:
                safe_path(Path(parent) / name)


def configure(mode="Mock"):
    if mode not in ("Mock", "GeminiValidation"):
        raise ValidationError("Unsupported validation command mode")
    check_tree()
    os.environ.update(PAPERREAD_TEST_PROFILE=str(PROFILE), PAPERREAD_REVIEW_MODE=mode,
                      PAPERREAD_OFFLINE_TEST="1", EASYREAD_HOME=str(PROFILE / "home"),
                      EASYREAD_LIBRARY=str(PROFILE / "library"), EASYREAD_LANG="zh-TW")


def initialize():
    check_tree()
    root = safe_path(PROFILE)
    marker = root / ".gemini-validation.json"
    if root.exists() and not marker.exists() and any(p.name != "inbox" for p in root.iterdir()):
        raise ValidationError("Existing unrecognized profile will not be overwritten")
    if marker.exists() and json.loads(marker.read_text(encoding="utf-8")) != {"version": 1}:
        raise ValidationError("Unrecognized validation profile")
    for area in ("inbox", "home", "library", "desktop"):
        safe_path(root / area).mkdir(parents=True, exist_ok=True)
    from .store import write_json_atomic
    if not marker.exists():
        write_json_atomic(marker, {"version": 1})
    settings = root / "home" / "config.json"
    if not settings.exists():
        write_json_atomic(settings, {"engine": "none", "auto_translate": False, "check_updates": False,
                                     "library_dir": str(root / "library")})
    else:
        cfg = json.loads(settings.read_text(encoding="utf-8"))
        if cfg.get("engine") != "none" or cfg.get("auto_translate") or cfg.get("check_updates") or cfg.get("openai"):
            raise ValidationError("Validation settings must contain no model credentials or enabled engine")


def prepare(input_pdf, original_page=None):
    """Only explicitly chosen inbox bytes are imported; no metadata enrichment."""
    if original_page is not None and (type(original_page) is not int or original_page < 1):
        raise ValidationError("Original paper page must be a positive integer or omitted")
    path = safe_path(input_pdf, PROFILE / "inbox")
    if not path.is_file() or path.suffix.lower() != ".pdf" or path.stat().st_size > 20_000_000:
        raise ValidationError("Choose one PDF of at most 20 MB in inbox")
    data = path.read_bytes()
    from pypdf import PdfReader
    try:
        pdf = PdfReader(io.BytesIO(data), strict=True)
        if pdf.is_encrypted or len(pdf.pages) != 1:
            raise ValidationError("Only an unencrypted, single-page test PDF is allowed")
    except ValidationError:
        raise
    except Exception:
        raise ValidationError("Invalid single-page PDF") from None
    initialize()
    from . import pdfwork, table_translate
    from .library import Library
    identity = {"test_pdf_page": 1, "original_paper_page": original_page,
                "input_name": path.name, "version": 1}
    title = "Gemini table validation (test PDF p.1; original paper p." + str(original_page or "unknown") + ")"
    lib = Library(PROFILE / "library")
    ws, fresh = lib.create_from_pdf(data, path.name, {"title_en": title, "target": "zh-TW", "validation_source": identity})
    if ws.load("paper").get("meta", {}).get("validation_source") != identity:
        raise ValidationError("Existing PDF provenance differs; do not overwrite it")
    if fresh or not ws.load("paper")["meta"].get("pages"):
        pages = pdfwork.prepare(ws.root)
        ws.update("paper", lambda p: p["meta"].update(page_count=1, pages=pages))
    table_translate._discover(ws, [1], table_translate.pdf_hash(ws), None)
    return ws


def table_list(ws):
    return [{"id": b["id"], "caption": b.get("caption_en", ""), "status": b.get("table_status"),
             "reason": b.get("table_issue", ""), "page": b.get("page")}
            for b in ws.load("paper").get("blocks", []) if b.get("type") == "table"]


class Authorization:
    """Opaque process-only budget. A saved config or HTTP body cannot create it."""
    def __init__(self, token, ws, table_id, model, prompt, key):
        if token is not _TOKEN:
            raise ValidationError("Explicit command authorization is required")
        self.ws, self.table_id, self.model = ws, table_id, model
        self._prompt, self._key = prompt, key
        self._lock = threading.Lock()
        self.attempts = 0
        self._digest = hashlib.sha256(ws.source_pdf.read_bytes()).hexdigest()

    def claim(self, body):
        with self._lock:
            if self.attempts or not self._key:
                raise ValidationError("Single HTTP request budget exhausted; no retry")
            if os.environ.get("PAPERREAD_REVIEW_MODE") != "GeminiValidation" or \
                    Path(os.environ.get("PAPERREAD_TEST_PROFILE", "")) != PROFILE or \
                    os.environ.get("PAPERREAD_OFFLINE_TEST") != "1":
                raise ValidationError("Explicit GeminiValidation command mode is required")
            self.check_source()
            expected = {"model": self.model, "messages": [{"role": "user", "content": self._prompt}]}
            if body != expected or self._key in self._prompt:
                raise ValidationError("Payload differs from the selected table")
            self.attempts += 1  # Count failed HTTP, TLS and response attempts too.
            return self._key

    def check_source(self):
        check_tree()
        safe_path(self.ws.root, PROFILE / "library")
        paper = self.ws.load("paper")
        source = paper.get("meta", {}).get("validation_source", {})
        chosen = [b for b in paper.get("blocks", []) if b.get("id") == self.table_id and b.get("page") == 1]
        inbox = safe_path(PROFILE / "inbox" / source.get("input_name", ""), PROFILE / "inbox")
        if len(chosen) != 1 or paper.get("meta", {}).get("page_count") != 1 or paper.get("glossary") or \
                hashlib.sha256(self.ws.source_pdf.read_bytes()).hexdigest() != self._digest or \
                hashlib.sha256(inbox.read_bytes()).hexdigest() != self._digest:
            raise ValidationError("Selected validation source changed")

    def close(self):
        self._key = ""


def execute(ws, table_id, model, confirm, read_key):
    """Cached results require neither confirmation nor a Key. No task is queued."""
    if os.environ.get("PAPERREAD_REVIEW_MODE") != "GeminiValidation":
        raise ValidationError("Run with explicit GeminiValidation mode")
    if not re.fullmatch(r"gemini-[A-Za-z0-9._-]{1,100}", model or ""):
        raise ValidationError("Choose an explicit Gemini model ID")
    check_tree()
    safe_path(ws.root, PROFILE / "library")
    from . import openai_api, table_extract, table_translate
    matches = [b for b in ws.load("paper").get("blocks", []) if b.get("id") == table_id and b.get("page") == 1]
    if len(matches) != 1:
        raise ValidationError("Select exactly one table from the local list")
    table_extract.recognize(ws, matches[0])  # Unreliable sources stop before Key input.
    authorization = None
    invoked = False

    def run(_cfg, prompt, cwd, images, cancel, meter):
        nonlocal authorization, invoked
        if invoked:
            raise ValidationError("Only one selected table request is authorized")
        invoked = True
        if not confirm():
            raise ValidationError("Request not authorized; nothing sent")
        key = read_key()
        try:
            if not isinstance(key, str) or not key.strip() or any(c.isspace() for c in key):
                raise ValidationError("Enter a nonempty API Key without whitespace")
            authorization = Authorization(_TOKEN, ws, table_id, model, prompt, key)
            text = openai_api.complete_gemini_validation(prompt, model, authorization)
            authorization.check_source()
            return text
        finally:
            key = ""
            if authorization:
                authorization.close()

    try:
        result = table_translate.translate_missing(ws, {"engine": "openai"}, [1], table_id=table_id, run=run, attempts=1)
    finally:
        if authorization:
            authorization.close()
    result["http_attempts"] = authorization.attempts if authorization else 0
    result["paper_id"] = ws.id
    result["table_id"] = table_id
    if result["translated"]:
        def provenance(paper):
            block = next(b for b in paper["blocks"] if b["id"] == table_id)
            block["table_cache"]["validation"] = {"provider": "gemini", "model": model, "http_attempts": result["http_attempts"]}
        ws.update("paper", provenance)
    return result
