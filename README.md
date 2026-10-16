# 文獻小幫手

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
  <img src="https://img.shields.io/badge/Windows%20x64%20%7C%20Linux%20x64-支援-2f6070" alt="支援平台：Windows x64、Linux x64">
  <img src="https://img.shields.io/badge/license-MIT-lightgrey" alt="MIT License">
</p>

PaperRead 是以 EasyRead 為基礎整理的個人研究工具。它保留原有的 PDF 排版、雙語閱讀、原文定位、批註與 AI 對話能力，再加入研究探索和閱讀規劃流程，讓「找到論文」與「真正讀懂論文」接在同一個工作區裡。

## 這個版本和上游 EasyRead 的差異

| 面向 | PaperRead 的調整 |
|---|---|
| 介面語言 | 預設使用 `zh-TW`，介面用語根據臺灣語境做調整，例如「設定、匯入、匯出、儲存、資料夾、候選清單」。英文技術名詞與論文術語保留原文。 |
| 品牌與桌面程式 | 使用 PaperRead 名稱、新版標誌及 `YuriyLin` 發行者中繼資料；安裝檔為 `PaperRead-Setup-x.x.x.exe`。 |
| 論文閱讀 | 延續原文／譯文對照、公式、PDF 頁面定位、螢光筆、筆記、問 AI、模型切換和 token 使用量記錄。 |
| 研究流程 | 新增「研究探索、閱讀看板、候選清單、已整理摘要、閱讀路徑」工作區。 |
| 研究視覺化 | 可根據目前論文內容產生繁體中文 Mermaid 心智圖，協助理解研究問題、方法、發現、貢獻與限制。 |
| 智慧標註 | 可依全文、章節或研究目的產生 AI 標註建議；接受前先逐筆審閱，不會覆蓋手動標註。 |
| 影像與表格 | 論文圖片和表格保留版面佔位，直接回到原 PDF 查看；不把裁切結果硬塞進譯文排版。 |
| 資料相容性 | 使用者資料遷移至 `PaperRead` 資料夾；Python package、CLI、舊資料格式與 `easyread://` 連結協定仍保留相容層。 |

## 主要工作流程

```text
研究探索
    ↓
加入候選清單
    ↓
查看候選論文與背景摘要
    ↓
選擇要整理的論文
    ↓
產生／查看／匯出摘要
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

每張論文卡片只保留研究探索階段需要的操作：

- **加入候選**：先保存論文，不會立刻生成摘要或下載 PDF。
- **論文來源**：開啟可查證的出版頁、DOI 或來源連結。

## 閱讀看板

閱讀看板是研究探索頁面的主要工作區。論文可以拖曳到不同狀態欄位，狀態由使用者決定，不會因為開啟 PDF 或讀到最後一頁而自動改變。

預設狀態包含：

- 待閱讀
- 閱讀中
- 待整理
- 已完成

閱讀進度百分比獨立顯示，只代表閱讀位置，不代表已經理解或完成筆記。看板支援分類、PDF 可用性、感興趣標記與手動優先順序篩選；首頁、閱讀器研究面板和看板的星標會同步。

加入閱讀看板時，分類使用可複選的分類卡片，不需要使用鍵盤搭配下拉選單。一次可以將論文放入多個研究方向；沒有分類時也可以先加入看板，之後再整理。

## 候選清單

候選清單用來保存「值得之後研究」的論文。它會跨頁面保留，與閱讀看板及已整理摘要分開管理。

加入候選後，PaperRead 會在背景批次整理來源摘要。一次加入多篇時會排入佇列，避免同時發送大量請求。你仍然可以自行決定：

1. 查看候選論文。
2. 移除不再需要的論文。
3. 對個別論文重新整理摘要。
4. 查看 Markdown 摘要。
5. 使用「匯出摘要」保存檔案。
6. 將選定論文加入閱讀看板。

候選論文不會自動變成已讀，也不會自動覆蓋你的正式筆記。

## 已整理摘要

已整理摘要會獨立保存，即使論文之後移出候選清單，摘要仍可保留。摘要內容以 Markdown 儲存並使用與筆記一致的安全渲染方式，支援：

- 標題與副標題
- 粗體、斜體
- 有序與無序清單
- 程式碼區塊
- 表格
- 系統已支援的數學公式

主要操作順序是：

```text
查看摘要 → 重新整理摘要 → 匯出摘要 → 移到回收站
```

摘要由模型根據實際取得的論文資料產生；缺少的來源資訊會標示「未提供」，不捏造研究結果或出版資訊。

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

節點會盡量保持簡短，內容只使用目前論文提供的文字、公式和數據。生成中的狀態會顯示載入動畫，失敗時可以重試；生成後可在閱讀頁查看，也能透過筆記匯出流程一併匯出。

## 論文閱讀與 AI

PaperRead 的 Human Reading Interface 仍以原文核對為中心：

- 原文、譯文、AI 解釋和個人筆記分開顯示。
- 圖片與表格保留排版位置，點擊後回到原 PDF 查看。
- 螢光筆、下劃線、問題和筆記會綁定原文 block、頁碼與定位資訊。
- 可以選取文字後執行 AI 改寫，不會固定套用搜尋結果中的第一組詞。
- AI 回答和摘要都會顯示載入、失敗與重試狀態。

## 智慧標註

閱讀器的「筆記」面板提供「智慧標註」，用來找出值得回看的研究內容。分析前可以選擇：

- **全文**或指定章節。
- **AI 自動標註**、逐筆審閱的**AI 建議標註**，或依研究目的篩選。
- 是否輸入研究目的，例如「找出可用於 3D segmentation 的方法與限制」。

每筆建議都會顯示原文定位、頁碼、顏色、標註類型、AI 註記與標註原因。使用者可以逐筆接受、修改或拒絕，也可以批次接受已確認能定位的項目。未能可靠定位的內容會保留在待確認清單，不會直接套用到正文。

顏色有固定語意：黃色表示核心概念與主要主張，綠色表示方法與實作細節，藍色表示實驗證據與量化結果，紅色表示限制、失敗案例與待研究問題。接受後會沿用既有螢光筆或底線標註系統，不會覆蓋手動建立的標註。

AI 分析同時參考穩定的英文原文與目前的繁體中文譯文，正式標註優先落在中文譯文上。論文重新翻譯後，PaperRead 會重新檢查定位；無法確認的新位置會要求重新分析或人工修改，不會猜測座標。

匯出筆記時勾選「每條附上原文引用」，引文與注記會分開呈現：中文譯文放在 Markdown 引用區塊，使用者說明標示為「我的注記」，問題則標示為「我的問題」。

## 模型選擇

可在設定中選擇主流 API 或本地模型：

| 類型 | 例子 |
|---|---|
| 雲端 API | OpenAI、Anthropic、Google Gemini、DeepSeek、智譜 GLM、阿里雲百煉、Kimi、OpenRouter、Groq、Cerebras |
| 本地模型 | Ollama、LM Studio |
| 自訂介面 | OpenAI-compatible Chat Completions 或 Responses endpoint |

Ollama 使用本機 API，例如 `http://127.0.0.1:11434`。啟用 thinking 的模型會依模型支援的參數傳遞；只有支援布林值的模型會使用 `think: true/false`，不會強行送出不相容的 `low/high` 層級。

## 安裝與執行

### Windows 安裝檔

從 [PaperRead Releases](https://github.com/YuriyLin/PaperRead/releases/latest) 下載 `PaperRead-Setup-x.x.x.exe`。安裝程式會包含 Electron 桌面程式與打包好的 Python 後端，不需要另外安裝 Python 或 Node.js。

目前 Windows 安裝檔尚未使用程式碼簽署憑證，因此 Windows 可能顯示未驗證發行者提示。這不影響程式功能，但不等同於「已驗證的發行者」。

### Linux AppImage

從 [PaperRead Releases](https://github.com/YuriyLin/PaperRead/releases/latest) 下載 `PaperRead-x.x.x.AppImage`。Linux AppImage 會包含 Electron 桌面程式與打包好的 Python 後端；下載後加入執行權限即可：

```bash
chmod +x PaperRead-*.AppImage
./PaperRead-*.AppImage
```

目前正式 Release 提供 Linux x64 AppImage。macOS 尚未列入預建桌面安裝檔，仍可透過 Docker 瀏覽器版使用。

### Docker 瀏覽器版

Docker 版本適合 Linux、macOS 或 Windows 上沒有原生桌面安裝需求的情境。它啟動 PaperRead 網頁服務，論文庫與設定持久保存於 Docker volume：

```bash
git clone https://github.com/YuriyLin/PaperRead.git
cd PaperRead
docker compose up -d
```

接著開啟 <http://localhost:8765>。停止服務但保留資料可使用 `docker compose down`；重新啟動仍會使用同一個 `paperread-data` volume。

若 Ollama 執行在主機上，Docker Compose 已提供 `host.docker.internal` 對應，可在 PaperRead 設定中使用 `http://host.docker.internal:11434/v1`。不要把 PaperRead port 直接暴露到公網；若要給其他裝置使用，請另外設定防火牆與登入驗證的反向代理。

每個版本也會發布預建的 GitHub Container Registry 映像，不必在本機編譯：

```bash
docker pull ghcr.io/yuriylin/paperread:v1.4.6
docker run -d --name paperread --restart unless-stopped -p 8765:8765 -v paperread-data:/data/PaperRead ghcr.io/yuriylin/paperread:v1.4.6
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

輸出位於 `dist/electron/`。在 Windows 會產生 NSIS 安裝檔，在 Linux 會產生 AppImage。Docker 瀏覽器版則不需要 Electron 或 Node.js。

## 資料位置與相容性

安裝版預設將論文庫與設定放在：

```text
Windows: C:\Users\<使用者名稱>\PaperRead
Linux/macOS Docker: Docker volume `paperread-data` 內的 `/data/PaperRead`
```

舊版 `EasyRead` 資料會在首次啟動時嘗試遷移；若遷移失敗，程式會保留原資料並以相容方式讀取。為了避免破壞既有腳本與使用者資料，程式內部仍保留 `easyread` 的 Python module、CLI、環境變數和舊連結協定名稱。

## 開發與測試

前端使用原生 HTML、CSS、JavaScript，沒有額外的前端 build step；後端使用 Python。修改 `easyread/web/` 後重新整理頁面即可查看變更。

```bash
python -m unittest discover tests
node --test tests/test_*.cjs
python scripts/i18n_check.py
```

研究探索、繁中介面與資料格式說明：

- [Personal Research OS 使用說明](docs/personal-research-os.md)
- [資料格式](docs/data-format.md)
- [API 說明](docs/api.md)
- [貢獻指南](CONTRIBUTING.md)

## 授權

MIT License。公式渲染使用 [KaTeX](https://katex.org)，同樣採 MIT License。

PaperRead 是個人研究工具 fork；上游 EasyRead 的資料格式與相容性設計仍保留，詳細來源與貢獻者請參考 Git 歷史紀錄。
