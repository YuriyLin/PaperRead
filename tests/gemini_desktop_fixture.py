"""Fresh, synthetic Electron fixture. All model traffic is fake at the HTTP boundary."""
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from easyread import gemini_validation as validation


def main():
    parent = ROOT / ".paperread-local-test"
    parent.mkdir(exist_ok=True)
    # Never reuse or overwrite either a user validation profile or Mock data.
    validation.PROFILE = Path(tempfile.mkdtemp(prefix="gemini-desktop-smoke-", dir=parent)).resolve()
    validation.configure("GeminiValidation")
    validation.initialize()
    from easyread import http
    from tests.test_gemini_validation import fake_response, KEY, MODEL
    from tests.test_table_translation import make_table_pdf
    path = validation.PROFILE / "inbox/page.pdf"
    make_table_pdf(path)
    ws = validation.prepare(path, original_page=9)
    table = validation.table_list(ws)[0]["id"]
    with mock.patch.object(http, "_validation_open", side_effect=fake_response), \
            mock.patch.object(socket.socket, "connect", side_effect=AssertionError("No network")):
        result = validation.execute(ws, table, MODEL, lambda: True, lambda: KEY)
        if result["translated"] != 1 or result["http_attempts"] != 1:
            raise RuntimeError("Mock fixture validation failed")
        cached = validation.execute(ws, table, MODEL, lambda: False, lambda: None)
        if cached["cached"] != 1 or cached["http_attempts"]:
            raise RuntimeError("Fixture cache validation failed")
    ws.update("paper", lambda p: p["meta"].update(validation_evidence={"transport": "mock", "http_attempts": 1}))
    print(json.dumps({"profile": str(validation.PROFILE), "paper": ws.id, "table": table}))


if __name__ == "__main__":
    main()
