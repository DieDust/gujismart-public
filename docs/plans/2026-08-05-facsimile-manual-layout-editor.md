# Facsimile Manual Layout Editor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a durable manual page-layout editor with Excel-style table editing, typed text/image blocks, blank-page insertion, and consistent rendering/search/export behavior.

**Architecture:** Keep `ocr_result.layout_result` as the canonical page-layout source and add stable IDs plus typed manual metadata to blocks. The renderer owns a revisioned local draft and merges acknowledged page updates instead of resetting selection; new main/preload IPCs handle blank-page insertion and managed image cropping. Every read/search/export path consumes shared block normalization and text projection helpers so manual edits remain consistent across the application.

**Tech Stack:** Electron, React, TypeScript, Ant Design, SQLite/better-sqlite3, Electron `nativeImage`, existing GujiSmart OCR IR and regression scripts.

---

### Task 1: Add the canonical manual block model and text projection

**Files:**
- Create: `src/shared/manual-layout.ts`
- Modify: `src/shared/types.ts:1932-1939`
- Modify: `src/shared/ocr-ir.ts`
- Create: `scripts/manual-layout-blocks-regression.js`
- Modify: `package.json`

**Step 1: Write the failing regression**

Create a regression that imports the shared helper and verifies:

```js
const blocks = [
  { manual_block_id: 'm-text', label: 'note', words: '夹注内容', reading_order: 1 },
  { manual_block_id: 'm-table', label: 'table', rows: [['甲', '乙'], ['丙', '丁']], reading_order: 2 },
  { manual_block_id: 'm-image', label: 'image', caption: '图一', reading_order: 3 },
]

assert.strictEqual(projectManualLayoutText(blocks), '夹注内容\n甲\t乙\n丙\t丁\n图一')
assert.strictEqual(getManualBlockId(blocks[0]), 'm-text')
assert.ok(isManualLayoutBlock(blocks[0]))
```

Also verify that empty image blocks do not invent OCR text and that unknown legacy OCR blocks remain readable.

**Step 2: Run the regression and verify failure**

Run: `node scripts/manual-layout-blocks-regression.js`
Expected: FAIL because `src/shared/manual-layout.ts` does not exist.

**Step 3: Implement the shared model**

Define narrow types and helpers, avoiding `any`:

```ts
export type ManualLayoutBlockKind =
  | 'text' | 'title' | 'paragraph_title' | 'note' | 'abstract'
  | 'reference' | 'header' | 'footer' | 'number'
  | 'table' | 'image' | 'seal'

export interface ManualLayoutBlockMeta {
  manual_block_id: string
  segmentation_source: 'manual'
  label: ManualLayoutBlockKind
  location: { left: number; top: number; width: number; height: number }
  reading_order: number
  orientation?: 'horizontal' | 'vertical'
  caption?: string
  alt_text?: string
  image_asset_path?: string
  image_crop?: { source_page_id: string; left: number; top: number; width: number; height: number }
}
```

Implement `getManualBlockId`, `isManualLayoutBlock`, `getLayoutBlockSearchText`, and `projectLayoutBlocksToPageText`. Table text must preserve row/column boundaries; image and seal blocks contribute only caption/alt text.

Update `ensureOcrResultIr`/IR building to preserve the manual metadata and use the shared text projection when rebuilding page text.

**Step 4: Add the regression to the full check chain**

Add `check:manual-layout` and invoke it from `npm run check` before the facsimile UI regressions.

**Step 5: Run targeted checks**

Run:

```powershell
npm run typecheck
npm run check:manual-layout
npm run check:ocr-ir
```

Expected: PASS.

**Step 6: Commit**

```powershell
git add src/shared/manual-layout.ts src/shared/types.ts src/shared/ocr-ir.ts scripts/manual-layout-blocks-regression.js package.json
git commit -m "feat: add canonical manual layout blocks"
```

### Task 2: Extend the table data engine for spreadsheet operations

**Files:**
- Modify: `src/renderer/src/utils/facsimileTableEditing.ts`
- Modify: `scripts/facsimile-layout-editor-regression.js`

**Step 1: Add failing table-engine tests**

Cover:

```js
assert.deepStrictEqual(parseFacsimileTableClipboard('甲\t乙\n丙\t丁'), [['甲', '乙'], ['丙', '丁']])

const pasted = pasteFacsimileTableRange(rows, merges, { row: 3, col: 4 }, [['甲', '乙'], ['丙', '丁']])
assert.strictEqual(pasted.rows.length, 5)
assert.strictEqual(pasted.rows[0].length, 6)
assert.strictEqual(pasted.rows[4][5], '丁')
```

Also test rectangular drag selection, whole-row/whole-column selection, multi-cell clear, merge normalization after insertion/deletion, and row/column size metadata.

**Step 2: Run and verify failure**

Run: `node scripts/facsimile-layout-editor-regression.js`
Expected: FAIL on missing clipboard/range helpers.

**Step 3: Implement minimal pure helpers**

Add typed helpers for:

- TSV and HTML-table parsing;
- selected-range clearing;
- automatic row/column expansion during paste;
- row/column selection;
- normalized row heights and column widths;
- adjusting merged ranges after structural edits.

Keep these functions free of React/DOM dependencies so they remain deterministic and easy to test.

**Step 4: Run the regression**

Run: `node scripts/facsimile-layout-editor-regression.js`
Expected: PASS.

**Step 5: Commit**

```powershell
git add src/renderer/src/utils/facsimileTableEditing.ts scripts/facsimile-layout-editor-regression.js
git commit -m "feat: add spreadsheet table operations"
```

### Task 3: Rebuild the table UI as a lightweight Excel-style grid

**Files:**
- Modify: `src/renderer/src/components/FacsimileTableEditor.tsx`
- Create: `src/renderer/src/components/FacsimileTableEditor.css`
- Modify: `scripts/facsimile-layout-editor-regression.js`

**Step 1: Add failing UI structure assertions**

Assert that the component contains:

- row and column header buttons;
- pointer-drag range selection;
- a single active cell editor instead of a `TextArea` in every cell;
- clipboard `onPaste` handling;
- keyboard handling for arrows, Tab, Enter, Delete, Ctrl+Z and Ctrl+Y;
- a right-click context menu;
- no hard-coded white cell/text combination.

**Step 2: Run and verify failure**

Run: `node scripts/facsimile-layout-editor-regression.js`
Expected: FAIL against the current button-heavy editor.

**Step 3: Implement the grid shell**

Use one focusable grid root and render display cells as plain elements. Create an input only for the active editing cell. Keep selection state as anchor/focus points and expose selected range through CSS classes.

Use GujiSmart theme tokens:

```css
.facsimile-table-grid {
  --table-bg: var(--gs-surface-elevated);
  --table-text: var(--gs-text-primary);
  --table-grid: color-mix(in srgb, var(--gs-text-primary) 18%, transparent);
  --table-selection: color-mix(in srgb, var(--gs-accent) 18%, transparent);
}
```

Do not force `#fff` for editable cells. Ensure selected text remains readable in both themes.

**Step 4: Add direct interactions**

- Drag cells to select a rectangle.
- Double-click or type to edit.
- Use keyboard navigation without leaving the grid.
- Use row/column headers for whole-axis selection and resize handles.
- Build the context menu from current selection: insert before/after, delete, merge, split.
- Paste TSV/HTML and auto-expand the grid.

**Step 5: Run targeted checks**

Run:

```powershell
npm run typecheck
node scripts/facsimile-layout-editor-regression.js
npm run check:mojibake
```

Expected: PASS.

**Step 6: Commit**

```powershell
git add src/renderer/src/components/FacsimileTableEditor.tsx src/renderer/src/components/FacsimileTableEditor.css scripts/facsimile-layout-editor-regression.js
git commit -m "feat: add Excel style facsimile table editor"
```

### Task 4: Add revisioned page drafts and fix editor reset/blur behavior

**Files:**
- Create: `src/renderer/src/hooks/useManualLayoutDraft.ts`
- Modify: `src/renderer/src/components/GujiFacsimileProofreader.tsx:1870-2014,2249-2551,2868-2885,3260-3335`
- Modify: `scripts/facsimile-layout-editor-regression.js`

**Step 1: Add failing draft-state assertions**

Test the state reducer independently:

```ts
const state = createManualLayoutDraft(pageId, blocks)
const created = reduceDraft(state, { type: 'create', block })
const echoed = reduceDraft(created, { type: 'server-ack', revision: 0, blocks })
expect(echoed.activeBlockId).toBe(block.manual_block_id)
expect(echoed.blocks).toContainEqual(expect.objectContaining({ manual_block_id: block.manual_block_id }))
```

Verify that an older save acknowledgment cannot overwrite a newer draft.

**Step 2: Run and verify failure**

Run: `node scripts/facsimile-layout-editor-regression.js`
Expected: FAIL because the draft hook/reducer is absent.

**Step 3: Implement revisioned drafts**

The hook must track:

```ts
type SaveState = 'clean' | 'dirty' | 'saving' | 'failed'

type ManualLayoutDraftState = {
  pageId: string
  blocks: LayoutBlock[]
  activeBlockId: string | null
  revision: number
  acknowledgedRevision: number
  saveState: SaveState
}
```

Use `manual_block_id` instead of array indexes. Debounce saves, keep dirty state on failure, and merge matching server echoes without clearing the active block.

**Step 4: Fix the creation sequence**

Replace the current sequence that calls `commitBlocks()` and then sets `editingIndex`. New blocks must:

1. receive a stable ID;
2. enter the local draft;
3. become active immediately;
4. open the docked inspector;
5. persist through the draft save queue.

Do not reset the active block merely because `ocrResult` changed for the same `pageId`.

**Step 5: Link edit mode to the existing blur preference**

- Remove `layoutEditMode ? 'none' : ...` from the image filter.
- Use the same `imageUnderlayBlur` state in normal and edit modes.
- Change the first-use default to 65 without overwriting an existing stored preference.
- Add an `Alt` key temporary-clear state; when active, show the clear underlay without changing the stored slider value.

**Step 6: Add save status and leave-page protection**

Display dirty/saving/saved/failed status. Ctrl+S flushes immediately. Page changes with failed/unsaved drafts prompt before discarding.

**Step 7: Run targeted checks**

Run:

```powershell
npm run typecheck
node scripts/facsimile-layout-editor-regression.js
npm run check:reader-preferences
```

Expected: PASS.

**Step 8: Commit**

```powershell
git add src/renderer/src/hooks/useManualLayoutDraft.ts src/renderer/src/components/GujiFacsimileProofreader.tsx scripts/facsimile-layout-editor-regression.js
git commit -m "fix: preserve manual layout editing drafts"
```

### Task 5: Add the typed block toolbox, docked inspector, movement, and resizing

**Files:**
- Create: `src/renderer/src/components/ManualLayoutToolbar.tsx`
- Create: `src/renderer/src/components/ManualBlockInspector.tsx`
- Modify: `src/renderer/src/components/GujiFacsimileProofreader.tsx`
- Modify: `scripts/facsimile-layout-editor-regression.js`

**Step 1: Add failing interaction assertions**

Assert that:

- all OCR-supported block types are available through quick types plus “More”;
- existing and new blocks use the same move/resize handlers;
- eight resize handles render for the active block;
- the inspector is keyed by stable block ID;
- text, table and image inspectors are selected by type;
- block type can be changed with a guarded conversion.

**Step 2: Run and verify failure**

Run: `node scripts/facsimile-layout-editor-regression.js`
Expected: FAIL on missing toolbar/inspector components.

**Step 3: Implement the compact toolbar**

Provide selection, text, note, table and image tools plus a “More” menu for title, paragraph title, abstract, reference, header, footer, number and seal. A preselected tool remains active for repeated drawing until Escape returns to selection.

**Step 4: Implement the docked inspector**

The inspector remains mounted while editing the page. Text-like blocks expose content, orientation, type and reading order. Table blocks embed `FacsimileTableEditor`. Image-like blocks expose preview, caption/alt text, crop retry and replacement actions.

**Step 5: Normalize movement and resize**

Use the existing coordinate clamp helpers for all block kinds. Dragging the body moves; eight handles resize. Persist geometry through the draft queue and preserve it across page reloads.

**Step 6: Run targeted checks**

Run:

```powershell
npm run typecheck
node scripts/facsimile-layout-editor-regression.js
npm run check:facsimile-stacked-vertical-blocks
```

Expected: PASS.

**Step 7: Commit**

```powershell
git add src/renderer/src/components/ManualLayoutToolbar.tsx src/renderer/src/components/ManualBlockInspector.tsx src/renderer/src/components/GujiFacsimileProofreader.tsx scripts/facsimile-layout-editor-regression.js
git commit -m "feat: add typed manual layout tools"
```

### Task 6: Add managed image-block cropping and replacement IPC

**Files:**
- Create: `src/main/manual-page-assets.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/main/ipc/documents.ts:6150-6218`
- Modify: `src/renderer/src/components/ManualBlockInspector.tsx`
- Create: `scripts/manual-page-assets-regression.js`
- Modify: `scripts/check-ipc-contract.js`
- Modify: `package.json`

**Step 1: Write failing contract and crop tests**

Define expected APIs:

```ts
cropManualPageImage(request: ManualPageImageCropRequest): Promise<ManualPageImageAsset>
selectManualBlockImage(pageId: string): Promise<ManualPageImageAsset | null>
```

The crop test creates a synthetic image, crops a known rectangle, verifies output dimensions and verifies the resulting path remains within the document’s managed storage boundary.

**Step 2: Run and verify failure**

Run:

```powershell
node scripts/check-ipc-contract.js
node scripts/manual-page-assets-regression.js
```

Expected: FAIL because the API and asset helper do not exist.

**Step 3: Add shared contracts and preload APIs**

Use normalized crop coordinates and return only managed metadata:

```ts
export interface ManualPageImageCropRequest {
  pageId: string
  blockId: string
  crop: { left: number; top: number; width: number; height: number }
}

export interface ManualPageImageAsset {
  assetPath: string
  width: number
  height: number
}
```

**Step 4: Implement managed cropping**

In the main process:

- validate that the page belongs to the active project;
- resolve the readable source page image;
- crop using `nativeImage`;
- write a PNG beneath the document’s managed page-assets directory;
- reject paths outside the managed boundary;
- leave existing assets untouched when a crop fails.

For blank pages, the selection API copies the chosen image into the same managed directory.

**Step 5: Connect the inspector**

When creating an image/seal block from a page with a source image, start cropping after geometry is chosen. Keep the block and crop metadata if generation fails, show retry, and never discard the selected rectangle.

**Step 6: Run targeted checks**

Run:

```powershell
npm run typecheck
node scripts/check-ipc-contract.js
node scripts/manual-page-assets-regression.js
npm run check:managed-path-boundary
npm run check:file-capabilities
```

Expected: PASS.

**Step 7: Commit**

```powershell
git add src/main/manual-page-assets.ts src/shared/types.ts src/preload/index.ts src/main/ipc/documents.ts src/renderer/src/components/ManualBlockInspector.tsx scripts/manual-page-assets-regression.js scripts/check-ipc-contract.js package.json
git commit -m "feat: add managed manual image blocks"
```

### Task 7: Add transactional blank-page insertion

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/main/ipc/documents.ts`
- Modify: `src/renderer/src/views/DocumentView.tsx`
- Create: `scripts/manual-page-insertion-integration-regression.js`
- Modify: `scripts/check-ipc-contract.js`
- Modify: `package.json`

**Step 1: Write the failing integration test**

Create a temporary document with three pages, insert before page 2, and assert:

```js
assert.deepStrictEqual(pageNumbers, [1, 2, 3, 4])
assert.strictEqual(inserted.image_path, null)
assert.strictEqual(inserted.ocr_status, 'completed')
assert.strictEqual(parsed.source_type, 'manual_blank_page')
assert.deepStrictEqual(parsed.layout_result, [])
```

Also test insertion after the current page and transaction rollback on an injected failure.

**Step 2: Run and verify failure**

Run: `electron scripts/manual-page-insertion-integration-regression.js`
Expected: FAIL because `pages:insertManual` is absent.

**Step 3: Add the IPC contract**

```ts
export interface ManualPageInsertRequest {
  documentId: string
  anchorPageId?: string
  position: 'before' | 'after'
}
```

Return the inserted `DocumentPage` and new page count.

**Step 4: Implement the database transaction**

- assert project ownership;
- derive width/height/orientation from the anchor or nearest page;
- shift later page numbers using a collision-safe temporary offset;
- insert a page with `source_type: 'manual_blank_page'`, empty layout and explicit page dimensions;
- update document timestamps/count caches;
- invalidate reading/search snapshots;
- commit atomically.

**Step 5: Add reader controls**

Expose “在当前页前插入空白页” and “在当前页后插入空白页” near page navigation. After insertion, reload the reading window and select the new page without resetting unrelated tabs.

**Step 6: Run targeted checks**

Run:

```powershell
npm run typecheck
node scripts/check-ipc-contract.js
electron scripts/manual-page-insertion-integration-regression.js
npm run check:library-projects
npm run check:stable-reader-locator
```

Expected: PASS.

**Step 7: Commit**

```powershell
git add src/shared/types.ts src/preload/index.ts src/main/ipc/documents.ts src/renderer/src/views/DocumentView.tsx scripts/manual-page-insertion-integration-regression.js scripts/check-ipc-contract.js package.json
git commit -m "feat: add manual blank pages"
```

### Task 8: Make reading, search, import, and export consume manual blocks consistently

**Files:**
- Modify: `src/renderer/src/utils/ocrText.ts`
- Modify: `src/renderer/src/views/DocumentView.tsx`
- Modify: `src/main/semantic-search.ts`
- Modify: `src/main/search-index-worker.ts`
- Modify: `src/main/export.ts`
- Modify: `src/main/ipc/documents.ts`
- Create: `scripts/manual-layout-cross-mode-regression.js`
- Modify: `scripts/source-reader-image-regression.js`
- Modify: `scripts/search-accuracy-regression.js`
- Modify: `scripts/export-snapshot-atomic-regression.js`
- Modify: `package.json`

**Step 1: Add failing cross-mode fixtures**

Use one neutral synthetic page containing note, table and image-caption blocks. Assert that:

- `getReadablePageElements` returns the note, table and image element;
- page text projection contains note/table/caption exactly once;
- reader search locates the stable block ID and coordinates;
- the search index contains the new manual text;
- structured export retains table cells, crop metadata and asset path;
- text export contains no fabricated image OCR.

**Step 2: Run and verify failure**

Run: `node scripts/manual-layout-cross-mode-regression.js`
Expected: FAIL until consumers use the shared manual-layout helpers.

**Step 3: Update renderer reading helpers**

Route block text and readable-element construction through `src/shared/manual-layout.ts`. Use stable block IDs in search locators. Render image/seal blocks with the managed asset or crop fallback; show caption separately.

**Step 4: Update indexing**

Ensure `pages:update` invalidates the page/document search index when manual text changes. Build search segments from the shared text projection and include stable block metadata for navigation.

**Step 5: Update import and export**

- Preserve recognized manual fields during structured JSON import.
- Include managed image assets or resolvable references in structured export.
- Keep native facsimile PDF fallback cropping from the source page.
- Use the shared text projection for TXT/Markdown/export snippets.

**Step 6: Run targeted checks**

Run:

```powershell
npm run typecheck
node scripts/manual-layout-cross-mode-regression.js
npm run check:source-reader-image
npm run check:search-accuracy
npm run check:export-snapshot
npm run check:library-import-queue
```

Expected: PASS.

**Step 7: Commit**

```powershell
git add src/renderer/src/utils/ocrText.ts src/renderer/src/views/DocumentView.tsx src/main/semantic-search.ts src/main/search-index-worker.ts src/main/export.ts src/main/ipc/documents.ts scripts/manual-layout-cross-mode-regression.js scripts/source-reader-image-regression.js scripts/search-accuracy-regression.js scripts/export-snapshot-atomic-regression.js package.json
git commit -m "feat: integrate manual layout across reading and search"
```

### Task 9: Add release notes and complete verification

**Files:**
- Modify: `CHANGELOG.md`

**Step 1: Add bilingual Unreleased notes**

Document:

- Excel-style table editing and bulk paste;
- durable typed manual blocks and move/resize;
- linked blur setting and temporary clear-underlay key;
- blank-page insertion;
- image-region blocks;
- cross-mode reading/search/export compatibility;
- the fixed create-block flash/disappear bug.

Do not bump the package version or publish until explicitly requested.

**Step 2: Run the full quality gate**

Run:

```powershell
npm run check
npm run build
npm run smoke
npm audit
npm audit --omit=dev
npm run check:mojibake
npm run check:opensource
git diff --check
```

Expected: all commands PASS; audits report 0 vulnerabilities.

**Step 3: Perform visual QA**

Verify at 100%, 150% and 175% Windows scaling in light and dark themes:

- table cell text and selections remain readable;
- context menus stay in the viewport;
- inspector does not cover the selected block on narrow windows;
- existing/new blocks move and resize correctly;
- Alt temporarily clears the underlay;
- page switch/reload preserves the active saved block;
- blank pages, image blocks and table blocks render in reading and facsimile modes.

**Step 4: Commit**

```powershell
git add CHANGELOG.md
git commit -m "docs: describe manual layout editor improvements"
```

**Step 5: Report remaining risks**

Report any unsupported clipboard format, image crop recovery limitation, or unusually large table performance limit. Do not package, tag, or push a release unless the user separately requests it.
