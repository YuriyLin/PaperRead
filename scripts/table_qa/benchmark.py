"""Pinned, source-grouped benchmark. Default execution excludes sealed holdout.

Run: python -m scripts.table_qa.benchmark --output tmp/table-qa-regression.json
This reports known defects; --fail-on-unsafe exits 2 if unsafe accepts remain.
It never regenerates PDF inputs or ground truth, downloads, or writes app data.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import socket
from types import SimpleNamespace
from unittest.mock import patch

import pdfplumber

from easyread import table_extract as te, table_policy
from .provenance import contains, reference_for_table, verify_block, valid_box

FIXTURES = Path(__file__).resolve().parents[2] / 'tests' / 'fixtures' / 'tables' / 'benchmark-v1'


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_manifest(root=FIXTURES):
    """Validate assets and annotation schema before running any extractor."""
    root = Path(root).resolve()
    manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('schema') != 1:
        raise ValueError('unsupported_manifest_schema')
    sources, groups, publishers, digests, ids = {}, {}, {}, {}, set()
    for source in manifest['sources']:
        if source['id'] in sources:
            raise ValueError('duplicate_source_id')
        if source['split'] not in ('regression', 'holdout'):
            raise ValueError('invalid_split')
        for field, seen in [('source_document_group', groups), ('publisher_group', publishers)]:
            group = source[field]
            if group in seen and seen[group] != source['split']:
                raise ValueError('source_group_split_leakage')
            seen[group] = source['split']
        path = (root / source['path']).resolve()
        if not path.is_relative_to(root.parent):
            raise ValueError('fixture_outside_tables_directory')
        if sha256(path) != source['sha256']:
            raise ValueError('fixture_hash_mismatch:' + source['id'])
        digest = source['sha256']
        if digest in digests and digests[digest] != source['split']:
            raise ValueError('duplicate_pdf_split_leakage')
        digests[digest] = source['split']
        sources[source['id']] = {**source, 'resolved_path': path}
    cases = []
    for case in manifest['cases']:
        if case['id'] in ids:
            raise ValueError('duplicate_case_id')
        ids.add(case['id'])
        if case['source'] not in sources:
            raise ValueError('unknown_source')
        path = (root / case['truth']).resolve()
        if not path.is_relative_to(root) or sha256(path) != case['truth_sha256']:
            raise ValueError('truth_hash_mismatch:' + case['id'])
        truth = json.loads(path.read_text(encoding='utf-8'))
        if truth['table_exists'] is not None and type(truth['table_exists']) is not bool:
            raise ValueError('invalid_existence_label')
        if truth['table_exists'] is False and truth['tables']:
            raise ValueError('negative_contains_table')
        for table in truth['tables']:
            if (type(table['page']) is not int or table['page'] not in truth['pages']
                    or not valid_box(table['box']) or not valid_box(table['page_bbox'])
                    or not contains(table['page_bbox'], table['box'])):
                raise ValueError('invalid_table_region')
            if (any(type(table[k]) is not int or table[k] < 1 for k in ('row_count','column_count'))
                    or type(table['header_row_count']) is not int
                    or not 0 <= table['header_row_count'] <= table['row_count']):
                raise ValueError('invalid_truth_dimensions')
            covered = set()
            for cell in table['cells']:
                if (not isinstance(cell['text'], str) or not valid_box(cell['box'])
                        or not contains(table['box'], cell['box'], 0.001)):
                    raise ValueError('invalid_cell_truth')
                r, c, rs, cs = (cell[k] for k in ('row', 'col', 'rowspan', 'colspan'))
                if (any(type(n) is not int for n in (r, c, rs, cs)) or min(r, c) < 0
                        or min(rs, cs) < 1 or r + rs > table['row_count'] or c + cs > table['column_count']):
                    raise ValueError('invalid_cell_span')
                for rr in range(r, r + rs):
                    for cc in range(c, c + cs):
                        if (rr, cc) in covered:
                            raise ValueError('overlapping_truth_slots')
                        covered.add((rr, cc))
            if len(covered) != table['row_count'] * table['column_count']:
                raise ValueError('incomplete_cell_ground_truth')
        cases.append({**case, 'ground_truth': truth})
    baseline = manifest['observation_baseline']
    path = (root / baseline['path']).resolve()
    if not path.is_relative_to(root) or sha256(path) != baseline['sha256']:
        raise ValueError('observation_baseline_hash_mismatch')
    return manifest, sources, cases


def expected_matrices(table):
    if any(c['rowspan'] != 1 or c['colspan'] != 1 for c in table['cells']):
        return None
    matrix = [[''] * table['column_count'] for _ in range(table['row_count'])]
    for cell in table['cells']:
        matrix[cell['row']][cell['col']] = cell['text']
    h = table['header_row_count']
    return matrix[:h], matrix[h:]


def block_from_truth(table):
    """QA helper only: construct a candidate from independent fixed annotation."""
    matrices = expected_matrices(table)
    if matrices is None:
        raise ValueError('spanned_truth_is_not_a_flat_block')
    from easyread import tables
    dummy_source = {'sha256': ''}
    boxes = reference_for_table(dummy_source, table)['cells']
    bounds = table['page_bbox']

    def normalized(box):
        return [round((n - bounds[i % 2]) / (bounds[i % 2 + 2] - bounds[i % 2]), 6) for i, n in enumerate(box)]

    block = {'page': table['page'], 'caption_en': table.get('caption') or '',
             'head_en': matrices[0], 'rows_en': matrices[1], 'footnotes_en': [],
             'table_source_box': normalized(table['box']),
             'table_cell_boxes': {k: {'page': table['page'], 'box': normalized(v)} for k, v in boxes.items()}}
    block['table_geometry_source'] = tables.source_token(block)
    return block


def assess_case(case, source):
    truth, path = case['ground_truth'], source['resolved_path']
    with pdfplumber.open(path) as pdf:
        pages = [te.extract_page(pdf.pages[p - 1], p) for p in truth['pages']]
    first = truth['tables'][0] if truth['tables'] else None
    number = (first or {}).get('number') or '1'
    caption = (first or {}).get('caption') or f'Table {number}: QA target'
    try:
        candidate = te.recognize(SimpleNamespace(source_pdf=path),
                                 {'page': truth['pages'][0], 'num': number, 'caption_en': caption})
        reason = ''
    except te.UnreliableTable as exc:
        candidate, reason = None, str(exc)
    exact = False
    if candidate and first and truth['table_exists'] is True and not truth['expected_fallback']:
        matrices = expected_matrices(first)
        exact = matrices is not None and candidate['head_en'] == matrices[0] and candidate['rows_en'] == matrices[1]
    if truth['table_exists'] is None:
        outcome = 'ambiguous_accept' if candidate else 'ambiguous_reject'
    elif truth['table_exists'] is False:
        outcome = 'false_positive' if candidate else 'correct_rejection'
    elif candidate:
        outcome = 'unsafe_structure_accept' if truth['expected_fallback'] else 'correct' if exact else 'cell_misalignment'
    elif truth['expected_fallback'] and any(p.unresolved or p.sources for p in pages):
        outcome = 'correct_fallback'
    else:
        outcome = 'false_negative'
    fidelity, region_text_fidelity = None, None
    if candidate and first and expected_matrices(first) is not None:
        reference = reference_for_table(source, first)
        fidelity = verify_block(path, candidate, reference)
        # Separately isolate text attribution from strict box equivalence.
        # This is NOT verification of the candidate's original geometry.
        from easyread import tables
        projected = block_from_truth(first)
        projected['head_en'], projected['rows_en'] = candidate['head_en'], candidate['rows_en']
        projected['footnotes_en'] = candidate.get('footnotes_en', [])
        projected['table_geometry_source'] = tables.source_token(projected)
        region_text_fidelity = verify_block(path, projected, reference)
    return {'id': case['id'], 'source_document_group': source['source_document_group'],
            'publisher_group': source['publisher_group'], 'categories': case['categories'],
            'primary_category': case['primary_category'],
            'desired_action': case['desired_action'], 'outcome': outcome,
            'accepted': candidate is not None, 'exact_cells': exact, 'reason': reason,
            'page_sources': [len(p.sources) for p in pages],
            'page_unresolved': [len(p.unresolved) for p in pages], 'page_issues': [p.issues for p in pages],
            'fidelity': fidelity, 'text_attribution_on_reviewed_regions': region_text_fidelity}


def run(root=FIXTURES, split='regression'):
    if split != 'regression':
        raise ValueError('holdout_sealed: release a new, reviewed benchmark protocol before evaluating')
    manifest, sources, cases = load_manifest(root)
    selected = [c for c in cases if sources[c['source']]['split'] == split]
    with patch.object(socket.socket, 'connect', side_effect=AssertionError('offline benchmark')):
        results = [assess_case(c, sources[c['source']]) for c in selected]
    by_category, by_primary = defaultdict(Counter), defaultdict(Counter)
    for result in results:
        by_primary[result['primary_category']][result['outcome']] += 1
        for category in result['categories']:
            by_category[category][result['outcome']] += 1
    baseline = json.loads((Path(root) / manifest['observation_baseline']['path']).read_text(encoding='utf-8'))['cases']
    changes = []
    if set(baseline) != {r['id'] for r in results}:
        raise ValueError('observation_baseline_case_set_mismatch')
    for result in results:
        for key, value in baseline[result['id']].items():
            if result[key] != value:
                changes.append({'id':result['id'], 'field':key, 'baseline':value, 'actual':result[key]})
    return {'benchmark_id': manifest['id'], 'manifest_sha256': sha256(Path(root) / 'manifest.json'),
            'pdfplumber_version': pdfplumber.__version__, 'split': split,
            'table_extraction_enabled': table_policy.enabled(),
            'case_count': len(results), 'document_group_count': len({r['source_document_group'] for r in results}),
            'public_document_group_count': len({r['source_document_group'] for r in results
                                               if r['publisher_group'] != 'synthetic-independent-writer-v1'}),
            'holdout_evaluated': False, 'summary': dict(Counter(r['outcome'] for r in results)),
            'observation_changes': changes,
            'by_primary_category': {k:dict(v) for k,v in by_primary.items()},
            'by_category': {k: dict(v) for k, v in by_category.items()}, 'cases': results,
            'note': 'Challenge-set observations, not population accuracy; categories overlap. Unsafe structure accepts are separate from non-table FP.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--fail-on-unsafe', action='store_true')
    parser.add_argument('--check-baseline', action='store_true', help='exit 1 on observation drift, including improvements needing review')
    args = parser.parse_args()
    # Prevent accidental overwriting of frozen corpus, production or external files.
    repo = Path(__file__).resolve().parents[2]
    destination = args.output.resolve()
    if not destination.is_relative_to(repo / 'tmp'):
        parser.error('output must be inside the repository tmp directory')
    result = run()
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({k: result[k] for k in ('case_count', 'document_group_count', 'summary', 'holdout_evaluated')}, ensure_ascii=False))
    unsafe = any(result['summary'].get(k, 0) for k in ('false_positive', 'unsafe_structure_accept', 'cell_misalignment'))
    if args.check_baseline and result['observation_changes']:
        return 1
    return 2 if args.fail_on_unsafe and unsafe else 0


if __name__ == '__main__':
    raise SystemExit(main())
