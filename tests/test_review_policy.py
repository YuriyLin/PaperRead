"""No CLI, credentials, production library or model traffic in these tests."""
import contextlib
import os
import queue
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from easyread import chat, cli_models, config, detect, engines, jobs, library_api, netcheck, openai_api, translate, translate_api
from easyread.research import store as research_store


class ReviewPolicyTest(unittest.TestCase):
    def setUp(self):
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        self.enter = stack.enter_context
        self.root = Path(self.enter(tempfile.TemporaryDirectory())) / "profile"
        self.enter(mock.patch.dict(os.environ, {"PAPERREAD_TEST_PROFILE": str(self.root),
            "PAPERREAD_REVIEW_MODE": "Mock", "PAPERREAD_OFFLINE_TEST": "0"}))

    def test_every_transport_rejects_even_without_offline_flag(self):
        cfg = config._merge(config.DEFAULTS, {"engine": "codex"})
        with mock.patch.object(subprocess, "Popen", side_effect=AssertionError("real process")), \
                mock.patch.object(netcheck, "problem", side_effect=AssertionError("preflight")), \
                mock.patch.object(research_store.prefs, "load", side_effect=AssertionError("locale prefs read")), \
                mock.patch.dict(os.environ, {"EASYREAD_LANG": "auto"}):
            for mode in ("Mock", "RealModelValidation", "unknown"):
                with mock.patch.dict(os.environ, {"PAPERREAD_REVIEW_MODE": mode}):
                    calls = [lambda: engines.run(cfg, "test", self.root),
                             lambda: engines._run(cfg, "test", self.root, [], None, None),
                             lambda: engines.run_codex(cfg["codex"], "test", self.root, []),
                             lambda: engines.run_claude(cfg["claude"], "test", self.root),
                             lambda: engines.run_openai(cfg["openai"], "test", []),
                             lambda: openai_api.complete(cfg["openai"], "test", []),
                             lambda: openai_api.models(cfg["openai"]),
                             lambda: list(openai_api.stream(cfg["openai"], "test", threading.Event())),
                             lambda: engines._codex_once("fake", cfg["codex"], "test", self.root, [], None, []),
                             lambda: list(chat._stream_claude(cfg["claude"], "test", self.root, threading.Event())),
                             lambda: list(chat.stream(cfg, "test", self.root, threading.Event()))]
                    for call in calls:
                        with self.subTest(mode=mode, call=call), self.assertRaises(engines.EngineError):
                            call()

    def test_real_low_level_cli_guard_in_fresh_interpreter_with_fake_subprocess(self):
        # The regression harness replaces _popen in this interpreter. Exercise
        # the real implementation in a child, with Popen replaced before use.
        import sys
        source = """
import os
from pathlib import Path
from unittest.mock import patch
from easyread import engines
with patch('subprocess.Popen', side_effect=AssertionError('real process')):
    for mode in ('Mock', 'RealModelValidation', 'unknown'):
        os.environ['PAPERREAD_REVIEW_MODE'] = mode
        try:
            engines._popen(['fake-codex', 'exec'], Path('.'))
        except engines.EngineError:
            continue
        raise AssertionError('model process allowed')
"""
        completed = subprocess.run([sys.executable, "-c", source], env=dict(os.environ),
                                   capture_output=True, text=True, timeout=20)
        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_detection_and_model_lists_do_not_probe_or_read_user_cli_config(self):
        with mock.patch.object(engines, "claude_path", side_effect=AssertionError("CLI discovery")), \
                mock.patch.object(engines, "_version", side_effect=AssertionError("CLI version")), \
                mock.patch.object(detect, "_ollama", side_effect=AssertionError("Ollama")), \
                mock.patch.object(Path, "read_text", side_effect=AssertionError("user config")):
            detect.warm(config.DEFAULTS)
            self.assertFalse(detect.detect(config.DEFAULTS, fresh=True)["codex"]["found"])
            self.assertFalse(detect._refresh(config.DEFAULTS)["claude"]["found"])
            cli_models.probe_claude({}, "fake")
            cli_models._probe("fake", "fake")
            self.assertEqual(cli_models.codex()["models"], [])
            self.assertEqual(cli_models.claude_default(), "")
            cli_models.claude()

    def test_preflight_and_page_translation_reject_before_any_network_or_paper_read(self):
        with mock.patch.object(netcheck, "target", side_effect=AssertionError("user config/network")):
            self.assertTrue(netcheck.problem(config.DEFAULTS))
        ws = SimpleNamespace(load=mock.Mock(side_effect=AssertionError("paper read")))
        with self.assertRaises(engines.EngineError):
            translate.translate_pages(ws, config.DEFAULTS, [9], threading.Event(), lambda *args: None)

    def test_restart_releases_stale_busy_state_without_resuming_old_jobs(self):
        worker = object.__new__(jobs.Jobs)
        saved = {"state": "running", "pages": [9], "tables_only": True, "done": 1}
        ws = SimpleNamespace(load=lambda _: saved)
        worker.lib = SimpleNamespace(all=lambda: [ws])
        worker._write = mock.Mock(side_effect=lambda _, **fields: saved.update(fields))
        worker.bulk = queue.Queue()
        worker._resume()
        self.assertTrue(worker.bulk.empty())
        self.assertEqual(saved["state"], "cancelled")
        self.assertEqual(saved["pages"], [9])
        self.assertEqual(saved["done"], 1)

    def test_library_location_never_detects_external_candidates(self):
        loc = object.__new__(library_api.LibraryLocation)
        loc.app = SimpleNamespace(lib=SimpleNamespace(root=self.root / "library"))
        loc.status = "idle"
        with mock.patch.object(library_api.cloudlib, "detect", side_effect=AssertionError("external library")), \
                mock.patch.object(library_api.cloudlib, "inspect", return_value={"exists": True}):
            self.assertEqual(loc.location()["candidates"], [])
        for route in ("inspect", "cleanup", "pick-folder", "move", "reveal"):
            with self.subTest(route=route), self.assertRaises(ValueError):
                library_api.post(loc.app, "/api/library/" + route, {"path": str(self.root.parent / "outside")})

    def test_vault_rejects_external_and_saved_preferences_before_mkdir(self):
        outside = self.root.parent / "outside"
        with self.assertRaises(ValueError):
            research_store.set_vault(str(outside))
        self.assertFalse(outside.exists())
        with mock.patch.object(research_store, "settings", return_value={"vault": str(outside)}), self.assertRaises(ValueError):
            research_store.vault_path()
        allowed = self.root / "vault"
        with mock.patch.object(research_store.prefs, "save"), mock.patch.object(config, "library_dir", return_value=self.root / "library"):
            self.assertEqual(research_store.set_vault(str(allowed)), allowed.resolve())

    def test_vault_junction_and_retargeted_child_are_rejected(self):
        from easyread import review_policy
        outside = self.root.parent / "outside"
        outside.mkdir()
        self.root.mkdir()
        link = self.root / "vault"
        if os.name == "nt":
            import _winapi
            _winapi.CreateJunction(str(outside), str(link))
        else:
            link.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError):
            review_policy.require_path(link / "new.md", "vault")
        with mock.patch.object(research_store, "settings", return_value={"vault": str(link)}), self.assertRaises(ValueError):
            research_store.vault_path()

    def test_runtime_status_is_not_a_saved_authorization(self):
        with mock.patch.object(config, "_saved", return_value={"engine": "codex", "auto_translate": True}):
            cfg = config.load()
        self.assertEqual(cfg["engine"], "codex")
        self.assertFalse(cfg["auto_translate"])
        public = config.public({**cfg, "review_policy": {"real_model_allowed": True}})
        self.assertEqual(public["review_policy"]["mode"], "Mock")
        self.assertFalse(public["review_policy"]["real_model_allowed"])

    def test_backend_launch_rejects_real_mode_and_missing_or_mismatched_profile_before_io(self):
        from easyread import cli, launch
        with mock.patch.object(launch, "setup_log", side_effect=AssertionError("log write")), \
                mock.patch.object(config, "load", side_effect=AssertionError("settings read")):
            for mode, profile in (("RealModelValidation", str(self.root)), ("unknown", str(self.root)),
                                  ("Mock", ""), ("Mock", str(self.root))):
                with mock.patch.dict(os.environ, {"PAPERREAD_REVIEW_MODE": mode, "PAPERREAD_TEST_PROFILE": profile}):
                    with self.subTest(mode=mode, profile=profile), self.assertRaises(ValueError):
                        launch.serve(port=0)
                    with self.subTest(entry="CLI", mode=mode, profile=profile), self.assertRaises(ValueError):
                        cli.cmd_serve(SimpleNamespace(port=0, open=False, exit_on_close=False))

    def test_no_implicit_page_scope_or_confirmed_body_can_authorize_translation(self):
        worker = SimpleNamespace(enqueue=mock.Mock(side_effect=AssertionError("queued task")))
        ws = SimpleNamespace(load=mock.Mock(side_effect=AssertionError("paper read")))
        for body in ({}, {"tables_only": True}, {"confirmed": True}, {"pages": ""}, {"failed": True}):
            with self.subTest(body=body), self.assertRaises(ValueError):
                translate_api.enqueue(worker, ws, body)

    def test_library_workspace_and_linked_pdf_paths_reject_external_reads(self):
        from easyread.library import Library
        from easyread.store import Workspace
        outside = self.root.parent / "outside"
        with self.assertRaises(ValueError):
            Library(outside)
        with self.assertRaises(ValueError):
            Workspace(outside)
        self.assertFalse(outside.exists())
        ws = Workspace(self.root / "library" / "paper-test")
        with mock.patch.object(ws, "load", return_value={"meta": {"source_pdf_path": str(outside / "source.pdf")}}), self.assertRaises(ValueError):
            ws.source_pdf


if __name__ == "__main__":
    unittest.main()
