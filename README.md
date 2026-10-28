# PaperRead

<p align="center">
  <img src="easyread/web/paperread-mark.png" width="88" alt="PaperRead">
</p>

<p align="center">
  <strong>從研究探索到論文精讀的個人研究工作區</strong><br>
  以繁體中文介面閱讀論文、整理候選清單、規劃閱讀路徑，並保留可回到原文核對的研究脈絡。
</p>

<p align="center">
  <a href="https://github.com/YuriyLin/PaperRead/releases/latest">下載 PaperRead</a> ·
  <a href="https://github.com/YuriyLin/PaperRead/issues">回報問題</a> ·
  <a href="README.en.md">English</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Windows%20x64%20%7C%20macOS%20arm64%20%7C%20Linux%20x64-支援-2f6070" alt="支援平臺：Windows x64、macOS arm64、Linux x64">
  <img src="https://img.shields.io/badge/license-MIT-lightgrey" alt="MIT License">
</p>

PaperRead 是以 EasyRead 為基礎整理的個人研究工具。它保留原有的 PDF 排版、雙語閱讀、原文定位、批註與 AI 對話能力，再加入研究探索和閱讀規劃流程，讓「找到論文」與「真正讀懂論文」接在同一個工作區裡。

## 功能與改善概覽

- **文獻整理**：支援階層分類、整個資料夾批次匯入、Zotero 文獻庫匯入，以及連結既有 PDF 而不複製檔案。
- **批次作業**：匯入時顯示處理進度；大量匯入提供翻譯確認，並可停止全部或指定的背景翻譯任務。
- **論文閱讀**：提供滑鼠手寫註記、橡皮擦、復原／重做與自動保存；改善 LaTeX 標題及摘要顯示、程式碼區塊處理，並支援行動版 HTML 匯出。
- **研究工作區**：整合研究探索、候選清單、摘要、閱讀看板、閱讀路徑、跨論文關鍵字搜尋與原文定位；Quick Peek 可查看摘要與閱讀紀錄。
- **AI 模型**：新增 Antigravity CLI 模型來源，可偵測本機可用模型並調整推理強度。
- **Obsidian**：匯出時可設定 Vault，並將摘要、分析、標註、心智圖與比較資料匯入筆記庫。
- **穩定性與桌面更新**：單篇資料異常時隔離處理；桌面版更新支援背景下載、進度顯示與手動重啟。

## 主要工作流程

```text
研究探索
    ↓
加入候選清單
    ↓
檢視候選論文與背景摘要
    ↓
選擇要整理的論文
    ↓
產生／檢視／匯出摘要
    ↓
加入閱讀看板並拖曳調整順序
    ↓
建立閱讀路徑與論文心智圖
    ↓
開啟 PDF 精讀、核對原文、批註與問 AI
```

這些狀態彼此分開：搜尋結果不等於候選論文，候選論文不等於已整理摘要，也不會因為加入候選就自動加入閱讀看板。

## 研究探索

研究探索是 PaperRead 的研究入口，提供兩種搜尋方式：

### 主題搜尋

輸入研究概念或問題，例如：

- `Long Video Understanding`
- `Vision-Language Models`
- `3D Scene Understanding`

PaperRead 會先取得可用的公開書目資料，再顯示標題、作者、年份、摘要、來源、DOI、引用資訊和 PDF 可用性。搜尋結果會標示資料來源，缺少的欄位顯示「未提供」，不把缺漏資料當成零。

### 會議／期刊搜尋

可一次輸入一個或多個出版來源，例如：

```text
CVPR
ICCV ECCV CVPR
MICCAI
```

PaperRead 會依來源拆分查詢，支援常見的學術會議與期刊。結果會保留出版來源、DOI 和可查證連結，並區分正式出版資料與預印本；搜尋結果中的會議名稱不會被直接當成正式發表證明。

目前探索資料主要使用 OpenAlex，會議／期刊書目查詢也可使用 DBLP 與 Crossref 補充。服務限流或網路中斷時會保留既有結果並提供重試，不會把「服務失敗」誤顯示成「沒有論文」。

### 跨論文關鍵字搜尋與原文定位

閱讀器可從反白文字或勾選既有術語收錄關鍵字。每個關鍵字會保留顯示名稱與原文比對詞，並在目前文獻庫的已整理原文中比對命中位置；翻譯術語表不會被改寫。

研究工作區的「關鍵字」頁（`/research?mode=keywords`）可多選關鍵字，以「符合全部（AND）」或「符合任一（OR）」篩選論文，即時檢視包含命中詞語的原文脈絡摘錄卡片（標記高亮關鍵字），並可點擊「開啟論文並定位到此段 ↗」直接開啟閱讀器跳轉至對應原文段落。支援排除不相關的自動比對關聯、封存管理以及快速建立新關鍵字。自動比對只代表原文出現指定詞，不代表研究結論或因果關係。

每張論文卡片只保留研究探索階段需要的操作：

- **加入候選**：先儲存論文，不會立刻生成摘要或下載 PDF。
- **論文來源**：開啟可查證的出版頁、DOI 或來源連結。

## 閱讀看板

閱讀看板是研究探索頁面的主要工作區。論文可以拖曳到不同狀態列位，狀態由使用者決定，不會因為開啟 PDF 或讀到最後一頁而自動改變。

預設狀態包含：

- 待閱讀
- 閱讀中
- 待整理
- 已完成

閱讀進度百分比獨立顯示，只代表閱讀位置，不代表已經理解或完成筆記。看板支援分類、PDF 可用性、感興趣標記與手動優先順序篩選；首頁、閱讀器研究面板和看板的星標會同步。

加入閱讀看板時，分類使用可複選的分類卡片，不需要使用鍵盤搭配下拉選單。一次可以將論文放入多個研究方向；沒有分類時也可以先加入看板，之後再整理。

點擊卡片空白處會從右側開啟 **Quick Peek**，不離開看板即可查看完整書目、摘要、分類、閱讀狀態、星標、進度與來源資訊。閱讀紀錄區會分開顯示最近筆記、劃線與最近問題；點擊紀錄可回到閱讀器對應段落。抽屜底部提供上一篇、下一篇與繼續閱讀，背景更新時會保留目前的論文與捲動位置。

## 候選清單

候選清單用來儲存「值得之後研究」的論文。它會跨頁面保留，與閱讀看板及已整理摘要分開管理。

加入候選後，PaperRead 會在背景批次整理來源摘要。一次加入多篇時會排入佇列，避免同時傳送大量請求。你仍然可以自行決定：

1. 檢視候選論文。
2. 移除不再需要的論文。
3. 對個別論文重新整理摘要。
4. 檢視 Markdown 摘要。
5. 使用「匯出摘要」儲存檔案。
6. 將選定論文加入閱讀看板。

候選論文不會自動變成已讀，也不會自動覆蓋你的正式筆記。

## 已整理摘要

已整理摘要會獨立儲存，即使論文之後移出候選清單，摘要仍可保留。摘要內容以 Markdown 儲存並使用與筆記一致的安全渲染方式，支援：

- 標題與副標題
- 粗體、斜體
- 有序與無序清單
- 程式碼區塊
- 表格
- 系統已支援的數學公式

主要操作順序是：

```text
檢視摘要 → 重新整理摘要 → 匯出摘要 → 移到回收站
```

摘要由模型根據實際取得的論文資料產生；缺少的來源資訊會標示「未提供」，不捏造研究結果或出版資訊。

摘要可直接匯入已設定的 Obsidian Vault，檔案會寫入 `Research/05-論文摘要`，使用英文論文名作為受限制長度的檔名，不額外建立子資料夾。下載時，單一項目輸出 Markdown，多個項目輸出包含完整資料夾結構的 ZIP。

## 閱讀路徑

閱讀路徑可以從研究主題或指定論文開始。例如：

```text
主題：Long Video Understanding
研究目標：先建立基礎，再理解主流方法並尋找研究方向
```

PaperRead 會依目前可取得的論文資料，將推薦結果整理成有順序的路徑。每篇論文會附上：

- 閱讀順序
- 閱讀角色，例如基礎入門、方法理解、代表性研究、延伸探索或前沿研究
- 推薦理由
- 與主題或起點論文的關聯
- 年份與出版來源（可取得時）

AI 只能重組已查詢到的論文資料，不能自行新增不存在的論文。資料不足時會明確說明，基礎搜尋與看板功能也不會因 AI 不可用而停止。

產生後可在地圖／清單之間切換，使用縮放、平移、節點選取與提前／延後調整閱讀順序。虛線箭頭表示建議閱讀順序，實線箭頭表示目前路徑內可由 OpenAlex 確認的引用關係。閱讀路徑與跨論文比較都可在背景執行；關閉視窗或切換頁面不會取消工作，完成後會在 PaperRead 內通知並提供查看結果。

研究探索中的跨論文比較會保留研究問題、核心方法、成本、限制、異同與候選問題，並可直接匯入 Obsidian `Research/04-跨論文比較`。若部分單篇筆記尚未匯出，系統會提醒比較報告中的對應 WikiLink 可能要在單篇筆記匯出後重新建立。

## 論文心智圖

在論文閱讀頁的「研究脈絡」區塊，可以要求 PaperRead 根據目前論文生成繁體中文 Mermaid 心智圖。心智圖優先呈現研究邏輯，而不是單純複製論文章節：

```text
論文標題
├── 研究問題
├── 理論框架
├── 方法設計
│   ├── 輸入與輸出
│   ├── 核心模組
│   └── 實驗設定
├── 核心發現
├── 研究貢獻
└── 研究限制
```

節點會盡量保持簡短，內容只使用目前論文提供的文字、公式和資料。生成中的狀態會顯示載入動畫，失敗時可以重試；生成後可在閱讀頁檢視，也能透過筆記匯出流程一併匯出。

## 論文閱讀與 AI

PaperRead 的 Human Reading Interface 仍以原文核對為中心：

- 原文、譯文、AI 解釋和個人筆記分開顯示。
- 圖片與表格保留排版位置，點選後回到原 PDF 檢視。
- 螢光筆、下劃線、問題和筆記會繫結原文 block、頁碼與定位資訊。
- 可以選取文字後執行 AI 改寫，不會固定套用搜尋結果中的第一組詞。
- AI 回答和摘要都會顯示載入、失敗與重試狀態。
- 問 AI 的「回答方式」可選標準回答、簡明回答或精讀；旁邊的問號會說明三種模式的差異與用量。精讀著重方法機制、公式示例與實驗限制，仍針對這次問題回答；長文會受上下文上限而節錄。

## 智慧標註

閱讀器的「筆記」面板提供「智慧標註」，用來找出值得回看的研究內容。分析前可以選擇：

- **全文**或指定章節。
- **AI 自動標註**、逐筆審閱的**AI 建議標註**，或依研究目的篩選。
- 是否輸入研究目的，例如「找出可用於 3D segmentation 的方法與限制」。

每筆建議都會顯示原文定位、頁碼、顏色、標註型別、AI 註記與標註原因。使用者可以逐筆接受、修改或拒絕，也可以批次接受已確認能定位的專案。未能可靠定位的內容會保留在待確認清單，不會直接套用到正文。

顏色有固定語意：黃色表示核心概念與主要主張，綠色表示方法與實作細節，藍色表示實驗證據與量化結果，紅色表示限制、失敗案例與待研究問題。接受後會沿用既有螢光筆或底線標註系統，不會覆蓋手動建立的標註。

AI 分析同時參考穩定的英文原文與目前的繁體中文譯文，正式標註優先落在中文譯文上。論文重新翻譯後，PaperRead 會重新檢查定位；無法確認的新位置會要求重新分析或人工修改，不會猜測座標。

匯出筆記時勾選「每條附上原文引用」，引文與注記會分開呈現：中文譯文放在 Markdown 引用區塊，使用者說明標示為「我的注記」，問題則標示為「我的問題」。

## 模型選擇

可在設定中選擇主流 API 或本地模型：

| 型別 | 例子 |
|---|---|
| 雲端 API | OpenAI、Anthropic、Google Gemini、DeepSeek、智譜 GLM、阿里雲百煉、Kimi、OpenRouter、Groq、Cerebras |
| 本地模型 | Ollama、LM Studio |
| 自訂介面 | OpenAI-compatible Chat Completions 或 Responses endpoint |

Ollama 使用本機 API，例如 `http://127.0.0.1:11434`。啟用 thinking 的模型會依模型支援的引數傳遞；只有支援布林值的模型會使用 `think: true/false`，不會強行送出不相容的 `low/high` 層級。

## 安裝與執行

### Windows 安裝檔

從 [PaperRead Releases](https://github.com/YuriyLin/PaperRead/releases/latest) 下載 `PaperRead-Setup-x.x.x.exe`。安裝程式會包含 Electron 桌面程式與打包好的 Python 後端，不需要另外安裝 Python 或 Node.js。

目前 Windows 安裝檔尚未使用程式碼簽署憑證，因此 Windows 可能顯示未驗證發行者提示。這不影響程式功能，但不等同於「已驗證的發行者」。

### Linux AppImage

從 [PaperRead Releases](https://github.com/YuriyLin/PaperRead/releases/latest) 下載 `PaperRead-x.x.x.AppImage`。Linux AppImage 會包含 Electron 桌面程式與打包好的 Python 後端；下載後加入執行許可權即可：

```bash
chmod +x PaperRead-*.AppImage
./PaperRead-*.AppImage
```

目前正式 Release 提供 Linux x64 AppImage。

### macOS 安裝檔

目前正式 Release 提供 Apple Silicon（arm64）DMG：從 [PaperRead Releases](https://github.com/YuriyLin/PaperRead/releases/latest) 下載 `PaperRead-x.x.x-arm64.dmg`，開啟後將 PaperRead 拖曳至 Applications。Intel Mac 請使用 Docker 瀏覽器版，或自行從原始碼建置相容架構。

### Docker 瀏覽器版

Docker 版本適合 Linux、macOS 或 Windows 上沒有原生桌面安裝需求的情境。它啟動 PaperRead 網頁服務，論文庫與設定持久儲存於 Docker volume：

```bash
git clone https://github.com/YuriyLin/PaperRead.git
cd PaperRead
docker compose up -d
```

接著開啟 <http://localhost:8765>。停止服務但保留資料可使用 `docker compose down`；重新啟動仍會使用同一個 `paperread-data` volume。

若 Ollama 執行在主機上，Docker Compose 已提供 `host.docker.internal` 對應，可在 PaperRead 設定中使用 `http://host.docker.internal:11434/v1`。PaperRead 沒有登入機制，因此 Docker Compose 預設只繫結本機 `127.0.0.1`。若要給其他裝置使用，建議在前面加一層有登入驗證的反向代理；若確定要直接在區域網路開放，需同時把 port 對應改成 `"8765:8765"`，並在 `PAPERREAD_ALLOWED_HOSTS` 列出你用來連線的主機名稱或 IP（逗號分隔），否則請求會因 Host 檢查被拒絕。不要把 PaperRead port 直接暴露到公網。

每個版本也會發布預建的 GitHub Container Registry 映像，不必在本機編譯：

```bash
docker pull ghcr.io/yuriylin/paperread:v1.5.0
docker run -d --name paperread --restart unless-stopped -p 127.0.0.1:8765:8765 -v paperread-data:/data/PaperRead ghcr.io/yuriylin/paperread:v1.5.0
```

接著開啟 <http://localhost:8765>。`paperread-data` volume 會保留論文庫與設定。

### 從原始碼執行

需要 Python 3.10+、Node.js 22+ 和 PyInstaller：

```bash
git clone https://github.com/YuriyLin/PaperRead.git
cd PaperRead
python -m pip install -e .
python -m pip install pyinstaller
npm install
```

啟動本機服務：

```bash
python -m easyread serve
```

啟動 Electron 桌面版：

```bash
npm run dev
```

建立安裝檔：

```bash
npm run dist
```

輸出位於 `dist/electron/`。在 Windows 會產生 NSIS 安裝檔，在 macOS（Apple Silicon）會產生 DMG，在 Linux 會產生 AppImage。Docker 瀏覽器版則不需要 Electron 或 Node.js。

## 資料位置與相容性

安裝版預設將論文庫與設定放在：

```text
Windows: C:\Users\<使用者名稱>\PaperRead
macOS: `~/PaperRead`
Linux Docker: Docker volume `paperread-data` 內的 `/data/PaperRead`
```

舊版 `EasyRead` 資料會在首次啟動時嘗試遷移；若遷移失敗，程式會保留原資料並以相容方式讀取。為了避免破壞既有指令碼與使用者資料，程式內部仍保留 `easyread` 的 Python module、CLI、環境變數和舊連結協定名稱。

## 開發與測試

前端使用原生 HTML、CSS、JavaScript，沒有額外的前端 build step；後端使用 Python。修改 `easyread/web/` 後重新整理頁面即可檢視變更。

```bash
python -m unittest discover tests
node --test tests/test_*.cjs
python scripts/i18n_check.py
```

PaperRead UI 變更不會自動執行瀏覽器 E2E；請依功能手動驗收閱讀路徑、背景通知、Quick Peek、閱讀器面板與 Obsidian 匯出。

研究探索、繁中介面與資料格式說明：

- [Personal Research OS 使用說明](docs/personal-research-os.md)
- [資料格式](docs/data-format.md)
- [API 說明](docs/api.md)
- [貢獻指南](CONTRIBUTING.md)

## 授權

MIT License。公式渲染使用 [KaTeX](https://katex.org)，同樣採 MIT License。

PaperRead 是個人研究工具 fork；上游 EasyRead 的資料格式與相容性設計仍保留，詳細來源與貢獻者請參考 Git 歷史紀錄。
