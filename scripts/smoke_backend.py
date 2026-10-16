"""Exercise PDF import and HTTP image resizing in the actual frozen artifact."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path


def probe_pdf() -> bytes:
    # A real text page, generated without importing the dependencies that the
    # artifact is supposed to contain. This catches missing pdfium / Pillow.
    content = b"BT /F1 18 Tf 72 700 Td (PaperRead packaging smoke test.) Tj ET"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"\nendstream",
    ]
    data = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for i, obj in enumerate(objects, 1):
        offsets.append(len(data))
        data.extend(f"{i} 0 obj\n".encode() + obj + b"\nendobj\n")
    xref = len(data)
    data.extend(b"xref\n0 6\n0000000000 65535 f \n")
    for offset in offsets[1:]:
        data.extend(f"{offset:010} 00000 n \n".encode())
    data.extend(f"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return bytes(data)


def main():
    root = Path(__file__).resolve().parents[1]
    exe = Path(sys.argv[1]) if len(sys.argv) > 1 else root / "build" / "backend" / ("easyread-backend.exe" if os.name == "nt" else "easyread-backend")
    with tempfile.TemporaryDirectory(prefix="easyread-frozen-smoke-") as tmp:
        home = Path(tmp)
        pdf = home / "probe.pdf"
        pdf.write_bytes(probe_pdf())
        env = dict(os.environ, EASYREAD_HOME=str(home), EASYREAD_LIBRARY=str(home / "library"), PYTHONUTF8="1")
        (home / "config.json").write_text(json.dumps({"engine": "none"}), encoding="utf-8")
        imported = subprocess.run([str(exe), "import", str(pdf), "--no-translate"], env=env, capture_output=True, text=True, timeout=120)
        if imported.returncode:
            raise RuntimeError(imported.stderr or imported.stdout)
        ws = next((home / "library").iterdir())
        paper = json.loads((ws / "paper.json").read_text(encoding="utf-8"))
        assert len(paper["meta"]["pages"]) == 1, paper
        text = (ws / "extract" / "page-001.txt").read_text(encoding="utf-8")
        assert "PaperRead packaging smoke test" in text, text
        chars = json.loads((ws / "extract" / "page-001.chars.json").read_text(encoding="utf-8"))
        assert chars, "PDFium did not extract coordinates"
        output = home / "serve.log"
        with output.open("w", encoding="utf-8") as log:
            proc = subprocess.Popen([str(exe), "serve", "--port", "0"], env=env, stdout=log, stderr=log)
            try:
                import re
                url = None
                for _ in range(100):
                    if proc.poll() is not None:
                        raise RuntimeError(output.read_text(encoding="utf-8"))
                    match = re.search(r"PaperRead 已啟動：(http://127\.0\.0\.1:\d+)", output.read_text(encoding="utf-8"))
                    if match:
                        url = match[1]
                        break
                    time.sleep(0.1)
                assert url, "frozen service failed to start"
                with urllib.request.urlopen(url, timeout=10) as response:
                    assert "文獻小幫手".encode("utf-8") in response.read()
                rel = paper["meta"]["pages"][0]["img"]
                for width in (1000, 1200, 1400, 1600):
                    with urllib.request.urlopen(f"{url}/p/{ws.name}/{rel}?w={width}", timeout=15) as response:
                        assert response.status == 200
                        data = response.read()
                        assert data[:4] == b"RIFF" and data[8:12] == b"WEBP", data[:80]
                    if width < 1468:  # the 612 pt source was rendered at 2.4x
                        assert (ws / "pages" / f"w{width}" / "page-001.webp").is_file(), "resizing did not run"
            finally:
                if os.name == "nt":  # onefile 在 Windows 上是两层进程，只杀外层的话里层还占着 easyread.log，临时目录删不掉
                    subprocess.run(["taskkill", "/pid", str(proc.pid), "/t", "/f"], capture_output=True)
                proc.terminate()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
        print("PASS: frozen PDF render, text, character coordinates, Web UI, original images at 1000/1200/1400/1600px")


if __name__ == "__main__":
    main()
