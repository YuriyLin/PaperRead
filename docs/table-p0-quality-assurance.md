# 表格擷取 P0 品質保障（2026-10-18）

本階段沿用前次評估的 22 個案例與結果，新增固定語料、完整標註、離線執行器及獨立逐格驗證原型。**沒有改動 easyread 的正式擷取、翻譯、來源驗證或前端邏輯**。既有未提交修改保留，未操作正式論文庫、Obsidian Vault、安裝版或真實模型。

## 固定基準與 ground truth

基準位於 `tests/fixtures/tables/benchmark-v1/`。manifest 有27個案例：26個 regression、1個 sealed holdout。所有 PDF、逐案 truth 及觀測快照都有 SHA-256。執行器不再呼叫舊產生器或重建答案。

| 集合 | 案例數 | 來源分組與標註 |
|---|---:|---|
| 合成 regression | 22 | 同一個獨立產生器家族；不當成22個獨立來源 |
| NIST regression | 3 | 同一文件三頁；7×7、5×7、26×7，完整 cell/span/region 標註 |
| FBI/NICS regression | 1 | 58×25，含2層表頭與56資料列，保留空格／合併表頭 |
| W3C sealed holdout | 1 | 不同出版來源；5×5，已標註，未執行 PaperRead 辨識或 fidelity 評估 |

原先已檢視過的 NIST/FBI 不重新命名為 holdout。不同頁面不跨 split，合成器變體也不跨 split，publisher/document group 洩漏會使載入失敗。預設執行器只跑 regression，明示要求 holdout split 也會拒絕，必須先另立版本化評估協定才能釋出。只有一份封存文件仍不足以代表跨文件泛化。

每份 truth 明列表格存在與否（模糊例為 null）、頁碼、原文件頁碼、邏輯表格數、分頁片段、列欄與表頭、各格文字、絕對 PDF 座標、rowspan/colspan、非表格區域及預期 fallback 原因。標註的 desired action 與目前觀測分開；例如 NIST Table 2 的真值是可精確重建，不能因既有測試預期 fallback 就把 FN 算成成功。

合成標註來自既有 writer 的宣告內容／座標；NIST/FBI 是固定規則格線、raw PDF 文字輔助轉錄及視覺檢查，未使用正式 table.extract 的結果當答案，也尚未經第二位標註者逐格覆核。W3C 的25格為人工轉錄並檢視。這些可靠度與限制記錄於 annotation_method；不能把固定檔案雜湊當成標註必然正確的證明。

## 各類結果

本表用互斥 primary category 加總；manifest 另保留可重疊標籤，例如有框線概念表同時有 ruled/concept。26 案只代表挑戰集，不是自然抽樣的辨識準確率。

| 主類別 | 案例數 | 正確接受 | FN | 非表格 FP | 結構不完整誤接受 | 正確 fallback | 正確拒絕 | 模糊接受 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 有框線矩形表／Caption 變體 | 10 | 4 | 6 | 0 | 0 | 0 | 0 | 0 |
| 無框線統計表 | 3 | 2 | 1 | 0 | 0 | 0 | 0 | 0 |
| 文字型概念表 | 2 | 1 | 1 | 0 | 0 | 0 | 0 | 0 |
| 跨頁表格 | 2 | 0 | 0 | 0 | 1 | 1 | 0 | 0 |
| 合併儲存格 | 4 | 0 | 1 | 0 | 0 | 3 | 0 | 0 |
| 普通正文 | 3 | 0 | 0 | 1 | 0 | 0 | 2 | 0 |
| 模糊內容／身份歧義 | 2 | 0 | 0 | 0 | 0 | 1 | 0 | 1 |
| **合計** | **26** | **7** | **9** | **1** | **1** | **5** | **2** | **1** |

真正表格「已接受但儲存格錯位」本次正常擷取樣本為0；這不包括下方刻意注入的錯誤。若沿用前次把跨頁誤接受也合稱 FP 的計法，合計仍是2個不安全接受；此次拆開，避免混淆表格存在與結構完整性。

| 案例 | 類別／目標 | 現況 |
|---|---|---|
| ruled_times | 有框線統計表 | 正確接受 |
| ruled_courier_right | 有框線、數值靠右 | 正確接受 |
| borderless_times | 無框線統計表 | 正確接受 |
| borderless_courier_right | 無框線、數值靠右 | 正確接受 |
| ruled_concept | 有框線概念表 | 正確接受 |
| borderless_concept | 無框線概念表 | FN：外側欄覆蓋檢查 |
| ruled_multiline | 有框線換行表 | 正確接受 |
| borderless_multiline | 無框線換行表 | FN：統計對齊不足 |
| merged_header | 合併表頭 | 正確 fallback |
| continued_label | 次頁明示 continued | 正確 fallback（recognize 層） |
| continued_unlabelled | 次頁還有數據，無 continued | 結構不完整誤接受 |
| prose_negative | 對齊的無數字句子 | 正確拒絕 |
| numeric_prose_negative | 三欄含年份句子 | 模糊接受，不列為確認 FP |
| caption_gap_45 | Caption 距離45pt | FN：找不到唯一幾何 |
| caption_below | 下方 Caption | FN：既定搜尋範圍不支援 |
| missing_caption | 無 Caption 的真表格 | FN：無候選、無 unresolved |
| nonbold_header | 非粗體表頭 | 正確接受 |
| unmarked_body_after | 表後緊接正文 | FN：正文被視為未知附註風險 |
| duplicate_identity | 同頁兩個同號來源 | 正確 fallback（recognize 層） |
| caption_plain_label | 非粗體且無分隔符的 Caption | FN：未成立 Caption |
| natural_prose_captioned | 含年份普通完整句、有 Table 標題 | 非表格 FP，正文拆成9欄 |
| natural_prose_no_caption | 相同正文、無 Caption | 正確拒絕 |
| nist-table-1 | 真實合併表頭 | 正確 fallback |
| nist-table-2 | 真實有框線表 | FN：表後正文被視為未知附註 |
| nist-table-3 | 真實合併表頭 | 正確 fallback |
| fbi-nics-table | 真實複合表頭、無 Table Caption | 偵測 FN：沒有候選 fallback，不計正確 fallback |
| w3c-pdf6-table | 不同來源 holdout | 封存，未評估 |

## 現有來源欄位的意義

- `table_cell_boxes`：由擷取器實體 row/cell bbox 轉為相對 page.bbox 的六位小數座標，key 如 rows:0:1；附註另有 note key。它提供位置，但本身沒有證明文字確實來自該位置。
- `table_geometry_source`：等於 tables.source_token，hash 的輸入只有 Caption、英文表頭／資料與附註；不含 PDF bytes、頁碼、table_source_box 或 cell boxes。內容改動後重新計算 token 不能證明來源；改座標甚至可能不改 token。
- 翻譯流程會複製來源 boxes/token；前端 openTableCell 以 token 相符和合法座標決定跳轉區域。這是新鮮度／導航保護，不能等同文字來源驗證。
- 原本 `_matrix` 的 coverage 確認每個字元落一個 cell，全表 Counter 確認字元多重集合；兩者不比較每個 slot 的有序文字，所以數字重排及跨格交換仍有盲點。

## 獨立 cell-level provenance 原型

原型放在 `scripts/table_qa/provenance.py`，正式 easyread 程式不引用它。輸入是 PDF、待驗 block，以及從固定標註取得的獨立 reference。

流程為：先核對 PDF SHA-256／頁碼／頁框／可見區域，再核對矩陣形狀、完整 slot 集合、table region 和 slot→bbox 綁定；檢查來源區域每個非空白 glyph 恰好被一格完整包含；依 baseline、x 座標重建每格有序文字，僅做明確拉丁連字與空白處理，同時比較有序數字 token。負號、百分比、小數點、註腳／引用符號都保留原樣，沒有 NFKC 或符號替換。

reference 的信任前提是其檔案與標註經獨立審查並固定，不能由待驗 block 當場自行產生。若攻擊者連 reference 也能任意修改，這個檢查就沒有獨立信任基礎。manifest hash 是版本追蹤與意外變動偵測，不是簽章或惡意竄改防護。

| 程式正確性情境 | 實測原型結果 |
|---|---|
| 正確的12格來源、正確換行格 | 通過，保留逐格 source/extracted 診斷 |
| 12.50→21.50（Counter 相同） | 拒絕：ordered_text/numeric_sequence mismatch |
| 兩格數值／標籤交換（全表 Counter 相同） | 拒絕 |
| 文字與 boxes 一起交換，再重算 token | 拒絕：獨立 slot→box 綁定不符 |
| 漏位數或多一個位數 | 拒絕 |
| 負號、小數點、百分比、星號、引用數字改動 | 拒絕；使用獨立固定符號 PDF fixture |
| ASCII hyphen→Unicode minus | 拒絕，不把兩者折疊 |
| 無害空白／明確拉丁連字 | 比較用途允許；連字映射有單元測試 |
| 數字被空白拆開但刪空白後一樣 | 拒絕：有序數字 token 不同 |
| PDF 檔案改動、頁碼不符、stale token | 拒絕 |
| 缺 box、多 box、錯頁、NaN／Inf／越界 | 拒絕 |
| 參考格重疊、漏掉 glyph、部分裁切 glyph | 拒絕 |
| 重印 glyph、旋轉、無法解碼或混字級歧義 | 保守拒絕，不猜閱讀順序 |
| 未覆蓋的表外附註 | 保守拒絕，不忽略附註 |

本次正常擷取的7個精確正例，**5個通過原始 block 的嚴格幾何＋文字驗證；2個無框線表因緊邊框與 writer 宣告區域不同而拒絕**。另外把候選文字投影到已審查的固定區域，單獨檢查文字歸屬，7個都通過。後者不驗證候選原 boxes，輸出欄位明名為 text_attribution_on_reviewed_regions，不能宣稱原始 boxes 已通過。

無 continued 跨頁片段的第一頁也能通過局部 fidelity，顯示逐格正確不代表整張邏輯表完整。模糊三欄句子的區域文字也可通過；文字真實不代表它一定是表格。偵測、跨頁、身份唯一性仍必須保留為不同驗證層。

限制：這個保守原型尚未支援合併格、多頁引用、表外附註的完整驗證，也未解決不同引擎合法邊框的等價關係。旋轉、混字級／上標只會拒絕；本階段不能直接上線。未改動正式 glyph Counter 或其拒絕條件。

## 驗證結果與後續順序

新增31個程式／基準完整性測試通過，另與既有相關105個測試一起執行，合計136個測試。這代表程式按規格工作及觀測可重現，**不代表136份文件辨識成功，也不代表26案例的泛化準確率**。

另稽核1958個 regression 標註儲存格的來源字元覆蓋。高解析影像確認 NIST Table 3 的 Coefficient／Err. 字形幾乎被後續繪圖覆蓋；原始 crop 轉錄會跨邊界重複這些字形。已在固定標註分離可見文字與 source_glyph_text，記錄例外原因，並以測試確認每個 raw glyph 只歸屬一格。這說明即使全表字元一致，也不能單靠文字層判斷最終可見內容；本次未改動正式辨識邏輯。

固定觀測 `--check-baseline` 無漂移。`--fail-on-unsafe` 預期回傳2，因普通正文 FP 與未標記跨頁誤接受仍存在；這是誠實的品質閘門失敗，不以更新快照或放鬆檢查改成綠燈。

1. P0 下一步先對 NIST/FBI 標註做第二次逐格覆核，補入更多**未參與規則調整**的來源；holdout 留待凍結候選策略與驗證器後一次性評估。當前還沒有真實文件精確成功的 regression 正例，不能據此背書泛化能力。
2. P0 對逐格原型評估「合法邊框不同但 glyph 歸屬相同」的證據格式，以及跨頁／表外附註 reference；保留精確文字與數字順序檢查。不要為了讓兩個無框線案例通過而直接加大容差。
3. P1 值得離線比較 Camelot Network 與 Hybrid，但本次不安裝、不執行、不啟用模型。官方策略說明提供其文字對齊網路與線段組合方式；這是候選機制，不是本機效果結論：[官方文件](https://github.com/camelot-dev/camelot/blob/master/docs/user/how-it-works.rst)。
4. 比較時先鎖定版本與預設參數，分成「固定人工區域下的結構重建」與「端到端候選偵測」兩條實驗；用同一份逐格答案、來源唯一性與數值保護評分。合併格與跨頁仍可正確 fallback。引擎聯集或信心分數不能取代驗證。
5. 只有 regression 的精確接受改善且 FP／錯位／跨頁誤接受不增加，才申請釋出 holdout；釋出後不得依其結果反覆調參。若需要進一步開發，該來源應轉為已知案例並補新的 holdout。

執行方式與資產來源見 corpus README。主要命令：

```powershell
.venv/Scripts/python.exe -m unittest tests.test_table_provenance tests.test_table_benchmark tests.test_table_ligatures tests.test_table_caption tests.test_table_crop tests.test_table_translation tests.test_table_reading tests.test_table_reading_translation tests.test_table_reading_review tests.test_table_interactions
.venv/Scripts/python.exe -m scripts.table_qa.benchmark --output tmp/table-qa-regression.json --check-baseline
.venv/Scripts/python.exe -m scripts.table_qa.benchmark --output tmp/table-qa-safety.json --fail-on-unsafe
git diff --check
```

JSON、逐格診斷與測試 log 保留在 tmp，固定 truth／觀測則在 tests/fixtures；兩者不互相覆寫。已記錄的正式 Python 檔、build_backend.py 與既有 Caption 測試內容雜湊與本階段開始時比較，保持不變；其餘既有未提交修改亦保留。
