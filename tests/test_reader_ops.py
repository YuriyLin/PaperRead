import base64
import tempfile
import unittest
from pathlib import Path

from easyread.store import Workspace


class ReaderOpsTest(unittest.TestCase):
    def test_text_box_and_safe_sticker_link_round_trip(self):
        with tempfile.TemporaryDirectory() as d:
            ws = Workspace(Path(d))
            base = {"id": "s1", "assetId": "book-open", "anchor": "p1", "textHash": "1234abcd",
                    "ref": [200, 100], "x": 10, "y": 20, "width": 40, "height": 30,
                    "rotation": 0, "opacity": 1, "z": 1, "locked": False}
            ws.apply_reader_ops([{"op": "sticker", "sticker": {**base, "href": "https://example.com/paper"}}])
            self.assertEqual(ws.load("reader")["stickers"]["s1"]["href"], "https://example.com/paper")
            for url in ("javascript:alert(1)", "data:text/html,foo", "https://user:pass@example.com", "https://example.com/\nheader", "https://example.com:99999"):
                with self.subTest(url=url), self.assertRaises(ValueError):
                    ws.apply_reader_ops([{"op": "sticker", "sticker": {**base, "id": "bad", "href": url}}])
            text = {**base, "id": "t1", "assetId": "paperread-text-box", "text": "第一行 $x^2$\nsecond line", "textBold": True}
            ws.apply_reader_ops([{"op": "sticker", "sticker": text}])
            self.assertEqual(ws.load("reader")["stickers"]["t1"]["text"], text["text"])
            self.assertTrue(ws.load("reader")["stickers"]["t1"]["textBold"])
            grouped = {**text, "id": "t2", "groupId": "gabc123"}
            ws.apply_reader_ops([{"op": "sticker", "sticker": grouped}])
            self.assertEqual(ws.load("reader")["stickers"]["t2"]["groupId"], "gabc123")
            with self.assertRaises(ValueError):
                ws.apply_reader_ops([{"op": "sticker", "sticker": {**text, "text": "x" * 2001}}])
            for field, value in (("textColor", "red"), ("textSize", 100), ("textSize", float("nan"))):
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    ws.apply_reader_ops([{"op": "sticker", "sticker": {**text, field: value}}])
            with self.assertRaises(ValueError):
                ws.apply_reader_ops([{"op": "sticker", "sticker": {**text, "textBold": "yes"}}])
            with self.assertRaises(ValueError):
                ws.apply_reader_ops([{"op": "sticker", "sticker": {**text, "groupId": "not valid"}}])

    def test_sticker_persistence_deletion_and_validation(self):
        with tempfile.TemporaryDirectory() as d:
            ws = Workspace(Path(d))
            sticker = {"id": "s1", "assetId": "doodle-fox", "anchor": "p1", "textHash": "1234abcd",
                       "ref": [200, 100], "x": 10, "y": 20, "width": 40, "height": 30,
                       "rotation": 90, "opacity": 0.5, "z": 1, "locked": False}
            ws.apply_reader_ops([{"op": "sticker", "sticker": sticker, "at": "2026-10-01T00:01:00Z"}])
            self.assertEqual(ws.load("reader")["stickers"]["s1"]["rotation"], 90)
            styled = {**sticker, "strokeColor": "#336699", "strokeWidth": 3.25}
            ws.apply_reader_ops([{"op": "sticker", "sticker": styled, "at": "2026-10-01T00:01:30Z"}])
            self.assertEqual(ws.load("reader")["stickers"]["s1"]["strokeColor"], "#336699")
            self.assertEqual(ws.load("reader")["stickers"]["s1"]["strokeWidth"], 3.25)
            for field, value in [("strokeColor", "red"), ("strokeWidth", float("nan")), ("strokeWidth", 4.5)]:
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    ws.apply_reader_ops([{"op": "sticker", "sticker": {**sticker, "id": "invalid-style", field: value}}])
            ws.apply_reader_ops([{"op": "sticker_del", "id": "s1", "at": "2026-10-01T00:02:00Z"}])
            ws.apply_reader_ops([{"op": "sticker", "sticker": sticker, "at": "2026-10-01T00:01:00Z"}])
            self.assertTrue(ws.load("reader")["stickers"]["s1"]["deleted"])
            with self.assertRaises(ValueError):
                ws.apply_reader_ops([{"op": "sticker", "sticker": {**sticker, "id": "bad", "x": float("nan")}}])
            safe_svg = b'<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1"/></svg>'
            unsafe_svg = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
            data = lambda b: "data:image/svg+xml;base64," + base64.b64encode(b).decode("ascii")
            custom = {**sticker, "id": "custom1", "assetId": "custom-123", "customData": data(safe_svg)}
            ws.apply_reader_ops([{"op": "sticker", "sticker": custom}])
            self.assertEqual(ws.load("reader")["stickers"]["custom1"]["customData"], data(safe_svg))
            with self.assertRaises(ValueError):
                ws.apply_reader_ops([{"op": "sticker", "sticker": {**custom, "id": "unsafe", "customData": data(unsafe_svg)}}])
            for content in [b'<svg xmlns="http://www.w3.org/2000/svg" onload="evil()"/>',
                            b'<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/x"/></svg>',
                            b'<svg xmlns="http://www.w3.org/2000/svg"><style>.a{fill:url(https://example.com/x)}</style></svg>']:
                with self.subTest(content=content), self.assertRaises(ValueError):
                    ws.apply_reader_ops([{"op": "sticker", "sticker": {**custom, "id": "unsafe", "customData": data(content)}}])

    def test_ink_strokes_merge_by_id_and_reject_invalid_coordinates(self):
        with tempfile.TemporaryDirectory() as d:
            ws = Workspace(Path(d))
            stroke = {"id": "i1", "group": "g1", "anchor": "p1", "textHash": "1234abcd", "ref": [200, 100],
                      "points": [[1, 2], [3.5, 8]], "color": "#d94b4b", "width": 2}
            ws.apply_reader_ops([{"op": "ink", "stroke": stroke, "at": "2026-10-01T00:01:00Z"}])
            grouped = {**stroke, "id": "i2", "groupId": "gabc123"}
            ws.apply_reader_ops([{"op": "ink", "stroke": grouped, "at": "2026-10-01T00:01:01Z"}])
            self.assertEqual(ws.load("reader")["ink"]["i2"]["groupId"], "gabc123")
            ws.apply_reader_ops([{"op": "ink_del", "id": "i1", "at": "2026-10-01T00:02:00Z"}])
            ws.apply_reader_ops([{"op": "ink", "stroke": stroke, "at": "2026-10-01T00:01:00Z"}])
            self.assertTrue(ws.load("reader")["ink"]["i1"]["deleted"])
            with self.assertRaises(ValueError):
                ws.apply_reader_ops([{"op": "ink", "stroke": {**stroke, "id": "bad", "points": [[float("nan"), 1]]}}])
            with self.assertRaises(ValueError):
                ws.apply_reader_ops([{"op": "ink", "stroke": {**stroke, "id": "bad-group", "groupId": "not valid"}}])

    def test_deletion_wins_over_delayed_creation_in_both_orders(self):
        note = {"op": "note", "note": {"id": "n1", "body": "旧笔记", "updated": "2026-10-01T00:01:00Z"}}
        delete = {"op": "note_del", "id": "n1", "at": "2026-10-01T00:02:00Z"}
        for ops in [[note, delete], [delete, note]]:
            with self.subTest(ops=ops), tempfile.TemporaryDirectory() as d:
                ws = Workspace(Path(d))
                for op in ops:
                    ws.apply_reader_ops([op])
                self.assertTrue(ws.load("reader")["notes"]["n1"]["deleted"])
                # Explicitly restoring with a newer edit is still possible.
                ws.apply_reader_ops([{**note, "note": {**note["note"], "updated": "2026-10-01T00:03:00Z"}}])
                self.assertFalse(ws.load("reader")["notes"]["n1"].get("deleted", False))

    def test_reading_position_keeps_block_offset_and_ratio(self):
        """回到上次读到的地方要用这三样：哪一块、线在块里的位置、全文比例。"""
        with tempfile.TemporaryDirectory() as d:
            ws = Workspace(Path(d))
            ws.apply_reader_ops([{"op": "progress", "block": "p2", "off": 0.32, "ratio": 0.43, "at": "2026-10-01T00:01:00Z"}])
            self.assertEqual(ws.load("reader")["progress"],
                             {"block": "p2", "off": 0.32, "ratio": 0.43, "at": "2026-10-01T00:01:00Z"})
            # 更早的位置晚到，不覆盖
            ws.apply_reader_ops([{"op": "progress", "block": "p1", "off": 0.9, "ratio": 0.1, "at": "2026-10-01T00:00:00Z"}])
            self.assertEqual(ws.load("reader")["progress"]["block"], "p2")
            # 1.4.2 及以前的操作只带 ratio，照旧能落盘
            ws.apply_reader_ops([{"op": "progress", "block": "p5", "ratio": 0.6, "at": "2026-10-01T00:02:00Z"}])
            self.assertEqual(ws.load("reader")["progress"]["ratio"], 0.6)
            self.assertNotIn("off", ws.load("reader")["progress"])
