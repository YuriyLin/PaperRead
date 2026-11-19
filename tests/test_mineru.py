"""Tests for MinerU PDF parser integration, HTML table conversion, settings API, and fallback."""
from __future__ import annotations

import io
import json
import os
import shutil
import ssl
import tempfile
import threading
import unittest
import urllib.error
import zipfile
from unittest import mock

from easyread import config, engines, mineru, settings_api, translate
from tests.test_translate import make_ws


class _FakeResponse:
    def __init__(self, body: bytes, status: int = 200):
        self._body = body
        self.status = status

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def _zip_bytes(content_list: list[dict], filename: str = "paper_content_list.json") -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(filename, json.dumps(content_list, ensure_ascii=False))
    return buf.getvalue()


class MinerUTableAndConfigTest(unittest.TestCase):
    def test_html_table_expands_colspan_and_rowspan(self):
        html = """
        <table>
          <thead>
            <tr>
              <th rowspan="2">Method</th>
              <th colspan="2">Benchmark A</th>
            </tr>
            <tr>
              <th>Acc</th>
              <th>F1</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td rowspan="2">Ours</td>
              <td>91.2%</td>
              <td>89.4</td>
            </tr>
            <tr>
              <td>92.0%</td>
              <td>90.1</td>
            </tr>
          </tbody>
        </table>
        """
        head, rows, align = mineru.parse_html_table(html)
        self.assertEqual(head, [["Method", "Benchmark A", ""], ["", "Acc", "F1"]])
        self.assertEqual(rows, [["Ours", "91.2%", "89.4"], ["", "92.0%", "90.1"]])
        self.assertEqual(align, "lrr")

    def test_html_table_without_thead_keeps_grouped_colspan_headers_in_head(self):
        html = (
            "<table>"
            "<tr><td colspan=\"3\">Evaluation</td><td colspan=\"3\">Training Steps</td></tr>"
            "<tr><td>Training method</td><td>Dataset</td><td>0</td><td>100</td><td>200</td><td>300</td></tr>"
            "<tr><td>SFT</td><td>Refcoco</td><td>88.7</td><td>88.8</td><td>88.9</td><td>89.0</td></tr>"
            "<tr><td>RL</td><td>Refcoco</td><td>88.7</td><td>89.0</td><td>89.2</td><td>89.5</td></tr>"
            "</table>"
        )
        head, rows, align = mineru.parse_html_table(html)
        self.assertEqual(len(head), 2)
        self.assertEqual(head[0], ["Evaluation", "", "", "Training Steps", "", ""])
        self.assertEqual(head[1], ["Training method", "Dataset", "0", "100", "200", "300"])
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0][0], "SFT")

    def test_config_masks_mineru_token_and_preserves_on_masked_save(self):
        tmp = tempfile.mkdtemp(prefix="easyread-mineru-cfg-")
        try:
            cfg_path = f"{tmp}/config.json"
            with mock.patch.object(config, "CONFIG_PATH", __import__("pathlib").Path(cfg_path)):
                saved = settings_api.save_config({
                    "mineru": {"enabled": True, "mode": "cloud", "token": "secret-token-9876", "model_version": "vlm"},
                    "local_references": True,
                })["config"]
                self.assertEqual(saved["mineru"]["token"], "••••9876")
                self.assertTrue(saved["mineru"]["has_token"])

                # Re-saving masked token preserves real secret in config.json.
                settings_api.save_config({
                    "mineru": {"enabled": True, "mode": "cloud", "token": "••••9876", "model_version": "pipeline"},
                })
                loaded = config.load()
                self.assertEqual(loaded["mineru"]["token"], "secret-token-9876")
                self.assertEqual(loaded["mineru"]["model_version"], "pipeline")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_connection_checks_cloud_and_local(self):
        no_tok = mineru.test_connection({"enabled": True, "mode": "cloud", "token": ""})
        self.assertFalse(no_tok["ok"])

        bad_url = mineru.test_connection({"enabled": True, "mode": "local", "base_url": "ftp://invalid"})
        self.assertFalse(bad_url["ok"])

        def fake_cloud_ok(req, timeout=None, **kw):
            return _FakeResponse(json.dumps({"code": 0, "data": {}}).encode("utf-8"), 200)

        with mock.patch.object(mineru.http, "urlopen", fake_cloud_ok):
            res = mineru.test_connection({"enabled": True, "mode": "cloud", "token": "tok-123"})
        self.assertTrue(res["ok"])

        def fake_local_ok(req, timeout=None, **kw):
            return _FakeResponse(json.dumps({"paths": {"/file_parse": {}}}).encode("utf-8"), 200)

        with mock.patch.object(mineru.http, "urlopen", fake_local_ok):
            res_loc = mineru.test_connection({"enabled": True, "mode": "local", "base_url": "http://127.0.0.1:8000"})
        self.assertTrue(res_loc["ok"])


class MinerUPipelineTest(unittest.TestCase):
    def setUp(self):
        self.ws = make_ws(3)
        (self.ws.root / "source.pdf").write_bytes(b"%PDF-1.4\n%fake\n")
        (self.ws.root / "extract" / "page-001.txt").write_text("Title\nThis paper introduces a new method.", encoding="utf-8")
        (self.ws.root / "extract" / "page-002.txt").write_text("Second page experiment results.", encoding="utf-8")
        (self.ws.root / "extract" / "page-003.txt").write_text("References\n[1] Smith 2024. Paper.", encoding="utf-8")
        self.cfg = {
            "engine": "openai",
            "batch_pages": 2,
            "concurrency": 1,
            "openai": {"vision": False},
            "local_references": True,
            "mineru": {"enabled": True, "mode": "cloud", "token": "tok-abc", "model_version": "vlm", "timeout": 60},
        }
        self.patches = [
            mock.patch.object(translate.pdfwork, "locate", lambda root: None),
            mock.patch.object(translate, "tex_problems", lambda tex: []),
            mock.patch.object(translate.netcheck, "problem", return_value=None),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        shutil.rmtree(self.ws.root, ignore_errors=True)

    def test_cloud_v4_upload_headers_figure_crop_and_text_only_translation(self):
        sample_items = [
            {"type": "text", "text_level": 1, "text": "My Awesome Paper", "page_idx": 0},
            {"type": "text", "text_level": 0, "text": "This paper introduces a new method.", "page_idx": 0},
            {"type": "image", "bbox": [100, 200, 900, 600], "image_caption": ["Figure 1: System overview."], "page_idx": 0},
            {
                "type": "table",
                "table_caption": ["Table 1: Benchmark scores."],
                "table_body": "<table><thead><tr><th>Model</th><th>Score</th></tr></thead><tbody><tr><td>Ours</td><td>95.0</td></tr></tbody></table>",
                "table_footnote": ["Best scores are bold."],
                "page_idx": 1,
            },
            {"type": "interline_equation", "text": "$$E = mc^2 \\tag{1}$$", "page_idx": 1},
        ]
        zip_payload = _zip_bytes(sample_items)
        oss_headers_seen = []

        def fake_urlopen(req, timeout=None, **kw):
            url = req.full_url
            method = req.get_method()
            if url.endswith("/api/v4/file-urls/batch") and method == "POST":
                return _FakeResponse(json.dumps({
                    "code": 0,
                    "data": {"batch_id": "b123", "file_urls": ["https://oss.example.com/presigned?sig=1"]},
                }).encode("utf-8"))
            if url.endswith("/api/v4/extract-results/batch/b123"):
                return _FakeResponse(json.dumps({
                    "code": 0,
                    "data": {"extract_result": [{"state": "done", "full_zip_url": "https://cdn.example.com/result.zip"}]},
                }).encode("utf-8"))
            if url.endswith(".zip"):
                return _FakeResponse(zip_payload)
            raise AssertionError(f"Unexpected URL {method} {url}")

        class FakeHTTPSConn:
            def __init__(self, netloc, *args, **kwargs):
                self.netloc = netloc

            def request(self, method, path, body=None, headers=None):
                oss_headers_seen.append((method, self.netloc, path, {k.lower(): v for k, v in (headers or {}).items()}))

            def getresponse(self):
                return type("R", (), {"status": 200, "reason": "OK", "read": lambda s: b""})()

            def close(self):
                pass

        crop_calls = []

        def fake_crop(root, page, box, name):
            crop_calls.append((page, box))
            return f"figures/{name}.webp"

        llm_calls = []

        def fake_llm(cfg_, prompt, cwd, images=None, cancel=None, meter=None, json_mode=False):
            # MinerU mode only sends text-only fill prompts, never structure/vision prompts.
            self.assertIn("要", prompt)
            self.assertFalse(images)
            marker = next(m for m in ("要翻譯的內容（鍵 → 英文）：\n", "要翻译的内容（键 → 英文）：\n") if m in prompt)
            items = json.loads(prompt.split(marker, 1)[1])
            llm_calls.append(sorted(items))
            zh = {}
            for k in items:
                zh[k] = [["模型", "分數"]] if k.endswith("#head") else f"譯:{k}"
            return json.dumps({"zh": zh, "meta": {"title_zh": "好論文", "short_zh": "好論文"}}, ensure_ascii=False)

        with mock.patch.object(mineru.http, "urlopen", fake_urlopen), \
             mock.patch.object(mineru.http_client, "HTTPSConnection", FakeHTTPSConn), \
             mock.patch.object(mineru.urllib.request, "getproxies", return_value={}), \
             mock.patch("easyread.figures.pdfwork.crop", fake_crop), \
             mock.patch.object(engines, "run", fake_llm):
            failed = translate.translate_pages(self.ws, self.cfg, [1, 2, 3], threading.Event(), lambda *a: None)

        self.assertEqual(failed, {})
        # OSS PUT must have NO content-type or authorization headers.
        self.assertEqual(len(oss_headers_seen), 1)
        method, netloc, path, hdrs = oss_headers_seen[0]
        self.assertEqual((method, netloc, path), ("PUT", "oss.example.com", "/presigned?sig=1"))
        self.assertNotIn("content-type", hdrs)
        self.assertNotIn("authorization", hdrs)
        # Figure bbox normalized 0..1000 -> [0.1, 0.2, 0.9, 0.6] and cropped locally via pdfwork.crop!
        self.assertEqual(crop_calls, [(1, [0.1, 0.2, 0.9, 0.6])])
        # Page 3 handled by local_references (0 LLM calls, 0 MinerU upload on cached subset).
        paper = self.ws.load("paper")
        self.assertEqual(paper["translation"]["done_pages"], [1, 2, 3])
        self.assertEqual([r["id"] for r in paper["references"]], ["1"])
        fig = next(b for b in paper["blocks"] if b["type"] == "figure")
        self.assertEqual(fig["box"], [0.1, 0.2, 0.9, 0.6])
        self.assertTrue(fig["src"].startswith("figures/crop-1-"))
        self.assertEqual(fig["caption_zh"], "譯:fig1#caption")
        tab = next(b for b in paper["blocks"] if b["type"] == "table")
        self.assertEqual(tab["head"], [["Model", "Score"]])
        self.assertEqual(tab["caption_zh"], "譯:tab1#caption")
        math_blk = next(b for b in paper["blocks"] if b["type"] == "math")
        self.assertEqual(math_blk["tex"], "E = mc^2")
        self.assertEqual(math_blk["tag"], "1")
        note_blk = next(b for b in paper["blocks"] if b.get("role") == "table_note")
        self.assertEqual(note_blk["en"], "Best scores are bold.")

    def test_local_fastapi_and_read_only_mode(self):
        cfg = dict(self.cfg, mineru={"enabled": True, "mode": "local", "base_url": "http://127.0.0.1:8000", "model_version": "pipeline"})
        sample_items = [
            {"type": "text", "text_level": 0, "text": "Intro text on page 1.", "page_idx": 0},
            {"type": "text", "text_level": 0, "text": "Results text on page 2.", "page_idx": 1},
        ]

        def fake_local(req, timeout=None, **kw):
            if req.full_url.endswith("/openapi.json"):
                return _FakeResponse(json.dumps({"paths": {"/file_parse": {}}}).encode("utf-8"))
            self.assertTrue(req.full_url.endswith("/file_parse"))
            return _FakeResponse(json.dumps({"results": {"paper": {"content_list": json.dumps(sample_items)}}}).encode("utf-8"))

        llm_called = []
        with mock.patch.object(mineru.http, "urlopen", fake_local), \
             mock.patch.object(engines, "run", lambda *a, **kw: llm_called.append(True)):
            failed = translate.translate_pages(self.ws, cfg, [1, 2, 3], threading.Event(), lambda *a: None, read=True)

        self.assertEqual(failed, {})
        self.assertEqual(llm_called, [])
        paper = self.ws.load("paper")
        self.assertEqual(paper["translation"]["en_pages"], [1, 2])
        self.assertEqual(paper["translation"]["done_pages"], [1, 2, 3])

    def test_mineru_failure_falls_back_to_builtin_llm(self):
        def failing_mineru(*args, **kwargs):
            raise mineru.MinerUQuotaError("HTTP 429: quota exceeded")

        llm_pages = []

        def fallback_llm(cfg_, prompt, cwd, images=None, cancel=None, meter=None, json_mode=False):
            import re
            pages_in_batch = [int(x.strip()) for x in re.search(r"(?:這次只處理第|这次只处理第) ([\d, ]+) (?:頁|页)", prompt)[1].split(",")]
            llm_pages.extend(pages_in_batch)
            return json.dumps({"blocks": [{"id": f"p{pg}-1", "type": "para", "page": pg, "en": f"En {pg}", "zh": f"Zh {pg}"} for pg in pages_in_batch]})

        with mock.patch.object(mineru, "extract_to_workspace", side_effect=failing_mineru), \
             mock.patch.object(engines, "run", fallback_llm):
            failed = translate.translate_pages(self.ws, self.cfg, [1, 2, 3], threading.Event(), lambda *a: None)

        self.assertEqual(failed, {})
        self.assertEqual(llm_pages, [1, 2])  # Page 3 still handled locally!
        log_text = (self.ws.root / "job.log").read_text(encoding="utf-8")
        self.assertIn("MinerU unavailable, falling back to built-in LLM pipeline", log_text)

    def test_transient_ssleoferror_retries_with_compat_tls(self):
        attempts = []

        def flaky_urlopen(req, timeout=None, context=None):
            attempts.append(context is not None)
            if len(attempts) == 1:
                raise ssl.SSLEOFError(8, "EOF occurred in violation of protocol (_ssl.c:2427)")
            return _FakeResponse(json.dumps({"code": 0, "data": {}}).encode("utf-8"), 200)

        with mock.patch.object(mineru.http, "urlopen", flaky_urlopen), \
             mock.patch.object(mineru.time, "sleep", lambda *a: None):
            status, body = mineru._http_request("https://mineru.net/api/v4/test")

        self.assertEqual(status, 200)
        self.assertEqual(attempts, [False, True])

    def test_local_v1_tasks_api_and_middle_json(self):
        middle = {
            "pdf_info": [
                {
                    "page_idx": 0,
                    "page_size": [600, 800],
                    "para_blocks": [
                        {"type": "title", "level": 1, "bbox": [60, 40, 540, 80], "lines": [{"spans": [{"type": "text", "content": "Deep Paper"}]}]},
                        {"type": "text", "bbox": [60, 100, 540, 140], "lines": [{"spans": [{"type": "text", "content": "Value"}, {"type": "inline_equation", "content": "x^2"}]}]},
                        {
                            "type": "image", "bbox": [60, 200, 540, 400],
                            "blocks": [
                                {"type": "image_body", "bbox": [60, 200, 540, 360]},
                                {"type": "image_caption", "lines": [{"spans": [{"type": "text", "content": "Figure 1: Plot."}]}]},
                            ],
                        },
                    ],
                },
                {
                    "page_idx": 1,
                    "page_size": [600, 800],
                    "para_blocks": [
                        {
                            "type": "table", "bbox": [60, 100, 540, 300],
                            "blocks": [
                                {"type": "table_caption", "lines": [{"spans": [{"type": "text", "content": "Table 1: Scores"}]}]},
                                {"type": "table_body", "lines": [{"spans": [{"html": "<table><thead><tr><th>M</th><th>S</th></tr></thead><tbody><tr><td>Ours</td><td>99</td></tr></tbody></table>"}]}]},
                            ],
                        },
                    ],
                },
            ]
        }

        def fake_v1(req, timeout=None, **kw):
            url = req.full_url
            m = req.get_method()
            if url.endswith("/openapi.json"):
                return _FakeResponse(json.dumps({"paths": {"/v1/tasks": {}, "/v1/health": {}, "/v1/tiers": {}}}).encode())
            if url.endswith("/v1/health"):
                return _FakeResponse(json.dumps({"status": "ok", "version": "4.2.3", "runtime": {"device": "gpu"}}).encode())
            if url.endswith("/v1/tiers"):
                return _FakeResponse(json.dumps({"data": [{"id": "flash"}, {"id": "standard"}]}).encode())
            if url.endswith("/v1/tasks") and m == "POST":
                return _FakeResponse(json.dumps({
                    "task_id": "job_1", "status": "waiting-file",
                    "files": [{"file_id": "f_1", "upload": {"url": "/v1/tasks/job_1/uploads/f_1", "headers": {"Content-Type": "application/octet-stream"}}}],
                }).encode())
            if url.endswith("/v1/tasks/job_1/uploads/f_1") and m == "PUT":
                return _FakeResponse(json.dumps({"task_id": "job_1", "file_id": "f_1", "status": "pending"}).encode())
            if url.endswith("/v1/tasks/job_1") and m == "GET":
                return _FakeResponse(json.dumps({
                    "task_id": "job_1", "status": "completed",
                    "files": [{"file_id": "f_1", "status": "completed", "result_url": "/v1/files/f_1/content"}],
                }).encode())
            if url.endswith("/v1/files/f_1/content"):
                return _FakeResponse(json.dumps(middle).encode())
            raise AssertionError(f"Unexpected v1 call: {m} {url}")

        cfg = dict(self.cfg, mineru={"enabled": True, "mode": "local", "base_url": "http://127.0.0.1:8000"})
        with mock.patch.object(mineru.http, "urlopen", fake_v1), \
             mock.patch("easyread.figures.pdfwork.crop", lambda root, page, box, name: f"figures/{name}.webp"), \
             mock.patch.object(engines, "run", lambda *a, **kw: None):
            conn_res = mineru.test_connection(cfg["mineru"])
            self.assertTrue(conn_res["ok"])
            self.assertIn("/v1/tasks", conn_res["message"])
            failed = translate.translate_pages(self.ws, cfg, [1, 2, 3], threading.Event(), lambda *a: None, read=True)

        self.assertEqual(failed, {})
        paper = self.ws.load("paper")
        self.assertEqual(paper["translation"]["done_pages"], [1, 2, 3])
        self.assertTrue(any(b.get("en") == "Value $x^2$" for b in paper["blocks"]))
        fig = next(b for b in paper["blocks"] if b["type"] == "figure")
        self.assertEqual(fig["box"], [0.1, 0.25, 0.9, 0.45])
        tab = next(b for b in paper["blocks"] if b["type"] == "table")
        self.assertEqual(tab["head"], [["M", "S"]])
        self.assertEqual(tab["rows"], [["Ours", "99"]])

    def test_parse_json_keeps_literal_think_tags_inside_strings(self):
        raw = '<think>internal reasoning with {"ignored": 1}</think>\n{"zh": {"p6-2": "輸出格式為 <think>...</think><answer>json</answer>"}}'
        parsed = engines.parse_json(raw)
        self.assertEqual(parsed["zh"]["p6-2"], "輸出格式為 <think>...</think><answer>json</answer>")

    def test_inline_html_cleanup_and_mineru_box_source(self):
        self.assertEqual(mineru._clean_inline_html("Haozhan Shen<sup>1</sup>, Zhao<sup>2,3B</sup>"), "Haozhan Shen¹, Zhao$^{2,3\\mathrm{B}}$")
        self.assertEqual(mineru._clean_inline_html("a<sub>i</sub> + b<sub>10</sub>"), r"a$_{\mathrm{i}}$ + b₁₀")
        sample = [
            {"type": "text", "text_level": 1, "text": "Title", "page_idx": 0},
            {"type": "text", "text_level": 0, "text": "Alice<sup>1</sup>", "page_idx": 0},
            {"type": "image", "bbox": [100, 280, 900, 520], "image_caption": ["Figure 1. Demo."], "page_idx": 0},
            {"type": "page_footnote", "text": "<sup>B</sup> Corresponding author.", "page_idx": 0},
        ]
        with mock.patch.object(mineru, "parse_pdf_pages", return_value={1: sample}), \
             mock.patch("easyread.figures.pdfwork.crop", lambda root, page, box, name: f"figures/{name}.webp"):
            ok, data = mineru.extract_to_workspace(self.ws, self.cfg, [1], 3, threading.Event())
        self.assertEqual(ok, [1])
        author_blk = next(b for b in data["blocks"] if b.get("type") == "para" and "Alice" in b.get("en", ""))
        self.assertEqual(author_blk["en"], "Alice¹")
        fig_blk = next(b for b in data["blocks"] if b.get("type") == "figure")
        self.assertEqual(fig_blk.get("box_source"), "mineru")
        foot_blk = next(b for b in data["blocks"] if b.get("role") == "footnote")
        self.assertEqual(foot_blk["num"], "B")
        self.assertEqual(foot_blk["en"], "Corresponding author.")

    def test_smoke_parse_surfaces_worker_failure_or_success(self):
        cfg = {"enabled": True, "mode": "local", "base_url": "http://127.0.0.1:8000"}

        def fake_health(req, timeout=None, **kw):
            url = req.full_url
            if url.endswith("/openapi.json"):
                return _FakeResponse(json.dumps({"paths": {"/v1/tasks": {}, "/v1/health": {}, "/v1/tiers": {}}}).encode())
            if url.endswith("/v1/health"):
                return _FakeResponse(json.dumps({"version": "4.2.3", "runtime": {"device": "gpu"}}).encode())
            if url.endswith("/v1/tiers"):
                return _FakeResponse(json.dumps({"data": [{"id": "flash"}, {"id": "standard"}]}).encode())
            if url.endswith("/v1/tasks") and req.get_method() == "POST":
                return _FakeResponse(json.dumps({
                    "task_id": "job_s", "status": "waiting-file",
                    "files": [{"file_id": "f_s", "upload": {"url": "/v1/tasks/job_s/uploads/f_s", "headers": {}}}],
                }).encode())
            if "/uploads/" in url:
                return _FakeResponse(json.dumps({"task_id": "job_s", "file_id": "f_s", "status": "pending"}).encode())
            if url.endswith("/v1/tasks/job_s"):
                return _FakeResponse(json.dumps({
                    "task_id": "job_s", "status": "failed",
                    "files": [{"file_id": "f_s", "status": "failed", "error": {"code": "parse_failed", "message": "HF OAuth expired"}}],
                }).encode())
            raise AssertionError(url)

        with mock.patch.object(mineru.http, "urlopen", fake_health):
            conn = mineru.test_connection(cfg, smoke=False)
            self.assertTrue(conn["ok"])
            self.assertIn("tiers:flash,standard", conn["message"])
            smoke = mineru.test_connection(cfg, smoke=True)
            self.assertFalse(smoke["ok"])
            self.assertIn("parse_failed: HF OAuth expired", smoke["message"])

    def test_structured_content_zip_and_markdown_table(self):
        sc = {
            "pages": [
                {
                    "page_idx": 0,
                    "blocks": [
                        {"type": "doc_title", "level": 1, "bbox": [0.1, 0.1, 0.9, 0.15], "content": "Paper Title"},
                        {"type": "paragraph_title", "level": 2, "bbox": [0.1, 0.2, 0.4, 0.23], "content": "Abstract"},
                        {"type": "chart", "bbox": [0.1, 0.3, 0.5, 0.5], "captions": ["Figure 1. Chart."]},
                        {
                            "type": "table",
                            "bbox": [0.5, 0.3, 0.9, 0.5],
                            "captions": ["Table 1. Scores."],
                            "content": "| Model | GP |\n| --- | --- |\n| Ours | 67.3 |",
                        },
                    ],
                }
            ]
        }
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("structured_content.json", json.dumps(sc))
        cl = mineru._extract_zip_content_list(buf.getvalue())
        with mock.patch.object(mineru, "parse_pdf_pages", return_value={1: [x for x in cl if x.get("page_idx") == 0]}), \
             mock.patch("easyread.figures.pdfwork.crop", lambda root, page, box, name: f"figures/{name}.webp"):
            ok, data = mineru.extract_to_workspace(self.ws, self.cfg, [1], 3, threading.Event())
        self.assertEqual(ok, [1])
        fig = next(b for b in data["blocks"] if b["type"] == "figure")
        self.assertEqual(fig["caption_en"], "Figure 1. Chart.")
        tab = next(b for b in data["blocks"] if b["type"] == "table")
        self.assertEqual(tab["head"], [["Model", "GP"]])
        self.assertEqual(tab["rows"], [["Ours", "67.3"]])

    def test_structured_dict_captions_continues_prev_code_fence_and_entities(self):
        sc = {
            "pages": [
                {
                    "page_idx": 0,
                    "blocks": [
                        {"type": "text", "bbox": [0.1, 0.1, 0.4, 0.2], "content": "First half ends in comma,"},
                        {"type": "text", "bbox": [0.5, 0.1, 0.9, 0.2], "content": "second half completes it. Format uses &lt;think&gt;...&lt;/think&gt;.", "continues_prev": True},
                        {
                            "type": "image",
                            "bbox": [0.1, 0.25, 0.5, 0.45],
                            "captions": [
                                {"bbox": [0.1, 0.46, 0.5, 0.48], "content": "Chart subtitle"},
                                {"bbox": [0.1, 0.49, 0.5, 0.52], "content": "Figure 5. Plot compare."},
                            ],
                            "footnotes": [{"bbox": [0.1, 0.53, 0.5, 0.55], "content": "Note one."}],
                        },
                        {
                            "type": "table",
                            "bbox": [0.5, 0.25, 0.9, 0.45],
                            "content": "| Model | Score |\n| --- | --- |\n| RL | 21.1 |",
                        },
                        {"type": "text", "bbox": [0.5, 0.46, 0.9, 0.5], "content": "Table 3. Results on COCO."},
                        {
                            "type": "code",
                            "bbox": [0.1, 0.58, 0.9, 0.72],
                            "captions": [{"bbox": [0.1, 0.55, 0.4, 0.57], "content": "Problem Template of OVD"}],
                            "content": "```txt\nUse format:\n```json\n{\"a\": 1}\n```\nDone.\n```",
                        },
                    ],
                },
                {
                    "page_idx": 1,
                    "blocks": [
                        {"type": "text", "bbox": [0.1, 0.1, 0.9, 0.2], "content": "crosses page boundary.", "continues_prev": True},
                    ],
                },
            ]
        }
        cl = mineru._structured_content_to_content_list(sc)
        by_page = {
            1: [x for x in cl if x.get("page_idx") == 0],
            2: [x for x in cl if x.get("page_idx") == 1],
        }
        with mock.patch.object(mineru, "parse_pdf_pages", return_value=by_page), \
             mock.patch("easyread.figures.pdfwork.crop", lambda root, page, box, name: f"figures/{name}.webp"):
            ok, data = mineru.extract_to_workspace(self.ws, self.cfg, [1, 2], 3, threading.Event())
        self.assertEqual(ok, [1, 2])
        blocks = data["blocks"]
        p1 = next(b for b in blocks if b["page"] == 1 and b["type"] == "para" and "First half" in b["en"])
        self.assertEqual(p1["en"], "First half ends in comma, second half completes it. Format uses <think>...</think>.")
        fig = next(b for b in blocks if b["type"] == "figure")
        self.assertNotIn("{'bbox'", fig["caption_en"])
        self.assertEqual(fig["caption_en"], "Chart subtitle Figure 5. Plot compare.")
        tab = next(b for b in blocks if b["type"] == "table")
        self.assertEqual(tab["caption_en"], "Table 3. Results on COCO.")
        self.assertEqual(tab["num"], "3")
        self.assertFalse(any(b.get("type") == "para" and "Table 3." in b.get("en", "") for b in blocks))
        code_blk = next(b for b in blocks if b["type"] == "para" and "Problem Template" in b["en"])
        self.assertIn("````txt\nUse format:", code_blk["en"])
        self.assertFalse(code_blk["en"].startswith("Problem Template of OVD\n\n```\n```txt"))
        p2 = next(b for b in blocks if b["page"] == 2 and b["type"] == "para")
        self.assertTrue(p2.get("cont"))

    def test_fill_items_retries_when_model_echoes_english_verbatim(self):
        long_en = "ing deeper understanding: Position detection and Relationship detection across multiple visual benchmarks demonstrate better overall generalization of visual understanding."
        self.ws.update("paper", lambda p: p.update({
            "meta": {"pages": [1], "page_count": 1, "target": "zh-TW"},
            "blocks": [
                {"id": "p1-1", "type": "para", "page": 1, "en": "Short intro.", "zh": ""},
                {"id": "p1-2", "type": "para", "page": 1, "en": long_en, "zh": ""},
            ],
            "translation": {"done_pages": [], "failed_pages": {}, "running": False},
        }))
        prompts_seen = []

        def fake_run(cfg, prompt, *a, **kw):
            prompts_seen.append(prompt)
            if len(prompts_seen) == 1:
                return json.dumps({
                    "zh": {
                        "p1-1": "簡短介紹。",
                        "p1-2": long_en,
                    }
                }, ensure_ascii=False)
            return json.dumps({
                "zh": {
                    "p1-2": "深入理解：位置偵測與關係偵測在多項視覺基準測試中展現出更佳的整體視覺理解泛化能力。",
                }
            }, ensure_ascii=False)

        with mock.patch.object(engines, "run", side_effect=fake_run):
            translate._fill_items(
                self.ws,
                self.cfg,
                [1],
                self.ws.load("paper")["blocks"],
                {"p1-1": "Short intro.", "p1-2": long_en},
                threading.Event(),
                lambda *a: None,
                final_pages=[1],
            )
        self.assertEqual(len(prompts_seen), 2)
        paper = self.ws.load("paper")
        b2 = next(b for b in paper["blocks"] if b["id"] == "p1-2")
        self.assertIn("深入理解", b2["zh"])

    def test_reconcile_page_floats_fixes_cross_type_multipacked_and_split_subfigures(self):
        page10 = [
            {"type": "image", "bbox": [0.128, 0.094, 0.871, 0.351], "image_caption": [], "page_idx": 9},
            {
                "type": "table",
                "bbox": [0.106, 0.432, 0.892, 0.507],
                "table_caption": [{"bbox": [0.09, 0.362, 0.908, 0.42], "content": "Figure 7. Cases compare."}],
                "table_body": "<table><tr><th>Model</th><th>mAP</th></tr><tr><td>A</td><td>1.0</td></tr></table>",
                "page_idx": 9,
            },
            {
                "type": "table",
                "bbox": [0.104, 0.574, 0.895, 0.685],
                "table_caption": [
                    {"bbox": [0.091, 0.532, 0.906, 0.561], "content": "Table 6. Different training data."},
                    {"bbox": [0.09, 0.71, 0.906, 0.74], "content": "Table 7. Different model sizes."},
                ],
                "table_body": "<table><tr><th>Model</th><th>mAP</th></tr><tr><td>B</td><td>2.0</td></tr></table>",
                "page_idx": 9,
            },
        ]
        page6 = [
            {"type": "image", "bbox": [0.532, 0.106, 0.648, 0.241], "image_caption": ["Training"], "page_idx": 5},
            {"type": "image", "bbox": [0.659, 0.107, 0.889, 0.245], "image_caption": [{"bbox": [0.513, 0.268, 0.908, 0.339], "content": "Figure 4. Split panel."}], "page_idx": 5},
        ]
        with mock.patch.object(mineru, "parse_pdf_pages", return_value={6: page6, 10: page10}), \
             mock.patch("easyread.figures.pdfwork.crop", lambda root, page, box, name: f"figures/{name}.webp"):
            ok, data = mineru.extract_to_workspace(self.ws, self.cfg, [6, 10], 10, threading.Event())
        self.assertEqual(ok, [6, 10])
        fig4 = next(b for b in data["blocks"] if b["id"] == "fig4")
        self.assertEqual(fig4["box"], [0.532, 0.106, 0.889, 0.245])
        fig7 = next(b for b in data["blocks"] if b["id"] == "fig7")
        self.assertEqual(fig7["caption_en"], "Figure 7. Cases compare.")
        tab6 = next(b for b in data["blocks"] if b["id"] == "tab6")
        tab7 = next(b for b in data["blocks"] if b["id"] == "tab7")
        self.assertEqual(tab6["caption_en"], "Table 6. Different training data.")
        self.assertEqual(tab7["caption_en"], "Table 7. Different model sizes.")


if __name__ == "__main__":
    unittest.main()
