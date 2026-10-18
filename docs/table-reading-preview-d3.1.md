# D3.1 原始 PDF 表格內嵌預覽

僅由 D2.5 reader projection 通過來源與中文快取驗證的 fallback 表格取得預覽。
重用 PDFium 的全域鎖與文件生命週期；從 SHA-256 相符的 PDF bytes 快照以
3 倍比例渲染，再依已驗證的 visible-page box 向外取整裁切，輸出無損 WebP。
不重新排版文字、不推測邊界、不使用一般 layout 的 caption/between 區域。

預覽使用既有 data URI 圖片格式，僅存在投影與有界記憶體快取（最多 8 張），
不寫入 paper.json 或 figures。每次投影仍重新雜湊目前 PDF；最後再次檢查來源，
來源失效即撤除中文與預覽，並透過既有版本輪詢更新閱讀器。
輸入的 table_reading_preview 一律移除後重新產生，不能以儲存欄位冒充驗證。
因此不需新增靜態資產服務或 PDF 閱讀器。離線 HTML 是匯出時已驗證的快照，
與既有離線資料相同，不會追蹤之後的來源變動。

英文側圖片使用既有 data-t="page" 開啟原 PDF。四種模式沿用 table-pair 的
完整語言側切換與排序；中文側保留原 PDF 核對入口。圖片依欄寬等比例縮放。
結構化表格路徑與 D2 翻譯流程未變更。

## 局部驗證

```powershell
.\.venv\Scripts\python.exe -m unittest tests.test_reader_data tests.test_table_reading tests.test_table_reading_review
.\.paperread-local-test\node-v22.20.0-win-x64\node.exe --test tests/test_table_render.cjs tests/test_table_modes.cjs tests/test_table_actions.cjs
```

Python 23 項、JavaScript 30 項通過。涵蓋實際 PDF 像素比對、來源替換、
渲染期間來源變動、偽造來源、四種模式、逐格互動與批註鍵保持不變。
未執行完整測試。

## Mock 人工驗收

```powershell
.\.venv\Scripts\python.exe scripts/prepare_table_reading_review.py
.\scripts\start_table_review.ps1 -Mode Mock
```

僅使用 `.paperread-local-test/desktop-review`，開啟
`PaperRead Reading Table Review (Mock)`（`table-reading-review`）。
本次準備已驗證來源並命中既有快取，local_response_calls 為 0。

1. 原文優先雙語：原始英文表格影像在前、中文閱讀輔助在後。
2. 譯文優先雙語：中文在前、原表影像在後。
3. 只看原文：顯示原表影像；只看譯文：顯示中文與原 PDF 核對入口。
4. 點圖片與中文側入口，確認均可開啟原 PDF。
5. 縮小閱讀欄，確認圖片等比例縮放且沒有橫向溢出；比對原 PDF 的數字與線條。

桌面視覺驗收需依以上步驟操作；本次未啟動桌面 GUI。自動化測試以無損像素
比對確認裁切內容來自原 PDF，並驗證來源失效時投影不再提供圖片。
沒有開始 D4。
