# Roadmap

GujiSmart is maintained as a local-first research workstation for literature management, OCR correction, evidence search, excerpt collection, citation formatting, and source-backed AI synthesis.

## Product Direction

- Keep the main workflow focused: import documents, run OCR, correct pages, search evidence, save excerpts, organize research projects, and export writing material.
- Treat AI features as research assistance, not source-of-truth generation. Answers and syntheses should preserve document/page evidence wherever possible.
- Keep local privacy expectations clear: documents, OCR results, notes, settings, and backups remain local unless the user configures external OCR or AI services.

## Current Foundations

- Electron, React, TypeScript, Vite, Ant Design, and `better-sqlite3`.
- Modular IPC handlers under `src/main/ipc/`.
- Document library, tags, folders, saved search, citation templates, OCR, AI panel, batch queue, backup and restore.
- Research projects, excerpts, project documents, AI outputs, and reference export.
- Shared DTOs in `src/shared/types.ts` for main/preload/renderer boundaries.
- Open-source hygiene gates through `npm run check`.

## Near-Term Milestones

- Tighten shared types for remaining broad IPC surfaces such as document lists, folder/tag payloads, and AI task results.
- Split oversized renderer modules into smaller domain components, starting with `LibraryView`, `DocumentView`, and `SourcePageReader`.
- Improve metadata quality warnings and document-health review flows.
- Add richer project export formats and more regression coverage around research IPC, citation export, and reader state.
- Keep experimental proofreading and manual corpus QA scripts clearly isolated from default test paths.

## Quality Rules

- Keep source files UTF-8 clean.
- Prefer shared types from `src/shared/types.ts` over view-local DTO copies.
- Keep renderer payloads in camelCase unless they intentionally model database rows.
- Keep database row shapes in snake_case at the storage boundary.
- Do not commit real databases, real document corpora, user-data directories, logs, API keys, or local absolute paths.
- Run `npm run check` and `npm run build` before publishing or opening a pull request.
