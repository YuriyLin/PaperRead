"""Fail-closed review policy. No setting or HTTP body grants model permission.

RealModelValidation is reserved but unavailable until a restricted Codex runner
has independently verified read/tool/provider/auth boundaries. Never delegate
that mode to the ordinary runner or retry with fewer restrictions.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

def isolated() -> bool:
    return bool(os.environ.get("PAPERREAD_TEST_PROFILE") or os.environ.get("PAPERREAD_REVIEW_MODE")
                or os.environ.get("PAPERREAD_OFFLINE_TEST") == "1")


def model_error() -> str | None:
    if not isolated():
        return None
    # Do not call i18n.tr here: locale detection can read prefs/config before
    # the review profile has been validated. The UI translates this reason.
    if os.environ.get("PAPERREAD_REVIEW_MODE", "Mock") != "Mock":
        return "RealModelValidation 尚未通過 Codex 工具、讀取範圍與登入來源隔離驗證，禁止呼叫真實模型。"  # i18n-ok: translated by the UI after profile validation.
    return "隔離測試模式禁止呼叫模型。"  # i18n-ok: policy errors must not read locale preferences.


def status() -> dict:
    return {"mode": os.environ.get("PAPERREAD_REVIEW_MODE") or "Mock",
            "real_model_allowed": False, "reason": model_error()}


def results_only() -> bool:
    return isolated() and os.environ.get("PAPERREAD_REVIEW_KIND") == "GeminiResults"


def results_route_allowed(method: str, path: str) -> bool:
    """The Gemini result viewer never imports, exports, indexes, or starts AI."""
    if not results_only():
        return True
    if method in ("GET", "HEAD"):
        return path in ("/", "/index.html", "/api/library", "/api/config", "/api/prefs", "/api/jobs",
                        "/api/chat/models", "/api/version", "/api/presence") or \
            path.startswith(("/web/", "/read/", "/p/")) or \
            bool(re.fullmatch(r"/api/p/[A-Za-z0-9_-]+/(state|versions|part/(paper|reader|layout|discussion|job))", path))
    return path in ("/api/prefs", "/api/shutdown", "/api/presence/keep") or \
        bool(re.fullmatch(r"/api/p/[A-Za-z0-9_-]+/ops", path))


def require_launch() -> None:
    """Reject unsupported review launches before logging or reading settings."""
    mode = os.environ.get("PAPERREAD_REVIEW_MODE")
    if mode and mode != "Mock":
        raise ValueError(model_error())
    if mode and not os.environ.get("PAPERREAD_TEST_PROFILE"):
        raise ValueError("Review mode requires an isolated test profile")


def require_path(value: Path | str, area: str) -> Path:
    """Check before mkdir/read/write; canonicalize existing junctions and parents.

    This is an application guard, not an OS sandbox or protection against a
    concurrent hostile filesystem actor. It cannot authorize real inference.
    """
    raw = os.environ.get("PAPERREAD_TEST_PROFILE")
    candidate = Path(value).expanduser()
    if not raw:
        return candidate
    root = Path(raw)
    if not root.is_absolute() or area not in ("home", "library", "vault", "desktop"):
        raise ValueError("Invalid isolated review profile")
    root = root.resolve()
    expected = root / area
    # Resolving the allowed root alone would bless a junction to outside data.
    if expected.resolve() != expected:
        raise ValueError("Isolated review directory must not redirect outside its profile")
    resolved = candidate.resolve()
    if not candidate.is_absolute() or not resolved.is_relative_to(expected):
        raise ValueError("Path must remain inside the isolated review " + area)
    return resolved
