# Changelog

## 1.0.2 - 2026-06-15

### Improvements

- Improved OCR import and batch processing stability, including queue recovery, progress reporting, PDF upload handling, and OCR result saving.
- Added legacy database maintenance guidance for users upgrading from older search-index versions.
- Added required legacy database upgrade flow that cleans old search indexes, compacts the database, and then continues lightweight index rebuilding in the background.
- Reduced large-library overhead by avoiding repeated full sidebar/statistics refreshes and by improving cached library state handling.
- Improved large database storage maintenance with safer diagnostics, old index cleanup, lightweight search index rebuilding, and manual database compaction.
- Hardened build tool dependencies so both full and production dependency audits pass.

### Fixes

- Fixed OCR incomplete filtering so documents with existing recognized pages are not incorrectly counted as unrecognized.
- Fixed repeated “one-click search index slimming” after old indexes have already been cleaned. The button is disabled when no legacy index cleanup is needed, and the backend no longer queues a redundant full rebuild.
- Fixed startup maintenance guidance so old databases must be upgraded and compacted before continuing.
- Fixed several source reader image, page initialization, import queue, OCR progress, OCR layout deduplication, and search-index consistency regressions.

### Downloads

- `GujiSmart-1.0.2-Setup-x64.exe` for normal Windows installation.
- `GujiSmart-1.0.2-Portable-x64.exe` for portable use.

## 0.9.9 - 2026-06-11

- Initial open-source release.
