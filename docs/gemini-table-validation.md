# 單次 Gemini 表格驗證與 Mock 閱讀器驗收

日期：2026-10-18。分支：`feature/bilingual-table-translation`。
起點：`f4e541ca3c3fc22c765a4af61a641973d827d585`；開始時工作目錄乾淨。

使用者已同意改以 Gemini API 做獨立小範圍驗證。本次只完成程式與 Mock 測試；
**沒有呼叫真實 Gemini API。真實請求須由使用者親自執行。**
Codex `RealModelValidation` 仍禁止啟動，一般 Mock 的所有模型 guard 保留。

## 功能範圍

- 固定新 profile：`.paperread-local-test/gemini-validation`，包含 `inbox`、`home`、`library`、`desktop`。
  不複製正式或舊 Mock 資料、設定、模型選擇、憑證或 Vault。
- 只讀使用者明確指定、位於 inbox 的一份未加密單頁 PDF（上限 20 MB）。
  不接受外部路徑、symlink、junction、reparse point 或硬連結；既有不明 profile 不覆寫。
- 先本機辨識並列出表格；每次只選一個 Table ID。無法可靠辨識者在要求 Key 前停止。
- 每次輸入 `SEND` 並提供 Key 後最多一次 HTTP 模型請求。無重試、修復請求、其他表格接續、
  持久任務、重啟續跑、聊天或背景翻譯。
- Key 透過 `getpass` 隱藏輸入；無安全隱藏輸入能力時停止，不退回明文輸入。
  不接受 Key 命令列參數、不讀環境中的 Key，不保存到環境變數、設定、任務、結果或日誌。
- 只送出指定表格待補的遮罩文字；不傳整份 PDF、圖片、檔案路徑、筆記、全文或其他表格。
  表格處理沿用 `table_translate.py` 的原文、逐格遮罩、繁體正規化、不變性驗證與原子保存。
- 結果閱讀器使用相同隔離庫，以 **Mock** 啟動；真實引擎為 `none`，模式切換與重新開啟只讀快取。
  停用匯入、模型設定寫入、翻譯／AI、研究／Vault、外部檔案匯出與資料夾選擇。
  保留四種閱讀模式、PDF 入口及原本的本機閱讀批註機制。

## Windows PowerShell 操作

使用專案已有 Python 虛擬環境與 Electron，不需新增 Gemini SDK。
以下真實請求命令由使用者決定何時親自執行；開發測試沒有執行這類真實請求。

### 1. 初始化專用環境

```powershell
Set-Location 'C:\Users\00818\Documents\PaperRead'
.\.venv\Scripts\python.exe .\scripts\validate_gemini_table.py --init
```

將你自行擷取、可提供給 Google 的單頁 PDF 放入：

```text
C:\Users\00818\Documents\PaperRead\.paperread-local-test\gemini-validation\inbox\page.pdf
```

不要放整篇論文或從正式文獻庫建立 linked PDF。程式不替你搜尋／擷取正式庫。
不清除或覆寫既有資料；正式庫與既有 `.paperread-local-test/desktop-review` 不由此流程使用。

### 2. 列出可驗證的表格（完全本機）

假設此測試頁來自原論文第 9 頁：

```powershell
.\.venv\Scripts\python.exe .\scripts\validate_gemini_table.py --list `
  --pdf '.\.paperread-local-test\gemini-validation\inbox\page.pdf' `
  --original-page 9
```

輸出例如 `table-p1-1 | test PDF p.1 | ready | Table 1: ...`。
這裡的 `ready` 是既有本機表格辨識狀態，**不代表已翻譯或已建立翻譯快取**。
若顯示 fallback／無法辨識，保留 PDF 查看入口，不猜測或要求 Key。

`--original-page` 是使用者提供的原論文頁碼，不會驗證原文件；不知道時省略，保存為 `null`。
同一 PDF 後續操作必須保持相同原頁碼與 inbox 檔名；不允許默默改寫既有引用來源。
閱讀器的 `p.1` 與 PDF 定位始終指測試 PDF 第 1 頁。標題另標原論文頁碼，兩者分開保存。

### 3. 使用者親自進行一次 Gemini 驗證

下例模型名稱參照 Google 目前相容介面文件；請明確選擇你帳戶可用的 Gemini 模型，
沒有自動取得模型清單、替換模型或供應商的行為。

```powershell
.\.venv\Scripts\python.exe .\scripts\validate_gemini_table.py --run `
  --mode GeminiValidation `
  --pdf '.\.paperread-local-test\gemini-validation\inbox\page.pdf' `
  --original-page 9 `
  --table 'table-p1-1' `
  --model 'gemini-3.8-flash'
```

以本機列出的實際 Table ID 取代範例。命令會顯示模型與選定表格，輸入 `SEND` 才取得該次授權，
接著在隱藏欄位輸入 Key。不輸入 `SEND`、取消、缺少模式／Table ID，均不送出請求。
API Key 不要放在 PowerShell 指令、變數、環境變數、檔案或對話中。

正常新翻譯輸出：`translated=1 cached=0 HTTP attempts=1`，以及 `paper=<id>` 與保存位置。
HTTP、JSON、數據或來源檢查失敗會停止，不標記翻譯完成，也不重送。原表矩陣與 PDF 保留。
HTTP 次數表示本機嘗試送出的次數；逾時不能證明 Google 未處理或未計費。

### 4. 開啟 Mock 結果閱讀器

先關閉同一 profile 已開啟的閱讀器，避免多個實例同時寫入閱讀偏好。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start_table_review.ps1 `
  -Mode Mock -ReviewData GeminiValidation
```

`-ExecutionPolicy Bypass` 僅作用於該 PowerShell 程序，不修改持久執行原則；
若本機允許 `.ps1`，可省略。此命令只初始化／開啟結果，不要求 Key、不呼叫 Gemini。
視窗標題為 `Gemini results / Mock — real models blocked`。

在庫中打開該論文，依序檢查英文、中文、雙語英文在前、雙語中文在前。
四種模式使用相同 table block／DOM；PDF 按鈕與表格頁碼開測試 PDF 第 1 頁。
中文語意品質需人工逐格核對，不能只以自動數據檢查通過判定。
原 Mock 啟動指令保持可用：`start_table_review.ps1 -Mode Mock`。

### 5. 確認持久快取

成功結果位於：

```text
.paperread-local-test/gemini-validation/library/<paper-id>/paper.json
```

保存的是既有雙語 `type=table` block，包含 `head_en/head_zh`、`rows_en/rows_zh`、
`caption_en/caption_zh`、`footnotes_en/footnotes_zh`，不是另存一份無法閱讀的 JSON 回應。

```powershell
$validationPaper = Get-Content -Raw -Encoding UTF8 `
  '.\.paperread-local-test\gemini-validation\library\<paper-id>\paper.json' | ConvertFrom-Json
$validationTable = $validationPaper.blocks | Where-Object { $_.id -eq 'table-p1-1' }
$validationTable | Select-Object id, page, table_status
$validationTable.table_cache | Format-List
$validationPaper.meta.validation_source | Format-List
```

快取包含 `source_hash`、`translation_hash`、`pdf_sha256`、`target=zh-TW`、`verified_at`；
額外 `validation` 記錄 Gemini 模型與首次請求次數，不含 Key。
再執行完全相同的驗證命令，通過來源／譯文核對後應輸出 `cached=1 HTTP attempts=0`，
不要求 `SEND` 或 Key。切換模式、重載與關閉重開閱讀器也不會送出請求。
表格補譯不會將正文的 `translation.done_pages` 改成全文已翻譯。

快取按既有來源／譯文雜湊判斷，不因換模型名稱而強制重送；此版沒有付費模型比較或強制重譯功能。

## 傳輸與資料限制

固定端點：`https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`。
使用既有 OpenAI 相容的訊息建構與回應讀取，實際供應商是 Google；不呼叫 OpenAI 或 Codex。
不提供自訂 URL、工具、MCP、函式執行、遠端圖片、繼承代理憑證或自訂 CA 檔路徑。
驗證傳輸拒絕重新導向、只接受 HTTP 200 與完整單一回答；90 秒逾時、回應上限 4 MB。

HTTP 邊界以程序內 Authorization 物件核對模式、profile、來源、模型、payload 與一次性額度。
計次有鎖，錯誤／並行呼叫也不能多送；一般模型 guard 未解除，GUI 無權建立此授權。
錯誤不輸出供應商 body、request headers 或例外 repr，回應若包含 Key 會丟棄。
回應經原有表格逐格／數據驗證後才原子保存，失敗不寫入新譯文或新快取。

不修改 Google 計費設定或選用服務 tier。既有專案可能收費；本程式不保證免費。
資料會送 Google，不應以獨立文獻庫當成資料留在本機的保證。
參考：[Google 相容介面](https://ai.google.dev/gemini-api/docs/openai)、
[計費](https://ai.google.dev/gemini-api/docs/billing)、[資料使用條款](https://ai.google.dev/gemini-api/terms)。

## 測試與交付證據

| 範圍 | 通過 | 失敗 | 跳過 |
| --- | ---: | ---: | ---: |
| 全專案 Python unittest discovery | 497 | 0 | 0 |
| 全部 `tests/test_*.cjs` Node | 172 | 0 | 0 |
| 實際 Windows Electron + 隔離後端 | 19 檢查點 | 0 | 0 |

新增 17 項 Python 測試涵蓋單頁、路徑／junction／硬連結、選表、模式／授權、
單次／並行額度、固定 URL、取消、HTTP／不完整／錯誤數據回應、Key 不落盤／不輸出、
原文及數值不變、原頁碼、保存與重開快取。沿用全部既有 Mock／Codex 阻擋與表格回歸。
Node 增加結果 profile／Electron 權限測試；四模式測試沿用現有閱讀器程式。

Electron 測試每次建立全新 `gemini-desktop-smoke-*` 合成庫，在最底層 HTTP 開啟處注入假回應，
產生真實雙語 table block 後開啟 Mock 閱讀器。驗證四模式、逐格數值、原頁碼、
重載／離開再開、快取位元組不變、拒絕真實功能、僅 loopback 與無 renderer 例外。
四模式截圖與合成 PDF 頁圖已目視確認。畫面中的「翻譯內容」是測試假譯文，不是真實語意品質證據。

第一次 Electron 執行因測試使用錯 token，及拒絕 POST 的 body 未消耗造成連線問題而失敗；
已使用真實 reader token，並在拒絕後關閉連線。最終 19 項通過，不把初次失敗算成成功。
PowerShell parser 為 0 errors。`--run` 未明確選 GeminiValidation 時已驗證拒絕。

```powershell
.\.venv\Scripts\python.exe scripts/run_regression.py
$validationNodeTests = (Get-ChildItem tests/test_*.cjs).FullName
.\.paperread-local-test\node-v22.20.0-win-x64\node.exe --test @validationNodeTests
.\.paperread-local-test\node-v22.20.0-win-x64\node.exe tests/gemini_desktop.cjs
git diff --check
```

Python harness 也封鎖新增的 `_validation_open`；正向測試必須明確換成假傳輸。
不執行可能選用正式文獻庫的舊 `tests/e2e.cjs`。
本機證據均忽略、不提交：`gemini-validation-final/python.txt`／`python-summary.json`、
`gemini-validation-node-final.txt`；Electron 最終證據位於
`.paperread-local-test/gemini-desktop-smoke-4190iixn/verification/summary.json` 與四模式 PNG。

## 修改與剩餘限制

- 新增 `easyread/gemini_validation.py`、`scripts/validate_gemini_table.py`：專用單次命令與資料／授權檢查。
- `http.py`、`openai_api.py`：固定 Gemini 單次傳輸；原一般 API 路徑保持。
- `table_translate.py`：只增加選表、假／受限傳輸與次數參數；原預設行為保持。
- `review_policy.py`、`server.py`、`electron/{main,test-profile}.cjs`、`start_table_review.ps1`：Mock 結果檢視限制。
- `tests/test_gemini_validation.py`、`tests/gemini_desktop*`、既有 Node 測試與 regression harness：測試及傳輸封鎖。
- 本文件、資料格式文件與交接連結：操作及交付說明。

不支援多頁 PDF、掃描／影像表格、合併格、跨頁拼接、表頭／註腳邊界不明及其他原辨識器不可靠的版型。
只有一頁且能可靠還原的矩形表格可進入翻譯；保留原有 PDF fallback。
單頁複雜表格即使可辨識，也可能超過模型輸出限制，遇截斷會停止，不分拆續跑。

應用層檢查不等同 OS 沙箱，不抵抗同權限惡意程序同時改檔或讀取程序記憶體。
此命令不載入可執行本機工具的模型代理；信任邊界是明確測試輸入及固定 HTTP payload。
尚未驗證真實 Gemini 回應／語意品質、frozen backend／打包 EXE、跨平台桌面或整個 App 程序重啟；
本次 Electron 覆蓋 renderer 重載與閱讀頁關閉重開，既有 Node 測試覆蓋 profile 重啟。
不新增套件、不修改全域環境或任何計費設定。

只建立本機 commit，不 push／PR。完成 Mock 驗證後停止，等待使用者親自操作真實請求。
