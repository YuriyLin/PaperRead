"""配置和数据位置。

從源码目录运行时，数据就放在源码目录（library/、config.json）；安装后放在 ~/PaperRead。
环境变量 EASYREAD_HOME 仍保留作为旧版相容设定，可用来改资料目录；EASYREAD_LIBRARY 临时指定文献库（测试、多库）。
"""
from __future__ import annotations

import copy
import os
import shutil
from pathlib import Path

from .chat_models import DEFAULT_CHAT
from .presets import PRESET_GROUPS, PRESETS  # noqa: F401
from .store import read_json, write_json_atomic
from . import review_policy

PACKAGE = Path(__file__).resolve().parent
WEB = PACKAGE / "web"
_SOURCE = PACKAGE.parent
_SOURCE_MODE = (_SOURCE / "pyproject.toml").exists()
HOME = Path(os.environ.get("EASYREAD_HOME") or (_SOURCE if _SOURCE_MODE else Path.home() / "PaperRead"))
LEGACY_HOME = Path.home() / "EasyRead"
PROJECT = HOME  # 旧名，cli 里还在用
CONFIG_PATH = HOME / "config.json"
LOG_PATH = HOME / "easyread.log"
SERVER_INFO = HOME / ".server.json"

DEFAULTS = {
    "library_dir": str(HOME / "library"),
    "port": 8765,
    "engine": "claude",          # claude | codex（本机 CLI 无头）| openai（任意 OpenAI 兼容接口）| none
    "auto_translate": True,      # 导入后自动开始翻译
    "target": "zh-TW",           # Translation language is independent of the interface.
    "target_locale_v": 1,
    "check_updates": False,      # 個人 fork 未設定自己的發佈庫前，不檢查或套用 upstream 更新
    "batch_pages": 2,            # 每次交给模型的页数
    "page_cap": 60,              # 全文超过多少页先确认；0 表示不限
    "concurrency": 0,            # 同时译几段（分段并行，见 segments.py）；0 是自动，每段约 2 批、最多 4 段；手动最多 8 段
    "concurrency_v": 2,          # 1.3.1 起 concurrency 的意思变了，旧配置的 1 当成自动，见 load
    "claude": {"command": "claude", "model": "", "reasoning_effort": "", "extra_args": [], "timeout": 1200},
    "codex": {"command": "codex", "model": "", "reasoning_effort": "", "service_tier": "", "extra_args": [], "timeout": 1200},
    # api：chat（/chat/completions）| responses（/responses），见 openai_api.py
    "openai": {"preset": "", "base_url": "", "api": "chat", "api_key": "", "model": "", "vision": False, "timeout": 600},
    # 阅读页右侧“问 AI”的模型名单和默认模型，见 chat_models.py
    "chat": copy.deepcopy(DEFAULT_CHAT),
}

def _merge(base: dict, over: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in (over or {}).items():
        out[k] = _merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def is_first_run() -> bool:
    return not CONFIG_PATH.exists()


def _saved() -> dict:
    review_policy.require_path(CONFIG_PATH, "home")
    _migrate_legacy_home()
    raw = read_json(CONFIG_PATH, {}) or {}
    if raw.get("target") == "zh" and not raw.get("target_locale_v"):
        raw["target"] = "zh-TW"
    raw["target_locale_v"] = 1
    if raw.get("concurrency_v") != 2 and raw.get("concurrency") == 1:
        # 以前默认 1，而且切到本机 CLI 时设置页会强制改回 1，旧配置里的 1 多半不是自己选的：当成自动。
        # 存过一次之后带上 concurrency_v，再选 1 就是真的要一段一段译
        raw["concurrency"] = 0
    elif raw.get("concurrency_v") != 2 and isinstance(raw.get("concurrency"), int) and raw["concurrency"] > 4:
        raw["concurrency"] = 4  # 以前的 6 是“同时 6 批”，现在是“同时 6 段”：升级时不替老用户开到 4 段以上
    raw["concurrency_v"] = 2
    return raw


def _migrate_legacy_home() -> None:
    """Migrate the old per-user data directory without discarding either copy.

    The desktop shell may create ``PaperRead`` before the Python backend starts.
    In that case a simple directory rename is no longer possible, so merge the
    legacy tree into the new location and leave the old tree as a recoverable
    backup. Existing files in the new location always win.
    """
    global HOME, PROJECT, CONFIG_PATH, LOG_PATH
    if _SOURCE_MODE or os.environ.get("EASYREAD_HOME") or not LEGACY_HOME.is_dir():
        return
    try:
        if not HOME.exists():
            HOME.parent.mkdir(parents=True, exist_ok=True)
            LEGACY_HOME.replace(HOME)
            return
        _merge_legacy_tree(LEGACY_HOME, HOME)
    except OSError:
        # A locked or read-only old directory remains usable through the legacy
        # path; never discard a user's library just because migration failed.
        HOME = LEGACY_HOME
        PROJECT = HOME
        CONFIG_PATH = HOME / "config.json"
        LOG_PATH = HOME / "easyread.log"
        return


def _merge_legacy_tree(src: Path, dst: Path) -> None:
    """Copy missing legacy files into an existing PaperRead data directory."""
    dst.mkdir(parents=True, exist_ok=True)
    for item in src.iterdir():
        target = dst / item.name
        if item.is_dir() and not item.is_symlink():
            if target.exists() and target.is_dir() and not target.is_symlink():
                _merge_legacy_tree(item, target)
            elif not target.exists():
                shutil.copytree(item, target, symlinks=True)
            continue
        if not target.exists():
            shutil.copy2(item, target, follow_symlinks=False)


def load() -> dict:
    cfg = _merge(DEFAULTS, _saved())
    lib = os.environ.get("EASYREAD_LIBRARY") or os.environ.get("COREAD_LIBRARY")
    if lib:  # 测试或多库时临时指定文献库
        cfg["library_dir"] = lib
    if review_policy.isolated():
        # Keep saved model selections visible for settings round trips. The
        # engines.run / chat.stream guards block model transport independently.
        cfg.update(auto_translate=False, check_updates=False)
    return cfg


def temp_library() -> bool:
    return bool(os.environ.get("EASYREAD_LIBRARY") or os.environ.get("COREAD_LIBRARY"))


def save(patch: dict) -> dict:
    review_policy.require_path(CONFIG_PATH, "home")
    cfg = _merge(_merge(DEFAULTS, _saved()), patch)
    write_json_atomic(CONFIG_PATH, cfg)
    return load()


def with_key(o: dict) -> dict:
    """页面提交的 openai 设置 → 要存的样子。每家服务商的 Key 分开存（keys[预设]），换来换去不用重填；
    页面发回来的打码 Key 或空 Key 表示不改。"""
    cur = load()["openai"]
    o = dict(o)
    key = o.pop("api_key", None)
    preset = o.get("preset", cur.get("preset")) or ""
    keys = dict(cur.get("keys") or {})
    if cur.get("api_key") and not keys:  # 旧配置只有一个 Key
        keys[cur.get("preset") or ""] = cur["api_key"]
    if key and not key.startswith("••••"):
        keys[preset] = key.strip()
    o["keys"] = keys
    o["api_key"] = keys.get(preset, "")
    return o


def public(cfg: dict) -> dict:
    """给页面看的配置：密钥只露后四位。"""
    out = copy.deepcopy(cfg)
    out.pop("review_policy", None)
    if review_policy.isolated():
        out["review_policy"] = review_policy.status()
    key = out["openai"].get("api_key") or ""
    out["openai"]["api_key"] = ("••••" + key[-4:]) if key else ""
    out["openai"]["has_key"] = bool(key)
    out["openai"]["saved_keys"] = [k for k, v in (out["openai"].pop("keys", None) or {}).items() if v]
    return out


def library_dir(cfg: dict | None = None) -> Path:
    p = review_policy.require_path(Path((cfg or load())["library_dir"]), "library")
    p.mkdir(parents=True, exist_ok=True)
    return p
