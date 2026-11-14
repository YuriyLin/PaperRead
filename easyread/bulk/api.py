"""成批导入的接口：找 Zotero 数据目录；看一眼有多少、开始 / 停止、查进度（Zotero 和文件夹共用）。"""
from __future__ import annotations

import hashlib
from ..zotero import locate
from .. import prefs
from ..i18n import tr
from .runner import Migration


def _mig(app) -> Migration:
    if not getattr(app, "bulk", None):
        app.bulk = Migration(app)
    return app.bulk


def get(app, path: str):
    if path == "/api/zotero/detect":
        return {"candidates": locate.candidates()}
    if path == "/api/zotero/sync-config":
        return {"config": (prefs.load().get("import") or {}).get("zotero_sync") or {}}
    if path == "/api/migrate/status":
        return _mig(app).status
    return None


def post(app, path: str, body: dict):
    source, where, base = str(body.get("source") or "zotero"), str(body.get("path") or ""), str(body.get("base") or "")
    if path in ("/api/zotero/sync", "/api/zotero/sync-preview"):
        saved = (prefs.load().get("import") or {}).get("zotero_sync") or {}
        where = where or saved.get("path", "")
        base = base if body.get("path") else saved.get("base", "")
        if not where:
            raise ValueError(tr("請先設定 Zotero 資料夾。"))
        if path.endswith("sync-preview"):
            result = _mig(app).sync_preview(where, base)
            tags = body.get("tags", saved.get("tags", True)) is not False
            prefs.save({"import": {"zotero_sync": {"path": str(locate.resolve(where)), "base": base, "tags": tags}}})
            return result
        current_library = hashlib.sha256(str(app.lib.root).encode("utf-8")).hexdigest()
        if body.get("library_token") != current_library:
            raise ValueError(tr("文獻庫已變更，請重新開始同步。"))
        tags = body.get("tags", saved.get("tags", True)) is not False
        return _mig(app).start("zotero", where, base, with_tags=tags, sync=True,
                               selected=body.get("selected", []), library_token=body.get("library_token", ""))
    if path == "/api/migrate/scan":
        return _mig(app).scan(source, where, base)
    if path == "/api/migrate/start":
        return _mig(app).start(source, where, base, with_tags=body.get("tags", True) is not False,
                               fetch=body.get("fetch") is True, link=body.get("link") is True)
    if path == "/api/migrate/stop":
        return _mig(app).stop()
    return None


GET = {"/api/zotero/detect", "/api/zotero/sync-config", "/api/migrate/status"}
POST = {"/api/zotero/sync", "/api/zotero/sync-preview", "/api/migrate/scan", "/api/migrate/start", "/api/migrate/stop"}
