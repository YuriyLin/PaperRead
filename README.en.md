<p align="center"><img src="easyread/web/paperread-mark.png" width="88" alt="PaperRead"></p>

# PaperRead

A personal research workspace for discovering, reading, and connecting papers.

[Download PaperRead](https://github.com/YuriyLin/PaperRead/releases/latest) · [繁體中文](README.md) · [Report an issue](https://github.com/YuriyLin/PaperRead/issues)

![Platforms](https://img.shields.io/badge/Windows_x64%20%7C%20macOS_arm64%20%7C%20Linux_x64-supported-2f6070) ![MIT](https://img.shields.io/badge/license-MIT-lightgrey)

Built on EasyRead, PaperRead brings literature discovery, reading, source verification, and notes into one local workspace.

![Bilingual reader and original PDF page](docs/images/readingpage.jpg)

## Why PaperRead?

Search results, reading progress, and research notes often live in separate tools. PaperRead helps you choose what to read, stay connected to the original paper, and carry your work into your own knowledge base.

## Four research modules

### 01 · Discover & Organize

Find papers, collect candidates, plan reading, and explore connections.

![Reading board](docs/images/researchspace.jpg)

| Feature | Purpose |
| --- | --- |
| Research exploration | Search topics, venues, and related papers |
| Candidates and reading board | Organize papers, status, and progress |
| Reading paths | Explore reading order and citation relationships |

### 02 · Read & Annotate

Read translations alongside the original and capture your thoughts.

![Stickers and annotations in the reader](docs/images/sticker.jpg)

| Feature | Purpose |
| --- | --- |
| Tabs and split view | Switch between or compare papers side by side |
| Bilingual reading and page lightbox | Check text, formulas, figures, and original pages |
| Ink, stickers, and text boxes | Annotate, select with a lasso, and group objects |
| Reading notes | Write in rich text or Markdown |

### 03 · Analyze & Connect

Move from individual papers to comparisons, with the source close at hand.

| Feature | Purpose |
| --- | --- |
| Cross-paper search | Search originals and translations and jump to passages |
| Deep analysis and comparison | Examine methods, evidence, experiments, and limits |
| Mind maps and AI chat | Explore structure and ask questions about a paper |

### 04 · Build Your Knowledge Base

Keep your work in files you can continue to use.

| Feature | Purpose |
| --- | --- |
| Obsidian export | Export notes, annotations, and reports with WikiLinks |
| Markdown and JSON | Organize, back up, and manage research data |

## AI model support

| Type | Supported options |
| --- | --- |
| Local CLI | Antigravity CLI, Claude Code, Codex CLI |
| Cloud APIs | OpenAI, Claude, Gemini, DeepSeek, and others |
| Local models | Ollama, LM Studio |

AI is optional. Library management, PDF reading, ink annotations, and knowledge organization work without a configured model. Translation, AI chat, and analysis require one.

## Installation

Download from [Releases](https://github.com/YuriyLin/PaperRead/releases/latest):

- **Windows x64:** run the Setup installer.
- **macOS Apple Silicon:** open the arm64 DMG and drag the app to Applications.
- **Linux x64:** download the AppImage and run `chmod +x PaperRead-*.AppImage` before launching it.

Docker browser edition:

```bash
git clone https://github.com/YuriyLin/PaperRead.git
cd PaperRead
docker compose up -d
```

Open http://localhost:8765. See the [contributing guide](CONTRIBUTING.md) for development and running from source.

## Data & privacy

The library is stored locally by default: `C:\Users\<user>\PaperRead` on Windows and `~/PaperRead` on macOS/Linux. Papers and annotations are stored as JSON and other files you can back up or manage with Git. Cloud models and literature search send relevant content to the selected services; choose them according to your needs.

## Documentation & contribution

- [User guide](docs/index.html) · [System design](docs/design.md) · [Data format](docs/data-format.md) · [API](docs/api.md) · [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md) · [Issues and suggestions](https://github.com/YuriyLin/PaperRead/issues)

Contributions, bug reports, and feedback on research workflows are welcome.

## License & credits

The code is licensed under the [MIT License](LICENSE) and builds on [EasyRead](https://github.com/Edwardxlai/easyread). Sticker assets have separate licenses: Lucide uses ISC, some Feather icons use MIT, and Mega Doodles Pack uses CC BY-SA 4.0. See the [sticker overview](data/stickers/README.md) and [license manifest](data/stickers/license-manifest.json).
