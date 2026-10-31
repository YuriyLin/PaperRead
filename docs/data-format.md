# 資料格式

PaperRead 的核心資料結構以檔案與標準 SQLite 為核心，兼顧單機易讀性、Git 備份友善與高效檢索。

---

## 1. 論文目錄結構 (`papers/{id}/`)

每篇論文擁有獨立目錄，以 PDF 雜湊前 12 碼小寫命名（例如 `papers/a1b2c3d4e5f6/`）：

| 檔案 | 權限/職責 | 說明 |
|---|---|---|
| `paper.json` | 引擎寫入 | 論文中英文雙語內容、排版區塊（Blocks）、中繼資料、術語表與參考文獻 |
| `discussion.json` | 引擎寫入 | 保存於頁邊的 AI 解釋、問答與即時追問記錄 |
| `reader.json` | 使用者寫入 | 讀者劃線、邊注、智慧標註、手寫筆跡（Ink）、圖章貼紙、全文心得與閱讀進度 |
| `report.json` | 引擎寫入 | 論文深度技術剖析（五維技術審查報告） |
| `layout.json` | 系統生成 | PDF 字元座標與區塊歸一化邊界框（Bounding Box），供原頁燈箱高亮 |
| `item.json` | 系統/使用者 | 閱讀狀態、星標、自定義分類標籤與中繼資料覆蓋 |
| `chat.json` | 系統寫入 | 「問 AI」的多分頁對話記錄、圖片附件與錨定上下文 |
| `job.json` | 系統排程 | 背景翻譯任務狀態（進度、失敗頁面、重試佇列） |
| `source.pdf` | 唯讀原檔 | 使用者匯入的原始 PDF 檔案 |
| `pages/page-*.webp` | 系統生成 | PDF 各頁高解析度光柵圖，供原頁燈箱全頁呈現 |
| `figures/crop-*.webp` | 系統生成 | 自動擷取的圖表檔案（以雜湊防快取衝突） |

---

## 2. paper.json

```json
{
  "schema": 2,
  "meta": {
    "title_zh": "給評測加上誤差條：語言模型評測的統計學方法",
    "short_zh": "給評測加上誤差條",
    "title_en": "Adding Error Bars to Evals: ...",
    "authors": "Evan Miller",
    "affiliation": "Anthropic",
    "date": "2024 年 11 月 4 日",
    "arxiv": "arXiv:2411.00640v1 [stat.AP]",
    "pdf": "source.pdf",
    "source_sha256": "…",
    "pages": [{"n": 1, "w": 612, "h": 792, "img": "pages/page-001.webp"}]
  },
  "translation": {
    "scope": "全文",
    "done_pages": [1, 2, 3],
    "note": "參考文獻保留原文"
  },
  "glossary": [
    { "en": "standard error", "zh": "標準誤差", "note": "統計術語" }
  ],
  "references": [
    { "id": "1", "text": "原文條目" }
  ],
  "blocks": [ … ]
}
```

### 區塊（Blocks）定義
每個區塊擁有全域唯一且不可變的 `id`，後續筆記、劃線與原頁定位均錨定於此：

| type | 欄位 | 說明 |
|---|---|---|
| `heading` | `level`(1/2)、`num`、`zh`、`en`、`appendix` | 章節標題。`num` 如 "2.1"、"A"；附錄標記 `"appendix": true` |
| `para` | `zh`、`en`、`role`、`cont` | 段落。`role: "abstract"` 為摘要樣式；`cont: true` 表示緊接公式的未完句 |
| `list` | `ordered`、`items: [{zh, en}]` | 項目清單 |
| `math` | `tex`、`tag` | 獨立行間公式。`tag` 為原文編號（如 "(4)"） |
| `table` | `num`、`head: [[…]]`、`rows: [[…]]`、`align`、`caption_zh`、`caption_en` | 三線書籍表格。單元格支援換行與行內標記 |
| `figure` | `num`、`src`、`box`、`image_en`、`image_zh`、`caption_zh`、`caption_en` | 圖表區塊。`box` 為歸一化裁剪框，`src` 為圖檔路徑 |
| `references` | `zh`、`en` | 參考文獻列表容器（取用 `references` 條目） |
| `note` | `zh` | 正文流內的專題閱讀註解 |

### 行內語法支援
- `$...$`：行內 KaTeX 數學公式（純文字美元符號請跳脫為 `\$`）。
- `**粗體**`、`*斜體*`、`` `程式碼` ``。
- `[7]`、`[2, 5]`：自動連結至文末參考文獻。
- 自動跳轉：文字中的「公式 (4)」、「表 2」、「圖 3」、「第 2.2 節」自動識別為可點選跳轉與懸停預覽的微連結。

---

## 3. reader.json

由前端透過 `/api/p/{id}/ops` 發送原子操作寫入：

```json
{
  "schema": 2,
  "rev": 15,
  "edits": {
    "s1-p3": { "zh": "讀者修訂後的中文", "base": "修改時譯者稿的雜湊", "at": "2026-10-31T12:00:00Z" },
    "tab1#caption": { "zh": "修訂後的表格題注", "base": "…", "at": "…" }
  },
  "notes": {
    "n_123": {
      "id": "n_123", "anchor": "s1-p2", "key": "s1-p2",
      "quote": "選中的文字片段", "prefix": "前文", "suffix": "後文",
      "kind": "note | question | highlight",
      "color": "yellow | green | blue | pink",
      "body": "讀者筆記內容",
      "created": "2026-10-31T12:00:00Z", "updated": "2026-10-31T12:00:00Z",
      "deleted": false
    }
  },
  "ai_annotations": {
    "a_456": {
      "annotation_id": "a_456", "block_id": "s2-p1",
      "quote": "關注語句", "kind": "terminology | methodology | insight",
      "comment": "AI 生成的智慧洞察", "created_at": "…", "updated_at": "…"
    }
  },
  "ink": {
    "i_789": {
      "id": "i_789", "group": "g_01", "anchor": "s1-p2", "textHash": "1234abcd",
      "ref": [620, 180], "points": [[20, 30], [22, 34]],
      "color": "#d94b4b", "width": 2,
      "updated": "2026-10-31T12:00:00Z", "deleted": false
    }
  },
  "stickers": {
    "stk_01": {
      "id": "stk_01", "assetId": "star-01", "anchor": "s1-p2", "textHash": "1234abcd",
      "ref": [620, 180], "x": 20, "y": 30, "width": 80, "height": 80,
      "rotation": 0, "opacity": 0.9, "z": 1, "locked": false,
      "strokeColor": "#d94b4b", "strokeWidth": 2,
      "href": "https://...", "textColor": "#23211d", "textSize": 14, "textBold": false,
      "text": "圖章文字", "updated": "2026-10-31T12:00:00Z", "deleted": false
    }
  },
  "paper_note": {
    "body": "全篇論文綜合筆記（支援 Markdown 與 KaTeX）",
    "at": "2026-10-31T12:00:00Z"
  },
  "progress": {
    "block": "s3-1-p2", "ratio": 0.42, "at": "2026-10-31T12:00:00Z"
  }
}
```

---

## 4. report.json（論文深度剖析）

```json
{
  "schema": 1,
  "paper_id": "a1b2c3d4e5f6",
  "markdown": "## 1. 核心主張與證據對照\n...\n## 2. 消融實驗審查 (Ablation Audit)\n...\n## 3. 關鍵公式拆解與數值示範 (Formula & Toy Example)\n...\n## 4. 基準線公平性與數據審查\n...\n## 5. 局限性、邊界與盲點\n...",
  "focus": "重點檢視 Transformer 注意力層的計算量瓶頸",
  "model": "claude-3-7-sonnet",
  "created_at": "2026-10-31T10:00:00Z",
  "updated_at": "2026-10-31T10:00:00Z"
}
```

---

## 5. discussion.json（AI 頁邊問答）

```json
{
  "schema": 2,
  "entries": [
    {
      "id": "d001-ab12c",
      "anchor": "s2-1-p4",
      "quote": "對它進行推斷",
      "kind": "explain | qa | insight | reply | check",
      "title": "原句推導疑問",
      "body": "詳細解答內容...",
      "reply_to": "n_123",
      "at": "2026-10-31T11:00:00Z"
    }
  ]
}
```

---

## 6. layout.json（原頁歸一化座標定位）

```json
{
  "s1-p3": {
    "page": 1,
    "src": "text",
    "box": [0.08, 0.10, 0.92, 0.90],
    "boxes": [
      [0.08, 0.60, 0.48, 0.90],
      [0.52, 0.10, 0.92, 0.30]
    ]
  }
}
```

每個座標方框均為以原 PDF 頁面寬高為基準的歸一化數值 `[x0, y0, x1, y1]`。`boxes` 支援多欄排版中折行段落的分段精準框選。

---

## 7. 研究工作區資料庫 (`.paperread-planning.sqlite3`)

存放於資料目錄根目錄下，採用 SQLite WAL 模式，管理文獻庫之上的研究規劃資料：

- **`statuses`**：閱讀看板欄位定義（`id`, `label`, `color`, `position`, `builtin`）。
- **`saved_papers`**：已收錄候選論文之延伸中繼資料、研讀計劃與所屬分類。
- **`candidates`**：OpenAlex 與外部探索檢索出的候選池清單。
- **`candidate_summaries`**：AI 預讀摘要快取與回收站管理。
- **`keywords` & `keyword_links`**：跨論文關鍵字索引表與段落雙向參照圖譜。
- **`cache`**：閱讀路徑（`reading-path:latest`）、心智圖與非同步背景任務狀態快取。

---

## 8. Obsidian 知識庫匯出目錄規範

在觸發匯出至 Obsidian 時，系統於目標 Vault 建立嚴格隔離的 6 大專題目錄：

```text
Vault Root/
├── 01-論文分析/          # 核心觀點、架構剖析與引文導讀
├── 02-心智圖/            # Markmap 階層大綱與雙向結構圖
├── 03-閱讀標註/          # 匯總全文劃線、邊注、AI 洞察與貼紙標籤
├── 04-論文深度剖析/      # 五維技術審查（Claims, Ablations, Toy Example 等）
├── 05-跨論文比較/        # 多篇論文之橫向綜合比較
├── 06-論文摘要/          # 候選論文精簡速讀摘要
└── .paperread-index.json # 匯出索引與雜湊映射表
```

### 使用者自定義筆記保護機制
匯出之 Markdown 檔案均包含受管區塊標記：

```markdown
<!-- paperread:managed:start -->
# 系統自動生成之結構化內容
...
<!-- paperread:managed:end -->

## 我的個人心得與延伸思考
讀者在此區塊手動撰寫的心得、待辦清單或 [[內部雙向連結]]，在後續覆蓋更新時均獲得 100% 完整保留。
```
