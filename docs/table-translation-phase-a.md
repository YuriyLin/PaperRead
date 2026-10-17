# 雙語表格：階段 A 交付紀錄

分支：`feature/bilingual-table-translation`。

本階段完成明確雙語資料的保存、基本表格呈現及既有閱讀模式整合。
**尚未實作 PDF 表格辨識、逐格翻譯、局部補譯或研究數據一致性驗證。**
現有論文不會自動轉換格式或重新翻譯。

## 環境

- 獨立 `.venv`：Python 3.13.15，`include-system-site-packages = false`。
  實際 `sys.path` 的 site-packages 只有專案 `.venv/Lib/site-packages`。
- 解譯器來自既有 docling 環境，但不繼承其已安裝套件；沒有改動全域 Python、
  Anaconda 或系統 PATH。
- 依 `pyproject.toml` 安裝相關測試需要的七項直接依賴：pypdfium2、pdfplumber、
  Pillow、pypdf、truststore、certifi、opencc-python-reimplemented，以及它們的間接依賴。
  未安裝 fastembed，未下載嵌入模型。`pip check` 通過。
- JavaScript 使用既有 Cursor 內附的 Node 24.18.1，沒有另行安裝 Node。
  專案沒有 Node engines 限制；CI 使用 Node 22、Python 3.10/3.12，仍須後續 CI 驗證。

## 修改檔案

| 檔案 | 用途 |
|---|---|
| `easyread/tables.py`（新增） | 雙語欄位、版本、矩形結構、逐格尺寸與註腳格式驗證 |
| `easyread/paperdata.py` | 接入驗證；同 ID 新版表格保留舊矩陣與來源中繼資料；不繼承缺省的舊雙語本體 |
| `easyread/checks.py` | 將雙語矩陣與註腳納入控制字元及 TeX 檢查 |
| `easyread/traditional.py` | 僅正規化明確的表格譯文，保留英文與語言不明的舊矩陣 |
| `easyread/web/js/reader/render.js` | 每種語言各自呈現完整題注、表頭、本體及註腳；不安全或缺譯時顯示 PDF 入口 |
| `easyread/web/js/reader/reading-language.js` | 沿用 mode/lead/biOrder，以整張表為單位移動與顯隱，不重建內容 |
| `easyread/web/js/reader/actions.js` | 讓既有逐塊展開原文操作適用於完整表格 |
| `easyread/web/js/reader/sentences.js` | 保持既有表題批註的中英文配對與 `id#caption` |
| `easyread/web/css/reader.css` | 整表顯隱、寬表格、換行與註腳樣式 |
| `easyread/web/i18n/en.json` | 新增格式錯誤及 PDF 退回說明的英文介面文字 |
| `tests/test_bilingual_tables.py`（新增） | 格式、保存、舊資料、閱讀進度、筆記、PDF 區域與離線輸出回歸測試 |
| `tests/test_table_modes.cjs`（新增） | 四種顯示方式、偏好獨立性、表題配對及逐塊展開測試 |
| `tests/test_table_render.cjs` | 擴充一般學術表格、缺譯、錯誤結構、複雜表格退回、HTML 安全及 KaTeX 測試 |
| `docs/data-format.md` | 格式及階段限制說明 |

## 測試結果

| 範圍 | 通過 | 失敗 | 跳過 |
|---|---:|---:|---:|
| 修改前相關 Python 基線（最終重跑） | 141 | 0 | 0 |
| 修改前全部既有 Node 單元測試 | 136 | 0 | 0 |
| 階段 A 相關 Python 回歸測試（最終重跑） | 155 | 0 | 0 |
| 階段 A 全部 Node 單元測試 | 148 | 0 | 0 |

Python 涵蓋表格、翻譯與續譯、語言、格式與 TeX、PDF 抽取與並行處理、
原文定位、批註、閱讀進度、設定遷移及 Obsidian 匯出。
後測另包含兩項既有 release i18n 測試，並新增 12 項 Python、12 項 Node 案例。
這不是全專案 Python 測試套件或真實論文翻譯的驗證。

本機測試執行器在匯入專案前指定隔離的 EASYREAD_HOME/EASYREAD_LIBRARY，
並阻擋未 Mock 的模型入口、CLI 子行程入口及 socket 連線；網路預檢也使用 Mock。
沒有呼叫 Gemini、Codex、Claude 或其他模型服務。

本機紀錄位於 Git 忽略的 `.paperread-local-test/`：

- `baseline-a-final/python.txt`、`baseline-a-final/python-summary.json`
- `baseline-a/node.txt`、`baseline-a/requirements.txt`
- `phase-a-final/python.txt`、`phase-a-final/python-summary.json`
- `phase-a-node-final.txt`
- `run_checks.py`：本機隔離測試執行器；`bin/node.cmd` 僅供本次命令程序尋找既有 Node。

`git diff --check` 通過。未修改任何正式文獻庫、Vault、API Key、模型或計費設定。

## 限制與相容性風險

1. Windows 的既有 `test_failed_batch_is_retried_then_skipped` 在修改前與後測都曾發生
   暫存 `paper.json` 並行讀取 PermissionError。單獨重跑及最終整組重跑通過。
   此問題沒有在階段 A 修正，後續仍應追蹤；保留失敗紀錄而非視為從未發生。
2. 第一版測試執行器阻擋了既有翻譯測試的網路預檢，產生一項環境隔離錯誤。
   將預檢改為 Mock 後消失，沒有開放模型呼叫或解除網路阻擋。
3. 此環境的瀏覽器工具沒有可連線瀏覽器，未完成實際瀏覽器目視驗證。
   自動化使用真實渲染／模式程式、模擬 DOM 與內附 KaTeX；離線 HTML 也已驗證可建立。
4. 一般欄列、描述統計、迴歸分析、相關矩陣及假設檢定表，僅在已提供明確結構化資料時可呈現。
   矩形多列表頭可呈現；非空的合併或跨頁結構資訊一律退回 PDF，沒有猜測或錯誤合併。
5. 舊格式仍可讀，但不會因為本次更新而顯示完整雙語表格。沒有將舊 `head/rows` 視為英文。
6. 表格本體批註與編輯、完整問 AI 表格脈絡、新增表格引用的匯出與跨頁精細定位仍待後續階段。
   既有表題操作及原有筆記／Obsidian 匯出回歸測試通過，不宣稱已完成階段 C。

## 暫停與下一階段交接

使用者已要求暫停開發。本機提交訊息為
`feat: add bilingual table rendering foundation`，不推送、不建立 Pull Request。
階段 A 最終測試沒有失敗或跳過項目；上列既有 Windows 並行檔案讀取問題仍是
已知待追蹤風險，不能宣稱已經修復。瀏覽器目視驗證也仍未完成。

保留現有 `.venv` 與 `.paperread-local-test/`，但兩者均由 Git 忽略，
不得加入提交。執行日誌、測試生成檔案、API Key、模型設定、文獻庫、
翻譯快取、Vault 與使用者資料均不納入本次提交。

階段 B 預定工作（尚未開始）：

1. 沿用原頁圖片、抽取文字與字元座標，辨識一般學術表格的英文欄列及註腳；
   優先支援描述統計、迴歸、相關矩陣與假設檢定，不可靠時保留 PDF 入口。
2. 接入既有翻譯引擎與提示詞，逐格補上繁體中文，不修改既有 Gemini Flash-Lite、
   API Key、模型、計費或使用者設定。測試只使用 Mock，禁止實際模型呼叫。
3. 保護數字、係數、標準誤、p 值、顯著性標記、公式與變數符號，
   在繁體正規化及術語處理後再次檢查逐格對應與不變內容。
4. 加入表格層級的來源雜湊、缺漏狀態及快取驗證，只辨識／補譯缺少的表格，
   不重跑已完成正文，不刪改舊矩陣、不猜測其語言，保留 ID、來源位置及讀者資料。
5. 沿用現有任務、儲存鎖、原子寫入與重試流程，測試取消、重啟、重複提交及
   來源變動，確保已完成表格不會被失敗或過期的回應覆蓋。
6. 為多層表頭、合併儲存格及跨頁表格建立辨識證據與結構驗證測試；
   沒有可靠證據時維持退回 PDF，不推測或錯誤串接。
7. 先確認分支與工作目錄，使用既有隔離測試環境重跑相關基線，再分步實作。
   階段 B 完成後回報檔案、測試、未完成項目與相容性風險，等待確認才進入階段 C。

階段 C 才處理表格本體批註、完整 PDF 定位、Obsidian／Markdown 引用匯出整合
及完整回歸驗證；不要因本次交接而提前開始。

即使額度已重置，也必須等待使用者重新啟動工作並明確下達階段 B 指令；
不排程、不自動恢復開發。
