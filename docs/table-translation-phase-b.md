# 雙語表格：階段 B 交付紀錄

日期：2026-10-17。分支：`feature/bilingual-table-translation`。
起點：階段 A commit `65344dd1c742a6582bd685687480e739b77ef5f`，開始時工作目錄乾淨。
沿用階段 A `table_schema: 1`、雙語矩陣、註腳及四種閱讀模式，沒有重做渲染架構。

## 完成內容

1. **本機 PDF 辨識**：使用既有 pdfplumber 讀取實際 PDF 字元、字型、框線與座標。
   支援有框線矩形表格及欄位對齊證據充分的無框線統計表；以 `Table 1`、`Table A1.2` 等
   題注辨識來源，檢查欄列、字元覆蓋、表頭界線及註腳／來源範圍。
   不使用模型猜測英文欄列，不將舊 `head/rows` 推定為英文。
2. **完整表格翻譯**：將表題、每層表頭、列標籤、文字儲存格、註腳與資料來源交給現有翻譯引擎，
   使用既有模型與 Key，產生繁體中文；數據格與變數符號直接沿用英文原值。
3. **數據驗證**：呼叫模型前遮罩數值、正負號、精度、科學記號、百分比、顯著性標記、變數及公式。
   回應必須鍵集合完整、遮罩個數與順序一致；還原後經繁體正規化及術語處理，再比較每格、
   表題及註腳的不變內容。純數據／公式格逐字相同；錯誤結果不寫成已完成譯文。
4. **局部補譯**：閱讀器、HTTP 入口及 CLI 都提供表格專用任務。可補建原來遺漏的表格 block，
   也可只補齊既有表格缺少的文字格；完整且已驗證的格子不重送。
   有完整階段 A 雙語資料但尚無階段 B 快取者，與 PDF 核對後直接補快取，不呼叫模型。
5. **持久快取**：雙語內容與來源／譯文 SHA-256 雜湊在同一次 `paper.json` 原子寫入保存。
   重新開啟閱讀器直接呈現資料，模式切換只移動／顯隱 DOM。重送補譯任務也會驗證並沿用快取。
   完整 PDF 或英文結構變動會重新驗證；只有來源內容變動的表格需要更新翻譯，舊版本保存在
   `table_history`，不刪除既有結果。
6. **任務安全**：沿用持久 bulk 佇列、取消事件、用量記錄、頁數上限與原子儲存鎖。
   新增表格專用 OS 檔案鎖，跨執行緒與跨程序重複任務只翻譯一次；程序結束時 OS 自動釋放鎖。
   一般錯誤最多重試一次；額度／限流錯誤停止後續呼叫。提交前再次核對 PDF 身分、原 block
   內容及取消狀態，丟棄過期回應。重啟後已完成表格可直接命中快取。
7. **安全退回**：辨識不確定、合併格、續表、遮罩或數據驗證失敗，保留既有矩陣與譯文並標記
   `fallback`，閱讀器提供原 PDF 入口。新發現但無法還原的題注，也會保留頁碼與 PDF placeholder。

正文、`translation.done_pages/en_pages`、舊矩陣、既有 ID／來源框、`reader.json`、`layout.json`
及使用者筆記不由表格任務重寫。新辨識出的表格有頁碼入口；沒有實作階段 C 的表格本體批註、
跨頁精細定位或新式引用匯出。

## 舊論文如何只補譯表格

- 在連線閱讀器論文頁首按 **「只補譯表格」**。成功表格就地更新，失敗表格保留 PDF。
  可再次按同一按鈕重試；通過驗證的完整表格不再呼叫模型。
- CLI（使用現有虛擬環境）：

  ```powershell
  .venv/Scripts/python.exe -m easyread translate PAPER_ID --tables-only
  .venv/Scripts/python.exe -m easyread translate PAPER_ID --tables-only --pages 3-5
  ```

  服務執行中時交由同一佇列處理；服務未執行時在前景執行。
- HTTP：向既有 `POST /api/p/PAPER_ID/translate` 傳送 `{"tables_only": true}`，
  可加 `"pages": "3-5"`，沿用既有 token 驗證。仍適用既有頁數上限；選擇全文或縮小頁數後
  都保持表格任務，不會改為正文重譯。

新論文透過服務翻譯、或透過 CLI 前景翻譯為繁體中文後，會對成功處理的頁面接續補譯表格。
舊論文不會因為開啟頁面、切換模式或重新啟動而自動新增翻譯費用。
表格專用操作的目標語言固定為繁體中文，沒有改動其他語言正文及全域翻譯設定。

## 支援條件與限制

| 類型 | 本階段範圍 |
|---|---|
| 一般學術表格 | 英文、單頁矩形欄列、可辨識的上方 `Table` 題注；文字表格需明確表頭字型證據 |
| 描述統計表 | 數值欄、樣本數、平均數、標準差等；保留數字精度與空格 |
| 迴歸分析表 | 係數、正負號、顯著性符號、括號標準誤；支援標準誤獨立成列及空白標籤 |
| 相關矩陣 | 矩形矩陣、對角值、空白三角區域 |
| 假設檢定表 | 假設標籤、p 值、比較符號、信賴區間及文字結果 |
| 多列表頭 | 各列仍為相同欄數、沒有合併儲存格，且表頭／資料界線可確認 |
| 無框線表格 | 至少兩筆資料列、穩定對齊、統計數字證據、沒有折行或漏欄疑慮 |
| 註腳／來源 | 表格下方相鄰、以 Note／Source／Standard errors／顯著性符號起頭；可接續同字級折行 |

以下情況採保守退回，尚不宣稱支援：掃描／影像表格、缺少可辨識題注、題注在下方、
羅馬表號、合併格、跨頁拼接、跨欄／並排歧義、表頭界線不明、未標示且界線不明的註腳、
混合字級上下標／複雜數學排版、缺字或字元覆蓋不符。
無框線文字表格及單筆資料的無框線表格，也不以統計對齊規則猜測。

這是對有明確幾何證據的表格提供支援，不是對所有真實期刊版型的辨識率承諾。
模型測試全為 Mock，驗證了流程與資料不變性，沒有測量真實模型的中文語意品質。
未完成實際瀏覽器目視驗證；使用真實 reader 程式配合模擬 DOM 測試四種模式與操作。
合成迴歸 PDF 已用 Poppler 渲染並目視確認表格、標準誤、註腳與來源配置。

## 修改檔案

| 檔案 | 修改 |
|---|---|
| `easyread/table_extract.py`（新增） | 本機 PDF 幾何、字元覆蓋、表頭、註腳、續表與安全退回 |
| `easyread/table_translate.py`（新增） | 遮罩逐格翻譯、缺漏補譯、持久快取、OS 鎖、重試、取消及過期檢查 |
| `easyread/tables.py` | 共用數據／公式不變性及完整譯文驗證，保留階段 A 格式檢查 |
| `easyread/jobs.py`、`easyread/translate_api.py` | 表格專用持久任務、頁數上限、重啟恢復及一般翻譯後接續表格 |
| `easyread/cli.py` | `--tables-only` 與前景翻譯整合 |
| `easyread/store.py` | Windows 原子替換期間短暫讀取 PermissionError 的有限重試 |
| `easyread/web/js/reader/render.js`、`actions.js`、`panels.js` | 只補譯表格按鈕、錯誤提示及表格任務狀態 |
| `easyread/web/js/common/page-cap.js`、`easyread/web/i18n/en.json` | 保留表格任務類型的超頁數操作及英文介面文字 |
| `tests/test_table_translation.py`（新增） | 51 項 Python 測試；真實合成 PDF 與明確 Mock 模型 |
| `tests/test_table_actions.cjs`（新增）、`test_table_render.cjs`、`test_page_cap.cjs` | 新增 5 項 Node 操作、快取呈現及頁數確認測試 |
| `docs/data-format.md`、本文件 | 資料欄位、使用方法、測試與限制 |

## 測試、安全及既有相容性問題

使用既有 `.venv` 與 Cursor 內附 Node，沒有安裝套件或更改全域環境。
隔離執行器在載入專案前指定測試專用 EASYREAD_HOME／EASYREAD_LIBRARY；封鎖未 Mock
模型入口、模型 CLI 及 socket 連線。跨程序測試的兩個子程序也明確 Mock 翻譯入口並封鎖
模型 CLI 與 socket。沒有呼叫 Gemini、Codex 或其他模型 API 進行翻譯測試。

| 最終範圍 | 通過 | 失敗 | 跳過 |
|---|---:|---:|---:|
| 階段 A 相關 Python + 階段 B + 既有 Jobs／頁數上限 | 233 | 0 | 0 |
| 全部 `tests/test_*.cjs` Node 單元測試 | 153 | 0 | 0 |

Python 的 233 項包含原階段 A 的 155 項、階段 B 新增 51 項，以及既有 Jobs／頁數上限
27 項；涵蓋 PDF 抽取、翻譯／續譯、模式、句子、筆記、螢光筆、定位、設定遷移、
智慧標註、Obsidian 匯出等相關回歸。這不是全專案 Python 或瀏覽器 E2E 測試。
`git diff --check` 通過；英文介面詞條檢查包含於上述 Python 測試。

本次基線再次重現階段 A 已記錄的 Windows `paper.json` 並行讀取 PermissionError，
造成原有翻譯測試失敗。本次只在 `read_json` 增加有限的短暫重試；永久權限錯誤仍會拋出。
新增針對暫時拒讀的測試，最終整組與跨程序快取測試通過，沒有更改檔案權限。

第一次 Node 指令誤含 `tests/e2e.cjs`，因未安裝 Playwright 失敗；當時既有 148 項單元測試
已通過。已改回 `tests/test_*.cjs` 的既有單元範圍，沒有安裝或宣稱執行瀏覽器 E2E。
開發中的 i18n 遺漏及測試 harness 問題均已修正；最後結果為上表的零失敗、零跳過。

本機詳細紀錄保留在 Git 忽略的 `.paperread-local-test/`：

- `phase-b-baseline/python.txt`、`python-summary.json`：修改前基線及已知 Windows 失敗。
- `phase-b-final/python.txt`、`python-summary.json`：最終 233 項 Python。
- `phase-b-node-final.txt`：最終 153 項 Node。
- `run_checks.py`：沿用的隔離執行器；`visual/regression.pdf/png` 為合成視覺測試資料。

重現相關 Python 範圍（透過上述隔離執行器執行）：

```powershell
.venv/Scripts/python.exe .paperread-local-test/run_checks.py phase-b-final `
  tests.test_bilingual_tables tests.test_config_migration tests.test_consistency `
  tests.test_i18n tests.test_langs tests.test_multiregion_layout tests.test_obsidian_export `
  tests.test_page_check tests.test_pdf_concurrency tests.test_pdf_extraction tests.test_pdfwork `
  tests.test_reader_ops tests.test_readmode tests.test_release_i18n tests.test_segments `
  tests.test_sentences tests.test_smart_annotations tests.test_table_shape tests.test_translate `
  tests.test_table_translation tests.test_jobs tests.test_page_cap
$nodeTests = (Get-ChildItem tests/test_*.cjs).FullName
.paperread-local-test/bin/node.cmd --test @nodeTests
```

未改動正式文獻庫、Obsidian Vault、API Key、模型／計費設定；未清除既有翻譯結果。
測試資料、環境、日誌、PDF／PNG 及使用者資料均不納入提交。

## 交付邊界

建立本機提交 `feat: add verified PDF table translation and backfill`。
不 push、不建立 PR。階段 B 完成後停止，等待使用者審查；不自行進入階段 C。
