# PaperRead

<p align="center">
  <img src="easyread/web/paperread-mark.png" width="72" alt="PaperRead">
</p>

<p align="center"><b>A local research workspace for discovering, reading, and organizing papers.</b><br>
PaperRead combines a comfortable PDF reading experience with research exploration, candidate management, reading progress, AI-assisted summaries, reading paths, and paper mind maps.</p>

> This is YuriyLin's PaperRead fork. It keeps the useful local reading and annotation model from EasyRead while adding a Traditional Chinese interface, a research workspace, Windows/macOS/Linux desktop packages, and a Docker browser edition.

<p align="center"><a href="README.md">繁體中文</a> · <b>English</b></p>

<p align="center"><a href="https://github.com/YuriyLin/PaperRead">Homepage</a> · <a href="https://github.com/YuriyLin/PaperRead/releases/latest">Download</a> · <a href="https://github.com/YuriyLin/PaperRead/issues">Issues</a></p>

<p align="center">
  <a href="https://github.com/YuriyLin/PaperRead/releases/latest"><img src="https://img.shields.io/github/v/release/YuriyLin/PaperRead?label=release" alt="release"></a>
  <a href="https://github.com/YuriyLin/PaperRead/actions/workflows/test.yml"><img src="https://github.com/YuriyLin/PaperRead/actions/workflows/test.yml/badge.svg" alt="tests"></a>
  <img src="https://img.shields.io/badge/Windows%20x64%20%7C%20macOS%20arm64%20%7C%20Linux%20x64-supported-2f6070" alt="Windows x64, macOS arm64, and Linux x64 supported">
  <img src="https://img.shields.io/badge/license-MIT-lightgrey" alt="MIT license">
</p>

PaperRead provides **Windows x64**, **macOS arm64**, and **Linux x64** desktop packages. The installer, DMG, and AppImage bundle the Electron application, Python backend, and required dependencies; Python and Node.js are not required for normal use. Docker is also available for Linux, macOS, and Windows hosts.

## Feature overview

PaperRead brings literature management, close reading, and research planning into one local workspace:

| Area | PaperRead behavior |
|---|---|
| **Research Explorer** | Search by topic, conference, journal, year, and venue. Multiple venues can be entered together, such as `ICCV ECCV CVPR`, or a single venue such as `MICCAI`. |
| **Reading Board** | Move papers by drag and drop between **To read**, **Reading**, **To organize**, and **Completed**. Reading progress and the interest star are independent and remain synchronized with the library and reader. |
| **Candidates** | Keep a separate list of papers worth reviewing. Adding a candidate does not silently replace the search results or force a download. |
| **Organized Summaries** | Generate and review a paper summary when you choose, render it as Markdown, and export it for later use. Summaries can be removed to the recycle bin. |
| **Reading Path** | Start from a topic or a selected paper and organize recommended papers by purpose, such as foundations, method understanding, representative work, extensions, and frontier research. The result has map/list views, citation relations, reordering, and background notifications. |
| **Cross-paper Keywords** | Collect selected text or glossary terms as separate keywords, match the configured original-language term across the current library, filter papers with AND/OR logic, and jump directly to matching excerpts in the reader. |
| **Quick Peek** | Open a right-side drawer from a board card to inspect overview, summary, recent notes, highlights, and recent questions without leaving the board. Status, category, and star can be edited in place. |
| **Obsidian knowledge base** | Export summaries, paper analysis, annotations, mind maps, and comparisons directly into a Vault with stable IDs, evidence, and WikiLinks. |
| **Literature management** | Organize papers with nested categories; import folders or a Zotero library; link local PDFs without copying them. |
| **Background jobs** | Track import progress, confirm before translating large batches, and stop queued or running translation jobs. |
| **Reader improvements** | Add and erase mouse-drawn notes with undo/redo and autosave; render LaTeX in titles and abstracts; export a mobile-friendly HTML copy. |
| **AI models** | Add Antigravity CLI as a model source, with local model discovery and reasoning effort controls. |
| **Answer styles** | Toggle between standard and plain answers. Plain answers use short sentences and lists and may consume more tokens because paper content is included. |
| **Reliability and updates** | Isolate damaged paper data so one item does not break the library; download desktop updates in the background and restart when ready. |
| **Linux/Docker compatibility** | Fix reader navigation and paragraph toolbar actions in Docker on Linux Firefox, and use bundled/system trust for research API queries in packaged macOS builds. |
| **Paper Mind Map** | Ask AI to turn the current paper into a Traditional Chinese Mermaid mind map covering the research question, method, findings, contribution, and limitations. |
| **Smart Annotations** | Generate reviewable AI highlight or underline suggestions for the full paper, a section, or a research purpose. Suggestions never overwrite manual annotations before you accept them. |

The interface is localized for Taiwan Traditional Chinese usage. English technical terms such as `OpenAlex`, `Ollama`, `Mermaid`, model names, and API names remain unchanged where that improves clarity. Translation language and interface language are separate settings.

## Typical workflow

1. Open **Research Explorer** and search a topic or one or more venues.
2. Add promising papers to **Candidates**. Results from different sources are merged and duplicate papers are removed.
3. Review the candidate list and choose which papers need a summary. Summary generation and export are explicit user actions.
4. Move papers on the **Reading Board** to set the reading order and progress.
5. Open a paper in the reader to highlight, annotate, ask questions, and verify the original PDF.
6. Generate a **Reading Path** or a **Paper Mind Map** when you need a broader view of the research area.

When adding a paper to the Reading Board, categories are shown as selectable cards rather than a keyboard-dependent multi-select list. You can assign multiple research directions at once, or add the paper without a category and organize it later.

Clicking the empty area of a board card opens **Quick Peek** on the right. It shows bibliographic details, summary, category, reading status, star, progress, source information, recent notes, highlights, and recent questions. Clicking a record returns to its reader anchor; the drawer footer provides previous, next, and continue reading actions.

## Cross-paper keyword search and excerpt navigation

The reader collects a keyword from selected text or checked glossary entries. A keyword has a display name and an original-text match term, so it remains separate from translation glossary replacements. PaperRead scans parsed original text only within the active library and records source locations; an automatic match only means the configured text occurs, not that the paper supports a research claim.

Use the **Keywords** tab in Research Explorer (`/research?mode=keywords`) to combine selected terms with AND/OR filtering, view matching papers with highlighted excerpt cards, and click **Open Paper and Locate Paragraph ↗** to jump directly to the paragraph in the reader. You can also exclude unwanted automatic matches persistently, manage keyword archives, and quickly add new keywords.

## Reading and evidence

PaperRead keeps translated text, AI explanations, and personal notes as separate data. Figures and tables preserve their layout as placeholders in the reading view; open the original PDF to inspect the source image or table. This avoids presenting a cropped screenshot or an unverified translation as the original evidence.

The local library stores paper metadata, PDF files, page data, block identifiers, translations, highlights, notes, discussions, and chat history. Existing EasyRead data is kept compatible where possible, and PaperRead data is stored under the `PaperRead` user folder.

## Smart annotations

The reader's Notes panel provides **Smart Annotations** for finding research-relevant passages. Before starting, choose:

- the **full paper** or a selected section;
- **automatic annotations**, reviewable **suggestions**, or annotations guided by a research purpose;
- an optional purpose such as `Find methods and limitations relevant to 3D segmentation`.

Each suggestion shows its page, location status, color, highlight or underline type, AI note, and reason. You can accept, edit, or reject suggestions one by one, or accept all suggestions that have been safely located. Unlocatable text remains pending for review instead of being applied to an uncertain position.

Colors have stable meanings: yellow for core concepts and claims, green for methods and implementation details, blue for experiments and quantitative evidence, and red for limitations, failure cases, assumptions, and open questions. Accepted suggestions use the existing annotation system and never overwrite manual annotations.

The analysis uses the stable English source together with the current Traditional Chinese translation, then places accepted annotations on the Chinese reading text when it can verify the location. After a retranslation, PaperRead rechecks the anchors; it asks for another analysis or manual editing when the new location cannot be confirmed.

When **Quote the original with each item** is enabled during Markdown export, the quote and the user's note are separated clearly: the translated passage is rendered as a Markdown blockquote, followed by **My note** or **My question**.

## Models and AI services

PaperRead can use configured cloud APIs, CLI-based model services, or local OpenAI-compatible endpoints. Common options include OpenAI/Codex, Anthropic, Gemini, DeepSeek, Zhipu GLM, SiliconFlow, Ollama, LM Studio, and custom endpoints. Local models can be selected from the model list when the service is running, for example an Ollama model at `http://127.0.0.1:11434`.

Model availability, rate limits, and response formats depend on the selected provider. Basic reading, the library, the candidate list, and the board remain usable when an AI provider is unavailable. AI-generated summaries, reading paths, and mind maps should be reviewed against the original paper before being used as research conclusions.

The map/list view supports zoom, pan, node selection, and moving a paper earlier or later in the reading order. Dashed arrows represent the suggested reading order; solid arrows represent in-map citation relations that OpenAlex can verify. Reading-path and paper-comparison analysis run in the background, so closing the dialog or changing pages does not cancel them. PaperRead notifies you when a result is ready instead of forcing navigation.

Paper comparisons preserve research questions, core methods, cost, limitations, differences, evaluation conditions, and candidate questions. They can be exported to `Research/05-跨論文比較` in Obsidian. If a selected paper has not yet been exported as a single-paper note, the comparison can still be generated, but its WikiLink may be created after the single-paper note is exported.

Summaries can be imported directly into an Obsidian Vault under `Research/06-論文摘要`. Filenames use a shortened English paper title and do not create an extra child folder. Downloading one item produces Markdown; downloading multiple items produces a ZIP with the full folder structure.

## Install on Windows

Download the latest `PaperRead-Setup-x.x.x.exe` from [Releases](https://github.com/YuriyLin/PaperRead/releases/latest). The installer supports per-user installation, lets you choose the install directory, and can create a desktop shortcut. The installer is currently not code-signed, so Windows SmartScreen may require **More info → Run anyway** after you verify that the file came from this repository.

For development, install Python 3.10+ and run `start.cmd` from the repository root. The local service listens on `127.0.0.1`; paper files and settings remain on the local machine unless a configured model service receives selected content for translation or AI analysis.

## Install on Linux

Download `PaperRead-x.x.x.AppImage` from [Releases](https://github.com/YuriyLin/PaperRead/releases/latest), then make it executable and launch it:

```bash
chmod +x PaperRead-*.AppImage
./PaperRead-*.AppImage
```

The AppImage is the supported Linux x64 desktop package.

## Install on macOS

The latest release includes a prebuilt DMG for Apple Silicon (arm64). Download `PaperRead-x.x.x-arm64.dmg` from [Releases](https://github.com/YuriyLin/PaperRead/releases/latest), open it, and drag PaperRead to Applications. Intel Macs should use the Docker edition or build from source for their target architecture.

## Run with Docker

The Docker edition runs PaperRead as a local web service and works on Linux, macOS, and Windows with Docker Desktop. From a checkout of this repository:

```bash
docker compose up -d
```

Open <http://localhost:8765>. The Compose file stores the library and settings in the named `paperread-data` volume, so `docker compose down` does not remove your data. If Ollama runs on the host machine, use `http://host.docker.internal:11434/v1` as its OpenAI-compatible endpoint; the included Compose configuration provides the host mapping. PaperRead has no login, so the Compose file publishes the port on `127.0.0.1` only. To use it from other devices, put an authenticating reverse proxy in front of it; if you deliberately open it on your LAN, change the port mapping to `"8765:8765"` and list the hostnames or IPs you will use in `PAPERREAD_ALLOWED_HOSTS` (comma-separated), otherwise requests are rejected by the Host check. Never expose the port directly to the public Internet.

Each release also publishes a prebuilt image to GitHub Container Registry:

```bash
docker pull ghcr.io/yuriylin/paperread:v1.5.0
docker run -d --name paperread --restart unless-stopped -p 127.0.0.1:8765:8765 -v paperread-data:/data/PaperRead ghcr.io/yuriylin/paperread:v1.5.0
```

Open <http://localhost:8765>. The `paperread-data` volume keeps the library and settings between container restarts.

## Development

The web interface uses plain HTML, CSS, and JavaScript. The backend is Python and the desktop shell is Electron. Useful checks include:

```bash
python -m unittest discover tests
node --test tests/test_*.cjs
python scripts/i18n_check.py
```

Browser E2E is not run automatically for PaperRead UI changes. Manually verify the reading path, background notifications, Quick Peek, reader panels, and Obsidian export flows after code-level checks pass.

To create the Windows installer, macOS arm64 DMG, or Linux AppImage after testing locally:

```bash
npm run dist
```

## License

The code is MIT licensed. Math rendering uses [KaTeX](https://katex.org) (MIT). Sticker assets have separate licenses: Lucide icons are ISC, with MIT for some Feather-derived icons; [Mega Doodles Pack](https://github.com/MariaLetta/mega-doodles-pack) by Maria Letta is [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). See the [asset overview](data/stickers/README.md) and [license manifest](data/stickers/license-manifest.json) for sources, modification status, and license texts.

## Contributors

- [@YuriyLin](https://github.com/YuriyLin) — PaperRead fork, Traditional Chinese interface, research workspace, reading workflow, Windows desktop packaging, and release maintenance
- [@Wang-auspicious](https://github.com/Wang-auspicious) — upstream Electron desktop packaging and release workflow
- [@bisuwuss-netizen](https://github.com/bisuwuss-netizen) — upstream PDF dependency, page locating, Markdown rendering, and streaming fixes
- [@MeshedPoto](https://github.com/MeshedPoto) — upstream PDF translation, highlighting, macOS reliability, and math rendering fixes
- [@Lzy22301093](https://github.com/Lzy22301093) — upstream table validation and rendering resilience
