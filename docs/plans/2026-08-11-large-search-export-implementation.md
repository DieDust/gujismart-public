# Large Search Export Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow search excerpt export and batch-save counts to default to 10,000, accept very large custom counts or `全部`, and process large jobs in the background without freezing the Electron UI.

**Architecture:** Introduce a shared `SearchExportCount` contract (`number | 'all'`) and a persisted `search-export` task built on the existing task scheduler. Search results are represented by a project-scoped snapshot/cursor; the renderer receives pages and progress summaries while the main process reads hits in bounded batches and streams TXT/Markdown/CSV/JSON to an atomic temporary file.

**Tech Stack:** Electron main/preload/renderer, TypeScript, React/Ant Design, SQLite/better-sqlite3, existing task scheduler and background task events, Node `fs.WriteStream`, Node regression scripts and Electron integration regressions.

---

### Task 1: Add the shared count contract and red tests

**Files:**
- Create: `src/shared/search-export.ts`
- Modify: `src/shared/types.ts` (SearchOptions/SearchExportOptions and task payload types)
- Modify: `scripts/embedding-index-regression.js`
- Create: `scripts/search-export-limit-regression.js`
- Modify: `package.json` (`check:search-export` and include it in `check`)

**Step 1: Write the failing tests**

- Assert the shared default is `10_000`.
- Assert numeric counts are preserved as safe positive integers.
- Assert `'all'` is accepted and invalid/empty values fall back to `10_000`.
- Assert the old `HARD_FULLTEXT_EXPORT_MAX = 1000` and vector-only `5000` export clamps are absent.
- Assert `SearchOptions.maxExportRecords` and `SearchExportOptions.maxExportRecords` accept `number | 'all'`.

**Step 2: Run the focused test**

Run: `npm run check:search-export`

Expected: FAIL because the shared contract and implementation do not exist yet.

**Step 3: Implement the minimal shared contract**

- Add `SearchExportCount`, `DEFAULT_SEARCH_EXPORT_COUNT = 10_000`, `normalizeSearchExportCount`, and a safe-integer helper.
- Keep old numeric callers source-compatible.
- Do not introduce a business maximum; `'all'` is the explicit unlimited sentinel and numeric values are only bounded by `Number.MAX_SAFE_INTEGER`.

**Step 4: Run the focused test**

Run: `npm run check:search-export`

Expected: PASS for shared parsing, with source-contract assertions still failing for the not-yet-implemented worker.

**Step 5: Commit**

```powershell
git add src/shared/search-export.ts src/shared/types.ts scripts/embedding-index-regression.js scripts/search-export-limit-regression.js package.json
git commit -m "feat: add large search export count contract"
```

### Task 2: Make search snapshots project-scoped and pageable for large counts

**Files:**
- Modify: `src/main/semantic-search.ts`
- Modify: `src/main/ipc/search.ts`
- Modify: `src/main/embedding-index.ts` (reuse bounded vector Top-K/cursor path where needed)
- Modify: `src/shared/types.ts`
- Modify: `scripts/search-export-limit-regression.js`
- Modify: `scripts/search-accuracy-regression.js` or create `scripts/search-export-snapshot-regression.js`

**Step 1: Write the failing integration assertions**

- A vector request with a count above 5,000 returns a snapshot/cursor instead of forcing all hits into one renderer payload.
- A full-text export snapshot preserves the active library project ID and current filters.
- Paging the same snapshot returns deterministic non-overlapping pages.

**Step 2: Run the focused integration test**

Run: `node scripts/search-export-snapshot-regression.js` (or the selected existing regression command).

Expected: FAIL because vector export currently reuses a flat in-memory response and full-text export has a 1,000 hard cap.

**Step 3: Implement snapshot/cursor support**

- Preserve the existing full-text snapshot behavior and extend its export cursor to expose only the next bounded page.
- Add a vector snapshot descriptor containing project ID, model ID, normalized query, filters, score floor, and a stable cursor/ordinal.
- Keep vector ranking deterministic; use the existing bounded heap and batched metadata hydration, never a renderer-side 100,000-item array.
- Validate the captured project ID on every page/read operation.

**Step 4: Run the focused integration test**

Run: `node scripts/search-export-snapshot-regression.js` and `npm run check:embedding-index`.

Expected: PASS with deterministic page boundaries and no old export cap.

**Step 5: Commit**

```powershell
git add src/main/semantic-search.ts src/main/ipc/search.ts src/main/embedding-index.ts src/shared/types.ts scripts/search-export-snapshot-regression.js
git commit -m "feat: page large search snapshots safely"
```

### Task 3: Build the bounded streaming export writer

**Files:**
- Create: `src/main/search-export-worker.ts`
- Modify: `src/main/ipc/search.ts`
- Modify: `src/shared/types.ts`
- Create: `scripts/search-export-stream-regression.js`
- Modify: `package.json` (`check:search-export-stream`)

**Step 1: Write the failing stream tests**

- Generate 25,000 synthetic records and verify TXT, Markdown, CSV, and JSON output counts and syntax.
- Verify each batch is bounded and the output is written through a temporary file.
- Verify cancellation removes the temporary file and preserves an existing destination file.

**Step 2: Run the focused stream test**

Run: `npm run check:search-export-stream`

Expected: FAIL because the writer and cancellation protocol do not exist.

**Step 3: Implement the writer**

- Use a fixed batch target around 500 records, shrinking when estimated text size is large.
- Stream headers/records/footers per format; JSON must remain valid after every successful completion.
- Write to `<target>.gujismart-partial-<jobId>` and atomically rename only after the final flush.
- Expose `requestCancel()` and check it between records and batches.
- Keep citation generation and paragraph restoration inside the main-process worker; do not make one IPC request per record.

**Step 4: Run the focused stream test**

Run: `npm run check:search-export-stream`

Expected: PASS for all formats, cancellation, cleanup, and atomic replacement.

**Step 5: Commit**

```powershell
git add src/main/search-export-worker.ts src/main/ipc/search.ts src/shared/types.ts scripts/search-export-stream-regression.js package.json
git commit -m "feat: stream large search exports in batches"
```

### Task 4: Persist jobs, progress, and cancellation through IPC

**Files:**
- Modify: `src/main/ipc/search.ts`
- Modify: `src/main/ipc/index.ts` only if a separate registration function is introduced
- Modify: `src/main/task-scheduler.ts` only for missing cursor/artifact helpers
- Modify: `src/main/background-tasks.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/shared/types.ts`
- Create: `scripts/search-export-task-regression.js`

**Step 1: Write the failing task lifecycle tests**

- Start a search export with `10_000`, a custom number, and `'all'`.
- Verify `queued → running → completed` progress and final file statistics.
- Cancel while a batch is running and verify `canceling → canceled` without an output replacement.
- Simulate a database busy error and verify a bounded retry followed by a diagnosable failure.

**Step 2: Run the focused task test**

Run: `node scripts/search-export-task-regression.js`

Expected: FAIL because no search-export task IPC or persisted state exists.

**Step 3: Implement the task lifecycle**

- Create one scheduler job with a stable project-scoped settings snapshot and resumable cursor.
- Add IPC methods to start, inspect, and cancel the job; keep the existing synchronous preview API only for small previews.
- Emit throttled `background:taskStatusChanged` events with processed, total/unknown, bytes, phase, and error fields.
- Ensure startup recovery marks stale jobs safely and cleans orphaned partial files.
- Never change active project context while a job is running; the job owns its captured project ID.

**Step 4: Run the focused task test**

Run: `node scripts/search-export-task-regression.js` and the existing database-busy/task-scheduler regressions.

Expected: PASS with persisted progress, cancellation, recovery, and project isolation.

**Step 5: Commit**

```powershell
git add src/main/ipc/search.ts src/main/ipc/index.ts src/main/task-scheduler.ts src/main/background-tasks.ts src/preload/index.ts src/shared/types.ts scripts/search-export-task-regression.js
git commit -m "feat: add resumable search export tasks"
```

### Task 5: Update the search UI with default 10,000, custom counts, and risk confirmation

**Files:**
- Modify: `src/renderer/src/views/SearchView.tsx`
- Modify: `src/renderer/src/App.tsx` or the existing background task surface
- Modify: `src/renderer/src/components/TaskCenter.tsx` if present, otherwise add the smallest shared task panel component
- Modify: `src/renderer/src/styles/*.css` only for the task panel layout
- Create: `scripts/search-export-ui-regression.js`

**Step 1: Write the failing UI assertions**

- Default value is 10,000.
- Numeric input and `全部` are available for full-text export, vector export, and batch save.
- Selecting more than 10,000 or `全部` shows the risk confirmation before IPC starts.
- The preview remains sample-only and the task panel shows progress/cancel controls.

**Step 2: Run the focused UI test**

Run: `node scripts/search-export-ui-regression.js`

Expected: FAIL because the current UI uses a vector-only numeric max and synchronous export feedback.

**Step 3: Implement the UI**

- Replace the shared `InputNumber max={VECTOR_SEARCH_MAX_LIMIT}` with the count model and an explicit `全部` option.
- Persist the last numeric choice without persisting `全部` as an unsafe silent default; default new sessions to 10,000.
- Add the Chinese risk message and explicit confirmation action.
- Start a background task, close the modal without losing the task, and show progress in the existing global task surface.
- Keep a small on-demand preview and show skipped/processed/total statistics.

**Step 4: Run the focused UI test**

Run: `node scripts/search-export-ui-regression.js`; then run the renderer/type checks.

Expected: PASS with no optional `window.api` probes and no full-result array rendered at once.

**Step 5: Commit**

```powershell
git add src/renderer/src/views/SearchView.tsx src/renderer/src/App.tsx src/renderer/src/components src/renderer/src/styles scripts/search-export-ui-regression.js
git commit -m "feat: add large export controls and progress UI"
```

### Task 6: Preserve existing behavior and add cross-feature regression coverage

**Files:**
- Modify: `scripts/search-regression.js`
- Modify: `scripts/search-accuracy-regression.js`
- Modify: `scripts/excerpts-library-regression.js`
- Modify: `scripts/database-busy-retry-regression.js` if task retry coverage needs a shared assertion
- Modify: `CHANGELOG.md`
- Modify: `docs/SCRIPTS.md` if new checks need documentation

**Step 1: Add regression cases**

- Existing small exports still complete synchronously/through the same user flow.
- Large exports do not change search hit order, score filtering, citations, page numbering, or project boundaries.
- Existing vector default/recall behavior remains compatible for callers that explicitly request their old numeric value.
- A task cancellation does not cancel OCR, embedding, translation, or unrelated project jobs.

**Step 2: Run the focused suite**

Run: `npm run check:search-export`, `npm run check:search-export-stream`, `npm run check:search-export-task`, `npm run check:search-export-ui`, `npm run check:search-accuracy`, and `npm run check:excerpts-library`.

Expected: PASS.

**Step 3: Update bilingual release notes**

- Add the large-export controls, “全部” risk confirmation, background progress, cancellation, and atomic-file behavior to the next release changelog.
- Keep docs free of private corpus names and local paths.

**Step 4: Commit**

```powershell
git add scripts CHANGELOG.md docs/SCRIPTS.md
git commit -m "test: cover large search export behavior"
```

### Task 7: Full verification, packaging, and release handoff

**Files:**
- No new source files; inspect the complete diff and generated artifacts only.

**Step 1: Run local quality gates**

Run: `npm run check`, `npm run check:mojibake`, `npm run check:opensource`, `npm audit`, `npm audit --omit=dev`, and `git diff --check`.

Expected: all exit 0; only known non-blocking LF/CRLF or bundler warnings may remain.

**Step 2: Build and smoke test**

Run: `npm run build:win` and `npm run smoke:packaged`.

Expected: Setup and Portable installers build; packaged runtime probe and smoke test pass.

**Step 3: Verify no local data is staged**

Run: `git status --short` and inspect staged paths.

Expected: only source, tests, docs, and lock/config files; no `dist`, `out`, databases, logs, or user screenshots.

**Step 4: Commit/release according to the user's explicit request**

- For local testing only, leave installers under `dist` and do not push/tag.
- For GitHub publishing, update version and bilingual `CHANGELOG.md`, push `main`, create a new tag, wait for CI/Release, and verify only Setup/Portable EXEs are uploaded.

**Step 5: Final verification**

Run: `gh run list --repo DieDust/gujismart-public --limit 6` and `gh release view <tag> --repo DieDust/gujismart-public --json assets,url`.

Expected: latest CI and Release are `completed success`; release assets contain only the two intended `.exe` files plus GitHub-generated source archives.
