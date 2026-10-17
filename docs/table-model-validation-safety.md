# 模型驗證隔離：安全修補交付

日期：2026-10-18。分支：`feature/bilingual-table-translation`。
恢復起點：`598c90e63c65aeaa59c86551f8c5859f07f1bb7c`，工作目錄乾淨。
已讀取原交接及階段 A／B／C 文件，確認 `7792ac1` 設定保存修正仍在歷史；沒有回退或重新實作表格功能。
本次使用者已明確授權繼續開發、Mock 回歸及本機提交，取代原交接的「待確認／暫停」要求。

## 結論與安全閘門

**雙模式的正向真實翻譯尚未完成；RealModelValidation 保持禁止啟動。**
本次完成 Mock 防護及真實模式的拒絕入口，沒有建立能進行真實推論的 runner。
選擇真實模式、修改設定、HTTP `confirmed` 或把離線環境變數改為 `0` 均不能取得模型權限。

核對結果：

- 本次 shell 的 `Get-Command codex*` 沒有結果。因此沒有取得可測試的 CLI 版本／路徑，
  也沒有驗證登入類型、實際 provider、工具清單或 OS 讀取限制。
  這不表示 Codex 桌面應用程式未登入，也不能以目前開發工作階段的權限推論另一個子程序的權限。
- 現有 `_codex_once()` 是一般用途 runner：`--sandbox read-only`、`--ephemeral`，
  仍會繼承設定並接受 `extra_args`；`run_codex()` 會在不相容時移除 lean 覆寫重試。
  它不能作為本需求已驗證的正式資料讀取邊界，不能接到真實驗證模式。
- 官方 Windows 文件說明不同 sandbox 的能力與前置條件；較新的實作／設定能力
  不代表本機已安裝版本及其執行環境已符合要求。尤其不能只憑 `read-only`、cwd 或 prompt 保證不可讀正式資料。
- 未執行 Codex `exec`、登入、模型請求、sandbox provisioning 或任何權限升級探測；
  未讀出憑證、複製 CLI 設定或新增 API Key／付費設定。

官方核對來源：[Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox)、
[CLI developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli)。
這些資料只用於能力評估，沒有當成本機隔離驗證通過的證據。

## 已完成

1. `review_policy.py` 集中判斷隔離狀態。任何測試 profile、review mode 或原離線旗標
   都會封鎖模型；真實模式及未知模式一律拒絕，沒有可保存的允許開關。
2. 模型總入口、CLI 底層 `_popen`／`_codex_once`、各引擎、聊天串流與 API transport
   都有防護。一般頁面翻譯在讀取論文及網路預檢前先拒絕；表格翻譯繼續走受保護的既有引擎。
   沒有新增可繞過 regression harness 的模型 subprocess 入口。
3. 隔離模式不執行啟動偵測、版本偵測、Claude probe、Ollama 探測，
   也不讀取使用者的 Codex／Claude 模型設定與模型清單。保存的 PaperRead 模型選擇仍保留，
   不以未偵測到 CLI 作為自動切換 Claude 的理由。
4. 文獻庫位置查詢不搜尋外部候選庫；隔離模式拒絕 inspect、cleanup、move、pick-folder 及 reveal。
   profile 下的設定、文獻庫、Workspace 與 linked PDF 入口驗證 canonical path。
5. Vault 新設定、既存偏好與 Markdown 路徑都加入 profile 內的路徑檢查，
   新設定會在 mkdir／保存前檢查。測試 profile 的 home／library／desktop／vault 若導向外部 junction，啟動即拒絕。
6. 隔離模式重啟不恢復 queued／running 工作：改成 cancelled，保留任務頁碼、部分完成結果與其他欄位，
   使用者可重新選頁提交，避免殘留 busy 狀態。正式模式的原有續跑行為不變。
7. 閱讀器「只補譯表格」先要求 PDF 頁碼，傳送 `pages + tables_only`；取消／留白不送出。
   隔離 HTTP 翻譯入口也拒絕未明確指定頁碼的請求，不能透過重試／確認擴大成全文。
8. 啟動器新增 `-Mode`，預設 Mock。RealModelValidation 在建立資料、查找執行檔或啟動程序前即拒絕。
   Electron 也獨立拒絕真實／未知模式；有 mode 卻沒有 profile 亦拒絕。
   Python 後端直接啟動也會在寫入日誌或載入設定前拒絕真實模式及缺少／不符的 profile。
   Mock 模式傳遞固定 profile／離線旗標；設定頁及視窗標題明確顯示禁止真實模型。
9. `engine=none` 在隔離設定頁不再被舊相容邏輯改成 Claude；既有 Codex 選擇與持久化測試保留。
   模式狀態由後端即時產生，保存的 `review_policy` 不能偽造授權。

四種閱讀模式、PDF 定位、儲存格批註／個人編輯、表格局部補譯與快取、Markdown／Vault 整合
均沿用階段 A／B／C 實作，由既有回歸覆蓋；未重新生成使用者內容或重跑既有翻譯。

## 操作方式

Mock 使用既有隔離資料，不需重跑會更新合成論文的 prepare 腳本：

```powershell
powershell -NoProfile -File .\scripts\start_table_review.ps1 -Mode Mock
```

本機若以執行原則禁止 `.ps1`，可在允許的開發環境以程序範圍執行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start_table_review.ps1 -Mode Mock
```

此參數不改機器／使用者的持久執行原則。程式使用 `.paperread-local-test/desktop-review`；
不安裝或覆蓋正式 PaperRead。設定中可保留／選擇 Codex 模型，但所有模型請求仍被禁止。
隔離庫「只補譯表格」需填入例如 `9` 或 `3,5-7`；沒有合適原頁的請求仍會失敗。
本次測試只用合成／既有 fixture 與假傳輸，不對使用者測試庫發出翻譯請求。

```powershell
# 預期失敗：回報隔離尚未驗證，不會啟動 GUI 或模型。
powershell -NoProfile -File .\scripts\start_table_review.ps1 -Mode RealModelValidation
```

不提供刪除離線旗標、改用 API、切換供應商、設定 fast tier 或移除工具限制的繞過方式。

## 驗證

| 範圍 | 通過 | 失敗 | 跳過 |
| --- | ---: | ---: | ---: |
| 修改前既有局部 Python | 88 | 0 | 0 |
| 修改前既有局部 Node | 17 | 0 | 0 |
| 完整 Python unittest discovery | 480 | 0 | 0 |
| 全部 `tests/test_*.cjs` Node | 170 | 0 | 0 |

完整結果以最終重跑為準。包含新 policy 的 13 項 Python 測試及既有表格、模型設定、
任務／頁碼、Vault、PDF、四模式等回歸。Python 內含的 Node 子測試不重複加總。
不執行舊 `tests/e2e.cjs`，未啟動 Electron 或進行本次 renderer 目視／EXE 封裝驗證。

PowerShell parser：0 errors。實際執行 RealModelValidation 拒絕路徑，
確認錯誤是 policy 訊息而非找不到執行檔，沒有啟動模型／GUI。
第一次使用系統預設執行原則時腳本本身遭阻擋，不把該次當成模式防護通過；
後以程序範圍 `-ExecutionPolicy Bypass` 重跑並確認特定拒絕訊息。

開發中的首次 policy 測試有 3 個 subtest 失敗：原 harness 已替換 `_popen`，
斷言看到的是 harness 的 AssertionError，未觸及生產 guard。已改為子 Python 程序內
先以 fake `subprocess.Popen` 封鎖傳輸，再測真實 `_popen` 防護；沒有解除 harness 的 CLI／網路封鎖。

測試命令：

```powershell
.\.venv\Scripts\python.exe scripts/run_regression.py
$nodeTests = (Get-ChildItem tests/test_*.cjs).FullName
.\.paperread-local-test\node-v22.20.0-win-x64\node.exe --test @nodeTests
git diff --check
```

本次 Python 日誌：`.paperread-local-test/model-validation-final/python.txt`、`python-summary.json`；
Node：`.paperread-local-test/model-validation-node-final.txt`。均不提交。
首輪基線沿用原 harness，因此舊 `phase-c-final` 日誌現在是 88 項局部基線；
上次 70 項的原日誌已被原執行器覆寫，其結果僅可追溯原交接文字，不能再宣稱該目錄保有上次原始證據。
後續本次測試已改用新的目錄，與階段 C 的歷史交付數字分開。

## 剩餘限制與後續工作

- **沒有真實模型正向放行測試，也沒有真實中文語意品質測量。**
  不把 fake transport／路徑測試通過稱為 Codex sandbox 或登入來源驗證通過。
- 尚缺：選定且可驗證的 CLI 路徑／版本、既有登入的身分與 provider 限制、禁止 API Key／付費 fallback、
  工具／MCP／hooks／notify／繼承設定隔離，以及 OS 層正式庫／Vault 不可讀的負向探測證據。
  沒有建立第二個可推論的 profile、沒有複製模型設定或測試資料到真實驗證環境。
- 這次 canonical path 檢查屬應用層防護；不是全面檔案系統沙箱，
  不保證抵抗其他本機程序同時替換路徑，也沒有審核所有任意檔案入口。
  如需可證明的隔離，須另行評估 OS sandbox 或不掛載正式資料的專用執行環境，
  並先使用合成 canary 與假傳輸驗證，不能先放行真實請求來試錯。
- 一般正式模式 runner 的相容性 fallback 保留供原功能使用；任何未來驗證 runner 都不得重用它作為安全邊界。
- 登入狀態、CLI 可用性及服務費用來源本次均未推定；不安裝依賴、不修改全域環境、憑證或正式資料。

只建立本機 commit，不 push／PR。真實驗證工作停在安全閘門；後續先補足上述證據，再設計最小權限 runner。
