"""OpenAI 兼容接口的两种格式（chat / responses）、去掉 temperature 重试、模型列表。  python -m unittest tests.test_openai_api"""
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from easyread import openai_api

SEEN = []


class FakeAPI(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj, ctype="application/json"):
        data = obj if isinstance(obj, bytes) else json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.headers.get("User-Agent", "").startswith("Python-urllib"):  # 像 Cloudflare 那样拦默认 UA（#10）
            return self._send(403, b"error code: 1010", "text/plain")
        self._send(200, {"object": "list", "data": [{"id": "b-model"}, {"id": "a-model"}]})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        SEEN.append((self.path, body))
        if not self.headers.get("x-opencode-session"):  # 像 OpenCode Go 那样要求会话 ID（#10）
            return self._send(400, {"type": "error", "error": {"type": "MissingSessionID"}})
        if body.get("model") == "slow":
            import time
            time.sleep(3)
        if body.get("model") == "fixed-temp" and "temperature" in body:
            return self._send(400, {"error": {"message": "invalid temperature: only 1 is allowed for this model"}})
        if self.path.endswith("/responses"):
            if body.get("stream"):
                evs = [{"type": "response.created"}, {"type": "response.output_text.delta", "delta": "你"},
                       {"type": "response.output_text.delta", "delta": "好"}, {"type": "response.completed"}]
                return self._send(200, b"".join(b"event: x\ndata: " + json.dumps(e).encode() + b"\n\n" for e in evs), "text/event-stream")
            return self._send(200, {"object": "response", "status": "completed", "output": [
                {"type": "reasoning", "content": [{"type": "reasoning_text", "text": "想一想"}]},
                {"type": "message", "content": [{"type": "output_text", "text": '{"ok": true}'}]}]})
        return self._send(200, {"choices": [{"message": {"content": "chat-ok"}, "finish_reason": "stop"}]})


class OpenAIApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeAPI)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.srv.server_address[1]}/v1"

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def setUp(self):
        SEEN.clear()

    def test_responses_complete(self):
        out = openai_api.complete({"base_url": self.base, "model": "m", "api": "responses"}, "问题", [])
        self.assertEqual(out, '{"ok": true}')                 # 只要 message，不要推理过程
        path, body = SEEN[0]
        self.assertEqual(path, "/v1/responses")
        self.assertNotIn("temperature", body)
        self.assertEqual(body["input"][0]["content"][0], {"type": "input_text", "text": "问题"})

    def test_responses_stream(self):
        o = {"base_url": self.base, "model": "m", "api": "responses"}
        self.assertEqual("".join(openai_api.stream(o, "问题", threading.Event())), "你好")

    def test_cancel_does_not_wait_for_response(self):
        import time
        from easyread.engines import Cancelled
        cancel = threading.Event()
        self.assertEqual(openai_api.complete({"base_url": self.base, "model": "m"}, "q", [], cancel), "chat-ok")
        threading.Timer(0.2, cancel.set).start()
        start = time.monotonic()
        with self.assertRaises(Cancelled):
            openai_api.complete({"base_url": self.base, "model": "slow"}, "q", [], cancel)
        self.assertLess(time.monotonic() - start, 1.5)  # 接口 3 秒才回，点了取消不用等它

    def test_chat_drops_temperature_when_rejected(self):
        self.assertEqual(openai_api.complete({"base_url": self.base, "model": "fixed-temp"}, "q", []), "chat-ok")
        self.assertEqual([("temperature" in b) for _, b in SEEN], [True, False])

    def test_models(self):
        self.assertEqual(openai_api.models({"base_url": self.base + "/"}), ["a-model", "b-model"])

    def test_ollama_disables_default_thinking_but_respects_explicit_choice(self):
        default = openai_api._body({"preset": "ollama", "model": "qwen3.5-4b:latest"}, "q", [], True, 0.4)
        self.assertEqual(default["reasoning_effort"], "none")
        enabled = openai_api._body({"preset": "ollama", "model": "qwen3.5-4b:latest", "reasoning_effort": "high"}, "q", [], True, 0.4)
        self.assertEqual(enabled["reasoning_effort"], "high")
        other = openai_api._body({"preset": "openai", "model": "gpt"}, "q", [], True, 0.4)
        self.assertNotIn("reasoning_effort", other)

    def test_json_mode_is_enabled_only_for_ollama_chat_completions(self):
        ollama = openai_api._body({"preset": "ollama", "model": "local"}, "q", [], False, 0.2, True)
        self.assertEqual(ollama["response_format"], {"type": "json_object"})
        other = openai_api._body({"preset": "openai", "model": "gpt"}, "q", [], False, 0.2, True)
        self.assertNotIn("response_format", other)

    def test_max_output_tokens_maps_to_appropriate_key(self):
        o1 = openai_api._body({"model": "o1-preview", "max_output_tokens": 4096}, "q", [], False, None)
        self.assertEqual(o1.get("max_completion_tokens"), 4096)
        gpt4 = openai_api._body({"model": "gpt-4", "max_output_tokens": 2048}, "q", [], False, 0.2)
        self.assertEqual(gpt4.get("max_tokens"), 2048)
        resp = openai_api._body({"model": "gpt-4o", "max_output_tokens": 1024, "api": "responses"}, "q", [], False, None)
        self.assertEqual(resp.get("max_output_tokens"), 1024)

    def test_truncated_error_preserves_code(self):
        err = openai_api._truncated()
        self.assertEqual(getattr(err, "code", ""), "OUTPUT_TRUNCATED")


if __name__ == "__main__":
    unittest.main()
