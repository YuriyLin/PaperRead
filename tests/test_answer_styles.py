"""回答方式从 HTTP 请求、提示词、流式输出一直保留到对话和页边笔记。"""
import contextlib
import json
import tempfile
import threading
import types
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from easyread import answer_styles, chat, chat_store
from easyread.server import Handler
from easyread.store import Workspace, write_json_atomic

ANSWER = "## 结果\n误差为 2%。器件计算 $y=Wx$。\n\n## 局限\n测试采用室温和固定权重。"


class AnswerStyleTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ws = Workspace(Path(self.tmp.name))
        write_json_atomic(self.ws.paper_path, {"meta": {"title_en": "Test paper", "target": "zh-TW"}, "blocks": [
            {"id": "a", "type": "para", "page": 1, "role": "abstract", "en": "An abstract.", "zh": "摘要"},
            {"id": "b", "type": "para", "page": 2, "en": "A source fact with $x$.", "zh": "当前段落"},
            {"id": "list", "type": "list", "page": 3, "items": [{"en": "A test condition.", "zh": "测试条件"}]},
            {"id": "table", "type": "table", "page": 4, "caption_en": "Test results", "head": [["Error"]], "rows": [["2%"]]},
            {"id": "eq", "type": "math", "page": 5, "tex": "y=2x"},
            {"id": "c", "type": "para", "page": 6, "en": "A final limitation.", "zh": "局限"},
        ]})

    def test_prompt_switches_language_without_losing_source_or_history(self):
        messages = [{"role": "assistant", "content": "Previous answer in English."}, {"role": "user", "content": "总结论文"}]
        for engine in ("openai", "claude", "codex"):
            with self.subTest(engine=engine):
                normal = chat.prompt(self.ws, messages, "b", "引用", engine)
                ste = chat.prompt(self.ws, messages, "b", "引用", engine, answer_style="ste100")
                self.assertIn("用繁體中文（臺灣用語），不可使用簡體字，直接", normal)
                self.assertNotIn("本次使用 ASD-STE100", normal)
                self.assertNotIn("目前已匯入的正文", normal)
                self.assertNotIn("A final limitation.", normal)
                self.assertNotIn("直接、具體，能舉例就舉例", ste)
                self.assertIn("只輸出繁體中文回答，不附英文答案", ste)
                self.assertNotIn("## English (ASD-STE100)", ste)
                for fact in ("Previous answer in English.", "A source fact with $x$.", "引用", "A test condition.", "2%", "$$y=2x$$", "A final limitation."):
                    self.assertIn(fact, ste)
                self.assertIn("每句表達一個主要意思", ste)
                self.assertIn("不要把英文的詞數限制機械地套用到中文", ste)
                self.assertIn("不要聲稱", ste)

    def test_ste_context_only_includes_annotations_when_the_question_requests_them(self):
        write_json_atomic(self.ws.root / "reader.json", {"notes": {
            "r": {"anchor": "b", "quote": "red selection", "body": "red private note", "color": "pink"},
            "b": {"anchor": "c", "quote": "blue selection", "body": "blue private note", "color": "blue"},
        }})
        for style in answer_styles.VALUES:
            with self.subTest(style=style):
                plain = chat.prompt(self.ws, [{"role": "user", "content": "总结论文"}], "b", "", "openai", answer_style=style)
                self.assertNotIn("red private note", plain)
                self.assertNotIn("blue private note", plain)
                red = chat.prompt(self.ws, [{"role": "user", "content": "我标红的那些有什么联系"}], "b", "", "openai", answer_style=style)
                self.assertIn("red private note", red)
                self.assertNotIn("blue private note", red)

    def test_all_modes_and_engines_require_renderable_math_output(self):
        for engine in ("openai", "claude", "codex"):
            for style in answer_styles.VALUES:
                with self.subTest(engine=engine, style=style):
                    prompt = chat.prompt(self.ws, [{"role": "user", "content": "推导这个公式"}], "eq", "", engine, answer_style=style)
                    self.assertIn("行內公式只使用 $TeX$", prompt)
                    self.assertIn("行間公式只使用 $$TeX$$", prompt)
                    self.assertIn("不要使用 \\(\\) 或 \\[\\]", prompt)
                    self.assertIn("不要把公式放進反引號或程式碼區塊", prompt)
                    self.assertIn("不要在公式中插入空行", prompt)

    def test_ste_prompt_preserves_source_conditions_and_requirement_strength(self):
        source = "At room temperature, this design may reduce loss. Only some devices were tested. The operator should check the sample. Use no more than 5 V."
        self.ws.update("paper", lambda p: p.update(blocks=[{"id": "p1", "type": "para", "page": 1, "en": source}]))
        for engine in ("openai", "claude", "codex"):
            with self.subTest(engine=engine):
                prompt = chat.prompt(self.ws, [{"role": "user", "content": "所有器件都能降低损耗吗？"}], None, "", engine, answer_style="ste100")
                self.assertIn(source, prompt)
                self.assertIn('「可能」不能改成「確定」', prompt)
                self.assertIn('「建議」不能改成「必須」', prompt)
                self.assertIn('「部分」不能改成「全部」', prompt)
                self.assertIn("準確性優先於簡短", prompt)
                self.assertIn("不補造原文未說明", prompt)

    def test_long_paper_excerpt_is_bounded_and_keeps_late_results(self):
        blocks = [{"id": f"p{i}", "type": "para", "page": i + 1,
                   "en": f"Start{i}. " + "middle " * 2000 + f" Final{i}."} for i in range(50)]
        self.ws.update("paper", lambda p: p.update(blocks=blocks))
        excerpt = chat._paper_context(self.ws)
        self.assertIn("正文節錄", excerpt)
        self.assertIn("不能視為已讀", excerpt)
        self.assertIn("Start0.", excerpt)
        self.assertIn("Final49.", excerpt)
        self.assertLessEqual(len(excerpt.split("：\n\n", 1)[1]), chat.PAPER_BUDGET)

    def test_xray_includes_sources_and_teaches_without_inventing_evidence(self):
        for engine in ("openai", "claude", "codex"):
            with self.subTest(engine=engine):
                prompt = chat.prompt(self.ws, [{"role": "user", "content": "Explain the method"}],
                                     "b", "selected source", engine, answer_style="xray")
                for fact in ("A final limitation.", "A test condition.", "2%", "$$y=2x$$", "selected source"):
                    self.assertIn(fact, prompt)
                for rule in ("本次使用精讀模式", "張量形狀", "手算", "教學示例", "資料洩漏",
                             "論文沒有報告", "不可聲稱已看過或核對原圖", "不能把未提供的內容視為已讀"):
                    self.assertIn(rule, prompt)
                self.assertIn("用繁體中文（臺灣用語），不可使用簡體字", prompt)
                self.assertNotIn("本次使用 ASD-STE100", prompt)
        self.ws.update("paper", lambda p: p["meta"].pop("target"))
        with patch("easyread.i18n.lang", return_value="en"):
            english = chat.prompt(self.ws, [{"role": "user", "content": "Explain"}], "b", "", "openai", answer_style="xray")
        self.assertIn("用英文（English）", english)
        self.assertNotIn("只輸出繁體中文", english)

    def test_ste_prompt_follows_paper_target_language(self):
        # Korean target
        self.ws.update("paper", lambda p: p["meta"].update(target="ko"))
        prompt_ko = chat.prompt(self.ws, [{"role": "user", "content": "질문"}], "b", "", "openai", answer_style="ste100")
        self.assertIn("只輸出韩语（한국어）回答", prompt_ko)
        self.assertNotIn("只輸出繁體中文回答", prompt_ko)
        self.assertIn("組織韩语（한국어）答案", prompt_ko)

        # Japanese target
        self.ws.update("paper", lambda p: p["meta"].update(target="ja"))
        prompt_ja = chat.prompt(self.ws, [{"role": "user", "content": "質問"}], "b", "", "openai", answer_style="ste100")
        self.assertIn("只輸出日语（日本語）回答", prompt_ja)
        self.assertNotIn("只輸出繁體中文回答", prompt_ja)
        self.assertIn("組織日语（日本語）答案", prompt_ja)

        # Simplified Chinese target
        self.ws.update("paper", lambda p: p["meta"].update(target="zh"))
        prompt_zh = chat.prompt(self.ws, [{"role": "user", "content": "问题"}], "b", "", "openai", answer_style="ste100")
        self.assertIn("只輸出中文回答", prompt_zh)
        self.assertNotIn("不可使用簡體字", prompt_zh)

        # English UI / no paper target
        self.ws.update("paper", lambda p: p["meta"].pop("target", None))
        with patch("easyread.i18n.lang", return_value="en"):
            prompt_en = chat.prompt(self.ws, [{"role": "user", "content": "Question"}], "b", "", "openai", answer_style="ste100")
        self.assertIn("只輸出英文（English）回答", prompt_en)
        self.assertNotIn("只輸出繁體中文回答", prompt_en)

    def test_all_modes_roundtrip_through_http_storage_and_pinning(self):
        self.start_server()
        model = {"id": "m", "name": "Model", "engine": "openai", "model": "test"}
        with patch("easyread.server.config.load", return_value={}), \
                patch("easyread.server.chat_models.engine_cfg", return_value=({"engine": "openai"}, model)), \
                patch("easyread.server.chat.stream", side_effect=lambda *a: iter([ANSWER])) as stream:
            for style in answer_styles.VALUES:
                with self.subTest(style=style):
                    events = self.post({"text": "Explain", "anchor": "b", "answer_style": style})
                    tid = events[0]["thread"]
                    self.assertEqual(events[0]["answer_style"], style)
                    saved = chat_store.get(self.ws, tid)
                    self.assertEqual(saved["messages"][-1]["answer_style"], style)
                    text = stream.call_args.args[1]
                    self.assertEqual("A final limitation." in text, style in answer_styles.WHOLE_PAPER)
                    followup = self.post({"thread": tid, "text": "Continue", "anchor": "b"})
                    self.assertEqual(followup[0]["answer_style"], style)
                    chat_store.pin(self.ws, tid, followup[-1]["id"])
                    entry = self.ws.load("discussion")["entries"][-1]
                    self.assertEqual(entry["anchor"], "b")
                    self.assertEqual(entry["body"], ANSWER)

    def test_legacy_messages_do_not_inherit_later_ste_badges(self):
        write_json_atomic(self.ws.root / "chat.json", {"messages": [
            {"role": "user", "content": "旧问题"}, {"role": "assistant", "content": "旧回答"},
        ]})
        chat_store.append(self.ws, "t-first", {"content": "新问题", "answer_style": "ste100"}, ANSWER, "m", "Model")
        saved = chat_store.get(self.ws, "t-first")
        self.assertEqual(saved["answer_style"], "ste100")
        self.assertEqual([m["answer_style"] for m in saved["messages"]], ["standard", "standard", "ste100", "ste100"])

    def test_partially_imported_paper_identifies_missing_pages(self):
        self.ws.update("paper", lambda p: p.update(meta={"page_count": 12}, translation={"done_pages": [1, 2]}))
        text = chat._paper_context(self.ws)
        self.assertIn("只完成整理 2 / 12 頁", text)

    def test_note_question_reply_keeps_chinese_answer_and_formula(self):
        write_json_atomic(self.ws.root / "reader.json", {"notes": {"n1": {"id": "n1", "anchor": "b", "kind": "question", "body": "explain"}}})
        chat_store.append(self.ws, "t-note", {"content": "explain", "note": "n1", "answer_style": "ste100"}, ANSWER, "m", "Model")
        entry = self.ws.load("discussion")["entries"][0]
        self.assertEqual(entry["reply_to"], "n1")
        self.assertEqual(entry["body"], ANSWER)

    def start_server(self):
        ws = self.ws

        class TestHandler(Handler):
            app = types.SimpleNamespace(token="test-token", lib=types.SimpleNamespace(ws=lambda pid: ws),
                                        location=types.SimpleNamespace(status="idle", request=lambda *a: contextlib.nullcontext()))

            def log_message(self, *args):
                pass

        srv = ThreadingHTTPServer(("127.0.0.1", 0), TestHandler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        self.url = f"http://127.0.0.1:{srv.server_port}/api/p/test/chat"

    def post(self, body):
        req = urllib.request.Request(self.url, json.dumps(body).encode(),
                                     {"Content-Type": "application/json", "X-Token": "test-token"})
        with urllib.request.urlopen(req, timeout=5) as res:
            self.assertEqual(res.headers.get_content_type(), "application/x-ndjson")
            return [json.loads(line) for line in res.read().decode().splitlines()]

    def test_stream_and_followup_remember_mode_and_pin_complete_answer(self):
        self.start_server()
        engine = {"engine": "openai"}
        model = {"id": "m", "name": "Model", "engine": "openai", "model": "test"}
        with patch("easyread.server.config.load", return_value={}), \
                patch("easyread.server.chat_models.engine_cfg", return_value=(engine, model)), \
                patch("easyread.server.chat.stream", side_effect=lambda *a: iter([ANSWER[:35], ANSWER[35:]])) as stream:
            events = self.post({"text": "总结论文", "anchor": "b", "answer_style": "ste100"})
            tid = events[0]["thread"]
            self.assertEqual(events[0]["answer_style"], "ste100")
            self.assertEqual("".join(e.get("t", "") for e in events), ANSWER)
            saved = chat_store.get(self.ws, tid)
            self.assertEqual(saved["answer_style"], "ste100")
            self.assertEqual(saved["messages"][-1]["content"], ANSWER)
            chat_store.pin(self.ws, tid, events[-1]["id"])
            self.assertEqual(self.ws.load("discussion")["entries"][0]["body"], ANSWER)
            inherited = self.post({"thread": tid, "text": "再解释一下"})
            self.assertEqual(inherited[0]["answer_style"], "ste100")
            self.assertIn("本次使用 ASD-STE100", stream.call_args.args[1])
            standard = self.post({"thread": tid, "text": "普通解释", "answer_style": "standard"})
            self.assertEqual(standard[0]["answer_style"], "standard")
            self.assertNotIn("本次使用 ASD-STE100", stream.call_args.args[1])
            saved = chat_store.get(self.ws, tid)
            self.assertEqual(saved["answer_style"], "standard")
            self.assertEqual(saved["messages"][1]["answer_style"], "ste100")

    def test_invalid_mode_is_http_400_before_any_model_call(self):
        self.start_server()
        for value in ("unknown", "", ["ste100"], {"style": "ste100"}):
            with self.subTest(value=value), patch("easyread.server.config.load") as cfg, \
                    patch("easyread.server.chat.stream") as stream:
                with self.assertRaises(urllib.error.HTTPError) as result:
                    self.post({"text": "test", "answer_style": value})
                self.assertEqual(result.exception.code, 400)
                self.assertIn("回答方式", json.loads(result.exception.read())["error"])
                cfg.assert_not_called()
                stream.assert_not_called()
        self.assertEqual(chat_store.threads(self.ws), [])
