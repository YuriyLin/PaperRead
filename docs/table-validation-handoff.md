# 表格辨識驗證交接

更新日期：2026-10-18（Asia/Taipei）。因 Codex 五小時使用額度約剩 4%，本次僅安全收尾與保存交接，不繼續開發或深入診斷。

## Git 與本次保存範圍

- 專案：`C:\Users\00818\Documents\PaperRead`
- 分支：`feature/bilingual-table-translation`
- 收尾前 HEAD：`37b078147ae9960d15c3576409e4b0f8c0433032`
- 收尾前 `git status --porcelain=v1 --untracked-files=all` 無輸出；staged、unstaged diff 均為空。
- 本次只新增本文件並建立本機 commit，未修改程式碼或測試資料。最終 commit 以 `git rev-parse HEAD` 查詢，避免文件自我引用 commit hash。
- 本次未執行測試、PDF 內容診斷、Gemini／Codex 翻譯或任何真實 API；未啟動 Electron，未修改正式文獻庫、Obsidian Vault、憑證或測試 PDF。
- 不 push、不建立 PR、不覆蓋既有變更、不使用 `git reset --hard` 或 `git clean`。

## 測試材料與既有診斷證據

原始論文：Dahlstrand (2026), *Defying Distance? The Provision of Medical Services in the Digital Age.*

四份單頁 PDF 位於 `.paperread-local-test/gemini-validation/inbox/`，分別對應原論文第 **9、10、16、31** 頁。每份測試 PDF 的實體頁碼均為 **1**；原論文頁碼須透過來源 metadata／`--original-page` 區分。

以下為使用者提供、先前已確認的成果，本次未重新擷取或診斷 PDF：

| 項目 | 四份 PDF 的已知結果 |
| --- | --- |
| 文字擷取 | 均可擷取 |
| Paper ID | 四份各不相同 |
| SHA-256 與來源 metadata | 已確認一致 |
| `paper.blocks` | 均為空 |
| 呼叫鏈 | `table_translate._discover()` 正常呼叫 `table_extract.extract_page()` |
| Sources／Unresolved／Issues | 每份均為 `0 / 0 / 0` |
| 真實 Gemini API | 尚未發出請求 |

本次未另行列出檔名、Paper ID 或雜湊值；恢復時應從既有 inbox 與隔離 library metadata 對照，不能猜測或重建來源關係。

**目前尚不能判定表格辨識器存在 Bug。** 可擷取文字不代表頁面包含完整表格；三組結果皆為零也不能單獨證明漏判。

## 未解決事項

1. 四頁實際是否包含完整表格，或主要為公式、圖片與一般正文？
2. 若存在表格，`table_extract.py` 是否漏判無框線學術表格？
3. 是否受表格標題格式、標題位置、頁面排版或單頁擷取造成的上下文缺失影響？
4. 若證實漏判，如何最小修正，並維持公式、圖片與正文的誤判防護？

## 恢復時必須遵循的順序

**第一步：讀取本交接文件與 Git 狀態。** 先確認分支、HEAD 和未提交修改；保留使用者後續變更。

**第二步：以唯讀方式檢查四頁 PDF 的實際內容。** 逐頁區分表格、公式、圖片與一般正文，記錄是否完整、標題位置及原論文頁碼與測試 PDF 頁碼的對應。不要先假設四頁都有表格，不要修改 PDF 或匯入資料。若需渲染，輸出另存隔離暫存位置。

**第三步：診斷 `table_extract.extract_page()` 的表格候選辨識條件。** 依第二步的視覺證據對照標題辨識、搜尋範圍、候選幾何、無框線策略與結構驗證，定位候選未產生或遭拒的階段。

**第四步：若確定有漏判，先提出最小修正方案與回歸測試。** 說明觸發條件、預期結果及如何防止公式、圖片、正文被誤認；若頁面沒有完整表格，記錄結果並與使用者確認合適的驗證頁面。

**第五步：經使用者確認後再修改程式碼。** 本次交接不構成後續修改授權。確認後僅執行與修正相關的局部測試。

**第六步：表格辨識成功後，再由使用者手動執行 Gemini 單次真實翻譯驗證。** 不由代理自動發送；以實際辨識出的 Table ID、使用者選定模型及既有互動授權流程執行。

後續產品目標：使用者可直接在**隔離版 PaperRead 匯入 PDF、選擇頁面並驗證翻譯**，不必長期依賴手動 PowerShell 操作。此目標尚未由本次工作完成，勿將既有 Mock 結果檢視介面視為完整驗證流程。

## 程式碼入口與診斷路線

下列位置僅依本次靜態讀取整理，並非四頁漏判的原因結論：

- `scripts/validate_gemini_table.py:main()`：CLI 入口，`--init`／`--list`／`--run`。`--list` 會呼叫 `prepare()`，**不是純唯讀操作**。
- `easyread/gemini_validation.py:prepare()`：驗證單頁 PDF、建立／使用隔離 workspace、保存來源 metadata，並以 `[1]` 呼叫 `_discover()`。
- `easyread/table_translate.py:_discover()`：逐頁呼叫 `table_extract.extract_page()`，檢查辨識結果與 blocks 寫入的接點。
- `easyread/table_extract.py:_lines()`、`_CAPTION`、`extract_page()`：文字行與標題候選、標題下方搜尋區域、`page.find_tables()` 與無框線候選流程。
- `easyread/table_extract.py:_matrix()`：儲存格幾何、字元歸屬與表頭等結構檢查；`recognize()`：既有 block 的重新辨識入口。
- `tests/test_table_translation.py:ExtractionTest`：已有 `test_aligned_borderless_table`、缺少標題、合併儲存格、續表、裁切等案例；既有無框線測試不能證明本論文版型已受涵蓋。
- `tests/test_table_translation.py:TableJobTest`：包含缺少 table blocks 時重新發現的案例。
- `tests/test_gemini_validation.py`：隔離來源與假 transport 驗證。
- `scripts/run_regression.py`：指定局部 unittest 的離線 harness，攔截外部連線、未 mock 的模型 CLI 與 Gemini transport；輸出位於 `.paperread-local-test/gemini-validation-final/`，執行會更新其日誌。
- `scripts/start_table_review.ps1`：預設 Mock；`-ReviewData GeminiValidation` 讀取隔離結果，會先執行 `--init`。`RealModelValidation` 目前明確封鎖。

## 下次可用的本機指令（本次均未執行）

先做唯讀狀態確認：

```powershell
Set-Location 'C:\Users\00818\Documents\PaperRead'
Get-Content -Encoding UTF8 .\docs\table-validation-handoff.md
git branch --show-current
git rev-parse HEAD
git status --short --branch
git diff --stat
git diff --cached --stat
Get-ChildItem -LiteralPath '.\.paperread-local-test\gemini-validation\inbox' -Filter '*.pdf'
```

完成視覺檢查、提出方案並取得修改確認後，可用指定案例的局部離線測試；不要無參數執行完整套件：

```powershell
.\.venv\Scripts\python.exe .\scripts\run_regression.py tests.test_table_translation.ExtractionTest
# 若變更影響 discovery／隔離整合，再選用對應局部測試：
.\.venv\Scripts\python.exe .\scripts\run_regression.py tests.test_table_translation.TableJobTest tests.test_gemini_validation
git diff --check
```

若之後需要重跑隔離發現流程，以下只是範本；先將 `<實際檔名>` 與原論文頁碼配對。`--list` 無模型請求，但會初始化／更新隔離 library，不能用於第二步的唯讀內容檢查：

```powershell
.\.venv\Scripts\python.exe .\scripts\validate_gemini_table.py --list --pdf '.\.paperread-local-test\gemini-validation\inbox\<實際檔名>.pdf' --original-page 9
```

對原論文第 10、16、31 頁，分別替換檔名與 `--original-page`。不要將原論文頁碼傳成單頁 PDF 的擷取索引。

表格辨識成功後，使用者可依 [Gemini 驗證說明](gemini-table-validation.md) 手動執行單次真實驗證；本文件不預填模型、Table ID 或任何 Key。Mock 結果檢視入口為：

```powershell
powershell -NoProfile -File .\scripts\start_table_review.ps1 -Mode Mock -ReviewData GeminiValidation
```

此命令會啟動 Electron，僅供日後使用；本次禁止執行。既有較廣範圍背景另見 [模型驗證交接](table-model-validation-handoff.md) 與 [驗證安全約束](table-model-validation-safety.md)；本次任務的狀態與恢復順序以本文件及最新使用者指示為準。

## 停止點

本次僅提交本文件；完成 commit 與 Git 狀態確認後立即停止。下一次最優先工作是讀取本文件與 Git 狀態，然後唯讀確認四頁實際內容。尚無已確認的漏判原因、修正方案或真實翻譯結果。
