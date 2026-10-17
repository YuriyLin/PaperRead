"""翻譯、提問前先檢查連線；無法連線時立即提供可執行的繁體中文提示，避免使用者等待逾時。

- problem(cfg)：按引擎找到它真正要连的地址，发一个请求；收到任何 HTTP 响应都算通。
- explain(cfg, msg)：引擎跑到一半报错时，报错像网络问题就补一句该怎么办。
- proxy_env()：梯子只开了“系统代理”时 Claude Code / Codex 读不到，把它转成 HTTPS_PROXY 传过去。
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

from .i18n import tr
from . import http, review_policy
from .log import log
from .presets import NEEDS_VPN, PRESETS



_OK_TTL = 120  # 通过一次后两分钟内不再测，一篇论文几十批不用每批都测
_ok: dict[str, float] = {}
_LOCAL = {"localhost", "127.0.0.1", "::1"}
_NET = re.compile(r"ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|EAI_AGAIN|fetch failed|connection error|unable to connect"
                  r"|error sending request|stream disconnected|timed out|getaddrinfo|连不上|can't connect", re.I)  # i18n-ok 匹配报错
_REGION = re.compile(r"unsupported_country|not available in your (country|region)|request not allowed", re.I)
# 自己给出的连不上 / 证书提示里一定带的词（中英文各一套），见到就不再追加建议
_MARKS = ("目前無法連線至", "無法連線至", "目前的連線位置不受", "請先確認服務已啟動",  # i18n-ok: 關鍵字比對，不會直接顯示。
          "在国内要先打开梯子", "先把它打开", "start it first", "can't connect", "could not connect",  # i18n-ok: 內部比對或資料格式，不會直接顯示。  # i18n-ok: 網路連線錯誤比對字串，不會顯示給使用者。
          "VPN settings", "service is unavailable in your region", "refused access from your current region")  # i18n-ok
_CERT_MARKS = ("憑證驗證失敗", "证书校验失败", "certificate verification failed")  # i18n-ok
_CERT = re.compile(r"CERTIFICATE_VERIFY_FAILED|certificate verify failed|self.signed certificate|unknown issuer", re.I)


def _claude_base() -> str:
    """Claude Code 可能配了中转（CC Switch 之类写在 ~/.claude/settings.json 的 env 里），国内中转不用梯子。"""
    base = os.environ.get("ANTHROPIC_BASE_URL")
    if not base:
        try:
            env = json.loads((Path.home() / ".claude" / "settings.json").read_text(encoding="utf-8")).get("env") or {}
            base = env.get("ANTHROPIC_BASE_URL")
        except (OSError, ValueError, AttributeError):
            pass
    return base or "https://api.anthropic.com"


def _codex_base() -> str:
    try:
        text = (Path.home() / ".codex" / "config.toml").read_text(encoding="utf-8")
    except OSError:
        text = ""
    m = re.search(r'^\s*model_provider\s*=\s*"([^"]+)"', text, re.M)
    if m and m.group(1) != "openai":
        sec = re.search(r"^\[model_providers\.%s\]([\s\S]*?)(?=^\[|\Z)" % re.escape(m.group(1)), text, re.M)
        b = sec and re.search(r'^\s*base_url\s*=\s*"([^"]+)"', sec.group(1), re.M)
        if b:
            return b.group(1)
    return "https://chatgpt.com"


def target(cfg: dict) -> dict | None:
    """{name, url, vpn}：vpn 表示這項服務可能需要 VPN 或代理連線。"""
    if review_policy.isolated():
        return None
    e = cfg.get("engine")
    if e == "claude":
        url = _claude_base()
        official = "anthropic.com" in url
        return {"name": "Claude" if official else tr("Claude Code 配置的中转地址"), "url": url, "vpn": official}
    if e == "codex":
        url = _codex_base()
        official = "chatgpt.com" in url or "openai.com" in url
        return {"name": tr("OpenAI（Codex）") if official else tr("Codex 配置的中转地址"), "url": url, "vpn": official}
    if e == "openai":
        o = cfg.get("openai") or {}
        url = (o.get("base_url") or "").strip().rstrip("/")
        if not url:
            return None
        p = next((x for x in PRESETS if x["id"] == o.get("preset")), None) \
            or next((x for x in PRESETS if x["base_url"].rstrip("/") == url), None)
        return {"name": p["name"] if p else tr("接口"), "url": url, "vpn": bool(p and p["id"] in NEEDS_VPN)}
    return None


def _advice(t: dict) -> str:
    host = urlparse(t["url"]).hostname or t["url"]
    if host in _LOCAL:
        return tr("连不上 {name}（{host}）：先把它打开，再点重试。", name=t["name"], host=urlparse(t["url"]).netloc)
    if t["vpn"]:
        return tr("连不上 {name}（{host}）。在国内要先打开梯子（VPN）再点重试；开着还不行，把梯子切到 TUN 或全局模式。不想开梯子，可以在设置里换成国内引擎（DeepSeek、智谱 GLM、硅基流动等）。", name=t["name"], host=host)
    return tr("连不上 {name}（{host}）：检查网络和地址有没有填对；开着梯子的话，试试让国内网站直连。", name=t["name"], host=host)


def _region(t: dict) -> str:
    return tr("{name} 拒绝了当前地区的访问：梯子节点在它不支持的地区（比如香港），换成美国、日本、新加坡等节点再重试。", name=t["name"])


def _certificate(t: dict) -> str:
    host = urlparse(t["url"]).hostname or t["url"]
    return tr("{name}（{host}）证书校验失败：请检查系统信任的根证书；使用代理时，也检查代理证书是否已获系统信任。", name=t["name"], host=host)


def _has_advice(msg: str) -> bool:
    lowered = msg.casefold()
    return any(mark.casefold() in lowered for mark in _MARKS + _CERT_MARKS)


def problem(cfg: dict, timeout: float = 6) -> str | None:
    """连得上返回 None，连不上返回给用户看的一句话。"""
    error = review_policy.model_error()
    if error:
        return error
    t = target(cfg)
    u = urlparse(t["url"]) if t else None
    if not u or not u.hostname:
        return None
    origin = f"{u.scheme}://{u.netloc}/"
    if time.time() - _ok.get(origin, 0) < _OK_TTL:
        return None
    for attempt in range(2):  # 梯子偶尔抖一下，失败一次不算
        try:
            http.urlopen(origin, timeout=timeout).close()
        except urllib.error.HTTPError as e:  # 有 HTTP 响应就说明网络是通的
            if _REGION.search(e.read(2000).decode("utf-8", "replace")):
                return _region(t)
        except Exception as e:  # noqa: BLE001  DNS 失败、拒绝连接、超时、证书被劫持……
            if _CERT.search(str(e)):
                log.info("证书校验失败 %s：%s", origin, e)
                return _certificate(t)
            if attempt == 0:
                continue
            log.info("连通性检查失败 %s：%s", origin, e)
            return _advice(t)
        _ok[origin] = time.time()
        return None


def explain(cfg: dict, msg: str) -> str:
    t = target(cfg)
    if not t or _has_advice(msg):
        return msg
    if _REGION.search(msg):
        return msg + "\n" + _region(t)
    if _CERT.search(msg):
        _ok.clear()
        return msg + "\n" + _certificate(t)
    if _NET.search(msg):
        _ok.clear()
        return msg + "\n" + _advice(t)
    return msg


def offline(msg: str) -> bool:
    """这条报错是不是网络 / 地区问题（是的话剩下的页不用再试了）。"""
    return _has_advice(msg)


def proxy_env() -> dict | None:
    """Windows / macOS 的系统代理 Python 读得到，Node 写的 Claude Code 读不到；没设 HTTPS_PROXY 时替它补上。"""
    if any(os.environ.get(k) for k in ("HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy")):
        return None
    p = urllib.request.getproxies()
    proxy = p.get("https") or p.get("http")
    if not proxy or not proxy.startswith("http"):
        return None
    return dict(os.environ, HTTPS_PROXY=proxy, HTTP_PROXY=p.get("http") or proxy,
                NO_PROXY=os.environ.get("NO_PROXY") or "localhost,127.0.0.1,::1")
