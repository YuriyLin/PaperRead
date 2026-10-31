# PaperRead

<p align="center">
  <img src="easyread/web/paperread-mark.png" width="72" alt="PaperRead">
</p>

<p align="center"><b>A local Personal Research OS for discovering, reading, auditing, and organizing academic papers.</b><br>
PaperRead combines multi-tab bilingual PDF close reading and original-page verification with research exploration, reading boards, reading paths, cross-paper keyword search, rich-text notes with live Markmap, AI deep technical audits, and structured Obsidian exports.</p>

> This is YuriyLin's PaperRead fork. It preserves the local reading and annotation model from EasyRead while expanding into a full research workspace with a Taiwan Traditional Chinese and English interface, Windows/macOS/Linux desktop packages, and a Docker browser edition.

<p align="center"><a href="README.md">繁體中文</a> · <b>English</b></p>

<p align="center"><a href="https://github.com/YuriyLin/PaperRead">Homepage</a> · <a href="https://github.com/YuriyLin/PaperRead/releases/latest">Download</a> · <a href="https://github.com/YuriyLin/PaperRead/issues">Issues</a></p>

<p align="center">
  <a href="https://github.com/YuriyLin/PaperRead/releases/latest"><img src="https://img.shields.io/github/v/release/YuriyLin/PaperRead?label=release" alt="release"></a>
  <a href="https://github.com/YuriyLin/PaperRead/actions/workflows/test.yml"><img src="https://github.com/YuriyLin/PaperRead/actions/workflows/test.yml/badge.svg" alt="tests"></a>
  <img src="https://img.shields.io/badge/Windows%20x64%20%7C%20macOS%20arm64%20%7C%20Linux%20x64-supported-2f6070" alt="Windows x64, macOS arm64, and Linux x64 supported">
  <img src="https://img.shields.io/badge/license-MIT-lightgrey" alt="MIT license">
</p>

PaperRead provides **Windows x64**, **macOS arm64**, and **Linux x64** desktop packages. The installer, DMG, and AppImage bundle the Electron application, Python backend, and required dependencies; Python and Node.js are not required for normal use. A Docker browser edition is also available for Linux, macOS, and Windows hosts.

---

## Feature Overview

PaperRead connects literature discovery, research planning, close reading, and knowledge base export in one local workspace:

| Module | Capabilities & Highlights |
| :--- | :--- |
| **Library & Multi-Paper Tabs** | Hierarchical `/` categories, recursive folder import, Zotero library migration, local PDF linking (without copying files), and an Archive view. The desktop shell supports **multi-paper tabs**, **drag-out 50/50 split-window reading**, category tab groups, auto-hide tab bar, and LRU memory virtualization (auto-sleeping inactive tabs beyond 5). |
| **Research Explorer** | Search by topic, conference, journal, year, and venue (`ICCV ECCV CVPR`, `MICCAI`, etc.) across OpenAlex, DBLP, and Crossref. Explore a paper's reference network, citing works, and related research while distinguishing published venues from preprints. |
| **Cross-Paper Keyword Search** | **1600px fluid master-detail layout** with height-aligned columns. Supports **bi-directional search across English original text and Chinese translations** with automatic glossary lookup. Excerpt cards render **KaTeX math formulas** alongside **authentic fluorescent keyword highlights**, accordion folding, and one-click jump to the exact paragraph in the reader. |
| **Reading Board & Quick Peek** | Drag-and-drop cards across **To Read**, **Reading**, **To Organize**, and **Completed**. Reading progress is tracked separately from completion status. Click any card's blank area to open the right-side **Quick Peek** drawer for metadata, summaries, recent notes, highlights, and questions. |
| **Candidates & Summaries** | Save promising papers to Candidates for queued background summary generation. Organized summaries are stored independently as Markdown and can be exported or imported into Obsidian. |
| **Reading Path & Comparison** | Generate ordered reading paths (foundations, method understanding, representative work, frontier research) with interactive **map/list views**, reading-order dashed arrows, and OpenAlex-verified citation solid arrows. Compare 2–5 papers across methods, costs, and limitations, tracked by a **global background task monitor**. |
| **Bilingual Reader & Lightbox** | Sentence-aligned bilingual reading, nested TOC indentation, separated footnotes (`[^n]`) and bibliography citations (`[n]`), and a transparent PDF text layer. Figure and table placeholders preserve original layout: click the placeholder to locate on the side PDF, or click the **magnifier button** to open a **full-screen original-page lightbox** automatically zoomed and scrolled to the target figure/table. |
| **Glossary & My Keywords Drawer** | **Inline glossary editing**: click any translated term in the left drawer, edit, and press `Enter` to replace across the full paper with animated `✓` feedback. **My Keywords**: streamlined top quick-add bar with automatic bi-directional glossary matching. |
| **Ink, Lasso & Sticker Assets** | Freehand drawing layer with multi-color pens, smart eraser, **freehand lasso selection**, text boxes, and undo/redo. Built-in **Lucide academic icons and Mega Doodles illustrations** with double-click center insertion, 8-handle resizing (corner & edge), rotation, custom stroke styling, and URL links. |
| **Rich-Text Notes & Markmap** | Full-paper note editor powered by **Tiptap WYSIWYG + Markdown two-way sync** (tables, KaTeX math, task lists, code blocks) paired with a live **Markmap mind map** featuring two-way cursor synchronization and SVG export. |
| **AI Deep Technical Audit & Mind Map** | **Deep Technical Audit (`04-論文深度剖析`)**: 5-dimension objective review covering Claim-Evidence alignment, Ablation Audit, Micro-Formula Derivations & Toy Examples, Baseline Fairness, and Blind Spots. **Mind-Elixir interactive mind map** with full-screen pan/zoom, KaTeX math, dynamic target-language generation, and PNG/outline export. |
| **Smart Annotations & Multimodal Chat** | **Smart Annotations**: 3 density levels (*Concise*, *Standard*, *Detailed*) and a 2×4 semantic legend separating sentence highlighters from phrase underlines. **Ask AI**: toggle between Standard and Concise answers, paste up to 4 **clipboard images** for multimodal Q&A, pin answers to the left margin (with cross-thread fallback lookup), or export single answers. |
| **Unified Export & Obsidian Vault** | Single export hub for notes, highlights, questions, margin AI explanations, chat history, mind maps, and deep technical audits. Writes into a 6-folder structured Obsidian Vault (`01` through `06`) with stable IDs, SHA-256 verification, and preserved manual sections. |
| **AI Models & Local CLI** | Supports **Antigravity CLI (`agy`)** (local model discovery & reasoning effort controls), Claude Code, Codex CLI, cloud APIs (OpenAI `o1`/`o3-mini` compatible, Anthropic, Gemini, DeepSeek, GLM, Kimi, OpenRouter, Groq), and local endpoints (Ollama, LM Studio). |

---

## Typical Workflow

```text
Research Explorer (Topic / Venue Search / Citation Network)
    ↓
Candidates (Queued background summary generation)
    ↓
Reading Board (4-stage drag & drop + Quick Peek drawer)
    ↓
Reading Path Map / Bi-directional Cross-Paper Keyword Search / Multi-Paper Comparison
    ↓
Multi-Tab & 50/50 Split-View Reader
    ├── Full-Screen Figure Lightbox (Auto-zoom & target scroll) & Inline Glossary Edit
    ├── Freehand Ink, Lasso Selection & 8-Handle Academic Stickers
    ├── Smart Annotations (3 intensity levels) & Multimodal Clipboard Image Chat
    └── Deep Technical Audit Report & Mind-Elixir / Markmap Mind Maps
    ↓
Unified Export Hub (Markdown / ZIP download or 6-Folder Obsidian Vault sync)
```

---

## Multi-Paper Tabs & Split-Window Reading

- **Multi-Tab Workspace**: Keep your library and multiple papers open in a single window. Switch tabs with `Ctrl+Tab`, close with `Ctrl+W`, reorder by dragging, or batch-manage tabs with `Ctrl`/`Shift` selection.
- **50/50 Split View**: Drag any paper tab outside the window to automatically snap the main window to the left half of the screen and the new window to the right half for side-by-side comparison. Drag the tab back onto the tab bar to merge seamlessly.
- **Category Tab Groups & Auto-Hide**: Tabs automatically group by paper category with color-coded collapsible chips. Enable **Auto-Hide Tab Bar** to maximize vertical reading space, revealing the bar smoothly when hovering near the top edge.
- **Memory Virtualization**: Inactive background tabs freeze rendering, and when more than 5 tabs are open, the least-recently-used tabs automatically enter a low-memory sleep state and restore their exact scroll position when clicked.

---

## Cross-Paper Keyword Search & Excerpt Navigation

- **Bi-directional English/Chinese Indexing**: Add keywords from selected text, glossary items, or the top quick-add bar. Entering either a Chinese term or an English original term automatically resolves its counterpart from your library's translation glossaries. Search scans both English original blocks and Chinese translated blocks across all parsed papers.
- **KaTeX Math & Fluorescent Highlights**: In `/research?mode=keywords`, the right pane displays matching papers in a clean accordion layout (showing the top 2 excerpts by default, expandable on demand). Excerpt blockquotes safely render inline and display **KaTeX math expressions** (e.g., `$384 \times 384$`, `$\sim 2$`) while highlighting matched terms with a warm amber fluorescent marker. Click anywhere on an excerpt card to open the paper and scroll directly to that paragraph.

---

## Reading, Original-Page Lightbox & Annotations

- **Original-Page Figure & Table Lightbox**: PaperRead intentionally avoids auto-cropping figures so multi-panel layouts and labels are never cut off. Clicking a figure/table placeholder opens the side PDF panel; clicking the **magnifier button** in the top-right corner of the placeholder opens a **full-screen high-resolution page lightbox** automatically zoomed (~95%) and scrolled directly to the figure or table's bounding box.
- **Deep Technical Audit**: Located in the reader's **Research Context** drawer, AI performs an objective 5-part technical audit (Claim vs. Evidence alignment, Ablation study audit, Micro-formula derivations & toy examples, Experimental/baseline fairness, and Limitations/blind spots).
- **Smart Annotations**: Choose between *Concise*, *Standard*, and *Detailed* annotation density. Suggestions use a 4-color semantic system (Yellow: core claims, Green: methods, Blue: quantitative evidence, Red: limitations/open questions) and distinguish whole-sentence highlighters from phrase underlines.

---

## Unified Export & Obsidian Vault Structure

Click **Export Notes** in the reader top bar to download Markdown/ZIP archives or sync directly into your configured Obsidian Vault under `Research/`:

```text
<Obsidian Vault>/Research/
├── 01-論文分析/          # Single-paper bibliographic metadata, DOI, and full-paper notes
├── 02-心智圖/            # Paper mind map Markdown outlines and high-res PNG images
├── 03-閱讀標註/          # Per-paper folders: Single AI Answers, All AI Q&A, My Highlights, My Notes
├── 04-論文深度剖析/      # 5-dimension objective Deep Technical Audit reports
├── 05-跨論文比較/        # Multi-paper comparison reports (methods, costs, limitations)
└── 06-論文摘要/          # Organized paper summaries
```

---

## Installation & Running

### Windows, macOS & Linux Desktop Packages
- **Windows (x64)**: Download `PaperRead-Setup-x.x.x.exe` from [Releases](https://github.com/YuriyLin/PaperRead/releases/latest).
- **macOS (Apple Silicon arm64)**: Download `PaperRead-x.x.x-arm64.dmg` from [Releases](https://github.com/YuriyLin/PaperRead/releases/latest) and drag PaperRead to `Applications`.
- **Linux (x64)**: Download `PaperRead-x.x.x.AppImage` from [Releases](https://github.com/YuriyLin/PaperRead/releases/latest), run `chmod +x PaperRead-*.AppImage && ./PaperRead-*.AppImage`.

### Docker Browser Edition
```bash
git clone https://github.com/YuriyLin/PaperRead.git
cd PaperRead
docker compose up -d
```
Then open <http://localhost:8765>. Or pull the prebuilt image from GitHub Container Registry:
```bash
docker pull ghcr.io/yuriylin/paperread:latest
docker run -d --name paperread --restart unless-stopped -p 127.0.0.1:8765:8765 -v paperread-data:/data/PaperRead ghcr.io/yuriylin/paperread:latest
```

### Run from Source
Requires Python 3.10+, Node.js 22+, and PyInstaller:
```bash
python -m pip install -e .
python -m pip install pyinstaller
npm install

# Start web server at http://127.0.0.1:8765
python -m easyread serve --port 8765

# Or launch Electron desktop shell
npm run dev

# Build desktop installers into dist/electron/
npm run dist
```

---

## Development & Verification

```bash
pytest tests/
node --test tests/test_*.cjs
python scripts/i18n_check.py
```

---

## License & Credits

The code is MIT licensed. Math rendering uses [KaTeX](https://katex.org) (MIT). Sticker assets have separate licenses: Lucide icons are ISC (with MIT for Feather-derived icons); [Mega Doodles Pack](https://github.com/MariaLetta/mega-doodles-pack) by Maria Letta is [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). See the [asset overview](data/stickers/README.md) and [license manifest](data/stickers/license-manifest.json) for full details.
