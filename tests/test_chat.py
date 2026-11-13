"""“问 AI”的流式输出、推理等级、存储管理、工具调用与 Markdown 导出。
python -m unittest tests.test_chat"""
import base64
import copy
import io
import json
from pathlib import Path
import shutil
import tempfile
import threading
import unittest
from unittest import mock
from unittest.mock import patch
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from easyread import chat, chat_markdown, chat_models, chat_options, chat_store, engines, translate
from easyread.store import Workspace, write_json_atomic

PIECES = ["<think>先想", "一想</think>", "标准误差", "除以 $\\sqrt{n}$", "。"]


class FakeAPI(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        assert body["stream"] is True
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for p in PIECES:
            self.wfile.write(b"data: " + json.dumps({"choices": [{"delta": {"content": p}}]}).encode() + b"\n\n")
        self.wfile.write(b"data: [DONE]\n\n")


class ChatStreamTest(unittest.TestCase):
    def test_openai_stream_strips_think(self):
        srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeAPI)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            cfg = {"engine": "openai", "openai": {"base_url": f"http://127.0.0.1:{srv.server_address[1]}/v1", "model": "fake", "api_key": "k"}}
            out = "".join(chat.stream(cfg, "问题", None, threading.Event()))
        finally:
            srv.shutdown()
            srv.server_close()
        self.assertEqual(out, "标准误差除以 $\\sqrt{n}$。")

    def test_model_list_picks_preset_key(self):
        cfg = {"engine": "claude", "claude": {"model": ""}, "codex": {"model": ""},
               "chat": {"default": "ds", "models": [{"id": "ds", "name": "DeepSeek", "engine": "openai", "preset": "deepseek", "model": ""}]},
               "openai": {"preset": "zhipu", "base_url": "x", "model": "glm", "api_key": "zk", "keys": {"zhipu": "zk", "deepseek": "dk"}}}
        e, m = chat_models.engine_cfg(cfg, None)
        self.assertEqual((e["engine"], e["openai"]["api_key"], e["openai"]["model"], m["id"]), ("openai", "dk", "deepseek-flash", "ds"))

    def test_threads_and_legacy(self):
        root = Path(tempfile.mkdtemp())
        try:
            write_json_atomic(root / "paper.json", {"blocks": []})
            write_json_atomic(root / "chat.json", {"messages": [{"role": "user", "content": "旧问题"}, {"role": "assistant", "content": "旧回答"}]})
            ws = Workspace(root)
            chat_store.append(ws, "t2", {"content": "新问题"}, "新回答", "opus", "Claude Opus 5.5")
            ts = chat_store.threads(ws)
            self.assertEqual([t["title"] for t in ts], ["新问题", "旧问题"])
            chat_store.delete(ws, "t-first")
            self.assertEqual(len(chat_store.threads(ws)), 1)
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_marks_only_when_asked_and_refs(self):
        root = Path(tempfile.mkdtemp())
        try:
            blocks = [{"id": "a", "type": "p", "zh": "甲段 $x$"}, {"id": "b", "type": "p", "zh": "乙段"}, {"id": "c", "type": "p", "zh": "丙段"}]
            write_json_atomic(root / "paper.json", {"meta": {}, "blocks": blocks})
            write_json_atomic(root / "reader.json", {"notes": {"n1": {"anchor": "a", "quote": "红色重点", "color": "pink", "kind": "highlight"},
                                                                "n2": {"anchor": "b", "quote": "黄色句子", "color": "yellow", "kind": "highlight"}}})
            ws = Workspace(root)
            refs = [{"anchor": "b", "quote": ""}, {"anchor": "c", "quote": "丙"}]
            plain = chat.prompt(ws, [{"role": "user", "content": "这两段什么关系"}], "b", "", "openai", refs)
            self.assertNotIn("红色重点", plain)           # 没问到标记，就不带
            self.assertIn("2 處標記", plain)
            self.assertIn("[c] 讀者選取：「丙」", plain)   # 引用的第二段也在
            red = chat.prompt(ws, [{"role": "user", "content": "我标红的那些有什么联系"}], None, "", "openai")
            self.assertIn("红色重点", red)
            self.assertNotIn("黄色句子", red)              # 只带问到的颜色
        finally:
            shutil.rmtree(root, ignore_errors=True)


class ChatEffortTest(unittest.TestCase):
    def test_explicit_override_does_not_change_card_or_translation(self):
        from easyread import config
        saved = copy.deepcopy(config.DEFAULTS)
        saved["claude"].update(model="opus", reasoning_effort="high")
        request = copy.deepcopy(saved)
        selected = chat_options.apply(request, {"reasoning_effort": "low"})
        self.assertEqual(request["claude"]["reasoning_effort"], "low")
        self.assertEqual(saved["claude"]["reasoning_effort"], "high")
        self.assertEqual(selected, {"reasoning_effort": "low"})
        chat_options.apply(request, {"reasoning_effort": ""})
        self.assertEqual(request["claude"]["reasoning_effort"], "")

    def test_legacy_requests_and_invalid_levels(self):
        from easyread import config
        cfg = copy.deepcopy(config.DEFAULTS)
        self.assertEqual(chat_options.apply(cfg, None), {})
        with self.assertRaises(ValueError):
            chat_options.apply(cfg, {"reasoning_effort": "invalid"})
        cfg["claude"]["model"] = "haiku"
        with self.assertRaises(ValueError):
            chat_options.apply(cfg, {"reasoning_effort": "high"})


class ChatStoreTest(unittest.TestCase):
    def test_empty_chat_can_be_created_renamed_and_deleted(self):
        with tempfile.TemporaryDirectory() as d:
            ws = Workspace(Path(d))
            write_json_atomic(ws.root / "chat.json", {})
            chat_store.append(ws, "t1", {"content": "q"}, "a", "m", "M")
            chat_store.rename(ws, "t1", "renamed")
            self.assertEqual(chat_store.get(ws, "t1")["title"], "renamed")
            chat_store.delete(ws, "t1")
            self.assertEqual(chat_store.threads(ws), [])

    def test_same_clock_tick_does_not_alias_threads_or_pinned_answers(self):
        with tempfile.TemporaryDirectory() as d, patch("time.time", return_value=1):
            ws = Workspace(Path(d))
            write_json_atomic(ws.paper_path, {"blocks": [{"id": "p1"}]})
            tids = [chat_store.new_id() for _ in range(10)]
            self.assertEqual(len(set(tids)), 10)
            user = {"content": "q", "anchor": "p1"}
            first = chat_store.append(ws, tids[0], user, "first answer", "m", "M")
            second = chat_store.append(ws, tids[0], user, "second answer", "m", "M")
            self.assertNotEqual(first["id"], second["id"])
            chat_store.pin(ws, tids[0], second["id"])
            self.assertEqual(ws.load("discussion")["entries"][0]["body"], "second answer")

    def test_pin_with_mismatched_thread_id_finds_answer_across_threads(self):
        with tempfile.TemporaryDirectory() as d:
            ws = Workspace(Path(d))
            write_json_atomic(ws.paper_path, {"blocks": [{"id": "b1"}]})
            t1 = chat_store.new_id()
            t2 = chat_store.new_id()
            chat_store.append(ws, t1, {"content": "question in t1", "anchor": "b1"}, "answer in t1", "m", "M")
            ans2 = chat_store.append(ws, t2, {"content": "question in t2", "anchor": "b1"}, "answer in t2", "m", "M")
            chat_store.pin(ws, t1, ans2["id"])
            entries = ws.load("discussion")["entries"]
            self.assertEqual(len(entries), 1)
            self.assertEqual(entries[0]["body"], "answer in t2")
            self.assertEqual(entries[0]["anchor"], "b1")

    def test_pin_with_nonexistent_message_id_raises_key_error(self):
        with tempfile.TemporaryDirectory() as d:
            ws = Workspace(Path(d))
            write_json_atomic(ws.paper_path, {"blocks": [{"id": "b1"}]})
            t1 = chat_store.new_id()
            chat_store.append(ws, t1, {"content": "q", "anchor": "b1"}, "ans", "m", "M")
            with self.assertRaises(KeyError):
                chat_store.pin(ws, t1, "nonexistent_mid")


class FakeProc:
    def __init__(self, lines, err=""):
        self.stdin = io.StringIO()
        self.stdout = iter(lines)
        self.stderr = io.StringIO(err)
        self.returncode = 0

    def poll(self):
        return 0

    def kill(self):
        pass


def result_lines(text):
    return [json.dumps({"type": "stream_event", "event": {"delta": {"type": "text_delta", "text": text}}}) + "\n",
            json.dumps({"type": "result", "subtype": "success", "result": text, "usage": {}}) + "\n"]


class ChatClaudeLeanTest(unittest.TestCase):
    def stream(self, procs, c=None):
        calls = []

        def popen(args, cwd):
            calls.append(list(args))
            return procs[len(calls) - 1]

        with mock.patch.object(engines, "claude_path", lambda c: "claude"), mock.patch.object(engines, "_popen", popen):
            out = "".join(chat._stream_claude(c or {"model": "opus", "reasoning_effort": "high"}, "q", Path("."), threading.Event()))
        return out, calls

    def test_tools_read_and_user_choices_kept(self):
        out, calls = self.stream([FakeProc(result_lines("答"))])
        self.assertEqual(out, "答")
        a = calls[0]
        self.assertEqual(a[a.index("--tools") + 1], "Read")
        self.assertIn("--strict-mcp-config", a)
        self.assertEqual(a[a.index("--model") + 1], "opus")
        self.assertEqual(a[a.index("--effort") + 1], "high")

    def test_unknown_option_falls_back_before_any_output(self):
        out, calls = self.stream([FakeProc([], err="error: unknown option '--tools'"), FakeProc(result_lines("答"))])
        self.assertEqual(out, "答")
        self.assertIn("--tools", calls[0])
        self.assertNotIn("--tools", calls[1])

    def test_other_errors_are_not_retried(self):
        with self.assertRaises(engines.EngineError):
            self.stream([FakeProc([], err="network down")])

    def test_cancel_event_untouched_after_answer(self):
        cancel = threading.Event()
        with mock.patch.object(engines, "claude_path", lambda c: "claude"), \
                mock.patch.object(engines, "_popen", lambda a, c: FakeProc(result_lines("答"))):
            "".join(chat._stream_claude({}, "q", Path("."), cancel))
        self.assertFalse(cancel.is_set())


class OtherPathsLeanTest(unittest.TestCase):
    def test_codex_chat_answer_and_retranslate_use_lean_cfg(self):
        seen = []

        def run(cfg, prompt, cwd, images=None, cancel=None, meter=None):
            seen.append(cfg)
            return '{"zh": "新译文"}'

        cfg = {"engine": "codex", "codex": {"model": "m"}}
        with mock.patch.object(engines, "run", run), mock.patch.object(chat.netcheck, "problem", lambda c: ""):
            list(chat.stream(cfg, "q", Path("."), threading.Event()))
        self.assertTrue(seen[-1]["codex"]["lean"])
        self.assertEqual(seen[-1]["codex"]["model"], "m")
        self.assertNotIn("lean", cfg["codex"])

        ws = mock.MagicMock()
        ws.load.return_value = {"notes": {"n1": {"anchor": "p1", "body": "?"}}}
        with mock.patch.object(engines, "run", run), mock.patch.object(translate.prompts, "answer", lambda ws, note: "p"), \
                mock.patch.object(translate, "add_discussion", lambda *a: None):
            translate.answer(ws, cfg, "n1", None)
        self.assertTrue(seen[-1]["codex"]["lean"])
        with mock.patch.object(engines, "run", run), mock.patch.object(translate.prompts, "retranslate", lambda ws, k, h: ("p", None)), \
                mock.patch.object(translate, "set_block_text", lambda *a: None):
            translate.retranslate(ws, cfg, "p1", "", None)
        self.assertTrue(seen[-1]["codex"]["lean"])


class ChatMarkdownTests(unittest.TestCase):
    def setUp(self):
        self._temp = tempfile.TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.tmp_path = Path(self._temp.name)

    def test_chat_markdown_export_basic(self):
        tmp_path = self.tmp_path
        ws = Workspace(tmp_path)
        (tmp_path / "paper.json").write_text(json.dumps({
            "meta": {"title_en": "Attention Is All You Need", "title_zh": "注意力就是你所需"}
        }, ensure_ascii=False), encoding="utf-8")
        (tmp_path / "chat.json").write_text(json.dumps({
            "threads": [{
                "id": "t1",
                "title": "Thread 1",
                "messages": [
                    {"role": "user", "id": "u1", "content": "What is self-attention?"},
                    {"role": "assistant", "id": "a1", "content": "Self-attention relates different positions of a single sequence.", "at": "2026-10-27T12:00:00Z"}
                ]
            }]
        }, ensure_ascii=False), encoding="utf-8")

        result = chat_markdown.export(ws, {"thread": "t1", "id": "a1"})
        self.assertTrue(result["filename"].endswith(".md"))
        self.assertTrue(result["mime"].startswith("text/markdown"))
        decoded = base64.b64decode(result["data"]).decode("utf-8")
        self.assertIn("What is self-attention?", decoded)
        self.assertIn("Self-attention relates different positions of a single sequence.", decoded)
        self.assertIn("2026-10-27T12:00:00Z", decoded)

    def test_chat_markdown_export_mismatched_thread_fallback(self):
        tmp_path = self.tmp_path
        ws = Workspace(tmp_path)
        (tmp_path / "paper.json").write_text(json.dumps({
            "meta": {"title_en": "Paper"}
        }, ensure_ascii=False), encoding="utf-8")
        (tmp_path / "chat.json").write_text(json.dumps({
            "threads": [
                {"id": "t1", "title": "T1", "messages": []},
                {"id": "t2", "title": "T2", "messages": [
                    {"role": "user", "id": "u1", "content": "Question in T2"},
                    {"role": "assistant", "id": "a2", "content": "Answer in T2"}
                ]}
            ]
        }, ensure_ascii=False), encoding="utf-8")

        result = chat_markdown.export(ws, {"thread": "t1", "id": "a2"})
        decoded = base64.b64decode(result["data"]).decode("utf-8")
        self.assertIn("Question in T2", decoded)
        self.assertIn("Answer in T2", decoded)

    def test_chat_markdown_export_with_image(self):
        tmp_path = self.tmp_path
        ws = Workspace(tmp_path)
        (tmp_path / "paper.json").write_text(json.dumps({
            "meta": {"title_en": "Sample Paper"}
        }, ensure_ascii=False), encoding="utf-8")
        media_dir = tmp_path / "chat-media"
        media_dir.mkdir(parents=True)
        (media_dir / "fig1.png").write_bytes(b"FAKE_PNG_DATA")

        (tmp_path / "chat.json").write_text(json.dumps({
            "threads": [{
                "id": "t1",
                "title": "Thread 1",
                "messages": [
                    {"role": "user", "id": "u1", "content": "Explain this", "images": [f"/p/{ws.id}/chat-media/fig1.png"]},
                    {"role": "assistant", "id": "a1", "content": f"Here is the result: ![](/p/{ws.id}/chat-media/fig1.png)"}
                ]
            }]
        }, ensure_ascii=False), encoding="utf-8")

        result = chat_markdown.export(ws, {"thread": "t1", "id": "a1"})
        self.assertTrue(result["filename"].endswith(".zip"))
        self.assertEqual(result["mime"], "application/zip")
        raw_zip = base64.b64decode(result["data"])
        with zipfile.ZipFile(io.BytesIO(raw_zip), "r") as z:
            names = z.namelist()
            md_name = next(n for n in names if n.endswith(".md"))
            self.assertIn("assets/fig1.png", names)
            self.assertEqual(z.read("assets/fig1.png"), b"FAKE_PNG_DATA")
            md_content = z.read(md_name).decode("utf-8")
            self.assertIn("assets/fig1.png", md_content)

    def test_chat_markdown_export_not_found(self):
        tmp_path = self.tmp_path
        ws = Workspace(tmp_path)
        (tmp_path / "chat.json").write_text(json.dumps({"threads": []}), encoding="utf-8")
        with self.assertRaises(ValueError):
            chat_markdown.export(ws, {"thread": "t1", "id": "nonexistent"})


if __name__ == "__main__":
    unittest.main()
