# Folder Menu and Export Count Consistency Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use systematic debugging and TDD while implementing each task.

**Goal:** Keep folder-page document actions consistent with the Library context menu and make search-export progress/counts describe one unambiguous unit.

**Architecture:** Extract the recursive add-to-folder submenu into a renderer-shared helper used by both LibraryView and FoldersView. FoldersView keeps its context-specific move/remove actions, but common add-to-folder behavior, hierarchy, labels, and scrolling remain shared. Search export keeps raw-hit processing and paragraph deduplication, while UI text explicitly distinguishes fast search totals, exhaustive raw hits, and exported paragraphs.

**Tech Stack:** Electron, React, TypeScript, Ant Design, Node regression scripts.

---

### Task 1: Regression coverage

**Files:**
- Modify: `scripts/library-folder-menu-regression.js`
- Modify: `scripts/folder-management-regression.js`
- Modify: `scripts/search-export-limit-regression.js`

1. Assert LibraryView and FoldersView import the same recursive folder menu helper.
2. Assert FoldersView exposes top-level single/batch add-to-folder actions while retaining move and remove-current actions.
3. Assert export progress and completion messages distinguish raw hits from exported paragraphs and avoid duplicate counters.
4. Run the focused scripts and confirm they fail before implementation.

### Task 2: Shared folder actions

**Files:**
- Create: `src/renderer/src/utils/documentFolderMenu.tsx`
- Modify: `src/renderer/src/views/LibraryView.tsx`
- Modify: `src/renderer/src/views/FoldersView.tsx`

1. Move the recursive parent/child folder menu builder into the shared utility.
2. Use the shared helper in LibraryView for single and batch context menus.
3. Centralize FoldersView document-menu construction and click routing.
4. Add direct membership assignment through `addDocumentsToFolder` without removing the existing move/remove workflows.
5. Run folder-focused regressions until green.

### Task 3: Export count semantics

**Files:**
- Modify: `src/main/ipc/search.ts`
- Modify: `src/renderer/src/views/SearchView.tsx`
- Modify: `CHANGELOG.md`

1. Label worker totals as raw search hits.
2. Label output totals as exported complete paragraphs/evidence.
3. Explain that normal search uses a fast count while “All” export performs an exhaustive scan.
4. Remove the duplicate numeric suffix from progress text.
5. Run search-export regressions until green.

### Task 4: Verification and local package

1. Run `npm run check`.
2. Run `npm audit` and `npm audit --omit=dev`.
3. Run `npm run build:win` and `npm run smoke:packaged`.
4. Verify installer hashes and `git diff --check`.
5. Commit locally only; do not push, tag, or create a GitHub Release.
