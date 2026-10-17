# 雙語表格：階段 C 交付紀錄

日期：2026-10-18。分支：`feature/bilingual-table-translation`。接續階段 B `0ad46c4`。

## 恢復與盤點

先執行 `git status --short --branch`、`git diff --stat` 及完整差異閱讀，確認保留的 22 個修改檔及
3 個未追蹤項目；閱讀階段 A、B 交付文件。未重新開始、回復版本、清除工作樹或刪除既有成果。

中斷時已存在：逐格 ID、PDF 幾何、選取／批註／AI 引用、雙語 Markdown 匯出初稿，以及測試 profile。
尚缺：中文格編輯（當時被明確停用）、階段 C 測試、完整回歸、實際 Electron 驗證及交付文件。
舊紀錄有英文詞條、NumPy 過早匯入、本機 Mock HTTP 被誤擋及舊 HTML 斷言數量等問題；均已修正並重跑。

未找到上次 PowerShell `ParserError` 的原始訊息，不能確定當時行號或根因。現有
`scripts/start_table_review.ps1` 已由 Windows PowerShell 語法解析器驗證，**0 個解析錯誤**。
本次 PowerShell 環境設定與隔離 Electron 啟動也已成功，未再出現 ParserError。

## 完成內容

- 英／中文表頭、資料格與註腳可選取、跨格選取、螢光筆、底線、批註及提問。
  相同格的雙語標記依 ID 配對；不以其他同值格代替定位失敗的引用。
- 中文格可雙擊或從選取工具列編輯，沿用草稿、個人修改、還原及過期提示。
  英文格唯讀；個人修改寫入 `reader.json`，不修改原表矩陣、數值或翻譯快取。
- 穩定欄列 ID 與英文來源指紋；來源改變後保留舊批註／個人修改並阻止錯誤套用。
  本機抽取保存逐格與註腳框；可信框可在原頁高亮，否則安全開原頁。
- 問 AI、拖曳引用、筆記追問及後端上下文保留 key／語言／指紋；表格上下文包含雙語表頭、整列與註腳。
  跨格引用上限與後端一致為 200，避免第 13 格之後被默默丟棄。
- Markdown 與既有 Obsidian Vault／ZIP 流程整合，附表號、原頁、Cell ID、雙語表格及個人修改。
  保留多列表頭、數值、標準誤與註腳；處理管線、HTML 及 TeX。
  Vault 重複匯出保留管理區外使用者內容、UTF-8 BOM 與既有 CRLF；管理標記重複時回報衝突。
- 四種模式保持完整表格與同一批 DOM：英文、中文、英文在前、中文在前。
  長中文可換行，寬表在可鍵盤聚焦的區域內水平捲動，頁面不被撐寬。
- 實際 Electron 測試發現 PDF 格高亮會被後續面板同步清除；已保留明確格定位跨面板重排／同步，
  並補單元回歸。過期引用的「只開原頁」也不會被舊段落框取代。

## 最終驗證

| 範圍 | 通過 | 失敗 | 跳過 |
|---|---:|---:|---:|
| 全專案 Python unittest discovery | 465 | 0 | 0 |
| 全部 `tests/test_*.cjs` Node 單元測試 | 162 | 0 | 0 |
| 實際 Windows Electron renderer＋本機後端 | 42 個檢查點 | 0 | 0 |

Python 測試內含的 Node 子測試不重複加總。`tests/e2e.cjs` 是需要 Playwright、會選用文獻庫的舊測試，
本次不執行；改用明確只接到隔離 Mock 文獻庫的 `tests/table_desktop.cjs`。

Electron 驗證使用本專案 Electron **44.5.1** 與既有 Python 3.13.15 虛擬環境。
單元回歸使用專案內下載的 Node **22.20.0**；沒有更動全域 Node／Python。
桌面 42 個檢查點包含三輪四種模式、選取與跨格筆記、英文字底線、中文編輯、來源變更、
PDF 格定位／退回、Mock 串流問 AI、Markdown、Vault 重複匯出、磁碟保存及實際 renderer 重載。
四種模式與 720px renderer 窄視窗的截圖已目視檢查：長中文換行，寬表出現內部捲軸，英文版內容完整。
窄視窗使用 Electron CDP viewport emulation，不宣稱測過實體手機。

原生 Computer Use 擷取先後遇到 `foreground window did not report a process id` 及
`Cannot call write after a stream was destroyed`。改以實際 Electron CDP 擷取 renderer，並使用本機影像工具檢視。
恢復原生工具時，工具回報使用者按 Escape 停止 Computer Use；隨即停止所有後續介面操作。
42 項 Electron 驗證與截圖均在中止前完成。未把原生工具失敗算作通過。

重現回歸（使用一般 Node PATH 亦可）：

```powershell
.venv/Scripts/python.exe scripts/run_regression.py
$nodeTests = (Get-ChildItem tests/test_*.cjs).FullName
.paperread-local-test/node-v22.20.0-win-x64/node.exe --test @nodeTests
git diff --check
```

`scripts/run_regression.py` 在載入測試前指定測試 HOME／LIBRARY，阻擋外部 DNS／socket、
未 Mock 的模型與模型 CLI；只放行本機假 HTTP 服務。兩個既有測試補上遺漏的預檢／搜尋 Mock。
測試中可見刻意製造的限流、壞回應、TLS 斷線等輸出，結果以 unittest summary 為準。

本機詳細證據（均忽略、不提交）：

- `.paperread-local-test/phase-c-final/python.txt`、`python-summary.json`
- `.paperread-local-test/phase-c-node-final.txt`
- `.paperread-local-test/desktop-review/verification/summary.json`
- 同目錄 `original.png`、`translation.png`、`english-first.png`、`chinese-first.png`、`narrow-desktop.png`
- `.paperread-local-test/desktop-review/library`、`home`、`desktop`、`vault` 為專用隔離資料。

## 三個原有未追蹤項目的決定

| 項目 | 用途及提交決定 |
|---|---|
| `electron/test-profile.cjs` | 正式的 opt-in 隔離功能，提交。使用絕對路徑，解析 junction，拒絕與預設正式／舊版資料位置重疊；停用資料搬移、協定註冊及更新，傳入專用 HOME／LIBRARY 與模型禁用旗標。 |
| `scripts/start_table_review.ps1` | 可重現的原始碼／未安裝測試版啟動器，提交。清除 `ELECTRON_RUN_AS_NODE`，結束時恢復環境；只允許 `dist/table-review` 下的封裝測試執行檔。 |
| `tests/fixtures/tables/` | 提交 README、來源 manifest 及固定三頁 NIST PDF（317,724 bytes）。不是翻譯快取或偶發測試產物；新測試驗證固定 SHA-256、原文數值及三頁的安全退回理由。 |

NIST fixture 保留來源、作者、頁碼對照及再利用聲明。三頁真實迴歸表因合併格／不明註腳採安全退回，
不宣稱成功還原。其餘下載原始 PDF、產生頁圖、Node／Electron 套件、測試庫、日誌、API 資料與建置產物均不提交。

## 修改檔案

| 類別 | 檔案 |
|---|---|
| 表格資料／幾何／快取 | `easyread/tables.py`、`table_extract.py`、`table_translate.py` |
| 模型上下文與隔離 | `easyread/chat.py`、`prompts.py`、`server.py`、`engines.py`、`config.py` |
| 持久化／Vault／延遲依賴 | `easyread/store.py`、`research/obsidian_export.py`、`research/index.py` |
| Reader | `easyread/web/js/reader/{anchor,chat,editor,margin,notespanel,pageview,render,sentences,store}.js` |
| 樣式／語系 | `easyread/web/css/reader.css`、`easyread/web/i18n/en.json` |
| Electron | `electron/main.cjs`、`electron/test-profile.cjs` |
| 工具 | `scripts/{prepare_table_review.py,run_regression.py,start_table_review.ps1}` |
| 新測試 | `tests/test_table_interactions.py`、`tests/test_table_profile.cjs`、`tests/table_desktop.cjs`、`tests/fixtures/tables/*` |
| 擴充回歸 | `tests/{test_consistency.py,test_research_v2.py,test_notes_export.cjs,test_pageview.cjs,test_reader_store.cjs,test_table_render.cjs}` |
| 文件 | 本文件、`docs/data-format.md` |

## Windows 桌面測試版啟動與建置

已驗證的是 **原始碼 Electron 桌面版**，尚未建置或驗證 frozen backend／打包 EXE。
目前 `.venv` 未裝 PyInstaller 與完整語意模型依賴；這不影響已完成的本機表格功能測試。

直接啟動隔離測試版（先有 Node 22+、本專案 Python 依賴及 Electron；`npm ci` 只安裝專案依賴）：

```powershell
npm ci
.venv/Scripts/python.exe scripts/prepare_table_review.py
powershell -NoProfile -File scripts/start_table_review.ps1
```

重跑實際 Electron smoke：在第一個 PowerShell 用 `-DebugPort 9339` 啟動上述腳本，
第二個 PowerShell 執行 `node tests/table_desktop.cjs`。該測試先檢查 Mock 論文及 offline engine，
「問 AI」使用 renderer 內 Mock 回應；其餘 HTTP 僅連 127.0.0.1。
請勿同時手動編輯同一隔離論文；smoke 使用固定 `desktop-smoke-*` 筆記 ID。

若要產生可攜式「未安裝」Windows 測試資料夾，以下為建置方式，本次沒有執行安裝依賴或封裝：

```powershell
.venv/Scripts/python.exe -m pip install . pyinstaller
npm ci
$env:PYTHON = (Resolve-Path .venv/Scripts/python.exe).Path
npm run build:backend
npx electron-builder --win --x64 --dir --config.directories.output=dist/table-review --publish never
.venv/Scripts/python.exe scripts/prepare_table_review.py
powershell -NoProfile -File scripts/start_table_review.ps1 -Executable dist/table-review/win-unpacked/PaperRead.exe
```

`--dir` 只產生 unpacked 檔案，不執行 NSIS 安裝程式。測試啟動必須透過隔離腳本。
打包產物的 frozen backend smoke 可另執行 `scripts/smoke_backend.py`，本次未宣稱驗證該產物。

## 剩餘限制與交付邊界

沒有已知失敗的 Python／Node 回歸或未完成的階段 C 表格互動項目。
合併格、跨頁／掃描表格、無可靠來源框仍採 PDF 退回；不宣稱所有期刊表格可還原。
未呼叫 Gemini 或其他模型 API，因此不評估真實模型語意品質；未驗證 frozen EXE、實體窄視窗拖曳或手機。
使用者 Escape 中止後未再進行原生／CDP 介面操作。

只建立本機 Git commit，不 push、不建立 PR、不安裝或覆蓋正式 PaperRead。
正式文獻庫、Obsidian Vault、API Key、模型與計費設定未修改。交付後停止，等待驗收。
