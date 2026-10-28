"""Portable Markdown for one question and answer; bundle local images if needed."""
from __future__ import annotations

import base64
import io
import re
import zipfile
from pathlib import PurePosixPath
from urllib.parse import unquote

from .chat_store import get
from .i18n import tr


def export(ws, body):
    thread = get(ws, str(body.get("thread", "")))
    messages = (thread or {}).get("messages", [])
    index = next((i for i, m in enumerate(messages) if m.get("id") == body.get("id") and m.get("role") == "assistant"), None)
    if index is None:
        raise ValueError(tr("未找到回答"))
    answer = messages[index]
    question = next((m for m in reversed(messages[:index]) if m.get("role") == "user"), {})
    meta = (ws.load("paper") or {}).get("meta", {})
    title = meta.get("title_zh") or meta.get("title_en") or "Paper"
    subject = " ".join(question.get("content", "").split())[:60] or (thread.get("title") if thread else "Note") or "Note"
    filename = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "-", (meta.get("short_zh") or title)[:45] + "-" + subject).strip(" .") or "note"
    assets = {}

    def local_image(value):
        rel = unquote(value).removeprefix(f"/p/{ws.id}/")
        path = PurePosixPath(rel)
        if (path.is_absolute() or ".." in path.parts or "\\" in rel or not path.parts
                or path.parts[0] not in ("chat-media", "figures", "pages")
                or path.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp", ".gif")):
            return value
        source = (ws.root / rel).resolve()
        if not source.is_relative_to(ws.root.resolve()) or not source.is_file():
            return value
        dest = "assets/" + path.name
        if dest in assets and assets[dest] != source:
            dest = "assets/" + path.parts[0] + "-" + path.name
        assets[dest] = source
        return dest

    def images(text):
        # Only rewrite image destinations; keep equations, code and other Markdown intact.
        return re.sub(r'(!\[[^\]]*\]\()([^\s)]+)(\))', lambda m: m[1] + local_image(m[2]) + m[3], text or "")

    lines = ["# " + subject, "", tr("來源論文：") + " ".join(title.split())]
    source = meta.get("url") or meta.get("source_url") or ""
    if not source and meta.get("doi"):
        source = "https://doi.org/" + meta["doi"].removeprefix("https://doi.org/")
    if str(source).startswith(("https://", "http://")):
        lines.append(tr("論文連結：") + source)
    if answer.get("at"):
        lines.append(tr("記錄時間：") + answer["at"])
    lines.extend(["", "## " + tr("我的問題"), "", images(question.get("content", ""))])
    for i, value in enumerate(question.get("images") or []):
        img_label = tr("提问附图 {n}", n=i+1)
        lines.extend(["", f"![{img_label}]({local_image(value)})"])
    lines.extend(["", "## " + tr("AI 回答"), "", images(answer.get("content", "")), ""])
    markdown_str = "\n".join(lines)
    markdown = markdown_str.encode("utf-8")
    attachments_list = []
    for name, source in assets.items():
        try:
            attachments_list.append({
                "filename": name,
                "content_base64": base64.b64encode(source.read_bytes()).decode("ascii")
            })
        except Exception:
            pass

    if assets:
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(filename + ".md", markdown)
            for name, source in assets.items():
                archive.write(source, name)
        payload, suffix, mime = stream.getvalue(), ".zip", "application/zip"
    else:
        payload, suffix, mime = markdown, ".md", "text/markdown;charset=utf-8"
    return {
        "filename": filename + suffix,
        "stem": filename,
        "subject": subject,
        "paper_title": title,
        "markdown": markdown_str,
        "mime": mime,
        "data": base64.b64encode(payload).decode("ascii"),
        "attachments": attachments_list,
    }
