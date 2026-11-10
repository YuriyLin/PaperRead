from __future__ import annotations

import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from easyread import planning_store, research_v2
from easyread.research import api, tasks


class ResearchTaskTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        planning_store.init(self.root)
        fake_ws = SimpleNamespace(load=lambda kind: {"meta": {"title_zh": "測試論文"}, "blocks": [{"text": "段落"}]})
        self.app = SimpleNamespace(lib=SimpleNamespace(root=self.root, all=lambda: [], ws=lambda pid: fake_ws))

    def tearDown(self):
        try:
            self.temp.cleanup()
        except OSError:
            pass

    def _wait_for(self, predicate, timeout=2):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            value = predicate()
            if value:
                return value
            time.sleep(.01)
        self.fail("background research task did not reach the expected state")

    def test_task_scope_isolation_deduplication_and_acknowledgement(self):
        scope = tasks.scope_id(self.root)
        other_scope = tasks.scope_id(self.root / "other")
        release = threading.Event()
        started = threading.Event()

        def runner(cancel, report):
            started.set()
            release.wait(1)
            return {"ok": True}

        first = tasks.submit("comparison", runner, scope=scope)
        self.assertTrue(started.wait(1))
        duplicate = tasks.submit("comparison", runner, scope=scope)
        other = tasks.submit("comparison", lambda cancel, report: {"ok": True}, scope=other_scope)
        self.assertEqual(first["id"], duplicate["id"])
        self.assertEqual([item["id"] for item in tasks.list_tasks(scope=scope)], [first["id"]])
        self.assertIsNone(tasks.get(other["id"], scope=scope))
        self.assertIsNone(tasks.cancel(other["id"], scope=scope))
        release.set()
        done = self._wait_for(lambda: (lambda task: task if task and task["state"] == "completed" else None)(
            tasks.get(first["id"], scope=scope)))
        self.assertTrue(tasks.acknowledge(done["id"], scope=scope)["acknowledged"])

    def test_reading_path_task_endpoint_persists_and_recovers_completion(self):
        original_post = research_v2.post

        def mocked_path(app, endpoint, body, *, _cancel=None, _report=None):
            _report("planning", 3, 5, "AI 正在規劃閱讀順序。")
            return {"results": [{"paper_key": "openalex:W1"}], "path_id": "path-1", "revision": 1,
                    "warning": "部分搜尋資料使用快取。"}

        with mock.patch("easyread.research_v2.post", side_effect=mocked_path):
            submitted = original_post(self.app, "/reading-path/tasks", {
                "topic": "vision", "candidate_papers": [], "search_results": [],
            })["task"]
            self.assertIn(submitted["state"], ("queued", "running", "completed"))
            completed = self._wait_for(lambda: (lambda task: task if task and task["id"] == submitted["id"]
                and task["state"] == "completed" else None)(research_v2.get(
                    self.app, research_v2.PREFIX + "/reading-path/tasks/current")["task"]))

        self.assertEqual(completed["result"]["path_id"], "path-1")
        self.assertEqual(completed["result"]["warning"], "部分搜尋資料使用快取。")
        acked = original_post(self.app, f"/reading-path/tasks/{submitted['id']}/ack", {})["task"]
        self.assertTrue(acked["acknowledged"])

    def test_reading_path_current_marks_lost_active_task_interrupted_and_retains_retry_input(self):
        from easyread.research.tasks import scope_id
        request = {"topic": "vision", "candidate_papers": []}
        interrupted = {"id": "lost-task", "kind": "reading-path", "scope": scope_id(self.root),
                       "state": "running", "phase": "planning", "message": "running"}
        research_v2._persist_reading_path_task(self.root, request, interrupted)
        current = research_v2.get(self.app, research_v2.PREFIX + "/reading-path/tasks/current")["task"]
        self.assertEqual(current["state"], "interrupted")
        self.assertEqual(current["request"], request)

    def test_mindmap_task_endpoint_persists_and_recovers_completion(self):
        fake_ws = SimpleNamespace(load=lambda kind: {"meta": {"title_zh": "注意力機制論文"}, "blocks": [{"text": "這是測試段落"}]})
        self.app.lib.ws = lambda pid: fake_ws
        original_post = research_v2.post

        def mocked_post(app, endpoint, body, *, _cancel=None, _report=None):
            if endpoint.startswith("/paper/") and endpoint.endswith("/mindmap"):
                _report("generating", 1, 2, "正在依據論文內文產生心智圖…")
                return {"mermaid": "mindmap\n  root((注意力機制論文))", "title": "注意力機制論文", "paper_id": "p-100", "cached": False}
            return original_post(app, endpoint, body, _cancel=_cancel, _report=_report)

        with mock.patch("easyread.research_v2.post", side_effect=mocked_post):
            submitted = original_post(self.app, "/paper/p-100/mindmap/tasks", {})["task"]
            self.assertIn(submitted["state"], ("queued", "running", "completed"))
            completed = self._wait_for(lambda: (lambda task: task if task and task["id"] == submitted["id"]
                and task["state"] == "completed" else None)(research_v2.get(
                    self.app, research_v2.PREFIX + "/paper/p-100/mindmap/tasks/current")["task"]))

        self.assertEqual(completed["paper_id"], "p-100")
        self.assertIn("mindmap", completed["result"]["mermaid"])
        acked = original_post(self.app, f"/paper/p-100/mindmap/tasks/{submitted['id']}/ack", {})["task"]
        self.assertTrue(acked["acknowledged"])

    def test_mindmap_ack_survives_late_task_persistence(self):
        cache_key = research_v2.MINDMAP_TASK_CACHE_PREFIX + "p-race"
        task = {"id": "mindmap-race", "kind": "mindmap", "state": "completed", "paper_id": "p-race",
                "result": {"mermaid": "mindmap\n  root((測試))"}}
        request = {"model": "test-model"}
        research_v2._persist_mindmap_task(self.root, "p-race", request, task)

        persist_read = threading.Event()
        release_persist = threading.Event()
        ack_lock_attempt = threading.Event()
        ack_done = threading.Event()
        ack_result = {}
        errors = []
        cache_lock = threading.Lock()

        class ObservedLock:
            def __enter__(self):
                if threading.current_thread().name == "mindmap-ack-race":
                    ack_lock_attempt.set()
                cache_lock.acquire()

            def __exit__(self, *_):
                cache_lock.release()

        original_cache_get = planning_store.cache_get

        def delayed_cache_get(root, key):
            result = original_cache_get(root, key)
            if key == cache_key and threading.current_thread().name == "mindmap-late-persist":
                persist_read.set()
                if not release_persist.wait(2):
                    raise TimeoutError("test did not release the late task update")
            return result

        def persist_late_update():
            try:
                research_v2._persist_mindmap_task(self.root, "p-race", request, task)
            except Exception as error:  # noqa: BLE001
                errors.append(error)

        def acknowledge():
            try:
                ack_result["response"] = research_v2.post(
                    self.app, "/paper/p-race/mindmap/tasks/mindmap-race/ack", {})
            except Exception as error:  # noqa: BLE001
                errors.append(error)
            finally:
                ack_done.set()

        with mock.patch.object(planning_store, "cache_get", side_effect=delayed_cache_get), \
                mock.patch.object(research_v2, "_MINDMAP_TASK_CACHE_LOCK", ObservedLock()):
            persist_thread = threading.Thread(target=persist_late_update, name="mindmap-late-persist")
            persist_thread.start()
            self.assertTrue(persist_read.wait(1))
            ack_thread = threading.Thread(target=acknowledge, name="mindmap-ack-race")
            ack_thread.start()
            self.assertTrue(ack_lock_attempt.wait(1))
            self.assertFalse(ack_done.wait(.05))
            release_persist.set()
            persist_thread.join(1)
            ack_thread.join(1)

        self.assertFalse(persist_thread.is_alive())
        self.assertFalse(ack_thread.is_alive())
        self.assertEqual(errors, [])
        self.assertTrue(ack_result["response"]["task"]["acknowledged"])
        self.assertTrue(original_cache_get(self.root, cache_key)[0]["acknowledged"])

    def test_mindmap_current_marks_lost_active_task_interrupted(self):
        from easyread.research.tasks import scope_id
        request = {"model": "test-model"}
        interrupted = {"id": "lost-map-task", "kind": "mindmap", "scope": scope_id(self.root),
                       "paper_id": "p-200", "state": "running", "phase": "generating", "message": "running"}
        research_v2._persist_mindmap_task(self.root, "p-200", request, interrupted)
        current = research_v2.get(self.app, research_v2.PREFIX + "/paper/p-200/mindmap/tasks/current")["task"]
        self.assertEqual(current["state"], "interrupted")
        self.assertEqual(current["request"], request)

    def test_research_monitor_only_lists_tasks_for_current_library(self):
        scope = tasks.scope_id(self.root)
        release = threading.Event()
        current = tasks.submit("comparison", lambda cancel, report: release.wait(.4), scope=scope)
        other = tasks.submit("comparison", lambda cancel, report: release.wait(.4), scope=tasks.scope_id(self.root / "other"))
        monitor = api.get(self.app, "/api/research/v1/monitor")
        self.assertEqual(monitor["scope_id"], scope)
        self.assertEqual([item["id"] for item in monitor["tasks"]], [current["id"]])
        release.set()

    def test_reading_path_endpoint_rejects_non_list_candidate_data(self):
        with self.assertRaises(ValueError):
            research_v2.post(self.app, "/reading-path/tasks", {"topic": "vision", "candidate_papers": 123})

    def test_balanced_candidate_selection_deduplicates_and_keeps_each_source_represented(self):
        seed = {"id": "https://openalex.org/W100", "title": "Seed"}
        candidates = [{"doi": "10.1/shared", "title": "Shared", "openalex_id": "https://openalex.org/W101"}]
        references = [{"id": "https://openalex.org/W101", "doi": "https://doi.org/10.1/shared", "title": "Shared source record"},
                      {"id": "https://openalex.org/W102", "title": "Reference"}]
        related = [{"id": "https://openalex.org/W103", "title": "Related"}]
        searched = [{"id": "https://openalex.org/W104", "title": "Search result"}]
        selected = research_v2._balanced_candidates(seed, candidates, references, related, searched, limit=5)
        self.assertEqual([item["title"] for item in selected], ["Seed", "Shared source record", "Reference", "Related", "Search result"])
        self.assertEqual(len({research_v2._key(item) for item in selected}), 5)

    def test_identifier_lookup_uses_fresh_cache_without_repeating_openalex_call(self):
        work = {"id": "https://openalex.org/W100", "title": "Cached paper"}
        with mock.patch.object(research_v2, "_openalex", return_value=work) as openalex:
            first = research_v2._identifier_search(self.root, "https://openalex.org/W100")
            second = research_v2._identifier_search(self.root, "W100")
        self.assertEqual(openalex.call_count, 1)
        self.assertTrue(second["cached"])
        self.assertEqual(first["results"][0]["title"], second["results"][0]["title"])


if __name__ == "__main__":
    unittest.main()
