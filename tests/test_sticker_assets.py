import hashlib
import json
import unittest
from collections import Counter
from pathlib import Path
from xml.etree import ElementTree


WEB = Path(__file__).resolve().parents[1] / "easyread" / "web"


class StickerAssetsTest(unittest.TestCase):
    def test_license_manifest_matches_asset_licenses(self):
        repo = WEB.parents[1]
        paths = [repo / "data/stickers/license-manifest.json", WEB / "stickers/license-manifest.json"]
        manifests = [json.loads(path.read_text(encoding="utf-8")) for path in paths]
        self.assertEqual(manifests[0], manifests[1])
        assets = json.loads((WEB / "stickers/sticker-manifest.json").read_text(encoding="utf-8"))["assets"]
        used = {license_id for asset in assets for license_id in asset["license_ids"]}
        self.assertEqual(used, {license["id"] for license in manifests[0]["licenses"]})
        self.assertEqual(used, {"ISC", "MIT-Feather", "CC-BY-SA-4.0"})

    def test_maria_letta_assets_are_decorative_in_both_catalogs(self):
        repo = WEB.parents[1]
        manifests = [json.loads((repo / "data/stickers/sticker-manifest.json").read_text(encoding="utf-8")),
                     json.loads((WEB / "stickers/sticker-manifest.json").read_text(encoding="utf-8"))]
        self.assertEqual(manifests[0], manifests[1])
        colored = [a for a in manifests[0]["assets"] if a.get("creator") == "Maria Letta" and a.get("source") == "Mega Doodles Pack"]
        self.assertEqual(len(colored), 99)
        for item in colored:
            self.assertEqual(item["category"], "decorative")
            relative = Path(item["path"].removeprefix("/public/stickers/"))
            self.assertEqual(relative.parts[0], "decorative")
            self.assertEqual(hashlib.sha256((repo / "public/stickers" / relative).read_bytes()).hexdigest(), item["sha256"])

    def test_catalog_files_and_svg_safety(self):
        root = WEB / "stickers"
        manifest = json.loads((root / "sticker-manifest.json").read_text(encoding="utf-8"))
        assets = manifest["assets"]
        self.assertEqual(manifest["total"], len(assets))
        self.assertEqual(len(assets), len({item["id"] for item in assets}))
        self.assertEqual(manifest["categories"], dict(Counter(item["category"] for item in assets)))
        for item in assets:
            with self.subTest(id=item["id"]):
                relative = Path(item["path"].removeprefix("/public/stickers/"))
                self.assertNotIn("..", relative.parts)
                self.assertEqual(relative.parts[0], item["category"])
                data = (root / relative).read_bytes()
                self.assertEqual(hashlib.sha256(data).hexdigest(), item["sha256"])
                self.assertEqual(relative.suffix, ".svg")
                self.assertNotIn(b"<!doctype", data.lower())
                self.assertNotIn(b"<!entity", data.lower())
                self.assertNotIn(b"url(", data.lower())
                self.assertNotIn(b"@import", data.lower())
                svg = ElementTree.fromstring(data)
                for element in svg.iter():
                    self.assertNotIn(element.tag.split("}")[-1].lower(), {"script", "image", "foreignobject"})
                    for key in element.attrib:
                        self.assertFalse(key.lower().startswith("on") or key.lower().endswith("href"))
