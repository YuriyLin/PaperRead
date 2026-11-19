"""Optional MinerU PDF parser integration (mineru.net Cloud v4 and self-hosted FastAPI)."""
from __future__ import annotations

import hashlib
import html as html_lib
import http.client as http_client
import io
import json
import math
import os
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from html.parser import HTMLParser
from pathlib import Path

import certifi

from . import engines, http, langs, local_references
from .figures import figure_box, normalize_figure, prepare_figures
from .i18n import tr
from .log import log
from .store import Workspace, read_json, write_json_atomic

CLOUD_BASE = "https://mineru.net"
_POLL_INTERVAL = 2.0
_CACHE_FILE = "mineru_pages.json"

_NUM_HEAD_RE = re.compile(r"^\s*((?:[A-Z]\.)?\d+(?:\.\d+)*|[IVXLC]+\.)\s+(.+)$")
_CAP_NUM_RE = re.compile(r"^\s*(?:\*{0,2})(?:(?:Table|Figure|Fig\.?|Tab\.?)\s+|(?:表|圖|图)\s*)([A-Za-z]?\d+(?:\.[A-Za-z0-9]+)?)\b", re.I)
_FIG_CAP_RE = re.compile(r"^\s*(?:\*{0,2})(?:Fig\.?|Figure|圖|图)\s*(?:[A-Za-z]?\d+(?:\.\d+)*)(?:\s*[.:：]|$)", re.I)
_TAB_CAP_RE = re.compile(r"^\s*(?:\*{0,2})(?:Tab\.?|Table|表)\s*(?:[A-Za-z]?\d+(?:\.\d+)*)(?:\s*[.:：]|$)", re.I)
_FOOT_NUM_RE = re.compile(r"^\s*(?:\[(\d{1,3})\]|\^?(\d{1,3}|[*†‡§¶])(?:[.)\s]+|$))(.*)$")
_EQ_TAG_RE = re.compile(r"(?:\\tag\{([^}]+)\}|\((\d+(?:\.\d+)?)\))\s*$")
_LIST_ORDERED_RE = re.compile(r"^\s*(?:\d+[.)]|\(\d+\)|[a-zA-Z]\))\s+")
_LIST_BULLET_RE = re.compile(r"^\s*(?:[•·▪◦\-–—*]|\d+[.)]|\(\d+\))\s+")
_CODE_ROLE_RE = re.compile(r"\b(Algorithm|Listing)\s+([A-Za-z0-9]+(?:\.[A-Za-z0-9]+)?)\b", re.I)
_QUOTA_ERR_RE = re.compile(r"quota|limit|balance|credit|insufficient|exceeded|429|401|402|unauthorized|额度|余额|上限", re.I)  # i18n-ok

_SUP_MAP = str.maketrans("0123456789+-=()", "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾")
_SUB_MAP = str.maketrans("0123456789+-=()", "₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎")
_SIMPLE_SUP_RE = re.compile(r"^[0-9+\-=()*†‡§¶]+$")
_SIMPLE_SUB_RE = re.compile(r"^[0-9+\-=()]+$")
_SUP_TAG_RE = re.compile(r"<sup\b[^>]*>(.*?)</sup>", re.I | re.S)
_SUB_TAG_RE = re.compile(r"<sub\b[^>]*>(.*?)</sub>", re.I | re.S)
_BOLD_TAG_RE = re.compile(r"<(?:b|strong)\b[^>]*>(.*?)</(?:b|strong)>", re.I | re.S)
_ITALIC_TAG_RE = re.compile(r"<(?:i|em)\b[^>]*>(.*?)</(?:i|em)>", re.I | re.S)
_BR_TAG_RE = re.compile(r"<br\s*/?>", re.I)
_LEAD_FOOT_SUP_RE = re.compile(r"^\s*<sup\b[^>]*>([^<]{1,16})</sup>\s*(.*)$", re.S | re.I)


def _clean_inline_html(text: str) -> str:
    """Convert inline formatting HTML tags emitted by MinerU into PaperRead Markdown/Unicode."""
    s = text
    if "<" in s:
        s = _BR_TAG_RE.sub("\n", s)
        s = _BOLD_TAG_RE.sub(lambda m: f"**{m.group(1).strip()}**" if m.group(1).strip() else "", s)
        s = _ITALIC_TAG_RE.sub(lambda m: f"*{m.group(1).strip()}*" if m.group(1).strip() else "", s)

        def _rep_sup(m: re.Match) -> str:
            inner = " ".join(m.group(1).split()).strip()
            if not inner:
                return ""
            if _SIMPLE_SUP_RE.match(inner):
                return inner.translate(_SUP_MAP)
            tex_inner = re.sub(r"[A-Za-z]+", lambda wm: rf"\mathrm{{{wm.group(0)}}}", inner)
            return f"$^{{{tex_inner}}}$"

        def _rep_sub(m: re.Match) -> str:
            inner = " ".join(m.group(1).split()).strip()
            if not inner:
                return ""
            if _SIMPLE_SUB_RE.match(inner):
                return inner.translate(_SUB_MAP)
            tex_inner = re.sub(r"[A-Za-z]+", lambda wm: rf"\mathrm{{{wm.group(0)}}}", inner)
            return f"$_{{{tex_inner}}}$"

        s = _SUP_TAG_RE.sub(_rep_sup, s)
        s = _SUB_TAG_RE.sub(_rep_sub, s)
    if "&" in s:
        s = html_lib.unescape(s)
    return s


def _flatten_text_list(val) -> str:
    """Normalize MinerU caption/footnote values whether given as strings or `{"bbox", "content"}` dicts."""
    if isinstance(val, list):
        parts: list[str] = []
        for x in val:
            if isinstance(x, dict):
                s = str(x.get("content") or x.get("text") or "").strip()
            else:
                s = str(x or "").strip()
            if s:
                parts.append(s)
        return " ".join(parts).strip()
    if isinstance(val, dict):
        return str(val.get("content") or val.get("text") or "").strip()
    return str(val or "").strip()


class MinerUError(RuntimeError):
    """Raised when MinerU parsing or connection fails cleanly."""


class MinerUQuotaError(MinerUError):
    """Raised when MinerU rejects requests due to quota, balance, or auth failure."""


def config_of(cfg: dict) -> dict:
    raw = (cfg or {}).get("mineru") or {}
    return {
        "enabled": bool(raw.get("enabled")),
        "mode": "local" if str(raw.get("mode") or "cloud").strip().lower() == "local" else "cloud",
        "token": str(raw.get("token") or "").strip(),
        "base_url": str(raw.get("base_url") or "").strip().rstrip("/"),
        "model_version": "pipeline" if str(raw.get("model_version") or "vlm").strip().lower() == "pipeline" else "vlm",
        "timeout": max(30, int(raw.get("timeout") or 300)),
    }


def is_enabled(cfg: dict) -> bool:
    return config_of(cfg)["enabled"]


def mode_label(cfg: dict) -> str:
    mc = config_of(cfg)
    if mc["mode"] == "local":
        return f"local:{mc['base_url'] or 'unset'}"
    return f"cloud:{mc['model_version']}"


def _validate_url(url: str) -> None:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise MinerUError(tr("MinerU 服务地址格式不对（需要 http:// 或 https://）"))


def _compat_ssl_context() -> ssl.SSLContext:
    """Fallback TLS context compatible with OpenSSL 3 servers/proxies that omit close_notify."""
    ctx = ssl.create_default_context(cafile=certifi.where())
    ctx.options |= getattr(ssl, "OP_IGNORE_UNEXPECTED_EOF", 0)
    return ctx


def _is_transient_ssl_or_conn(exc: BaseException) -> bool:
    if isinstance(exc, (ssl.SSLError, ConnectionResetError, BrokenPipeError, http_client.HTTPException)):
        return True
    if isinstance(exc, urllib.error.URLError) and isinstance(exc.reason, (ssl.SSLError, ConnectionResetError, BrokenPipeError, OSError)):
        return True
    return False


def _http_request(url: str, method: str = "GET", data: bytes | None = None,
                  headers: dict[str, str] | None = None, timeout: int = 30) -> tuple[int, bytes]:
    last_exc: Exception | None = None
    for attempt in range(3):
        req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
        kwargs: dict = {"timeout": timeout}
        if attempt > 0:
            kwargs["context"] = _compat_ssl_context()
        try:
            with http.urlopen(req, **kwargs) as resp:
                return getattr(resp, "status", 200), resp.read()
        except urllib.error.HTTPError as exc:
            body = b""
            try:
                body = exc.read()
            except Exception:  # noqa: BLE001
                pass
            text = body.decode("utf-8", errors="replace").strip()
            msg = f"HTTP {exc.code}: {text[:250] or exc.reason}"
            if exc.code in (401, 402, 403, 429):
                raise MinerUQuotaError(msg) from exc
            raise MinerUError(msg) from exc
        except TimeoutError as exc:
            last_exc = exc
            if attempt == 2:
                raise MinerUError(f"Timeout: {exc}") from exc
        except urllib.error.URLError as exc:
            last_exc = exc
            if _is_transient_ssl_or_conn(exc) and attempt < 2:
                time.sleep(0.5 * (attempt + 1))
                continue
            raise MinerUError(f"{type(exc.reason).__name__}: {exc.reason}") from exc
        except (ssl.SSLError, http_client.HTTPException, ConnectionResetError) as exc:
            last_exc = exc
            if attempt < 2:
                time.sleep(0.5 * (attempt + 1))
                continue
            raise MinerUError(f"{type(exc).__name__}: {exc}") from exc
    raise MinerUError(f"{type(last_exc).__name__}: {last_exc}")


def _put_presigned(url: str, data: bytes, timeout: int = 120) -> None:
    """Raw HTTP(S) PUT with no auto Content-Type header (urllib adds form-urlencoded -> OSS 403)."""
    parsed = urllib.parse.urlparse(url)
    path = parsed.path + ("?" + parsed.query if parsed.query else "")
    proxies = urllib.request.getproxies()
    proxy_url = proxies.get(parsed.scheme) or proxies.get("https") or proxies.get("http")
    last_exc: Exception | None = None
    for attempt in range(3):
        conn = None
        try:
            ctx = _compat_ssl_context() if attempt > 0 else http._context(
                os.environ.get("SSL_CERT_FILE"), os.environ.get("SSL_CERT_DIR")
            )
            if proxy_url:
                px = urllib.parse.urlparse(proxy_url)
                if px.hostname and px.port:
                    conn = http_client.HTTPSConnection(px.hostname, px.port, timeout=timeout, context=ctx) if parsed.scheme == "https" else http_client.HTTPConnection(px.hostname, px.port, timeout=timeout)
                    conn.set_tunnel(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80))
            if conn is None:
                conn = http_client.HTTPSConnection(parsed.netloc, timeout=timeout, context=ctx) if parsed.scheme == "https" else http_client.HTTPConnection(parsed.netloc, timeout=timeout)
            conn.request("PUT", path, body=data, headers={"Content-Length": str(len(data))})
            resp = conn.getresponse()
            body = resp.read()
            if 200 <= resp.status < 300:
                return
            msg = f"HTTP {resp.status}: {body.decode('utf-8', errors='replace')[:250] or resp.reason}"
            if resp.status in (401, 402, 403, 429):
                raise MinerUQuotaError(msg)
            raise MinerUError(msg)
        except TimeoutError as exc:
            last_exc = exc
        except (ssl.SSLError, http_client.HTTPException, OSError) as exc:
            last_exc = exc
            if attempt < 2:
                time.sleep(0.5 * (attempt + 1))
                continue
            raise MinerUError(f"{type(exc).__name__}: {exc}") from exc
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:  # noqa: BLE001
                    pass
    raise MinerUError(f"{type(last_exc).__name__}: {last_exc}")


def _mini_test_pdf() -> bytes:
    """Build a valid minimal single-page PDF in memory for smoke-parse diagnostics."""
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length 49 >>\nstream\nBT /F1 14 Tf 30 140 Td (Hello MinerU test.) Tj ET\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for idx, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{idx} 0 obj\n".encode("ascii") + body + b"\nendobj\n"
    xref_pos = len(out)
    out += f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode("ascii")
    for off in offsets[1:]:
        out += f"{off:010d} 00000 n \n".encode("ascii")
    out += f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n".encode("ascii")
    return bytes(out)


def _smoke_parse(mc: dict) -> dict:
    """Send a minimal 1-page PDF through the real parser path to surface backend worker/model errors."""
    pdf_bytes = _mini_test_pdf()
    smoke_cfg = {**mc, "timeout": min(mc["timeout"], 60)}
    t0 = time.monotonic()
    try:
        items = _parse_cloud(pdf_bytes, "mineru_probe.pdf", smoke_cfg, None) if mc["mode"] == "cloud" else _parse_local(pdf_bytes, "mineru_probe.pdf", smoke_cfg, None)
        elapsed = round(time.monotonic() - t0, 1)
        return {"ok": True, "message": tr("實測解析成功（耗時 {sec}s，解析出 {n} 個區塊）", sec=elapsed, n=len(items))}
    except MinerUError as exc:
        return {"ok": False, "message": tr("已連上服務，但實測解析失敗：{err}", err=str(exc)[:260])}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "message": tr("已連上服務，但實測解析失敗：{err}", err=f"{type(exc).__name__}: {exc}"[:260])}


def test_connection(mcfg: dict, smoke: bool = False) -> dict:
    """Verify MinerU connectivity and credentials for the Settings test buttons."""
    mc = config_of({"mineru": mcfg})
    if mc["mode"] == "cloud":
        if not mc["token"]:
            return {"ok": False, "message": tr("请先填写 MinerU API Token")}
        headers = {"Authorization": f"Bearer {mc['token']}", "Accept": "*/*"}
        try:
            status, raw = _http_request(f"{CLOUD_BASE}/api/v4/extract-results/batch/0", headers=headers, timeout=20)
            info = json.loads(raw.decode("utf-8", errors="replace") or "{}")
            code = info.get("code")
            msg = str(info.get("msg") or "")
            if code in (401, -10001, -10002) or _QUOTA_ERR_RE.search(msg):
                return {"ok": False, "message": tr("MinerU Token 验证失败：{msg}", msg=msg or f"code {code}")}
            conn_res = {"ok": True, "message": tr("MinerU Cloud 连线成功（{model}）", model=mc["model_version"])}
        except MinerUQuotaError as exc:
            return {"ok": False, "message": tr("MinerU Token 验证失败：{msg}", msg=str(exc)[:180])}
        except MinerUError as exc:
            # HTTP 404 on dummy batch_id after passing gateway auth also confirms reachable + authed.
            if "HTTP 404" in str(exc):
                conn_res = {"ok": True, "message": tr("MinerU Cloud 连线成功（{model}）", model=mc["model_version"])}
            else:
                return {"ok": False, "message": tr("MinerU 连线失败：{msg}", msg=str(exc)[:180])}
        except ValueError:
            return {"ok": False, "message": tr("MinerU 回应格式异常")}
        return _smoke_parse(mc) if smoke else conn_res

    if not mc["base_url"]:
        return {"ok": False, "message": tr("请先填写本机 MinerU 服务地址")}
    try:
        _validate_url(mc["base_url"])
    except MinerUError as exc:
        return {"ok": False, "message": str(exc)}
    headers = {"Authorization": f"Bearer {mc['token']}"} if mc["token"] else {}
    conn_res = None
    for suffix in ("/openapi.json", "/v1/health", "/docs", "/health"):
        try:
            status, raw = _http_request(f"{mc['base_url']}{suffix}", headers=headers, timeout=15)
            if 200 <= status < 300:
                if suffix == "/openapi.json":
                    try:
                        spec = json.loads(raw.decode("utf-8", errors="replace"))
                        paths = spec.get("paths") or {}
                        if "/v1/tasks" in paths:
                            info_str = _probe_local_v1_health(mc["base_url"], headers)
                            label = f"{info_str} /v1/tasks".strip()
                            conn_res = {"ok": True, "message": tr("本机 MinerU 服务连线成功（{label}）", label=label)}
                            break
                        if "/file_parse" in paths:
                            conn_res = {"ok": True, "message": tr("本机 MinerU 服务连线成功")}
                            break
                        conn_res = {"ok": True, "message": tr("已连上服务，但未找到 /v1/tasks 或 /file_parse")}
                        break
                    except ValueError:
                        pass
                conn_res = {"ok": True, "message": tr("本机 MinerU 服务连线成功")}
                break
        except MinerUQuotaError as exc:
            return {"ok": False, "message": tr("本机 MinerU 认证失败：{msg}", msg=str(exc)[:180])}
        except MinerUError:
            continue
    if not conn_res:
        return {"ok": False, "message": tr("无法连上本机 MinerU 服务，请确认服务已启动")}
    return _smoke_parse(mc) if smoke else conn_res


def _probe_local_v1_health(base_url: str, headers: dict[str, str]) -> str:
    parts: list[str] = []
    try:
        status, raw = _http_request(f"{base_url}/v1/health", headers=headers, timeout=10)
        if 200 <= status < 300:
            info = json.loads(raw.decode("utf-8", errors="replace"))
            ver = str(info.get("version") or "").strip()
            dev = str((info.get("runtime") or {}).get("device") or "").strip()
            if ver:
                parts.append(f"v{ver}")
            if dev:
                parts.append(dev)
    except (MinerUError, ValueError):
        pass
    try:
        status, raw = _http_request(f"{base_url}/v1/tiers", headers=headers, timeout=10)
        if 200 <= status < 300:
            tdata = json.loads(raw.decode("utf-8", errors="replace")).get("data") or []
            tiers = [str(item.get("id")) for item in tdata if isinstance(item, dict) and item.get("id")]
            if tiers:
                parts.append("tiers:" + ",".join(tiers))
    except (MinerUError, ValueError):
        pass
    return " ".join(parts)


class _TableParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.head_rows: list[list[tuple[str, int, int]]] = []
        self.body_rows: list[list[tuple[str, int, int]]] = []
        self._in_thead = False
        self._in_tr = False
        self._in_cell = False
        self._cell_is_th = False
        self._cur_row: list[tuple[str, int, int, bool]] = []
        self._colspan = 1
        self._rowspan = 1
        self._buf: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        t = tag.lower()
        if t == "thead":
            self._in_thead = True
        elif t == "tbody":
            self._in_thead = False
        elif t == "tr":
            self._in_tr = True
            self._cur_row = []
        elif t in ("th", "td") and self._in_tr:
            self._in_cell = True
            self._cell_is_th = (t == "th")
            attr_map = {k.lower(): (v or "") for k, v in attrs}
            self._colspan = self._parse_span(attr_map.get("colspan"))
            self._rowspan = self._parse_span(attr_map.get("rowspan"))
            self._buf = []
        elif self._in_cell:
            if t == "br":
                self._buf.append("\n")
            elif t == "sup":
                self._buf.append("$^{")
            elif t == "sub":
                self._buf.append("$_{")

    def handle_endtag(self, tag: str) -> None:
        t = tag.lower()
        if t == "thead":
            self._in_thead = False
        elif t in ("th", "td") and self._in_cell:
            text = _clean_cell_text("".join(self._buf))
            self._cur_row.append((text, self._colspan, self._rowspan, self._cell_is_th))
            self._in_cell = False
            self._buf = []
        elif t == "tr" and self._in_tr:
            self._in_tr = False
            if self._cur_row:
                cells = [(txt, cs, rs) for txt, cs, rs, _ in self._cur_row]
                if self._in_thead or (not self.body_rows and all(is_th for _, _, _, is_th in self._cur_row)):
                    self.head_rows.append(cells)
                else:
                    self.body_rows.append(cells)
            self._cur_row = []
        elif self._in_cell and t in ("sup", "sub"):
            self._buf.append("}$")

    def handle_data(self, data: str) -> None:
        if self._in_cell:
            self._buf.append(data)

    @staticmethod
    def _parse_span(val: str | None) -> int:
        try:
            return max(1, min(64, int(val or 1)))
        except (TypeError, ValueError):
            return 1


def _clean_cell_text(raw: str) -> str:
    lines = [" ".join(part.split()) for part in raw.splitlines()]
    return "\n".join(part for part in lines if part).strip()


def _expand_section_grid(raw_rows: list[list[tuple[str, int, int]]]) -> list[list[str]]:
    if not raw_rows:
        return []
    occupied: dict[tuple[int, int], str] = {}
    max_row = len(raw_rows) - 1
    max_col = 0
    for r, row in enumerate(raw_rows):
        c = 0
        for text, colspan, rowspan in row:
            while (r, c) in occupied:
                c += 1
            for dr in range(rowspan):
                for dc in range(colspan):
                    occupied[(r + dr, c + dc)] = text if (dr == 0 and dc == 0) else ""
            max_row = max(max_row, r + rowspan - 1)
            max_col = max(max_col, c + colspan)
            c += colspan
    return [[occupied.get((r, c), "") for c in range(max_col)] for r in range(max_row + 1)]


def _infer_align(rows: list[list[str]], col_count: int) -> str:
    if col_count <= 0:
        return ""
    align = ["l"]
    num_re = re.compile(r"^[\s+\-±~<>≤≥$%.,()0-9/\\*†‡]+$")
    for c in range(1, col_count):
        vals = [r[c].strip() for r in rows if c < len(r) and r[c].strip()]
        if vals and sum(1 for v in vals if num_re.match(v)) >= len(vals) / 2:
            align.append("r")
        else:
            align.append("l")
    return "".join(align)


def _infer_header_row_count(body_rows: list[list[tuple[str, int, int]]]) -> int:
    if len(body_rows) < 2:
        return 0
    hdr = 1
    if len(body_rows) >= 3:
        # MinerU pipeline omits <thead>/<th>; grouped headers with colspan/rowspan span >= 2 rows.
        max_reach = 0
        r = 0
        while r < hdr and r < len(body_rows) - 1:
            has_colspan = False
            for _, cs, rs in body_rows[r]:
                if cs > 1:
                    has_colspan = True
                if rs > 1:
                    max_reach = max(max_reach, r + rs - 1)
            next_hdr = hdr
            if max_reach >= hdr:
                next_hdr = max(next_hdr, max_reach + 1)
            elif r == 0 and has_colspan:
                next_hdr = max(next_hdr, 2)
            hdr = min(len(body_rows) - 1, next_hdr)
            r += 1
    return hdr


def parse_markdown_table(md_str: str) -> tuple[list[list[str]], list[list[str]], str]:
    """Parse GitHub-flavored Markdown table from MinerU 4.2 structured_content into `(head, rows, align)`."""
    lines = [ln.strip() for ln in (md_str or "").splitlines() if "|" in ln]
    if len(lines) < 2:
        return [], [], ""

    def split_row(ln: str) -> list[str]:
        s = ln.strip()
        if s.startswith("|"):
            s = s[1:]
        if s.endswith("|"):
            s = s[:-1]
        return [_clean_inline_html(c.strip()) for c in s.split("|")]

    sep_re = re.compile(r"^\s*:?-{2,}:?\s*$")
    sep_idx = next((i for i, ln in enumerate(lines) if all(sep_re.match(c) for c in split_row(ln) if c or len(split_row(ln)) == 1)), -1)
    if sep_idx > 0:
        head_raw = [split_row(ln) for ln in lines[:sep_idx]]
        body_raw = [split_row(ln) for ln in lines[sep_idx + 1:]]
    else:
        head_raw = [split_row(lines[0])]
        body_raw = [split_row(ln) for ln in lines[1:]]
    col_count = max([len(r) for r in head_raw] + [len(r) for r in body_raw] + [0])
    if not col_count:
        return [], [], ""
    head = [r + [""] * (col_count - len(r)) for r in head_raw]
    rows = [r + [""] * (col_count - len(r)) for r in body_raw]
    return head, rows, _infer_align(rows, col_count)


def _parse_table_body(body_str: str) -> tuple[list[list[str]], list[list[str]], str]:
    low = (body_str or "").lower()
    if "<table" in low or "<tr" in low:
        return parse_html_table(body_str)
    if "|" in (body_str or "") and "---" in (body_str or ""):
        return parse_markdown_table(body_str)
    return [], [], ""


def parse_html_table(html_str: str) -> tuple[list[list[str]], list[list[str]], str]:
    """Parse MinerU HTML table into `(head, rows, align)` with expanded spans."""
    parser = _TableParser()
    parser.feed(html_str or "")
    parser.close()

    if parser.head_rows:
        head = _expand_section_grid(parser.head_rows)
        rows = _expand_section_grid(parser.body_rows)
    else:
        hdr_n = _infer_header_row_count(parser.body_rows)
        head = _expand_section_grid(parser.body_rows[:hdr_n])
        rows = _expand_section_grid(parser.body_rows[hdr_n:])
    col_count = max([len(r) for r in head] + [len(r) for r in rows] + [0])
    if col_count:
        head = [r + [""] * (col_count - len(r)) for r in head]
        rows = [r + [""] * (col_count - len(r)) for r in rows]
    align = _infer_align(rows, col_count)
    return head, rows, align


def _slice_pdf_bytes(pdf_path: Path, pages_1based: list[int], total_pages: int) -> tuple[bytes, dict[int, int]]:
    """Slice `pdf_path` to `pages_1based` if subset; return `(pdf_bytes, page_idx -> pdf_page_1based)`."""
    if not pages_1based or (total_pages and len(pages_1based) == total_pages and pages_1based == list(range(1, total_pages + 1))):
        return pdf_path.read_bytes(), {n - 1: n for n in pages_1based}
    try:
        from pypdf import PdfReader, PdfWriter

        reader = PdfReader(str(pdf_path))
        writer = PdfWriter()
        idx_map: dict[int, int] = {}
        valid_total = len(reader.pages)
        for out_idx, p in enumerate(pages_1based):
            if 1 <= p <= valid_total:
                writer.add_page(reader.pages[p - 1])
                idx_map[len(idx_map)] = p
        if not idx_map:
            return pdf_path.read_bytes(), {n - 1: n for n in pages_1based}
        buf = io.BytesIO()
        writer.write(buf)
        return buf.getvalue(), idx_map
    except Exception:  # noqa: BLE001
        return pdf_path.read_bytes(), {n - 1: n for n in pages_1based}


def _structured_content_to_content_list(doc: dict) -> list[dict]:
    """Convert MinerU 4.2 `structured_content.json` (`pages[] -> blocks[]`) into standard `content_list`."""
    out: list[dict] = []
    for pg in doc.get("pages") or []:
        if not isinstance(pg, dict):
            continue
        p_idx = int(pg.get("page_idx", 0))
        for b in pg.get("blocks") or []:
            if not isinstance(b, dict):
                continue
            btype = str(b.get("type") or "").lower()
            bbox = b.get("bbox")
            content = b.get("content")
            if btype in ("header", "footer", "page_number", "aside_text", "discarded"):
                continue
            if btype in ("doc_title", "paragraph_title", "title", "section_title"):
                lvl = int(b.get("level") or (1 if btype == "doc_title" else 2))
                txt = str(content or "").strip()
                if txt:
                    out.append({"type": "text", "text_level": lvl, "text": txt, "page_idx": p_idx, "bbox": bbox})
            elif btype in ("text", "abstract", "list_item"):
                if isinstance(content, list):
                    txt = " ".join(str(x.get("content") or x) if isinstance(x, dict) else str(x) for x in content).strip()
                else:
                    txt = str(content or "").strip()
                if txt:
                    if b.get("continues_prev") and out and out[-1].get("page_idx") == p_idx and out[-1].get("type") == "text" and out[-1].get("text_level", 0) == 0:
                        prev_txt = out[-1]["text"]
                        out[-1]["text"] = (prev_txt[:-1] + txt) if (prev_txt.endswith("-") and not prev_txt.endswith("--")) else (prev_txt.rstrip() + " " + txt.lstrip())
                        continue
                    # Attach loose standalone "Table N." / "Figure N." block right after an uncaptioned table/figure.
                    if out and out[-1].get("page_idx") == p_idx and _CAP_NUM_RE.match(txt):
                        prev = out[-1]
                        if prev.get("type") == "table" and not _flatten_text_list(prev.get("table_caption")):
                            prev["table_caption"] = [txt]
                            continue
                        if prev.get("type") == "image" and not _flatten_text_list(prev.get("image_caption")):
                            prev["image_caption"] = [txt]
                            continue
                    item_out = {"type": "text", "text_level": 0, "text": txt, "page_idx": p_idx, "bbox": bbox}
                    if b.get("continues_prev"):
                        item_out["continues_prev"] = True
                    out.append(item_out)
            elif btype in ("image", "figure", "chart"):
                out.append({
                    "type": "image",
                    "image_caption": b.get("captions") or [],
                    "image_footnote": b.get("footnotes") or [],
                    "page_idx": p_idx,
                    "bbox": bbox,
                })
            elif btype == "table":
                out.append({
                    "type": "table",
                    "table_caption": b.get("captions") or [],
                    "table_footnote": b.get("footnotes") or [],
                    "table_body": str(content or ""),
                    "page_idx": p_idx,
                    "bbox": bbox,
                })
            elif btype in ("equation", "interline_equation", "formula", "display_formula"):
                txt = str(content or "").strip()
                if txt:
                    out.append({"type": "interline_equation", "text": txt, "page_idx": p_idx, "bbox": bbox})
            elif btype == "page_footnote":
                txt = str(content or "").strip()
                if txt:
                    out.append({"type": "page_footnote", "text": txt, "page_idx": p_idx, "bbox": bbox})
            elif btype == "list":
                items = content if isinstance(content, list) else (b.get("items") or [])
                out.append({"type": "list", "list_items": items, "sub_type": b.get("sub_type", ""), "page_idx": p_idx, "bbox": bbox})
            elif btype in ("code", "algorithm"):
                out.append({"type": "code", "code_body": str(content or ""), "code_caption": b.get("captions") or [], "page_idx": p_idx, "bbox": bbox})
    return out


def _extract_zip_content_list(zip_bytes: bytes) -> list[dict]:
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        znames = zf.namelist()
        names = [n for n in znames if n.endswith("_content_list.json") and not n.endswith("_content_list_v2.json")]
        if not names:
            names = [n for n in znames if n.endswith("content_list.json")]
        if names:
            raw = zf.read(names[0]).decode("utf-8", errors="replace")
            data = json.loads(raw)
            if not isinstance(data, list):
                raise MinerUError(tr("MinerU content_list.json 格式异常"))
            return data
        for candidate in ("structured_content.json", "middle_json.json"):
            hit = next((n for n in znames if n.endswith(candidate)), None)
            if hit:
                payload = json.loads(zf.read(hit).decode("utf-8", errors="replace"))
                if isinstance(payload, dict) and isinstance(payload.get("pages"), list):
                    return _structured_content_to_content_list(payload)
                if isinstance(payload, dict) and isinstance(payload.get("pdf_info"), list):
                    return _middle_json_to_content_list(payload)
        raise MinerUError(tr("MinerU 压缩包内找不到 content_list.json"))


def _parse_cloud(pdf_bytes: bytes, pdf_name: str, mc: dict, cancel) -> list[dict]:
    if not mc["token"]:
        raise MinerUQuotaError(tr("MinerU API Token 未填写"))
    auth_headers = {
        "Authorization": f"Bearer {mc['token']}",
        "Content-Type": "application/json",
        "Accept": "*/*",
    }
    payload = {
        "enable_formula": True,
        "enable_table": True,
        "language": "en",
        "model_version": mc["model_version"],
        "files": [{"name": pdf_name, "is_ocr": False, "data_id": uuid.uuid4().hex[:12]}],
    }
    _, raw = _http_request(
        f"{CLOUD_BASE}/api/v4/file-urls/batch",
        method="POST",
        data=json.dumps(payload).encode("utf-8"),
        headers=auth_headers,
        timeout=30,
    )
    resp = json.loads(raw.decode("utf-8", errors="replace"))
    if resp.get("code") != 0:
        msg = str(resp.get("msg") or f"code {resp.get('code')}")
        if _QUOTA_ERR_RE.search(msg):
            raise MinerUQuotaError(msg)
        raise MinerUError(msg)
    data = resp.get("data") or {}
    batch_id = data.get("batch_id")
    file_urls = data.get("file_urls") or []
    if not batch_id or not file_urls:
        raise MinerUError(tr("MinerU 未返回上传链接"))

    # Pre-signed OSS URL must NOT receive extra Content-Type or Authorization headers (otherwise 403).
    _put_presigned(file_urls[0], pdf_bytes, timeout=max(60, mc["timeout"] // 2))

    deadline = time.monotonic() + mc["timeout"]
    poll_headers = {"Authorization": f"Bearer {mc['token']}", "Accept": "*/*"}
    while time.monotonic() < deadline:
        if cancel and cancel.is_set():
            raise engines.Cancelled()
        _, poll_raw = _http_request(
            f"{CLOUD_BASE}/api/v4/extract-results/batch/{urllib.parse.quote(str(batch_id))}",
            headers=poll_headers,
            timeout=30,
        )
        poll = json.loads(poll_raw.decode("utf-8", errors="replace"))
        if poll.get("code") != 0:
            msg = str(poll.get("msg") or f"code {poll.get('code')}")
            if _QUOTA_ERR_RE.search(msg):
                raise MinerUQuotaError(msg)
            raise MinerUError(msg)
        results = (poll.get("data") or {}).get("extract_result") or []
        if results:
            item = results[0]
            state = item.get("state")
            if state == "done":
                zip_url = item.get("full_zip_url")
                if not zip_url:
                    raise MinerUError(tr("MinerU 解析完成但缺少下载链接"))
                _, zip_bytes = _http_request(zip_url, timeout=60)
                return _extract_zip_content_list(zip_bytes)
            if state == "failed":
                err = str(item.get("err_msg") or "MinerU extraction failed")
                if _QUOTA_ERR_RE.search(err):
                    raise MinerUQuotaError(err)
                raise MinerUError(err)
        time.sleep(_POLL_INTERVAL)
    raise MinerUError(tr("MinerU 云端解析超时"))


def _encode_multipart(fields: dict[str, str], files: list[tuple[str, str, bytes, str]]) -> tuple[bytes, str]:
    boundary = f"----PaperReadMinerU{uuid.uuid4().hex}"
    chunks: list[bytes] = []
    for k, v in fields.items():
        chunks.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode("utf-8"))
    for field_name, filename, content, ctype in files:
        chunks.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{field_name}\"; filename=\"{filename}\"\r\n"
            f"Content-Type: {ctype}\r\n\r\n".encode("utf-8")
        )
        chunks.append(content)
        chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode("utf-8"))
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def _middle_lines_text(block: dict) -> str:
    parts: list[str] = []
    for line in block.get("lines") or []:
        if not isinstance(line, dict):
            continue
        segs: list[str] = []
        for span in line.get("spans") or []:
            if not isinstance(span, dict):
                continue
            st = str(span.get("type") or "").lower()
            txt = str(span.get("content") or "")
            if not txt:
                continue
            if st == "inline_equation":
                segs.append(f"${txt}$")
            else:
                segs.append(txt)
        line_str = " ".join(segs).strip()
        if line_str:
            parts.append(line_str)
    return " ".join(parts).strip()


def _middle_bbox(bbox, page_size) -> list[float] | None:
    if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
        return None
    if isinstance(page_size, (list, tuple)) and len(page_size) == 2 and page_size[0] and page_size[1]:
        pw, ph = float(page_size[0]), float(page_size[1])
        return [
            round(float(bbox[0]) * 1000.0 / pw, 2),
            round(float(bbox[1]) * 1000.0 / ph, 2),
            round(float(bbox[2]) * 1000.0 / pw, 2),
            round(float(bbox[3]) * 1000.0 / ph, 2),
        ]
    return [float(v) for v in bbox]


def _middle_json_to_content_list(data: dict) -> list[dict]:
    """Convert MinerU v1 Middle JSON (`pdf_info`) into standard `content_list` items."""
    out: list[dict] = []
    for pg in data.get("pdf_info") or []:
        if not isinstance(pg, dict):
            continue
        p_idx = int(pg.get("page_idx", 0))
        psize = pg.get("page_size")
        blocks = pg.get("para_blocks") or pg.get("preproc_blocks") or []
        for b in blocks:
            if not isinstance(b, dict):
                continue
            btype = str(b.get("type") or "").lower()
            bbox = _middle_bbox(b.get("bbox"), psize)
            if btype in ("header", "footer", "page_number", "aside_text", "discarded"):
                continue
            if btype == "title":
                txt = _middle_lines_text(b)
                if txt:
                    out.append({"type": "text", "text_level": int(b.get("level") or 1), "text": txt, "page_idx": p_idx, "bbox": bbox})
            elif btype in ("text", "list_item"):
                txt = _middle_lines_text(b)
                if txt:
                    out.append({"type": "text", "text_level": 0, "text": txt, "page_idx": p_idx, "bbox": bbox})
            elif btype == "list":
                sub_items = [_middle_lines_text(sub) for sub in (b.get("blocks") or []) if isinstance(sub, dict)]
                sub_items = [s for s in sub_items if s]
                if not sub_items:
                    txt = _middle_lines_text(b)
                    if txt:
                        sub_items = [txt]
                if sub_items:
                    out.append({"type": "list", "list_items": sub_items, "sub_type": b.get("sub_type", ""), "page_idx": p_idx, "bbox": bbox})
            elif btype == "interline_equation":
                txt = _middle_lines_text(b)
                if not txt:
                    spans = [str(sp.get("content") or "") for ln in (b.get("lines") or []) for sp in (ln.get("spans") or [])]
                    txt = " ".join(s for s in spans if s).strip()
                if txt:
                    out.append({"type": "interline_equation", "text": txt, "page_idx": p_idx, "bbox": bbox})
            elif btype == "table":
                sub_blocks = b.get("blocks") or []
                cap, foot, body_html = [], [], ""
                body_bbox = bbox
                for sb in sub_blocks:
                    if not isinstance(sb, dict):
                        continue
                    sbt = str(sb.get("type") or "").lower()
                    if sbt == "table_caption":
                        t = _middle_lines_text(sb)
                        if t:
                            cap.append(t)
                    elif sbt == "table_footnote":
                        t = _middle_lines_text(sb)
                        if t:
                            foot.append(t)
                    elif sbt == "table_body":
                        body_bbox = _middle_bbox(sb.get("bbox"), psize) or body_bbox
                        for ln in sb.get("lines") or []:
                            for sp in ln.get("spans") or []:
                                if sp.get("html"):
                                    body_html = str(sp["html"])
                out.append({
                    "type": "table", "table_caption": cap, "table_footnote": foot,
                    "table_body": body_html, "page_idx": p_idx, "bbox": body_bbox,
                })
            elif btype == "image":
                sub_blocks = b.get("blocks") or []
                cap, foot = [], []
                body_bbox = bbox
                for sb in sub_blocks:
                    if not isinstance(sb, dict):
                        continue
                    sbt = str(sb.get("type") or "").lower()
                    if sbt == "image_caption":
                        t = _middle_lines_text(sb)
                        if t:
                            cap.append(t)
                    elif sbt == "image_footnote":
                        t = _middle_lines_text(sb)
                        if t:
                            foot.append(t)
                    elif sbt == "image_body":
                        body_bbox = _middle_bbox(sb.get("bbox"), psize) or body_bbox
                out.append({"type": "image", "image_caption": cap, "image_footnote": foot, "page_idx": p_idx, "bbox": body_bbox})
            elif btype == "page_footnote":
                txt = _middle_lines_text(b)
                if txt:
                    out.append({"type": "page_footnote", "text": txt, "page_idx": p_idx, "bbox": bbox})
            elif btype == "code":
                sub_blocks = b.get("blocks") or []
                cap, body = [], ""
                for sb in sub_blocks:
                    if not isinstance(sb, dict):
                        continue
                    sbt = str(sb.get("type") or "").lower()
                    if sbt == "code_caption":
                        t = _middle_lines_text(sb)
                        if t:
                            cap.append(t)
                    elif sbt == "code_body":
                        body = "\n".join(str(sp.get("content") or "") for ln in (sb.get("lines") or []) for sp in (ln.get("spans") or []))
                if not body:
                    body = _middle_lines_text(b)
                if body:
                    out.append({"type": "code", "code_caption": cap, "code_body": body, "page_idx": p_idx, "bbox": bbox})
    return out


def _extract_local_content_list(resp: object) -> list[dict]:
    if isinstance(resp, list):
        return resp
    if not isinstance(resp, dict):
        raise MinerUError(tr("本机 MinerU 返回格式异常"))
    if isinstance(resp.get("pages"), list):
        return _structured_content_to_content_list(resp)
    if isinstance(resp.get("pdf_info"), list):
        return _middle_json_to_content_list(resp)
    cl = resp.get("content_list")
    if isinstance(cl, str):
        cl = json.loads(cl)
    if isinstance(cl, list):
        return cl
    results = resp.get("results")
    if isinstance(results, dict):
        for val in results.values():
            if not isinstance(val, dict):
                continue
            item_cl = val.get("content_list")
            if isinstance(item_cl, str):
                item_cl = json.loads(item_cl)
            if isinstance(item_cl, list):
                return item_cl
            if isinstance(val.get("middle_json"), dict) and isinstance(val["middle_json"].get("pdf_info"), list):
                return _middle_json_to_content_list(val["middle_json"])
    raise MinerUError(tr("本机 MinerU 返回中找不到 content_list"))


def _local_api_flavor(base_url: str, headers: dict[str, str]) -> str:
    try:
        status, raw = _http_request(f"{base_url}/openapi.json", headers=headers, timeout=10)
        if 200 <= status < 300:
            paths = (json.loads(raw.decode("utf-8", errors="replace")).get("paths") or {})
            if "/v1/tasks" in paths and "/file_parse" not in paths:
                return "v1_tasks"
    except (MinerUError, ValueError):
        pass
    return "file_parse"


def _parse_local_v1_tasks(pdf_bytes: bytes, pdf_name: str, mc: dict, cancel) -> list[dict]:
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if mc["token"]:
        headers["Authorization"] = f"Bearer {mc['token']}"
    body = {
        "files": [{"file_name": pdf_name, "bytes": len(pdf_bytes)}],
        "output_formats": ["default"],
        "ocr_mode": "auto",
    }
    _, raw = _http_request(
        f"{mc['base_url']}/v1/tasks",
        method="POST",
        data=json.dumps(body).encode("utf-8"),
        headers=headers,
        timeout=30,
    )
    created = json.loads(raw.decode("utf-8", errors="replace"))
    task_id = created.get("task_id")
    files = created.get("files") or []
    if not task_id or not files:
        raise MinerUError(tr("本机 MinerU 未返回任务或上传信息"))
    up = files[0].get("upload") or {}
    up_url = urllib.parse.urljoin(mc["base_url"] + "/", str(up.get("url") or ""))
    if not up_url:
        raise MinerUError(tr("本机 MinerU 未返回上传链接"))
    up_headers = dict(up.get("headers") or {"Content-Type": "application/octet-stream"})
    if mc["token"]:
        up_headers.setdefault("Authorization", f"Bearer {mc['token']}")
    _http_request(up_url, method="PUT", data=pdf_bytes, headers=up_headers, timeout=max(60, mc["timeout"] // 2))

    poll_headers = {"Accept": "application/json"}
    if mc["token"]:
        poll_headers["Authorization"] = f"Bearer {mc['token']}"
    deadline = time.monotonic() + mc["timeout"]
    while time.monotonic() < deadline:
        if cancel and cancel.is_set():
            raise engines.Cancelled()
        _, poll_raw = _http_request(f"{mc['base_url']}/v1/tasks/{urllib.parse.quote(str(task_id))}", headers=poll_headers, timeout=30)
        st = json.loads(poll_raw.decode("utf-8", errors="replace"))
        status = st.get("status")
        f_detail = (st.get("files") or [{}])[0]
        if status in ("completed", "partial") or f_detail.get("status") == "completed":
            rurl = f_detail.get("result_url")
            if not rurl:
                raise MinerUError(tr("本机 MinerU 解析完成但缺少结果链接"))
            full_rurl = urllib.parse.urljoin(mc["base_url"] + "/", str(rurl))
            _, res_bytes = _http_request(full_rurl, headers=poll_headers, timeout=60)
            if res_bytes[:2] == b"PK":
                return _extract_zip_content_list(res_bytes)
            return _extract_local_content_list(json.loads(res_bytes.decode("utf-8", errors="replace")))
        if status in ("failed", "canceled") or f_detail.get("status") in ("failed", "canceled"):
            err = f_detail.get("error") or st.get("error") or {}
            msg = f"{err.get('code', 'failed')}: {err.get('message', 'MinerU task failed')}".strip(": ")
            if _QUOTA_ERR_RE.search(msg):
                raise MinerUQuotaError(msg)
            raise MinerUError(msg)
        time.sleep(_POLL_INTERVAL)
    raise MinerUError(tr("本机 MinerU 解析超时"))


def _parse_local(pdf_bytes: bytes, pdf_name: str, mc: dict, cancel) -> list[dict]:
    if cancel and cancel.is_set():
        raise engines.Cancelled()
    _validate_url(mc["base_url"])
    auth = {"Authorization": f"Bearer {mc['token']}"} if mc["token"] else {}
    if _local_api_flavor(mc["base_url"], auth) == "v1_tasks":
        return _parse_local_v1_tasks(pdf_bytes, pdf_name, mc, cancel)
    fields = {
        "return_content_list": "true",
        "return_middle_json": "false",
        "return_md": "false",
        "parse_method": "auto",
        "lang_list": "en",
        "formula_enable": "true",
        "table_enable": "true",
    }
    body, content_type = _encode_multipart(fields, [("files", pdf_name, pdf_bytes, "application/pdf")])
    headers = {"Content-Type": content_type, "Accept": "application/json", **auth}
    _, raw = _http_request(f"{mc['base_url']}/file_parse", method="POST", data=body, headers=headers, timeout=mc["timeout"])
    resp = json.loads(raw.decode("utf-8", errors="replace"))
    return _extract_local_content_list(resp)


def _pdf_identity(ws: Workspace, mc: dict) -> dict:
    try:
        st = ws.source_pdf.stat()
        sig = f"{st.st_size}:{st.st_mtime_ns}"
    except OSError:
        sig = "missing"
    return {"sig": sig, "mode": mc["mode"], "model_version": mc["model_version"]}


def parse_pdf_pages(ws: Workspace, cfg: dict, pages: list[int], cancel) -> dict[int, list[dict]]:
    """Parse requested 1-based pages using MinerU (with extract/mineru_pages.json caching)."""
    mc = config_of(cfg)
    cache_path = ws.root / "extract" / _CACHE_FILE
    ident = _pdf_identity(ws, mc)
    cached = read_json(cache_path, {}) or {}
    if cached.get("identity") != ident:
        cached = {"identity": ident, "pages": {}}
    stored_pages: dict[str, list[dict]] = dict(cached.get("pages") or {})

    missing = sorted({p for p in pages if str(p) not in stored_pages})
    if missing:
        paper = ws.load("paper") or {}
        total_pages = paper.get("meta", {}).get("page_count") or 0
        pdf_bytes, idx_map = _slice_pdf_bytes(ws.source_pdf, missing, total_pages)
        pdf_name = ws.source_pdf.name or "paper.pdf"
        items = _parse_cloud(pdf_bytes, pdf_name, mc, cancel) if mc["mode"] == "cloud" else _parse_local(pdf_bytes, pdf_name, mc, cancel)

        grouped: dict[int, list[dict]] = {p: [] for p in missing}
        for item in items:
            if not isinstance(item, dict):
                continue
            raw_idx = item.get("page_idx", 0)
            try:
                idx_int = int(raw_idx)
            except (TypeError, ValueError):
                continue
            real_page = idx_map.get(idx_int, idx_int + 1)
            if real_page in grouped:
                grouped[real_page].append(item)
        for p, page_items in grouped.items():
            if page_items:
                stored_pages[str(p)] = page_items
        write_json_atomic(cache_path, {"identity": ident, "pages": stored_pages})

    return {p: list(stored_pages.get(str(p)) or []) for p in pages}


def _normalize_bbox(bbox, page_w: float | None = None, page_h: float | None = None) -> list[float] | None:
    if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
        return None
    try:
        x0, y0, x1, y1 = [float(v) for v in bbox]
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(v) for v in (x0, y0, x1, y1)):
        return None
    hi = max(abs(x0), abs(y0), abs(x1), abs(y1))
    if hi <= 1.05:
        coords = [x0, y0, x1, y1]
    elif hi <= 1000.5:
        coords = [x0 / 1000.0, y0 / 1000.0, x1 / 1000.0, y1 / 1000.0]
    elif page_w and page_h and page_w > 0 and page_h > 0:
        coords = [x0 / page_w, y0 / page_h, x1 / page_w, y1 / page_h]
    else:
        coords = [x0 / 1000.0, y0 / 1000.0, x1 / 1000.0, y1 / 1000.0]
    return figure_box(coords)


def _strip_tex_delimiters(tex: str) -> tuple[str, str]:
    s = tex.strip()
    if s.startswith("$$") and s.endswith("$$") and len(s) >= 4:
        s = s[2:-2].strip()
    elif s.startswith("\\[") and s.endswith("\\]") and len(s) >= 4:
        s = s[2:-2].strip()
    elif s.startswith("$") and s.endswith("$") and len(s) >= 2:
        s = s[1:-1].strip()
    tag = ""
    m = _EQ_TAG_RE.search(s)
    if m:
        tag = (m.group(1) or m.group(2) or "").strip()
        s = s[:m.start()].strip()
    return s, tag


def _split_heading_num(text: str) -> tuple[str, str]:
    m = _NUM_HEAD_RE.match(text)
    if not m:
        return "", text.strip()
    num = m.group(1).rstrip(".")
    return num, m.group(2).strip()


def _cap_num(caption: str) -> str:
    m = _CAP_NUM_RE.match(caption or "")
    return m.group(1) if m else ""


def _unique_id(prefix: str, taken: set[str]) -> str:
    if prefix not in taken:
        taken.add(prefix)
        return prefix
    i = 2
    while f"{prefix}-{i}" in taken:
        i += 1
    ident = f"{prefix}-{i}"
    taken.add(ident)
    return ident


def _has_text_to_lose(ws: Workspace, page_n: int) -> bool:
    txt_file = ws.root / "extract" / f"page-{page_n:03d}.txt"
    if not txt_file.is_file():
        return False
    letters = re.sub(r"[^A-Za-z0-9]", "", txt_file.read_text(encoding="utf-8", errors="replace"))
    return len(letters) >= 40


def _caption_kind(text: str) -> str | None:
    if _FIG_CAP_RE.match(text or ""):
        return "figure"
    if _TAB_CAP_RE.match(text or ""):
        return "table"
    return None


def _overlap_1d(a0: float, a1: float, b0: float, b1: float) -> float:
    return max(0.0, min(a1, b1) - max(a0, b0))


def _reconcile_page_floats(items: list[dict], pw: float | None, ph: float | None) -> list[dict]:
    """Fix MinerU cross-type/multi-packed captions, merge split sub-figures, and re-pair by bbox."""
    import itertools

    work = [dict(it) if isinstance(it, dict) else it for it in items]

    def _norm(raw_box):
        return _normalize_bbox(raw_box, pw, ph)

    def _cap_entries(val) -> list[tuple[str | None, list[float] | None, str]]:
        out: list[tuple[str | None, list[float] | None, str]] = []
        seq = val if isinstance(val, list) else ([val] if val else [])
        for x in seq:
            if isinstance(x, dict):
                txt = str(x.get("content") or x.get("text") or "").strip()
                cbox = _norm(x.get("bbox"))
            else:
                txt = str(x or "").strip()
                cbox = None
            if txt:
                out.append((_caption_kind(txt), cbox, txt))
        return out

    # 1. Merge consecutive split sub-figures (side-by-side or vertically stacked in same column).
    merged: list[dict] = []
    for it in work:
        if not isinstance(it, dict):
            merged.append(it)
            continue
        itype = str(it.get("type") or "").lower()
        if itype in ("image", "figure") and merged and str(merged[-1].get("type") or "").lower() in ("image", "figure"):
            prev = merged[-1]
            p_caps = _cap_entries(prev.get("image_caption") or prev.get("img_caption") or prev.get("caption"))
            c_caps = _cap_entries(it.get("image_caption") or it.get("img_caption") or it.get("caption"))
            p_has_num = any(k == "figure" for k, _, _ in p_caps)
            c_has_num = any(k == "figure" for k, _, _ in c_caps)
            pb, cb = _norm(prev.get("bbox")), _norm(it.get("bbox"))
            if not p_has_num and c_has_num and pb and cb:
                y_ov = _overlap_1d(pb[1], pb[3], cb[1], cb[3])
                x_ov = _overlap_1d(pb[0], pb[2], cb[0], cb[2])
                min_h = max(1e-4, min(pb[3] - pb[1], cb[3] - cb[1]))
                min_w = max(1e-4, min(pb[2] - pb[0], cb[2] - cb[0]))
                h_gap = max(cb[0] - pb[2], pb[0] - cb[2], 0.0)
                v_gap = cb[1] - pb[3]
                side_by_side = y_ov >= 0.4 * min_h and h_gap <= 0.12
                stacked = x_ov >= 0.5 * min_w and -0.02 <= v_gap <= 0.12
                if side_by_side or stacked:
                    prev["bbox"] = [min(pb[0], cb[0]), min(pb[1], cb[1]), max(pb[2], cb[2]), max(pb[3], cb[3])]
                    numbered_only = [{"bbox": box, "content": txt} if box else txt for k, box, txt in c_caps if k == "figure"]
                    prev["image_caption"] = numbered_only or (it.get("image_caption") or it.get("img_caption") or it.get("caption") or [])
                    prev.pop("img_caption", None)
                    prev["image_footnote"] = (prev.get("image_footnote") or []) + (it.get("image_footnote") or it.get("img_footnote") or [])
                    continue
        merged.append(it)

    # 2. Extract misplaced/multi-packed/standalone numbered captions and re-pair per kind by bbox.
    float_idxs: dict[str, list[int]] = {"figure": [], "table": []}
    pool: dict[str, list[tuple[int, list[float] | None, str]]] = {"figure": [], "table": []}
    drop_text_idxs: set[int] = set()

    for idx, it in enumerate(merged):
        if not isinstance(it, dict):
            continue
        itype = str(it.get("type") or "").lower()
        if itype in ("image", "figure"):
            fkind = "figure"
            raw_caps = it.get("image_caption") or it.get("img_caption") or it.get("caption")
        elif itype == "table":
            fkind = "table"
            raw_caps = it.get("table_caption") or it.get("caption")
        elif itype == "text" and int(it.get("text_level") or 0) == 0:
            txt = _clean_inline_html(" ".join(str(it.get("text") or "").split()).strip())
            ck = _caption_kind(txt)
            if ck:
                pool[ck].append((idx, _norm(it.get("bbox")), txt))
                drop_text_idxs.add(idx)
            continue
        else:
            continue

        float_idxs[fkind].append(idx)
        entries = _cap_entries(raw_caps)
        num_same = [e for e in entries if e[0] == fkind]
        wrong = [e for e in entries if e[0] and e[0] != fkind]
        if wrong or len(num_same) > 1 or num_same:
            # Pull all numbered captions into the page pool so 1-to-1 matching can resolve swaps.
            kept_unnumbered = [{"bbox": box, "content": txt} if box else txt for k, box, txt in entries if k is None]
            for k, box, txt in entries:
                if k in pool:
                    pool[k].append((idx, box, txt))
            if fkind == "figure":
                it["image_caption"] = kept_unnumbered
                it.pop("img_caption", None)
            else:
                it["table_caption"] = kept_unnumbered

    for fkind in ("figure", "table"):
        f_list = float_idxs[fkind]
        c_list = pool[fkind]
        if not f_list or not c_list:
            # Restore any standalone text blocks that couldn't match a float of their kind.
            for src_idx, _, _ in c_list:
                drop_text_idxs.discard(src_idx)
            continue

        def _cost(fi: int, ci: int) -> float:
            fbox = _norm(merged[fi].get("bbox"))
            csrc_idx, cbox, _ = c_list[ci]
            if fbox and cbox:
                x_ov = _overlap_1d(fbox[0], fbox[2], cbox[0], cbox[2])
                min_w = max(1e-4, min(fbox[2] - fbox[0], cbox[2] - cbox[0]))
                col_pen = 0.0 if x_ov >= 0.25 * min_w else 1.5
                dy = max(cbox[1] - fbox[3], fbox[1] - cbox[3], 0.0)
                return col_pen + dy
            return 0.05 * abs(fi - csrc_idx)

        n_f, n_c = len(f_list), len(c_list)
        best_pairs: list[tuple[int, int]] = []
        if n_f <= 7 and n_c <= 7:
            best_score = float("inf")
            k = min(n_f, n_c)
            for f_sub in itertools.combinations(range(n_f), k):
                for c_perm in itertools.permutations(range(n_c), k):
                    sc = sum(_cost(f_list[fi], ci) for fi, ci in zip(f_sub, c_perm))
                    if sc < best_score:
                        best_score = sc
                        best_pairs = list(zip(f_sub, c_perm))
        else:
            edges = sorted((_cost(f_list[fi], ci), fi, ci) for fi in range(n_f) for ci in range(n_c))
            used_f, used_c = set(), set()
            for _, fi, ci in edges:
                if fi not in used_f and ci not in used_c:
                    used_f.add(fi)
                    used_c.add(ci)
                    best_pairs.append((fi, ci))

        for fi, ci in best_pairs:
            target_it = merged[f_list[fi]]
            _, cbox, ctxt = c_list[ci]
            fbox = _norm(target_it.get("bbox"))
            if fbox and cbox and cbox[3] <= fbox[1] + 0.01:
                target_it["_caption_pos"] = "above"
            cap_val = {"bbox": cbox, "content": ctxt} if cbox else ctxt
            if fkind == "figure":
                cur = list(target_it.get("image_caption") or [])
                target_it["image_caption"] = cur + [cap_val]
            else:
                cur = list(target_it.get("table_caption") or [])
                target_it["table_caption"] = cur + [cap_val]

        # If a standalone text caption wasn't matched to any float, keep it as text.
        matched_c = {ci for _, ci in best_pairs}
        for ci, (src_idx, _, _) in enumerate(c_list):
            if ci not in matched_c:
                drop_text_idxs.discard(src_idx)

    return [it for i, it in enumerate(merged) if i not in drop_text_idxs]


def extract_to_workspace(
    ws: Workspace,
    cfg: dict,
    pages: list[int],
    total_pages: int,
    cancel,
    split_pages: dict[int, dict[str, str]] | None = None,
    ref_plan: local_references.PagePlan | None = None,
) -> tuple[list[int], dict]:
    """Run MinerU extraction on `pages`, build en_only blocks + 3x figure crops, and return `(ok_pages, data)`."""
    if not pages:
        return [], {"blocks": [], "references": []}
    by_page = parse_pdf_pages(ws, cfg, pages, cancel)
    paper = ws.load("paper") or {}
    target = langs.of_paper(paper.get("meta"), cfg)
    dims = {p.get("n"): (p.get("w"), p.get("h")) for p in (paper.get("meta") or {}).get("pages", []) if isinstance(p, dict)}
    taken = {
        b.get("id") for b in paper.get("blocks", [])
        if b.get("id") and b.get("page") not in set(pages)
    }

    blocks: list[dict] = []
    references: list[dict] = []
    meta_out: dict[str, str] = {}
    ok_pages: list[int] = []
    split_set = set(split_pages or {})

    for page_n in pages:
        items = by_page.get(page_n) or []
        if not items:
            continue
        pw, ph = dims.get(page_n, (None, None))
        items = _reconcile_page_floats(items, pw, ph)
        page_blocks: list[dict] = []
        seq = {"para": 0, "heading": 0, "math": 0, "table": 0, "figure": 0, "list": 0}
        in_abstract = False
        in_refs_slice = False
        has_app_on_page = page_n in split_set and bool(split_pages[page_n].get("prose_after"))

        for item in items:
            if not isinstance(item, dict):
                continue
            itype = str(item.get("type") or "").lower()
            if itype in ("header", "footer", "page_number", "aside_text", "discarded"):
                continue

            if itype == "text":
                raw_txt = _clean_inline_html(" ".join(str(item.get("text") or "").split()).strip())
                if not raw_txt:
                    continue
                level_raw = item.get("text_level")
                try:
                    text_level = int(level_raw) if level_raw is not None else 0
                except (TypeError, ValueError):
                    text_level = 0

                if text_level > 0 or local_references._REF_HEADING_RE.match(raw_txt) or local_references._is_real_appendix_heading(raw_txt):
                    if local_references._REF_HEADING_RE.match(raw_txt):
                        in_abstract = False
                        if page_n in split_set and not has_app_on_page:
                            in_refs_slice = True
                            break
                        if page_n in split_set:
                            in_refs_slice = True
                            continue
                        bid = _unique_id("refs", taken)
                        page_blocks.append(local_references.build_ref_block(page_n, target) | {"id": bid})
                        continue
                    if local_references._is_real_appendix_heading(raw_txt):
                        in_refs_slice = False
                    if in_refs_slice:
                        continue
                    num, title_clean = _split_heading_num(raw_txt)
                    if title_clean.lower() == "abstract":
                        in_abstract = True
                        seq["heading"] += 1
                        bid = _unique_id(f"s-p{page_n}-{seq['heading']}", taken)
                        page_blocks.append({"id": bid, "type": "heading", "page": page_n, "level": 1, "num": "", "en": "Abstract"})
                        continue
                    in_abstract = False
                    if page_n == 1 and text_level == 1 and not meta_out.get("title_en") and not num and len(title_clean) >= 8:
                        meta_out["title_en"] = title_clean
                    lvl = 1 if (text_level == 1 or local_references._is_real_appendix_heading(raw_txt)) else 2
                    seq["heading"] += 1
                    base = f"s{num.replace('.', '-')}" if num else f"s-p{page_n}-{seq['heading']}"
                    bid = _unique_id(base, taken)
                    blk = {"id": bid, "type": "heading", "page": page_n, "level": lvl, "num": num, "en": title_clean}
                    if local_references._is_real_appendix_heading(raw_txt):
                        blk["appendix"] = True
                    page_blocks.append(blk)
                else:
                    if in_refs_slice:
                        continue
                    seq["para"] += 1
                    bid = _unique_id(f"p{page_n}-{seq['para']}", taken)
                    blk = {"id": bid, "type": "para", "page": page_n, "en": raw_txt}
                    if in_abstract:
                        blk["role"] = "abstract"
                    elif item.get("continues_prev"):
                        blk["cont"] = True
                    page_blocks.append(blk)

            elif itype == "list":
                if in_refs_slice:
                    continue
                raw_items = item.get("list_items") or []
                if isinstance(raw_items, str):
                    raw_items = [ln.strip() for ln in raw_items.splitlines() if ln.strip()]
                if not isinstance(raw_items, list) or not raw_items:
                    txt = str(item.get("text") or "").strip()
                    raw_items = [ln.strip() for ln in txt.splitlines() if ln.strip()] if txt else []
                cleaned_items = []
                ordered = False
                for idx_it, entry in enumerate(raw_items):
                    s = " ".join(str(entry or "").split()).strip()
                    if not s:
                        continue
                    if idx_it == 0 and _LIST_ORDERED_RE.match(s):
                        ordered = True
                    s = _clean_inline_html(_LIST_BULLET_RE.sub("", s, count=1).strip())
                    if s:
                        cleaned_items.append({"en": s})
                if not cleaned_items:
                    continue
                if str(item.get("sub_type") or "").lower() == "ref_list":
                    if page_n in split_set:
                        continue
                    parsed = local_references.parse_entries([(page_n, "\n".join(x["en"] for x in cleaned_items))])
                    references.extend(parsed)
                    continue
                seq["list"] += 1
                bid = _unique_id(f"p{page_n}-l{seq['list']}", taken)
                page_blocks.append({"id": bid, "type": "list", "page": page_n, "ordered": ordered, "items": cleaned_items})

            elif itype in ("equation", "interline_equation"):
                if in_refs_slice:
                    continue
                tex, tag = _strip_tex_delimiters(str(item.get("text") or item.get("latex") or ""))
                if not tex:
                    continue
                seq["math"] += 1
                base = f"eq{tag}" if tag and re.match(r"^[A-Za-z0-9.]+$", tag) else f"eq-p{page_n}-{seq['math']}"
                bid = _unique_id(base, taken)
                blk = {"id": bid, "type": "math", "page": page_n, "tex": tex}
                if tag:
                    blk["tag"] = tag
                page_blocks.append(blk)

            elif itype == "table":
                if in_refs_slice:
                    continue
                seq["table"] += 1
                cap_en = _clean_inline_html(_flatten_text_list(item.get("table_caption") or item.get("caption") or []))
                num = _cap_num(cap_en)
                body_html = str(item.get("table_body") or item.get("html") or "")
                head, rows, align = _parse_table_body(body_html)
                box = _normalize_bbox(item.get("bbox"), pw, ph)
                if head or rows:
                    base = f"tab{num.replace('.', '-')}" if num else f"tab-p{page_n}-{seq['table']}"
                    bid = _unique_id(base, taken)
                    tab_blk = {
                        "id": bid,
                        "type": "table",
                        "page": page_n,
                        "num": num,
                        "head": head,
                        "rows": rows,
                        "align": align,
                        "caption_en": cap_en,
                    }
                    if item.get("_caption_pos") == "above":
                        tab_blk["caption_pos"] = "above"
                    page_blocks.append(tab_blk)
                elif box:
                    # Fallback if MinerU emitted bbox without HTML table rows: keep cropped visual.
                    seq["figure"] += 1
                    bid = _unique_id(f"fig-p{page_n}-{seq['figure']}", taken)
                    fig_blk = {"id": bid, "type": "figure", "page": page_n, "num": num, "src": "", "box": box, "box_source": "mineru", "caption_en": cap_en}
                    normalize_figure(fig_blk)
                    page_blocks.append(fig_blk)

                foot_txt = _clean_inline_html(_flatten_text_list(item.get("table_footnote") or []))
                if foot_txt:
                    seq["para"] += 1
                    bid = _unique_id(f"p{page_n}-{seq['para']}", taken)
                    page_blocks.append({"id": bid, "type": "para", "page": page_n, "role": "table_note", "en": foot_txt})

            elif itype in ("image", "figure"):
                if in_refs_slice:
                    continue
                seq["figure"] += 1
                cap_en = _clean_inline_html(_flatten_text_list(item.get("image_caption") or item.get("img_caption") or item.get("caption") or []))
                num = _cap_num(cap_en)
                box = _normalize_bbox(item.get("bbox"), pw, ph)
                base = f"fig{num.replace('.', '-')}" if num else f"fig-p{page_n}-{seq['figure']}"
                bid = _unique_id(base, taken)
                fig_blk = {"id": bid, "type": "figure", "page": page_n, "num": num, "src": "", "caption_en": cap_en}
                if item.get("_caption_pos") == "above":
                    fig_blk["caption_pos"] = "above"
                if box:
                    fig_blk["box"] = box
                    fig_blk["box_source"] = "mineru"
                normalize_figure(fig_blk)
                page_blocks.append(fig_blk)

                foot_txt = _clean_inline_html(_flatten_text_list(item.get("image_footnote") or item.get("img_footnote") or []))
                if foot_txt:
                    seq["para"] += 1
                    fid = _unique_id(f"p{page_n}-{seq['para']}", taken)
                    page_blocks.append({"id": fid, "type": "para", "page": page_n, "role": "footnote", "en": foot_txt})

            elif itype == "page_footnote":
                if in_refs_slice:
                    continue
                raw_fn = " ".join(str(item.get("text") or "").split()).strip()
                if not raw_fn:
                    continue
                sup_m = _LEAD_FOOT_SUP_RE.match(raw_fn)
                if sup_m:
                    fnum = sup_m.group(1).strip()
                    body = _clean_inline_html(sup_m.group(2).strip()) or raw_fn
                else:
                    clean_fn = _clean_inline_html(raw_fn)
                    m = _FOOT_NUM_RE.match(clean_fn)
                    fnum = (m.group(1) or m.group(2) or "") if m else ""
                    body = (m.group(3) or clean_fn).strip() if m else clean_fn
                seq["para"] += 1
                bid = _unique_id(f"p{page_n}-{seq['para']}", taken)
                blk = {"id": bid, "type": "para", "page": page_n, "role": "footnote", "en": body or raw_fn}
                if fnum:
                    blk["num"] = fnum
                page_blocks.append(blk)

            elif itype == "code":
                if in_refs_slice:
                    continue
                raw_code = str(item.get("code_body") or item.get("text") or "").rstrip()
                if not raw_code:
                    continue
                if "&" in raw_code:
                    raw_code = html_lib.unescape(raw_code)
                code_lang = str(item.get("code_lang") or "").strip()
                m_fence = re.match(r"^(`{3,})([^\n`]*)\n([\s\S]*?)\n\1\s*$", raw_code.strip())
                if m_fence:
                    if not code_lang:
                        code_lang = m_fence.group(2).strip()
                    inner_body = m_fence.group(3).rstrip()
                else:
                    inner_body = raw_code
                fence = "````" if "```" in inner_body else "```"
                fenced = f"{fence}{code_lang}\n{inner_body}\n{fence}"
                cap_str = _clean_inline_html(_flatten_text_list(item.get("code_caption") or []))
                en_code = f"{cap_str}\n\n{fenced}" if cap_str else fenced
                seq["para"] += 1
                bid = _unique_id(f"p{page_n}-{seq['para']}", taken)
                blk = {"id": bid, "type": "para", "page": page_n, "en": en_code}
                rm = _CODE_ROLE_RE.search(cap_str)
                if rm:
                    blk["role"] = "algorithm" if rm.group(1).lower() == "algorithm" else "listing"
                    blk["num"] = rm.group(2)
                page_blocks.append(blk)

        # Attach locally parsed references on split boundary pages if applicable.
        if page_n in split_set and ref_plan is not None:
            page_data = {"blocks": page_blocks, "references": []}
            local_references.parse_split_page(ws, page_n, ref_plan, page_data, cfg)
            page_blocks = page_data["blocks"]
            references.extend(page_data["references"])

        if not page_blocks and _has_text_to_lose(ws, page_n):
            log.warning("MinerU 第 %s 頁未產出有效區塊，留給內建流程處理", page_n)
            continue

        blocks.extend(page_blocks)
        ok_pages.append(page_n)

    if ok_pages:
        prepare_figures(ws.root, blocks, total_pages)
    out = {"blocks": blocks, "references": references}
    if meta_out:
        out["meta"] = meta_out
    return ok_pages, out
