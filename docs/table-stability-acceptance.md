# 表格功能穩定性驗收（2026-10-18）

**NO-GO：不應以目前預設啟用實驗性表格擷取的狀態發版。**普通正文誤接受已被最小防護攔截；沒有 continued 標記的跨頁表仍可能只接受第一頁，列為發版阻礙。沒有以單篇 PDF 成功或測試數量作為發版標準。

本輪沿用 P0 的26案 regression 與獨立逐格驗證；W3C holdout 仍封存，未用來調參。原始 PDF、truth、P0 觀測快照均不更新。既有未提交修改及備份保留。未操作正式文獻庫、Vault、安裝版或真實模型，也未 Commit／Push／Merge。

## 兩項不安全接受

### 普通正文

證據案例是 natural_prose_captioned。其 Table 標題後接普通句子與年份，text-strategy 從重複的字詞位置推導出9欄；第一列甚至變成 `This ann / ual / repo / rt / ...`。原始字元都在、各資料列也有數字，因而通過 Counter、coverage 和統計列條件。

共同機制是「Caption＋含數字列＋推測對齊」不足以證明表格，亦沒有要求推測欄界保留來源詞彙的完整性。這不是對所有正文誤判的完整解法；三欄排列的句子仍有語意模糊案例，持續獨立列出。

最小修正只在 `_matrix(method='text')` 加入來源單字完整性防護：以既有相同容差的 source words 與 PDF glyph 中心位置，檢查一個原始單字是否被推測格線分配到多個 cell。若被切開，拒絕並 fallback，理由為 `Borderless grid splits a source word`。

不依賴特定字詞、年份、欄數、PDF 身份或座標。未放寬 Counter、數字、coverage、來源唯一性、Caption 或跨頁條件。新拒絕理由不在 reading 補譯允許清單，因此不會用另一種閱讀文字補譯繞過拒絕；整合測試確認模型與 reading recognizer 均未被呼叫。

### 未標記跨頁表

continued_unlabelled 的第一頁為完整矩形表，次頁還有 Delta/Epsilon/Zeta 資料，但標題僅為 Further results。`extract_page` 只看到當頁，`recognize` 只檢查次頁的同號 Table／continued 字詞，因此沒有證據觸發拒絕。逐格 provenance 可以證明第一頁文字忠於該頁，不能證明整張邏輯表已完整。

本輪沒有加「下一頁像同欄寬」「相同字型」「頁碼相鄰」等特例。這些特徵也常見於獨立表格或其他正文，現有資料不足以安全決定延續關係。不能宣稱此問題已 fallback；**目前啟用模式仍會誤接受，明確列為發版阻礙**。既有明示 continued／已知跨頁 metadata 的拒絕繼續有效。

## 固定基準結果

| 結果 | P0 | 本輪啟用模式 |
|---|---:|---:|
| 精確接受 | 7 | 7 |
| FN | 9 | 9 |
| 非表格 FP | 1 | 0 |
| 結構不完整誤接受 | 1 | 1 |
| 正確 fallback | 5 | 5 |
| 正確拒絕 | 2 | 3 |
| 模糊接受 | 1 | 1 |
| 真正表格已接受但儲存格錯位 | 0 | 0 |

七個正例的英文表頭／資料矩陣逐格相同；cell-level 原型結果也維持原來的5個原始幾何通過、2個無框線幾何過度保守拒絕，投影到固定標註區域後7個文字歸屬均通過。這不是新放寬，也不把投影結果當作原 boxes 驗證成功。

只有 natural_prose_captioned 的觀測發生預期變動，其他25案不變。P0 原觀測沒有重新產生；`--check-baseline` 因這個已記錄的改善回傳1，測試明確核對變動範圍只限此案例，而非把基準洗成全綠。品質閘門 `--fail-on-unsafe` 仍回傳2，對應尚未解決的跨頁誤接受。

## 新舊論文相容性

新增 `tests/test_table_stability.py`，每案在工作目錄下獨立 TemporaryDirectory 中建立 profile/home/library。應用程式 path policy 限制這些資料夾；設定檔路徑亦切換至測試 profile。模型 run／CLI 與網路連線被阻擋，只傳入明確 fake response。故意中斷的子程序只處理這份測試資料。

| 情境 | 測試與結果 |
|---|---|
| 新匯入無表格 PDF | 實際 Library.create_from_pdf 與 table-only pipeline；沒有新增表格，fake runner 呼叫0次，原始 bytes 保留 |
| 新匯入有框線／無框線表 | 兩種既有固定 PDF 均完成假回應補譯；原 PDF 不改寫 |
| 含 Table 標題的普通正文 | 產出明確 fallback，沒有儲存新矩陣，未呼叫 reading/model |
| 掃描式 PDF | 以圖像建立無文字層 PDF；沒有偽造矩陣、沒有模型／OCR呼叫；基本 PDF 文字擷取回空字串，原文保留 |
| 損壞 PDF | 非 PDF signature 先拒絕；帶 signature 但物件損壞的 PDF 在解析時失敗；該檔原文與 JSON、設定、其他論文不變 |
| 無法解析 PDF | 密碼保護且未提供密碼的 PDF 解析失敗；資料保留、未呼叫模型。未宣稱覆蓋所有 PDF parser 故障 |
| 既有已翻譯論文重開 | 從隔離 library 重新取得 Workspace，reader projection 不改寫舊矩陣、正文或翻譯 |
| 表格補譯失敗 | 不完整 fake masks 被拒絕；舊 Caption／矩陣、正文翻譯、其他頁狀態、筆記、layout、原文、設定保留；只允許預期的 table_status／issue 更新 |
| 提交前取消 | 明確 cancellation 後沒有提交翻譯，原 paper bytes 與受保護資料不變 |
| 真實程序中斷／重新啟動 | fake model callback 以 os._exit(71) 結束測試子程序，paper bytes 不變；第二個全新 Python 程序可重新取得鎖並完成假補譯。成功的明確補譯可更新 caption_zh，舊 legacy head/rows、正文、筆記與設定保留 |
| 四種閱讀模式 | 既有前端測試執行實際 render/mode 函式，驗證原文、譯文及雙語兩種順序，包含 reading fallback |
| 筆記／翻譯／重新開啟 | 既有 reader_ops、smart_annotations、translation、jobs、bilingual 與 reader_data 測試覆蓋筆記 key、原譯配對、快取、重啟與其他頁面不被覆寫 |

相容性相關235個 Python 測試及37個前端測試通過。前端為 Node VM／最小 DOM 測試，沒有聲稱完成真實安裝版的人工視覺驗收。掃描式與損壞範例都是額外的程式正確性案例，不當作獨立文件來源或泛化準確率。

另執行完整 Python discover，共591項，首次590項通過；唯一錯誤是測試子程序 PATH 缺少 Node，無法啟動 Codex 設定介面測試。將既有 runtime 的 Node 加入該測試子程序 PATH 後，只補跑此項即通過（其內含1項 Node UI測試），未更動產品碼。591個案例均已有通過結果，沒有未解決程式失敗；這不是聲稱首次完整單輪全綠。原始完整 log 與補跑 log 分開保留，沒有覆蓋失敗紀錄，以控制重複執行成本。完整測試的預設 home/library 均指向另外的隔離 profile，阻擋外部網路與真實模型程序；測試用 HTTP 僅允許 loopback。模型錯誤與 localhost 連線重設等 log 為測試模擬／失敗路徑，不是真實推論。

## 安全隔離與停用機制

原本的 review/offline policy 能阻止模型與限制資料路徑，engine=none 也不是完整的表格解析停用開關；讀取已儲存 reading evidence 仍可能進行 PDF 來源驗證。因此新增小型 `easyread/table_policy.py`，只讀環境變數，不新增或更改設定檔。

```powershell
$env:PAPERREAD_DISABLE_TABLE_EXTRACTION = '1'
# 使用此環境重新啟動開發／驗收程序。
```

預設行為不變；1/true/yes/on（大小寫不拘）停用。這是程序環境開關，沒有新增 UI／API。要保證既有 worker 都停止，須重新啟動程序；不宣稱會撤回已在執行中的遠端請求。

已測試的關閉邊界：

- table_extract 的 extract_page／recognize／_matrix 在存取 page／PDF 前停止。
- table_reading 的來源辨識／實際抽取停止，verify_source 亦無法繞過。
- table-only translate_missing 與 discovery 在取鎖、雜湊、讀 paper／PDF 或寫資料之前拒絕。
- reader_paper 在 PDF digest／verification cache／preview 前停止；即使已命中快取，也只在獨立讀取投影中隱藏四個 optional reading 欄位，磁碟資料與 legacy 矩陣不刪除。
- 停用期間原文、paper、筆記及設定 bytes 保持不變；重新啟用後 reading evidence 可再次被驗證使用。

開關不會追溯判定以前儲存的矩陣是否正確，也不阻止基本 PDF 匯入、原頁顯示或既有翻譯／筆記功能。它提供明確的風險隔離選項，不等同已修好跨頁辨識，更不能用「全不解析所以零 FP」宣稱辨識品質達標。benchmark JSON 會標明 table_extraction_enabled。

## 驗收與發版決策

| 條件 | 狀態 |
|---|---|
| 普通正文誤接受攔截 | 通過；本次固定案例已擋，沒有宣稱可排除所有正文 |
| 未標記跨頁表完整性 | **未通過，發版阻礙** |
| 既有精確正例／儲存格錯位 | 7案不變，沒有新增錯位 |
| 相容性相關測試 | 235 Python＋37前端通過 |
| 完整 Python 測試覆蓋 | 591案均有通過結果；首次1項環境錯誤，補跑通過，保留兩份 log |
| 停用後不再執行新表格解析 | 通過；來源讀取、模型、寫入與 reader cache hit 均有防繞過測試 |
| 原始固定基準／holdout | 保留，holdout 未評估 |
| 正式安裝版／完整 GUI 人工驗收 | 未執行，亦未更新安裝版 |

**NO-GO：預設啟用表格實驗功能的發版。**停用模式可用於後續隔離驗收，但不能據此自動升格為整個產品 GO；尚需解決／排除未標記跨頁誤接受，完成對應文件層級驗證，以及正式發版流程所需的 GUI／封裝驗收。

重現資料：`tmp/table-stability-candidate.json`（固定26案）、`tmp/table-stability-full-tests.log`（完整單元測試原始紀錄）、`tmp/table-stability-retry-tests.log`（補跑）、`tmp/table-stability-acceptance.json`（合併驗收摘要）、`tests/test_table_stability.py`（11案隔離相容性）。原 P0 manifest 與 observations-v1.json 保持不變。程式變動僅限來源單字防護及必要停用邊界，不引入第二擷取引擎或其他演算法調參。

完整隔離啟動器保留於 `tmp/run_table_stability_suite.py`，可用 `python -m tmp.run_table_stability_suite` 重現；加上完整 unittest 名稱可只重跑指定案例。既有前端測試命令為 `node --test tests/test_table_modes.cjs tests/test_table_render.cjs tests/test_table_actions.cjs tests/test_table_profile.cjs`。
