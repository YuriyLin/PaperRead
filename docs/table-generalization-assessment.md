# PaperRead 表格擷取泛化評估（2026-10-18）

## 結論與範圍

建議停止針對 Busch & Henriksen Table 1 增加特殊規則，先補齊基準集與驗證邊界，再做第二擷取策略的離線比較。目前證據支持「規則與測試的版面涵蓋偏窄」，不能據此宣稱已證明統計意義上的過度擬合，也不能推估正式論文庫的成功率。

本階段只新增評估腳本、測試產物與本報告，沒有改動正式辨識邏輯。先前未提交的 Caption、裁切、連字與其他修改均保留。沒有讀寫正式論文庫、呼叫真實模型、更新安裝版、Commit 或 Push。公開範例下載與官方文件查閱屬資料準備；評估執行期間封鎖 socket connect。

評估環境：pdfplumber 0.11.10、pypdf 6.21.0。合成器直接使用 pypdf 寫出文字與向量線段，不引用既有 make_table_pdf；這提供不同產生器與版面，但仍共用 pypdf PDF 寫入套件，不能視為完全獨立的文件分布。

## 規則盤點

行號以本次工作目錄的 easyread/table_extract.py 為準。分類為「通用不變條件」、「支援範圍政策」、「版面啟發式」；同一段程式可能兼具數種性質。

| 位置 | 規則 | 分類與泛化風險 |
|---|---|---|
| 38–55 | 字元中心落在半開矩形內；2pt 文字容差、3pt 行合併門檻 | 幾何歸屬概念通用；中心點及固定 pt 容差仍會受字級、旋轉、密集版面影響 |
| 58–71 | 至少 2×2、同欄數、無 None、列欄邊界差 ≤1pt | 矩形結構政策與幾何啟發式；合併儲存格拒絕是既定支援限制 |
| 72–79 | 無框線表格不得遺漏同一高度區域外側文字；每字元恰落一格 | 來源覆蓋通用；將同高度外側文字視為遺漏欄的推論，可能拒絕雙欄正文或旁註 |
| 80–100 | 拒絕 replacement/control glyph；輸出型別及非空列；全表 Counter 比對 | 通用完整性檢查；Counter 不保留順序與儲存格歸屬，不能等同逐格數值一致性 |
| 93–98 | U+FB00–FB06 明確拉丁連字展開，僅用於比較 | 通用編碼差異修正；不改寫 cell，不使用廣泛 NFKC，不依賴論文身份 |
| 101–108 | CJK 拒絕；同格字級比 >1.25 拒絕 | 英文範圍政策；混字級判斷是數學風險代理，可能拒絕合法強調、引用與上標 |
| 109–127 | 開頭整列全粗體視為表頭；否則首次在第 2 欄以後出現數字前的列是表頭 | 強版面／內容啟發式；一般非粗體文字型表頭及帶年份的表頭有漏判風險 |
| 128–131 | 無框線至少兩資料列、不接受 cell 換行、每資料列必須含數字 | 統計表專用政策；排除短表、概念表、換行延續列，含數字正文仍可能通過 |
| 135–162 | 裁切區域有限、正面積、與原 PDF bbox 取交集；尊重 CropBox；部分字元裁切拒絕 | 通用 PDF 座標修正及保守來源政策，不依賴 A4 或零原點 |
| 174–209 | 英文 Table 編號、分隔標點或粗體標籤；裸標籤下行標題須對齊、近距離、首字大寫、至少兩詞、排除標點／特定開頭詞 | 跨行 Caption 支援是通用需求；具體 6/12pt、大小寫、詞數及詞表都是啟發式，不宜當成通用格式定義 |
| 213–233 | continued 拒絕；只搜尋 Caption 下方 <40pt，遇 Note/Source/下一 Caption 停止；頁尾留18pt；線策略優先，否則 text 策略；min_words_vertical=3；候選必須唯一 | 唯一性屬通用驗證；搜尋方向、距離、詞彙及偵測參數屬版面假設；下方 Caption 刻意不支援 |
| 236–243 | 表格底部距頁尾 ≤30pt 拒絕；Caption 間文字最多兩行 | 跨頁／Caption 風險代理；可能漏判合法近頁尾表及長 Caption |
| 246–265 | 表下 ≤18pt 逐行讀 Note/Source；續行間隔<7pt且字級差≤5%；未標記文字拒絕；混字級附註拒絕 | 強版面啟發式；正文緊接表格可能被當成未知附註；NIST Table 2 重現此問題 |
| 267–284 | 保留 head/rows/notes、實體格框、來源 token；正規化位置及矩形 schema 檢查 | 通用可追溯性；token 與 schema 正確不代表語意列欄正確 |
| 293–316 | 頁碼、caption/num 一致，拒絕已知 spans/segments；檢查下一頁同號 continued；同編號來源恰一個 | 通用身份驗證加有限跨頁啟發式；沒有 continued 標記的跨頁表可能只接受第一片段 |

特別注意 API 層級：extract_page 僅看單頁；recognize 才檢查下一頁及同編號唯一性。本次矩陣以 recognize 作最終接受判定，同時記錄 extract_page 結果。帶 continued 的案例在第一頁 extract_page 仍產出 1 個來源，recognize 才拒絕。重複身份案例單頁產出 2 個來源，recognize 才拒絕。table_translate 同時有呼叫這兩個 API 的路徑，未來應逐路徑審查，不能把局部 API 成功當成最終來源已驗證。

## 既有測試偏差

- 倉庫原有真實 PDF 僅 NIST TN 2113 的同文件 3 頁節錄；3 頁全以 fallback 為期望，沒有真實 PDF 成功逐格重建的正例。
- test_table_translation、crop、caption、reading、reading_translation、interactions、reader_data 等共用 make_table_pdf。其固定 600×800、Helvetica/Helvetica-Bold、165pt 等寬欄、27pt 列距、上方 Caption 與規整三欄版面，形成明顯相關樣本。
- 既有測試已涵蓋負號、精度、統計符號、合併格、continued、部分裁切與來源驗證；這些測試有價值，但數量不等同獨立版面數量。
- Caption 單元測試部分使用 mock line，能驗證分支但不能證明真實 PDF 的分行結果。
- 本次 105 個既有相關測試全通過，同時新評估仍能重現漏判及誤接受，證明既有回歸測試不足以衡量泛化。

## 指標定義

- 正確接受：真實目標為可表格化的單頁矩形表，head/rows 必須逐格等於事先建立的答案，含數字、符號與換行。
- False Negative（FN）：確有表格但未取得正確矩陣。即使保守拒絕有安全理由，仍是矩陣擷取能力的漏判；另記是否產出 unresolved。
- False Positive（FP）：非表格文字被接受，或已知跨頁表被當作完整單頁表接受。後者是「結構完整性誤接受」，不等同把非表格判為表格。
- 儲存格錯位：接受了真正表格，但列欄、表頭邊界或內容與預先答案不一致；另與 FP 分開計。
- 正確 fallback：合併格、明示跨頁、身份歧義等既定不支援／不可唯一識別的結構被拒絕。
- 正確拒絕：非表格未被接受；沒有 Caption 而回傳空結果不稱為已產出 fallback。
- 語意模糊：刻意排列成三欄的含數字句子，也可合理被解讀為表；獨立呈現，不併入確認 FP。

## 合成 PDF 測試矩陣

全部案例使用獨立合成器，不使用 Busch。22 案例含 14 個可表格化正例、3 個不支援／身份歧義案例、4 個非表格負例與1個語意模糊案例。跨頁案例為各 2 頁，其餘各 1 頁。

| ID（同產物檔名） | 類型／變因 | 最終結果 | 原因或證據 |
|---|---|---|---|
| ruled_times | Times 有框線統計表 | 正確接受 | 逐格完全相同 |
| ruled_courier_right | Courier、數值靠右、有框線 | 正確接受 | 逐格完全相同 |
| borderless_times | 無框線統計表 | 正確接受 | 逐格完全相同 |
| borderless_courier_right | 無框線、Courier、數值靠右 | 正確接受 | 逐格完全相同 |
| ruled_concept | 無數字概念表、有框線 | 正確接受 | 逐格完全相同 |
| borderless_concept | 同內容、移除框線 | FN，有 unresolved | Borderless extraction may omit an outside column |
| ruled_multiline | 有框線、首資料格換行 | 正確接受 | 換行及其餘格完整保留 |
| borderless_multiline | 同內容、移除框線 | FN，有 unresolved | Borderless rows lack statistical alignment evidence |
| merged_header | 合併表頭 | 正確 fallback | Merged or irregular cells |
| continued_label | 2 頁、次頁同號 continued | 正確 fallback | recognize: Table continues on the following page |
| continued_unlabelled | 2 頁、次頁另有數據但無 continued | FP：不完整表被接受 | 第一頁接受，第二頁 Delta/Epsilon/Zeta 數據不在結果中 |
| prose_negative | 刻意對齊的無數字句子 | 正確拒絕 | 外側欄覆蓋檢查拒絕；有 unresolved |
| numeric_prose_negative | 三欄含年份／數字句子 | 語意模糊：接受 | 視覺上也像表；不計確認 FP |
| caption_gap_45 | Caption 與表格距離 45pt | FN，有 unresolved | Missing or ambiguous table geometry |
| caption_below | Caption 在表格下方 | FN，有 unresolved | Missing or ambiguous table geometry；既定範圍限制 |
| missing_caption | 無 Caption、實際有表格 | FN，無 unresolved | 來源身份不能唯一確認；未產出候選 fallback |
| nonbold_header | 表頭非粗體、數值資料 | 正確接受 | 數字轉折推斷表頭成功 |
| unmarked_body_after | 表下緊接普通正文 | FN，有 unresolved | Text below the table may contain unmarked footnotes |
| duplicate_identity | 同頁兩張同號表 | 正確 fallback | recognize 拒絕兩個來源；單頁 API 仍輸出兩張表 |
| caption_plain_label | 非粗體 Table 1 Estimates | FN，無 unresolved | 沒有分隔標點／粗體，Caption 未成立 |
| natural_prose_captioned | 普通完整句、含年份，前有 Table 1 標題 | FP：非表格被接受 | 正文拆為9欄，表頭甚至被切成 This ann / ual / repo / rt 等片段 |
| natural_prose_no_caption | 相同完整句、沒有 Caption | 正確拒絕 | 沒有來源 Caption；無 unresolved |

結果：7 正確接受、7 FN、2 FP、3 正確 fallback、2 正確拒絕、1 語意模糊接受。7 個正確接受皆逐格精確，未在這些正常擷取案例觀察到「真正表格接受但格子錯位」。此結論不能延伸為不會錯位，見下方故障注入。

14 個單頁可表格化正例只有7個取得精確矩陣。這是刻意選取的挑戰集，不是抽樣估計，不應當作產品召回率。無 Caption／下方 Caption 等政策限制仍記 FN，以免靠縮小分母美化能力；對不支援案例另列安全性結果。

## 不同來源真實 PDF

| 文件與頁 | 結果 | 解讀 |
|---|---|---|
| 既有 NIST TN 2113，節錄頁1／原PDF頁17，Table 1 | 0來源、1 unresolved；Merged or irregular cells | 合併格，符合目前矩形限制的正確 fallback |
| 同文件，節錄頁2／原PDF頁18，Table 2 | 0來源、1 unresolved；unmarked footnotes | 有框線的實際表格；視覺確認表後為正文。安全拒絕，但在矩陣擷取指標仍是 FN；不能因測試原本期望 fallback 就當成泛化成功 |
| 同文件，節錄頁3／原PDF頁19，Table 3 | 0來源、1 unresolved；Merged or irregular cells | 合併群組列，正確 fallback |
| 新增本機副本 FBI/NICS，November 2015，第1頁 | 0來源、0 issues、0 unresolved；原生 find_tables 有1個候選 | 真實表格但無 Table n Caption，屬偵測 FN／靜默未辨識；也含複合表頭，矩陣重建能力尚未被測到 |

兩份來源均在工作目錄內讀取；輸入 SHA-256 前後一致。NIST 既有 fixture 的 SHA-256 為 34337949d20353d834189f819fd2545416f9a00c9092b054a7fa67174612fdbe。FBI 副本為 4f0ae6e017b0e97de211da8fd97316e55bd927af5740d6ce95e1b7b1539f9407。第二來源下載自 pdfplumber 官方範例，未納入正式論文庫。

來源：[NIST fixture 說明](../tests/fixtures/tables/README.md)、[pdfplumber 官方範例](https://github.com/jsvine/pdfplumber/tree/stable/examples/pdfs)、[下載的原始檔](https://raw.githubusercontent.com/jsvine/pdfplumber/stable/examples/pdfs/background-checks.pdf)。兩份來源4頁仍過少，且沒有真實成功重建正例，不能做跨出版社泛化的肯定結論。

## 故障注入：完整性不等同正確歸屬

在真實合成有框線 PDF 的 table.extract 回傳值上做測試期 mock，page.chars 與幾何不變，直接呼叫現有 _matrix；未更動正式程式：

| 注入錯誤 | 現有結果 | 意義 |
|---|---|---|
| 12.50 → 12.5 | 拒絕 | 漏字檢查有效 |
| 12.50 → 12.500 | 拒絕 | 重複字元檢查有效 |
| 12.50 → 21.50 | 接受 | Counter 對順序不敏感，數值改變卻保留相同字元數 |
| Alpha/Beta 兩格的 -1.25 與 12.50 互換 | 接受 | 全表字元完整，但儲存格歸屬錯誤 |

後兩者是驗證盲點的可重現證明，不是現實 PDF 錯誤發生率。後續應保留全表 Counter，同時評估逐格來源字元、閱讀順序及數值 token 的獨立核對。不能把兩種策略輸出相同，或同一套函式產生／驗證的 hash，相當於來源正確性保證。

## 泛化與過度擬合風險

1. 編碼與座標修正風險較低：邊界取交集、保留原點、比較用途的連字映射有明確格式語意，不依賴 Busch 的內容或位置。仍需更多字型、非零原點與 CropBox 的真實來源。
2. Caption 啟發式風險中高：支援跨行的需求合理，但固定詞表、行數、距離、大小寫限制可能只適合部分出版格式。不可只用 Busch 與同產生器測試支持新閾值。
3. 無框線策略風險高：只用含數字作為統計對齊證據，既排除合法概念／換行表，也無法排除含年份正文。這是類別分離證據不足，繼續加例外很難兼顧 precision 與 recall。
4. 邊界與跨頁風險高：Caption 下方整區 text-strategy 可能納入正文；沒有 continued 的跨頁表則無法由目前跨頁字詞規則保證完整。
5. 測試相關性高：同一 helper 的多種內容變體不能替代多出版來源；本次獨立 helper 仍只有三欄、少量字型和向量文字，尚未包含掃描、旋轉、CJK、雙欄頁面、複雜公式或完整字型編碼分布。

## 改善優先順序與第二策略評估

| 優先級 | 工作 | 可審查的成功條件 |
|---|---|---|
| P0 | 凍結目前規則；固定本次失敗案例與答案；補充多來源人工逐格標註，按文件／出版社劃分開發與留出集 | 同文件不能跨開發／驗收集；分別報告 FP、FN、錯位、fallback、無候選；不以 Busch 是否通過決策 |
| P0 | 在測試環境審查逐格來源／數值順序核對與跨頁完整性，審查所有 extract_page/recognize 呼叫路徑 | 故障注入的數字重排與格子互換必須被拒絕；漏字、重複、來源身份歧義仍拒絕；不以放鬆保護換成功率 |
| P1 | 第二擷取策略離線原型，保留目前策略為基準 | 留出集精確重建增加，非表格 FP、錯位及已知跨頁誤接受不得增加；來源無法唯一確認或策略衝突仍 fallback |
| P1 | 分開測量候選區域、格線結構、文字歸屬與接受判定 | 比較「相同人工區域」與「端到端自動區域」兩組，辨別引擎改善或只是 crop 改善；不提供人工區域給端到端分數 |
| P2 | 有充分跨來源證據後才調整 Caption／字級／距離等門檻 | 使用局部消融，呈現每個門檻改動的 FP/FN 變化；參數以相對字級／間距為候選，而非依 Busch 固定座標 |

建議值得評估第二策略，但現在不能宣稱換引擎一定更好。現有實作已經使用 pdfplumber 的 lines 與 text 兩種設定，單純再加一組 text tolerance 只是同一偵測機制的參數變體。較有比較價值的是非模型的對齊網路／空白分群策略，例如 Camelot Network，並對部分框線表比較 Hybrid；官方說明其依文字框雙軸連結尋找區域，與現有的逐行數字條件不同。參考：[Camelot 官方策略說明](https://github.com/camelot-dev/camelot/blob/master/docs/user/how-it-works.rst)。本次沒有安裝或執行 Camelot，以上是候選方案，不是本機效能結論，也不啟用 ML/OCR 模型。

第二策略只提出帶來源座標的候選結構，不產生／重寫文字。候選必須重新以 PDF 原字元填格，經同一套字元完整性、來源唯一性、逐格數值／順序及跨頁驗證。引擎信心分數或多引擎投票不能取代這些條件。不要把「引擎接受結果的聯集」直接當作產出，否則容易放大 FP。

建議下一批至少收集6個獨立文件來源，每個必要類型至少3種獨立版面，並包含有框線與無框線的真實成功正例。這只是開始建立留出集的規模建議，不是統計充分性的宣稱。合併格／跨頁即使仍維持 fallback，也要獨立報告政策覆蓋率與安全性。

## 重現與產物

- 腳本：scripts/evaluate_table_generalization.py；執行 `.venv/Scripts/python.exe -m scripts.evaluate_table_generalization`。
- 執行前需要第二份公開 PDF 放在 tmp/table-generalization/background-checks.pdf，核對上述 SHA-256；腳本本身不下載檔案。
- 完整逐案資料：tmp/table-generalization/results.json。PDF、預覽 contact-0 至 contact-4.png、NIST/FBI 頁面預覽及 run.log 均在同一資料夾。已檢視合成預覽及真實頁面；預覽 contact sheet 為局部裁切，完整頁面以原 PDF 為準。
- 既有測試：`python -m unittest tests.test_table_ligatures tests.test_table_caption tests.test_table_crop tests.test_table_translation tests.test_table_reading tests.test_table_reading_translation tests.test_table_reading_review tests.test_table_interactions`，105 tests，OK。
- `git diff --check` 通過。評估腳本為 characterization，不會因現有缺陷而直接 assertion failure；結果需閱讀 JSON 與本矩陣，不能把腳本 exit 0 解讀為泛化通過。
