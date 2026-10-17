"""All Gemini requests are fake; no credentials or user libraries are used."""
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

from pypdf import PdfWriter
from easyread import config, engines, gemini_validation as validation, http, openai_api, review_policy, tables
from tests.test_table_translation import make_table_pdf, mock_translation

KEY = "FAKE_TEST_KEY_never_store_52319"
MODEL = "gemini-test-model"


class Response(io.BytesIO):
    status = 200


def fake_response(request, timeout):
    body = json.loads(request.data)
    text = mock_translation({}, body["messages"][0]["content"], None)
    return Response(json.dumps({"choices": [{"message": {"content": text}, "finish_reason": "stop"}]}).encode())


class GeminiValidationTest(unittest.TestCase):
    def setUp(self):
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        self.enter = stack.enter_context
        root = Path(self.enter(tempfile.TemporaryDirectory())).resolve() / "profile"
        self.enter(mock.patch.object(validation, "PROFILE", root))
        self.enter(mock.patch.dict(os.environ, {}))
        validation.configure("GeminiValidation")
        for name, path in (("HOME", root / "home"), ("CONFIG_PATH", root / "home/config.json"),
                           ("LOG_PATH", root / "home/easyread.log"), ("SERVER_INFO", root / "home/.server.json")):
            self.enter(mock.patch.object(config, name, path))
        validation.initialize()
        self.pdf = root / "inbox/page.pdf"
        make_table_pdf(self.pdf)
        self.ws = validation.prepare(self.pdf, original_page=9)
        self.table = validation.table_list(self.ws)[0]["id"]
        self.confirm = mock.Mock(return_value=True)
        self.read_key = mock.Mock(return_value=KEY)

    def run_table(self, **kw):
        return validation.execute(self.ws, kw.get("table", self.table), MODEL, self.confirm, self.read_key)

    def assert_no_key_on_disk(self):
        for path in validation.PROFILE.rglob("*"):
            if path.is_file():
                self.assertNotIn(KEY.encode(), path.read_bytes(), str(path))
        self.assertNotIn(KEY, json.dumps(dict(os.environ)))

    def test_success_saves_native_bilingual_block_invariants_and_provenance(self):
        before = copy.deepcopy(self.ws.load("paper")["blocks"][0])
        with mock.patch.object(http, "_validation_open", side_effect=fake_response) as send:
            result = self.run_table()
        self.assertEqual(result["translated"], 1)
        self.assertEqual(result["http_attempts"], 1)
        self.assertEqual(send.call_count, 1)
        self.assertEqual(send.call_args.args[0].full_url, http.GEMINI_VALIDATION_URL)
        self.assertEqual(send.call_args.args[0].get_header("Authorization"), "Bearer " + KEY)
        block = self.ws.load("paper")["blocks"][0]
        for field in ("head_en", "rows_en", "footnotes_en", "head", "rows", "caption_en"):
            self.assertEqual(block.get(field), before.get(field))
        self.assertIsNone(tables.translation_problem(block))
        self.assertEqual(block["rows_zh"][0][1:], ["1.20", "0.045"])
        self.assertEqual(block["rows_zh"][1][1:], ["-0.50", "0.060"])
        self.assertEqual(block["table_status"], "ready")
        self.assertEqual(block["table_cache"]["validation"]["model"], MODEL)
        meta = self.ws.load("paper")["meta"]
        self.assertEqual(meta["validation_source"]["test_pdf_page"], 1)
        self.assertEqual(meta["validation_source"]["original_paper_page"], 9)
        self.assertEqual(block["page"], 1)
        self.assert_no_key_on_disk()

    def test_cache_hit_after_reopen_has_zero_requests_no_key_or_confirmation(self):
        with mock.patch.object(http, "_validation_open", side_effect=fake_response):
            self.assertEqual(self.run_table()["translated"], 1)
        self.ws = validation.prepare(self.pdf, original_page=9)
        self.confirm.reset_mock(); self.read_key.reset_mock()
        before = self.ws.paper_path.read_bytes()
        with mock.patch.object(http, "_validation_open", side_effect=AssertionError("cache must not send")) as send:
            result = self.run_table()
        self.assertEqual(result["cached"], 1)
        self.assertEqual(result["http_attempts"], 0)
        send.assert_not_called(); self.confirm.assert_not_called(); self.read_key.assert_not_called()
        self.assertEqual(self.ws.paper_path.read_bytes(), before)

    def test_mock_mode_and_missing_selection_never_read_key_or_send(self):
        for mode, table in (("Mock", self.table), ("RealModelValidation", self.table), ("GeminiValidation", "missing")):
            with mock.patch.dict(os.environ, {"PAPERREAD_REVIEW_MODE": mode}), \
                    mock.patch.object(http, "_validation_open") as send, self.assertRaises(validation.ValidationError):
                self.run_table(table=table)
            send.assert_not_called()
        self.read_key.assert_not_called()
        self.assertEqual(validation.table_list(self.ws)[0]["status"], "ready")

    def test_cancelled_confirmation_preserves_original_and_never_reads_key(self):
        self.confirm.return_value = False
        with mock.patch.object(http, "_validation_open") as send:
            result = self.run_table()
        self.assertTrue(result["failed"])
        self.assertEqual(result["http_attempts"], 0)
        self.read_key.assert_not_called(); send.assert_not_called()
        self.assertNotIn("table_cache", self.ws.load("paper")["blocks"][0])

    def test_http_error_stops_once_without_leaking_provider_body_or_key(self):
        error = urllib.error.HTTPError(http.GEMINI_VALIDATION_URL, 429, KEY, {}, io.BytesIO(KEY.encode()))
        with mock.patch.object(http, "_validation_open", side_effect=error) as send:
            result = self.run_table()
        self.assertEqual(send.call_count, 1)
        self.assertEqual(result["http_attempts"], 1)
        self.assertTrue(result["failed"])
        self.assertNotIn(KEY, str(result))
        self.assert_no_key_on_disk()

    def test_malformed_incomplete_and_credential_echo_responses_never_commit(self):
        escaped_key = "".join("\\u%04x" % ord(c) for c in KEY)
        variants = [b"broken JSON", json.dumps({"secret": KEY}).encode(),
                    json.dumps({"choices": [{"message": {"content": '{"zh":{"caption":"' + escaped_key + '"}}'}, "finish_reason": "stop"}]}).encode(),
                    json.dumps({"choices": [{"message": {"content": '{"zh":{"caption":"bad\\q"}}'}, "finish_reason": "stop"}]}).encode(),
                    json.dumps({"choices": [{"message": {"content": "{}"}, "finish_reason": "length"}]}).encode(),
                    json.dumps({"choices": [{"message": {"content": '{"zh":{}}'}, "finish_reason": "stop"}]}).encode()]
        for raw in variants:
            with self.subTest(raw=raw[:10]), mock.patch.object(http, "_validation_open", return_value=Response(raw)) as send:
                result = self.run_table()
            self.assertTrue(result["failed"])
            self.assertEqual(result["http_attempts"], 1)
            self.assertEqual(send.call_count, 1)
            block = self.ws.load("paper")["blocks"][0]
            self.assertEqual(block["table_status"], "fallback")
            self.assertNotIn("table_cache", block)
            self.assertNotIn("rows_zh", block)
            self.assertNotIn(KEY, str(result))
        self.assert_no_key_on_disk()

    def test_changed_mask_or_added_number_is_rejected_without_repair(self):
        def wrong(request, timeout):
            body = json.loads(request.data)
            content = json.loads(mock_translation({}, body["messages"][0]["content"], None))
            content["zh"]["caption"] += " 999"
            return Response(json.dumps({"choices": [{"message": {"content": json.dumps(content)}, "finish_reason": "stop"}]}).encode())
        with mock.patch.object(http, "_validation_open", side_effect=wrong) as send:
            result = self.run_table()
        self.assertTrue(result["failed"])
        self.assertEqual(send.call_count, 1)
        self.assertNotIn("rows_zh", self.ws.load("paper")["blocks"][0])

    def test_unreliable_table_stops_before_authorization(self):
        other = validation.PROFILE / "inbox/merged.pdf"
        make_table_pdf(other, merged=True)
        self.ws = validation.prepare(other)
        self.table = validation.table_list(self.ws)[0]["id"]
        with self.assertRaises(ValueError), mock.patch.object(http, "_validation_open") as send:
            self.run_table()
        self.confirm.assert_not_called(); self.read_key.assert_not_called(); send.assert_not_called()

    def test_external_multi_page_and_missing_inputs_are_rejected(self):
        outside = validation.PROFILE.parent / "outside.pdf"
        outside.write_bytes(self.pdf.read_bytes())
        multiple = validation.PROFILE / "inbox/multi.pdf"
        pdf = PdfWriter(); pdf.add_blank_page(300, 300); pdf.add_blank_page(300, 300); pdf.write(multiple)
        for path in (outside, multiple, validation.PROFILE / "inbox/missing.pdf"):
            with self.subTest(path=path), self.assertRaises(validation.ValidationError):
                validation.prepare(path)

    def test_junctions_and_hardlinks_are_rejected_before_pdf_read(self):
        outside = validation.PROFILE.parent / "outside"
        outside.mkdir()
        alias = validation.PROFILE / "inbox/alias"
        if os.name == "nt":
            import _winapi
            _winapi.CreateJunction(str(outside), str(alias))
        else:
            alias.symlink_to(outside, target_is_directory=True)
        with mock.patch.object(Path, "read_bytes", side_effect=AssertionError("redirected read")), self.assertRaises(validation.ValidationError):
            validation.prepare(alias / "page.pdf")
        alias.rmdir() if os.name == "nt" else alias.unlink()
        link = validation.PROFILE / "inbox/hard.pdf"
        os.link(self.pdf, link)
        with self.assertRaises(validation.ValidationError):
            validation.prepare(link)

    def test_origin_is_never_silently_reassigned(self):
        with self.assertRaises(validation.ValidationError):
            validation.prepare(self.pdf, original_page=10)
        self.assertEqual(self.ws.load("paper")["meta"]["validation_source"]["original_paper_page"], 9)

    def test_other_tables_are_never_sent_or_modified(self):
        other = copy.deepcopy(self.ws.load("paper")["blocks"][0])
        other.update(id="other-table", num="2", caption_en="UNSELECTED PRIVATE TABLE")
        self.ws.update("paper", lambda p: p["blocks"].append(other))
        def selected_only(request, timeout):
            self.assertNotIn(b"UNSELECTED", request.data)
            return fake_response(request, timeout)
        with mock.patch.object(http, "_validation_open", side_effect=selected_only) as send:
            self.assertEqual(self.run_table()["translated"], 1)
        self.assertEqual(send.call_count, 1)
        self.assertEqual(self.ws.load("paper")["blocks"][1], other)

    def test_cli_never_prints_key_or_provider_error_body(self):
        from scripts import validate_gemini_table as command
        import sys
        output = io.StringIO()
        args = ["validate_gemini_table.py", "--run", "--mode", "GeminiValidation", "--pdf", str(self.pdf),
                "--original-page", "9", "--table", self.table, "--model", MODEL]
        error = urllib.error.HTTPError(http.GEMINI_VALIDATION_URL, 403, KEY, {}, io.BytesIO(KEY.encode()))
        with mock.patch.object(sys, "argv", args), mock.patch("builtins.input", return_value="SEND"), \
                mock.patch.object(command.getpass, "getpass", return_value=KEY), \
                mock.patch.object(http, "_validation_open", side_effect=error), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            self.assertEqual(command.main(), 1)
        self.assertNotIn(KEY, output.getvalue())
        self.assert_no_key_on_disk()

    def authorization(self):
        body = {"model": MODEL, "messages": [{"role": "user", "content": "selected table"}]}
        permit = validation.Authorization(validation._TOKEN, self.ws, self.table, MODEL, "selected table", KEY)
        return body, permit

    def test_budget_is_enforced_at_bottom_transport_including_concurrent_calls(self):
        body, permit = self.authorization()
        response = b'{"choices":[{"message":{"content":"{}"}}]}'
        with mock.patch.object(http, "_validation_open", side_effect=lambda *a, **k: Response(response)) as send:
            def call(_):
                try:
                    http.gemini_validation_post(body, permit)
                    return "sent"
                except validation.ValidationError:
                    return "blocked"
            with ThreadPoolExecutor(2) as pool:
                states = list(pool.map(call, range(2)))
        self.assertEqual(sorted(states), ["blocked", "sent"])
        self.assertEqual(permit.attempts, 1)
        self.assertEqual(send.call_count, 1)
        self.assertEqual(permit._key, "")

    def test_forged_permit_modified_payload_or_source_never_sends(self):
        body, permit = self.authorization()
        with mock.patch.object(http, "_validation_open") as send:
            with self.assertRaises(validation.ValidationError):
                http.gemini_validation_post(body, object())
            with self.assertRaises(validation.ValidationError):
                http.gemini_validation_post({**body, "tools": []}, permit)
            self.pdf.write_bytes(b"changed")
            with self.assertRaises(validation.ValidationError):
                http.gemini_validation_post(body, permit)
        send.assert_not_called()
        self.assertEqual(permit.attempts, 0)

    def test_redirects_and_generic_engines_remain_blocked(self):
        self.assertIsNone(http._NoRedirect().redirect_request(None, None, 307, "redirect", {}, "https://other.invalid"))
        with self.assertRaises(engines.EngineError):
            engines.run({"engine": "openai"}, "no", self.ws.root)
        with self.assertRaises(engines.EngineError):
            openai_api.complete({"api_key": KEY}, "no", [])

    def test_results_viewer_denies_model_import_export_and_vault_routes(self):
        with mock.patch.dict(os.environ, {"PAPERREAD_REVIEW_MODE": "Mock", "PAPERREAD_REVIEW_KIND": "GeminiResults"}):
            for route in ("/api/import", "/api/config", "/api/p/abcd/translate", "/api/p/abcd/chat", "/api/research/vault"):
                self.assertFalse(review_policy.results_route_allowed("POST", route), route)
            for route in ("/research", "/api/update", "/api/p/abcd/export", "/api/research/index"):
                self.assertFalse(review_policy.results_route_allowed("GET", route), route)
            self.assertTrue(review_policy.results_route_allowed("GET", "/api/p/abcd/state"))
            self.assertTrue(review_policy.results_route_allowed("GET", "/p/abcd/source.pdf"))
            self.assertTrue(review_policy.results_route_allowed("POST", "/api/p/abcd/ops"))


if __name__ == "__main__":
    unittest.main()
