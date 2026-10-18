"""启动本地服务：只监听 127.0.0.1，记下地址给命令行复用；start.cmd / start.sh 启动时页面都关了就退出。"""
from __future__ import annotations

import os
import threading
import time
import webbrowser
from http.server import ThreadingHTTPServer

from . import __version__, config, detect, review_policy
from .log import log, setup as setup_log
from .presence import Presence
from .server import App, Handler
from .store import now_iso, read_json, write_json_atomic


class _Server(ThreadingHTTPServer):
    # Windows 上 SO_REUSEADDR 会让两个进程同时占住 8765，浏览器随机连到其中一个（比如旧版本）
    allow_reuse_address = os.name != "nt"


def serve(port: int | None = None, open_browser: bool = False, path: str = "/", exit_on_close: bool = False,
          host: str | None = None):
    """exit_on_close：start.cmd / start.sh 启动时为真，页面都关了、后台任务也做完了就退出。"""
    review_policy.require_launch()
    review_policy.require_path(config.LOG_PATH, "home")
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
    public_host = os.environ.get("PAPERREAD_PUBLIC_HOST")
    if not public_host:
        public_host = "127.0.0.1" if bind_host in ("0.0.0.0", "::") else bind_host
    url = f"http://{public_host}:{httpd.server_address[1]}"
    log.info("startup http-bound +%.0fms", (time.monotonic() - started) * 1000)
    app.shutdown = httpd.shutdown
    app.location.marker.start()
    app.presence = Presence(app.jobs.busy, httpd.shutdown, exit_on_close)
    if not config.temp_library():
        write_json_atomic(config.SERVER_INFO, {"url": url, "pid": os.getpid(), "started": now_iso()})
    log.info("PaperRead %s 已啟動：%s  文獻庫：%s", __version__, url, app.lib.root)
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
