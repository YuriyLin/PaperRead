# Real PDF regression fixture

Source: David Webb, Joshua Kneifel and Cheyney O'Fallon (2020), *Developing Cost
Functions for Estimating Solar Photovoltaic System Installed and Life Cycle Costs
Using Historical Quote Data*, NIST Technical Note 2113.
[Original PDF](https://nvlpubs.nist.gov/nistpubs/TechnicalNotes/NIST.TN.2113.pdf).

Republished courtesy of the National Institute of Standards and Technology.
[NIST Technical Series reuse statement](https://www.nist.gov/open/copyright-fair-use-and-licensing-statements-srd-data-software-and-technical-series-publications).

The fixture contains unmodified vector pages 17–19 (printed pages 11–13), extracted
using pypdf. It contains actual regression tables, merged headers and adjacent
prose. All three deliberately assert safe fallback; these are not synthetic
tables or claims of successful reconstruction. No translated data were invented.
The manifest pins the original and excerpt SHA-256, page mapping, source values,
table numbers and expected fallback reasons. Tests need no network or model.

To reproduce after downloading the original into a temporary directory:

```python
from pypdf import PdfReader, PdfWriter
r = PdfReader("NIST.TN.2113.pdf")
w = PdfWriter()
for i in (16, 17, 18):
    w.add_page(r.pages[i])
w.add_metadata({
    "/Title": "NIST TN 2113, source PDF pages 17-19 (regression test excerpt)",
    "/Subject": "Republished courtesy of the National Institute of Standards and Technology",
})
w.write("nist-tn-2113-pages-17-19.pdf")
```

Rendering and extraction are verified separately. A change in pypdf version may
change the excerpt bytes; do not update the pinned hash without inspecting the
rendered pages and checking all source values and page mappings again.
