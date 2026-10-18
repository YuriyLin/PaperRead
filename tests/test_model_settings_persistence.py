"""Settings round trips use isolated storage and mocked CLI discovery only."""
import contextlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from easyread import chat_models, config, detect, engines, server


class ModelSettingsPersistenceTest(unittest.TestCase):
    def setUp(self):
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        enter = stack.enter_context
        enter(mock.patch.dict(os.environ, {
            "PAPERREAD_OFFLINE_TEST": "1", "EASYREAD_LANG": "zh",
        }))
        temp = enter(tempfile.TemporaryDirectory())
        self.home = Path(temp) / "home"
        self.home.mkdir()
        self.library = Path(temp) / "library"
        enter(mock.patch.dict(os.environ, {
            "EASYREAD_HOME": str(self.home), "EASYREAD_LIBRARY": str(self.library),
        }))
        enter(mock.patch.object(config, "HOME", self.home))
        enter(mock.patch.object(config, "CONFIG_PATH", self.home / "config.json"))
        enter(mock.patch.object(detect, "detect", return_value={
            "claude": {"found": False}, "codex": {"found": True},
        }))
        # Do not inspect the user's CLI configuration or execute a real model.
        enter(mock.patch.object(chat_models, "actual_of", return_value=""))
        enter(mock.patch.object(chat_models, "_claude_default", return_value=""))
        enter(mock.patch.object(chat_models, "codex_default_model", return_value="gpt-6.1-sol"))
        enter(mock.patch.object(engines, "_popen", side_effect=AssertionError("Real CLI forbidden")))
        enter(mock.patch.object(engines.netcheck, "problem", side_effect=AssertionError("Transport forbidden")))
        self.initial = {
            "engine": "claude", "claude": {"model": "opus"}, "target": "fr", "page_cap": 100,
            "codex": {"command": "mock-codex", "extra_args": ["--mock"]},
            "chat": {"default": "sonnet", "models": [
                {"id": "opus", "name": "Claude Opus", "engine": "claude", "model": "opus"},
                {"id": "sonnet", "name": "Claude Sonnet", "engine": "claude", "model": "sonnet"},
                {"id": "gpt", "name": "GPT-6.1-Sol", "engine": "codex", "model": "gpt-6.1-sol",
                 "reasoning_effort": "high", "service_tier": "fast"},
            ]},
        }
        config.save(self.initial)

    def start_server(self):
        handler = type("SettingsHandler", (server.Handler,), {
            "app": SimpleNamespace(token="mock-token", lib=SimpleNamespace(),
                                   location=SimpleNamespace(request=lambda *args: contextlib.nullcontext())),
        })
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        worker = threading.Thread(target=httpd.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(worker.join, 5)
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        self.origin = f"http://127.0.0.1:{httpd.server_port}"

    def api(self, path, body=None):
        req = urllib.request.Request(self.origin + path,
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers={"X-Token": "mock-token", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as response:
            return json.load(response)

    def test_http_save_reopen_and_fresh_process_preserve_codex_without_claude(self):
        self.start_server()
        cards = self.api("/api/chat/models")
        self.assertEqual(cards["default"], "sonnet")
        self.assertFalse(cards["models"][0]["ready"])
        self.assertTrue(cards["models"][2]["ready"])
        # Same order as saveModelSettings: model cards, then translation config.
        self.api("/api/chat/models", {"models": cards["models"], "default": cards["default"], "keys": {}})
        response = self.api("/api/config", {
            "engine": "codex", "codex": {"model": "gpt-6.1-sol", "reasoning_effort": "high", "service_tier": "fast"},
        })
        self.assertEqual(json.loads(config.CONFIG_PATH.read_text(encoding="utf-8"))["engine"], "codex")
        self.assertEqual(response["config"]["engine"], "codex")
        for _ in range(2):  # Reopening must read the same saved selection.
            cfg = self.api("/api/config")["config"]
            cards = self.api("/api/chat/models")
            self.assertEqual(cfg["engine"], "codex")
            self.assertEqual(cfg["codex"]["model"], "gpt-6.1-sol")
            self.assertEqual(cards["translate"], "gpt")
            self.assertEqual(cards["default"], "sonnet")
            self.assertEqual([m["id"] for m in cards["models"]], ["opus", "sonnet", "gpt"])
            self.assertEqual((cfg["target"], cfg["page_cap"]), ("fr", 100))
            self.assertEqual(cfg["codex"]["extra_args"], ["--mock"])
        # A fresh interpreter imports config from the same profile, just as a
        # relaunched Electron backend does. No CLI discovery/model call needed.
        result = subprocess.run([sys.executable, "-c",
                                 "import json; from easyread import config; print(json.dumps(config.load()))"],
                                env=dict(os.environ), capture_output=True, text=True, check=True)
        restarted = json.loads(result.stdout)
        self.assertEqual(restarted["engine"], "codex")
        self.assertEqual(restarted["codex"]["model"], "gpt-6.1-sol")
        self.assertEqual(restarted["chat"]["default"], "sonnet")
        self.assertEqual(chat_models.translation_id(restarted), "gpt")

    def test_offline_guards_block_saved_codex_and_api_before_transport(self):
        config.save({"engine": "codex", "codex": {"model": "gpt-6.1-sol"}})
        for engine in ("codex", "openai", "claude"):
            cfg = config.load()
            cfg["engine"] = engine
            with self.subTest(engine=engine), self.assertRaises(engines.EngineError):
                engines.run(cfg, "mock", self.home)
            with self.subTest(engine=engine), self.assertRaises(engines.EngineError):
                list(server.chat.stream(cfg, "mock", self.home, threading.Event()))
        self.assertEqual(config.load()["engine"], "codex")
        self.assertFalse(config.load()["auto_translate"])
        self.assertFalse(config.load()["check_updates"])

    def test_write_failure_returns_http_error_and_preserves_previous_config(self):
        self.start_server()
        before = config.CONFIG_PATH.read_bytes()
        with mock.patch.object(config, "write_json_atomic", side_effect=OSError("mock disk failure")), \
                mock.patch.object(server.log, "exception"):
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.api("/api/config", {"engine": "codex"})
        self.assertEqual(error.exception.code, 500)
        self.assertEqual(config.CONFIG_PATH.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
