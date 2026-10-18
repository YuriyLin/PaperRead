from __future__ import annotations

import sqlite3
import struct
import threading
from pathlib import Path

from ..i18n import tr
from .markdown import chunks, parse_note, readable
from .store import index_folders, sha256_text, state_dir, vault_path

MODEL = "intfloat/multilingual-e5-small"
MODEL_REVISION = "614241f622f53c4eeff9890bdc4f31cfecc418b3"
MODEL_VERSION = MODEL + "@" + MODEL_REVISION + ":onnx-model_O4"
MODEL_FILES = (
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "onnx/model_O4.onnx",
)
_MODEL = None
_MODEL_LOCK = threading.Lock()


def _db() -> sqlite3.Connection:
    path = state_dir() / "index.sqlite3"
    db = sqlite3.connect(path, timeout=20)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA busy_timeout=20000")
    db.executescript("""
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY, file_hash TEXT NOT NULL, mtime_ns INTEGER NOT NULL,
        size INTEGER NOT NULL, indexed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY, path TEXT NOT NULL, file_hash TEXT NOT NULL, kind TEXT NOT NULL,
        title TEXT NOT NULL, section TEXT NOT NULL, content TEXT NOT NULL,
        embedding BLOB, model_version TEXT, source_id TEXT, pdf_sha256 TEXT, block_id TEXT, page INTEGER
      );
      CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        id UNINDEXED, title, section, content, tokenize='trigram'
      );
    """)
    columns = {row[1] for row in db.execute("PRAGMA table_info(chunks)")}
    for name, type_ in (("source_id", "TEXT"), ("pdf_sha256", "TEXT"), ("block_id", "TEXT"), ("page", "INTEGER")):
        if name not in columns:
            db.execute(f"ALTER TABLE chunks ADD COLUMN {name} {type_}")
    db.commit()
    return db


def _embedder():
    global _MODEL
    if _MODEL is not None:
        return _MODEL
    with _MODEL_LOCK:
        if _MODEL is not None:
            return _MODEL
        from fastembed import TextEmbedding
        from fastembed.common.model_description import ModelSource, PoolingType
        names = {item["model"] for item in TextEmbedding.list_supported_models()}
        if MODEL not in names:
            TextEmbedding.add_custom_model(
                model=MODEL,
                pooling=PoolingType.MEAN,
                normalization=True,
                sources=ModelSource(hf=MODEL),
                dim=384,
                model_file="onnx/model_O4.onnx",
                additional_files=["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json"],
                license="mit",
                size_in_gb=0.25,
            )
        # FastEmbed's snapshot cache can leave small tokenizer files missing from
        # the snapshot directory on Windows when symlinks are unavailable. Fetch
        # each required file into a normal local directory so inference is reliable
        # on standard, non-Developer-Mode Windows installations.
        from huggingface_hub import hf_hub_download
        model_dir = state_dir() / "models" / "multilingual-e5-small"
        model_dir.mkdir(parents=True, exist_ok=True)
        for filename in MODEL_FILES:
            hf_hub_download(
                repo_id=MODEL,
                filename=filename,
                revision=MODEL_REVISION,
                local_dir=str(model_dir),
            )
        _MODEL = TextEmbedding(
            model_name=MODEL,
            cache_dir=str(state_dir() / "models"),
            threads=2,
            local_files_only=False,
            specific_model_path=str(model_dir),
        )
    return _MODEL


def _vec_bytes(vector) -> bytes:
    import numpy as np
    values = np.asarray(vector, dtype=np.float32)
    return struct.pack("<I", len(values)) + values.tobytes()


def _vec_values(raw: bytes):
    import numpy as np
    size = struct.unpack("<I", raw[:4])[0]
    return np.frombuffer(raw, dtype=np.float32, count=size, offset=4)


def _source_files(root: Path):
    ignored = {".obsidian", ".git", ".trash", ".research-os", "node_modules"}
    root = root.resolve()
    seen = set()
    for configured in index_folders():
        base = root
        for part in configured.split("/"):
            exact = base / part
            if exact.exists():
                base = exact
                continue
            try:
                match = next((child for child in base.iterdir() if child.name.casefold() == part.casefold()), None)
            except OSError:
                match = None
            if match is None:
                base = root / ".__missing_research_folder__"
                break
            base = match
        if not base.is_dir() or not base.resolve().is_relative_to(root):
            continue
        for path in base.rglob("*.md"):
            relative = path.relative_to(root)
            if relative.as_posix() in seen:
                continue
            if any(part.casefold() in ignored or part.startswith(".") for part in relative.parts):
                continue
            if path.is_file() and path.resolve().is_relative_to(root):
                seen.add(relative.as_posix())
                yield path, relative.as_posix()


def _contains_cjk(text: str) -> bool:
    if not text:
        return False
    return sum("\u3400" <= char <= "\u9fff" for char in text) / len(text) > 0.08


def _embed_chunks(encoder, passages):
    return iter(encoder.embed(passages, batch_size=16)) if encoder and passages else None


def _index_one(db: sqlite3.Connection, root: Path, path: Path, relative: str, text: str, encoder, stat):
    note = parse_note(path, relative, text)
    content_hash = sha256_text(text)
    pieces = chunks(note, text)
    base_id = note.identity
    passages = []
    for index, (heading, piece) in enumerate(pieces):
        digest = sha256_text(f"{relative}\0{content_hash}\0{index}\0{piece}")[:24]
        chunk_id = f"{base_id}:{digest}"
        passage = f"passage: {note.title[:100]} | {heading[:100]} | {readable(piece)}"
        passages.append((chunk_id, note.kind, note.title, heading, piece, passage))

    vectors = _embed_chunks(encoder, [item[5] for item in passages])

    db.execute("DELETE FROM chunks_fts WHERE id IN (SELECT id FROM chunks WHERE path=?)", (relative,))
    db.execute("DELETE FROM chunks WHERE path=?", (relative,))
    for chunk_id, kind, title, heading, piece, _ in passages:
        vector = _vec_bytes(next(vectors)) if vectors else None
        db.execute("""INSERT INTO chunks(id,path,file_hash,kind,title,section,content,embedding,model_version)
                      VALUES(?,?,?,?,?,?,?,?,?)""",
                   (chunk_id, relative, content_hash, kind, title, heading, piece, vector,
                    MODEL_VERSION if vector else None))
        db.execute("INSERT INTO chunks_fts(id,title,section,content) VALUES(?,?,?,?)",
                   (chunk_id, title, heading, readable(piece)))
    db.execute("INSERT OR REPLACE INTO files(path,file_hash,mtime_ns,size,indexed_at) VALUES(?,?,?,?,datetime('now'))",
               (relative, content_hash, stat.st_mtime_ns, stat.st_size))
    db.commit()


def _index_easyread(db: sqlite3.Connection, lib, encoder, cancel_event=None, progress=None, start=0, total=0, force=False) -> dict:
    seen = set()
    changed = 0
    errors = []
    workspaces = lib.all()
    for position, ws in enumerate(workspaces, 1):
        if cancel_event and cancel_event.is_set():
            break
        rel = f"easyread/{ws.id}"
        seen.add(rel)
        try:
            paper = ws.load("paper") or {}
            meta = paper.get("meta") or {}
            full_sha = str(meta.get("source_sha256") or "")
            if len(full_sha) != 64:
                full_sha = ""
            reader = ws.load("reader") or {}
            fingerprint = sha256_text(str(ws.versions().get("paper", "")) + str(reader.get("rev", 0)) +
                                      str(paper.get("translation", {}).get("done_pages", [])))
            old = db.execute("SELECT file_hash FROM files WHERE path=?", (rel,)).fetchone()
            missing_vectors = db.execute("SELECT 1 FROM chunks WHERE path=? AND embedding IS NULL LIMIT 1", (rel,)).fetchone()
            if not force and old and old["file_hash"] == fingerprint and (not missing_vectors or encoder is None):
                continue
            title = str(meta.get("title_en") or meta.get("title_zh") or ws.id)
            section = "Abstract"
            extracted = []
            for block in paper.get("blocks", []):
                if block.get("type") == "heading":
                    section = " ".join(str(block.get(k) or "") for k in ("num", "en", "zh")).strip() or section
                    continue
                values = [block.get(k) for k in ("en", "zh", "caption_en", "caption_zh", "tex") if block.get(k)]
                if block.get("type") == "list":
                    values.extend(item.get(k) for item in block.get("items", []) for k in ("en", "zh") if item.get(k))
                if block.get("type") == "table":
                    values.extend(str(cell) for row in block.get("head", []) + block.get("rows", []) for cell in row if cell)
                text = "\n".join(dict.fromkeys(str(value).strip() for value in values if str(value).strip()))
                if not text:
                    continue
                block_id, page = str(block.get("id") or ""), int(block.get("page") or 0)
                cap = 320 if _contains_cjk(text) else 1050
                step = max(1, cap - min(100, cap // 4))
                for part_index, start in enumerate(range(0, len(text), step)):
                    content = text[start:start + cap].strip()
                    if content:
                        extracted.append((f"paper:{ws.id}:{block_id}:{part_index}", section, page, block_id, content))
            passages = [f"passage: {title[:60]} | {heading[:60]} | {content}"
                        for _, heading, _, _, content in extracted]
            vectors = _embed_chunks(encoder, passages)
            db.execute("DELETE FROM chunks_fts WHERE id IN (SELECT id FROM chunks WHERE path=?)", (rel,))
            db.execute("DELETE FROM chunks WHERE path=?", (rel,))
            for chunk_id, heading, page, block_id, content in extracted:
                vector = _vec_bytes(next(vectors)) if vectors else None
                db.execute("""INSERT INTO chunks(id,path,file_hash,kind,title,section,content,embedding,model_version,
                              source_id,pdf_sha256,block_id,page) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                           (chunk_id, rel, fingerprint, "paper", title, heading, content, vector,
                            MODEL_VERSION if vector else None, ws.id, full_sha, block_id, page))
                db.execute("INSERT INTO chunks_fts(id,title,section,content) VALUES(?,?,?,?)",
                           (chunk_id, title, heading, readable(content)))
            db.execute("INSERT OR REPLACE INTO files(path,file_hash,mtime_ns,size,indexed_at) VALUES(?,?,0,?,datetime('now'))",
                       (rel, fingerprint, len(extracted)))
            db.commit()
            changed += 1
        except (OSError, ValueError, KeyError, sqlite3.Error) as error:
            errors.append(f"{ws.id}: {error}"[:260])
        if progress:
            progress("indexing-papers", start + position, total, tr("索引 PaperRead 論文 {done}/{total}", done=position, total=len(workspaces)))
    cancelled = cancel_event and cancel_event.is_set()
    removed = [] if cancelled else [row[0] for row in db.execute("SELECT path FROM files WHERE path LIKE 'easyread/%'") if row[0] not in seen]
    for rel in removed:
        db.execute("DELETE FROM chunks_fts WHERE id IN (SELECT id FROM chunks WHERE path=?)", (rel,))
        db.execute("DELETE FROM chunks WHERE path=?", (rel,))
        db.execute("DELETE FROM files WHERE path=?", (rel,))
    db.commit()
    return {"papers": len(seen), "updated": changed, "removed": len(removed), "errors": errors[:12]}


def index_vault(rebuild: bool = False, library=None, semantic: bool = True, cancel_event=None, progress=None) -> dict:
    root = vault_path()
    if root is None or not root.is_dir():
        raise ValueError(tr("設定 Obsidian Vault 資料夾後即可建立研究索引。"))
    db = _db()
    source_files = list(_source_files(root))
    files_seen = 0
    changed = 0
    errors = []
    encoder = None
    encoder_attempted = False
    total = len(source_files) + (len(library.all()) if library is not None else 0)

    def get_encoder():
        nonlocal encoder, encoder_attempted
        if not encoder_attempted:
            encoder_attempted = True
            if progress:
                progress("loading-model", files_seen, total,
                         tr("載入本機多語向量模型（首次使用會下載）"))
            try:
                encoder = _embedder()
            except Exception as error:  # model download/runtime failure leaves lexical search usable
                errors.append("Embedding model is not ready: " + str(error)[:220])
        return encoder

    try:
        if rebuild and semantic:
            get_encoder()
        for path, relative in source_files:
            if cancel_event and cancel_event.is_set():
                raise InterruptedError(tr("索引工作已取消。"))
            files_seen += 1
            try:
                stat = path.stat()
                old = db.execute("SELECT file_hash,mtime_ns,size FROM files WHERE path=?", (relative,)).fetchone()
                missing_vectors = db.execute("SELECT 1 FROM chunks WHERE path=? AND embedding IS NULL LIMIT 1", (relative,)).fetchone()
                unchanged_stat = old and old["mtime_ns"] == stat.st_mtime_ns and old["size"] == stat.st_size
                if not rebuild and unchanged_stat and not missing_vectors:
                    continue
                text = path.read_text(encoding="utf-8-sig")
                digest = sha256_text(text)
                if not rebuild and old and old["file_hash"] == digest:
                    if not missing_vectors:
                        db.execute("UPDATE files SET mtime_ns=?,size=? WHERE path=?", (stat.st_mtime_ns, stat.st_size, relative))
                        db.commit()
                        continue
                    if not semantic or get_encoder() is None:
                        continue
                if semantic and not encoder_attempted:
                    get_encoder()
                if cancel_event and cancel_event.is_set():
                    raise InterruptedError(tr("索引工作已取消。"))
                _index_one(db, root, path, relative, text, encoder, stat)
                changed += 1
            except (OSError, UnicodeError, sqlite3.Error, ValueError) as error:
                errors.append(f"{relative}: {error}"[:260])
            if progress:
                progress("indexing-notes", files_seen, total, tr("索引 Obsidian 筆記 {done}/{total}", done=files_seen, total=len(source_files)))
        if cancel_event and cancel_event.is_set():
            raise InterruptedError(tr("索引工作已取消。"))
        existing = {relative for _, relative in _source_files(root)}
        removed = [row[0] for row in db.execute("SELECT path FROM files WHERE path NOT LIKE 'easyread/%'") if row[0] not in existing]
        for relative in removed:
            db.execute("DELETE FROM chunks_fts WHERE id IN (SELECT id FROM chunks WHERE path=?)", (relative,))
            db.execute("DELETE FROM chunks WHERE path=?", (relative,))
            db.execute("DELETE FROM files WHERE path=?", (relative,))
        db.commit()
        if library is not None:
            needs_vectors = db.execute("SELECT 1 FROM chunks WHERE path LIKE 'easyread/%' AND embedding IS NULL LIMIT 1").fetchone()
            if semantic and needs_vectors and not encoder_attempted:
                get_encoder()
            paper_status = _index_easyread(db, library, encoder if semantic else None, cancel_event, progress, files_seen, total, force=rebuild)
            errors.extend(paper_status["errors"])
        else:
            paper_status = {"papers": 0, "updated": 0, "removed": 0}
        count = db.execute("SELECT count(*) FROM chunks").fetchone()[0]
        embedded = db.execute("SELECT count(*) FROM chunks WHERE embedding IS NOT NULL").fetchone()[0]
        return {"files": files_seen, "updated": changed, "removed": len(removed), "chunks": count,
                "embedded": embedded, "papers": paper_status["papers"], "paper_updates": paper_status["updated"],
                "errors": errors[:12]}
    finally:
        db.close()


def _query_vector(query: str):
    import numpy as np
    encoder = _embedder()
    return np.asarray(next(iter(encoder.query_embed("query: " + query))), dtype=np.float32)


def search(query: str, limit: int = 10, kind: str = "", library=None) -> dict:
    query = query.strip()
    if not query:
        return {"results": [], "index": {"files": 0, "chunks": 0, "errors": []}}
    limit = max(1, min(int(limit), 30))
    from . import tasks
    active_index = next((task for task in tasks.list_tasks()
                         if task["kind"] == "index" and task["state"] in ("queued", "running", "cancelling")), None)
    index_status = ({"files": 0, "chunks": 0, "errors": [], "semantic_task": active_index}
                    if active_index else index_vault(library=library, semantic=False))
    db = _db()
    try:
        filters = " AND chunks.kind=?" if kind else ""
        params = [kind] if kind else []
        literal = query.strip()
        lexical = []
        try:
            rows = db.execute("""SELECT chunks.*,bm25(chunks_fts,0,2.0,1.4,1.0) rank
                FROM chunks_fts JOIN chunks ON chunks.id=chunks_fts.id
                WHERE chunks_fts MATCH ?""" + filters + " ORDER BY rank LIMIT 60",
                [f'"{literal.replace(chr(34), chr(34)*2)}"'] + params).fetchall()
            lexical.extend(rows)
        except sqlite3.Error:
            pass
        # Trigram FTS helps full phrases, while substring fallback preserves CJK
        # short-word lookup and mixed queries that the tokenizer cannot match.
        rows = db.execute("SELECT * FROM chunks WHERE (instr(lower(content),lower(?))>0 OR instr(lower(title),lower(?))>0)" +
                          (" AND kind=?" if kind else "") + " LIMIT 60", [literal, literal] + params).fetchall()
        lexical.extend(rows)
        ranks: dict[str, tuple[sqlite3.Row, float]] = {}
        for index, row in enumerate(lexical):
            ranks.setdefault(row["id"], (row, 1 / (60 + index + 1)))

        vector_error = ""
        has_vectors = db.execute("SELECT 1 FROM chunks WHERE embedding IS NOT NULL LIMIT 1").fetchone()
        needs_vectors = db.execute("SELECT 1 FROM chunks WHERE embedding IS NULL LIMIT 1").fetchone()
        model_cached = (state_dir() / "models" / f"models--{MODEL.replace('/', '--')}").exists()
        needs_model = bool(has_vectors and _MODEL is None and not model_cached)
        try:
            if needs_model:
                raise FileNotFoundError(tr("語意模型尚未下載。"))
            if has_vectors:
                import numpy as np
                query_vector = _query_vector(query)
            else:
                raise FileNotFoundError(tr("語意索引尚未建立。"))
            rows = db.execute("SELECT * FROM chunks WHERE embedding IS NOT NULL" + (" AND kind=?" if kind else ""), params).fetchall()
            semantic = []
            for row in rows:
                vector = _vec_values(row["embedding"])
                score = float(np.dot(query_vector, vector))
                semantic.append((score, row))
            semantic.sort(key=lambda item: item[0], reverse=True)
            for index, (_, row) in enumerate(semantic[:60]):
                old = ranks.get(row["id"])
                ranks[row["id"]] = (row, (old[1] if old else 0) + 1 / (60 + index + 1))
        except Exception as error:
            vector_error = str(error)[:240]
            if needs_vectors or needs_model:
                def build_semantic_index(cancel_event, report):
                    if needs_model:
                        report("loading-model", 0, 0, tr("載入本機多語向量模型（首次使用會下載）"))
                        _embedder()
                    return index_vault(library=library, semantic=True, cancel_event=cancel_event, progress=report)
                index_status["semantic_task"] = tasks.submit("index", build_semantic_index)
        ranked = sorted(ranks.values(), key=lambda item: item[1], reverse=True)[:limit]
        results = []
        for row, score in ranked:
            snippet = readable(row["content"])
            if len(snippet) > 700:
                found = snippet.casefold().find(literal.casefold())
                start = max(0, found - 240) if found >= 0 else 0
                snippet = ("…" if start else "") + snippet[start:start + 640] + ("…" if start + 640 < len(snippet) else "")
            results.append({"id": row["id"], "kind": row["kind"], "title": row["title"], "section": row["section"],
                            "path": row["path"], "text": row["content"], "snippet": snippet, "score": round(score, 5),
                            "source_id": row["source_id"], "sha256": row["pdf_sha256"], "block": row["block_id"], "page": row["page"]})
        if vector_error:
            index_status["errors"] = (index_status.get("errors") or []) + ["Semantic search: " + vector_error]
        return {"query": query, "results": results, "index": index_status}
    finally:
        db.close()


def indexed_rows(limit: int = 1000) -> list[dict]:
    db = _db()
    try:
        return [dict(row) for row in db.execute("SELECT * FROM chunks ORDER BY path, id LIMIT ?", (limit,))]
    finally:
        db.close()
