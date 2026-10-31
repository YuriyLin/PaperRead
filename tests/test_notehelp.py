"""筆記 AI 助手的語言與輸出規則。"""
import shutil
import unittest

from easyread import notehelp
from tests.test_translate import make_ws


class NoteHelpPromptTest(unittest.TestCase):
    def setUp(self):
        self.ws = make_ws(1)
        self.ws.update("paper", lambda paper: paper.setdefault("meta", {}).update({"target": "zh-TW"}))

    def tearDown(self):
        shutil.rmtree(self.ws.root, ignore_errors=True)

    def test_traditional_prompt_is_explicit_for_review_and_draft(self):
        for mode in ("review", "revise", "draft"):
            with self.subTest(mode=mode):
                prompt = notehelp.prompt(self.ws, mode, "我的筆記", "openai")
                self.assertIn("繁體中文（臺灣用語）", prompt)
                self.assertIn("不可使用簡體字", prompt)
                self.assertNotIn("请点评", prompt)
                self.assertNotIn("请帮读者", prompt)

    def test_draft_and_revise_forbid_blank_placeholders_and_include_reader_annotations(self):
        self.ws.update("reader", lambda r: r.setdefault("notes", {}).update({
            "n1": {"id": "n1", "quote": "rate-distortion Lagrangian", "body": "關鍵損失函數"}
        }))
        draft_prompt = notehelp.prompt(self.ws, "draft", "", "openai")
        self.assertIn("不要留空白填空區或空列點", draft_prompt)
        self.assertNotIn("留出他自己思考的空間", draft_prompt)
        self.assertIn("rate-distortion Lagrangian", draft_prompt)
        self.assertIn("關鍵損失函數", draft_prompt)

        revise_prompt = notehelp.prompt(self.ws, "revise", "> 我的理解：\n> - \n", "openai")
        self.assertIn("若筆記中有未填寫的空白區塊、空引用塊或空列點，請直接根據論文內容補齊具體內容並移除空白項目", revise_prompt)

    def test_table_headers_and_rows_are_included_in_paper_text(self):
        self.ws.update("paper", lambda p: p.setdefault("blocks", []).append({
            "id": "tab1",
            "type": "table",
            "page": 6,
            "caption_zh": "表 2：翻譯模型表現對比",
            "head": [["Model", "EN-DE BLEU", "EN-FR BLEU"]],
            "rows": [["Transformer (base)", "27.3", "38.1"], ["Transformer (big)", "28.4", "41.8"]],
        }))
        draft_prompt = notehelp.prompt(self.ws, "draft", "", "openai")
        self.assertIn("表 2：翻譯模型表現對比", draft_prompt)
        self.assertIn("Model | EN-DE BLEU | EN-FR BLEU", draft_prompt)
        self.assertIn("Transformer (big) | 28.4 | 41.8", draft_prompt)


    def test_local_model_detection_and_notice(self):
        # 1. Ollama preset
        ecfg = {"engine": "openai", "openai": {"base_url": "http://127.0.0.1:11434/v1"}}
        m = {"engine": "openai", "preset": "ollama", "model": "llama3.1"}
        self.assertTrue(notehelp.is_local_model(ecfg, m))
        notice = notehelp.local_model_notice(ecfg, m)
        self.assertIn("本地模型", notice)
        self.assertIn("num_ctx", notice)

        # 2. LM Studio preset
        m_lm = {"engine": "openai", "preset": "lmstudio", "model": "qwen2.5"}
        self.assertTrue(notehelp.is_local_model(ecfg, m_lm))

        # 3. Custom localhost URL
        ecfg_local = {"engine": "openai", "openai": {"base_url": "http://localhost:8000/v1"}}
        m_custom = {"engine": "openai", "preset": "", "model": "my-model"}
        self.assertTrue(notehelp.is_local_model(ecfg_local, m_custom))

        # 4. Cloud / non-local models
        ecfg_claude = {"engine": "claude", "claude": {}}
        m_claude = {"engine": "claude", "model": "sonnet"}
        self.assertFalse(notehelp.is_local_model(ecfg_claude, m_claude))
        self.assertEqual(notehelp.local_model_notice(ecfg_claude, m_claude), "")

        ecfg_cloud = {"engine": "openai", "openai": {"base_url": "https://api.openai.com/v1"}}
        m_cloud = {"engine": "openai", "preset": "openai", "model": "gpt-4o"}
        self.assertFalse(notehelp.is_local_model(ecfg_cloud, m_cloud))
        self.assertEqual(notehelp.local_model_notice(ecfg_cloud, m_cloud), "")

    def test_source_text_prioritizes_en_and_includes_glossary(self):
        self.ws.update("paper", lambda p: p.update({
            "glossary": [{"en": "Multi-Head Attention", "zh": "多頭注意力機制"}],
            "blocks": [
                {"id": "h1", "type": "heading", "page": 1, "num": "1", "en": "Introduction", "zh": "引言"},
                {"id": "p1", "type": "para", "page": 1, "en": "Recurrent models generate sequences.", "zh": "循環模型生成序列。"},
                {"id": "m1", "type": "math", "page": 2, "tex": "Attention(Q,K,V) = \\mathrm{softmax}(QK^T/\\sqrt{d})V"},
            ]
        }))
        prompt = notehelp.prompt(self.ws, "draft", "", "openai")
        self.assertIn("已有術語表", prompt)
        self.assertIn("Multi-Head Attention = 多頭注意力機制", prompt)
        self.assertIn("Introduction", prompt)
        self.assertIn("Recurrent models generate sequences.", prompt)
        self.assertIn("Attention(Q,K,V) = \\mathrm{softmax}(QK^T/\\sqrt{d})V", prompt)

    def test_non_chinese_target_language_in_notehelp(self):
        self.ws.update("paper", lambda p: p.setdefault("meta", {}).update({"target": "ko"}))
        prompt = notehelp.prompt(self.ws, "draft", "", "openai")
        self.assertIn("用韩语（한국어）", prompt)
        self.assertIn("所有章節標題與內文一律依照指定語言撰寫", prompt)



if __name__ == "__main__":
    unittest.main()
