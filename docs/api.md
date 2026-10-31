# 本機介面約定（給外部工具與擴充整合）

Zotero 外掛、Obsidian 外掛、命令列指令碼或自訂代理接入 PaperRead 時，只依賴本頁列出的介面規格。這些介面保持向下相容；不相容改動會將 API 版本加 1，並提前記錄於版本日誌。

當前 API 約定版本：**1**（PaperRead 1.5.2 延續相容介面）。

---

## 1. 發現服務位址

PaperRead 啟動時會將服務位址與 PID 寫入資料目錄下的 `.server.json`（預設為 `~/PaperRead/.server.json`；若設定環境變數 `EASYREAD_HOME` 則位於該目錄下）：

```json
{
  "url": "http://127.0.0.1:8765",
  "pid": 12345,
  "started": "2026-10-31T12:00:00Z"
}
```

服務只監聽本機 `127.0.0.1`。外部工具應先讀取該檔案取得當前連接埠，並請求 `/api/version` 確認服務正常運作。

---

## 2. 論文與段落識別規則

- **論文 ID (`id`)**：原 PDF 檔案完整 SHA-256 雜湊的前 12 位小寫十六進位字元。相同 PDF 重複匯入將指向同一篇論文，不會重複建立。
- **段落/區塊 ID (`block_id`)**：`paper.json` 內區塊唯一 `id`（如 `s1-p2`, `tab1`, `fig2`, `eq3`），永久不變。

---

## 3. 核心基礎介面

| 方法 | 路徑 | 請求頭 / 參數 | 用途 |
|---|---|---|---|
| GET | `/api/version` | 無 | 返回 `{"api": 1, "version": "1.5.2"}` |
| GET | `/api/library` | 無 | 取得文獻庫清單（每篇的標題、作者、狀態、進度等）與寫入所需的 `token` |
| POST | `/api/import` | `X-Token`，URL 帶 `?name=<檔名>&translate=0\|1` | 上傳 PDF 二進位資料匯入文獻庫，返回 `{"id", "new", "queued"}` |
| GET | `/api/p/{id}/part/{name}` | `{name}` 為 `paper`、`reader`、`discussion`、`layout`、`job` | 讀取指定論文的分部 JSON 資料與版本雜湊 |
| GET | `/read/{id}` | 可帶 `#<block_id>` 錨點 | 開啟雙語閱讀介面並定位至指定段落 |
| GET | `/open` | `?id=<id>&block=<block_id>` 或 `?sha256=<sha256>&block=<block_id>` | 依識別碼或雜湊精確跳轉至指定論文段落 |

> [!NOTE]
> 所有 POST 寫入請求均需在 HTTP 請求頭附帶 `X-Token`，其值從 `GET /api/library` 中獲取。

---

## 4. 閱讀器原子操作介面 (`POST /api/p/{id}/ops`)

前端劃線、筆記、手寫與貼紙透過原子批次操作寫入：

```json
{
  "ops": [
    {
      "op": "note",
      "note": {
        "id": "n_123",
        "anchor": "s1-p2",
        "kind": "highlight",
        "color": "yellow",
        "quote": "文字引文",
        "created": "2026-10-31T12:00:00Z"
      }
    },
    {
      "op": "ink",
      "stroke": {
        "id": "i_01",
        "anchor": "s1-p2",
        "textHash": "a1b2c3d4",
        "ref": [620, 180],
        "points": [[10, 20], [15, 25]],
        "color": "#d94b4b",
        "width": 2
      }
    },
    {
      "op": "sticker",
      "sticker": {
        "id": "stk_01",
        "assetId": "star-01",
        "anchor": "s1-p2",
        "textHash": "a1b2c3d4",
        "ref": [620, 180],
        "x": 20, "y": 30, "width": 80, "height": 80,
        "rotation": 0, "opacity": 0.9, "z": 1, "locked": false
      }
    }
  ]
}
```

支援的 `op` 類型：
- `edit`：段落譯文使用者修訂版（支援撤銷為原譯文）。
- `note` / `note_del`：劃線與側欄筆記的新增、修改與虛擬刪除。
- `ai_annotation`：智慧標註洞察。
- `ink` / `ink_del`：向量手寫筆跡繪製與移除。
- `sticker` / `sticker_del`：圖章貼紙放置、調整與刪除。
- `paper_note`：整篇論文心得儲存。
- `progress`：閱讀進度百分比與錨點更新。

---

## 5. 個人研究工作區介面 (`/api/research/v2/*`)

### 5.1 跨論文關鍵字索引
- `GET /api/research/v2/keywords`：獲取所有關鍵字列表與統計。
- `POST /api/research/v2/keywords`：新增或更新關鍵字對應關係（中文名稱與英文匹配詞雙向關聯）。
- `GET /api/research/v2/keywords/matches?ids=<id1>,<id2>&mode=all|any`：檢索庫內所有命中該組關鍵字的論文引文段落（含 KaTeX 公式與原頁座標）。
- `POST /api/research/v2/keywords/update`：行內更新關鍵字。
- `POST /api/research/v2/keywords/archive`：批次封存或取消封存關鍵字。
- `POST /api/research/v2/keywords/delete`：批次永久刪除關鍵字。
- `POST /api/research/v2/keywords/scan/tasks`：發起全庫關鍵字非同步掃描任務。

### 5.2 閱讀路徑與畫布
- `GET /api/research/v2/reading-path/latest`：取得目前規劃的最新閱讀路徑（含節點關係與閱讀順序）。
- `POST /api/research/v2/reading-path/tasks`：調用 AI 依候選池自動規劃推薦閱讀順序。
- `POST /api/research/v2/reading-path/reorder`：手動調整閱讀路徑節點先後順序。
- `POST /api/research/v2/reading-path/relations`：手動或自動更新文獻間之關聯邊（如前置、推進、對立、消融對照）。

### 5.3 雙向心智圖（Markmap）
- `POST /api/research/v2/paper/{id}/mindmap/tasks`：為特定論文生成層級結構心智圖大綱。
- `GET /api/research/v2/mindmap/tasks/current`：查詢心智圖生成任務即時進度。
- `POST /api/research/v2/paper/{id}/mindmap`：儲存使用者在 Tiptap / Markmap 編輯後的 Markdown 階層。

### 5.4 論文深度技術剖析（Deep Technical Audit）
- `GET /api/research/v2/deep-analysis?pid={id}`：讀取論文深度剖析報告（`report.json`）。
- `POST /api/research/v2/paper/{id}/deep-analysis/tasks`：發起 5 維度技術審查非同步任務（Claims、Ablations、Toy Example、Baselines、Failures）。
- `GET /api/research/v2/deep-analysis/tasks/current`：審查任務輪詢進度。
- `POST /api/research/v2/paper/{id}/deep-analysis/apply-to-note`：將剖析審查重點一鍵帶入閱讀器側欄心得筆記。
- `POST /api/research/v2/paper/{id}/deep-analysis/export-obsidian`：單篇匯出至 Obsidian `04-論文深度剖析/`。

### 5.5 知識庫匯出
- `POST /api/research/v2/export/obsidian`：全量或增量匯出至 Obsidian 6 大專題目錄，具備受管區塊保護。
- `POST /api/research/v2/export/zip`：將文獻分析與筆記打包為 ZIP 存檔下載。
- `POST /api/research/v2/export/summary`：單篇或批次快速匯出 Markdown 摘要卡片。

---

## 6. 桌面專屬通訊協定（Custom URL Scheme）

桌面版註冊了 `paperread://` 協定（舊版 `easyread://` 保持向下相容）：

```text
paperread://open?id=<論文 id>&block=<段落 id>
paperread://open?sha256=<完整 SHA-256>&block=<段落 id>
easyread://open?id=<論文 id>&block=<段落 id>
```

點選後自動喚起 PaperRead 桌面應用程式視窗並精準定位至該論文的對應段落。在未安裝桌面版時，透過瀏覽器直接造訪 `http://127.0.0.1:8765/open?...` 具備相同效果。
