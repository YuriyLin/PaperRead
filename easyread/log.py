"""日志：写到数据目录下的 easyread.log（双击启动时没有控制台，出错信息全靠它）。"""
from __future__ import annotations

import logging
import re
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

log = logging.getLogger("easyread")


def setup(path: Path) -> Path:
    if log.handlers:
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%Y-%m-%d %H:%M:%S")
    fh = RotatingFileHandler(path, maxBytes=1_000_000, backupCount=3, encoding="utf-8")
    fh.setFormatter(fmt)
    log.addHandler(fh)
    if sys.stderr is not None and getattr(sys.stderr, "name", "") != "nul" and sys.stderr.isatty():
        sh = logging.StreamHandler(sys.stderr)
        sh.setFormatter(fmt)
        log.addHandler(sh)
    log.setLevel(logging.INFO)
    return path


def tail(path: Path, n: int = 80) -> str:
    try:
        return "\n".join(path.read_text(encoding="utf-8", errors="replace").splitlines()[-n:])
    except OSError:
        return ""


def format_log_english(text: str) -> str:
    """把日誌內容轉換為英文顯示，使中英文介面的日誌呈現保持一致。"""
    if not text:
        return ""
    lines = []
    for line in text.splitlines():
        m_time = re.match(r"^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\s+[A-Z]+)?\s+)(.*)$", line)
        pfx, body = (m_time.group(1), m_time.group(2)) if m_time else ("", line)

        b = body
        # 1. PaperRead startup
        b = re.sub(r"^PaperRead\s+([0-9.]+)\s+已[啟启]動[：:]\s*(https?://[^\s]+)\s+文[獻献][庫库][：:]\s*(.*)$", r"PaperRead \1 started: \2  Library: \3", b)  # i18n-ok
        # 2. Started line
        m_started = re.match(r"^(?:只[讀读]原文[（(]不[翻飜]?[譯译][）)]\s*)?[開开]始[：:]\s*(\d+)\s*[頁页][，,]\s*(\d+)\s*批[，,]\s*引擎\s*([^，,]+)[，,]\s*[併并]發\s*(\d+)$", b)  # i18n-ok
        if m_started:
            pfx_ro = "[Read-only] " if ("只讀原文" in body or "只读原文" in body) else ""  # i18n-ok
            b = f"{pfx_ro}Started: {m_started.group(1)} pages, {m_started.group(2)} batches, engine {m_started.group(3)}, concurrency {m_started.group(4)}"
        # 3. Concurrent segments
        m_seg = re.match(r"^分\s*(\d+)\s*段同[時时][譯译][：:](.*)$", b)  # i18n-ok
        if m_seg:
            sub = m_seg.group(2)
            sub = re.sub(r"第\s*(\d+)[–-](\d+)\s*[頁页]", r"Pages \1–\2", sub)  # i18n-ok
            sub = re.sub(r"第\s*(\d+)\s*[頁页]", r"Page \1", sub)  # i18n-ok
            sub = sub.replace("、", ", ")  # i18n-ok
            b = f"Concurrent translation in {m_seg.group(1)} segments: {sub}"
        # 4. Page completed
        b = re.sub(r"^第\s*(\d+)[–-](\d+)\s*[頁页]\s*完成$", r"Pages \1–\2 completed", b)  # i18n-ok
        b = re.sub(r"^第\s*(\d+)\s*[頁页]\s*完成$", r"Page \1 completed", b)  # i18n-ok
        # 5. Page failed attempt
        b = re.sub(r"^第\s*(\d+)[–-](\d+)\s*[頁页]\s*第\s*(\d+)\s*次[失矢]敗[：:]\s*(.*)$", r"Pages \1–\2 failed (attempt \3): \4", b)  # i18n-ok
        b = re.sub(r"^第\s*(\d+)\s*[頁页]\s*第\s*(\d+)\s*次[失矢]敗[：:]\s*(.*)$", r"Page \1 failed (attempt \2): \3", b)  # i18n-ok
        b = re.sub(r"^第\s*(\d+)[–-](\d+)\s*[頁页]\s*第\s*(\d+)\s*次失败[：:]\s*(.*)$", r"Pages \1–\2 failed (attempt \3): \4", b)  # i18n-ok
        b = re.sub(r"^第\s*(\d+)\s*[頁页]\s*第\s*(\d+)\s*次失败[：:]\s*(.*)$", r"Page \1 failed (attempt \2): \3", b)  # i18n-ok
        # 6. Page missed entirely
        b = re.sub(r"^第\s*(\d+)[–-](\d+)\s*[頁页]\s*模型整[頁页]漏[譯译]，[單单][獨独]再[譯译]一次$", r"Pages \1–\2 missed entirely by model, retrying individually", b)  # i18n-ok
        b = re.sub(r"^第\s*(\d+)\s*[頁页]\s*模型整[頁页]漏[譯译]，[單单][獨独]再[譯译]一次$", r"Page \1 missed entirely by model, retrying individually", b)  # i18n-ok
        # 7. Page fix failed
        b = re.sub(r"^第\s*(\d+)[–-](\d+)\s*[頁页]修正[失矢]敗，保留原[譯译][：:]\s*(.*)$", r"Pages \1–\2 fix failed, original translation kept: \3", b)  # i18n-ok
        b = re.sub(r"^第\s*(\d+)\s*[頁页]修正[失矢]敗，保留原[譯译][：:]\s*(.*)$", r"Page \1 fix failed, original translation kept: \2", b)  # i18n-ok
        b = re.sub(r"^第\s*(\d+)[–-](\d+)\s*[頁页]修正失败，保留原[译譯][：:]\s*(.*)$", r"Pages \1–\2 fix failed, original translation kept: \3", b)  # i18n-ok
        b = re.sub(r"^第\s*(\d+)\s*[頁页]修正失败，保留原[译譯][：:]\s*(.*)$", r"Page \1 fix failed, original translation kept: \2", b)  # i18n-ok
        # 8. Terminology unify on merge
        b = re.sub(r"^第\s*(\d+)\s*[頁页]起[術术][語语][統统]一[：:](.+?)\s*的[“\"「](.+?)[”\"」]改成已有的[“\"「](.+?)[”\"」]$", r'Terminology unified starting from page \1: "\3" -> "\4" for \2', b)  # i18n-ok
        # 9. Terminology consistency item
        m_tc = re.match(r"^[術术][語语]一致性[：:]\s*第\s*(\d+)\s*[頁页]\s*(.*)$", b)  # i18n-ok
        if m_tc:
            b = f"Terminology consistency: Page {m_tc.group(1)} {m_tc.group(2)}"
        # 10. Terminology consistency check summary
        b = re.sub(r"^[術术][語语]一致性[檢检]查[：:]\s*[查檢检]了\s*(\d+)\s*段[，,]\s*改了\s*(\d+)\s*段$", r"Terminology consistency check: checked \1 sections, updated \2 sections", b)  # i18n-ok
        b = re.sub(r"^[術术][語语]一致性[檢检]查[：:]\s*沒有[發发]現不一致$", r"Terminology consistency check: no inconsistencies found", b)  # i18n-ok
        b = re.sub(r"^[術术][語语]一致性[檢检]查[：:]\s*没有发现不一致$", r"Terminology consistency check: no inconsistencies found", b)  # i18n-ok
        b = re.sub(r"^[術术][語语]一致性[檢检]查已取消[，,]\s*[譯译]文保留$", r"Terminology consistency check cancelled, translation kept", b)  # i18n-ok
        b = re.sub(r"^[術术][語语]一致性[檢检]查[沒没]做成[：:]\s*(.*)$", r"Terminology consistency check failed: \1", b)  # i18n-ok
        b = re.sub(r"^[術术][語语]一致性[檢检]查[失矢]敗[：:]\s*(.*)$", r"Terminology consistency check failed: \1", b)  # i18n-ok
        b = re.sub(r"^[術术][語语]一致性[檢检]查失败[：:]\s*(.*)$", r"Terminology consistency check failed: \1", b)  # i18n-ok
        # 11. Finished lines
        b = re.sub(r"^[處处]理完成[，,]\s*但有\s*(\d+)\s*[頁页][失矢]敗[：:]\s*(.*)$", r"Finished, but \1 pages failed: \2", b)  # i18n-ok
        b = re.sub(r"^[處处]理完成[，,]\s*但有\s*(\d+)\s*[頁页]失败[：:]\s*(.*)$", r"Finished, but \1 pages failed: \2", b)  # i18n-ok
        b = re.sub(r"^[結结]束[，,]\s*全部成功$", r"Finished, all successful", b)  # i18n-ok
        b = re.sub(r"^[結结]束[，,]\s*(\d+)\s*[頁页][失矢]敗[：:]\s*(.*)$", r"Finished, \1 pages failed: \2", b)  # i18n-ok
        b = re.sub(r"^[結结]束[，,]\s*(\d+)\s*[頁页]失败[：:]\s*(.*)$", r"Finished, \1 pages failed: \2", b)  # i18n-ok
        # 12. Quota / stopped lines
        b = re.sub(r"^[額额]度用完或[連连]不上[，,]\s*停止[翻飜]?[譯译]剩下的[頁页]$", r"Quota exceeded or connection lost, stopping remaining pages", b)  # i18n-ok
        b = re.sub(r"^出[錯错]停止[：:]\s*(.*)$", r"Stopped due to error: \1", b)  # i18n-ok
        b = re.sub(r"^核[對对]提示[沒没]存上[：:]\s*(.*)$", r"Verification prompt failed to save: \1", b)  # i18n-ok
        # 13. System logs
        b = re.sub(r"^改[為为]常[駐驻][，,]\s*不再在[頁页]面[關关]掉[後后]自[動动]退出$", r"Daemon mode enabled; staying open after page close", b)  # i18n-ok
        b = re.sub(r"^[頁页]面都[關关]了[，,]\s*[後后]台[沒没]有任[務务]在跑[，,]\s*退出服[務务]$", r"All pages closed with no active background jobs, shutting down server", b)  # i18n-ok
        b = re.sub(r"^[檢检]查新版本[沒没]成功[：:]\s*(.*)$", r"Check for update failed: \1", b)  # i18n-ok
        b = re.sub(r"^證[書书]校[驗验][失矢]敗\s*(.*?)[：:]\s*(.*)$", r"Certificate verification failed \1: \2", b)  # i18n-ok
        b = re.sub(r"^证书校验失败\s*(.*?)[：:]\s*(.*)$", r"Certificate verification failed \1: \2", b)  # i18n-ok
        b = re.sub(r"^[連连]通性[檢检]查[失矢]敗\s*(.*?)[：:]\s*(.*)$", r"Connectivity check failed \1: \2", b)  # i18n-ok
        b = re.sub(r"^[翻飜]?[譯译][失矢]敗\s*(.*)$", r"Translation failed \1", b)  # i18n-ok
        b = re.sub(r"^翻译失败\s*(.*)$", r"Translation failed \1", b)  # i18n-ok
        b = re.sub(r"^導[入入][失矢]敗\s*(.*)$", r"Import failed \1", b)  # i18n-ok
        b = re.sub(r"^导入失败\s*(.*)$", r"Import failed \1", b)  # i18n-ok
        # Common inner error message
        b = b.replace("必須是二維陣列", "must be a 2D array").replace("必须是二维数组", "must be a 2D array")  # i18n-ok
        b = re.sub(r"^[（(]完整[日誌日志]+[：:]\s*(.*?)[）)]$", r"(full log: \1)", b)  # i18n-ok

        lines.append(pfx + b)
    return "\n".join(lines)
