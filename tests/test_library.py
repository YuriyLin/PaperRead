"""文献库与文献管理测试：垃圾桶、标题覆盖、外部打开链接以及资料夹选取。
python -m unittest tests.test_library"""
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import parse_qs

from easyread import folder_pick, open_link, trash
from easyread.library import Library, sha256_bytes
from easyread.store import Workspace, write_json_atomic


class TrashTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        for name in ("aaaaaaaaaaaa-20261001120000", "bbbbbbbbbbbb-20261001130000"):
            (self.root / ".trash" / name).mkdir(parents=True)

    def test_list_newest_first(self):
        self.assertEqual([t["id"] for t in trash.items(self.root)], ["bbbbbbbbbbbb", "aaaaaaaaaaaa"])

    def test_restore_and_conflict(self):
        self.assertEqual(trash.restore(self.root, "aaaaaaaaaaaa-20261001120000"), "aaaaaaaaaaaa")
        self.assertTrue((self.root / "aaaaaaaaaaaa").is_dir())
        (self.root / "bbbbbbbbbbbb").mkdir()  # 后来又导入过同一篇
        with self.assertRaises(ValueError):
            trash.restore(self.root, "bbbbbbbbbbbb-20261001130000")

    def test_purge_needs_a_valid_name(self):
        for bad in ("", "../x", "aaaaaaaaaaaa"):
            with self.assertRaises(ValueError):
                trash.purge(self.root, bad)
        self.assertEqual(len(trash.items(self.root)), 2)  # 名字不对时什么都没删
        trash.purge(self.root, "aaaaaaaaaaaa-20261001120000")
        self.assertEqual(trash.empty(self.root), 1)
        self.assertEqual(trash.items(self.root), [])


class TitleOverrideTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.lib = Library(self.root)
        self.ws_dir = self.root / "testpaper"
        self.ws_dir.mkdir(parents=True)
        self.ws = Workspace(self.ws_dir)

    def test_parts_includes_item(self):
        self.assertIn("item", Workspace.PARTS)
        versions = self.ws.versions()
        self.assertIn("item", versions)

    def test_summary_derives_short_zh_when_title_zh_is_overridden(self):
        paper_data = {
            "meta": {
                "title_en": "Do Vision-Language Models Lose Confidence? A Study of Sycophancy in VLMs",
                "title_zh": "視覺語言模型是否失去了信心？VLMs 諂媚現象研究",
                "short_zh": "VLMs 阿諛現象研究",
                "target": "zh-TW"
            },
            "blocks": []
        }
        write_json_atomic(self.ws.paper_path, paper_data)
        write_json_atomic(self.ws.item_path, {"meta_override": {"title_zh": "視覺語言模型是否失去信心？VLMs 諂媚現象研究"}})

        summary = self.lib.summary(self.ws)
        self.assertEqual(summary["title_zh"], "視覺語言模型是否失去信心？VLMs 諂媚現象研究")
        self.assertEqual(summary["short_zh"], "VLMs 諂媚現象研究")

    def test_summary_keeps_custom_short_zh_if_explicitly_set(self):
        paper_data = {
            "meta": {
                "title_en": "Test Paper",
                "title_zh": "舊標題",
                "short_zh": "舊短標題",
                "target": "zh-TW"
            },
            "blocks": []
        }
        write_json_atomic(self.ws.paper_path, paper_data)
        write_json_atomic(self.ws.item_path, {
            "meta_override": {
                "title_zh": "新標題：副標題",
                "short_zh": "自訂短標題"
            }
        })

        summary = self.lib.summary(self.ws)
        self.assertEqual(summary["title_zh"], "新標題：副標題")
        self.assertEqual(summary["short_zh"], "自訂短標題")


PDF = b"%PDF-1.4\n%open-link test\n"


class OpenLinkTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.lib = Library(Path(self.tmp.name))
        self.ws, _ = self.lib.create_from_pdf(PDF, "a.pdf", {"title_en": "A"})
        self.sha = sha256_bytes(PDF)

    def tearDown(self):
        self.tmp.cleanup()

    def target(self, query: str) -> str:
        return open_link.target(self.lib, parse_qs(query))

    def test_opens_paper_by_fingerprint_with_block_anchor(self):
        self.assertEqual(self.target(f"sha256={self.sha.upper()}&block=p3-2"), f"/read/{self.ws.root.name}#p3-2")

    def test_opens_paper_by_id(self):
        self.assertEqual(self.target(f"id={self.ws.root.name}"), f"/read/{self.ws.root.name}")

    def test_unknown_or_malformed_links_fall_back_to_library(self):
        self.assertEqual(self.target("sha256=" + "b" * 64), "/")
        self.assertEqual(self.target("sha256=xyz"), "/")
        self.assertEqual(self.target("id=../x"), "/")

    def test_unsafe_block_is_dropped(self):
        self.assertEqual(self.target(f"sha256={self.sha}&block=<x>"), f"/read/{self.ws.root.name}")

    def test_version_reports_api_level(self):
        self.assertEqual(open_link.version()["api"], 1)


class FolderPickTest(unittest.TestCase):
    def run_with(self, returncode, stdout):
        done = subprocess.CompletedProcess([], returncode, stdout=stdout.encode("utf-8"), stderr=b"")
        with patch("easyread.folder_pick.sys.platform", "win32"), \
             patch.object(subprocess, "STARTUPINFO", lambda: SimpleNamespace(dwFlags=0, wShowWindow=0), create=True), \
             patch.object(subprocess, "STARTF_USESHOWWINDOW", 1, create=True), \
             patch("easyread.folder_pick.subprocess.run", return_value=done) as run:
            return folder_pick.pick("选文件夹"), run

    def test_returns_chosen_path_without_trailing_separator(self):
        path, run = self.run_with(0, "D:\\坚果云\\论文\\\n")
        self.assertEqual(path, "D:\\坚果云\\论文")
        self.assertEqual(run.call_args.kwargs["env"]["EASYREAD_PICK_TITLE"], "选文件夹")
        self.assertEqual(run.call_args.kwargs["startupinfo"].wShowWindow, 1)

    def test_cancel_returns_empty(self):
        self.assertEqual(self.run_with(0, "")[0], "")

    def test_windows_dialog_failure_falls_back_to_typing(self):
        with patch("easyread.folder_pick.sys.platform", "win32"):
            self.assertIsNone(self.run_with(1, "")[0])

    def test_unavailable_dialog_returns_none(self):
        with patch("easyread.folder_pick.subprocess.run", side_effect=FileNotFoundError):
            self.assertIsNone(folder_pick.pick("x"))
        with patch("easyread.folder_pick.sys.platform", "linux"), patch("easyread.folder_pick.shutil.which", return_value=None):
            self.assertIsNone(folder_pick.pick("x"))

    def test_powershell_script_is_ascii_and_uses_the_explorer_style_dialog(self):
        folder_pick._PS.encode("ascii")
        self.assertIn("FOS_PICKFOLDERS", folder_pick._PS)
        self.assertNotIn("FolderBrowserDialog", folder_pick._PS)


if __name__ == "__main__":
    unittest.main()
