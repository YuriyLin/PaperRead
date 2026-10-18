"""Fail-closed cell fidelity experiment using independently pinned geometry.

This verifies text attribution, not table detection or semantic structure. The
reference must come from reviewed annotation, not from the block being checked.
No table.extract(), crop.extract_text(), model, library or application writes.
"""
from __future__ import annotations

import hashlib
import math
import re
from pathlib import Path

import pdfplumber

from easyread import tables

LIGATURES = str.maketrans(dict(zip(
    "\ufb00\ufb01\ufb02\ufb03\ufb04\ufb05\ufb06",
    ("ff", "fi", "fl", "ffi", "ffl", "st", "st"))))
NUMBERS = re.compile(r"\d+(?:[.,]\d+)*(?:[eE][+\-\u2212]?\d+)?")
TOLERANCE = 0.02  # PDF points; accommodates 6-decimal normalized coordinates only.


def canonical(value):
    """Only Latin ligatures and whitespace; retain sign/unit/punctuation order."""
    return ''.join(c for c in value.translate(LIGATURES) if not c.isspace())


def valid_box(box):
    return (isinstance(box, (list, tuple)) and len(box) == 4
            and all(type(n) in (int, float) and math.isfinite(n) for n in box)
            and box[0] < box[2] and box[1] < box[3])


def contains(outer, inner, tolerance=0):
    return (outer[0] - tolerance <= inner[0] and outer[1] - tolerance <= inner[1]
            and inner[2] <= outer[2] + tolerance and inner[3] <= outer[3] + tolerance)


def center_inside(char, box):
    x = (char['x0'] + char['x1']) / 2
    y = (char['top'] + char['bottom']) / 2
    return box[0] <= x < box[2] and box[1] <= y < box[3]


def absolute(box, bounds):
    if not valid_box(box) or not all(0 <= n <= 1 for n in box):
        raise ValueError('invalid_normalized_box')
    width, height = bounds[2] - bounds[0], bounds[3] - bounds[1]
    return [bounds[0] + box[0] * width, bounds[1] + box[1] * height,
            bounds[0] + box[2] * width, bounds[1] + box[3] * height]


def sequence(chars):
    """Order upright glyphs by baseline then x; reject ambiguous layout."""
    if not chars:
        return ''
    if any(not c.get('upright', True) or '\ufffd' in c['text']
           or any(ord(t) < 32 and not t.isspace() for t in c['text']) for c in chars):
        raise ValueError('unmapped_or_rotated_glyph')
    sizes = [c['size'] for c in chars if c['text'].strip()]
    if sizes and (min(sizes) <= 0 or max(sizes) > min(sizes) * 1.25):
        raise ValueError('ambiguous_mixed_size_layout')
    seen, lines = set(), []
    for char in sorted(chars, key=lambda c: (c['bottom'], c['x0'])):
        if char['text'].strip():
            identity = tuple(round(char[k], 4) for k in ('x0', 'x1', 'top', 'bottom'))
            if identity in seen:
                raise ValueError('overlapping_source_glyphs')
            seen.add(identity)
        if not lines or abs(char['bottom'] - lines[-1][0]['bottom']) > 1:
            lines.append([])
        lines[-1].append(char)
    result = []
    for line in lines:
        line.sort(key=lambda c: c['x0'])
        text, previous = '', None
        for char in line:
            if previous and char['x0'] < previous['x1'] - max(0.1, char['size'] * 0.15):
                raise ValueError('ambiguous_horizontal_overlap')
            if previous and char['x0'] - previous['x1'] > char['size'] * 0.3:
                text += ' '
            text += char['text']
            previous = char
        result.append(text)
    return '\n'.join(result)


def reference_for_table(source, truth):
    """Convert reviewed, absolute-coordinate rectangular truth into a reference."""
    if any(c['rowspan'] != 1 or c['colspan'] != 1 for c in truth['cells']):
        raise ValueError('spanned_reference_requires_separate_validator')
    slots = {}
    headers = truth['header_row_count']
    for cell in truth['cells']:
        row, col = cell['row'], cell['col']
        section, index = ('head', row) if row < headers else ('rows', row - headers)
        slots[f'{section}:{index}:{col}'] = cell['box']
    return {'pdf_sha256': source['sha256'], 'page': truth['page'],
            'page_bbox': truth['page_bbox'], 'table_box': truth['box'], 'cells': slots,
            'head_rows': headers, 'body_rows': truth['row_count'] - headers,
            'columns': truth['column_count']}


def verify_block(path, block, reference):
    """Return structured diagnostics. Does not trust block-supplied geometry.

    A matching table_geometry_source is only a freshness check. Trusted source
    digest and slot->box binding are independent inputs, so changing text and
    rehashing it, or swapping text AND boxes, cannot establish provenance.
    """
    issues, cells = [], {}

    def fail(code, slot=None):
        issues.append({'code': code, **({'slot': slot} if slot else {})})

    try:
        digest = hashlib.sha256(Path(path).read_bytes()).hexdigest()
        if digest != reference['pdf_sha256']:
            raise ValueError('pdf_hash_mismatch')
        page_number = reference['page']
        if type(page_number) is not int or page_number < 1:
            raise ValueError('invalid_reference_page')
        if type(block.get('page')) is not int or block['page'] != page_number:
            raise ValueError('page_identity_mismatch')
        if block.get('table_geometry_source') != tables.source_token(block):
            raise ValueError('stale_geometry_token')
        expected = reference['cells']
        if not isinstance(expected, dict) or not expected:
            raise ValueError('empty_reference')
        if any(type(reference[k]) is not int or reference[k] < 1
               for k in ('head_rows', 'body_rows', 'columns')):
            raise ValueError('invalid_reference_dimensions')
        required = {f'{section}:{row}:{col}'
                    for section, count in [('head', reference['head_rows']), ('rows', reference['body_rows'])]
                    for row in range(count) for col in range(reference['columns'])}
        if set(expected) != required:
            raise ValueError('incomplete_reference_slots')
        for field, count in [('head_en', reference['head_rows']), ('rows_en', reference['body_rows'])]:
            matrix = block.get(field)
            if (not isinstance(matrix, list) or len(matrix) != count
                    or any(not isinstance(row, list) or len(row) != reference['columns']
                           or any(not isinstance(c, str) for c in row) for row in matrix)):
                raise ValueError('matrix_shape_mismatch')
        if block.get('footnotes_en'):
            raise ValueError('footnotes_not_covered_by_reference')
        supplied = block.get('table_cell_boxes')
        if not isinstance(supplied, dict) or set(supplied) != set(expected):
            raise ValueError('cell_slot_set_mismatch')
        with pdfplumber.open(path) as pdf:
            if page_number > len(pdf.pages):
                raise ValueError('page_does_not_exist')
            page = pdf.pages[page_number - 1]
            bounds, region = reference['page_bbox'], reference['table_box']
            if not valid_box(bounds) or any(abs(a-b) > TOLERANCE for a,b in zip(page.bbox, bounds)):
                raise ValueError('page_bounds_mismatch')
            if not valid_box(region) or not contains(bounds, region):
                raise ValueError('invalid_reference_region')
            if not contains(page.cropbox, region, TOLERANCE):
                raise ValueError('reference_outside_visible_page')
            actual_region = absolute(block.get('table_source_box'), bounds)
            if any(abs(a-b) > TOLERANCE for a,b in zip(actual_region, region)):
                raise ValueError('table_region_mismatch')
            boxes = list(expected.items())
            for slot, box in boxes:
                if not valid_box(box) or not contains(region, box, TOLERANCE):
                    raise ValueError('invalid_reference_cell')
                location = supplied[slot]
                if (not isinstance(location, dict) or type(location.get('page')) is not int
                        or location['page'] != page_number):
                    raise ValueError('cell_page_mismatch')
                actual = absolute(location.get('box'), bounds)
                if any(abs(a-b) > TOLERANCE for a,b in zip(actual, box)):
                    fail('cell_geometry_binding_mismatch', slot)
            for i, (_, a) in enumerate(boxes):
                for _, b in boxes[i + 1:]:
                    if min(a[2], b[2]) - max(a[0], b[0]) > TOLERANCE and min(a[3], b[3]) - max(a[1], b[1]) > TOLERANCE:
                        raise ValueError('overlapping_reference_cells')
            # Every visible glyph intersecting the source region must belong
            # wholly to exactly one cell. Crossing a boundary is not guessed.
            assigned = {slot: [] for slot in expected}
            for char in page.chars:
                cb = [char['x0'], char['top'], char['x1'], char['bottom']]
                intersects = min(cb[2], region[2]) > max(cb[0], region[0]) and min(cb[3], region[3]) > max(cb[1], region[1])
                if not intersects:
                    continue
                owners = [slot for slot, box in boxes if center_inside(char, box)]
                if char['text'].strip() and (len(owners) != 1 or not contains(expected[owners[0]], cb, TOLERANCE)):
                    fail('source_glyph_coverage_mismatch')
                    continue
                if len(owners) == 1:
                    assigned[owners[0]].append(char)
            for slot, chars in assigned.items():
                section, row, col = slot.split(':')
                text = block[f'{section}_en'][int(row)][int(col)]
                try:
                    source = sequence(chars)
                except ValueError as exc:
                    fail(str(exc), slot)
                    continue
                cells[slot] = {'source': source, 'extracted': text}
                if canonical(source) != canonical(text):
                    fail('ordered_text_mismatch', slot)
                if NUMBERS.findall(source.translate(LIGATURES)) != NUMBERS.findall(text.translate(LIGATURES)):
                    fail('numeric_sequence_mismatch', slot)
    except (ValueError, TypeError, KeyError, IndexError) as exc:
        fail(str(exc))
    return {'valid': not issues, 'issues': issues, 'cells': cells}
