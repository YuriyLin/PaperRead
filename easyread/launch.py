"""启动本地服务：只监听 127.0.0.1，记下地址给命令行复用；start.cmd / start.sh 启动时页面都关了就退出。"""
from __future__ import annotations

import os
import threading
import time
import webbrowser
from http.server import ThreadingHTTPServer

from . import __version__, config, detect
from .i18n import tr
from .log import log, setup as setup_log
from .presence import Presence
from .research import tasks as research_tasks
from .server import App, Handler, allowed_hosts, host_name
from .store import now_iso, read_json, write_json_atomic


class _Server(ThreadingHTTPServer):
    # Windows 上 SO_REUSEADDR 会让两个进程同时占住 8765，浏览器随机连到其中一个（比如旧版本）
    allow_reuse_address = os.name != "nt"


def serve(port: int | None = None, open_browser: bool = False, path: str = "/", exit_on_close: bool = False,
          host: str | None = None):
    """exit_on_close：start.cmd / start.sh 启动时为真，页面都关了、后台任务也做完了就退出。"""
    setup_log(config.LOG_PATH)
    started = time.monotonic()
    cfg = config.load()
    log.info("startup config-ready +%.0fms", (time.monotonic() - started) * 1000)
    app = App(cfg)
    log.info("startup library-jobs-ready +%.0fms", (time.monotonic() - started) * 1000)
    Handler.app = app
    detect.warm(cfg)
    port = cfg["port"] if port is None else port
    bind_host = host or os.environ.get("PAPERREAD_HOST") or "127.0.0.1"
    try:
        httpd = _Server((bind_host, port), Handler)
    except OSError:
        httpd = _Server((bind_host, 0), Handler)
    configured_public_host = os.environ.get("PAPERREAD_PUBLIC_HOST", "").strip()
    public_host = host_name(configured_public_host) if configured_public_host else ""
    if configured_public_host and not public_host:
        raise ValueError(tr("PAPERREAD_PUBLIC_HOST 必須包含有效的主機名稱"))
    if not public_host:
        public_host = "127.0.0.1" if bind_host in ("0.0.0.0", "::") else bind_host
    url = f"http://{public_host}:{httpd.server_address[1]}"
    Handler.allowed_hosts = allowed_hosts(bind_host, public_host, os.environ.get("PAPERREAD_ALLOWED_HOSTS"))
    log.info("startup http-bound +%.0fms", (time.monotonic() - started) * 1000)
    app.shutdown = httpd.shutdown
    app.location.marker.start()
    app.presence = Presence(lambda: app.jobs.busy() or research_tasks.busy(), httpd.shutdown, exit_on_close)
    if not config.temp_library():
        write_json_atomic(config.SERVER_INFO, {"url": url, "pid": os.getpid(), "started": now_iso()})
    log.info("PaperRead %s started: %s  Library: %s", __version__, url, app.lib.root)
    print(f"PaperRead 已啟動：{url}  文獻庫：{app.lib.root}", flush=True)  # i18n-ok Electron and smoke_backend match this line
    if open_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url + path)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        app.location.marker.close()
        httpd.server_close()
        if not config.temp_library() and (read_json(config.SERVER_INFO, {}) or {}).get("pid") == os.getpid():
            config.SERVER_INFO.unlink(missing_ok=True)  # 下次 easyread 命令不会去连一个已经关掉的服务
