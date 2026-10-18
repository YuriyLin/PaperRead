"""Build the Python service used by the packaged Electron application."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "build" / "backend"
WORK = ROOT / "build" / "pyinstaller"
REQUIRED = ("easyread", "pypdfium2", "pypdfium2_raw", "pdfplumber", "PIL", "pypdf", "truststore", "certifi",
            "opencc", "fastembed", "onnxruntime", "numpy", "tokenizers")


def python_with_pyinstaller() -> list[str]:
    candidates: list[str] = []
    configured = os.environ.get("PYTHON")
    if configured:
        candidates.append(configured)
    venv = ROOT / (".venv\\Scripts\\python.exe" if os.name == "nt" else ".venv/bin/python")
    if venv.exists():
        candidates.append(str(venv))
    candidates.append(sys.executable)
    for candidate in candidates:
        probe = subprocess.run([candidate, "-c", "import PyInstaller"], cwd=ROOT, capture_output=True)
        if probe.returncode == 0:
            return [candidate]
    raise SystemExit("未找到 PyInstaller。请运行：python -m pip install pyinstaller")


def check_dependencies(python: list[str]) -> None:
    for module in REQUIRED:
        probe = subprocess.run(python + ["-c", f"import {module}"], cwd=ROOT, capture_output=True)
        if probe.returncode:
            raise SystemExit(f"无法加载后端依赖 {module}。请使用打包的 Python 安装：python -m pip install pyinstaller .")


def openssl_binary_args(python: list[str]) -> list[str]:
    """Collect Conda's SSL dependencies into the onefile extraction root."""
    if os.name != "nt":
        return []
    # Query the interpreter used for packaging, not the one running this script.
    # Read _ssl's PE imports so other OpenSSL versions/architectures work too.
    probe = subprocess.run(python + ["-c", """
import importlib.util
import json
import sys
from pathlib import Path
from PyInstaller.depend.bindepend import get_imports

directory = Path(sys.base_prefix) / "Library" / "bin"
binaries = []
if directory.is_dir():
    import sysconfig

    extension_dir = Path(sysconfig.get_config_var("DESTSHARED") or
                         Path(sys.base_prefix) / "DLLs")
    extensions = sorted(extension_dir.glob("*.pyd"))

    # Collect only non-system dependencies located in Conda Library/bin.
    excluded = ("api-ms-win-", "ext-ms-win-", "vcruntime", "msvcp")
    for extension in extensions:
        for name, resolved in get_imports(
            str(extension), search_paths=[str(directory)]
        ):
            if name.lower().startswith(excluded):
                continue
            source = directory / name
            if source.is_file():
                binaries.append(str(source))

print(json.dumps(sorted(set(binaries))))
"""], cwd=ROOT, capture_output=True, text=True, check=True)
    # PyInstaller's Windows bootloader adds sys._MEIPASS to DLL search paths.
    # Keeping these beside _ssl.pyd needs no application/runtime hook or PATH edit.
    return [arg for source in json.loads(probe.stdout)
            for arg in ("--add-binary", f"{source}{os.pathsep}.")]


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")  # Windows 控制台默认不是 UTF-8，下面的中文提示会让脚本崩掉
    python = python_with_pyinstaller()
    check_dependencies(python)  # 验证通过后再清理旧产物
    binary_args = openssl_binary_args(python)
    OUT.mkdir(parents=True, exist_ok=True)
    WORK.mkdir(parents=True, exist_ok=True)
    for old in OUT.iterdir():
        if old.is_file() or old.is_symlink():
            old.unlink()
        elif old.is_dir():
            shutil.rmtree(old)
    cmd = python + ["-m", "PyInstaller", "--noconfirm", "--clean", "--onefile",
                    "--name", "easyread-backend", "--distpath", str(OUT),
                    "--workpath", str(WORK), "--specpath", str(WORK),
                    *[arg for module in REQUIRED for arg in ("--collect-all", module)],
                    *binary_args,
                    str(ROOT / "scripts" / "backend_entry.py")]
    subprocess.run(cmd, cwd=ROOT, check=True)
    print(f"后端已生成：{OUT / ('easyread-backend.exe' if os.name == 'nt' else 'easyread-backend')}")


if __name__ == "__main__":
    main()
