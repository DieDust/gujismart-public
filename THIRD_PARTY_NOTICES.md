# Third-Party Notices

GujiSmart is licensed under the Apache License 2.0. The full project license is in [LICENSE](LICENSE), and project attribution is in [NOTICE](NOTICE).

This file documents third-party software and runtime files used by the project. It is intended as a practical attribution index; each third-party component remains governed by its own license.

## Bundled Runtime Components

### QPDF

- Location: `resources/vendor/qpdf/`
- Bundled version: 12.3.2, based on the included documentation.
- Purpose: PDF page counting, compression, validation, and low-memory page chunking for import and OCR workflows.
- License: Apache License 2.0.
- Upstream: <https://github.com/qpdf/qpdf>
- Included executables/libraries: `qpdf.exe`, `fix-qdf.exe`, `zlib-flate.exe`, `qpdf30.dll`
- Included license notice: `resources/vendor/qpdf/share/doc/qpdf/license.html`
- Included manual: `resources/vendor/qpdf/share/doc/qpdf/qpdf-manual.pdf`
- Attribution from the bundled QPDF documentation: Copyright 2005-2021 Jay Berkenbilt, 2022-2026 Jay Berkenbilt and Manfred Holger.

QPDF is used as an external command-line tool. If the bundled executable is unavailable, GujiSmart may fall back to a `qpdf` executable on `PATH` where supported by the runtime lookup path.

### Microsoft Visual C++ Runtime Files

- Location: `resources/vendor/qpdf/bin/`
- Files: `concrt140.dll`, `msvcp140.dll`, `msvcp140_1.dll`, `msvcp140_2.dll`, `msvcp140_atomic_wait.dll`, `msvcp140_codecvt_ids.dll`, `vcruntime140.dll`, `vcruntime140_1.dll`
- Purpose: Microsoft Visual C++ runtime files required by the bundled Windows QPDF binaries.
- License: Microsoft Visual C++ Redistributable runtime terms.

These DLLs are not part of GujiSmart's Apache-2.0 source license. They are included only to let the bundled Windows QPDF binaries run on machines that do not already have the matching runtime installed.

## Optional Downloaded Components

### PaddleOCR PP-OCRv6 Addon

- Location: user data directory, under `ocr-addons/pp-ocrv6-small/` after user opt-in.
- Main package status: not bundled in Setup or Portable builds.
- Purpose: optional local OCR using PaddleOCR PP-OCRv6 small.
- License: PaddleOCR is Apache License 2.0; model files remain governed by PaddlePaddle/PaddleOCR upstream terms.
- Upstream: <https://github.com/PaddlePaddle/PaddleOCR>
- Implementation notes: see [docs/OCR_ADDON.md](docs/OCR_ADDON.md).

## Direct Runtime npm Dependencies

The packaged app uses the following direct runtime dependencies from `package.json`. Transitive dependency details are recorded in `package-lock.json` and in each dependency package's own license metadata.

| Package | License |
| --- | --- |
| `@ant-design/icons` | MIT |
| `@electron-toolkit/utils` | MIT |
| `@napi-rs/canvas` | MIT |
| `@pdf-lib/fontkit` | MIT |
| `@types/archiver` | MIT |
| `@types/better-sqlite3` | MIT |
| `antd` | MIT |
| `archiver` | MIT |
| `better-sqlite3` | MIT |
| `brace-expansion` | MIT |
| `epubjs` | BSD-2-Clause |
| `extract-zip` | BSD-2-Clause |
| `fast-xml-parser` | MIT |
| `flexsearch` | Apache-2.0 |
| `jszip` | MIT OR GPL-3.0-or-later; GujiSmart uses it under the MIT option |
| `marked` | MIT |
| `nanoid` | MIT |
| `opencc-js` | MIT |
| `pdf-lib` | MIT |
| `pdfjs-dist` | Apache-2.0 |
| `react` | MIT |
| `react-dom` | MIT |
| `react-markdown` | MIT |
| `react-router-dom` | MIT |
| `react-window` | MIT |
| `rehype-raw` | MIT |
| `remark-gfm` | MIT |
| `zustand` | MIT |

## Development and Build Tools

These direct development dependencies are used for local development, tests, type checking, packaging, and release workflows.

| Package | License |
| --- | --- |
| `@types/react` | MIT |
| `@types/react-dom` | MIT |
| `@vitejs/plugin-react` | MIT |
| `electron` | MIT |
| `electron-builder` | MIT |
| `electron-vite` | MIT |
| `playwright` | Apache-2.0 |
| `typescript` | Apache-2.0 |
| `vite` | MIT |

## Generated Assets and Local Data

Generated build output, local databases, logs, user documents, OCR output from real libraries, and packaged installers are not source-distributed third-party components and should not be committed to the public repository.
