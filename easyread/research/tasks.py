"""Small in-process task registry for potentially slow local indexing work."""
from __future__ import annotations

import threading
import time
import uuid
from hashlib import sha256

from ..i18n import tr


_LOCK = threading.Lock()
_TASKS: dict[str, dict] = {}
_CANCEL: dict[str, threading.Event] = {}


def _public(task: dict, include_result: bool = True) -> dict:
    return {key: value for key, value in task.items()
            if not key.startswith("_") and (include_result or key != "result")}


def _notify(callback, snapshot: dict) -> None:
    if callback:
        try:
            callback(snapshot)
        except Exception:
            # Persistence/notification hooks must not turn a successful task into a failure.
            pass


def scope_id(root) -> str:
    """Stable, non-reversible identifier for one local library task scope."""
    return sha256(str(root.resolve()).casefold().encode("utf-8")).hexdigest()[:20]


def submit(kind: str, runner, retry_failed: bool = False, *, scope: str = "", on_update=None, key: str = "", **extra) -> dict:
    scope = str(scope or "")
    key = str(key or "")
    with _LOCK:
        active = next((task for task in _TASKS.values()
                       if task["kind"] == kind and task.get("scope", "") == scope
                       and (not key or task.get("key", "") == key)
                       and task["state"] in ("queued", "running", "cancelling")), None)
        if active:
            return _public(active)
        recent_failure = next((task for task in _TASKS.values()
                               if task["kind"] == kind and task.get("scope", "") == scope
                               and (not key or task.get("key", "") == key)
                               and task["state"] in ("failed", "cancelled")
                               and time.time() - task["updated"] < 60), None)
        if recent_failure and not retry_failed:
            return _public(recent_failure)
        expired = sorted((task for task in _TASKS.values() if task["state"] not in ("queued", "running", "cancelling")),
                         key=lambda item: item["updated"], reverse=True)[100:]
        for old in expired:
            _TASKS.pop(old["id"], None)
        identity = str(uuid.uuid4())
        task = {"id": identity, "kind": kind, "key": key, "state": "queued", "phase": "queued", "done": 0,
                "total": 0, "message": tr("排入背景工作…"), "created": time.time(), "updated": time.time(),
                "scope": scope, "_on_update": on_update, **extra}
        cancel = threading.Event()
        _TASKS[identity] = task
        _CANCEL[identity] = cancel

    def report(phase: str, done: int, total: int, message: str):
        with _LOCK:
            if task["state"] in ("cancelling", "cancelled"):
                return
            task.update(phase=phase, done=max(0, int(done or 0)), total=max(0, int(total or 0)),
                        message=str(message or "")[:240], updated=time.time())
            snapshot = _public(task)
        _notify(on_update, snapshot)

    def work():
        with _LOCK:
            task.update(state="running", phase="starting", message=tr("背景工作開始"), updated=time.time())
            snapshot = _public(task)
        _notify(on_update, snapshot)
        try:
            result = runner(cancel, report)
            with _LOCK:
                if cancel.is_set():
                    task.update(state="cancelled", phase="cancelled", message=tr("工作已取消"))
                else:
                    task.update(state="completed", phase="completed", message=tr("工作完成"), result=result)
                task["updated"] = time.time()
                snapshot = _public(task)
            _notify(on_update, snapshot)
        except Exception as error:  # noqa: BLE001
            with _LOCK:
                task.update(state="cancelled" if cancel.is_set() else "failed",
                            phase="cancelled" if cancel.is_set() else "failed",
                            message=tr("工作已取消") if cancel.is_set() else str(error)[:500], updated=time.time())
                snapshot = _public(task)
            _notify(on_update, snapshot)
        finally:
            with _LOCK:
                _CANCEL.pop(identity, None)

    snapshot = _public(task)
    _notify(on_update, snapshot)
    threading.Thread(target=work, name=f"research-{kind}-{identity[:8]}", daemon=True).start()
    return snapshot


def register_external(identity: str, kind: str, *, scope: str = "", key: str = "", cancel_event: threading.Event | None = None, **extra) -> dict:
    with _LOCK:
        expired = sorted((t for t in _TASKS.values() if t["state"] not in ("queued", "running", "cancelling")),
                         key=lambda item: item["updated"], reverse=True)[100:]
        for old in expired:
            _TASKS.pop(old["id"], None)
        task = {
            "id": identity, "kind": kind, "key": key, "state": "queued", "phase": "queued",
            "done": 0, "total": 0, "message": tr("排入背景工作…"),
            "created": time.time(), "updated": time.time(), "scope": scope, **extra
        }
        _TASKS[identity] = task
        if cancel_event is not None:
            _CANCEL[identity] = cancel_event
        return _public(task)


def update_external(identity: str, *, state: str | None = None, phase: str | None = None, done: int | None = None, total: int | None = None, message: str | None = None, result: any = None) -> dict | None:
    with _LOCK:
        task = _TASKS.get(identity)
        if not task:
            return None
        if state is not None:
            task["state"] = state
        if phase is not None:
            task["phase"] = phase
        if done is not None:
            task["done"] = max(0, int(done))
        if total is not None:
            task["total"] = max(0, int(total))
        if message is not None:
            task["message"] = str(message)[:240]
        if result is not None:
            task["result"] = result
        task["updated"] = time.time()
        return _public(task)


def get(identity: str, scope: str | None = None) -> dict | None:
    with _LOCK:
        task = _TASKS.get(identity)
        if task and scope is not None and task.get("scope", "") != scope:
            return None
        return _public(task) if task else None


def list_tasks(scope: str | None = None) -> list[dict]:
    with _LOCK:
        items = [task for task in _TASKS.values() if scope is None or task.get("scope", "") == scope]
        return [_public(task, include_result=False) for task in sorted(items, key=lambda item: item["created"], reverse=True)[:20]]


def cancel(identity: str, scope: str | None = None) -> dict | None:
    with _LOCK:
        task = _TASKS.get(identity)
        if task and scope is not None and task.get("scope", "") != scope:
            return None
        event = _CANCEL.get(identity)
        if not task:
            return None
        if event and task["state"] in ("queued", "running"):
            event.set()
            task.update(state="cancelling", phase="cancelling", message=tr("正在取消工作…"), updated=time.time())
            snapshot = _public(task)
        else:
            snapshot = _public(task)
    if event:
        _notify(task.get("_on_update"), snapshot)
    return snapshot


def acknowledge(identity: str, scope: str | None = None) -> dict | None:
    with _LOCK:
        task = _TASKS.get(identity)
        if not task or (scope is not None and task.get("scope", "") != scope):
            return None
        task["acknowledged"] = True
        return _public(task, include_result=False)


def busy() -> bool:
    with _LOCK:
        return any(task["state"] in ("queued", "running", "cancelling") for task in _TASKS.values())
