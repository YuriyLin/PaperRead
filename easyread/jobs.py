"""后台任务：导入后的渲染与整篇翻译（一条队列，状态落在每篇的 job.json，重启后接着做），
以及“让模型回答我的问题 / 重译这段”这类小任务（另一条队列，不用等整篇翻译）。"""
from __future__ import annotations

import queue
import threading
import time
from uuid import uuid4

from . import chat_models, config, langs, translate, usage
from .engines import Cancelled, EngineError
from .i18n import tr
from .library import Library
from .log import log
from .store import DataReadError, Workspace, now_iso


def engine_for(cfg: dict, model: str | None) -> dict:
    """导入时选了“问 AI”名单里的模型就用它，否则用设置里的翻译引擎。名单里已经没有这个模型了，也用翻译引擎。"""
    m = next((x for x in chat_models.models(cfg) if x.get("id") == model), None) if model else None
    if not m:
        return cfg
    out, _ = chat_models.engine_cfg(cfg, model)
    o = cfg.get("openai") or {}
    if m["engine"] == "openai" and m.get("preset") == o.get("preset") and (m.get("model") or o.get("model")) == o.get("model"):
        out["openai"]["vision"] = o.get("vision", False)  # 和翻译引擎是同一个模型：沿用“模型能看图”
    return out


class Jobs:
    def __init__(self, lib: Library):
        self.lib = lib
        self.bulk: queue.Queue[str] = queue.Queue()
        self.small: queue.Queue[dict] = queue.Queue()
        self.cancels: dict[str, threading.Event] = {}
        self.small_cancels: dict[str, threading.Event] = {}
        self.recent: list[dict] = []  # 小任务的状态，给页面轮询
        self.lock = threading.Lock()
        self._resume()
        for target in (self._bulk_loop, self._small_loop):
            threading.Thread(target=target, daemon=True).start()

    # ---------- 整篇 ----------
    def _write(self, ws: Workspace, **fields):
        def apply(job):
            job.update(fields)
            job["updated"] = now_iso()
        try:
            ws.update("job", apply)
        except FileNotFoundError:
            # 写入期间整篇论文被删：工作目录没了就跳过，目录还在才抛出。
            if ws.root.exists():
                raise

    def enqueue(self, ws: Workspace, pages: list[int] | None = None, translate_after: bool = True, scope: str | None = None,
                read: bool = False, model: str = "", confirmed: bool = False, target: str = "", cap_check: bool = False):
        """pages=None：按 scope（all / body / range:A-B / first:N）翻译还没译的页。
        read：只读原文，用模型把页整理成段落、公式、表格，不翻译；之后再翻译时就地补中文。
        model：用“问 AI”名单里的哪个模型（导入时选的）；空着用设置里的翻译引擎。
        confirmed：只接受真正的 True；target：续跑时保留原任务的译文语言。
        cap_check：pages 来自系统计划而非用户指定，仍检查页数上限并跳过已完成页。"""
        target = langs.valid(target) if target else langs.of_paper((ws.load("paper") or {}).get("meta"))
        def apply(job):
            if job.get("state") in ("queued", "running"):
                raise ValueError(tr("这篇论文已有任务在排队或运行，请等它结束，或先取消再重试。"))
            job.update(type="read" if read and translate_after else "translate" if translate_after else "prepare",
                       state="queued", message=tr("排队中"), pages=pages, scope=scope or "all", translate=translate_after, read=read, model=model or "",
                       confirmed=confirmed is True, target=target, cap_check=cap_check is True,
                       done=0, total=0, error="", failed={}, updated=now_iso(), usage={})
            job.pop("page_cap", None)
        with self.lock:
            ws.update("job", apply)
            self.bulk.put(ws.id)

    def cancel(self, pid: str):
        with self.lock:
            ev = self.cancels.get(pid)
            if ev:
                ev.set()
            ws = self.lib.ws(pid)
            job = (ws.load("job") or {}) if ws else {}
            if job.get("state") == "queued":
                self._write(ws, state="cancelled", message=tr("已取消"))
            elif job.get("state") == "confirm":
                self._write(ws, state="done", message=tr("已导入，未整理") if job.get("read") else tr("已导入，未翻译"))

    def stop_model_work(self, ids: list[str] | None = None) -> int:
        """一键停止：只停用模型的部分（翻译、整理原文、等确认页数的），原页照样渲染。
        还在排队、原页没渲染的改成只渲染；ids 为空就是全部。返回停了几篇。"""
        want = set(ids) if ids is not None else None
        n = 0
        with self.lock:
            for ws in self.lib.all():
                if want is not None and ws.id not in want:
                    continue
                job = ws.load("job") or {}
                state = job.get("state")
                if state not in ("queued", "running", "confirm") or not job.get("translate"):
                    continue
                n += 1
                if state == "running":
                    ev = self.cancels.get(ws.id)
                    if ev:
                        ev.set()
                elif state == "confirm":
                    self._write(ws, state="done", message=tr("已导入，未整理") if job.get("read") else tr("已导入，未翻译"))
                elif (ws.load("paper") or {}).get("meta", {}).get("pages"):
                    self._write(ws, state="cancelled", message=tr("已取消"))
                else:  # 留在队里，轮到时只渲染原页
                    self._write(ws, type="prepare", translate=False, read=False, message=tr("排队中"))
        return n

    def _resume(self):
        for ws in self.lib.all():
            try:
                job = ws.load("job") or {}
            except DataReadError as e:
                # 損壞資料保留原樣以利修復；其他論文照常恢復排隊
                log.exception("Cannot resume task; unreadable data file: %s", e.path)
                continue
            if job.get("state") in ("queued", "running"):
                self._write(ws, state="queued", message=tr("排队中（服务重启后继续）"))
                self.bulk.put(ws.id)

    def _bulk_loop(self):
        while True:
            pid = self.bulk.get()
            try:
                self._process_bulk(pid)
            except Exception:  # noqa: BLE001
                # 论文在排队时被删（工作目录没了）等情况，记一下就接着处理下一篇。
                log.exception("后台任务出错 %s", pid)

    def _process_bulk(self, pid: str):
        with self.lock:
            ws = self.lib.ws(pid)
            if not ws:
                return
            job = ws.load("job") or {}
            if job.get("state") != "queued":
                return
            cancel = self.cancels[pid] = threading.Event()
            try:
                self._write(ws, state="running", message=tr("正在开始任务"))
            except Exception:
                self.cancels.pop(pid, None)
                raise
        try:
            self._run_bulk(ws, job, cancel)
        except Cancelled:
            self._write(ws, state="cancelled", message=tr("已取消，已译内容已保留"))
        except Exception as e:  # noqa: BLE001
            if cancel.is_set():  # 点了停止或模型调用被打断：算已取消
                self._write(ws, state="cancelled", message=tr("已取消，已译内容已保留"))
                return
            msg = str(e) if isinstance(e, (EngineError, KeyError, ValueError)) else f"{type(e).__name__}: {e}"
            self._write(ws, state="error", message=tr("出错了"), error=msg[:800])
            log.exception("后台任务出错 %s", pid)
            try:
                translate.journal(ws, tr("出错停止：{msg}", msg=msg[:500]))
            except OSError:
                pass
        finally:
            with self.lock:
                if self.cancels.get(pid) is cancel:
                    self.cancels.pop(pid, None)
            self.bulk.task_done()

    def _run_bulk(self, ws: Workspace, job: dict, cancel: threading.Event):
        cfg = engine_for(config.load(), job.get("model"))
        if job.get("target"):
            cfg = {**cfg, "target": langs.valid(job["target"])}
        if cancel.is_set():
            raise Cancelled()
        if not ws.load("paper").get("meta", {}).get("pages"):
            self._write(ws, state="running", message=tr("正在渲染原页、抽取文字"))
            translate.prepare(ws)
        if cancel.is_set():
            raise Cancelled()
        read = bool(job.get("read"))
        if not job.get("translate") or cfg.get("engine") == "none":
            self._write(ws, state="done", message=tr("已导入（没有可用的模型，先放原页）") if read else tr("已导入（未开启自动翻译）") if job.get("translate") else tr("已导入"))
            return
        paper = ws.load("paper")
        all_pages = [p["n"] for p in paper["meta"]["pages"]]
        tl = paper.get("translation", {})
        # 只读原文：跳过已经整理过（或已经译过）的页；翻译：跳过已经有译文的页，只有原文的页会补译文
        skip = set(tl.get("done_pages", [])) if read else set(tl.get("done_pages", [])) - set(tl.get("en_pages", []))
        planned = job.get("pages") is not None
        wanted = job["pages"] if planned else translate.scope_pages(ws, job.get("scope")) or all_pages
        pages = wanted if planned and not job.get("cap_check") else [n for n in wanted if n not in skip]
        if not pages:
            self._write(ws, state="done", message=tr("选定范围已整理完") if read else tr("选定范围已译完"))
            return

        cap = cfg.get("page_cap", 60)
        if type(cap) is not int or cap < 0:
            cap = 60  # 手改配置写错时仍按默认上限保护，不把错误值当作不限。
        check_cap = job.get("cap_check") or (not planned and (job.get("scope") or "all") in ("all", "body"))
        if cap > 0 and len(pages) > cap and check_cap and job.get("confirmed") is not True:
            with self.lock:
                if cancel.is_set():
                    raise Cancelled()
                self._write(ws, state="confirm", total=len(pages), page_cap=cap, pages=pages, cap_check=True,
                            message=tr("这篇要整理 {n} 页，超过了你设的 {cap} 页，确认后再开始", n=len(pages), cap=cap) if read
                            else tr("这篇要译 {n} 页，超过了你设的 {cap} 页，确认后再开始", n=len(pages), cap=cap))
            return

        meter = usage.Meter(cfg.get("engine") or "")

        def report(done, total, message):
            if cancel.is_set():
                raise Cancelled()
            self._write(ws, state="running", done=done, total=total, message=message, usage=meter.snapshot())

        started = time.time()
        try:
            failed = translate.translate_pages(ws, cfg, pages, cancel, report, meter, read)
        finally:  # 取消、出错也把已经花掉的记上
            run = meter.snapshot()
            if run["calls"]:
                ws.update("job", lambda j: j.update(usage=run, usage_total=usage.merge(j.get("usage_total"), run)))
        minutes = max(1, round((time.time() - started) / 60))
        if failed:
            first = next(iter(failed.values()))
            self._write(ws, state="partial", failed={str(k): v for k, v in failed.items()}, error=first,
                        message=(tr("{ok} 页好了，", ok=len(pages) - len(failed)) if len(failed) < len(pages) else "")
                        + (tr("{n} 页没整理成功", n=len(failed)) if read else tr("{n} 页没译成功", n=len(failed))))
        else:
            self._write(ws, state="done", failed={}, error="",
                        message=tr("原文整理完成（{n} 页，用时约 {m} 分钟）", n=len(pages), m=minutes) if read
                        else tr("翻译完成（{n} 页，用时约 {m} 分钟）", n=len(pages), m=minutes))

    # ---------- 小任务 ----------
    def submit_small(self, kind: str, pid: str, **kw) -> dict:
        job = {"id": "j" + uuid4().hex, "kind": kind, "pid": pid, "state": "queued", "message": tr("排队中"),
               "done": 0, "total": 0, "at": now_iso(), **kw}
        with self.lock:
            self.recent = ([job] + self.recent)[:50]
        cancel_evt = self.small_cancels.setdefault(job["id"], threading.Event())
        if kind == "smart-annotate":
            try:
                from .research import tasks as rtasks
                scope = rtasks.scope_id(self.lib.root)
                rtasks.register_external(job["id"], "smart-annotate", scope=scope, key=pid, paper_id=pid,
                                         title=kw.get("title", ""), cancel_event=cancel_evt)
            except Exception:
                pass
        self.small.put(job)
        return job

    def cancel_small(self, job_id: str) -> bool:
        """取消仍在執行的小任務；已寫入的候選會保留。"""
        with self.lock:
            job = next((x for x in self.recent if x.get("id") == job_id), None)
            if not job or job.get("state") not in ("queued", "running"):
                return False
            self.small_cancels.setdefault(job_id, threading.Event()).set()
            job["message"] = tr("正在取消")
            if job.get("kind") == "smart-annotate":
                try:
                    from .research import tasks as rtasks
                    rtasks.update_external(job_id, state="cancelling", phase="cancelling", message=tr("正在取消工作…"))
                except Exception:
                    pass
            return True

    def small_status(self, pid: str | None = None) -> list[dict]:
        with self.lock:
            return [dict(j) for j in self.recent if not pid or j["pid"] == pid]

    def busy(self) -> bool:
        """还有整篇翻译或小任务没做完（关页自动退出时要等它们）。"""
        if self.cancels or not self.bulk.empty() or not self.small.empty():
            return True
        with self.lock:
            return any(j["state"] in ("queued", "running") for j in self.recent)

    def _small_loop(self):
        while True:
            job = self.small.get()
            ws = self.lib.ws(job["pid"])
            if not ws:
                job["state"], job["message"] = "error", tr("文献已移除，无法执行任务")
                continue
            cancel = self.small_cancels.setdefault(job["id"], threading.Event())
            job["state"], job["message"] = "running", tr("模型思考中")
            if job.get("kind") == "smart-annotate":
                try:
                    from .research import tasks as rtasks
                    rtasks.update_external(job["id"], state="running", phase="running", message=tr("模型思考中"))
                except Exception:
                    pass
            try:
                if cancel.is_set():
                    raise Cancelled()
                cfg = config.load()
                if job["kind"] == "answer":
                    translate.answer(ws, cfg, job["note"], None)
                elif job["kind"] == "retranslate":
                    translate.retranslate(ws, cfg, job["key"], job.get("hint", ""), None)
                elif job["kind"] == "smart-annotate":
                    from . import smart_annotations

                    def on_progress(done_chunks: int, total_chunks: int, count: int) -> None:
                        with self.lock:
                            job["done"] = done_chunks
                            job["total"] = total_chunks
                            job["saved"] = count
                            if total_chunks > 0:
                                if done_chunks < total_chunks:
                                    job["message"] = f"正在分析第 {done_chunks + 1} / {total_chunks} 批..."  # i18n-ok
                                else:
                                    job["message"] = tr("完成")
                            if job.get("kind") == "smart-annotate":
                                try:
                                    from .research import tasks as rtasks
                                    rtasks.update_external(job["id"], done=done_chunks, total=total_chunks, message=job["message"])
                                except Exception:
                                    pass

                    result = smart_annotations.generate(
                        ws, scope=job.get("scope", "all"), section_id=job.get("section_id", ""),
                        mode=job.get("mode", "auto"), purpose=job.get("purpose", ""),
                        intensity=job.get("intensity", "standard"),
                        model_id=job.get("model", ""), cancel=cancel,
                        on_progress=on_progress,
                    )
                    job["result"] = result
                    job["done"] = job.get("total", 0)
                if cancel.is_set():
                    raise Cancelled()
                job["state"], job["message"] = "done", tr("完成")
                if job.get("kind") == "smart-annotate":
                    try:
                        from .research import tasks as rtasks
                        rtasks.update_external(job["id"], state="completed", phase="completed", done=job.get("total", 0),
                                               message=tr("完成"), result=job.get("result"))
                    except Exception:
                        pass
            except Cancelled:
                job["state"], job["message"] = "cancelled", tr("已取消")
                if job.get("kind") == "smart-annotate":
                    try:
                        from .research import tasks as rtasks
                        rtasks.update_external(job["id"], state="cancelled", phase="cancelled", message=tr("已取消"))
                    except Exception:
                        pass
            except Exception as e:  # noqa: BLE001
                job["state"], job["message"] = "error", str(e)[:500]
                if job.get("kind") == "smart-annotate":
                    try:
                        from .research import tasks as rtasks
                        rtasks.update_external(job["id"], state="failed", phase="failed", message=str(e)[:500])
                    except Exception:
                        pass
                log.exception("小任务出错 %s", job.get("kind"))
            finally:
                with self.lock:
                    self.small_cancels.pop(job["id"], None)
