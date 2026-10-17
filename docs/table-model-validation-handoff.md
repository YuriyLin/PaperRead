# Mock／真實模型驗證模式交接

## Gemini 單次驗證已交付

使用者於後續明確同意 Gemini 替代方案，已從 `f4e541c` 完成
[單次 Gemini 表格驗證與 Mock 閱讀器驗收](gemini-table-validation.md)。
Python 497、Node 172、實際 Electron 19 檢查點通過；全部使用假傳輸，沒有真實 Gemini 請求。
這是獨立的單頁／單表／單次命令，不解除 Mock 或 Codex `RealModelValidation` 的阻擋。
最新操作及限制以新文件為準；以下保留歷史交接。

## 2026-10-18 恢復後狀態

已依使用者新指示恢復開發，核對起點 `598c90e`、乾淨工作目錄及階段 A／B／C 原始碼。
本次完成 Mock 安全修補、指定頁表格操作、模式標示及真實模式的 fail-closed 拒絕入口。
**RealModelValidation 仍禁止啟動，沒有真實模型放行。** 本機 CLI 的工具／讀取範圍／登入 provider
隔離無法驗證，沒有降低標準或改接一般 runner。

最新功能、測試、操作與未完成工作見 [安全修補交付](table-model-validation-safety.md)。
以下為上次暫停時的歷史交接，不代表目前仍須重新詢問開發授權，也不能把提案當成已放行功能。

更新：2026-10-18（Asia/Taipei）。本次因 Codex 五小時額度約剩 8%，依使用者要求暫停開發並保存進度。

## 恢復時先讀

- 專案：`C:\Users\00818\Documents\PaperRead`。
- 分支：`feature/bilingual-table-translation`。
- 本次保存前 HEAD：`7792ac1a3372ae7c6a51c58d102a53121b31455b`。
- 保存前工作目錄乾淨，無 staged、unstaged 或未追蹤變更。本次只新增此文件，準備建立本機文件 commit；保存後 commit 以 `git rev-parse HEAD` 為準。
- RealModelValidation **尚未實作**。前一輪僅完成唯讀調查與方案提出，使用者尚未確認實作方案；本次保存請求不是開發或真實翻譯授權。
- 本次不執行模型、不啟動 Electron、不執行測試、不安裝依賴、不 push、不建立 PR。完成保存後停止。

## 已完成成果與目前檔案狀態

| 成果 | Commit／狀態 |
| --- | --- |
| 階段 A：雙語表格資料結構、四種閱讀模式 | `65344dd`，已提交 |
| 階段 B：PDF 表格辨識、逐格翻譯、局部補譯、快取 | `0ad46c4`，已提交 |
| 階段 C：儲存格批註、PDF 定位、Obsidian 整合、隔離 Electron 測試 | `55e6b90`，已提交 |
| 隔離桌面模型設定保存修正 | `7792ac1`，已提交 |
| Mock／RealModelValidation 分離 | 已調查、方案待確認，無功能程式碼修改 |
| 工作保存 | 本文件；本次唯一新增檔案 |

`7792ac1` 修改：`easyread/config.py`、`tests/test_desktop.cjs`、
`tests/test_model_settings_persistence.py`、`tests/test_model_settings_persistence.cjs`、
`tests/test_table_interactions.py`。不可回退到階段 C 而丟失此修正。

相關交付文件：`docs/table-translation-phase-a.md`、`docs/table-translation-phase-b.md`、
`docs/table-translation-phase-c.md`。

## 本次需求與不可改變的規則

1. Mock 保持預設，禁止真實模型呼叫；保留既有離線安全限制，不改成無限制環境。
2. 另提供使用者明確選擇的 RealModelValidation，只透過已登入 Codex CLI 驗證。
3. 設定、PaperRead 文獻庫、Electron userData、測試資料及測試 Vault 均須獨立於正式環境。
4. 不存取或修改正式文獻庫與正式 Obsidian Vault；不搬移正式資料或匯入正式設定。
5. 不自動使用 OpenAI API Key，不自動登入、不寫入登入憑證、不啟用額外付費設定或自動選用加速層級。
6. 保留既有翻譯模型選擇，不能自動退回 Claude Code；不能以 API 或 Claude 作為失敗替代方案。
7. 優先支援指定頁面、指定頁面的「只補譯表格」，不自動整篇翻譯。
8. 清楚標示模式；新增完全以假傳輸執行的權限、隔離與模型設定回歸測試。
9. 不提交 `.venv`、測試日誌、暫存、使用者資料、API Key、登入憑證；不使用 `git reset --hard` 或 `git clean -fd`。

## 第 9 頁失敗的根本原因

目前流程：

```text
scripts/start_table_review.ps1
  -> PAPERREAD_TEST_PROFILE=.paperread-local-test/desktop-review
  -> electron/test-profile.cjs
  -> EASYREAD_HOME=<profile>/home、EASYREAD_LIBRARY=<profile>/library
  -> PAPERREAD_OFFLINE_TEST=1
  -> easyread/engines.py:run 拒絕模型傳輸
  -> job.json 保存 partial／failed，再由介面顯示第 9 頁錯誤
```

- `easyread/engines.py:run` 及 `easyread/chat.py:stream` 均有離線阻擋。
- 前一輪唯讀檢查確認：隔離庫內該任務頁碼 `[9]`、`tables_only=false`，錯誤為「隔離測試模式禁止呼叫模型。」；日誌有兩次相同失敗。
- 隔離設定已保存 `engine=codex`、`codex.model=gpt-6.1-sol`、`auto_translate=false`；reasoning effort／service tier 為空。這是測試設定觀察，不是正式設定，也不是要求固定此模型。
- 因此，這次錯誤是 Mock 限制生效；不能據此判定 PDF 解析或 Codex 模型故障。
- 調查期間未呼叫真實模型、未讀取憑證或正式設定，也未修改測試設定與資料。

## 模型選擇返回 Claude 的問題

- 階段 C 原本在 `config.load()` 的離線分支強制設成 `engine=none` 並清空 chat 名單。
- `7792ac1` 已移除此執行期覆寫，保留保存的模型與 chat 選擇；離線分支仍關閉自動翻譯與更新，模型阻擋不變。
- 已有 Python／Node 設定保存、關閉重開、重啟、寫入失敗及離線阻擋測試。
- 仍存在另一個邊界：`easyread/web/js/common/settings-chat.js` 把 `engine=none` 轉成 `claude` 的舊相容邏輯；`config.DEFAULTS` 也預設 Claude。
- 真實驗證初始化及 UI 必須避免這個邊界。保存的非 Codex 引擎應顯示不允許並等待使用者選擇，不能偷偷切換。不要把已修復的設定持久化問題與尚未實作的模型放行混為一談。

## 已發現的安全與行為缺口

1. **偵測旁路**：`launch.py` 呼叫 `detect.warm()`；`detect._refresh()` 可呼叫
   `cli_models.probe_claude()`／`_probe()`，後者直接經 `engines._popen()` 啟動 Claude 並寫入 `.`。
   註解意圖是在 init 後終止、不使用 token，但未經離線 guard，不能依此保證無模型請求。
   這是程式碼可達路徑，不是已證實發生真實請求。隔離模式須停用或在底層補上不可繞過的限制。
2. **預檢順序**：`translate.translate_pages()` 在一般 `engines.run()` guard 前呼叫 `netcheck.problem()`。
   必須先檢查模式與授權，避免 Mock 先做外部網路預檢。
3. **Vault 路徑**：`research/store.py:set_vault()` 可接受外部位置，且驗證前就有 mkdir；
   `vault_path()` 會採用保存的偏好。隔離檢查應在讀寫／建目錄前執行，同時處理既存偏好。
4. **文獻庫偵測**：`library_api.py:location()` 會搜尋外部候選庫。即使臨時文獻庫已禁止搬移，仍須防止隔離模式偵測或讀取正式庫。
5. **自動續跑**：`Jobs._resume()` 恢復 queued／running 任務；真實驗證模式不得在啟動後自動恢復模型任務。
6. **表格範圍**：後端 `translate_api.enqueue()` 已支援 pages + tables_only；目前 reader 的
   `actions.js`「只補譯表格」按鈕只傳 `{tables_only:true}`，會採所有頁面，須補明確選頁。
7. **Codex 設定降級**：`run_codex()` 在 lean 覆寫不被接受時會移除覆寫重試；驗證模式不能因相容性重試而重新啟用 MCP／工具／notify。
   表格補譯呼叫也須確認完整套用受限 runner，不能只保護一般頁面翻譯。

## 擬議最小方案（待使用者確認）

| 模式 | Profile | 模型規則 |
| --- | --- | --- |
| Mock（預設） | `.paperread-local-test/desktop-review` | 原離線 guard 保持；真實模型全部阻擋 |
| RealModelValidation（明確 opt-in） | `.paperread-local-test/desktop-model-validation` | 獨立受限 Codex 入口；只接受已授權的明確頁面／表格任務 |

- 啟動腳本擬新增 ValidateSet 模式參數，預設 Mock；未知值拒絕啟動，結束後還原環境。
- 不以刪除 `PAPERREAD_OFFLINE_TEST`、設成 0 或略過所有安全限制完成放行。
  新增受限驗證入口／policy，保留既有一般模型入口阻擋；具體 runner 注入方式尚未定案。
- 每次啟動均需明確選擇真實模式；設定檔、上次選擇、重新啟動或 HTTP body 不能自行形成永久授權。
- 啟動只開隔離介面，不啟動翻譯。使用者之後必須選頁與操作；一般聊天、研究 AI、設定測試等入口不得順便取得廣泛模型權限。
- 新 profile 可從明確允許的既有隔離測試來源取測試 PDF、必要的模型設定白名單；不整份複製偏好、憑證、正式設定或個人批註。不覆寫既有 Mock 資料。
- 設定、文獻庫、Vault、工作目錄、PDF 與圖片須驗證 canonical path；拒絕 junction／symlink 逃逸及未知路徑。路徑檢查在任何存取前執行。
- 兩種模式均關閉自動翻譯、更新及會越界的偵測；保持安裝／協定註冊／正式資料搬移不啟用。
- UI、視窗與啟動訊息持續顯示模式、是否允許真實 Codex 翻譯及目前翻譯模型。

### Codex CLI 權限與檔案讀取隔離

- 現有 `_codex_once()` 使用 `--sandbox read-only`、`--ephemeral`，但 read-only 只限制寫入，**不能證明正式資料不可讀**。
- 重用已登入身分不代表可匯入所有 Codex provider、API Key、extra_args、MCP、hooks 或付費 tier。
  不能只清除環境中的 API Key 就宣稱完全使用登入額度。
- 下一階段須先確認 CLI 可用的登入驗證、provider／憑證來源限制、工具禁用與檔案讀取隔離能力，並處理繼承設定與 extra_args。
  不讀出或輸出憑證內容，不修改使用者 Codex 設定；不新增登入或付費流程。
- 模型 prompt、cwd、附件只包含明確測試來源。必須能阻止模型工具讀取正式庫與 Vault；能力不足時拒絕放行，不能以 prompt 承諾代替隔離。
- 僅使用既有登入所需的身分驗證，與 PaperRead 正式資料隔離分開處理。CLI 實際限制尚未驗證，不得宣稱現已達成。

## 測試證據與未驗證項目

- 階段 C 文件記錄：Python 465 通過、Node 162 通過、Windows Electron 42 檢查點通過；屬於階段 C 歷史結果，不是本次重跑結果。
- 保存時讀取既有 `.paperread-local-test/phase-c-final/python-summary.json`：70 tests、0 failures、0 errors、0 skipped。
  同目錄 `python.txt`（2026-10-18 00:56）以模型設定保存測試開頭，結尾為 `Ran 70 tests ... OK`。
  這是先前局部回歸證據，不能當作 HEAD 全專案回歸或新模式測試。
- `7792ac1` 包含模型設定與 desktop 重啟的 Node 測試，本次未重跑，不推定目前完整測試數或結果。
- 本次只做 Git、程式碼與既有測試紀錄檢查；交接文件提交前執行 `git diff --check`，結果以本次完成回報為準。
- 第 9 頁真實翻譯失敗的已知原因是 Mock guard；沒有新模式測試失敗，因為新模式尚不存在。
- 未驗證：新 mode 參數、受限 runner、CLI 登入與讀取隔離、API／額外計費阻擋、工具關閉、外部路徑拒絕、自動續跑禁止、新 UI、真實論文語意品質、frozen backend／打包 EXE。
- 真實模型翻譯本次與前一輪均未執行。新模式的正向放行測試也應先使用 fake subprocess／transport。

## 下一次工作階段優先步驟

1. 閱讀本文件，執行下列 Git 盤點；保留所有新出現的修改。確認 `7792ac1` 及本交接 commit 均在分支歷史。
2. 先向使用者確認是否依擬議方案實作；未確認前只作必要唯讀核對，不開始大型開發或真實模型驗證。
3. 先釐清 CLI 的登入／provider／工具與讀取隔離能力。若不能滿足「不得讀取正式資料」，先呈現具體限制與可行隔離方案，不先解除 guard。
4. 先寫 fake transport 的模式權限與路徑測試，再實作最小 policy、launcher／profile、資料限制及模式標示。
5. 沿用既有指定頁面與 tables_only 流程，補選頁 UI；禁止自動續跑與未指定頁碼的擴大翻譯，修正上述旁路。
6. 驗證模型保存、非 Codex 拒絕、無 API Key／付費 fallback、外部路徑與 junction 阻擋。
   確認測試 harness 不會讓新增的 Codex runner 繞過原本的 `_popen`／網路阻擋。
7. 局部測試通過後視額度跑完整回歸。使用者再次明確啟用真實模式與指定任務後，才做小範圍真實驗證；不直接啟動整篇翻譯。

### 恢復與測試指令（本次未執行測試）

```powershell
Set-Location C:\Users\00818\Documents\PaperRead
git branch --show-current
git rev-parse HEAD
git status --short --branch
git diff --stat
git diff --cached --stat
git log -5 --oneline

# 先跑既有局部回歸：使用隔離 harness，不能直接對正式庫啟動後端。
.\.venv\Scripts\python.exe scripts/run_regression.py tests.test_model_settings_persistence tests.test_table_interactions tests.test_table_translation tests.test_page_cap
.\.paperread-local-test\node-v22.20.0-win-x64\node.exe --test tests/test_table_profile.cjs tests/test_desktop.cjs tests/test_model_settings_persistence.cjs tests/test_codex_translation_options.cjs
git diff --check

# 新模式測試須另新增；完成開發且額度允許時才做全回歸。
.\.venv\Scripts\python.exe scripts/run_regression.py
$nodeTests = (Get-ChildItem tests/test_*.cjs).FullName
.\.paperread-local-test\node-v22.20.0-win-x64\node.exe --test @nodeTests
```

`scripts/run_regression.py` 會覆寫忽略目錄中的局部測試紀錄；必要時先保存上一輪證據到另一個忽略目錄。
新增真實驗證 runner 的測試需要同步擴充 harness 的 fake transport 防線，不能為了測試改成允許真實 CLI。
不要直接套用舊 `tests/table_desktop.cjs`：它目前要求 `engine=none`，與保存 Codex 選擇的新基線可能不相符，須先核對。

### 啟動指令狀態

```powershell
# 現有預設 Mock 啟動方式；已知偵測旁路補齊前，本交接不建議為驗證而直接啟動。
powershell -NoProfile -File .\scripts\start_table_review.ps1

# 僅為提案；目前腳本沒有 -Mode 參數，不可當成現成功能執行。
powershell -NoProfile -File .\scripts\start_table_review.ps1 -Mode RealModelValidation
```

擬議使用者操作沿用 `/api/p/<test-id>/translate`，一般頁面 body 為
`{"pages":"9"}`；只補表格為 `{"pages":"9","tables_only":true}`。
這些 body 不是模型權限，後端仍須通過模式、身分、資料路徑與明確操作驗證。

## 保存與提交邊界

本次只將本文件加入本機 commit；不修改功能程式碼、測試資料或已提交成果，不提交任何忽略檔。
若 commit 因檔案權限或其他原因無法完成，保留本文件於工作目錄並回報，不清除或回退。
完成後停止，等待使用者下一次啟動 Codex。
