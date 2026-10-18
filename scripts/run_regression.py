"""Run all Python tests with isolated storage and no external/model traffic.

Usage: .venv/Scripts/python.exe scripts/run_regression.py [tests.test_module ...]
Logs and all runtime data stay in the Git-ignored .paperread-local-test folder.
"""
from __future__ import annotations

import contextlib
import json
import os
from pathlib import Path
import socket
import sys
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / ".paperread-local-test" / "gemini-validation-final"
OUTPUT.mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(ROOT))
os.environ.update(EASYREAD_HOME=str(OUTPUT / "home"), EASYREAD_LIBRARY=str(OUTPUT / "library"),
                  EASYREAD_LANG="zh", PYTHONUTF8="1", ELECTRON_RUN_AS_NODE="1")
# Unit tests exercise offline guards explicitly; the suite also uses loopback
# fake HTTP servers. Do not globally turn off those fake transports.
os.environ.pop("PAPERREAD_OFFLINE_TEST", None)
os.environ.pop("PAPERREAD_TEST_PROFILE", None)
os.environ.pop("PAPERREAD_REVIEW_MODE", None)
os.environ.pop("PAPERREAD_REVIEW_KIND", None)
node_dir = ROOT / ".paperread-local-test" / "node-v22.20.0-win-x64"
os.environ["PATH"] = str(node_dir if node_dir.is_dir() else OUTPUT.parent / "bin") + os.pathsep + os.environ["PATH"]

connect = socket.socket.connect
resolve = socket.getaddrinfo


def local_connect(sock, address):
    if isinstance(address, tuple) and address[0] in ("127.0.0.1", "::1"):
        return connect(sock, address)
    raise AssertionError("External connections are forbidden during regression tests")


def local_resolve(host, *args, **kwargs):
    if host in ("localhost", "127.0.0.1", "::1", None):
        return resolve(host, *args, **kwargs)
    raise AssertionError("External DNS is forbidden during regression tests")


def main():
    from easyread import engines, http
    run = engines.run

    def guarded_model(*args, **kwargs):
        if engines.review_policy.isolated():
            return run(*args, **kwargs)  # Exercise the production offline guard.
        raise AssertionError("Unmocked model call")

    with contextlib.ExitStack() as stack:
        stack.enter_context(mock.patch.object(socket.socket, "connect", local_connect))
        stack.enter_context(mock.patch.object(socket, "getaddrinfo", local_resolve))
        stack.enter_context(mock.patch.object(engines, "run", side_effect=guarded_model))
        stack.enter_context(mock.patch.object(engines, "_popen", side_effect=AssertionError("Unmocked model CLI")))
        stack.enter_context(mock.patch.object(http, "_validation_open", side_effect=AssertionError("Unmocked Gemini transport")))
        suite = (unittest.defaultTestLoader.loadTestsFromNames(sys.argv[1:]) if len(sys.argv) > 1
                 else unittest.defaultTestLoader.discover(str(ROOT / "tests"), top_level_dir=str(ROOT)))
        with (OUTPUT / "python.txt").open("w", encoding="utf-8") as stream:
            result = unittest.TextTestRunner(stream=stream, verbosity=2).run(suite)
    summary = {"tests": result.testsRun, "failures": [t.id() for t, _ in result.failures],
               "errors": [t.id() for t, _ in result.errors], "skipped": [(t.id(), why) for t, why in result.skipped]}
    (OUTPUT / "python-summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary))
    if not result.wasSuccessful():
        print((OUTPUT / "python.txt").read_text(encoding="utf-8")[-24000:])
    return not result.wasSuccessful()


if __name__ == "__main__":
    sys.exit(main())
