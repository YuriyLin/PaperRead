# Frozen table QA corpus v1

This corpus reuses the 22 PDFs and observations from
`scripts/evaluate_table_generalization.py`; it does not introduce another PDF
generator. The benchmark runner reads these fixed bytes and never regenerates
inputs, annotations, hashes, or expected observations.

## Splits and units

| Split | Assets/cases | Independent grouping |
|---|---|---|
| regression | 22 synthetic PDFs, 22 cases | One generator family, **not 22 independent sources** |
| regression | Existing NIST excerpt, 3 cases | One source document/publisher |
| regression | FBI/NICS November 2015 PDF, 1 case | One source document/publisher |
| sealed holdout | W3C PDF6 example, 1 case | Different document and publisher; no PaperRead extraction evaluation performed |

There are 26 evaluated regression cases, two real public document groups and
one synthetic family. NIST's three pages stay together. All variants of the
synthetic writer stay together. Publisher/document groups cannot cross splits.
The previously inspected NIST and FBI files cannot be relabeled as holdout.

The W3C PDF has been read to annotate its five rows and five columns, but neither
`extract_page`, `recognize`, nor the fidelity experiment has been run against it.
Annotation access is distinct from evaluating an extractor. The loader validates
its SHA-256 without opening it as a PDF. The runner rejects `split='holdout'`;
there is deliberately no automatic holdout CLI switch. Release requires a new,
reviewed evaluation protocol with frozen algorithms and validation parameters,
one recorded final evaluation, and replacement holdout for later development.
One sealed document is an initial reserve, not an adequate generalization study.

## Ground truth and observations

`manifest.json` pins every input and `truth/*.json` by SHA-256, assigns source
groups, primary category plus overlapping tags, desired action, and references
the fixed observation snapshot. Case truth contains:

- `table_exists`: true/false; null for explicitly ambiguous interpretation.
- PDF page numbers, original page mapping for the NIST excerpt, logical table
  count and all page-local table segments.
- Absolute PDF coordinates `[x0, top, x1, bottom]`, page bounds, table region,
  dimensions, header count, every cell's text/box, rowspan and colspan.
- Paragraph text/regions for non-table cases, expected fallback policy and reason.
- Annotation method and known ambiguity. Cross-page segments belong to one logical
  table. Duplicate-identity examples contain two separate tables.

Synthetic truth comes from declared writer inputs/coordinates and visual review,
not from PaperRead outputs. Real NIST/FBI annotations use manually selected rule
grids with machine-assisted raw PDF text transcription (`crop.extract_text`,
not `find_tables`/`table.extract`). They are fixed and visually reviewed, but
have **not** had a second independent annotator review every cell. Subscripts
retain the source transcription's line text. They are a usable first annotation
pass, not a claim of error-free, double-reviewed gold data. A high-resolution
boundary audit found almost-overpainted Coefficient/Err. glyphs in NIST Table 3;
visible text is distinguished from `source_glyph_text`, with explicit source-layer
notes. A regression audit ensures each raw source glyph is counted once rather
than duplicated across crop boundaries. This does not prove visible semantics
from raw glyphs alone. W3C's 25 cells were
manually transcribed and visually reviewed. Metadata records these distinctions.

`expected_fallback` is a desired support/identity policy, not a copy of current
behavior. NIST Table 2 is a desired exact-accept case despite today's fallback;
FBI should be safely refused as a flat matrix, but a silent absence of a candidate
is recorded as a detection false negative, not a successful fallback.

`observations-v1.json` records current behavior **including known defects**.
`baseline-observations.json` preserves the previous assessment's synthetic summary
and versions. Neither file is ground truth. Any behavior change requires review;
do not automatically refresh snapshots to make tests pass. An improvement also
needs an explicit reviewed snapshot/version update. No holdout feedback may be
used to tune thresholds in this version.

## Reproduction

From the repository root, with the existing local Python environment:

```powershell
.venv/Scripts/python.exe -m unittest tests.test_table_provenance tests.test_table_benchmark
.venv/Scripts/python.exe -m scripts.table_qa.benchmark --output tmp/table-qa-regression.json --check-baseline
.venv/Scripts/python.exe -m scripts.table_qa.benchmark --output tmp/table-qa-safety.json --fail-on-unsafe
```

The first command tests program/corpus correctness. The second checks repeatable
observations, not recognition accuracy. The third deliberately exits **2** while
known unsafe accepts remain; its JSON is still written. Observation drift exits
**1** with `--check-baseline`. The runner blocks network connects, confines output
to the repository `tmp/` folder, does not read application configuration, and
does not access a library, Vault, model, installer or production code path that
writes application data. PDFs and truth are read-only.

Stability acceptance update: a source-word integrity guard now rejects the known
`natural_prose_captioned` false positive. The original P0 observation snapshot is
intentionally preserved, so `--check-baseline` reports drift (exit 1) for that
reviewed case. Tests allow only that case to change and require all seven exact
positives to remain exact with no new cell misalignment. The unlabeled cross-page
unsafe accept remains a release blocker (safety exit 2). See
[the acceptance report](../../../../docs/table-stability-acceptance.md). No holdout
evaluation or automatic snapshot refresh was performed.

Primary categories are mutually exclusive for counting; tags overlap. Report
ordinary-text FP separately from unsafe acceptance of a cross-page fragment.
Report cell misalignment separately from both. Report missing candidates as FN
even when a conservative support policy explains the omission. Cell fidelity
alone cannot establish that a region is a table or that later pages are complete.

## Provenance and attribution

- NIST TN 2113: existing `../nist-tn-2113-pages-17-19.pdf`; see
  [the original fixture README](../README.md) for attribution, source mapping and
  reuse statement. The file has not been rewritten.
- FBI/NICS: original public report, distributed by the
  [pdfplumber official examples](https://github.com/jsvine/pdfplumber/tree/stable/examples/pdfs),
  [download URL](https://raw.githubusercontent.com/jsvine/pdfplumber/stable/examples/pdfs/background-checks.pdf).
- W3C: [PDF6 technique and working examples](https://www.w3.org/WAI/WCAG22/Techniques/pdf/PDF6),
  [original PDF](https://www.w3.org/WAI/WCAG22/working-examples/pdf-table-headers/table-example-repaired.pdf),
  [WAI material permissions](https://www.w3.org/WAI/about/using-wai-material/).

The PDFs retain their original bytes/metadata. Source URLs, digest and split are
in the manifest. Future download of a changed file must not silently replace a
pinned version. The sibling `provenance-symbols.pdf/json` is a separate synthetic
program-correctness fixture and contributes no independent-document evidence.
