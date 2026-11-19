"""圖塊裁切、自動補截與手動重框測試。"""
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from pypdf import PdfWriter

from easyread import engines, figures, manual_crop, prompts_en, translate
from easyread.store import Workspace, write_json_atomic


class FigureTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        writer = PdfWriter()
        writer.add_blank_page(width=100, height=100)
        writer.write(self.root / "source.pdf")

    @staticmethod
    def figure():
        return {
            "id": "fig1", "type": "figure", "page": 1,
            "box": [.1, .1, .4, .4], "src": "figures/old.webp",
            "image_en": "Accuracy", "image_zh": "準確率", "caption_en": "Figure 1",
        }

    def test_normalize_figure_preserves_valid_box_and_strips_image_text(self):
        block = {
            "id": "fig1", "type": "figure", "page": 1,
            "box": [.1, .1, .4, .4],
            "image_text_en": " Accuracy ", "image_zh": " 準確率 ", "image_en": " Accuracy ",
        }
        figures.normalize_figure(block)
        self.assertEqual(block["box"], [0.1, 0.1, 0.4, 0.4])
        self.assertNotIn("image_en", block)
        self.assertNotIn("image_zh", block)
        self.assertNotIn("image_text_en", block)
        self.assertNotIn("image_text_zh", block)

    def test_prepare_figures_crops_valid_box_and_sets_abox(self):
        blocks = [self.figure()]
        with mock.patch.object(figures, "crop", return_value="figures/crop-1-abc.webp") as crop:
            figures.prepare_figures(self.root, blocks, 1)
        crop.assert_called_once_with(self.root, 1, [0.1, 0.1, 0.4, 0.4])
        self.assertEqual(blocks[0]["src"], "figures/crop-1-abc.webp")
        self.assertEqual(blocks[0]["abox"], [0.1, 0.1, 0.4, 0.4])

    def test_invalid_coordinates_are_rejected(self):
        for box in ([0, 0, float("nan"), 1], [0, 0, float("inf"), 1], [.8, 0, .2, 1]):
            self.assertIsNone(figures.figure_box(box))

    def test_read_omits_image_text_and_crops_figure(self):
        ws = Workspace(self.root)
        (self.root / "extract").mkdir()
        write_json_atomic(self.root / "paper.json", {"meta": {"page_count": 1}, "blocks": [], "translation": {}})
        cfg = {"engine": "openai", "openai": {"vision": False}}
        fig = {k: v for k, v in self.figure().items() if k != "image_zh"}
        with mock.patch.object(engines, "run", return_value=json.dumps({"blocks": [fig]})), \
             mock.patch.object(translate, "_problems", return_value=[]), \
             mock.patch.object(translate.pdfwork, "locate"):
            translate._one_batch(ws, cfg, [1], 1, threading.Event(), lambda *a: None, read=True)
        block = ws.load("paper")["blocks"][0]
        self.assertTrue(block["src"].startswith("figures/crop-1-"))
        self.assertNotIn("image_en", block)
        self.assertNotIn("image_zh", block)
        self.assertNotIn("fig1#image", prompts_en.todo([block]))

    def test_duplicate_figure_id_gets_deduplicated_and_cropped(self):
        ws = Workspace(self.root)
        (self.root / "extract").mkdir()
        old = self.figure()
        old["src"] = "figures/kept.webp"
        write_json_atomic(self.root / "paper.json", {"meta": {"page_count": 1}, "blocks": [old], "translation": {}})
        cfg = {"engine": "openai", "openai": {"vision": False}}
        with mock.patch.object(engines, "run", return_value=json.dumps({"blocks": [self.figure()]})), \
             mock.patch.object(translate, "_problems", return_value=[]), \
             mock.patch.object(translate.pdfwork, "locate"):
            translate._one_batch(ws, cfg, [1], 1, threading.Event(), lambda *a: None)
        blocks = {b["id"]: b for b in ws.load("paper")["blocks"]}
        self.assertIn("fig1", blocks)
        self.assertTrue(blocks["fig1"]["src"].startswith("figures/crop-1-"))

    def test_fill_updates_from_layout_and_skips_manual_crop(self):
        ws = Workspace(self.root)
        auto_block = {"id": "fig1", "type": "figure", "page": 1, "src": ""}
        manual_block = {"id": "fig2", "type": "figure", "page": 1, "src": "figures/crop-1-manual.webp", "manual_crop": {"src": ""}}
        write_json_atomic(self.root / "paper.json", {"meta": {"page_count": 1}, "blocks": [auto_block, manual_block]})
        write_json_atomic(self.root / "layout.json", {
            "fig1": {"page": 1, "box": [.1, .1, .8, .8]},
            "fig2": {"page": 1, "box": [.2, .2, .9, .9]},
        })
        self.assertEqual(figures.missing(ws), [("fig1", 1, [0.1, 0.1, 0.8, 0.8])])
        updated = figures.fill(ws)
        self.assertEqual(updated, 1)
        blocks = {b["id"]: b for b in ws.load("paper")["blocks"]}
        self.assertTrue(blocks["fig1"]["src"].startswith("figures/crop-1-"))
        self.assertEqual(blocks["fig1"]["abox"], [0.1, 0.1, 0.8, 0.8])
        self.assertEqual(blocks["fig2"]["src"], "figures/crop-1-manual.webp")

    def test_manual_crop_save_and_reset(self):
        ws = Workspace(self.root)
        orig = {"id": "fig1", "type": "figure", "page": 1, "src": "figures/auto.webp", "abox": [0.1, 0.1, 0.5, 0.5], "box": [0.1, 0.1, 0.5, 0.5]}
        write_json_atomic(self.root / "paper.json", {"meta": {"page_count": 1, "pages": [{"n": 1, "img": "pages/page-001.webp"}]}, "blocks": [orig]})
        res = manual_crop.save(ws, {"id": "fig1", "page": 1, "box": [0.2, 0.2, 0.8, 0.8]})
        saved = res["block"]
        self.assertTrue(saved["src"].startswith("figures/crop-1-"))
        self.assertEqual(saved["abox"], [0.2, 0.2, 0.8, 0.8])
        self.assertEqual(saved["manual_crop"]["src"], "figures/auto.webp")

        reset_res = manual_crop.save(ws, {"id": "fig1", "reset": True})
        restored = reset_res["block"]
        self.assertEqual(restored["src"], "figures/auto.webp")
        self.assertEqual(restored["abox"], [0.1, 0.1, 0.5, 0.5])
        self.assertNotIn("manual_crop", restored)

    def test_figure_crop_http_endpoint(self):
        import http.client
        import http.server
        import json
        from easyread import server

        ws = Workspace(self.root)
        orig = {"id": "fig1", "type": "figure", "page": 1, "src": "figures/auto.webp", "abox": [0.1, 0.1, 0.5, 0.5], "box": [0.1, 0.1, 0.5, 0.5]}
        write_json_atomic(self.root / "paper.json", {"meta": {"page_count": 1, "pages": [{"n": 1, "img": "pages/page-001.webp"}]}, "blocks": [orig]})
        write_json_atomic(self.root / "job.json", {"state": "done"})

        lib = mock.MagicMock()
        lib.ws.return_value = ws
        loc = mock.MagicMock()
        loc.status = "idle"
        app = mock.MagicMock()
        app.lib = lib
        app.location = loc
        app.token = "tok"
        app.hosts = server.allowed_hosts("127.0.0.1")

        handler_cls = type("TestHandler", (server.Handler,), {"app": app})
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        conn = None
        try:
            conn = http.client.HTTPConnection("127.0.0.1", srv.server_address[1], timeout=5)
            headers = {"Content-Type": "application/json", "X-Token": "tok"}
            conn.request("POST", f"/api/p/{ws.id}/figure-crop", json.dumps({"id": "fig1", "page": 1, "box": [0.2, 0.2, 0.8, 0.8]}), headers)
            resp = conn.getresponse()
            data = json.loads(resp.read().decode("utf-8"))
            self.assertEqual(resp.status, 200)
            self.assertTrue(data["block"]["src"].startswith("figures/crop-1-"))
            self.assertEqual(data["block"]["abox"], [0.2, 0.2, 0.8, 0.8])

            # Reject manual crop while translation job is running
            write_json_atomic(self.root / "job.json", {"state": "running"})
            conn.request("POST", f"/api/p/{ws.id}/figure-crop", json.dumps({"id": "fig1", "reset": True}), headers)
            resp = conn.getresponse()
            resp.read()
            self.assertEqual(resp.status, 400)

            # Reset succeeds once job is idle
            write_json_atomic(self.root / "job.json", {"state": "done"})
            conn.request("POST", f"/api/p/{ws.id}/figure-crop", json.dumps({"id": "fig1", "reset": True}), headers)
            resp = conn.getresponse()
            data = json.loads(resp.read().decode("utf-8"))
            self.assertEqual(resp.status, 200)
            self.assertEqual(data["block"]["src"], "figures/auto.webp")
            self.assertNotIn("manual_crop", data["block"])
        finally:
            if conn:
                conn.close()
            srv.shutdown()
            srv.server_close()


if __name__ == "__main__":
    unittest.main()
