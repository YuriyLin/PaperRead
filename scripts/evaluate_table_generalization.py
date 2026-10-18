"""Offline characterization, not acceptance tests or production extraction logic.

Independent pypdf fixture writer; never imports the existing test PDF generator.
Run from the repository root. Inputs/outputs remain under tmp/table-generalization.
"""
from pathlib import Path
from types import SimpleNamespace
from collections import Counter
import hashlib
import json
import socket
from unittest.mock import patch

import pdfplumber
import pypdf
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
from PIL import Image, ImageDraw
import pypdfium2
from easyread import table_extract as te

ROOT = Path('tmp/table-generalization')
HEAD = [['Measure', 'Estimate', 'Error']]
BODY = [['Alpha', '-1.25', '0.04'], ['Beta', '12.50', '1.20'], ['Gamma', '3.00', '0.50']]


def write_pdf(path, *, ruled=True, font='Times-Roman', bold=True, right=False,
              multiline=False, concept=False, merged=False, caption='Table 1: Estimates',
              gap=15, prose=False, numeric_prose=False, footer=False, below=False,
              continuation=None, caption_bold=True, duplicate=False, natural_prose=False):
    writer = PdfWriter()
    expected_head = [['Dimension', 'Mechanism', 'Outcome']] if concept else HEAD
    expected_body = ([['Autonomy', 'Local judgment', 'Flexible service'],
                      ['Control', 'Standard rules', 'Uniform service'],
                      ['Accountability', 'Public review', 'Open decisions']] if concept else BODY)
    if multiline:
        expected_body = [['Alpha\nsubgroup', '-1.25', '0.04'], *BODY[1:]]
    if prose or numeric_prose:
        expected_head = [['Annual', 'review', 'summary']]
        expected_body = ([['In 2020', 'we saw', '12 events'], ['In 2021', 'we saw', '15 events'],
                          ['In 2022', 'we saw', '18 events']] if numeric_prose else
                         [['The report', 'describes', 'ordinary work'], ['Several staff', 'discuss', 'local concerns'],
                          ['These words', 'form', 'a paragraph']])
    for pi in range(2 if continuation is not None else 1):
        page = writer.add_blank_page(width=612, height=792)
        fonts = {}
        bold_font = {'Times-Roman': 'Times-Bold', 'Courier': 'Courier-Bold', 'Helvetica': 'Helvetica-Bold'}[font]
        for key, name in [('R', font), ('B', bold_font)]:
            fonts[NameObject('/' + key)] = writer._add_object(DictionaryObject({
                NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'),
                NameObject('/BaseFont'): NameObject('/' + name)}))
        page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject(fonts)})
        ops = []

        def text(x, y, value, face='R', size=10):
            value = value.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)')
            ops.append(f'BT /{face} {size} Tf {x} {y} Td ({value}) Tj ET')

        cap = caption if pi == 0 else ('Table 1: Estimates (continued)' if continuation else 'Further results')
        top = 680
        if cap:
            text(42, top + gap if not below else 490, cap, 'B' if caption_bold else 'R', 11)
        xs = [42, 196, 394, 566]
        heights = [30, 45 if multiline else 30, 30, 30]
        ys = [top]
        for height in heights:
            ys.append(ys[-1] - height)
        displayed_body = expected_body if pi == 0 else [['Delta', '8.75', '0.15'], ['Epsilon', '4.50', '0.25'], ['Zeta', '2.00', '0.80']]
        for ri, row in enumerate(expected_head + displayed_body):
            if natural_prose:
                lines = ['This annual report describes ordinary events.',
                         'In 2020 we saw 12 events across the entire region.',
                         'In 2021 we saw 15 events across the entire region.',
                         'In 2022 we saw 18 events across the entire region.']
                text(49, ys[ri] - 18, lines[ri])
                continue
            for ci, value in enumerate(row):
                for li, line in enumerate(value.split('\n')):
                    x = xs[ci] + 7
                    if right and ci:
                        # Courier uses exactly 6pt glyph advances at 10pt.
                        x = xs[ci + 1] - 8 - len(line) * 6
                    text(x, ys[ri] - 18 - li * 12, line, 'B' if ri == 0 and bold else 'R')
        if ruled:
            for y in ys:
                ops.append(f'{xs[0]} {y} m {xs[-1]} {y} l S')
            for ci, x in enumerate(xs):
                ops.append(f'{x} {ys[-1]} m {x} {ys[1] if merged and ci == 1 else top} l S')
        if footer:
            text(42, ys[-1] - 14, 'This paragraph discusses the findings without a note label.')
        if duplicate:
            text(42, ys[-1] - 42, 'Table 1: Another table', 'B', 11)
            for ri, row in enumerate(expected_head + expected_body):
                for ci, value in enumerate(row):
                    text(xs[ci] + 7, ys[-1] - 70 - ri * 30, value)
            for y in range(int(ys[-1] - 52), int(ys[-1] - 173), -30):
                ops.append(f'{xs[0]} {y} m {xs[-1]} {y} l S')
            for x in xs:
                ops.append(f'{x} {ys[-1]-172} m {x} {ys[-1]-52} l S')
        stream = DecodedStreamObject()
        stream.set_data('\n'.join(ops).encode('ascii'))
        page[NameObject('/Contents')] = writer._add_object(stream)
    writer.write(path)
    return expected_head, expected_body


def evaluate(name, label='table', **kw):
    path = ROOT / f'{name}.pdf'
    head, body = write_pdf(path, **kw)
    with pdfplumber.open(path) as pdf:
        page_results = [te.extract_page(p, i + 1) for i, p in enumerate(pdf.pages)]
    try:
        block = te.recognize(SimpleNamespace(source_pdf=path), {'page': 1, 'num': '1', 'caption_en': 'Table 1: Estimates'})
        accepted, error = True, ''
    except te.UnreliableTable as exc:
        block, accepted, error = None, False, str(exc)
    exact = accepted and block['head_en'] == head and block['rows_en'] == body
    unsafe = label in ('non-table', 'unsupported', 'ambiguous')
    if accepted:
        outcome = ('false_positive' if unsafe else 'correct' if exact else 'cell_misalignment')
    elif label == 'ambiguous-content':
        outcome = 'ambiguous_reject'
    elif label == 'non-table':
        outcome = 'correct_rejection'
    else:
        outcome = ('correct_fallback' if unsafe else 'false_negative')
    if label == 'ambiguous-content' and accepted:
        outcome = 'ambiguous_accept'
    return {'name': name, 'label': label, 'outcome': outcome, 'exact_cells': bool(exact),
            'accepted': accepted, 'reason': error, 'options': kw,
            'page_sources': [len(r.sources) for r in page_results],
            'page_issues': [r.issues for r in page_results],
            'page_unresolved': [len(r.unresolved) for r in page_results],
            'actual_head': block['head_en'] if accepted else None,
            'actual_rows': block['rows_en'] if accepted else None}


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    cases = [
        ('ruled_times', {}, 'table'),
        ('ruled_courier_right', {'font': 'Courier', 'right': True}, 'table'),
        ('borderless_times', {'ruled': False}, 'table'),
        ('borderless_courier_right', {'ruled': False, 'font': 'Courier', 'right': True}, 'table'),
        ('ruled_concept', {'concept': True}, 'table'),
        ('borderless_concept', {'concept': True, 'ruled': False}, 'table'),
        ('ruled_multiline', {'multiline': True}, 'table'),
        ('borderless_multiline', {'multiline': True, 'ruled': False}, 'table'),
        ('merged_header', {'merged': True}, 'unsupported'),
        ('continued_label', {'continuation': True}, 'unsupported'),
        ('continued_unlabelled', {'continuation': False}, 'unsupported'),
        ('prose_negative', {'prose': True, 'ruled': False}, 'non-table'),
        ('numeric_prose_negative', {'numeric_prose': True, 'ruled': False}, 'ambiguous-content'),
        ('caption_gap_45', {'gap': 45}, 'table'),
        ('caption_below', {'below': True}, 'table'),
        ('missing_caption', {'caption': ''}, 'table'),
        ('nonbold_header', {'bold': False}, 'table'),
        ('unmarked_body_after', {'footer': True}, 'table'),
        ('duplicate_identity', {'duplicate': True}, 'ambiguous'),
        ('caption_plain_label', {'caption': 'Table 1 Estimates', 'caption_bold': False}, 'table'),
        ('natural_prose_captioned', {'natural_prose': True, 'ruled': False}, 'non-table'),
        ('natural_prose_no_caption', {'natural_prose': True, 'ruled': False, 'caption': ''}, 'non-table'),
    ]
    # Prevent any accidental network transport during evaluation.
    with patch.object(socket.socket, 'connect', side_effect=AssertionError('offline assessment')):
        results = [evaluate(name, label, **opts) for name, opts, label in cases]
        real = []
        for path in [Path('tests/fixtures/tables/nist-tn-2113-pages-17-19.pdf'), ROOT / 'background-checks.pdf']:
            before = hashlib.sha256(path.read_bytes()).hexdigest()
            with pdfplumber.open(path) as pdf:
                for i, page in enumerate(pdf.pages):
                    result = te.extract_page(page, i + 1)
                    real.append({'file': str(path), 'page': i + 1, 'sources': len(result.sources),
                                 'issues': result.issues, 'unresolved': len(result.unresolved),
                                 'raw_ruled_candidates': len(page.find_tables()),
                                 'sha256': before})
            assert hashlib.sha256(path.read_bytes()).hexdigest() == before
    faults = []
    with pdfplumber.open(ROOT / 'ruled_times.pdf') as pdf:
        page = pdf.pages[0]
        table = page.find_tables()[0]
        baseline = table.extract(x_tolerance=2, y_tolerance=2)
        import copy
        for name in ('missing_digit', 'duplicate_digit', 'permute_number', 'swap_cells'):
            changed = copy.deepcopy(baseline)
            if name == 'missing_digit':
                changed[2][1] = '12.5'
            elif name == 'duplicate_digit':
                changed[2][1] = '12.500'
            elif name == 'permute_number':
                changed[2][1] = '21.50'
            else:
                changed[1][1], changed[2][1] = changed[2][1], changed[1][1]
            with patch.object(table, 'extract', return_value=changed):
                try:
                    te._matrix(page, table, 'lines')
                    faults.append({'fault': name, 'accepted': True})
                except te.UnreliableTable as exc:
                    faults.append({'fault': name, 'accepted': False, 'reason': str(exc)})
    report = {'versions': {'pdfplumber': pdfplumber.__version__, 'pypdf': pypdf.__version__},
              'synthetic': results, 'real': real,
              'fault_injection': faults,
              'summary': dict(Counter(r['outcome'] for r in results))}
    (ROOT / 'results.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    # Contact sheets for visual ground-truth inspection.
    for start in range(0, len(cases), 5):
        sheet = Image.new('RGB', (1224, 440 * 3), 'white')
        draw = ImageDraw.Draw(sheet)
        for k, (name, _, _) in enumerate(cases[start:start + 5]):
            doc = pypdfium2.PdfDocument(ROOT / f'{name}.pdf')
            image = doc[0].render(scale=1).to_pil().crop((20, 65, 590, 465))
            x, y = (k % 2) * 612, (k // 2) * 440
            sheet.paste(image, (x, y + 25))
            draw.text((x + 10, y + 5), name, fill='black')
        sheet.save(ROOT / f'contact-{start // 5}.png')
    for name, path in [('nist', Path('tests/fixtures/tables/nist-tn-2113-pages-17-19.pdf')),
                       ('fbi', ROOT / 'background-checks.pdf')]:
        doc = pypdfium2.PdfDocument(path)
        for i in range(len(doc)):
            doc[i].render(scale=1.2).to_pil().save(ROOT / f'{name}-{i+1}.png')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
