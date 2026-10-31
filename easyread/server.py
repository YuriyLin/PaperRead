"""本地服务：只监听 127.0.0.1。文献库页、阅读页、数据接口、导入、后台任务。"""
from __future__ import annotations

import json
import mimetypes
import os
import re
import sys
import threading

from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

from . import __version__, answer_styles, figures, chat, chat_models, chat_store, cli_models, config, detect, engines, i18n, langs, notehelp, open_link, paperdata, pdfwork, prefs, settings_api, trash, library_api, translate_api, updates, usage, wsock, jobs_api, presets as api_presets
from .bulk import api as bulk_api
from .research import api as research_api
from . import research_v2
from . import planning_store
from .log import log, tail
from .jobs import Jobs
from .library import Library
from .i18n import tr
from .store import now_iso
from .reader_files import refresh_layout as _refresh_layout, warm as _warm, reveal as _reveal, _warming

WEB = config.WEB
mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("text/javascript", ".js")
MAX_UPLOAD = 200 * 1024 * 1024
LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


def host_name(header: str | None) -> str:
    """Host header 去掉 port 與結尾的點：'[::1]:8765' → '::1'，'LocalHost:8765' → 'localhost'。"""
    h = (header or "").strip().lower()
    if "://" in h:
        # 設定值偶爾會以完整 URL 傳入；只取 hostname，避免 allowlist
        # 收到「https」或帶路徑的錯誤項目。
        h = urlparse(h).hostname or ""
    elif h.startswith("["):
        h = h[1:].split("]", 1)[0]
    elif h.count(":") == 1:
        h = h.split(":", 1)[0]
    return h.rstrip(".")


def allowed_hosts(bind_host: str | None = None, public_host: str | None = None, extra: str | None = None) -> frozenset:
    """可接受的 Host：本機迴環、明確綁定的位址、PAPERREAD_PUBLIC_HOST，以及 PAPERREAD_ALLOWED_HOSTS（逗號分隔）。

    擋 DNS rebinding：惡意網域解析到 127.0.0.1 時，瀏覽器送來的 Host 仍是那個網域，
    若不檢查，對方頁面可以讀到 /api/library 的 token，再拿去發 POST。
    """
    hosts = set(LOOPBACK_HOSTS)
    if bind_host and bind_host not in ("0.0.0.0", "::"):
        hosts.add(host_name(bind_host))
    if public_host:
        hosts.add(host_name(public_host))
    for item in (extra or "").split(","):
        if item.strip():
            hosts.add(host_name(item))
    hosts.discard("")
    return frozenset(hosts)


def _safe(base: Path, rel: str) -> Path | None:
    target = (base / rel).resolve()
    return target if target.is_relative_to(base.resolve()) and target.is_file() else None


class App:
    def __init__(self, cfg: dict):
        self.lib = Library(config.library_dir(cfg))
        planning_store.recover_interrupted(self.lib.root)
        self.jobs = Jobs(self.lib)
        self.token = os.urandom(12).hex()
        self.location = library_api.LibraryLocation(self)
        self.presence = None  # presence.Presence，serve() 里设


class Handler(BaseHTTPRequestHandler):
    app: App
    protocol_version = "HTTP/1.1"
    allowed_hosts: frozenset = LOOPBACK_HOSTS  # launch.serve() 依綁定位址與環境變數覆寫

    def _host_ok(self) -> bool:
        """瀏覽器必須提供 Host，且只能使用啟動時建立的白名單。"""
        host = self.headers.get("Host")
        if host is not None and host_name(host) in self.allowed_hosts:
            return True
        self.close_connection = True
        self._json(400 if host is None else 403, {"error": "missing host" if host is None else "bad host"})
        return False

    def log_message(self, fmt, *args):
        if args and str(args[1]).startswith(("4", "5")):
            sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    # ---------- 输出 ----------
    def _send(self, code: int, body: bytes, ctype: str, cache: bool = False):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "max-age=86400" if cache else "no-store")
        if getattr(self, "close_connection", False):
            self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code: int, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _file(self, path: Path | None, cache=False, ctype=None):
        if not path:
            return self._json(404, {"error": "not found"})
        ctype = ctype or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        self._send(200, path.read_bytes(), ctype, cache)

    def _redirect(self, location: str):
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def _page(self, path: Path):
        self._send(200, i18n.inject(path.read_text(encoding="utf-8")).encode("utf-8"), "text/html; charset=utf-8")

    def _download(self, body: bytes, filename: str, ctype: str):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Disposition", f"attachment; filename=\"export.html\"; filename*=UTF-8''{quote(filename)}")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _chat(self, ws, body: dict):
        """流式回答：一行一个 JSON，{"t": 片段} … 最后 {"done": true, "id": …} 或 {"error": …}。"""
        text = (body.get("text") or "").strip()
        if not text:
            raise ValueError(tr("问题是空的"))
        thread = chat_store.get(ws, body.get("thread"))
        style = answer_styles.parse(body.get("answer_style", (thread or {}).get("answer_style")))
        cfg = config.load()
        ecfg, m = chat_models.engine_cfg(cfg, body.get("model"))
        from . import chat_options
        options = chat_options.apply(ecfg, body.get("chat_options"))
        images = []
        model = chat_models.label(m)
        tid = thread["id"] if thread else chat_store.new_id()
        refs = [{"anchor": str(r.get("anchor") or ""), "quote": str(r.get("quote") or "")[:1000]}
                for r in (body.get("refs") or [])[:12] if isinstance(r, dict) and r.get("anchor")]
        first = refs[0] if refs else {}
        user = {"content": text, "anchor": body.get("anchor") or first.get("anchor"), "quote": (body.get("quote") or first.get("quote") or "")[:1000],
                "note": body.get("note"), "refs": refs, "answer_style": style, "chat_options": options, "images": images}
        past = (thread or {}).get("messages", [])
        convo = [{"role": x["role"], "content": x["content"]} for x in past] + [{"role": "user", "content": text}]
        prompt_text = chat.prompt(ws, convo, user["anchor"], user["quote"], ecfg["engine"], refs, answer_style=style)
        images = chat.receive_images(ws, body.get("images"), ecfg)
        user["images"] = images
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        cancel = threading.Event()
        pieces: list[str] = []
        meter = usage.Meter(ecfg["engine"])

        def send(obj):
            self.wfile.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
            self.wfile.flush()
        try:
            send({"model": model, "thread": tid, "answer_style": style})
            def seen(actual):
                chat_models.remember(m.get("model", ""), actual)
                if m.get("engine") in ("claude", "antigravity"):
                    send({"model": chat_models.label(m)})
            attachments = chat.image_paths(ws, past + [user])
            image_options = {"images": attachments} if attachments else {}
            for piece in chat.stream(ecfg, prompt_text, ws.root, cancel, seen, meter, **image_options):
                pieces.append(piece)
                send({"t": piece})
            msg = chat_store.append(ws, tid, user, "".join(pieces), m["id"], model, meter.snapshot())
            send({"done": True, "id": msg["id"], "usage": msg.get("usage")})
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            cancel.set()  # 读者点了停止或关了页面
            if pieces:
                chat_store.append(ws, tid, {**user, "note": None}, "".join(pieces) + "\n\n" + tr("（已停止）"), m["id"], model, meter.snapshot())
        except engines.Cancelled:
            pass
        except Exception as e:  # noqa: BLE001
            log.exception("对话出错 %s", ws.id)
            try:
                send({"error": str(e)[:500]})
            except OSError:
                pass
        finally:
            saved = chat_store.get(ws, tid) or {}
            retained = {name for message in saved.get("messages", [])
                        for name in message.get("images", [])}
            for path in chat.image_paths(ws, [{"images": images}]):
                if path.relative_to(ws.root.resolve()).as_posix() not in retained:
                    path.unlink(missing_ok=True)

    def _body(self) -> bytes:
        n = int(self.headers.get("Content-Length", "0"))
        if n > MAX_UPLOAD:
            raise ValueError(tr("文件太大"))
        return self.rfile.read(n) if n else b""

    def _import_result(self, ws, fresh, translate_after, scope, read=False, model="", target=""):
        # A failed first preparation still leaves a library entry. Re-importing
        # that PDF must retry preparation instead of silently skipping it.
        paper = ws.load("paper") or {}
        active = (ws.load("job") or {}).get("state") in ("queued", "running")
        queued = fresh or (not paper.get("meta", {}).get("pages") and not active)
        if queued:
            if translate_after and not read:
                langs.remember(ws, target)  # 导入框里选的译文语言
            self.app.jobs.enqueue(ws, translate_after=translate_after, scope=scope, read=read, model=model)
        return self._json(200, {"id": ws.id, "new": fresh, "queued": queued})

    # ---------- GET ----------
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self._host_ok():
            return
        try:
            with self.app.location.request(self.command, self.path):
                self._get()
        except ValueError as e:
            self._json(409, {"error": str(e), "library_status": self.app.location.status})
        except Exception as e:  # noqa: BLE001
            log.exception("请求出错 %s", self.path)
            self._json(500, {"error": f"{type(e).__name__}: {e}"})

    def _get(self):
        url = urlparse(self.path)
        path = unquote(url.path)
        app, lib = self.app, self.app.lib
        research = research_api.get(app, path + ("?" + url.query if url.query else ""))
        if research is not None:
            return self._json(200, research)
        research = research_v2.get(app, path + ("?" + url.query if url.query else ""))
        if research is not None:
            return self._json(200, research)
        if path in ("/", "/index.html"):
            return self._page(WEB / "library.html")
        if path == "/web/tabs.html":
            return self._page(WEB / "tabs.html")
        if path == "/research":
            return self._page(WEB / "research.html")
        if path.startswith("/read/"):
            return self._page(WEB / "reader.html")
        if path == "/open":  # 外部工具打开指定论文/段落；桌面版的 easyread://open 也转到这里
            return self._redirect(open_link.target(lib, parse_qs(url.query)))
        if path == "/api/version":
            return self._json(200, open_link.version())
        if path.startswith("/web/"):
            return self._file(_safe(WEB, path[5:]), cache=path.startswith("/web/vendor/"))
        if path == "/api/presence" and wsock.is_upgrade(self.headers):
            return self._presence()
        location = library_api.get(app, path)
        if location is not None:
            return self._json(200, location)
        if path in bulk_api.GET:
            return self._json(200, bulk_api.get(app, path))
        if path == "/api/library":
            cfg = config.load()
            return self._json(200, {"items": lib.list(), "token": app.token, "jobs": app.jobs.small_status(),
                                    "research_statuses": planning_store.statuses(lib.root),
                                    "library_status": app.location.status, "other_device": app.location.marker.other_device(),
                                    "engine": cfg.get("engine"), "engine_label": cli_models.engine_label(cfg),
                                    "first_run": config.is_first_run(), "version": __version__, "trash": len(trash.items(lib.root)) + planning_store.summary_trash_count(lib.root)})
        if path == "/api/update":  # 有没有新版本（一天最多问一次 GitHub）
            return self._json(200, updates.check(force=parse_qs(url.query).get("force") == ["1"]))
        if path == "/api/trash":
            paper_items = [{**item, "type": "paper"} for item in trash.items(lib.root)]
            return self._json(200, {"items": paper_items + planning_store.summary_trash_items(lib.root)})
        if path == "/api/config":
            return self._json(200, {"config": config.public(config.load()), "presets": api_presets.presets(),
                                    "api_choices": api_presets.api_choices()})
        if path == "/api/engines":
            cfg = config.load()
            found = detect.detect(cfg, fresh=parse_qs(url.query).get("fresh") == ["1"])
            return self._json(200, {"found": found, "ready": detect.ready(cfg, found), "engine": cfg.get("engine"), "models": cli_models.listing()})
        if path == "/api/prefs":
            return self._json(200, prefs.load())
        if path == "/api/chat/models":
            return self._json(200, chat_models.listing(config.load()))
        if path == "/api/log":
            return self._json(200, {"text": tail(config.LOG_PATH, 200), "path": str(config.LOG_PATH)})
        if path == "/api/jobs":
            return self._json(200, {"jobs": app.jobs.small_status(parse_qs(url.query).get("pid", [None])[0])})
        if path.startswith("/api/p/"):
            parts = path.split("/")  # ['', 'api', 'p', id, action, name?]
            ws = lib.ws(parts[3]) if len(parts) > 4 else None
            if not ws:
                return self._json(404, {"error": tr("没有这篇论文")})
            action = parts[4]
            if action == "state":
                if config.load().get("target") == "zh-TW" and app.location.status == "idle" and (ws.load("job") or {}).get("state") not in ("queued", "running"):
                    from . import traditional
                    traditional.migrate(ws)
                # 舊版智慧標註可能仍以英文原文為定位。讀取閱讀頁時，
                # 以穩定的英文來源重新對齊目前的繁中譯文；只更新 AI
                # 標註，不會碰使用者手動建立的筆記或標註。
                try:
                    reader = ws.load("reader") or {}
                    if reader.get("ai_annotations"):
                        from .smart_annotations import refresh_after_translation
                        refresh_after_translation(ws)
                except Exception:  # noqa: BLE001 —— 相容性同步失敗不阻斷閱讀頁
                    log.exception("智慧標註讀取時同步失敗 %s", ws.id)
                opened = {"last_opened": now_iso()}
                if app.location.status == "idle":
                    ws.patch_item(opened)
                    _warm(ws.root, app.location)
                    _refresh_layout(ws)
                state = {**{n: ws.load(n) for n in ("paper", "discussion", "reader", "layout", "item", "job")},
                         "versions": ws.versions(), "token": app.token, "id": ws.id, "library_status": app.location.status,
                         "engine": config.load().get("engine")}
                # 旧论文的图按定位框补截图；等内容和版本号都取完再开始，页面轮询到 paper 变了就会重画
                if app.location.status == "idle" and (state["job"] or {}).get("state") not in ("queued", "running"):
                    pass  # PaperRead does not generate cropped figure assets.
                return self._json(200, state)
            if action == "versions":
                return self._json(200, {**ws.versions(), "library_status": app.location.status})
            if action == "chat":
                return self._json(200, {"threads": chat_store.threads(ws), **chat_models.listing(config.load()), "limits": usage.latest()})
            if action == "log":
                return self._json(200, {"text": tail(ws.root / "job.log", 300)})
            if action == "export":
                if app.location.status != "idle":
                    raise app.location._error()
                from .build import build
                out = build(ws, mobile=parse_qs(url.query).get("mobile") == ["1"])
                return self._download(out.read_bytes(), out.name, "text/html; charset=utf-8")
            if action == "part" and len(parts) > 5 and parts[5] in ("paper", "discussion", "reader", "layout", "job"):
                return self._json(200, {"data": ws.load(parts[5]), "version": ws.versions()[parts[5]]})
        if path.startswith("/p/"):
            _, _, pid, rel = path.split("/", 3)
            ws = lib.ws(pid)
            if ws and re.fullmatch(r"extract/page-[0-9]{3,6}\.chars\.json", rel):
                if parse_qs(url.query).get("selection") == ["2"]:
                    from .selectable_text import page_file
                    return self._file(page_file(ws.root, ws.source_pdf, int(rel[13:-11])))
                return self._file(_safe(ws.root, rel), cache=True)
            if ws and app.location.status == "idle" and rel.startswith("pages/") and "w=" in url.query:  # 原页面板用的小一号图，第一次请求时生成
                try:
                    w = int(parse_qs(url.query)["w"][0])
                except (KeyError, IndexError, ValueError):
                    w = 1000
                variant = pdfwork.page_variant(ws.root, rel, w)
                return self._file(variant or _safe(ws.root, rel), cache=True)
            if ws and re.fullmatch(r"chat-media/[0-9a-f]{32}\.png", rel):
                return self._file(_safe(ws.root, rel), cache=True)
            if ws and (rel.split("/", 1)[0] in ("pages", "figures") or rel == "source.pdf"):
                source = ws.source_pdf if rel == "source.pdf" else _safe(ws.root, rel)
                return self._file(source if source and source.is_file() else None, cache=rel != "source.pdf",
                                  ctype="application/pdf" if rel == "source.pdf" else None)
        return self._json(404, {"error": "not found"})

    # ---------- POST ----------
    def do_POST(self):
        if not self._host_ok():
            self.close_connection = True
            return
        if self.headers.get("X-Token") != self.app.token:  # 挡住别的网页跨站写
            self.close_connection = True
            try:
                self._body()
            except Exception:
                pass
            return self._json(403, {"error": "bad token"})
        try:
            with self.app.location.request("POST", self.path):
                self._post()
        except (ValueError, KeyError) as e:
            self._json(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001
            log.exception("请求出错 %s", self.path)
            self._json(500, {"error": f"{type(e).__name__}: {e}"})

    def _presence(self):
        """页面开着就一直连着这条 WebSocket；断开就是页面关了（见 presence.py）。"""
        host = self.headers.get("Host") or ""
        if self.headers.get("Origin") not in (None, f"http://{host}"):  # 别的网站不能来占着
            self.close_connection = True
            return self._json(403, {"error": "bad origin"})
        p = self.app.presence
        self.app.location.enter_page()
        try:
            wsock.accept(self)
            self.close_connection = True
            wsock.hold(self)
        finally:
            if p:
                p.leave()

    def _post(self):
        url = urlparse(self.path)
        path = unquote(url.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        app, lib = self.app, self.app.lib

        if path.startswith(research_api.PREFIX + "/"):
            endpoint = path[len(research_api.PREFIX):]
            result = research_api.post(app, endpoint, json.loads(self._body() or b"{}"))
            return self._json(200, result)

        if path == research_v2.PREFIX + "/attach-pdf":
            body = self._body()
            return self._json(200, research_v2.attach_pdf(app, q.get("paper_key", ""), body, q.get("name", "paper.pdf")))

        if path.startswith(research_v2.PREFIX + "/"):
            endpoint = path[len(research_v2.PREFIX):]
            result = research_v2.post(app, endpoint, json.loads(self._body() or b"{}"))
            return self._json(200, result)

        if path in library_api.POST:
            return self._json(200, library_api.post(app, path, json.loads(self._body() or b"{}")))
        if path in jobs_api.POST:  # 一键停止翻译
            return self._json(200, jobs_api.post(app, path, json.loads(self._body() or b"{}")))
        if path in bulk_api.POST:  # 从 Zotero 迁移、导入文件夹
            return self._json(200, bulk_api.post(app, path, json.loads(self._body() or b"{}")))
        if path == "/api/update":  # 开关“自动检查新版本”
            config.save({"check_updates": bool(json.loads(self._body() or b"{}").get("enabled"))})
            return self._json(200, updates.check())
        if path == "/api/presence/keep":  # easyread serve 复用了关页会退出的服务：改成常驻
            if app.presence:
                app.presence.keep()
            return self._json(200, {"ok": True})
        if path == "/api/import":  # 请求体就是 PDF 文件
            data = self._body()
            ws, fresh = lib.create_from_pdf(data, q.get("name", "paper.pdf"))
            return self._import_result(ws, fresh, q.get("translate", "1") == "1", q.get("scope"),
                                       read=q.get("read") == "1", model=q.get("model", ""), target=q.get("target", ""))
        if path in ("/api/import-url", "/api/import-arxiv"):
            body = json.loads(self._body() or b"{}")
            data, name, meta = lib.fetch(body.get("ref", ""))  # sources.SourceError 是 ValueError，回 400
            ws, fresh = lib.create_from_pdf(data, name, meta)
            return self._import_result(ws, fresh, bool(body.get("translate", True)), body.get("scope"),
                                       read=bool(body.get("read")), model=str(body.get("model") or ""), target=str(body.get("target") or ""))
        if path in settings_api.POST:  # 设置页：保存配置、模型名单、试一下、取模型列表
            return self._json(200, settings_api.POST[path](json.loads(self._body() or b"{}")))
        if path == "/api/prefs":
            return self._json(200, prefs.save(json.loads(self._body() or b"{}")))
        if path == "/api/trash":  # 回收站：論文與摘要分別還原或永久刪除。
            body = json.loads(self._body() or b"{}")
            act, name, item_type = body.get("action"), body.get("name", ""), body.get("type", "paper")
            if act == "move-summary":
                moved = planning_store.summary_move_to_trash(lib.root, str(name))
                if not moved:
                    raise ValueError(tr("找不到這份已整理摘要"))
                return self._json(200, {"moved": True, "type": "summary"})
            if act not in ("restore", "purge", "empty"):
                raise ValueError(tr("action 只能是 restore / purge / empty"))
            if item_type == "summary":
                if act == "restore":
                    planning_store.summary_trash_restore(lib.root, name)
                    return self._json(200, {"restored": True, "type": "summary"})
                if act == "purge":
                    return self._json(200, {"deleted": planning_store.summary_trash_purge(lib.root, name), "type": "summary"})
                deleted = planning_store.summary_trash_empty(lib.root) + trash.empty(lib.root)
                return self._json(200, {"deleted": deleted})
            if item_type != "paper":
                raise ValueError(tr("回收站項目類型不正確"))
            if act == "restore":
                return self._json(200, {"id": trash.restore(lib.root, name)})
            if act == "purge":
                return self._json(200, {"deleted": trash.purge(lib.root, name)})
            return self._json(200, {"deleted": trash.empty(lib.root) + planning_store.summary_trash_empty(lib.root)})

        if path.startswith("/api/p/"):
            parts = path.split("/")
            ws = lib.ws(parts[3]) if len(parts) > 4 else None
            if not ws:
                return self._json(404, {"error": tr("没有这篇论文")})
            action = parts[4]
            body = json.loads(self._body() or b"{}")
            if action == "chat" and len(parts) > 5:
                sub, tid = parts[5], body.get("thread", "")
                if sub == "pin":
                    chat_store.pin(ws, tid, body.get("id", ""))
                elif sub == "rename":
                    chat_store.rename(ws, tid, body.get("title", ""))
                elif sub == "delete":
                    chat_store.delete(ws, tid)
                return self._json(200, {"threads": chat_store.threads(ws)})
            if action == "chat":
                return self._chat(ws, body)
            if action == "chat-export":
                from .chat_markdown import export
                return self._json(200, export(ws, body))
            if action == "notehelp":
                return notehelp.handle(self, ws, body)
            if action == "discussion_del":
                return self._json(200, {"deleted": paperdata.delete_discussion(ws, str(body.get("id", "")))})
            if action == "smart-annotate":
                scope = str(body.get("scope") or "all")
                mode = str(body.get("mode") or "auto")
                intensity = str(body.get("intensity") or "standard")
                if scope not in ("all", "section"):
                    raise ValueError(tr("智慧標註範圍不正確"))
                if mode not in ("auto", "suggest", "purpose"):
                    raise ValueError(tr("智慧標註模式不正確"))
                if intensity not in ("concise", "standard", "detailed"):
                    raise ValueError(tr("智慧標註強度不正確"))
                meta = (ws.load("paper") or {}).get("meta") or {}
                title = str(meta.get("title_zh") or meta.get("title_en") or tr("未命名論文"))[:300]
                return self._json(200, app.jobs.submit_small(
                    "smart-annotate", ws.id, scope=scope, section_id=str(body.get("section_id") or ""),
                    mode=mode, intensity=intensity, purpose=str(body.get("purpose") or "")[:500],
                    model=str(body.get("model") or ""), title=title,
                ))
            if action == "smart-annotate-cancel":
                return self._json(200, {"cancelled": app.jobs.cancel_small(str(body.get("job") or ""))})
            if action == "smart-annotation":
                from . import smart_annotations
                return self._json(200, smart_annotations.apply_action(ws, body))
            if action == "ops":
                ops = body.get("ops") or []
                if not isinstance(ops, list):
                    raise ValueError(tr("ops 必须是数组"))
                res = ws.apply_reader_ops(ops, client=str(body.get("client", ""))[:40])
                res["versions"] = ws.versions()
                return self._json(200, res)
            if action == "item":
                return self._json(200, ws.patch_item(body))
            if action == "translate":
                return self._json(200, translate_api.enqueue(app.jobs, ws, body))
            if action == "reveal":  # 在资源管理器 / 访达里打开这篇的文件夹
                _reveal(ws.root)
                return self._json(200, {"ok": True})
            if action == "cancel":
                app.jobs.cancel(ws.id)
                return self._json(200, {"ok": True})
            if action == "answer":
                return self._json(200, app.jobs.submit_small("answer", ws.id, note=body["note"]))
            if action == "retranslate":
                return self._json(200, app.jobs.submit_small("retranslate", ws.id, key=body["key"], hint=body.get("hint", "")))
            if action == "delete":
                app.jobs.cancel(ws.id)
                return self._json(200, {"trash": str(lib.trash(ws.id))})
        return self._json(404, {"error": "not found"})

