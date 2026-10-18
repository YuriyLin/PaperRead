"""Comparison-only Latin ligature regressions; no library or model access."""
import unittest
from types import SimpleNamespace

from easyread.table_extract import UnreliableTable, _matrix


class TableLigatureTest(unittest.TestCase):
    def matrix(self, source, extracted):
        values = [["Label", "Value"], [extracted, "12"]]
        originals = [["Label", "Value"], [source, "12"]]
        rows, chars = [], []
        for i, row in enumerate(originals):
            cells = [(j * 100, i * 20, (j + 1) * 100, (i + 1) * 20) for j in range(2)]
            rows.append(SimpleNamespace(cells=cells, bbox=(0, i * 20, 200, (i + 1) * 20)))
            for j, value in enumerate(row):
                for k, char in enumerate(value):
                    chars.append({"text": char, "x0": j * 100 + k + 1,
                                  "x1": j * 100 + k + 2, "top": i * 20 + 1,
                                  "bottom": i * 20 + 11, "size": 10,
                                  "fontname": "Test-Bold" if i == 0 else "Test"})
        page = SimpleNamespace(chars=chars)
        table = SimpleNamespace(rows=rows, bbox=(0, 0, 200, 40), extract=lambda **kw: values)
        return _matrix(page, table, "lines")

    def test_latin_ligatures_expand_on_either_side_without_changing_cells(self):
        for ligature, expanded in (("\ufb00", "ff"), ("\ufb01", "fi"), ("\ufb02", "fl"),
                                   ("\ufb03", "ffi"), ("\ufb04", "ffl"),
                                   ("\ufb05", "st"), ("\ufb06", "st")):
            for source, extracted in ((ligature, expanded), (expanded, ligature)):
                with self.subTest(source=source, extracted=extracted):
                    head, body, physical = self.matrix(source, extracted)
                    self.assertEqual(head, [["Label", "Value"]])
                    self.assertEqual(body, [[extracted, "12"]])
                    self.assertEqual(len(physical), 2)

    def test_reported_five_fi_and_one_fl_counts(self):
        _, body, _ = self.matrix("\ufb01" * 5 + "\ufb02", "fi" * 5 + "fl")
        self.assertEqual(body, [["fi" * 5 + "fl", "12"]])

    def test_real_differences_still_reject_even_with_ligatures(self):
        for source, extracted in (
            ("\ufb01 123", "fi 12"),       # Missing digit.
            ("\ufb01 123", "fi 124"),      # Changed digit.
            ("\ufb01", "fii"),            # Duplicated character.
            ("\ufb01 x", "fi y"),         # Non-ligature difference.
            ("\ufb01 \u22121", "fi -1"),  # Distinct minus signs.
            ("\ufb01 \u00b5m", "fi \u03bcm"),  # Distinct unit characters.
            ("\ufb01 \u00b2", "fi 2"),    # No general compatibility folding.
            ("\ufb01 [1]", "fi [2]"),     # Changed citation.
        ):
            with self.subTest(source=source, extracted=extracted):
                with self.assertRaisesRegex(UnreliableTable, "Extracted text does not match source glyphs"):
                    self.matrix(source, extracted)


if __name__ == "__main__":
    unittest.main()
