# Third-Party Notices

GujiSmart is licensed under the Apache License 2.0. The project also bundles the following third-party runtime component.

## QPDF

- Path: `resources/vendor/qpdf/`
- Purpose: PDF page counting, chunking, and compression helpers for large PDF OCR/import flows.
- Bundled platform: Windows x64 runtime files.
- License: Apache License 2.0.
- Included notice: `resources/vendor/qpdf/share/doc/qpdf/license.html`
- Included manual: `resources/vendor/qpdf/share/doc/qpdf/qpdf-manual.pdf`

QPDF is used as an external command-line tool. If the bundled executable is unavailable, GujiSmart falls back to a `qpdf` executable on `PATH` where supported by the current runtime path lookup.
